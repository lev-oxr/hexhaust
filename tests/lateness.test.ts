import { describe, expect, it } from 'vitest';
import type { Bytes } from '../src/core/can/frame';
import { explainFrame } from '../src/core/obd/explain';
import { createLatenessTracker, markLate } from '../src/core/obd/lateness';
import { getPid, parseSupported } from '../src/core/obd/pids';

const pad = (b: Bytes): Bytes => [...b, ...Array<number>(8 - b.length).fill(0x55)];
const req = (t: number, ...payload: number[]) => ({ id: 0x7df, t, data: pad([payload.length, ...payload]) });
const resp = (t: number, ...payload: number[]) => ({ id: 0x7e8, t, data: pad([payload.length, ...payload]) });

describe('late responses', () => {
    it('in time: no mark', () => {
        const lt = createLatenessTracker(100);
        expect(lt.check(req(0, 0x01, 0x0c))).toBeNull();
        expect(lt.check(resp(6, 0x41, 0x0c, 0x1a, 0xf8))).toBeNull();
    });

    it('after the timeout, before the next request: "timeout"', () => {
        const lt = createLatenessTracker(100);
        lt.check(req(0, 0x01, 0x0c));
        expect(lt.check(resp(150, 0x41, 0x0c, 0x1a, 0xf8))).toEqual({ afterMs: 150, reason: 'timeout', timeoutMs: 100 });
    });

    it('after the scanner moved on to the next request: "superseded"', () => {
        const lt = createLatenessTracker(100);
        lt.check(req(0, 0x01, 0x0c));
        lt.check(req(100, 0x01, 0x0d));
        expect(lt.check(resp(150, 0x41, 0x0c, 0x1a, 0xf8))?.reason).toBe('superseded');
        // and the answer to the newer request, if it comes in time, is fine
        expect(lt.check(resp(160, 0x41, 0x0d, 0x3c))).toBeNull();
    });

    it('a negative response is matched by its service', () => {
        const lt = createLatenessTracker(100);
        lt.check(req(0, 0x04));
        expect(lt.check(resp(300, 0x7f, 0x04, 0x22))?.reason).toBe('timeout');
    });

    it('a response nobody asked for gets no verdict', () => {
        const lt = createLatenessTracker(100);
        expect(lt.check(resp(10, 0x41, 0x0c, 0x1a, 0xf8))).toBeNull();
    });

    it('a late long message: the First Frame and its Consecutive Frames are all marked, Flow Control is not a request', () => {
        const lt = createLatenessTracker(100);
        lt.check(req(0, 0x09, 0x02));
        const ff = lt.check({ id: 0x7e8, t: 160, data: [0x10, 0x14, 0x49, 0x02, 0x01, 0x31, 0x47, 0x31] });
        expect(ff?.reason).toBe('timeout');
        expect(lt.check({ id: 0x7e0, t: 161, data: pad([0x30, 0x00, 0x00]) })).toBeNull();
        expect(lt.check({ id: 0x7e8, t: 162, data: [0x21, 0x4a, 0x43, 0x35, 0x34, 0x34, 0x34, 0x52] })).toEqual(ff);
    });

    it('markLate() prefixes the log line and adds a note for the inspector', () => {
        const ex = explainFrame(resp(150, 0x41, 0x0c, 0x1a, 0xf8), { getPid, decodeSupportedPids: parseSupported });
        markLate(ex, { afterMs: 150.4, reason: 'timeout', timeoutMs: 100 });
        expect(ex.summary).toMatch(/^LATE 150 ms · response: /);
        expect(ex.notes.at(-1)).toContain('waits only 100 ms');
    });
});
