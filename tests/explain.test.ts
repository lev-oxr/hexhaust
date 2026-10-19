import { describe, expect, it } from 'vitest';
import { describeId, directionOf, explainFrame, formatValue, type Vocab } from '../src/core/obd/explain';
import { decodeSupportedPids, getPid } from './helpers/fake-vocab';

const vocab: Vocab = {
  getPid,
  decodeSupportedPids,
  decodeDtc: (a, b) => `P${(a >> 4) & 3}${(a & 0x0f).toString(16)}${b.toString(16).padStart(2, '0')}`.toUpperCase(),
};

const roles = (id: number, data: number[]) => explainFrame({ id, data }, vocab).bytes.map((b) => b.role);
const shorts = (id: number, data: number[]) => explainFrame({ id, data }, vocab).bytes.map((b) => b.short);

describe('direction and ID', () => {
  it.each([
    [0x7df, 'request'],
    [0x7e0, 'request'],
    [0x7e7, 'request'],
    [0x7e8, 'response'],
    [0x7ef, 'response'],
    [0x123, 'other'],
  ] as const)('%s -> %s', (id, dir) => {
    expect(directionOf(id)).toBe(dir);
  });

  it('ID text', () => {
    expect(describeId(0x7df)).toContain('broadcast');
    expect(describeId(0x7e0)).toContain('ECU #1');
    expect(describeId(0x7e9)).toContain('response from ECU #2');
    expect(describeId(0x123)).toContain('outside the OBD-II range');
  });
});

describe('request 01 0C', () => {
  const data = [0x02, 0x01, 0x0c, 0x55, 0x55, 0x55, 0x55, 0x55];

  it('byte roles', () => {
    expect(roles(0x7df, data)).toEqual(['pci', 'service', 'pid', 'pad', 'pad', 'pad', 'pad', 'pad']);
    expect(shorts(0x7df, data).slice(0, 3)).toEqual(['PCI', 'mode', 'PID']);
  });

  it('short summary and no calculation', () => {
    const ex = explainFrame({ id: 0x7df, data }, vocab);
    expect(ex.direction).toBe('request');
    expect(ex.summary).toBe('request 01 0C · Engine speed');
    expect(ex.calc).toBeNull();
    expect(ex.notes).toEqual([]);
  });

  it('request with several PIDs: every byte is a PID', () => {
    expect(roles(0x7df, [0x03, 0x01, 0x0c, 0x0d, 0x55, 0x55, 0x55, 0x55]).slice(0, 4)).toEqual(['pci', 'service', 'pid', 'pid']);
  });
});

describe('response 41 0C 1A F8', () => {
  const data = [0x04, 0x41, 0x0c, 0x1a, 0xf8, 0x55, 0x55, 0x55];

  it('byte roles', () => {
    expect(roles(0x7e8, data)).toEqual(['pci', 'service', 'pid', 'data', 'data', 'pad', 'pad', 'pad']);
    expect(shorts(0x7e8, data).slice(0, 5)).toEqual(['PCI', 'mode', 'PID', 'A', 'B']);
  });

  it('fills the numbers into the formula', () => {
    const ex = explainFrame({ id: 0x7e8, data }, vocab);
    expect(ex.calc).toEqual({
      formula: '(256 × A + B) / 4',
      substituted: '(256 × 26 + 248) / 4',
      result: '1726 rpm',
    });
    expect(ex.summary).toBe('response: Engine speed = 1726 rpm');
  });

  it('one-byte formula: 05 -> 35 °C', () => {
    const ex = explainFrame({ id: 0x7e8, data: [0x03, 0x41, 0x05, 0x4b, 0x55, 0x55, 0x55, 0x55] }, vocab);
    expect(ex.calc?.substituted).toBe('75 − 40');
    expect(ex.calc?.result).toBe('35 °C');
  });

  it('a PID missing from the table does not break the breakdown', () => {
    const ex = explainFrame({ id: 0x7e8, data: [0x03, 0x41, 0x99, 0x10, 0x55, 0x55, 0x55, 0x55] }, vocab);
    expect(ex.calc).toBeNull();
    expect(ex.summary).toBe('response to PID 99');
    expect(ex.bytes[2]?.text).toContain('unknown PID');
  });

  it('missing data bytes -> a warning', () => {
    const ex = explainFrame({ id: 0x7e8, data: [0x03, 0x41, 0x0c, 0x1a, 0x55, 0x55, 0x55, 0x55] }, vocab);
    expect(ex.notes.length).toBe(1);
    expect(ex.calc).toBeNull();
  });
});

