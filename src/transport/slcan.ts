// slcan (LAWICEL) text protocol, as data. Pure functions: no port, no time.
//
// A CANable adapter with slcan firmware is a USB serial port that speaks one line per command or frame:
//   we send     "S6\r"                       set 500 kbit/s
//               "O\r"                        open (join the bus)
//               "t7DF802010C5555555555\r"    a frame: t + ID 7DF + length 8 + bytes 02 01 0C 55 55 55 55 55
//   it sends    "t7E8804410C1AF8555555\r"    every frame it hears: ID 7E8, 8 bytes 04 41 0C 1A F8 55 55 55
// Unlike an ELM327 it does no ISO-TP: First Frame, Flow Control, Consecutive Frames are all ours.
//
// Two firmware dialects are handled:
//   CANable 2.5 (ElmueSoft, recommended for the SH-C31A): answers every command with CR (ok) or BEL (error),
//     "V" returns "+Board: …\tSlcan: 105\t…", and "ME" turns on bus error reports "Exxxxxxxx".
//   legacy canable2-fw (normaldotcom): no feedback at all, "V" returns one line of text.

import type { Bytes } from '../core/can/frame';

export type Bitrate = 125 | 250 | 500 | 1000;

/** Nominal bitrate commands. Cars use 500 kbit/s for OBD (VW, most others), some 250. */
export const BITRATE_COMMANDS: Record<Bitrate, string> = { 125: 'S4', 250: 'S5', 500: 'S6', 1000: 'S8' };

export const BITRATES: Bitrate[] = [500, 250, 125, 1000];

/** Hex as the firmware writes it: upper case, two digits per byte. */
const hex = (n: number, digits: number): string => n.toString(16).toUpperCase().padStart(digits, '0');

/** 7DF + [02 01 0C 55 55 55 55 55] → "t7DF802010C5555555555". 11-bit IDs and classic CAN only. */
export function encodeFrame(id: number, data: Bytes): string {
    if (!Number.isInteger(id) || id < 0 || id > 0x7ff) throw new RangeError(`An 11-bit CAN ID is 000-7FF, got ${id}`);
    if (data.length > 8) throw new RangeError(`A classic CAN frame carries at most 8 bytes, got ${data.length}`);
    for (const b of data) {
        if (!Number.isInteger(b) || b < 0 || b > 0xff) throw new RangeError(`A byte is 0-255, got ${b}`);
    }
    return `t${hex(id, 3)}${data.length}${data.map((b) => hex(b, 2)).join('')}`;
}

// ---------- Bus status (CANable 2.5 error reports, "ME") ----------

export type BusState = 'active' | 'warning' | 'passive' | 'bus-off';

export interface BusStatus {
    state: BusState;
    /** The last protocol error the CAN controller saw, in words; null = none. */
    lastError: string | null;
    /** Firmware problems: "Tx failed", "USB IN buffer overflow"… */
    flags: string[];
    txErrors: number;
    rxErrors: number;
}

const BUS_STATES: BusState[] = ['active', 'warning', 'passive', 'bus-off'];
const PROTOCOL_ERRORS = [null, 'bit stuffing error', 'frame format error', 'no ACK received', 'recessive bit error', 'dominant bit error', 'CRC error'];
const FLAGS: [number, string][] = [
    [0x01, 'Rx failed'],
    [0x02, 'Tx failed'],
    [0x04, 'CAN Tx buffer overflow'],
    [0x08, 'USB IN buffer overflow'],
    [0x10, 'Tx timeout'],
];

/** "E2310800C" → passive, no ACK received, Tx timeout, 128 Tx errors, 12 Rx errors. */
export function parseBusStatus(line: string): BusStatus | null {
    const m = /^E([0-3])([0-6])([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})$/i.exec(line);
    if (!m) return null;
    const flagBits = parseInt(m[3], 16);
    return {
        state: BUS_STATES[Number(m[1])],
        lastError: PROTOCOL_ERRORS[Number(m[2])],
        flags: FLAGS.filter(([bit]) => (flagBits & bit) !== 0).map(([, name]) => name),
        txErrors: parseInt(m[4], 16),
        rxErrors: parseInt(m[5], 16),
    };
}

/** In words, plus what it usually means at an OBD port. */
export function describeBusStatus(s: BusStatus): string {
    const parts = [
        { active: 'Bus active', warning: 'Bus warning', passive: 'Bus passive', 'bus-off': 'Bus off' }[s.state],
        s.lastError,
        ...s.flags,
        `Tx errors ${s.txErrors}, Rx errors ${s.rxErrors}`,
    ].filter(Boolean);
    let text = parts.join(' · ');
    if (s.lastError === 'no ACK received') text += '. Nobody acknowledged our frame: ignition off, or CAN-H / CAN-L not connected.';
    else if (s.lastError && s.lastError !== 'no ACK received') text += '. Usually a wrong bitrate or CAN-H and CAN-L swapped.';
    if (s.state === 'bus-off') text += ' The controller stopped sending; reconnect to reset it.';
    return text;
}

