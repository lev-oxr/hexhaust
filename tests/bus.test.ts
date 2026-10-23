import { describe, expect, it, vi } from 'vitest';
import { VirtualBus } from '../src/core/can/bus';
import type { CanFrame } from '../src/core/can/frame';
import type { Clock } from '../src/core/clock';
import { decodeSingleFrame, encodeSingleFrame } from '../src/core/isotp/single-frame';

// The bus barely needs a clock in these tests — one that always says "zero" is enough.
const zeroClock: Clock = {
    now: () => 0,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
};

describe('VirtualBus', () => {
    it('pads the frame to 8 bytes with the 0x55 filler', () => {
        const bus = new VirtualBus(zeroClock);
        const seen: CanFrame[] = [];
        bus.subscribe((f) => seen.push(f));

        bus.send({ id: 0x7df, data: [0x02, 0x01, 0x0c], from: 'tester' });

        expect(seen).toHaveLength(1);
        expect(seen[0].data).toEqual([0x02, 0x01, 0x0c, 0x55, 0x55, 0x55, 0x55, 0x55]);
    });

    it('delivers a frame to all subscribers, and no longer after unsubscribing', () => {
        const bus = new VirtualBus(zeroClock);
        const a = vi.fn();
        const b = vi.fn();
        const unsubscribeA = bus.subscribe(a);
        bus.subscribe(b);

        bus.send({ id: 0x7df, data: [0x02, 0x01, 0x0c], from: 'tester' });
        unsubscribeA();
        bus.send({ id: 0x7df, data: [0x02, 0x01, 0x0d], from: 'tester' });

        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(2);
    });

    it('everyone sees frames in send order, even when a subscriber replies instantly', () => {
        const bus = new VirtualBus(zeroClock);
        const log: string[] = [];

        // The "ECU" subscribes FIRST and answers right inside its handler
        bus.subscribe((f) => {
            if (f.from === 'tester') bus.send({ id: 0x7e8, data: [0x02, 0x41, 0x0c], from: 'ecu' });
        });
        bus.subscribe((f) => log.push(f.from));

        bus.send({ id: 0x7df, data: [0x02, 0x01, 0x0c], from: 'tester' });

        expect(log).toEqual(['tester', 'ecu']); // without the queue it would be ['ecu', 'tester']
    });

    it('a broken subscriber does not affect the others', () => {
        const bus = new VirtualBus(zeroClock);
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const good = vi.fn();
        bus.subscribe(() => {
            throw new Error('boom');
        });
        bus.subscribe(good);

        bus.send({ id: 0x7df, data: [0x02, 0x01, 0x0c], from: 'tester' });

        expect(good).toHaveBeenCalledTimes(1);
        spy.mockRestore();
    });

    it('stamps the time from the clock', () => {
        const bus = new VirtualBus({ ...zeroClock, now: () => 42 });
        const seen: CanFrame[] = [];
        bus.subscribe((f) => seen.push(f));
        bus.send({ id: 0x7df, data: [0x02, 0x01, 0x0c], from: 'tester' });
        expect(seen[0].t).toBe(42);
    });

    it('rejects frames that cannot exist in classic CAN', () => {
        const bus = new VirtualBus(zeroClock);
        expect(() => bus.send({ id: 0x800, data: [], from: 'tester' })).toThrow(RangeError);
        expect(() => bus.send({ id: 0x7df, data: [0, 1, 2, 3, 4, 5, 6, 7, 8], from: 'tester' })).toThrow(RangeError);
        expect(() => bus.send({ id: 0x7df, data: [256], from: 'tester' })).toThrow(RangeError);
    });
});

describe('Single Frame', () => {
    it('01 0C ⇄ 02 01 0C', () => {
        expect(encodeSingleFrame([0x01, 0x0c])).toEqual([0x02, 0x01, 0x0c]);
        expect(decodeSingleFrame([0x02, 0x01, 0x0c, 0x55, 0x55, 0x55, 0x55, 0x55])).toEqual([0x01, 0x0c]);
    });

    it('ignores frames of other types and frames with a bad length', () => {
        expect(decodeSingleFrame([0x10, 0x14, 0x49, 0x02, 0x01, 0x31, 0x47, 0x31])).toBeNull(); // First Frame
        expect(decodeSingleFrame([0x30, 0x00, 0x00, 0x55, 0x55, 0x55, 0x55, 0x55])).toBeNull(); // Flow Control
        expect(decodeSingleFrame([0x00, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55])).toBeNull(); // length 0
        expect(decodeSingleFrame([0x05, 0x41, 0x0c])).toBeNull(); // promises 5 bytes, has only 2
    });

    it('does not fit 8 bytes into a Single Frame', () => {
        expect(() => encodeSingleFrame([1, 2, 3, 4, 5, 6, 7, 8])).toThrow(RangeError);
        expect(() => encodeSingleFrame([])).toThrow(RangeError);
    });
});
