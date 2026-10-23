// Engine control unit (ECU).
// Two parts:
//   respond()   — a pure function: request bytes + vehicle state → response bytes or null (silence).
//                 Easy to test; it knows nothing about the bus or time.
//   attachEcu() — hooks respond() up to the bus: decodes the frame, replies after a delay.

import type { CanBus } from '../can/bus';
import type { Clock, TimerHandle } from '../clock';
import { OBD_ID, type Bytes } from '../can/frame';
import { decodeSingleFrame } from '../isotp/single-frame';
import { NEGATIVE_RESPONSE, NRC } from '../obd/match';
import { supportedMask, getPid } from '../obd/pids';
import type { VehicleState } from './model';
import { encodeVin } from '../obd/vin';
import { encodeDtc } from '../obd/dtc';
import { sendIsoTp } from '../isotp/sender';
import { encodeMonitorStatus, MONITOR_STATUS_PID } from '../obd/monitor-status';

// ─── What the ECU knows and where it gets it ─────────────────────────────────

/** PID → which state field to report. Encoding formulas come from pids.ts; this only says where the number comes from. */
const SOURCES: Record<number, (s: VehicleState) => number> = {
    0x04: (s) => s.engineLoadPct,
    0x05: (s) => s.coolantC,
    0x0b: (s) => s.mapKpa,
    0x0c: (s) => s.rpm,
    0x0d: (s) => s.speedKmh,
    0x0e: (s) => s.timingAdvanceDeg,
    0x0f: (s) => s.intakeAirC,
    0x10: (s) => s.mafGs,
    0x11: (s) => s.throttlePct,
    0x1f: (s) => s.runTimeS,
    0x2f: (s) => s.fuelLevelPct,
    0x33: (s) => s.baroKpa,
    0x42: (s) => s.moduleVoltageV,
    0x46: (s) => s.ambientC,
    0x06: (s) => s.stftPct, // fuel trims react to the "vacuum leak" fault
    0x07: (s) => s.ltftPct,
};

/**
 * PIDs the ECU actually supports: there is both a source in the state and a definition in pids.ts.
 * If your PID table lacks, say, 0x0E, the ECU honestly doesn't support it.
 */
export const SUPPORTED_PIDS: readonly number[] = [
    MONITOR_STATUS_PID, // 01 01 is built by hand below: it is not a "number with units"
    ...Object.keys(SOURCES)
        .map(Number)
        .filter((pid) => getPid(pid) !== undefined),
].sort((a, b) => a - b);

/** 0x00, 0x20, 0x40 … 0xE0 — "which PIDs do you support?" */
export function isSupportQuery(pid: number): boolean {
    return pid % 0x20 === 0 && pid <= 0xe0;
}

// ─── respond(): the heart of the ECU ─────────────────────────────────────────

/**
 * @param req      request payload without the ISO-TP byte, e.g. [0x01, 0x0C]
 * @param physical true — the request is addressed to us (7E0), false — broadcast (7DF)
 * @returns response bytes, e.g. [0x41, 0x0C, 0x1A, 0xF8], or null — stay silent
 */
export function respond(req: Bytes, state: VehicleState, physical: boolean): Bytes | null {
    if (req.length === 0) return null;
    const service = req[0];

    switch (service) {
        case 0x01:
            return respondMode01(req, state);
        case 0x03:
            return respondDtcs(0x43, state.storedDtcs);
        case 0x04:
            return respondMode04(state);
        case 0x07:
            return respondDtcs(0x47, state.pendingDtcs);
        case 0x09:
            return respondMode09(req, state);
        // 04 — clearing codes changes the state, so it comes with the car model in stage 6.
        default:
            return physical ? [NEGATIVE_RESPONSE, service, NRC.SERVICE_NOT_SUPPORTED] : null;
    }
}

/** Mode 01: current data. One PID per request. */
function respondMode01(req: Bytes, state: VehicleState): Bytes | null {
    // OBD allows up to 6 PIDs in one request, but then the response won't fit in a Single Frame.
    // For now exactly one PID; anything else gets silence.
    if (req.length !== 2) return null;
    const pid = req[1];

    if (isSupportQuery(pid)) {
        const mask = supportMask(pid);
        return mask ? [0x41, pid, ...mask] : null;
    }

    if (pid === MONITOR_STATUS_PID) {
        return [0x41, pid, ...encodeMonitorStatus(state.milOn, state.storedDtcs.length)];
    }

    const source = SOURCES[pid];
    const def = getPid(pid);
    if (!source || !def) return null; // unsupported PID — stay silent, that's normal for OBD

    return [0x41, pid, ...def.encode(source(state))];
}

/**
 * Mode 04: clear codes. Real ECUs refuse while the engine is running: clearing would also reset
 * the readiness monitors in the middle of a drive. 44 means "done"; the caller does the clearing.
 */
