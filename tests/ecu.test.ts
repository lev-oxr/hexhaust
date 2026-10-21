import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualBus } from '../src/core/can/bus';
import type { CanFrame } from '../src/core/can/frame';
import { createSystemClock, type Clock } from '../src/core/clock';
import { explainFrame } from '../src/core/obd/explain';
import { isResponseTo } from '../src/core/obd/match';
import { decodeMonitorStatus, encodeMonitorStatus, MONITOR_STATUS_INFO } from '../src/core/obd/monitor-status';
import { getPid, parseSupported } from '../src/core/obd/pids';
import { respond, SUPPORTED_PIDS } from '../src/core/vehicle/ecu';
import { createEcuLink } from '../src/core/vehicle/ecu-link';
import { createStubState } from '../src/core/vehicle/model';

const state = createStubState(); // 1726 rpm, 60 km/h, 35 °C

describe('ECU: respond()', () => {
    it.each([
        { req: [0x01, 0x0c], resp: [0x41, 0x0c, 0x1a, 0xf8], what: 'engine speed 1726 rpm' },
        { req: [0x01, 0x0d], resp: [0x41, 0x0d, 0x3c], what: 'vehicle speed 60 km/h' },
        { req: [0x01, 0x05], resp: [0x41, 0x05, 0x4b], what: 'coolant temperature 35 °C' },
    ])('$what: $req → $resp', ({ req, resp }) => {
        expect(respond(req, state, false)).toEqual(resp);
    });

    it('answers a broadcast and a physical request identically', () => {
        expect(respond([0x01, 0x0c], state, true)).toEqual(respond([0x01, 0x0c], state, false));
    });

    it('takes values from the state at the time of the request', () => {
        expect(respond([0x01, 0x0d], { ...state, speedKmh: 100 }, false)).toEqual([0x41, 0x0d, 0x64]);
    });

    it('stays silent on an unsupported PID — for a physical request too', () => {
        expect(respond([0x01, 0x0a], state, false)).toBeNull();
        expect(respond([0x01, 0x0a], state, true)).toBeNull();
    });

    it('unknown service: silent on 7DF, replies 7F xx 11 on 7E0', () => {
        expect(respond([0x22, 0xf1, 0x90], state, false)).toBeNull();
        expect(respond([0x22, 0xf1, 0x90], state, true)).toEqual([0x7f, 0x22, 0x11]);
    });

    it('stays silent on an empty request and on several PIDs at once', () => {
        expect(respond([], state, true)).toBeNull();
        expect(respond([0x01], state, true)).toBeNull();
        expect(respond([0x01, 0x0c, 0x0d], state, true)).toBeNull();
    });

    it('every response passes the isResponseTo check', () => {
        for (const pid of SUPPORTED_PIDS) {
            const resp = respond([0x01, pid], state, false);
            expect(resp, `PID ${pid.toString(16)}`).not.toBeNull();
            expect(isResponseTo([0x01, pid], resp!)).toBe(true);
        }
    });
});

describe('ECU: supported PID masks', () => {
    /** Walk 01 00 → 01 20 → … the way the scanner will. */
    function walkMasks(): number[] {
        const found: number[] = [];
        for (let base = 0; base <= 0xe0; base += 0x20) {
            const resp = respond([0x01, base], state, false);
            if (!resp) break;
            expect(resp.slice(0, 2)).toEqual([0x41, base]);
            const pids = parseSupported(base, resp.slice(2));
            found.push(...pids.filter((p) => p !== base + 0x20));
            if (!pids.includes(base + 0x20)) break;
        }
        return found;
    }

    it('01 00 is always answered and lists engine speed and vehicle speed', () => {
        const resp = respond([0x01, 0x00], state, false);
        expect(resp).toHaveLength(6);
        const pids = parseSupported(0, resp!.slice(2));
        expect(pids).toContain(0x0c);
        expect(pids).toContain(0x0d);
    });

    it('the mask chain yields exactly the PIDs the ECU responds to', () => {
        expect(walkMasks()).toEqual([...SUPPORTED_PIDS]);
    });

    it('the ECU stays silent for a range with nothing in it', () => {
        expect(respond([0x01, 0xe0], state, false)).toBeNull();
    });
});
describe('ECU: modes 03, 07, 09 (stage 5)', () => {
    const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

    it('03: three stored codes → 43 03 + 6 bytes, 8 in all (more than a Single Frame holds)', () => {
        const resp = respond([0x03], state, false);
        expect(resp).toEqual([0x43, 0x03, 0x03, 0x00, 0x04, 0x20, 0x01, 0x71]);
        expect(resp!.length).toBeGreaterThan(7);
    });

    it('03 and 07 without codes: 43 00 / 47 00', () => {
        expect(respond([0x03], { ...state, storedDtcs: [] }, false)).toEqual([0x43, 0x00]);
        expect(respond([0x07], state, false)).toEqual([0x47, 0x00]);
    });

    it('07 reports pending codes', () => {
        expect(respond([0x07], { ...state, pendingDtcs: ['P0128'] }, false)).toEqual([0x47, 0x01, 0x01, 0x28]);
    });

    it('09 02: VIN, 20 bytes', () => {
        const resp = respond([0x09, 0x02], state, false);
        expect(resp).toEqual([0x49, 0x02, 0x01, ...ascii('1G1JC5444R7252367')]);
        expect(resp).toHaveLength(20);
    });

    it('09 00: of mode 09 the ECU supports only PID 02', () => {
        const resp = respond([0x09, 0x00], state, false);
        expect(resp).toEqual([0x49, 0x00, 0x40, 0x00, 0x00, 0x00]);
        expect(parseSupported(0x00, resp!.slice(2))).toEqual([0x02]);
    });

    it('09 with an unknown PID: silence', () => {
        expect(respond([0x09, 0x0a], state, true)).toBeNull();
    });

    it('04 (stage 6): refused while the engine runs, 44 with the engine stopped', () => {
        expect(respond([0x04], state, true)).toEqual([0x7f, 0x04, 0x22]);
        expect(respond([0x04], { ...state, rpm: 0 }, true)).toEqual([0x44]);
    });

    it.each([[[0x03]], [[0x07]], [[0x09, 0x00]], [[0x09, 0x02]]])('%j: the response passes isResponseTo', (req) => {
        expect(isResponseTo(req, respond(req, state, false)!)).toBe(true);
    });
});

