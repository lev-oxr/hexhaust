// ISO-TP: sending a long message over the bus, the sender's side.
//
//   sender                         receiver
//   FF  10 14 49 02 01 31 47 31  →
//                                ←  FC  30 00 00   "go on"
//   CF  21 …                     →     (after STmin)
//   CF  22 …                     →
//
// If the FC says BS = 2, the sender stops after every 2 CFs and waits for the next FC.
// No FC within N_Bs (1000 ms) → the sender gives up quietly.

import type { CanBus } from '../can/bus';
import type { Bytes, CanFrame } from '../can/frame';
import type { Clock, TimerHandle } from '../clock';
import { decodeFlowControl, FLOW_STATUS, stMinToMs } from './flow-control';
import { segment } from './segment';

/** How long the sender waits for a Flow Control (ISO 15765-2 calls it N_Bs). */
export const N_BS_MS = 1000;

export type SendResult = 'sent' | 'no-flow-control' | 'overflow' | 'cancelled';

export interface SendOptions {
    /** CAN ID we send from, e.g. 7E8 */
    txId: number;
    /** CAN ID the Flow Control arrives on, e.g. 7E0 */
    rxId: number;
    from: CanFrame['from'];
    /** Wait for FC, ms. */
    fcTimeoutMs?: number;
    /**
     * Gap between CFs when STmin = 0, ms. On a real bus a frame takes ~0.25 ms;
     * 1 ms keeps the times in the log distinct.
     */
    minGapMs?: number;
    /** Called once at the end, however it ended. */
    onEnd?: (result: SendResult) => void;
}

/**
 * Sends the message: one Single Frame, or FF → (wait for FC) → CF … .
 * @returns a function that cancels sending (for example, when the ECU is detached)
 */
export function sendIsoTp(bus: CanBus, clock: Clock, payload: Bytes, opts: SendOptions): () => void {
    const frames = segment(payload);
    const fcTimeout = opts.fcTimeoutMs ?? N_BS_MS;
    const minGap = opts.minGapMs ?? 1;

    if (frames.length === 1) {
        bus.send({ id: opts.txId, data: frames[0], from: opts.from });
        opts.onEnd?.('sent');
        return () => { };
    }

    let next = 1; // index of the next CF in frames
    let blockLeft = 0; // CFs left in the current block; Infinity = no limit
    let gapMs = minGap;
    let waitingFc = true;
    let ended = false;
    let timer: TimerHandle | undefined;

    const stopTimer = (): void => {
        if (timer !== undefined) clock.clearTimeout(timer);
        timer = undefined;
    };

    const end = (result: SendResult): void => {
        if (ended) return;
        ended = true;
        stopTimer();
        unsubscribe();
        opts.onEnd?.(result);
    };

    const waitForFc = (): void => {
        waitingFc = true;
        stopTimer();
        timer = clock.setTimeout(() => end('no-flow-control'), fcTimeout);
    };

    const sendNextCf = (): void => {
        timer = undefined;
        if (ended) return;
        bus.send({ id: opts.txId, data: frames[next], from: opts.from });
        next++;
        if (next >= frames.length) return end('sent');

        blockLeft--;
        if (blockLeft === 0) return waitForFc(); // block finished: the receiver decides what's next
        timer = clock.setTimeout(sendNextCf, gapMs);
    };

    // Subscribe BEFORE sending the FF: the FC may come back while the FF is still being delivered.
    const unsubscribe = bus.subscribe((frame) => {
        if (!waitingFc || frame.id !== opts.rxId || frame.from === opts.from) return;
        const fc = decodeFlowControl(frame.data);
        if (!fc) return;

        if (fc.status === FLOW_STATUS.WAIT) return waitForFc(); // "hold on": wait for another FC
        if (fc.status === FLOW_STATUS.OVERFLOW) return end('overflow');

        waitingFc = false;
        stopTimer();
        blockLeft = fc.blockSize === 0 ? Infinity : fc.blockSize;
        gapMs = Math.max(stMinToMs(fc.stMin), minGap);
        timer = clock.setTimeout(sendNextCf, gapMs);
    });

    waitForFc();
    bus.send({ id: opts.txId, data: frames[0], from: opts.from });

    return () => end('cancelled');
}