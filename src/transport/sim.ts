// Transport over any CanBus: OBD messages ⇄ CAN frames.
// It plays the part an ELM327 plays in a real car: sends the request as a Single Frame,
// gathers a long response (FF + CF) and answers each First Frame with a Flow Control.
// Stage 7: the same class talks to a real car through SlcanBus. The name stayed from the simulator days.

import type { CanBus } from '../core/can/bus';
import type { Clock } from '../core/clock';
import { OBD_ID, type Bytes } from '../core/can/frame';
import { DEFAULT_FLOW_CONTROL, encodeFlowControl, type FlowControl } from '../core/isotp/flow-control';
import { Reassembler } from '../core/isotp/reassemble';
import { encodeSingleFrame } from '../core/isotp/single-frame';
import { isResponsePending, isResponseTo } from '../core/obd/match';
import { DEFAULT_TIMEOUT_MS, PENDING_TIMEOUT_MS, type RequestOptions, type Transport } from './transport';

export interface SimTransportOptions {
    /** What to answer a First Frame with. Default 30 00 00, like an ELM327. */
    flowControl?: FlowControl;
}

export class SimTransport implements Transport {
    private readonly bus: CanBus;
    private readonly clock: Clock;
    private readonly flowControl: FlowControl;
    private closed = false;
    private readonly pending = new Set<() => void>();

    constructor(bus: CanBus, clock: Clock, options: SimTransportOptions = {}) {
        this.bus = bus;
        this.clock = clock;
        this.flowControl = options.flowControl ?? DEFAULT_FLOW_CONTROL;
    }

    /**
     * timeoutMs works the way an ELM327 timeout does: it is the longest silence allowed,
     * before the first frame of the response and between the frames of a long one.
     * So a 20-byte VIN does not have to fit into 100 ms in total.
     */
    request(payload: Bytes, opts: RequestOptions = {}): Promise<Bytes | null> {
        if (this.closed) return Promise.reject(new Error('Transport is closed'));

        const physical = opts.physical ?? false;
        const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const requestId = physical ? OBD_ID.ECU_REQUEST : OBD_ID.FUNCTIONAL;
        const data = encodeSingleFrame(payload); // throws if the request is longer than 7 bytes

        return new Promise((resolve) => {
            let finished = false;
            const rx = new Reassembler();
            /** CAN ID of the ECU whose long response we're gathering; frames from others are ignored meanwhile. */
            let lockedTo: number | null = null;

            const finish = (result: Bytes | null): void => {
                if (finished) return;
                finished = true;
                this.pending.delete(cancel);
                this.clock.clearTimeout(timer);
                unsubscribe();
                resolve(result);
            };

            const cancel = (): void => finish(null);
            this.pending.add(cancel);
            let timer = this.clock.setTimeout(() => finish(null), timeoutMs);
            const restartTimer = (ms = timeoutMs): void => {
                this.clock.clearTimeout(timer);
                timer = this.clock.setTimeout(() => finish(null), ms);
            };

            // Subscribe BEFORE sending: the ECU may answer very quickly.
            const unsubscribe = this.bus.subscribe((frame) => {
                if (frame.from !== 'ecu' || !isAnswerId(frame.id, physical)) return;
                if (lockedTo !== null && frame.id !== lockedTo) return;

                const r = rx.push(frame.data);
                switch (r.type) {
                    case 'single':
                        // "Still working on it": not the answer yet, wait longer for the real one.
                        if (isResponsePending(payload, r.payload)) {
                            restartTimer(PENDING_TIMEOUT_MS);
                            return;
                        }
                        // Skip a foreign or late response and keep waiting.
                        if (isResponseTo(payload, r.payload)) finish(r.payload);
                        return;

                    case 'first':
                        // The first 6 bytes are enough to see whose answer this is.
                        if (!isResponseTo(payload, r.head)) {
                            rx.reset(); // a late long answer to an old request: no FC, the ECU gives up
                            return;
                        }
                        lockedTo = frame.id;
                        restartTimer();
                        // Flow Control goes to the ECU's physical address: response ID − 8 (7E8 → 7E0).
                        this.bus.send({ id: frame.id - 8, data: encodeFlowControl(this.flowControl), from: 'tester' });
                        return;

                    case 'progress':
                        restartTimer();
                        return;

                    case 'complete':
                        finish(r.payload);
                        return;

                    case 'error':
                        // A lost or reordered frame: the message is broken, better nothing than garbage.
                        finish(null);
                        return;

                    case 'ignored':
                        return;
                }
            });

            this.bus.send({ id: requestId, data, from: 'tester' });
        });
    }

    async close(): Promise<void> {
        this.closed = true;
        for (const cancel of [...this.pending]) cancel(); // nobody should wait out a timeout on a port that is gone
    }
}

/**
 * Physical request to 7E0 → wait only for 7E8.
 * Broadcast 7DF → any module 7E8…7EF will do; we take the first response.
 */
function isAnswerId(id: number, physical: boolean): boolean {
    if (physical) return id === OBD_ID.ECU_RESPONSE;
    return id >= 0x7e8 && id <= 0x7ef;
}