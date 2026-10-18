import { describe, expect, test } from 'vitest';
import { fromHex, hex } from '../src/core/can/frame';
import { decodeDtc, decodeDtcList, encodeDtc, isEmptyDtc } from '../src/core/obd/dtc';

// [code, bytes]
const EXAMPLES = [
    ['P0300', '03 00'],   // random/multiple cylinder misfire
    ['P0420', '04 20'],   // catalyst efficiency below threshold
    ['P0A80', '0A 80'],   // digits after the first one can be A–F
    ['P0001', '00 01'],
    ['C0035', '40 35'],
    ['B1234', '92 34'],
    ['U0100', 'C1 00'],
    ['U3FFF', 'FF FF'],   // largest possible code
] as const;

describe('encodeDtc', () => {
    test.each(EXAMPLES)('%s → [%s]', (code, bytes) => {
        expect(hex(encodeDtc(code))).toBe(bytes);
    });

    test('case and surrounding whitespace are ignored', () => {
        expect(encodeDtc('p0300')).toEqual([0x03, 0x00]);
        expect(encodeDtc('  P0300 ')).toEqual([0x03, 0x00]);
    });

    test.each(['', 'X1234', 'P4000', 'P030', 'P03000', 'P03G0', 'P 0300'])(
        'invalid code "%s" throws',
        (code) => {
            expect(() => encodeDtc(code)).toThrow();
        },
    );
});

describe('decodeDtc', () => {
    test.each(EXAMPLES)('[%s] ← %s', (code, bytes) => {
        const [a, b] = fromHex(bytes);
        expect(decodeDtc(a, b)).toBe(code);
    });

    test('byte outside 0–255 throws', () => {
        expect(() => decodeDtc(256, 0)).toThrow(RangeError);
        expect(() => decodeDtc(0, -1)).toThrow(RangeError);
    });
});

test('all 65,536 byte pairs survive a round trip unchanged', () => {
    const broken: string[] = [];
    for (let a = 0; a <= 0xff; a++) {
        for (let b = 0; b <= 0xff; b++) {
            const code = decodeDtc(a, b);
            const back = encodeDtc(code);
            if (back[0] !== a || back[1] !== b) broken.push(`${hex([a, b])} → ${code} → ${hex(back)}`);
        }
    }
    expect(broken).toEqual([]);
});

describe('empty slots and code lists', () => {
    test('00 00 is an empty slot', () => {
        expect(isEmptyDtc(0x00, 0x00)).toBe(true);
        expect(isEmptyDtc(0x03, 0x00)).toBe(false);
    });

    test('list skips 00 00', () => {
        expect(decodeDtcList(fromHex('03 00 04 20 00 00'))).toEqual(['P0300', 'P0420']);
    });

    test('empty list', () => {
        expect(decodeDtcList([])).toEqual([]);
        expect(decodeDtcList(fromHex('00 00 00 00 00 00'))).toEqual([]);
    });

    test('odd number of bytes throws', () => {
        expect(() => decodeDtcList(fromHex('03 00 04'))).toThrow(RangeError);
    });
});