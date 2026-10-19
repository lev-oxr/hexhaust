// Basic types for bytes and CAN frames, plus small helpers for printing and parsing bytes.

/** An array of bytes; every element is an integer 0–255. */
export type Bytes = number[];

/** Formats one byte or an array of bytes as 'XX' or 'XX XX XX'. */
export function hex(value: number | Bytes): string {
    const bytes = typeof value === 'number' ? [value] : value;
    return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

/** Parses '41 0C 1A F8' or '410C1AF8' into an array of bytes. */
export function fromHex(text: string): Bytes {
    const clean = text.replace(/\s+/g, '');
    if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
        throw new Error(`Invalid hex string: "${text}"`);
    }
    const bytes: Bytes = [];
    for (let i = 0; i < clean.length; i += 2) {
        bytes.push(parseInt(clean.slice(i, i + 2), 16));
    }
    return bytes;
}

/** True if n is an integer 0–255. */
export function isByte(n: number): boolean {
    return Number.isInteger(n) && n >= 0 && n <= 0xff;
}

export interface CanFrame {
    id: number; // 0x7DF, 0x7E0, 0x7E8
    data: Bytes; // always 8 bytes, unused ones = 0x55
    t: number; // ms since start
    from: 'tester' | 'ecu';
}

/** Standard 11-bit IDs for OBD over CAN (ISO 15765-4). */
export const OBD_ID = {
    /** Broadcast (functional) request: "whichever module knows this, answer". */
    FUNCTIONAL: 0x7df,
    /** Physical request addressed to the engine module (ECU #1). */
    ECU_REQUEST: 0x7e0,
    /** The engine module's response. Always the request ID + 8. */
    ECU_RESPONSE: 0x7e8,
} as const;

/** Filler used to pad a frame to 8 bytes. Scanners and ECUs commonly use 0x55 or 0xAA. */
export const PAD_BYTE = 0x55;

/** One "log" line for the console. In stage 4 a real on-page log replaces it. */
export function formatFrame(f: CanFrame): string {
    const t = `${f.t.toFixed(1)} мс`.padStart(10);
    const id = hex(f.id).padStart(3, '0'); // 11-bit ID → always 3 digits: 7E8, 0A0
    return `${t}  ${f.from.padEnd(6)}  ${id}  ${hex(f.data)}`;
}