// 7F xx 78 "response pending": real ECUs sometimes say "wait" before the real answer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualBus } from '../src/core/can/bus';
import { createSystemClock, type Clock } from '../src/core/clock';
import { createLatenessTracker } from '../src/core/obd/lateness';
import { isResponsePending } from '../src/core/obd/match';
import { SimTransport } from '../src/transport/sim';

let clock: Clock;
let bus: VirtualBus;

beforeEach(() => {
    vi.useFakeTimers();
    clock = createSystemClock();
    bus = new VirtualBus(clock);
});

afterEach(() => {
    vi.useRealTimers();
});

/** An ECU that says "wait" after 10 ms and answers `after` ms later. */
function slowEcu(after: number): void {
    bus.subscribe((f) => {
        if (f.from !== 'tester' || f.data[1] !== 0x09) return;
        clock.setTimeout(() => bus.send({ id: 0x7e8, data: [0x03, 0x7f, 0x09, 0x78], from: 'ecu' }), 10);
        clock.setTimeout(() => bus.send({ id: 0x7e8, data: [0x03, 0x49, 0x0a, 0x01], from: 'ecu' }), 10 + after);
    });
}

describe('response pending', () => {
    it('isResponsePending: only 7F + our service + 78', () => {
        expect(isResponsePending([0x09, 0x0a], [0x7f, 0x09, 0x78])).toBe(true);
        expect(isResponsePending([0x09, 0x0a], [0x7f, 0x01, 0x78])).toBe(false);
        expect(isResponsePending([0x09, 0x0a], [0x7f, 0x09, 0x22])).toBe(false);
    });

    it('the transport keeps waiting after 7F 09 78, longer than the usual 100 ms', async () => {
        slowEcu(800);
        const p = new SimTransport(bus, clock).request([0x09, 0x0a]);
        await vi.advanceTimersByTimeAsync(1000);
        expect(await p).toEqual([0x49, 0x0a, 0x01]);
    });

    it('but not forever: 5 s after the last "wait" it gives up', async () => {
        slowEcu(9000);
        const p = new SimTransport(bus, clock).request([0x09, 0x0a]);
        await vi.advanceTimersByTimeAsync(5100);
        expect(await p).toBeNull();
    });

    it('the log does not call the answer after "wait" LATE', () => {
        const tracker = createLatenessTracker(100);
        expect(tracker.check({ id: 0x7df, data: [0x02, 0x09, 0x0a], t: 0 })).toBeNull();
        expect(tracker.check({ id: 0x7e8, data: [0x03, 0x7f, 0x09, 0x78], t: 10 })).toBeNull();
        expect(tracker.check({ id: 0x7e8, data: [0x03, 0x49, 0x0a, 0x01], t: 810 })).toBeNull();
    });
});
