// The ECU's wire to the bus. It sits between the bus and attachEcu() and adds two things
// that ecu.ts doesn't need to know about:
//   power — with the key off the module is dead: it hears nothing and sends nothing;
//   delay — the protocol fault "slow ECU": every frame from the module leaves later.
//
//   bus ──► link ──► attachEcu(link, …)
//
// The link is itself a CanBus, so attachEcu() and the ISO-TP sender don't change at all.

import type { CanBus, FrameListener } from '../can/bus';
import type { CanFrame } from '../can/frame';
import type { Clock, TimerHandle } from '../clock';

export interface EcuLinkOptions {
    /** Is the module powered right now? */
    powered: () => boolean;
    /** Extra delay for every outgoing frame, ms. 0 = a healthy module. */
    extraDelayMs: () => number;
}

export interface EcuLink extends CanBus {
    /** Drops the frames still waiting to be sent. */
    dispose(): void;
}

export function createEcuLink(bus: CanBus, clock: Clock, opts: EcuLinkOptions): EcuLink {
    const waiting: { frame: Omit<CanFrame, 't'>; due: number }[] = [];
    let timer: TimerHandle | null = null;
    let lastDue = 0;

    // Frames leave in the order they were sent, even if the delay changes in between:
    // a later frame is never due before an earlier one.
    const flush = (): void => {
        timer = null;
        const now = clock.now();
        while (waiting.length > 0 && waiting[0].due <= now) {
            const { frame } = waiting.shift()!;
            if (opts.powered()) bus.send(frame); // the key went off while the frame waited: it's lost
        }
        schedule();
    };

    const schedule = (): void => {
        if (timer !== null || waiting.length === 0) return;
        timer = clock.setTimeout(flush, Math.max(0, waiting[0].due - clock.now()));
    };

    return {
        subscribe(listener: FrameListener) {
            return bus.subscribe((frame) => {
                if (opts.powered()) listener(frame);
            });
        },

        send(frame) {
            if (!opts.powered()) return;
            const delay = Math.max(0, opts.extraDelayMs());
            if (delay === 0 && waiting.length === 0) {
                bus.send(frame);
                return;
            }
            const due = Math.max(clock.now() + delay, lastDue);
            lastDue = due;
            waiting.push({ frame, due });
            schedule();
        },

        dispose() {
            waiting.length = 0;
            if (timer !== null) clock.clearTimeout(timer);
            timer = null;
        },
    };
}