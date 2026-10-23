// Explains frames of a long (ISO-TP) message in context.
// explainFrame() sees one frame at a time, so a Consecutive Frame on its own is just "more bytes".
// The tracker watches the whole stream, the way the receiver does, and adds what one frame can't tell:
// which bytes of the message this frame carries, what they mean, and what the finished message says.
// Pure logic, no DOM: the bus log feeds it every frame.

import { hex, type CanFrame } from '../can/frame';
import { Reassembler } from '../isotp/reassemble';
import { CF_PAYLOAD } from '../isotp/segment';
import { summarizeMessage, type ByteInfo, type FrameExplanation, type Vocab } from './explain';

/** Where a frame stands in a long message: "label, value" rows for the inspector. */
export interface MessageInfo {
    rows: [string, string][];
}

interface Progress {
    total: number;
    /** Message bytes received so far (from the FF and the CFs). */
    bytes: number[];
}

const ASCII_PIDS: Record<number, string> = { 0x02: 'VIN', 0x04: 'calibration ID', 0x0a: 'ECU name' };
const DTC_SIDS: Record<number, string> = { 0x43: 'stored', 0x47: 'pending', 0x4a: 'permanent' };

export class MessageTracker {
    private readonly vocab: Vocab;
    private readonly rx = new Map<number, Reassembler>(); // one receiver per CAN ID
    private readonly progress = new Map<number, Progress>();
    private readonly reported = new Set<number>(); // stalled messages already pointed out

    constructor(vocab: Vocab) {
        this.vocab = vocab;
    }

    reset(): void {
        this.rx.clear();
        this.progress.clear();
        this.reported.clear();
    }

    /**
     * Long messages that started but did not finish while something else happened (a new request, key off).
     * Each one is returned once, with the Consecutive Frame it was still waiting for.
     */
    stalled(): { id: number; next: number }[] {
        const out: { id: number; next: number }[] = [];
        for (const id of this.progress.keys()) {
            if (this.reported.has(id)) continue;
            this.reported.add(id);
            out.push({ id, next: this.rx.get(id)?.expected ?? 1 });
        }
        return out;
    }

    /**
     * Feed a frame and its stand-alone explanation. The explanation is updated in place
     * (byte texts, summary, notes). Returns extra info for frames of a long message.
     */
    annotate(frame: Pick<CanFrame, 'id' | 'data'>, ex: FrameExplanation): MessageInfo | undefined {
        let rx = this.rx.get(frame.id);
        if (!rx) {
            rx = new Reassembler();
            this.rx.set(frame.id, rx);
        }
        const r = rx.push(frame.data);

        switch (r.type) {
            case 'first':
                this.reported.delete(frame.id);
                this.progress.set(frame.id, { total: r.total, bytes: [...r.head] });
                return {
                    rows: [
                        ['length', `${r.total} bytes`],
                        ['this frame', `message bytes 1-${r.head.length}`],
                        ['next', 'the receiver answers with Flow Control, then Consecutive Frames bring the rest'],
                    ],
                };

            case 'progress':
            case 'complete': {
                const p = this.progress.get(frame.id);
                const total = r.type === 'complete' ? r.payload.length : r.total;
                const before = p ? p.bytes.length : total - Math.min(CF_PAYLOAD, total);
                const count = Math.min(CF_PAYLOAD, total - before);
                if (p) {
                    p.bytes.push(...frame.data.slice(1, 1 + count));
                    this.explainChunk(ex, p, before, count);
                }
                markPadding(ex, 1 + count);

                const range = `message bytes ${before + 1}-${before + count}`;
                if (r.type === 'progress') {
                    return {
                        rows: [
                            ['this frame', range],
                            ['received', `${r.received} of ${r.total} bytes`],
                        ],
                    };
                }
                this.progress.delete(frame.id);
                const what = summarizeMessage(r.payload, this.vocab);
                ex.summary = `${ex.summary} · complete: ${what}`;
                return {
                    rows: [
                        ['this frame', range],
                        ['received', `${total} of ${total} bytes, complete`],
                        ['whole message', hex(r.payload)],
                        ['meaning', what],
                    ],
                };
            }

            case 'error':
                this.progress.delete(frame.id);
                ex.summary = `${ex.summary} · broken: ${r.reason}`;
                ex.notes.push(`The long message is broken (${r.reason}). The receiver drops it, and the request ends with no response.`);
                return undefined;

            default:
                return undefined;
        }
    }

    /** Rewrites the texts of frame bytes 1…count: what each one is in the message. */
    private explainChunk(ex: FrameExplanation, p: Progress, before: number, count: number): void {
        const [sid = 0, pid = 0] = p.bytes;
        for (let i = 0; i < count; i++) {
            const offset = before + i; // 0-based position in the message
            const slot = ex.bytes[1 + i];
            if (!slot) continue;
            const where = `Message byte ${offset + 1} of ${p.total}.`;
            const value = p.bytes[offset] ?? 0;

            if (sid === 0x49 && ASCII_PIDS[pid] && offset >= 3) {
                const printable = value >= 0x20 && value < 0x7f;
                const ch = printable ? String.fromCharCode(value) : '·';
                setByte(
                    slot,
                    printable ? ch : '·',
                    `${where} ${ASCII_PIDS[pid]} character ${offset - 2}: ${printable ? `"${ch}"` : '(not printable)'} (ASCII 0x${hex(value)}).`,
                );
            } else if (DTC_SIDS[sid] && offset >= 2) {
                const k = Math.floor((offset - 2) / 2); // which code, 0-based
                const first = (offset - 2) % 2 === 0;
                const a = p.bytes[2 + 2 * k];
                const b = p.bytes[3 + 2 * k];
                const code = a !== undefined && b !== undefined && this.vocab.decodeDtc ? ` ${this.vocab.decodeDtc(a, b)}` : '';
                setByte(
                    slot,
                    'DTC',
                    `${where} Trouble code #${k + 1}${code}: ${first ? 'first' : 'second'} of its two bytes.${first && !code ? ' The second byte comes in the next frame.' : ''}`,
                );
            } else {
                setByte(slot, 'data', `${where} See the whole message on the frame that completes it.`);
            }
        }
    }
}

function setByte(slot: ByteInfo, short: string, text: string): void {
    slot.role = 'data';
    slot.short = short;
    slot.text = text;
}

/** The last CF is usually not full: whatever follows the message is padding. */
function markPadding(ex: FrameExplanation, from: number): void {
    for (let i = from; i < ex.bytes.length; i++) {
        const slot = ex.bytes[i];
        if (!slot) continue;
        slot.role = 'pad';
        slot.short = '-';
        slot.text = `Padding (${hex(slot.value)}): the message ended in the previous byte; the frame is filled up to 8 bytes.`;
    }
}
