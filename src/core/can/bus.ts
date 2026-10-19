// Virtual CAN bus. It knows nothing about OBD — it just delivers frames to every subscriber.
// The ECU, the scanner's transport and the log are all ordinary subscribers.

import type { Clock } from '../clock';
import { PAD_BYTE, type Bytes, type CanFrame } from './frame';

export type FrameListener = (frame: CanFrame) => void;

export interface CanBus {
    send(frame: Omit<CanFrame, 't'>): void;
    subscribe(listener: FrameListener): () => void; // returns an unsubscribe function
}

export class VirtualBus implements CanBus {
    private readonly clock: Clock;
    private readonly listeners = new Set<FrameListener>();
    private readonly queue: CanFrame[] = [];
    private delivering = false;

    constructor(clock: Clock) {
        this.clock = clock;
    }

    subscribe(listener: FrameListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    send(frame: Omit<CanFrame, 't'>): void {
        const full: CanFrame = {
            id: checkId(frame.id),
            data: padTo8(frame.data),
            t: this.clock.now(),
            from: frame.from,
        };

        // Why a queue instead of a plain loop over subscribers?
        // A subscriber may call send() right inside its handler (the ECU answering instantly).
        // Without a queue the log would receive the response BEFORE the request. With the queue
        // every subscriber sees frames in the order they were sent.
        this.queue.push(full);
        if (this.delivering) return;

        this.delivering = true;
        try {
            while (this.queue.length > 0) {
                const next = this.queue.shift()!;
                // Copy the list: someone may unsubscribe in the middle of delivery.
                for (const listener of [...this.listeners]) {
                    try {
                        listener(next);
                    } catch (err) {
                        // A broken subscriber (say, the log) must not stop the ECU or the scanner.
                        console.error('Error in subscriber:', err);
                    }
                }
            }
        } finally {
            this.delivering = false;
        }
    }
}

function checkId(id: number): number {
    if (!Number.isInteger(id) || id < 0 || id > 0x7ff) {
        throw new RangeError(`CAN ID should be 11-bit (0–7FF), received ${id}`);
    }
    return id;
}

/** Copies the bytes and pads them to 8 with the filler. More than 8 is an error: it won't fit in classic CAN. */
function padTo8(data: Bytes): Bytes {
    if (data.length > 8) {
        throw new RangeError(`In CAN-frame no more than 8 bytes, received ${data.length}`);
    }
    for (const b of data) {
        if (!Number.isInteger(b) || b < 0 || b > 0xff) {
            throw new RangeError(`Byte should be 0–255, received ${b}`);
        }
    }
    const out = [...data];
    while (out.length < 8) out.push(PAD_BYTE);
    return out;
}