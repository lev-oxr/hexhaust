// Mode 01 PID dictionary: name, unit, formula, decode and encode.
// Formulas come from SAE J1979 and are the same for every OBD2/EOBD vehicle.

import { hex, isByte } from '../can/frame';
import type { Bytes } from '../can/frame';

export interface PidDef {
    pid: number; // 0x0C
    name: string; // 'Engine speed'
    unit: string; // 'rpm'
    length: 1 | 2 | 4; // number of data bytes in the response
    min: number; // smallest value that can be encoded
    max: number; // largest value that can be encoded
    formula: string; // '(256 × A + B) / 4', shown in the inspector
    decode(data: Bytes): number; // [0x1A, 0xF8] → 1726
    encode(value: number): Bytes; // 1726 → [0x1A, 0xF8], used by the ECU
}

// ─── Linear PIDs ──────────────────────────────────────────────────────
// All 15 PIDs below have the form: value = raw × mul / div + offset,
// where "raw" is A (one byte) or 256 × A + B (two bytes).
// So a single factory replaces 15 hand-written decode/encode pairs.

interface LinearSpec {
    pid: number;
    name: string;
    unit: string;
    length: 1 | 2;
    formula: string;
    mul?: number; // defaults to 1
    div?: number; // defaults to 1
    offset?: number; // defaults to 0
}

function linearPid(spec: LinearSpec): PidDef {
    const { pid, name, unit, length, formula, mul = 1, div = 1, offset = 0 } = spec;
    const maxRaw = length === 1 ? 0xff : 0xffff;
    const toValue = (raw: number) => (raw * mul) / div + offset;

    return {
        pid,
        name,
        unit,
        length,
        formula,
        min: toValue(0),
        max: toValue(maxRaw),

        decode(data) {
            if (data.length < length) {
                throw new RangeError(`PID ${hex(pid)} expects ${length} data byte(s), got ${data.length}: [${hex(data)}]`);
            }
            const bytes = data.slice(0, length);
            if (!bytes.every(isByte)) {
                throw new RangeError(`PID ${hex(pid)}: bytes must be integers 0–255: [${bytes.join(', ')}]`);
            }
            // A is the high byte, B is the low byte
            const raw = bytes.reduce((acc, b) => acc * 256 + b, 0);
            return toValue(raw);
        },

        encode(value) {
            if (!Number.isFinite(value)) {
                throw new RangeError(`PID ${hex(pid)}: cannot encode ${value}`);
            }
            // Round to the nearest step and clamp to what fits in the data bytes
            const raw = clamp(Math.round(((value - offset) * div) / mul), 0, maxRaw);
            return length === 1 ? [raw] : [raw >> 8, raw & 0xff];
        },
    };
}

function clamp(n: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, n));
}

// ─── Table ────────────────────────────────────────────────────────────