describe('supported-PID bitmask', () => {
  it('01 00 -> list of PIDs', () => {
    const data = [0x06, 0x41, 0x00, 0xbe, 0x1f, 0xa8, 0x13, 0x55];
    const ex = explainFrame({ id: 0x7e8, data }, vocab);
    expect(roles(0x7e8, data)).toEqual(['pci', 'service', 'pid', 'data', 'data', 'data', 'data', 'pad']);
    expect(ex.summary).toBe('response: supported PIDs 01-20');
    expect(ex.calc?.substituted).toBe('10111110 00011111 10101000 00010011');
    expect(ex.calc?.result.startsWith('01, 03, 04, 05, 06, 07')).toBe(true);
  });

  it('request 01 20 is named after the bitmask', () => {
    const ex = explainFrame({ id: 0x7df, data: [0x02, 0x01, 0x20, 0x55, 0x55, 0x55, 0x55, 0x55] }, vocab);
    expect(ex.summary).toBe('request 01 20 · supported PIDs 21-40');
  });
});

describe('negative response', () => {
  const data = [0x03, 0x7f, 0x01, 0x11, 0x55, 0x55, 0x55, 0x55];

  it('roles and explanations', () => {
    expect(roles(0x7e8, data)).toEqual(['pci', 'error', 'service', 'error', 'pad', 'pad', 'pad', 'pad']);
    const ex = explainFrame({ id: 0x7e8, data }, vocab);
    expect(ex.summary).toBe('refusal: mode 01 · service not supported');
    expect(ex.bytes[3]?.text).toContain('11');
  });
});

describe('ISO-TP', () => {
  it('VIN First Frame: length and ASCII', () => {
    const data = [0x10, 0x14, 0x49, 0x02, 0x01, 0x57, 0x41, 0x55];
    const ex = explainFrame({ id: 0x7e8, data }, vocab);
    expect(roles(0x7e8, data)).toEqual(['pci', 'pci', 'service', 'pid', 'data', 'data', 'data', 'data']);
    expect(ex.bytes[1]?.text).toContain('20 bytes');
    expect(ex.bytes[5]?.short).toBe('W');
    expect(ex.summary).toBe('First Frame · 20 bytes · VIN (vehicle identification number)');
  });

  it('First Frame length is 12 bits', () => {
    const ex = explainFrame({ id: 0x7e8, data: [0x1f, 0xff, 0x49, 0x02, 0x01, 0x57, 0x41, 0x55] }, vocab);
    expect(ex.bytes[1]?.text).toContain('4095 bytes');
  });

  it('Consecutive Frame: sequence number and data', () => {
    const data = [0x21, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37];
    const ex = explainFrame({ id: 0x7e8, data }, vocab);
    expect(ex.summary).toBe('Consecutive Frame #1');
    expect(roles(0x7e8, data)).toEqual(['pci', 'data', 'data', 'data', 'data', 'data', 'data', 'data']);
  });

  it('Flow Control: CTS, BS, STmin', () => {
    const data = [0x30, 0x00, 0x00, 0x55, 0x55, 0x55, 0x55, 0x55];
    const ex = explainFrame({ id: 0x7e0, data }, vocab);
    expect(ex.summary).toContain('CTS');
    expect(roles(0x7e0, data)).toEqual(['pci', 'pci', 'pci', 'pad', 'pad', 'pad', 'pad', 'pad']);
    expect(ex.bytes[2]?.text).toContain('0 ms');
  });

  it('STmin in microseconds', () => {
    const ex = explainFrame({ id: 0x7e0, data: [0x30, 0x08, 0xf3, 0x55, 0x55, 0x55, 0x55, 0x55] }, vocab);
    expect(ex.bytes[2]?.text).toContain('300 µs');
  });
});

