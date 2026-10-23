import { describe, expect, it } from 'vitest';
import { formatTime, hex2, hexBytes, hexId, parseHex } from '../src/ui/format';

describe('hex', () => {
    it('hex2 / hexId / hexBytes', () => {
        expect(hex2(5)).toBe('05');
        expect(hex2(255)).toBe('FF');
        expect(hexId(0x7df)).toBe('7DF');
        expect(hexId(0x7e)).toBe('07E');
        expect(hexBytes([2, 1, 0x0c, 0x55])).toBe('02 01 0C 55');
    });
});

describe('formatTime', () => {
    it.each([
        [19.43, '19.4 ms'],
        [0, '0.0 ms'],
        [9999.94, '9999.9 ms'],
        [12345, '12.35 s'],
        [NaN, '-'],
    ])('%s -> %s', (ms, s) => {
        expect(formatTime(ms)).toBe(s);
    });
});

describe('parseHex', () => {
    it.each([
        ['01 0C', [1, 12]],
        ['010c', [1, 12]],
        ['0x01, 0x0C', [1, 12]],
        ['1 c', [1, 12]],
        ['01-0C', [1, 12]],
        ['09 02', [9, 2]],
    ])('%s', (text, bytes) => {
        expect(parseHex(text)).toEqual({ ok: true, bytes });
    });

    it('empty input', () => {
        expect(parseHex('  ')).toMatchObject({ ok: false });
    });

    it('not hex', () => {
        const r = parseHex('01 ZZ');
        expect(r).toMatchObject({ ok: false });
        if (!r.ok) expect(r.error).toContain('ZZ');
    });

    it('more than 7 bytes do not fit into one frame', () => {
        expect(parseHex('01 02 03 04 05 06 07 08')).toMatchObject({ ok: false });
        expect(parseHex('01 02 03 04 05 06 07')).toMatchObject({ ok: true });
    });
});
