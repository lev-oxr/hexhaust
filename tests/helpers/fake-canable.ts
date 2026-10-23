// A pretend CANable on the other end of a SerialLink, with a simulated car behind it.
// It speaks slcan like the real firmware: CANable 2.5 (CR / BEL after every command, "+…" version,
// error reports with ME) or legacy canable2-fw (silence after commands, repeats the last frame on a bare CR).
// Frames we send go onto a VirtualBus with the stage 3–6 ECU on it; the ECU's frames come back as "t7E8…".
// Replies are delayed with setTimeout, so tests drive it with vi.useFakeTimers().
import { VirtualBus } from '../../src/core/can/bus';
import type { CanFrame } from '../../src/core/can/frame';
import type { Clock } from '../../src/core/clock';
import { attachEcu } from '../../src/core/vehicle/ecu';
import { createStubState } from '../../src/core/vehicle/model';
import type { SerialLink } from '../../src/transport/serial-link';
import { encodeFrame } from '../../src/transport/slcan';

export interface FakeCanableOptions {
    firmware?: 'canable-2.5' | 'legacy';
    /** No car on the bus (ignition off, wires not connected): nobody acknowledges our frames. */
    noCar?: boolean;
    /** Nothing answers at all: a wrong port, or a device that is not slcan. */
    dead?: boolean;
    /** Commands answered with BEL. */
    reject?: string[];
    /** Deliver replies in chunks of this many characters. 0 = whole lines. */
    chunkSize?: number;
}

export class FakeCanable implements SerialLink {
    /** Every command received, in order: "C", "V", "S6", "t7DF8…". */
    readonly received: string[] = [];
    rawWritten = '';
    /** The car behind the adapter: frames on it are what the OBD port sees. */
    readonly car: VirtualBus;
    isOpen = false;
    silent = false;
    bitrate = '';
    errorReports = false;
    oneShot = false;

    private readonly opts: FakeCanableOptions;
    private readonly dataListeners = new Set<(t: string) => void>();
    private readonly closeListeners = new Set<(r?: unknown) => void>();
    private input = '';
    private lastTx = '';
    private unplugged = false;

    constructor(clock: Clock, opts: FakeCanableOptions = {}) {
        this.opts = opts;
        this.car = new VirtualBus(clock);
        if (!opts.noCar) attachEcu(this.car, clock, () => createStubState());
        // Whatever the ECU says reaches us only while the adapter is open.
        this.car.subscribe((f: CanFrame) => {
            if (f.from === 'ecu' && this.isOpen) this.reply(`${encodeFrame(f.id, f.data)}\r`);
        });
    }

    get firmware(): 'canable-2.5' | 'legacy' {
        return this.opts.firmware ?? 'canable-2.5';
    }

    async write(text: string): Promise<void> {
        if (this.unplugged) throw new Error('unplugged');
        this.rawWritten += text;
        for (const ch of text) {
            if (ch !== '\r') {
                this.input += ch;
                continue;
            }
            const cmd = this.input;
            this.input = '';
            this.handle(cmd);
        }
    }

    onData(listener: (text: string) => void): () => void {
        this.dataListeners.add(listener);
        return () => void this.dataListeners.delete(listener);
    }

    onClose(listener: (reason?: unknown) => void): () => void {
        this.closeListeners.add(listener);
        return () => void this.closeListeners.delete(listener);
    }

    async close(): Promise<void> {
        this.unplug();
    }

    /** The cable is pulled. */
    unplug(reason?: unknown): void {
        if (this.unplugged) return;
        this.unplugged = true;
        this.isOpen = false;
        for (const l of [...this.closeListeners]) l(reason);
    }

    /** Another node on the bus sends a frame (a non-OBD ID, say). */
    busFrame(id: number, data: number[]): void {
        if (this.isOpen) this.reply(`${encodeFrame(id, data)}\r`);
    }

    /** Push raw text from the adapter. */
    emit(text: string): void {
        for (const l of [...this.dataListeners]) l(text);
    }

    private handle(cmd: string): void {
        if (this.opts.dead) return;
        this.received.push(cmd);
        const v25 = this.firmware === 'canable-2.5';
        const ok = (): void => {
            if (v25) this.reply('\r');
        };
        const fail = (): void => {
            if (v25) this.reply('\x07');
        };

        if (this.opts.reject?.includes(cmd)) return fail();

        if (cmd === '') {
            // canable2-fw FIXME: "Pressing enter repeats the previous TX". Exactly what we must never trigger.
            if (!v25 && this.lastTx) this.handle(this.lastTx);
            return;
        }
        if (cmd === 'C') {
            // Close never answers (both firmwares). On 2.5 it also resets every mode.
            this.isOpen = false;
            this.silent = false;
            this.errorReports = false;
            this.oneShot = false;
            return;
        }
        if (cmd === 'V') {
            return this.reply(
                v25
                    ? '+Board: Multiboard\tMCU: STM32G431\tDevID: 1128\tSlcan: 105\tClock: 160\tSerial: 206249E3946306550\r'
                    : 'v1.0-abc123 https://github.com/normaldotcom/canable2-fw\r',
            );
        }
        if (cmd === 'O') {
            if (this.isOpen || !this.bitrate) return fail();
            this.isOpen = true;
            return ok();
        }
        if (/^S[0-9]$/.test(cmd) || cmd === 'A0' || cmd === 'A1' || cmd === 'M0' || cmd === 'M1' || cmd === 'ME') {
            if (this.isOpen && cmd !== 'ME') return fail();
            if (cmd === 'ME') {
                if (!v25) return; // legacy: unknown command, silently ignored here
                this.errorReports = true;
            }
            if (cmd[0] === 'S') this.bitrate = cmd;
            if (cmd === 'A0' || cmd === 'A1') this.oneShot = cmd === 'A0';
            if (cmd === 'M0' || cmd === 'M1') this.silent = cmd === 'M1';
            return ok();
        }
        const m = /^t([0-9A-F]{3})([0-8])([0-9A-F]*)$/.exec(cmd);
        if (m) {
            if (!this.isOpen || this.silent || m[3].length !== Number(m[2]) * 2) return fail();
            this.lastTx = cmd;
            const id = parseInt(m[1], 16);
            const data = (m[3].match(/../g) ?? []).map((h) => parseInt(h, 16));
            ok();
            if (this.opts.noCar) {
                // Nobody acknowledged: CANable 2.5 reports "error active, no ACK, Tx failed, 8 Tx errors".
                if (this.errorReports) this.reply('E03020800\r');
                return;
            }
            this.car.send({ id, data, from: 'tester' });
            return;
        }
        fail();
    }

    /** Everything waiting to go to the host, in order. One pump drains it, so lines never interleave. */
    private outbox = '';
    private pumping = false;

    private reply(text: string): void {
        this.outbox += text;
        if (this.pumping) return;
        this.pumping = true;
        const pump = (): void => {
            if (this.unplugged || this.outbox === '') {
                this.pumping = false;
                return;
            }
            // A chunk per millisecond, like USB packets; it may stop in the middle of a line.
            const size = this.opts.chunkSize || this.outbox.length;
            const chunk = this.outbox.slice(0, size);
            this.outbox = this.outbox.slice(size);
            this.emit(chunk);
            setTimeout(pump, 1);
        };
        setTimeout(pump, 1);
    }
}