export const PID_LIST: readonly PidDef[] = [
    linearPid({
        pid: 0x04,
        name: 'Calculated engine load',
        unit: '%',
        length: 1,
        mul: 100,
        div: 255,
        formula: 'A × 100 / 255',
    }),
    linearPid({
        pid: 0x05,
        name: 'Engine coolant temperature',
        unit: '°C',
        length: 1,
        offset: -40,
        formula: 'A − 40',
    }),
    linearPid({
        pid: 0x06,
        name: 'Short term fuel trim, bank 1',
        unit: '%',
        length: 1,
        mul: 100,
        div: 128,
        offset: -100,
        formula: '(A − 128) × 100 / 128',
    }),
    linearPid({
        pid: 0x07,
        name: 'Long term fuel trim, bank 1',
        unit: '%',
        length: 1,
        mul: 100,
        div: 128,
        offset: -100,
        formula: '(A − 128) × 100 / 128',
    }),
    linearPid({
        pid: 0x0b,
        name: 'Intake manifold absolute pressure',
        unit: 'kPa',
        length: 1,
        formula: 'A',
    }),
    linearPid({
        pid: 0x0c,
        name: 'Engine speed',
        unit: 'rpm',
        length: 2,
        div: 4,
        formula: '(256 × A + B) / 4',
    }),
    linearPid({
        pid: 0x0d,
        name: 'Vehicle speed',
        unit: 'km/h',
        length: 1,
        formula: 'A',
    }),
    linearPid({
        pid: 0x0e,
        name: 'Timing advance',
        unit: '° before TDC',
        length: 1,
        div: 2,
        offset: -64,
        formula: 'A / 2 − 64',
    }),
    linearPid({
        pid: 0x0f,
        name: 'Intake air temperature',
        unit: '°C',
        length: 1,
        offset: -40,
        formula: 'A − 40',
    }),
    linearPid({
        pid: 0x10,
        name: 'Mass air flow rate',
        unit: 'g/s',
        length: 2,
        div: 100,
        formula: '(256 × A + B) / 100',
    }),
    linearPid({
        pid: 0x11,
        name: 'Throttle position',
        unit: '%',
        length: 1,
        mul: 100,
        div: 255,
        formula: 'A × 100 / 255',
    }),
    linearPid({
        pid: 0x1f,
        name: 'Run time since engine start',
        unit: 's',
        length: 2,
        formula: '256 × A + B',
    }),
    linearPid({
        pid: 0x2f,
        name: 'Fuel tank level',
        unit: '%',
        length: 1,
        mul: 100,
        div: 255,
        formula: 'A × 100 / 255',
    }),
    linearPid({
        pid: 0x42,
        name: 'Control module voltage',
        unit: 'V',
        length: 2,
        div: 1000,
        formula: '(256 × A + B) / 1000',
    }),
    linearPid({
        pid: 0x46,
        name: 'Ambient air temperature',
        unit: '°C',
        length: 1,
        offset: -40,
        formula: 'A − 40',
    }),
];

/** The same table, indexed by PID number. */
export const PIDS: ReadonlyMap<number, PidDef> = new Map(PID_LIST.map((p) => [p.pid, p] as const));

/** PID definition, or undefined if the PID is not in the dictionary. */
export function getPid(pid: number): PidDef | undefined {
    return PIDS.get(pid);
}

// ─── Supported-PID bitmasks ───────────────────────────────────────────
// Request 01 00 returns 4 bytes = 32 bits. The most significant bit of the
// first byte is PID 01, the next one is PID 02, …, the last bit is PID 20.
// The PID 20 bit means "I also support mask 01 20", and so on down the chain.

/** Whether base is a mask PID: 00, 20, 40, …, E0. */
export function isMaskPid(base: number): boolean {
    return Number.isInteger(base) && base >= 0 && base <= 0xe0 && base % 0x20 === 0;
}

function assertMaskPid(base: number): void {
    if (!isMaskPid(base)) {
        throw new RangeError(`Masks exist only for PIDs 00, 20, 40, …, E0, not for ${base}`);
    }
}

/**
 * For the ECU: builds the 4 data bytes of the response to `01 base`.
 * If any PID in pids is greater than base + 0x20, the last bit is set,
 * meaning "the next mask is supported too".
 */
export function supportedMask(base: number, pids: Iterable<number>): Bytes {
    assertMaskPid(base);
    const mask: Bytes = [0, 0, 0, 0];
    for (const pid of pids) {
        let bit: number;
        if (pid > base && pid <= base + 0x20) {
            bit = pid - base - 1; // PID base+1 → bit 0, …, base+0x20 → bit 31
        } else if (pid > base + 0x20) {
            bit = 31; // PID is further on → the next mask must be queried
        } else {
            continue; // PID belongs to an earlier range
        }
        mask[bit >> 3] |= 0x80 >> (bit & 7); // byte index = bit / 8, bits within a byte count from the left
    }
    return mask;
}

/**
 * For the scanner: parses the 4 data bytes of the response to `01 base` into a list of PIDs.
 * If the list contains base + 0x20, the next mask is worth querying.
 */
export function parseSupported(base: number, mask: Bytes): number[] {
    assertMaskPid(base);
    if (mask.length !== 4 || !mask.every(isByte)) {
        throw new RangeError(`A mask must contain exactly 4 bytes, got [${mask.join(', ')}]`);
    }
    const pids: number[] = [];
    mask.forEach((byte, i) => {
        for (let j = 0; j < 8; j++) {
            if (byte & (0x80 >> j)) pids.push(base + i * 8 + j + 1);
        }
    });
    return pids;
}
