// The live car: holds the inputs (key, pedals) and the state, and steps the physics on a timer.
// The ECU only calls getState(), so it always answers with the numbers of the latest step.
// Time comes from Clock, so in tests vi.advanceTimersByTime(10_000) drives for 10 seconds instantly.

import type { Clock, TimerHandle } from '../clock';
import { FaultMonitor, type FaultId } from './faults';
import { type VehicleState } from './model';
import { createParkedState, stepVehicle, type CarInputs, type KeyPosition } from './physics';

export interface CarOptions {
    /** Simulation step, ms. */
    tickMs?: number;
    /** Outside temperature: the engine starts cold at this temperature. */
    ambientC?: number;
    /** Key position at start. 'ignition' lets the scanner find the ECU right after the page loads. */
    key?: KeyPosition;
}

export type CarListener = (car: Car) => void;

export class Car {
    readonly faults = new FaultMonitor();
    private readonly clock: Clock;
    private readonly tickMs: number;
    private readonly listeners = new Set<CarListener>();
    private current: VehicleState;
    private inp: CarInputs = { key: 'off', pedalPct: 0, brake: false };
    private timer: TimerHandle | null = null;
    private ecuDelay = 0;

    /** @param base where the fixed facts come from: VIN, fuel level, barometric pressure */
    constructor(clock: Clock, base: VehicleState, options: CarOptions = {}) {
        this.clock = clock;
        this.tickMs = options.tickMs ?? 100;
        this.inp = { ...this.inp, key: options.key ?? 'off' };
        this.current = this.withCodes(createParkedState(base, options.ambientC ?? base.ambientC));
    }

    /** The state the ECU reports. A fresh object after every step, never changed in place. */
    get state(): VehicleState {
        return this.current;
    }

    get inputs(): Readonly<CarInputs> {
        return this.inp;
    }

    /** The ECU is on the bus only with the ignition on. */
    get powered(): boolean {
        return this.inp.key !== 'off';
    }

    get running(): boolean {
        return this.inp.key === 'engine';
    }

    setKey(key: KeyPosition): void {
        if (key === this.inp.key) return;
        const wasRunning = this.running;
        this.inp = { ...this.inp, key };
        // Stopping the engine ends the drive cycle: pending codes are confirmed or forgotten.
        if (wasRunning && !this.running) this.faults.endDriveCycle();
        this.current = this.withCodes(this.current);
        this.emit();
    }

    setPedal(pct: number): void {
        this.inp = { ...this.inp, pedalPct: Math.min(100, Math.max(0, pct)) };
        this.emit();
    }

    setBrake(on: boolean): void {
        this.inp = { ...this.inp, brake: on };
        this.emit();
    }

    /** Protocol fault "slow ECU": extra delay before every frame the ECU sends, ms. The ECU link reads it. */
    get ecuExtraDelayMs(): number {
        return this.ecuDelay;
    }

    setEcuExtraDelay(ms: number): void {
        this.ecuDelay = Math.max(0, ms);
        this.emit();
    }

    setFault(id: FaultId, on: boolean): void {
        this.faults.setActive(id, on);
        this.emit();
    }

    /** Mode 04. The ECU checks the conditions (engine stopped) before calling this. */
    clearDtcs(): void {
        this.faults.clear();
        this.current = this.withCodes(this.current);
        this.emit();
    }

    /** One simulation step. Public so tests can step without timers. */
    step(dtS = this.tickMs / 1000): void {
        const next = stepVehicle(this.current, this.inp, dtS, this.faults.effects);
        this.faults.tick(dtS, { running: this.running, coolantC: next.coolantC });
        this.current = this.withCodes(next);
        this.emit();
    }

    /** Starts the timer. Safe to call twice. */
    start(): void {
        if (this.timer !== null) return;
        const loop = (): void => {
            this.step();
            this.timer = this.clock.setTimeout(loop, this.tickMs);
        };
        this.timer = this.clock.setTimeout(loop, this.tickMs);
    }

    stop(): void {
        if (this.timer !== null) this.clock.clearTimeout(this.timer);
        this.timer = null;
    }

    /** Called after every change: a step, a key turn, a pedal move. Returns an unsubscribe function. */
    subscribe(listener: CarListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private withCodes(s: VehicleState): VehicleState {
        return {
            ...s,
            storedDtcs: this.faults.storedDtcs,
            pendingDtcs: this.faults.pendingDtcs,
            milOn: this.faults.milOn,
        };
    }

    private emit(): void {
        for (const l of [...this.listeners]) l(this);
    }
}