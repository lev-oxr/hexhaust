// Spots late responses in the stream of frames, for the bus log.
// A response is late when it arrives after the scanner stopped waiting for it:
//   timeout    — more than timeoutMs after its request;
//   superseded — the scanner has already sent another request (it timed out and moved on).
// The scanner itself throws such responses away (isResponseTo + timeout); the log shows why.

import { OBD_ID, type Bytes, type CanFrame } from '../can/frame';
import { DEFAULT_TIMEOUT_MS, PENDING_TIMEOUT_MS } from '../../transport/transport';
import type { FrameExplanation } from './explain';
import { isResponsePending, isResponseTo } from './match';

export interface LateInfo {
    /** Time from the request to this response (the first frame of it), ms. */
    afterMs: number;
    reason: 'timeout' | 'superseded';
    /** The scanner's timeout this was judged against. */
    timeoutMs: number;
}

interface SentRequest {
    payload: Bytes;
    t: number;
    /** After "response pending" the scanner waits P2* (5 s) instead of its usual timeout. */
    limitMs?: number;
}

/** How many recent requests to remember when matching a stray response. */
const HISTORY = 16;

const isRequestId = (id: number): boolean => id === OBD_ID.FUNCTIONAL || (id >= 0x7e0 && id <= 0x7e7);
const isResponseId = (id: number): boolean => id >= 0x7e8 && id <= 0x7ef;

/** First bytes of the message carried by a Single Frame or a First Frame. */
function messageHead(data: Bytes): Bytes | null {
    const pci = data[0] >> 4;
    if (pci === 0) return data.slice(1, 1 + (data[0] & 0x0f));
    if (pci === 1) return data.slice(2);
    return null;
}

export interface LatenessTracker {
    /** Feed every frame in bus order. Returns LateInfo for a late response frame, otherwise null. */
    check(frame: Pick<CanFrame, 'id' | 'data' | 't'>): LateInfo | null;
}

export function createLatenessTracker(timeoutMs: number = DEFAULT_TIMEOUT_MS): LatenessTracker {
    const sent: SentRequest[] = [];
    let current: LateInfo | null = null; // verdict for the long message in progress, for its Consecutive Frames

    return {
        check(frame) {
            const pci = frame.data[0] >> 4;

            if (isRequestId(frame.id)) {
                // Flow Control (3x) also goes on the request ID, but it is not a new request.
                if (pci === 0) {
                    const head = messageHead(frame.data);
                    if (head && head.length > 0) {
                        sent.push({ payload: head, t: frame.t });
                        if (sent.length > HISTORY) sent.shift();
                    }
                }
                return null;
            }

            if (!isResponseId(frame.id)) return null;
            if (pci === 2) return current; // a Consecutive Frame shares the fate of its First Frame

            const head = messageHead(frame.data);
            if (!head || head.length === 0) return null;

            // The newest request this frame answers. Search from the end: a repeated PID matches the latest one.
            let k = sent.length - 1;
            while (k >= 0 && !isResponseTo(sent[k].payload, head)) k--;
            if (k < 0) {
                current = null; // nobody asked for it, or it is too old to remember: no verdict
                return null;
            }

            // "Response pending" restarts the clock: the ECU asked for more time, the scanner gave it.
            if (isResponsePending(sent[k].payload, head)) {
                sent[k].t = frame.t;
                sent[k].limitMs = PENDING_TIMEOUT_MS;
                current = null;
                return null;
            }

            const afterMs = frame.t - sent[k].t;
            const limitMs = sent[k].limitMs ?? timeoutMs;
            if (k < sent.length - 1) current = { afterMs, reason: 'superseded', timeoutMs: limitMs };
            else if (afterMs > limitMs) current = { afterMs, reason: 'timeout', timeoutMs: limitMs };
            else current = null;
            return current;
        },
    };
}

/** Adds the late mark to a frame explanation: a prefix in the log line and a note in the inspector. */
export function markLate(ex: FrameExplanation, late: LateInfo): void {
    const ms = Math.round(late.afterMs);
    ex.summary = `LATE ${ms} ms · ${ex.summary}`;
    ex.notes.push(
        late.reason === 'superseded'
            ? `Late response: it came ${ms} ms after its request. The scanner waited ${late.timeoutMs} ms, gave up and already sent the next request, so it ignores this frame.`
            : `Late response: it came ${ms} ms after its request, but the scanner waits only ${late.timeoutMs} ms. The scanner has already reported "no response" and ignores this frame.`,
    );
}
