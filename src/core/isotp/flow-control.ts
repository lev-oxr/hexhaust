// ISO-TP Flow Control (FC): the receiver's answer to a First Frame.
//
//   byte 0   byte 1       byte 2
//   3S       BS           STmin
//   │└─ status: 0 = CTS (go on), 1 = WAIT, 2 = OVERFLOW (won't fit, give up)
//   └── frame type 3 = Flow Control
//
// BS (Block Size): how many Consecutive Frames the sender may send before waiting for the next FC.
//                  0 = no limit, send everything.
// STmin: minimum gap between Consecutive Frames. 00–7F = 0–127 ms, F1–F9 = 100–900 µs.
//
// A real ELM327 answers every First Frame with 30 00 00: "go on, no limit, no gap".

import type { Bytes } from '../can/frame';

export const FLOW_STATUS = {
    CTS: 0,
    WAIT: 1,
    OVERFLOW: 2,
} as const;
export type FlowStatus = (typeof FLOW_STATUS)[keyof typeof FLOW_STATUS];

export interface FlowControl {
    status: FlowStatus;
    /** 0–255, 0 = no limit */
    blockSize: number;
    /** The raw STmin byte; stMinToMs() turns it into milliseconds. */
    stMin: number;
}

/** What the tester (and ELM327) answer by default: CTS, no block limit, no gap. */
export const DEFAULT_FLOW_CONTROL: FlowControl = { status: FLOW_STATUS.CTS, blockSize: 0, stMin: 0 };

export function encodeFlowControl(fc: FlowControl): Bytes {
    return [0x30 | fc.status, fc.blockSize & 0xff, fc.stMin & 0xff];
}

/** Frame data → FlowControl, or null if this isn't a Flow Control frame. */
export function decodeFlowControl(data: Bytes): FlowControl | null {
    if (data.length < 3 || data[0] >> 4 !== 0x3) return null;
    const status = data[0] & 0x0f;
    if (status > FLOW_STATUS.OVERFLOW) return null; // 3–F are reserved
    return { status: status as FlowStatus, blockSize: data[1], stMin: data[2] };
}

/**
 * STmin byte → milliseconds.
 * Reserved values (80–F0, FA–FF) must be treated as the maximum, 127 ms (ISO 15765-2).
 */
export function stMinToMs(raw: number): number {
    if (raw <= 0x7f) return raw;
    if (raw >= 0xf1 && raw <= 0xf9) return (raw - 0xf0) / 10;
    return 0x7f;
}