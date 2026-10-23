// Where the frames come from: the simulator or a real car through a CANable adapter.
// The scanner gets ONE Transport and the log gets ONE frame feed; this file decides what's behind them.
// Both sides use the same SimTransport (ISO-TP, Flow Control), once over VirtualBus, once over SlcanBus.

import type { CanFrame } from '../core/can/frame';
import type { Clock } from '../core/clock';
import type { SerialLink } from './serial-link';
import type { AdapterInfo, Bitrate, BusStatus } from './slcan';
import { SlcanBus, SlcanError, type SlcanHooks, type SlcanSettings, type TraceLine } from './slcan-bus';
import { SimTransport } from './sim';
import type { RequestOptions, Transport } from './transport';

export type FrameListener = (frame: CanFrame) => void;

/** What mountApp() calls `bus`: something you can subscribe to for frames. */
export interface FrameFeed {
    subscribe(listener: FrameListener): () => void;
}

export type SourceState =
    { kind: 'sim'; note?: string } | { kind: 'connecting' } | { kind: 'can'; info: AdapterInfo; bitrate: Bitrate; listenOnly: boolean };

/**
 * Services that only read. Everything else can change something in a real car:
 * 04 clears codes (and resets readiness monitors), 08 runs tests, 10/11/27/2E/31… are UDS sessions,
 * resets, security access, writes and routines. Those need an explicit "allow".
 */
export const READ_ONLY_SERVICES = new Set([0x01, 0x02, 0x03, 0x05, 0x06, 0x07, 0x09, 0x0a, 0x19, 0x22, 0x3e]);

export function isReadOnlyRequest(payload: readonly number[]): boolean {
    return payload.length > 0 && READ_ONLY_SERVICES.has(payload[0]);
}

/** IDs of OBD over CAN (ISO 15765-4, 11-bit): requests 7DF, 7E0–7E7 and responses 7E8–7EF. */
export function isObdId(id: number): boolean {
    return id === 0x7df || (id >= 0x7e0 && id <= 0x7ef);
}

/** Every line of the adapter conversation is kept for "Download raw log", up to this many. */
export const RAW_LOG_LINES = 20000;

export interface SourceSwitchDeps {
    clock: Clock;
    /** The virtual bus with the simulated ECU on it. */
    simBus: FrameFeed;
    /** SimTransport over that bus. */
    simTransport: Transport;
}

export class SourceSwitch {
    /** Give this to the Scanner. */
    readonly transport: Transport;
    /** Give this to mountApp() as `bus`. */
    readonly frames: FrameFeed;
    /** Real car only: allow services outside READ_ONLY_SERVICES. Off by default, off again after every disconnect. */
    allowStateChanges = false;
    /** Real car only: keep non-OBD frames out of the log. A car without a gateway sends thousands per second. */
    obdOnly = true;

    private readonly deps: SourceSwitchDeps;
    private st: SourceState = { kind: 'sim' };
    private real: { bus: SlcanBus; transport: SimTransport } | null = null;
    private hiddenFrames = 0;
    private lastStatus: BusStatus | null = null;
    private raw: string[] = [];
    private readonly frameListeners = new Set<FrameListener>();
    private readonly stateListeners = new Set<(s: SourceState) => void>();
    private readonly traceListeners = new Set<(l: TraceLine) => void>();
    private readonly statusListeners = new Set<(s: BusStatus) => void>();

    constructor(deps: SourceSwitchDeps) {
        this.deps = deps;

        // Simulator frames reach the log only while the simulator is the source.
        deps.simBus.subscribe((f) => {
            if (!this.real) this.push(f);
        });

        this.frames = {
            subscribe: (listener) => {
                this.frameListeners.add(listener);
                return () => void this.frameListeners.delete(listener);
            },
        };

        this.transport = {
            request: (payload, opts?: RequestOptions) => {
                const real = this.real;
                if (!real) return deps.simTransport.request(payload, opts);
                if (this.st.kind === 'can' && this.st.listenOnly) {
                    return Promise.reject(
                        new SlcanError('LISTEN_ONLY', 'Listen only: nothing is sent. Untick "Listen only" to ask the car.'),
                    );
                }
                if (!this.allowStateChanges && !isReadOnlyRequest(payload)) {
                    const svc = (payload[0] ?? 0).toString(16).toUpperCase().padStart(2, '0');
                    return Promise.reject(
                        new SlcanError(
                            'BLOCKED',
                            `Service ${svc} can change the car's state. Tick "Allow state-changing services" to send it.`,
                        ),
                    );
                }
                return real.transport.request(payload, opts);
            },
            close: async () => {
                await this.useSimulator();
            },
        };
    }

