import { describe, expect, test } from 'vitest';
import { fromHex, hex, isByte } from '../src/core/can/frame';

describe('hex', () => {
  test('single byte', () => {
    expect(hex(0x0c)).toBe('0C');
    expect(hex(0)).toBe('00');
    expect(hex(255)).toBe('FF');
  });

  test('array of bytes', () => {
    expect(hex([0x41, 0x0c, 0x1a, 0xf8])).toBe('41 0C 1A F8');
    expect(hex([])).toBe('');
  });
});

describe('fromHex', () => {
  test('with spaces, without spaces, lowercase', () => {
    const expected = [0x41, 0x0c, 0x1a, 0xf8];
    expect(fromHex('41 0C 1A F8')).toEqual(expected);
    expect(fromHex('410c1af8')).toEqual(expected);
    expect(fromHex('  41  0C 1A F8 ')).toEqual(expected);
  });

  test('empty string gives an empty array', () => {
    expect(fromHex('')).toEqual([]);
  });

  test.each(['4', '41 0', 'ZZ', '0x41'])('invalid string "%s" throws', (text) => {
    expect(() => fromHex(text)).toThrow();
  });
});

test('isByte', () => {
  expect(isByte(0)).toBe(true);
  expect(isByte(255)).toBe(true);
  expect(isByte(256)).toBe(false);
  expect(isByte(-1)).toBe(false);
  expect(isByte(1.5)).toBe(false);
});