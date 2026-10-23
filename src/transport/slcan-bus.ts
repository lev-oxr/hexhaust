// A real CAN bus behind a CANable adapter (slcan over USB serial).
// It implements the same CanBus interface as VirtualBus, so SimTransport, with its ISO-TP and Flow Control,
// talks to a real car without knowing it. The car's frames come in as 'ecu', ours go out as 'tester'.
//
// Safety:
//   - one-shot mode (A0): a frame nobody acknowledges is sent once, not repeated forever onto a bus
//     we may be wired to wrongly;
//   - listen-only mode (M1): the adapter does not even acknowledge frames, it only watches;
//   - never a bare "\r": legacy canable2-fw repeats the previous frame on an empty line.

import type { CanBus, FrameListener } from '../core/can/bus';
import { OBD_ID, PAD_BYTE, type CanFrame } from '../core/can/frame';
import type { Clock } from '../core/clock';
import type { SerialLink } from './serial-link';
import {
    BITRATE_COMMANDS,
    LineSplitter,
    encodeFrame,
    parseLine,
    parseVersion,
    type AdapterInfo,
    type Bitrate,
    type BusStatus,
    type SlcanToken,
} from './slcan';

export type SlcanErrorCode = 'NOT_SLCAN' | 'REJECTED' | 'LISTEN_ONLY' | 'NOT_OPEN' | 'DISCONNECTED' | 'CANCELLED' | 'BLOCKED';

export class SlcanError extends Error {
    readonly code: SlcanErrorCode;
    constructor(code: SlcanErrorCode, message: string) {
        super(message);
        this.name = 'SlcanError';
        this.code = code;
    }
}

export interface SlcanSettings {
    bitrate: Bitrate;
    /** Watch only: no acknowledgements, no frames sent. */
    listenOnly: boolean;
}

export interface TraceLine {
    dir: 'out' | 'in';
    text: string;
    t: number;
    /** A CAN frame line ("t7E88…"). The panel hides these; the raw log keeps them. */
    frame: boolean;
}

export interface SlcanHooks {
    /** Every line both ways, for the "adapter conversation" view and the raw log. */
    onTrace?(line: TraceLine): void;
    /** Bus error report from CANable 2.5. */
    onStatus?(status: BusStatus): void;
    /** The adapter rejected something we sent (BEL) when no command was waiting for an answer. */
    onRejected?(): void;
    /** The link went away on its own (cable pulled). */
    onDisconnect?(reason?: unknown): void;
}

/** How long to wait for the reply to "V" and for CR/BEL after a command. */
const VERSION_TIMEOUT_MS = 1000;
const FEEDBACK_TIMEOUT_MS = 500;

const isTesterId = (id: number): boolean => id === OBD_ID.FUNCTIONAL || (id >= 0x7e0 && id <= 0x7e7);

interface Waiter {
    accept(token: SlcanToken): boolean;
    resolve(token: SlcanToken): void;
}

export class SlcanBus implements CanBus {
    private readonly link: SerialLink;
    private readonly clock: Clock;
    private readonly hooks: SlcanHooks;
    private readonly listeners = new Set<FrameListener>();
    private readonly splitter = new LineSplitter();
    private readonly unsubscribe: (() => void)[] = [];

    private queue: CanFrame[] = [];
    private delivering = false;
    private waiter: Waiter | null = null;
    private chain: Promise<unknown> = Promise.resolve();

    private adapter: AdapterInfo | null = null;
    private settings: SlcanSettings | null = null;
    private open = false;
    private closed = false;

    constructor(link: SerialLink, clock: Clock, hooks: SlcanHooks = {}) {
        this.link = link;
        this.clock = clock;
        this.hooks = hooks;
        this.unsubscribe.push(
            link.onData((chunk) => this.onChunk(chunk)),
            link.onClose((reason) => this.onLinkClosed(reason)),
        );
    }

    get info(): AdapterInfo | null {
        return this.adapter;
    }

    get isOpen(): boolean {
        return this.open;
    }

