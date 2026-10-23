// VIN: vehicle identification number, 17 characters. Read with mode 09, PID 02.
//
// Response on CAN:  49 02 01 <17 ASCII bytes>  = 20 bytes, so it needs ISO-TP.
//                   │  │  └─ number of data items (always 1 for a VIN)
//                   │  └──── PID 02
//                   └─────── 09 + 40

import type { Bytes } from '../can/frame';

export const VIN_LENGTH = 17;
/** Letters I, O and Q are never used: too easy to mistake for 1 and 0. */
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

export function isValidVin(vin: string): boolean {
    return VIN_RE.test(vin);
}

/** 'WVW…' → [0x57, 0x56, 0x57, …] */
export function encodeVin(vin: string): Bytes {
    if (!isValidVin(vin)) {
        throw new Error(`Invalid VIN: "${vin}". Expected 17 characters, letters without I, O, Q`);
    }
    return [...vin].map((ch) => ch.charCodeAt(0));
}

/**
 * Response payload 49 02 01 … → 'VIN', or null if this isn't a VIN response.
 * Some ECUs pad the front with 00 bytes, so only the last 17 bytes are taken.
 */
export function decodeVinResponse(resp: Bytes): string | null {
    if (resp.length < 3 + VIN_LENGTH || resp[0] !== 0x49 || resp[1] !== 0x02) return null;
    const text = String.fromCharCode(...resp.slice(-VIN_LENGTH));
    return isValidVin(text) ? text : null;
}
