// Transport to the simulator: OBD messages ⇄ CAN frames on the virtual bus.
// Single Frame only for now.

import type { CanBus } from '../core/can/bus';
import type { Clock } from '../core/clock';
import { OBD_ID, type Bytes } from '../core/can/frame';
import { decodeSingleFrame, encodeSingleFrame } from '../core/isotp/single-frame';
import { isResponseTo } from '../core/obd/match';
import { DEFAULT_TIMEOUT_MS, type RequestOptions, type Transport } from './transport';

export class SimTransport implements Transport {
    private readonly bus: CanBus;
    private readonly clock: Clock;
    private closed = false;

    constructor(bus: CanBus, clock: Clock) {
        this.bus = bus;
        this.clock = clock;
    }

    request(payload: Bytes, opts: RequestOptions = {}): Promise<Bytes | null> {
        if (this.closed) return Promise.reject(new Error('Transport закрито'));

        const physical = opts.physical ?? false;
        const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const requestId = physical ? OBD_ID.ECU_REQUEST : OBD_ID.FUNCTIONAL;
        const data = encodeSingleFrame(payload); // throws if the request is longer than 7 bytes

        return new Promise((resolve) => {
            let finished = false;

            // Subscribe and start the timer BEFORE sending: the ECU may answer very quickly.
            const unsubscribe = this.bus.subscribe((frame) => {
                if (frame.from !== 'ecu') return;
                if (!isAnswerId(frame.id, physical)) return;

                const resp = decodeSingleFrame(frame.data);
                // Skip a foreign or late response and keep waiting.
                if (resp && isResponseTo(payload, resp)) finish(resp);
            });

            const timer = this.clock.setTimeout(() => finish(null), timeoutMs);

            // Single exit point: either the response or the timeout, whichever comes first.
            const finish = (result: Bytes | null): void => {
                if (finished) return;
                finished = true;
                this.clock.clearTimeout(timer);
                unsubscribe();
                resolve(result);
            };

            this.bus.send({ id: requestId, data, from: 'tester' });
        });
    }

    async close(): Promise<void> {
        this.closed = true;
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