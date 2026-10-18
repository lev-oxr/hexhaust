import { describe, expect, test } from 'vitest';
import { fromHex, hex } from '../src/core/can/frame';
import type { Bytes } from '../src/core/can/frame';
import { PID_LIST, getPid, parseSupported, supportedMask } from '../src/core/obd/pids';
import type { PidDef } from '../src/core/obd/pids';

/** Looks up a PID in the dictionary, or fails the test if it is missing. */
function pid(n: number): PidDef {
    const def = getPid(n);
    if (!def) throw new Error(`PID ${hex(n)} is not in the dictionary`);
    return def;
}

/** Every possible data input for a PID: 256 for one byte, 65,536 for two. */
function* allInputs(def: PidDef): Generator<Bytes> {
    const maxRaw = def.length === 1 ? 0xff : 0xffff;
    for (let raw = 0; raw <= maxRaw; raw++) {
        yield def.length === 1 ? [raw] : [raw >> 8, raw & 0xff];
    }
}

describe('PID table', () => {
    test('15 PIDs, no duplicates', () => {
        const ids = PID_LIST.map((p) => p.pid);
        expect(ids).toHaveLength(15);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('getPid returns undefined for an unknown PID', () => {
        expect(getPid(0x99)).toBeUndefined();
    });
});

describe('decode: examples', () => {
    // [PID, data bytes, expected value]
    test.each([
        ['0C', '1A F8', 1726],
        ['0C', '00 00', 0],
        ['05', '4B', 35],
        ['05', '00', -40],
        ['0D', '3C', 60],
        ['11', 'FF', 100],
        ['04', '00', 0],
        ['06', '80', 0],
        ['07', '00', -100],
        ['0B', '65', 101],
        ['0E', '80', 0],
        ['0E', '9A', 13],
        ['0F', '41', 25],
        ['10', '01 F4', 5],
        ['1F', '01 00', 256],
        ['2F', 'FF', 100],
        ['42', '31 26', 12.582],
        ['46', '00', -40],
    ] as const)('PID %s: [%s] → %s', (id, data, expected) => {
        expect(pid(parseInt(id, 16)).decode(fromHex(data))).toBeCloseTo(expected, 9);
    });

    test('extra bytes are ignored', () => {
        expect(pid(0x0d).decode([0x3c, 0x55, 0x55])).toBe(60);
    });

    test('too few bytes throws', () => {
        expect(() => pid(0x0c).decode([0x1a])).toThrow(RangeError);
    });

    test('byte outside 0–255 throws', () => {
        expect(() => pid(0x0d).decode([256])).toThrow(RangeError);
        expect(() => pid(0x0d).decode([-1])).toThrow(RangeError);
        expect(() => pid(0x0d).decode([1.5])).toThrow(RangeError);
    });
});

describe('encode: examples', () => {
    test.each([
        ['0C', 1726, '1A F8'],
        ['05', 35, '4B'],
        ['0D', 60, '3C'],
        ['42', 12.582, '31 26'],
        ['11', 50, '80'],          // 50 % is 127.5 raw, which rounds to 128
    ] as const)('PID %s: %s → [%s]', (id, value, expected) => {
        expect(hex(pid(parseInt(id, 16)).encode(value))).toBe(expected);
    });

    test('NaN and infinity throw', () => {
        expect(() => pid(0x0c).encode(NaN)).toThrow(RangeError);
        expect(() => pid(0x0c).encode(Infinity)).toThrow(RangeError);
    });
});

describe.each(PID_LIST.map((p) => [hex(p.pid), p] as const))('PID %s', (_, def) => {
    test('bytes → number → bytes gives the same bytes (for every possible input)', () => {
        const broken: string[] = [];
        for (const bytes of allInputs(def)) {
            const back = def.encode(def.decode(bytes));
            if (hex(back) !== hex(bytes)) broken.push(`${hex(bytes)} → ${hex(back)}`);
        }
        expect(broken).toEqual([]);
    });

    test('number → bytes → number differs by at most half a step', () => {
        const maxRaw = def.length === 1 ? 0xff : 0xffff;
        const step = (def.max - def.min) / maxRaw;
        for (let i = 0; i <= 100; i++) {
            const x = def.min + ((def.max - def.min) * i) / 100;
            expect(Math.abs(def.decode(def.encode(x)) - x)).toBeLessThanOrEqual(step / 2 + 1e-9);
        }
    });

    test('out-of-range values are clamped to the limits', () => {
        expect(def.encode(def.max + 1000)).toEqual(def.encode(def.max));
        expect(def.encode(def.min - 1000)).toEqual(def.encode(def.min));
    });
});

describe('supported-PID masks', () => {
    const simPids = PID_LIST.map((p) => p.pid);

    // Simulator responses to 01 00, 01 20, 01 40 (without 41 and the mask number)
    test.each([
        ['00', '1E 3F 80 03'],
        ['20', '00 02 00 01'],
        ['40', '44 00 00 00'],
        ['60', '00 00 00 00'],
    ])('supportedMask for 01 %s → [%s]', (base, expected) => {
        expect(hex(supportedMask(parseInt(base, 16), simPids))).toBe(expected);
    });

    test.each([
        ['00', '1E 3F 80 03', [0x04, 0x05, 0x06, 0x07, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x1f, 0x20]],
        ['20', '00 02 00 01', [0x2f, 0x40]],
        ['40', '44 00 00 00', [0x42, 0x46]],
    ])('parseSupported for 01 %s [%s]', (base, mask, expected) => {
        expect(parseSupported(parseInt(base, 16), fromHex(mask))).toEqual(expected);
    });

    test('Wikipedia example: BE 1F A8 13', () => {
        expect(parseSupported(0x00, fromHex('BE 1F A8 13'))).toEqual([
            0x01, 0x03, 0x04, 0x05, 0x06, 0x07, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x13, 0x15, 0x1c, 0x1f, 0x20,
        ]);
    });

    test('mask → list → the same mask', () => {
        for (const base of [0x00, 0x20, 0x40]) {
            const mask = supportedMask(base, simPids);
            expect(supportedMask(base, parseSupported(base, mask))).toEqual(mask);
        }
    });

    test('invalid mask throws', () => {
        expect(() => supportedMask(0x10, simPids)).toThrow(RangeError);
        expect(() => parseSupported(0x00, [0x1e, 0x3f, 0x80])).toThrow(RangeError);
    });
});