    get state(): SourceState {
        return this.st;
    }

    /** Non-OBD frames kept out of the log since the adapter was connected. */
    get hidden(): number {
        return this.hiddenFrames;
    }

    /** The last bus error report (CANable 2.5 only), or null. */
    get busStatus(): BusStatus | null {
        return this.lastStatus;
    }

    onChange(listener: (s: SourceState) => void): () => void {
        this.stateListeners.add(listener);
        return () => void this.stateListeners.delete(listener);
    }

    /** The adapter conversation, frames included. */
    onTrace(listener: (l: TraceLine) => void): () => void {
        this.traceListeners.add(listener);
        return () => void this.traceListeners.delete(listener);
    }

    onBusStatus(listener: (s: BusStatus) => void): () => void {
        this.statusListeners.add(listener);
        return () => void this.statusListeners.delete(listener);
    }

    /** The whole adapter conversation as text: a fixture for tests, or something to show on a forum. */
    rawLog(): string {
        return this.raw.join('\n') + (this.raw.length > 0 ? '\n' : '');
    }

    /** Switch to a real car. Until the adapter is on the bus the simulator keeps answering. */
    async connect(link: SerialLink, settings: SlcanSettings): Promise<AdapterInfo> {
        if (this.real) await this.useSimulator();
        this.hiddenFrames = 0;
        this.lastStatus = null;
        this.raw = [];

        const hooks: SlcanHooks = {
            onTrace: (l) => {
                this.raw.push(`${l.t.toFixed(1).padStart(10)} ${l.dir === 'out' ? '>' : '<'} ${l.text}`);
                if (this.raw.length > RAW_LOG_LINES) this.raw.splice(0, this.raw.length - RAW_LOG_LINES);
                for (const fn of [...this.traceListeners]) fn(l);
            },
            onStatus: (s) => {
                this.lastStatus = s;
                for (const fn of [...this.statusListeners]) fn(s);
            },
            onDisconnect: () => {
                if (this.real?.bus === bus) void this.useSimulator('The adapter disconnected. Back on the simulator.');
            },
        };
        const bus = new SlcanBus(link, this.deps.clock, hooks);
        bus.subscribe((f) => {
            if (this.real?.bus !== bus) return;
            if (this.obdOnly && !isObdId(f.id)) {
                this.hiddenFrames++;
                return;
            }
            this.push(f);
        });

        this.setState({ kind: 'connecting' });
        try {
            const info = await bus.start(settings);
            if (this.st.kind !== 'connecting') throw new SlcanError('CANCELLED', 'Connection was cancelled.');
            this.real = { bus, transport: new SimTransport(bus, this.deps.clock) };
            this.setState({ kind: 'can', info, bitrate: settings.bitrate, listenOnly: settings.listenOnly });
            return info;
        } catch (err) {
            await bus.close().catch(() => undefined);
            if (this.st.kind === 'connecting') {
                const unplugged = err instanceof SlcanError && err.code === 'DISCONNECTED';
                this.setState({
                    kind: 'sim',
                    note: unplugged ? 'The adapter disconnected. Back on the simulator.' : err instanceof Error ? err.message : String(err),
                });
            }
            throw err;
        }
    }

    /** Listen only on or off, without reconnecting the port. */
    async setListenOnly(listenOnly: boolean): Promise<void> {
        const real = this.real;
        if (!real || this.st.kind !== 'can') return;
        const { info, bitrate } = this.st;
        await real.bus.reconfigure({ bitrate, listenOnly });
        if (this.real === real) this.setState({ kind: 'can', info, bitrate, listenOnly });
    }

    /** Back to the simulator. Closes the port so other apps (or a reconnect) can open it. */
    async useSimulator(note?: string): Promise<void> {
        const real = this.real;
        this.real = null;
        this.allowStateChanges = false;
        this.setState({ kind: 'sim', note });
        if (real) {
            await real.transport.close();
            await real.bus.close().catch(() => undefined);
        }
    }

    private push(frame: CanFrame): void {
        for (const fn of [...this.frameListeners]) {
            try {
                fn(frame);
            } catch (err) {
                console.error('Error in frame listener:', err);
            }
        }
    }

    private setState(s: SourceState): void {
        this.st = s;
        for (const fn of [...this.stateListeners]) fn(s);
    }
}