    get listenOnly(): boolean {
        return this.settings?.listenOnly ?? true;
    }

    /**
     * Find out what firmware is on the other end, then join the bus.
     * Throws SlcanError('NOT_SLCAN') if nothing answers "V" like an slcan adapter.
     */
    start(settings: SlcanSettings): Promise<AdapterInfo> {
        return this.run(async () => {
            // Close first: the adapter may still be open from a previous session. No feedback on purpose.
            await this.write('C');
            const v = await this.ask('V', VERSION_TIMEOUT_MS, (t) => t.kind === 'info' || t.kind === 'other');
            if (this.closed) throw new SlcanError('DISCONNECTED', 'The adapter disconnected.');
            if (!v || (v.kind !== 'info' && v.kind !== 'other')) {
                throw new SlcanError(
                    'NOT_SLCAN',
                    'No answer to "V". Wrong port, or the adapter does not run slcan firmware (the factory gs_usb firmware is not a serial port at all).',
                );
            }
            this.adapter = parseVersion(v.text);
            await this.configure(settings);
            return this.adapter;
        });
    }

    /** Change bitrate or listen-only. The adapter has to be closed and opened again for that. */
    reconfigure(settings: SlcanSettings): Promise<void> {
        return this.run(() => this.configure(settings));
    }

    send(frame: Omit<CanFrame, 't'>): void {
        if (this.closed) throw new SlcanError('DISCONNECTED', 'The adapter is disconnected.');
        if (!this.open || !this.settings) throw new SlcanError('NOT_OPEN', 'The adapter is not on the bus yet.');
        if (this.settings.listenOnly) {
            throw new SlcanError('LISTEN_ONLY', 'Listen only: the adapter does not send anything. Untick "Listen only" to send requests.');
        }
        // ISO 15765-4: OBD frames always carry 8 bytes, unused ones padded.
        const data = [...frame.data];
        while (data.length < 8) data.push(PAD_BYTE);
        const line = encodeFrame(frame.id, data); // throws on a bad ID or more than 8 bytes, before anything is sent

        this.writeLine(line, true);
        // slcan does not echo our own frames, so the log gets them from here, at the moment we send.
        this.deliver({ id: frame.id, data, t: this.clock.now(), from: 'tester' });
    }

    subscribe(listener: FrameListener): () => void {
        this.listeners.add(listener);
        return () => void this.listeners.delete(listener);
    }

    /** Leave the bus ("C") and close the port. */
    async close(): Promise<void> {
        if (this.closed) return;
        this.open = false;
        await this.write('C').catch(() => undefined);
        this.shutdown();
        await this.link.close();
    }

    // ---------- Internals ----------

    private async configure(settings: SlcanSettings): Promise<void> {
        this.open = false;
        await this.write('C'); // also resets every mode on CANable 2.5, so the rest is sent again each time
        const cmds = [
            // Bus error reports: how we learn about "no ACK" (bad wiring, ignition off). CANable 2.5 only.
            ...(this.adapter?.firmware === 'canable-2.5' ? ['ME'] : []),
            BITRATE_COMMANDS[settings.bitrate],
            'A0', // one-shot: no endless retransmission of a frame nobody acknowledges
            settings.listenOnly ? 'M1' : 'M0',
            'O',
        ];
        for (const cmd of cmds) await this.command(cmd);
        this.settings = { ...settings };
        this.open = true;
    }

    /** Send a command; CANable 2.5 answers CR or BEL, legacy firmware answers nothing. */
    private async command(cmd: string): Promise<void> {
        if (this.adapter?.firmware !== 'canable-2.5') {
            await this.write(cmd);
            return;
        }
        const reply = await this.ask(cmd, FEEDBACK_TIMEOUT_MS, (t) => t.kind === 'ok' || t.kind === 'fail');
        if (this.closed) throw new SlcanError('DISCONNECTED', 'The adapter disconnected.');
        if (!reply) throw new SlcanError('REJECTED', `No feedback to "${cmd}" within ${FEEDBACK_TIMEOUT_MS} ms.`);
        if (reply.kind === 'fail') throw new SlcanError('REJECTED', `The adapter rejected "${cmd}".`);
    }

