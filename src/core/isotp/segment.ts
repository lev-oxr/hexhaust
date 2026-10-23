// ISO-TP: splitting a message into CAN frames.
//
// Up to 7 bytes  → one Single Frame (see single-frame.ts).
// 8–4095 bytes   → First Frame + Consecutive Frames:
//
//   First Frame (FF)         1L LL d d d d d d     L LL = total length, 12 bits; then the first 6 bytes
//   Consecutive Frame (CF)   2N d d d d d d d      N = sequence number 1, 2 … F, 0, 1 …; then up to 7 bytes
//
// Example, VIN (20 bytes: 49 02 01 + 17 characters):
//   10 14 49 02 01 31 47 31     FF: length 0x014 = 20, first 6 bytes
//   21 4A 43 35 34 34 34 52     CF #1: 7 more (13 so far)
//   22 37 32 35 32 33 36 37     CF #2: the last 7 (20)
//
// Frames are returned without padding; the bus pads them to 8 bytes, just like a Single Frame.

import type { Bytes } from '../can/frame';
import { encodeSingleFrame, SF_MAX_PAYLOAD } from './single-frame';

/** The length field of a First Frame is 12 bits. Longer messages need the 2016 escape format; we don't. */
export const MAX_MESSAGE_LENGTH = 0xfff; // 4095
/** Payload bytes that fit in a First Frame after its 2 PCI bytes. */
export const FF_PAYLOAD = 6;
/** Payload bytes that fit in a Consecutive Frame after its 1 PCI byte. */
export const CF_PAYLOAD = 7;

export function segment(payload: Bytes): Bytes[] {
    const length = payload.length;
    if (length <= SF_MAX_PAYLOAD) return [encodeSingleFrame(payload)]; // throws on an empty message
    if (length > MAX_MESSAGE_LENGTH) {
        throw new RangeError(`ISO-TP carries at most ${MAX_MESSAGE_LENGTH} bytes, the message is ${length}`);
    }

    const frames: Bytes[] = [[0x10 | (length >> 8), length & 0xff, ...payload.slice(0, FF_PAYLOAD)]];
    let sn = 1; // the first CF is #1: the FF counts as #0
    for (let i = FF_PAYLOAD; i < length; i += CF_PAYLOAD) {
        frames.push([0x20 | sn, ...payload.slice(i, i + CF_PAYLOAD)]);
        sn = (sn + 1) & 0x0f; // after F comes 0
    }
    return frames;
}

/** How many CAN frames a message of this length needs. */
export function frameCount(length: number): number {
    if (length <= SF_MAX_PAYLOAD) return 1;
    return 1 + Math.ceil((length - FF_PAYLOAD) / CF_PAYLOAD);
}