// ---------- Version ("V") ----------

export interface AdapterInfo {
    /** 'canable-2.5' answers commands with CR/BEL and reports bus errors; 'legacy' does neither. */
    firmware: 'canable-2.5' | 'legacy';
    /** The reply to "V" as it came. */
    text: string;
    board?: string;
    /** Slcan module version of CANable 2.5 (105 = legacy CR/BEL feedback). */
    slcanVersion?: number;
    serial?: string;
}

/** "+Board: Multiboard\tMCU: STM32G431\t…\tSlcan: 105\t…" or a legacy one-liner. */
export function parseVersion(line: string): AdapterInfo {
    const text = line.trim();
    if (!text.startsWith('+') || !text.includes('\t')) return { firmware: 'legacy', text };

    const pairs = new Map<string, string>();
    for (const part of text.slice(1).split('\t')) {
        const i = part.indexOf(':');
        if (i > 0) pairs.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
    const slcan = Number(pairs.get('Slcan'));
    return {
        firmware: 'canable-2.5',
        text,
        board: pairs.get('Board'),
        slcanVersion: Number.isFinite(slcan) ? slcan : undefined,
        serial: pairs.get('Serial'),
    };
}

// ---------- Lines from the adapter ----------

export interface ReceivedFrame {
    id: number;
    data: Bytes;
    /** 29-bit ID ('T', 'R', 'D', 'B'). */
    extended: boolean;
    /** CAN FD ('d', 'D', 'b', 'B'). */
    fd: boolean;
    /** Remote frame ('r', 'R'): no data. */
    remote: boolean;
}

export type SlcanToken =
    | { kind: 'frame'; frame: ReceivedFrame }
    /** Bare CR, or "#" in advanced feedback mode: the last command worked. */
    | { kind: 'ok' }
    /** BEL, or "#1"…"#=": the last command failed. */
    | { kind: 'fail'; code?: string }
    /** "+…": the text answer to a command (V, *Boot0:?). */
    | { kind: 'info'; text: string }
    | { kind: 'status'; status: BusStatus }
    | { kind: 'other'; text: string };

/** CAN FD length codes 9…F. */
const FD_LENGTHS: Record<string, number> = { '9': 12, A: 16, B: 20, C: 24, D: 32, E: 48, F: 64 };

/** One token from LineSplitter → what it means. */
export function parseLine(line: string): SlcanToken {
    if (line === '') return { kind: 'ok' };
    if (line === '\x07') return { kind: 'fail' };
    if (line === '#') return { kind: 'ok' };
    if (/^#.$/.test(line)) return { kind: 'fail', code: line.slice(1) };
    if (line.startsWith('+')) return { kind: 'info', text: line };

    const status = parseBusStatus(line);
    if (status) return { kind: 'status', status };

    const frame = parseFrame(line);
    if (frame) return { kind: 'frame', frame };
    return { kind: 'other', text: line };
}

function parseFrame(line: string): ReceivedFrame | null {
    const type = line[0];
    if (!type || !'tTrRdDbB'.includes(type)) return null;
    const extended = type === type.toUpperCase();
    const fd = 'dDbB'.includes(type);
    const remote = 'rR'.includes(type);
    const idLen = extended ? 8 : 3;

    const m = new RegExp(`^.([0-9A-Fa-f]{${idLen}})([0-9A-Fa-f])([0-9A-Fa-f]*)S?$`).exec(line);
    if (!m) return null;
    const id = parseInt(m[1], 16);
    if ((!extended && id > 0x7ff) || id > 0x1fffffff) return null;

    const dlc = m[2].toUpperCase();
    const length = fd ? (FD_LENGTHS[dlc] ?? Number(dlc)) : Number(dlc);
    if (!fd && !(length <= 8)) return null;
    if (remote) return m[3] === '' ? { id, data: [], extended, fd, remote } : null;
    if (m[3].length !== length * 2) return null;

    const data: Bytes = [];
    for (let i = 0; i < m[3].length; i += 2) data.push(parseInt(m[3].slice(i, i + 2), 16));
    return { id, data, extended, fd, remote };
}

/**
 * Cuts the byte stream into tokens. A line ends with CR; BEL is a token of its own (it comes without a CR).
 * An empty token '' is a bare CR: the "ok" feedback of CANable 2.5.
 */
export class LineSplitter {
    private partial = '';

    push(chunk: string): string[] {
        const out: string[] = [];
        for (const ch of chunk) {
            if (ch === '\r') {
                out.push(this.partial);
                this.partial = '';
            } else if (ch === '\x07') {
                out.push('\x07');
            } else if (ch === '\t' || ch >= ' ') {
                this.partial += ch;
            }
            // '\n' and other control characters are dropped: slcan never sends them on purpose.
        }
        return out;
    }

    reset(): void {
        this.partial = '';
    }
}