// ─── Stage 6: PID 01 01, fuel trims, mode 04, power and delay ───

const stub = createStubState();

describe('PID 01 01: MIL and number of stored codes', () => {
    it('stub: MIL on, 3 codes → A = 80 + 3 = 83', () => {
        expect(respond([0x01, 0x01], stub, false)).toEqual([0x41, 0x01, 0x83, 0x07, 0x65, 0x00]);
    });

    it('no codes, MIL off → A = 00', () => {
        expect(respond([0x01, 0x01], { ...stub, milOn: false, storedDtcs: [] }, false)?.[2]).toBe(0x00);
    });

    it('encode and decode agree', () => {
        expect(decodeMonitorStatus(encodeMonitorStatus(true, 5))).toEqual({ milOn: true, storedCount: 5 });
        expect(decodeMonitorStatus(encodeMonitorStatus(false, 200))).toEqual({ milOn: false, storedCount: 0x7f });
    });

    it('01 is advertised in the 01 00 mask', () => {
        expect(SUPPORTED_PIDS[0]).toBe(0x01);
        const mask = respond([0x01, 0x00], stub, false)!;
        expect(mask[2] & 0x80).toBe(0x80); // the very first bit is PID 01
    });

    it('the log explains it: A in binary, the formula, the result', () => {
        const vocab = { getPid: (p: number) => (p === 1 ? MONITOR_STATUS_INFO : getPid(p)), decodeSupportedPids: parseSupported };
        const ex = explainFrame({ id: 0x7e8, data: [0x06, 0x41, 0x01, 0x83, 0x07, 0x65, 0x00, 0x55] }, vocab);
        expect(ex.bytes[3].text).toContain('10000011');
        expect(ex.calc?.substituted).toBe('131 AND 7F; MIL = bit 7 of 131');
        expect(ex.calc?.result).toBe('MIL on, 3 code(s)');
    });
});

describe('fuel trims 06 and 07', () => {
    it('are answered from the state', () => {
        expect(respond([0x01, 0x06], { ...stub, stftPct: 0 }, false)).toEqual([0x41, 0x06, 0x80]);
        expect(respond([0x01, 0x07], { ...stub, ltftPct: 12.5 }, false)).toEqual([0x41, 0x07, 0x90]);
    });
});

describe('mode 04: clear codes', () => {
    it('engine running → refused, 7F 04 22 (conditions not correct)', () => {
        expect(respond([0x04], stub, false)).toEqual([0x7f, 0x04, 0x22]);
    });

    it('engine stopped → 44, on a broadcast too', () => {
        expect(respond([0x04], { ...stub, rpm: 0 }, false)).toEqual([0x44]);
        expect(respond([0x04], { ...stub, rpm: 0 }, true)).toEqual([0x44]);
    });
});

describe('ECU link: power and delay', () => {
    let clock: Clock;
    let bus: VirtualBus;
    let frames: CanFrame[];

    beforeEach(() => {
        vi.useFakeTimers();
        clock = createSystemClock();
        bus = new VirtualBus(clock);
        frames = [];
        bus.subscribe((f) => frames.push(f));
    });
    afterEach(() => vi.useRealTimers());

    it('without power the module hears nothing and sends nothing', () => {
        let on = false;
        const link = createEcuLink(bus, clock, { powered: () => on, extraDelayMs: () => 0 });
        const heard = vi.fn();
        link.subscribe(heard);
        bus.send({ id: 0x7df, data: [0x02, 0x01, 0x0c], from: 'tester' });
        link.send({ id: 0x7e8, data: [0x01, 0x44], from: 'ecu' });
        expect(heard).not.toHaveBeenCalled();
        expect(frames.filter((f) => f.from === 'ecu')).toEqual([]);

        on = true;
        bus.send({ id: 0x7df, data: [0x02, 0x01, 0x0c], from: 'tester' });
        expect(heard).toHaveBeenCalledTimes(1);
    });

    it('no delay: the frame goes out at once', () => {
        const link = createEcuLink(bus, clock, { powered: () => true, extraDelayMs: () => 0 });
        link.send({ id: 0x7e8, data: [0x01, 0x44], from: 'ecu' });
        expect(frames).toHaveLength(1);
    });

    it('with a delay: frames leave later, in the order they were sent, even if the delay shrinks', async () => {
        let delay = 100;
        const link = createEcuLink(bus, clock, { powered: () => true, extraDelayMs: () => delay });
        link.send({ id: 0x7e8, data: [0x01, 0x01], from: 'ecu' });
        delay = 10;
        link.send({ id: 0x7e8, data: [0x01, 0x02], from: 'ecu' });
        await vi.advanceTimersByTimeAsync(99);
        expect(frames).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(frames.map((f) => f.data[1])).toEqual([0x01, 0x02]);
    });

    it('dispose() drops the frames still waiting', async () => {
        const link = createEcuLink(bus, clock, { powered: () => true, extraDelayMs: () => 50 });
        link.send({ id: 0x7e8, data: [0x01, 0x44], from: 'ecu' });
        link.dispose();
        await vi.advanceTimersByTimeAsync(100);
        expect(frames).toHaveLength(0);
    });
});