function respondMode04(state: VehicleState): Bytes {
    if (state.rpm > 0) return [NEGATIVE_RESPONSE, 0x04, NRC.CONDITIONS_NOT_CORRECT];
    return [0x44];
}

/**
 * Modes 03 and 07: trouble codes. On CAN the response is
 *   43 N  a1 b1  a2 b2 …     N = how many codes, then 2 bytes per code.
 * No codes → 43 00. The ECU answers even a broadcast request: "no codes" is an answer too.
 * Three codes are already 8 bytes, so the response goes over ISO-TP.
 */
function respondDtcs(sid: number, codes: readonly string[]): Bytes {
    return [sid, codes.length, ...codes.flatMap((c) => encodeDtc(c))];
}

/** Mode 09 PIDs this ECU knows. */
const MODE09_PIDS = [0x02];

/** Mode 09: vehicle information. 09 00 = which PIDs, 09 02 = VIN. */
function respondMode09(req: Bytes, state: VehicleState): Bytes | null {
    if (req.length !== 2) return null;
    const pid = req[1];
    if (pid === 0x00) return [0x49, 0x00, ...supportedMask(0x00, MODE09_PIDS)];
    if (pid === 0x02) return [0x49, 0x02, 0x01, ...encodeVin(state.vin)]; // 01 = one data item
    return null;
}

/**
 * Response to 01 00 / 01 20 / 01 40 …: 4 bytes, one bit per PID in base+1 … base+0x20.
 * The last bit (PID base+0x20) means "the next range has something too, keep asking".
 */
function supportMask(base: number): Bytes | null {
    const inRange = SUPPORTED_PIDS.filter((p) => p > base && p < base + 0x20);
    const hasMore = SUPPORTED_PIDS.some((p) => p > base + 0x20);

    // The ECU always answers 01 00. For further ranges with no PIDs at all it stays silent.
    if (base !== 0 && inRange.length === 0 && !hasMore) return null;

    return supportedMask(base, hasMore ? [...inRange, base + 0x20] : inRange);
}

// ─── attachEcu(): the ECU on the bus ─────────────────────────────────────────

export interface EcuOptions {
    /** Response delay, ms. Real modules answer within 5–50 ms. */
    responseDelayMs?: number;
    /** The module's physical address. The engine is 7E0; a transmission would be 7E1. */
    requestId?: number;
    /** The response always comes from the request ID + 8. */
    responseId?: number;
    flowControlTimeoutMs?: number;
    /** called when the ECU accepted mode 04 (answered 44). respond() stays pure; the car forgets its codes here. */
    onClearDtcs?: () => void;
}

/**
 * Subscribes the ECU to the bus. getState is called at reply time,
 * so in stage 6 the RPM will be fresh without any changes here.
 * @returns a function that detaches the ECU from the bus
 */
export function attachEcu(bus: CanBus, clock: Clock, getState: () => VehicleState, options: EcuOptions = {}): () => void {
    const delay = options.responseDelayMs ?? 5;
    const requestId = options.requestId ?? OBD_ID.ECU_REQUEST;
    const responseId = options.responseId ?? requestId + 8;
    const timers = new Set<TimerHandle>();
    const transfers = new Set<{ cancel: () => void }>(); // long responses still being sent

    const unsubscribe = bus.subscribe((frame) => {
        if (frame.from !== 'tester') return; // don't listen to our own responses
        const physical = frame.id === requestId;
        if (!physical && frame.id !== OBD_ID.FUNCTIONAL) return; // the frame isn't for us

        // OBD requests always fit in a Single Frame. Flow Control frames for our long
        // responses also arrive here; sendIsoTp() handles those, so we skip them.
        const req = decodeSingleFrame(frame.data);
        if (!req) return;

        const resp = respond(req, getState(), physical);
        if (!resp) return;

        if (resp[0] === 0x44) options.onClearDtcs?.(); // mode 04 accepted

        const handle = clock.setTimeout(() => {
            timers.delete(handle);
            // Up to 7 bytes goes out as one Single Frame at once; longer: FF, then CFs after the tester's FC.
            // The transfer goes into the set first: a Single Frame ends inside sendIsoTp() and removes itself.
            const transfer = { cancel: () => {} };
            transfers.add(transfer);
            transfer.cancel = sendIsoTp(bus, clock, resp, {
                txId: responseId,
                rxId: requestId, // the tester sends Flow Control to our physical address
                from: 'ecu',
                fcTimeoutMs: options.flowControlTimeoutMs,
                onEnd: () => transfers.delete(transfer),
            });
        }, delay);
        timers.add(handle);
    });

    return () => {
        unsubscribe();
        for (const handle of timers) clock.clearTimeout(handle); // a detached module doesn't answer
        timers.clear();
        for (const t of [...transfers]) t.cancel(); // …and stops a long response halfway
        transfers.clear();
    };
}