    /** Write a command and wait for the first token that `accept` likes. null on timeout. */
    private ask(cmd: string, timeoutMs: number, accept: (t: SlcanToken) => boolean): Promise<SlcanToken | null> {
        return new Promise<SlcanToken | null>((resolve, reject) => {
            const timer = this.clock.setTimeout(() => {
                if (this.waiter === waiter) this.waiter = null;
                resolve(null);
            }, timeoutMs);
            const waiter: Waiter = {
                accept,
                resolve: (token) => {
                    this.clock.clearTimeout(timer);
                    resolve(token);
                },
            };
            this.waiter = waiter;
            this.write(cmd).catch((err: unknown) => {
                this.clock.clearTimeout(timer);
                if (this.waiter === waiter) this.waiter = null;
                reject(err);
            });
        });
    }

    /** Commands one after another, never interleaved. A failure doesn't block the queue. */
    private run<T>(fn: () => Promise<T>): Promise<T> {
        const next = this.chain.then(() => {
            if (this.closed) throw new SlcanError('DISCONNECTED', 'The adapter is disconnected.');
            return fn();
        });
        this.chain = next.catch(() => undefined);
        return next;
    }

    private write(cmd: string): Promise<void> {
        if (this.closed) return Promise.reject(new SlcanError('DISCONNECTED', 'The adapter is disconnected.'));
        return this.writeLine(cmd, false);
    }

    private writeLine(line: string, frame: boolean): Promise<void> {
        this.hooks.onTrace?.({ dir: 'out', text: line, t: this.clock.now(), frame });
        const p = this.link.write(`${line}\r`);
        p.catch(() => undefined); // a failed write shows up as a disconnect through onClose
        return p;
    }

    private onChunk(chunk: string): void {
        for (const raw of this.splitter.push(chunk)) {
            const token = parseLine(raw);
            const t = this.clock.now();
            if (raw !== '') {
                const text = raw === '\x07' ? 'BEL (error)' : raw;
                this.hooks.onTrace?.({ dir: 'in', text, t, frame: token.kind === 'frame' });
            }

            if (token.kind === 'frame') {
                const f = token.frame;
                if (f.remote) continue;
                this.deliver({ id: f.id, data: f.data, t, from: isTesterId(f.id) ? 'tester' : 'ecu' });
                continue;
            }
            if (token.kind === 'status') {
                this.hooks.onStatus?.(token.status);
                continue;
            }
            const w = this.waiter;
            if (w && w.accept(token)) {
                this.waiter = null;
                w.resolve(token);
                continue;
            }
            // A BEL nobody waited for: CANable 2.5 refused one of our frames (bus off, buffer full).
            if (token.kind === 'fail') this.hooks.onRejected?.();
        }
    }

    /**
     * Same queue as VirtualBus: SimTransport answers a First Frame with a Flow Control from inside
     * its listener, and the log must still see the FF before the FC.
     */
    private deliver(frame: CanFrame): void {
        this.queue.push(frame);
        if (this.delivering) return;
        this.delivering = true;
        try {
            while (this.queue.length > 0) {
                const next = this.queue.shift()!;
                for (const listener of [...this.listeners]) {
                    try {
                        listener(next);
                    } catch (err) {
                        console.error('Error in subscriber:', err);
                    }
                }
            }
        } finally {
            this.delivering = false;
        }
    }

    private onLinkClosed(reason?: unknown): void {
        if (this.closed) return;
        this.shutdown();
        this.hooks.onDisconnect?.(reason);
    }

    private shutdown(): void {
        this.closed = true;
        this.open = false;
        for (const u of this.unsubscribe) u();
        const w = this.waiter;
        this.waiter = null;
        if (w) w.resolve({ kind: 'fail' }); // whoever waited sees `closed` and reports DISCONNECTED
    }
}
