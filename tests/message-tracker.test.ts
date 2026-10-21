// The log's view of long messages: which message bytes each frame carries and what they mean.
import { describe, expect, it } from 'vitest';
import type { Bytes } from '../src/core/can/frame';
import { segment } from '../src/core/isotp/segment';
import { decodeDtc } from '../src/core/obd/dtc';
import { explainFrame, type Vocab } from '../src/core/obd/explain';
import { MessageTracker } from '../src/core/obd/message-tracker';
import { decodeSupportedPids, getPid } from './helpers/fake-vocab';

const vocab: Vocab = { getPid, decodeSupportedPids, decodeDtc };
const pad = (f: Bytes): Bytes => [...f, ...Array<number>(8 - f.length).fill(0x55)];

/** Runs the frames of one message from 7E8 through a tracker, returns explanation + info for each. */
function run(payload: Bytes) {
    const tracker = new MessageTracker(vocab);
    return segment(payload).map((f) => {
        const frame = { id: 0x7e8, data: pad(f) };
        const ex = explainFrame(frame, vocab);
        return { ex, info: tracker.annotate(frame, ex) };
    });
}

const VIN = '1G1JC5444R7252367';
const VIN_RESPONSE = [0x49, 0x02, 0x01, ...[...VIN].map((c) => c.charCodeAt(0))];
const DTC_RESPONSE = [0x43, 0x03, 0x03, 0x00, 0x04, 0x20, 0x01, 0x71];

describe('MessageTracker', () => {
    it('VIN: each CF byte is a numbered character', () => {
        const [ff, cf1, cf2] = run(VIN_RESPONSE);
        expect(ff.info?.rows[0]).toEqual(['length', '20 bytes']);
        expect(cf1.ex.bytes.map((b) => b.short)).toEqual(['PCI', 'J', 'C', '5', '4', '4', '4', 'R']);
        expect(cf1.ex.bytes[1].text).toBe('Message byte 7 of 20. VIN character 4: "J" (ASCII 0x4A).');
        expect(cf1.info?.rows).toEqual([['this frame', 'message bytes 7-13'], ['received', '13 of 20 bytes']]);
        expect(cf2.ex.summary).toBe(`Consecutive Frame #2 · complete: VIN ${VIN}`);
    });

    it('trouble codes: the CF names the code and pads the rest', () => {
        const [, cf] = run(DTC_RESPONSE);
        expect(cf.ex.bytes.map((b) => b.role)).toEqual(['pci', 'data', 'data', 'pad', 'pad', 'pad', 'pad', 'pad']);
        expect(cf.ex.bytes[1].text).toContain('Trouble code #3 P0171: first of its two bytes');
        expect(cf.info?.rows.at(-1)).toEqual(['meaning', '3 stored trouble code(s): P0300, P0420, P0171']);
    });

    it('a code split between two CFs: the first half says the rest is coming, the second names it', () => {
        // 6 codes = 2 + 12 = 14 bytes. FF: header + codes 1-2. CF #1: codes 3-5 and the first byte of code 6.
        const codes = [1, 2, 3, 4, 5, 6].flatMap((n) => [0x00, n]); // P0001 … P0006
        const [, cf1, cf2] = run([0x43, 0x06, ...codes]);
        expect(cf1.ex.bytes[7].text).toContain('Trouble code #6: first of its two bytes. The second byte comes in the next frame.');
        expect(cf2.ex.bytes[1].text).toContain('Trouble code #6 P0006: second of its two bytes.');
    });

    it('a skipped CF is reported as broken', () => {
        const tracker = new MessageTracker(vocab);
        const [ff, , cf2] = segment(VIN_RESPONSE).map(pad);
        tracker.annotate({ id: 0x7e8, data: ff }, explainFrame({ id: 0x7e8, data: ff }, vocab));
        const ex = explainFrame({ id: 0x7e8, data: cf2 }, vocab);
        expect(tracker.annotate({ id: 0x7e8, data: cf2 }, ex)).toBeUndefined();
        expect(ex.summary).toContain('broken: wrong sequence number');
        expect(ex.notes[0]).toContain('request ends with no response');
    });

    it('Single Frames get no extra info', () => {
        const tracker = new MessageTracker(vocab);
        const data = pad([0x04, 0x41, 0x0c, 0x1a, 0xf8]);
        expect(tracker.annotate({ id: 0x7e8, data }, explainFrame({ id: 0x7e8, data }, vocab))).toBeUndefined();
    });
});
