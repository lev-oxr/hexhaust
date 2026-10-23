// Diagnostic trouble codes (DTC): 'P0300' ⇄ [0x03, 0x00].
//
// Two bytes = 16 bits:
//   bits 15–14  system: P=00, C=01, B=10, U=11
//   bits 13–12  first digit: 0–3
//   bits 11–0   three hex digits
//
// So after the letter, the code is just a 14-bit number written in hex:
// 'P0300' → 0x0300, 'U0100' → 0b11 << 14 | 0x0100 = 0xC100.

import { hex, isByte } from '../can/frame';
import type { Bytes } from '../can/frame';

const SYSTEMS = ['P', 'C', 'B', 'U'] as const;
export type DtcSystem = (typeof SYSTEMS)[number];

const DTC_RE = /^([PCBU])([0-3][0-9A-F]{3})$/;

/** 'P0300' → [0x03, 0x00]. Case and surrounding whitespace are ignored. */
export function encodeDtc(code: string): [number, number] {
    const match = DTC_RE.exec(code.trim().toUpperCase());
    if (!match) {
        throw new Error(`Invalid trouble code: "${code}". Expected a format like P0300`);
    }
    const [, letter, digits] = match;
    const system = SYSTEMS.indexOf(letter as DtcSystem);
    const value = (system << 14) | parseInt(digits, 16);
    return [value >> 8, value & 0xff];
}

/** [0x03, 0x00] → 'P0300'. */
export function decodeDtc(a: number, b: number): string {
    if (!isByte(a) || !isByte(b)) {
        throw new RangeError(`Code bytes must be integers 0–255: ${a}, ${b}`);
    }
    const system = SYSTEMS[a >> 6];
    const digits = (((a & 0x3f) << 8) | b).toString(16).toUpperCase().padStart(4, '0');
    return system + digits;
}

/** 00 00 is an empty slot in a response, not the code P0000. */
export function isEmptyDtc(a: number, b: number): boolean {
    return a === 0 && b === 0;
}

/**
 * Parses a sequence of byte pairs into a list of codes, skipping 00 00.
 * Pass only the bytes after the header: after 43 on K-line,
 * after 43 and the count byte on CAN.
 */
export function decodeDtcList(bytes: Bytes): string[] {
    if (bytes.length % 2 !== 0) {
        throw new RangeError(`Codes come in byte pairs, got ${bytes.length} bytes: [${hex(bytes)}]`);
    }
    const codes: string[] = [];
    for (let i = 0; i < bytes.length; i += 2) {
        const a = bytes[i];
        const b = bytes[i + 1];
        if (isEmptyDtc(a, b)) continue;
        codes.push(decodeDtc(a, b));
    }
    return codes;
}
