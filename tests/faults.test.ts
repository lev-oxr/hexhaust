import { beforeEach, describe, expect, it } from 'vitest';
import { FAULTS, FaultMonitor, MIL_OFF_AFTER_GOOD_CYCLES, type MonitorContext } from '../src/core/vehicle/faults';

const WARM: MonitorContext = { running: true, coolantC: 90 };
const COLD: MonitorContext = { running: true, coolantC: 20 };
const OFF: MonitorContext = { running: false, coolantC: 90 };

let m: FaultMonitor;

/** Run the monitors for `seconds` in 0.1 s steps. */
function run(seconds: number, ctx: MonitorContext = WARM): void {
    for (let i = 0; i < Math.round(seconds * 10); i++) m.tick(0.1, ctx);
}

/** One drive cycle: run, then stop the engine. */
function cycle(seconds = 10, ctx: MonitorContext = WARM): void {
    run(seconds, ctx);
    m.endDriveCycle();
}

beforeEach(() => {
    m = new FaultMonitor();
});

describe('fault table', () => {
    it('has the three codes the stage 5 stub used', () => {
        expect(FAULTS.map((f) => f.dtc).sort()).toEqual(['P0171', 'P0300', 'P0420']);
    });

    it('a healthy car has no codes and no MIL', () => {
        cycle();
        expect(m.storedDtcs).toEqual([]);
        expect(m.pendingDtcs).toEqual([]);
        expect(m.milOn).toBe(false);
    });
});

describe('two-trip code (P0420, catalyst)', () => {
    beforeEach(() => m.setActive('catalyst', true));

    it('is "detecting" until the monitor has seen it long enough, then pending; MIL stays off', () => {
        run(1);
        expect(m.status('catalyst')).toBe('detecting');
        expect(m.pendingDtcs).toEqual([]);
        run(6);
        expect(m.pendingDtcs).toEqual(['P0420']);
        expect(m.storedDtcs).toEqual([]);
        expect(m.milOn).toBe(false);
    });

    it('fails again in the next drive cycle → stored, MIL on', () => {
        cycle(); // trip 1: pending
        expect(m.storedDtcs).toEqual([]);
        run(10); // trip 2
        expect(m.storedDtcs).toEqual(['P0420']);
        expect(m.pendingDtcs).toEqual(['P0420']);
        expect(m.status('catalyst')).toBe('stored-pending');
        expect(m.milOn).toBe(true);
    });

    it('is not tested on a cold engine: the monitor waits for 70 °C', () => {
        run(30, COLD);
        expect(m.pendingDtcs).toEqual([]);
    });

    it('does not count time with the engine stopped', () => {
        run(30, OFF);
        expect(m.pendingDtcs).toEqual([]);
    });

    it('repaired after trip 1: the next good cycle forgets the pending code', () => {
        cycle();
        m.setActive('catalyst', false);
        cycle();
        expect(m.pendingDtcs).toEqual([]);
        expect(m.storedDtcs).toEqual([]);
    });

    it('a good cycle in between resets the count: fail, pass, fail is still only pending', () => {
        cycle();
        m.setActive('catalyst', false);
        cycle();
        m.setActive('catalyst', true);
        run(10);
        expect(m.pendingDtcs).toEqual(['P0420']);
        expect(m.storedDtcs).toEqual([]);
    });
});

describe('one-trip code (P0300, misfire)', () => {
    it('is stored with the MIL at the first failure, even on a cold engine', () => {
        m.setActive('misfire', true);
        run(3, COLD);
        expect(m.storedDtcs).toEqual(['P0300']);
        expect(m.pendingDtcs).toEqual(['P0300']);
        expect(m.milOn).toBe(true);
    });
});

describe('after the repair', () => {
    beforeEach(() => {
        m.setActive('misfire', true);
        cycle();
        m.setActive('misfire', false);
    });

    it(`the MIL goes off after ${MIL_OFF_AFTER_GOOD_CYCLES} good cycles, the stored code stays`, () => {
        for (let i = 0; i < MIL_OFF_AFTER_GOOD_CYCLES - 1; i++) cycle();
        expect(m.milOn).toBe(true);
        cycle();
        expect(m.milOn).toBe(false);
        expect(m.storedDtcs).toEqual(['P0300']);
        expect(m.pendingDtcs).toEqual([]);
        expect(m.status('misfire')).toBe('stored');
    });
});

describe('mode 04: clear()', () => {
    it('forgets stored and pending codes and turns the MIL off', () => {
        m.setActive('misfire', true);
        m.setActive('lean', true);
        cycle();
        m.clear();
        expect(m.storedDtcs).toEqual([]);
        expect(m.pendingDtcs).toEqual([]);
        expect(m.milOn).toBe(false);
    });

    it('a part that is still broken sets the code again', () => {
        m.setActive('misfire', true);
        run(3);
        m.clear();
        expect(m.isActive('misfire')).toBe(true);
        run(3);
        expect(m.storedDtcs).toEqual(['P0300']);
    });
});

describe('effects for the physics', () => {
    it('follow the broken parts, not the codes', () => {
        expect(m.effects).toEqual({ misfire: false, lean: false });
        m.setActive('lean', true);
        expect(m.effects).toEqual({ misfire: false, lean: true });
    });
});