describe('trouble codes (mode 03)', () => {
  it('response with two codes', () => {
    const data = [0x06, 0x43, 0x02, 0x03, 0x00, 0x04, 0x20, 0x55];
    const ex = explainFrame({ id: 0x7e8, data }, vocab);
    expect(roles(0x7e8, data)).toEqual(['pci', 'service', 'data', 'data', 'data', 'data', 'data', 'pad']);
    expect(ex.summary).toBe('response: 2 trouble code(s) · stored trouble codes');
    expect(ex.bytes[3]?.text).toContain('P0300');
    expect(ex.bytes[5]?.text).toContain('P0420');
  });

  it('no codes', () => {
    const ex = explainFrame({ id: 0x7e8, data: [0x02, 0x43, 0x00, 0x55, 0x55, 0x55, 0x55, 0x55] }, vocab);
    expect(ex.summary).toContain('no codes');
  });
});

describe('malformed frames', () => {
  it('Single Frame with length 9', () => {
    const ex = explainFrame({ id: 0x7df, data: [0x09, 0x01, 0x0c, 0x55, 0x55, 0x55, 0x55, 0x55] }, vocab);
    expect(ex.notes[0]).toContain('Single Frame');
    expect(ex.bytes).toHaveLength(8);
  });

  it('unknown PCI type', () => {
    const ex = explainFrame({ id: 0x7e8, data: [0xf0, 1, 2, 3, 4, 5, 6, 7] }, vocab);
    expect(ex.summary).toBe('Unknown frame');
    expect(ex.notes.length).toBe(1);
  });

  it('ID outside OBD-II', () => {
    const ex = explainFrame({ id: 0x123, data: [0x02, 0x01, 0x0c, 0x55, 0x55, 0x55, 0x55, 0x55] }, vocab);
    expect(ex.direction).toBe('other');
    expect(ex.idText).toContain('outside the OBD-II range');
  });

  it('frame shorter than 8 bytes and an empty frame', () => {
    expect(explainFrame({ id: 0x7df, data: [0x02, 0x01, 0x0c] }, vocab).bytes).toHaveLength(3);
    expect(() => explainFrame({ id: 0x7df, data: [] }, vocab)).not.toThrow();
  });

  it('every byte of a frame has an explanation', () => {
    for (const data of [
      [0x02, 0x01, 0x0c, 0x55, 0x55, 0x55, 0x55, 0x55],
      [0x10, 0x14, 0x49, 0x02, 0x01, 0x57, 0x41, 0x55],
      [0x30, 0, 0, 0x55, 0x55, 0x55, 0x55, 0x55],
      [0x03, 0x7f, 0x01, 0x11, 0x55, 0x55, 0x55, 0x55],
    ]) {
      const ex = explainFrame({ id: 0x7e8, data }, vocab);
      expect(ex.bytes).toHaveLength(8);
      ex.bytes.forEach((b, i) => {
        expect(b.index).toBe(i);
        expect(b.value).toBe(data[i]);
        expect(b.text.length).toBeGreaterThan(0);
      });
    }
  });
});

describe('formatValue', () => {
  it.each([
    [1726, '1726'],
    [13.5, '13.5'],
    [29.8039, '29.8'],
    [-40, '-40'],
  ])('%s -> %s', (n, s) => {
    expect(formatValue(n)).toBe(s);
  });
});
