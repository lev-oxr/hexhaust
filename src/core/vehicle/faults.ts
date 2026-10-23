// Faults and the life of a trouble code. No timers or bus here: tick() gets the elapsed time.
//
// How a real ECU does it (SAE J1979 / OBD-II), squeezed in time:
//   1. A monitor runs only when its conditions hold (catalyst: warm engine, fuel trims: closed loop).
//   2. It fails → the code becomes PENDING (mode 07). The MIL is still off.
//   3. "Two-trip" codes: the monitor fails again in the NEXT drive cycle (engine stopped and started)
//      → the code is CONFIRMED (stored, mode 03) and the MIL lights up.
//      "One-trip" codes (a severe misfire can damage the catalyst) are confirmed at once.
//   4. A drive cycle without the failure clears the pending code. Three good cycles in a row turn the
//      MIL off, but the stored code stays until mode 04.
//   5. Mode 04 forgets everything. If the fault is still there, the code comes back.

import type { FaultEffects } from './physics';

export type FaultId = 'misfire' | 'lean' | 'catalyst';

/** What the monitor needs to know about the engine right now. */
export interface MonitorContext {
    running: boolean;
    coolantC: number;
}

export interface FaultDef {
    id: FaultId;
    dtc: string;
    title: string;
    /** One line for the car panel: what is broken and what you will see. */
    hint: string;
    /** 1: confirmed at the first failure, 2: needs a failure in two drive cycles. */
    trips: 1 | 2;
    /** How long the monitor must see the fault before it fails, seconds of engine running. */
    detectS: number;
    /** Monitor enable conditions: engine running and at least this warm, °C. */
    warmC: number;
}

export const canRun = (def: FaultDef, ctx: MonitorContext): boolean => ctx.running && ctx.coolantC >= def.warmC;

export const FAULTS: readonly FaultDef[] = [
    {
        id: 'misfire',
        dtc: 'P0300',
        title: 'Misfire',
        hint: 'The RPM shakes. One-trip: stored with the MIL right away.',
        trips: 1,
        detectS: 2,
        warmC: 0,
    },
    {
        id: 'lean',
        dtc: 'P0171',
        title: 'Vacuum leak (lean)',
        hint: 'Fuel trims 06 and 07 go positive once warm (40 °C). Two-trip.',
        trips: 2,
        detectS: 4,
        warmC: 40,
    },
    {
        id: 'catalyst',
        dtc: 'P0420',
        title: 'Worn catalyst',
        hint: 'No symptom you can feel; tested only on a warm engine (70 °C). Two-trip.',
        trips: 2,
        detectS: 6,
        warmC: 70,
    },
];

/** Good drive cycles in a row that turn the MIL off. */
export const MIL_OFF_AFTER_GOOD_CYCLES = 3;

export type CodeStatus = 'none' | 'detecting' | 'pending' | 'stored' | 'stored-pending';

interface Track {
    active: boolean; // the part is broken (the user ticked it)
    seenS: number; // how long the monitor has seen the fault in this cycle
    failedThisCycle: boolean;
    failedLastCycle: boolean;
    pending: boolean;
    confirmed: boolean;
    goodCycles: number; // drive cycles in a row without a failure, after confirmation
}

const fresh = (active: boolean): Track => ({
    active,
    seenS: 0,
    failedThisCycle: false,
    failedLastCycle: false,
    pending: false,
    confirmed: false,
    goodCycles: 0,
});

export class FaultMonitor {
    private readonly tracks = new Map<FaultId, Track>(FAULTS.map((f) => [f.id, fresh(false)]));

    /** Break or repair a part. Codes don't disappear on repair: that takes good drive cycles or mode 04. */
    setActive(id: FaultId, on: boolean): void {
        this.track(id).active = on;
    }

    isActive(id: FaultId): boolean {
        return this.track(id).active;
    }

    /** Call on every simulation step. */
    tick(dtS: number, ctx: MonitorContext): void {
        for (const def of FAULTS) {
            const t = this.track(def.id);
            if (!t.active || t.failedThisCycle || !canRun(def, ctx)) continue;
            t.seenS += dtS;
            if (t.seenS < def.detectS) continue;

            t.failedThisCycle = true;
            t.pending = true;
            t.goodCycles = 0;
            if (def.trips === 1 || t.failedLastCycle) t.confirmed = true;
        }
    }

    /** The engine was stopped: the drive cycle is over. */
    endDriveCycle(): void {
        for (const t of this.tracks.values()) {
            if (t.failedThisCycle) {
                t.failedLastCycle = true;
            } else {
                t.failedLastCycle = false;
                t.pending = false;
                if (t.confirmed) t.goodCycles++;
            }
            t.failedThisCycle = false;
            t.seenS = 0;
        }
    }

    /** Mode 04: forget all codes. Broken parts stay broken. */
    clear(): void {
        for (const [id, t] of this.tracks) this.tracks.set(id, fresh(t.active));
    }

    /** Codes for mode 03, in table order. */
    get storedDtcs(): string[] {
        return FAULTS.filter((f) => this.track(f.id).confirmed).map((f) => f.dtc);
    }

    /** Codes for mode 07. */
    get pendingDtcs(): string[] {
        return FAULTS.filter((f) => this.track(f.id).pending).map((f) => f.dtc);
    }

    get milOn(): boolean {
        return [...this.tracks.values()].some((t) => t.confirmed && t.goodCycles < MIL_OFF_AFTER_GOOD_CYCLES);
    }

    /** What the physics should feel. */
    get effects(): FaultEffects {
        return { misfire: this.isActive('misfire'), lean: this.isActive('lean') };
    }

    /** For the car panel. */
    status(id: FaultId): CodeStatus {
        const t = this.track(id);
        if (t.confirmed) return t.pending ? 'stored-pending' : 'stored';
        if (t.pending) return 'pending';
        if (t.active && t.seenS > 0) return 'detecting';
        return 'none';
    }

    private track(id: FaultId): Track {
        const t = this.tracks.get(id);
        if (!t) throw new Error(`Unknown fault: ${id}`);
        return t;
    }
}
