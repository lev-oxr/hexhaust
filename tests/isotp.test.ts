// ISO-TP without the bus: splitting, gathering, Flow Control. Pure functions, no time.
import { describe, expect, it } from 'vitest';
import type { Bytes } from '../src/core/can/frame';
import { decodeFlowControl, encodeFlowControl, FLOW_STATUS, stMinToMs } from '../src/core/isotp/flow-control';
import { Reassembler, type RxResult } from '../src/core/isotp/reassemble';
import { frameCount, segment } from '../src/core/isotp/segment';

/** 0, 1, 2 … — a recognisable message of any length. */
const message = (n: number): Bytes => Array.from({ length: n }, (_, i) => i & 0xff);

/** Feeds every frame to a fresh Reassembler, returns all results. */
function feed(frames: Bytes[]): RxResult[] {
    const rx = new Reassembler();
    return frames.map((f) => rx.push(f));
}

const VIN_RESPONSE = [0x49, 0x02, 0x01, ...[...'1G1JC5444R7252367'].map((c) => c.charCodeAt(0))];

describe('segment()', () => {
    it('7 bytes is still a Single Frame', () => {
        expect(segment(message(7))).toEqual([[0x07, 0, 1, 2, 3, 4, 5, 6]]);
    });

    it('8 bytes: FF with 6 bytes + one CF with 2', () => {
        expect(segment(message(8))).toEqual([
            [0x10, 0x08, 0, 1, 2, 3, 4, 5],
            [0x21, 6, 7],
        ]);
    });

    it('VIN: exactly the frames from the plan', () => {
        expect(segment(VIN_RESPONSE)).toEqual([
            [0x10, 0x14, 0x49, 0x02, 0x01, 0x31, 0x47, 0x31],
            [0x21, 0x4a, 0x43, 0x35, 0x34, 0x34, 0x34, 0x52],
            [0x22, 0x37, 0x32, 0x35, 0x32, 0x33, 0x36, 0x37],
        ]);
    });

    it('4095 bytes: length 0xFFF in the FF, sequence numbers go round F → 0 → 1', () => {
        const frames = segment(message(4095));
        expect(frames).toHaveLength(frameCount(4095));
        expect(frames).toHaveLength(1 + 585); // 6 + 584 × 7 = 4094, plus one more CF for the last byte
        expect(frames[0].slice(0, 2)).toEqual([0x1f, 0xff]);
        expect(frames.slice(1, 18).map((f) => f[0])).toEqual([
            0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f, 0x20, 0x21,
        ]);
        for (const f of frames) expect(f.length).toBeLessThanOrEqual(8);
    });

    it('refuses an empty message and anything over 4095 bytes', () => {
        expect(() => segment([])).toThrow(RangeError);
        expect(() => segment(message(4096))).toThrow(RangeError);
    });
});

describe('Reassembler: round trip', () => {
    it.each([1, 7, 8, 13, 14, 20, 100, 4095])('%i bytes: segment → reassemble gives the same message', (n) => {
        const results = feed(segment(message(n)));
        const last = results[results.length - 1];
        expect(last.type).toBe(n <= 7 ? 'single' : 'complete');
        expect(last.type === 'single' || last.type === 'complete' ? last.payload : null).toEqual(message(n));
        // Everything in between is FF + progress
        if (n > 7) {
            expect(results[0]).toMatchObject({ type: 'first', total: n });
            expect(results.slice(1, -1).every((r) => r.type === 'progress')).toBe(true);
        }
    });

    it('works with padded frames, the way they come off the bus', () => {
        const padded = segment(VIN_RESPONSE).map((f) => [...f, ...Array<number>(8 - f.length).fill(0x55)]);
        expect(feed(padded).at(-1)).toEqual({ type: 'complete', payload: VIN_RESPONSE });
    });

    it('the FF reports the total length and the first bytes', () => {
        const [ff] = feed(segment(VIN_RESPONSE));
        expect(ff).toEqual({ type: 'first', total: 20, head: [0x49, 0x02, 0x01, 0x31, 0x47, 0x31] });
    });
});

describe('Reassembler: broken transfers', () => {
    it('a missing CF is a sequence error, and the message is dropped', () => {
        const [ff, , cf2] = segment(message(20));
        const rx = new Reassembler();
        rx.push(ff);
        expect(rx.push(cf2)).toEqual({ type: 'error', reason: 'wrong sequence number: expected 1, got 2' });
        expect(rx.busy).toBe(false);
    });

    it('a repeated CF is an error as well', () => {
        const [ff, cf1] = segment(message(20));
        const rx = new Reassembler();
        rx.push(ff);
        rx.push(cf1);
        expect(rx.push(cf1).type).toBe('error');
    });

    it('a CF without an FF is ignored', () => {
        expect(new Reassembler().push([0x21, 1, 2, 3, 4, 5, 6, 7]).type).toBe('ignored');
    });

    it('a new FF in the middle starts over', () => {
        const a = segment(message(20));
        const b = segment(VIN_RESPONSE);
        const rx = new Reassembler();
        rx.push(a[0]);
        rx.push(a[1]);
        const results = b.map((f) => rx.push(f));
        expect(results.at(-1)).toEqual({ type: 'complete', payload: VIN_RESPONSE });
    });

    it('a Single Frame in the middle cancels the long message', () => {
        const rx = new Reassembler();
        rx.push(segment(message(20))[0]);
        expect(rx.push([0x02, 0x41, 0x00])).toEqual({ type: 'single', payload: [0x41, 0x00] });
        expect(rx.busy).toBe(false);
    });

    it('an FF announcing 0–7 bytes is an error', () => {
        expect(new Reassembler().push([0x10, 0x05, 1, 2, 3, 4, 5, 0x55]).type).toBe('error');
        expect(new Reassembler().push([0x10, 0x00, 1, 2, 3, 4, 5, 6]).type).toBe('error');
    });

    it('Flow Control frames are not for the receiver', () => {
        expect(new Reassembler().push([0x30, 0x00, 0x00]).type).toBe('ignored');
    });

    it('reset() drops a half-received message (used on a timeout)', () => {
        const [ff, cf1] = segment(message(20));
        const rx = new Reassembler();
        rx.push(ff);
        rx.reset();
        expect(rx.push(cf1).type).toBe('ignored');
    });
});

describe('Flow Control', () => {
    it('30 00 00 ⇄ CTS, no block limit, no gap', () => {
        const fc = { status: FLOW_STATUS.CTS, blockSize: 0, stMin: 0 };
        expect(encodeFlowControl(fc)).toEqual([0x30, 0x00, 0x00]);
        expect(decodeFlowControl([0x30, 0x00, 0x00, 0x55, 0x55])).toEqual(fc);
    });

    it('WAIT and OVERFLOW', () => {
        expect(decodeFlowControl([0x31, 0, 0])?.status).toBe(FLOW_STATUS.WAIT);
        expect(decodeFlowControl([0x32, 0, 0])?.status).toBe(FLOW_STATUS.OVERFLOW);
    });

    it('not an FC or a reserved status → null', () => {
        expect(decodeFlowControl([0x21, 0, 0])).toBeNull();
        expect(decodeFlowControl([0x33, 0, 0])).toBeNull();
        expect(decodeFlowControl([0x30])).toBeNull();
    });

    it.each([
        [0x00, 0],
        [0x0a, 10],
        [0x7f, 127],
        [0xf1, 0.1],
        [0xf9, 0.9],
        [0x80, 127], // reserved → the maximum
        [0xfa, 127],
    ])('STmin %i → %f ms', (raw, ms) => {
        expect(stMinToMs(raw)).toBeCloseTo(ms);
    });
});
