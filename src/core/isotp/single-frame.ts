// ISO-TP, the simplest part: the Single Frame (SF).
// A message of up to 7 bytes fits in one frame:
//
//   byte 0       bytes 1…7
//   0L           data (L bytes), the rest is filler
//   │└─ length 1–7
//   └── frame type 0 = Single Frame
//
// Example: request 01 0C → frame 02 01 0C 55 55 55 55 55.

import type { Bytes } from '../can/frame';

export const SF_MAX_PAYLOAD = 7;

/** [0x01, 0x0C] → [0x02, 0x01, 0x0C]. The bus pads it to 8. */
export function encodeSingleFrame(payload: Bytes): Bytes {
    if (payload.length < 1 || payload.length > SF_MAX_PAYLOAD) {
        throw new RangeError(
            `Single Frame size is 1–${SF_MAX_PAYLOAD} bytes, the message sixe is ${payload.length}. ` +
                'Larger messages it is ISO-TP with couple of frames.',
        );
    }
    return [payload.length, ...payload];
}

/** Frame data → payload, or null if this isn't a Single Frame. */
export function decodeSingleFrame(data: Bytes): Bytes | null {
    if (data.length === 0) return null;
    const type = data[0] >> 4; // high nibble
    const length = data[0] & 0x0f; // low nibble
    if (type !== 0) return null; // 1 = First Frame, 2 = Consecutive, 3 = Flow Control — stage 5
    if (length < 1 || length > SF_MAX_PAYLOAD) return null;
    if (data.length < 1 + length) return null;
    return data.slice(1, 1 + length);
}
