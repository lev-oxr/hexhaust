// ISO-TP: gathering CAN frames back into one message.
//
// A pure state machine: push() takes the data of the next frame and says what happened.
// It doesn't know about the bus or time. Whoever uses it (sim.ts) decides:
//   'first'  → send Flow Control back and start the "next frame" timer;
//   'progress' → restart the timer;
//   'complete' / 'single' → the message is ready;
//   'error'  → reception is aborted (a frame was lost or came out of order).
//
// One Reassembler = one sender. Two ECUs answering at once need two of them.

import type { Bytes } from '../can/frame';
import { decodeSingleFrame, SF_MAX_PAYLOAD } from './single-frame';
import { CF_PAYLOAD, FF_PAYLOAD } from './segment';

export type RxResult =
    /** A whole message in one frame. */
    | { type: 'single'; payload: Bytes }
    /** A long message has started. head = its first bytes, enough to see what it answers. */
    | { type: 'first'; total: number; head: Bytes }
    /** Another Consecutive Frame fitted in. */
    | { type: 'progress'; received: number; total: number }
    /** The last Consecutive Frame arrived. */
    | { type: 'complete'; payload: Bytes }
    /** Reception aborted; the partial message is dropped. */
    | { type: 'error'; reason: string }
    /** Not ours to handle: a Flow Control, a CF with no FF before it, garbage. Nothing changed. */
    | { type: 'ignored'; reason: string };

export class Reassembler {
    private buffer: Bytes = [];
    private total = 0;
    private nextSn = 0;

    /** true between a First Frame and the last Consecutive Frame. */
    get busy(): boolean {
        return this.total > 0;
    }

    /** Sequence number of the Consecutive Frame it waits for next. */
    get expected(): number {
        return this.nextSn;
    }

    /** Drop whatever was half-received. Called on a timeout. */
    reset(): void {
        this.buffer = [];
        this.total = 0;
        this.nextSn = 0;
    }

    push(data: Bytes): RxResult {
        if (data.length === 0) return { type: 'ignored', reason: 'empty frame' };

        switch (data[0] >> 4) {
            case 0x0: {
                const payload = decodeSingleFrame(data);
                if (!payload) return { type: 'ignored', reason: 'Single Frame with a bad length' };
                // ISO 15765-2: a new SF in the middle of a long message cancels the old one.
                this.reset();
                return { type: 'single', payload };
            }

            case 0x1: {
                const total = ((data[0] & 0x0f) << 8) | (data[1] ?? 0);
                // Likewise, a new FF replaces a half-received message.
                this.reset();
                if (total === 0) {
                    return { type: 'error', reason: 'First Frame with length 0: the 32-bit length format is not supported' };
                }
                if (total <= SF_MAX_PAYLOAD) {
                    return { type: 'error', reason: `First Frame with length ${total}: that fits in a Single Frame` };
                }
                this.total = total;
                this.buffer = data.slice(2, 2 + FF_PAYLOAD);
                this.nextSn = 1;
                return { type: 'first', total, head: [...this.buffer] };
            }

            case 0x2: {
                if (!this.busy) return { type: 'ignored', reason: 'Consecutive Frame without a First Frame' };
                const sn = data[0] & 0x0f;
                if (sn !== this.nextSn) {
                    const expected = this.nextSn;
                    this.reset();
                    return { type: 'error', reason: `wrong sequence number: expected ${expected.toString(16).toUpperCase()}, got ${sn.toString(16).toUpperCase()}` };
                }
                const missing = this.total - this.buffer.length;
                this.buffer.push(...data.slice(1, 1 + Math.min(CF_PAYLOAD, missing)));
                this.nextSn = (this.nextSn + 1) & 0x0f;

                if (this.buffer.length < this.total) {
                    return { type: 'progress', received: this.buffer.length, total: this.total };
                }
                const payload = this.buffer;
                this.reset();
                return { type: 'complete', payload };
            }

            case 0x3:
                return { type: 'ignored', reason: 'Flow Control: meant for the sender' };

            default:
                return { type: 'ignored', reason: `unknown PCI type ${data[0] >> 4}` };
        }
    }
}