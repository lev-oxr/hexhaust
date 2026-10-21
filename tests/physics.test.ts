import { describe, expect, it } from 'vitest';
import { createStubState, type VehicleState } from '../src/core/vehicle/model';
import {
    createParkedState,
    idleTarget,
    stepVehicle,
    COLD_IDLE_RPM,
    REDLINE_RPM,
    THERMOSTAT_C,
    WARM_IDLE_RPM,
    type CarInputs,
    type FaultEffects,
} from '../src/core/vehicle/physics';

const parked = (ambientC = 18): VehicleState => createParkedState(createStubState(), ambientC);

/** Drive for `seconds` with fixed inputs, in 0.1 s steps, like the real timer. */
function drive(s: VehicleState, inp: Partial<CarInputs>, seconds: number, fx?: FaultEffects): VehicleState {
    const full: CarInputs = { key: 'engine', pedalPct: 0, brake: false, ...inp };
    for (let i = 0; i < Math.round(seconds * 10); i++) s = stepVehicle(s, full, 0.1, fx);
    return s;
}

describe('idle speed', () => {
    it.each([
        [0, COLD_IDLE_RPM],
        [35, (COLD_IDLE_RPM + WARM_IDLE_RPM) / 2],
        [70, WARM_IDLE_RPM],
        [95, WARM_IDLE_RPM],
        [-20, COLD_IDLE_RPM],
    ])('at %i °C the target is %i rpm', (c, rpm) => {
        expect(idleTarget(c)).toBeCloseTo(rpm);
    });

    it('a cold engine idles higher than a warm one', () => {
        const cold = drive(parked(5), {}, 3);
        const warm = drive({ ...parked(5), coolantC: 90 }, {}, 3);
        expect(cold.rpm).toBeGreaterThan(warm.rpm + 300);
        expect(warm.rpm).toBeGreaterThan(750);
        expect(warm.rpm).toBeLessThan(850);
    });
});

describe('key positions', () => {
    it('engine off: no rpm, MAP equals barometric pressure, no airflow', () => {
        const s = drive(parked(), { key: 'ignition', pedalPct: 50 }, 2);
        expect(s.rpm).toBe(0);
        expect(s.mapKpa).toBe(s.baroKpa);
        expect(s.mafGs).toBe(0);
        expect(s.runTimeS).toBe(0);
        expect(s.moduleVoltageV).toBeCloseTo(12.4);
    });

    it('the throttle sensor works with the ignition on, but not with the key out', () => {
        expect(drive(parked(), { key: 'ignition', pedalPct: 100 }, 0.1).throttlePct).toBeGreaterThan(50);
        expect(drive(parked(), { key: 'off', pedalPct: 100 }, 0.1).throttlePct).toBe(0);
    });

    it('starting the engine brings rpm up to idle and the alternator to 14 V', () => {
        const s = drive(parked(), {}, 2);
        expect(s.rpm).toBeCloseTo(idleTarget(s.coolantC), -1);
        expect(s.moduleVoltageV).toBeCloseTo(14.1);
        expect(s.runTimeS).toBeCloseTo(2);
    });

    it('stopping the engine lets rpm fall to zero and resets run time', () => {
        const running = drive(parked(), {}, 3);
        const stopped = drive(running, { key: 'ignition' }, 3);
        expect(stopped.rpm).toBe(0);
        expect(stopped.runTimeS).toBe(0);
    });
});

describe('pedal, gears and speed', () => {
    it('the pedal revs a standing engine', () => {
        const s = drive(parked(), {}, 2);
        // one step is enough to see the change, the car barely moves
        const revved = stepVehicle(s, { key: 'engine', pedalPct: 60, brake: false }, 0.1);
        expect(revved.rpm).toBeGreaterThan(s.rpm + 100);
    });

    it('holding the pedal: the car speeds up and the gearbox shifts up', () => {
        const s = drive(parked(), { pedalPct: 40 }, 20);
        expect(s.speedKmh).toBeGreaterThan(50);
        expect(s.gear).toBeGreaterThanOrEqual(3);
        expect(s.rpm).toBeLessThan(REDLINE_RPM);
    });

    it('lifting off: an automatic shifts up at once, then down as the car coasts slower', () => {
        const fast = drive(parked(), { pedalPct: 60 }, 20);
        const liftedOff = drive(fast, { pedalPct: 0 }, 2);
        expect(liftedOff.gear).toBeGreaterThan(fast.gear);
        const coasted = drive(liftedOff, { pedalPct: 0 }, 60);
        expect(coasted.speedKmh).toBeLessThan(liftedOff.speedKmh / 2);
        expect(coasted.gear).toBeLessThan(liftedOff.gear);
    });

    it('the brake stops the car', () => {
        const fast = drive(parked(), { pedalPct: 50 }, 10);
        expect(fast.speedKmh).toBeGreaterThan(30);
        const stopped = drive(fast, { brake: true }, 5);
        expect(stopped.speedKmh).toBe(0);
        expect(stopped.gear).toBe(1);
    });

    it('a stopped engine does not push the car', () => {
        expect(drive(parked(), { key: 'ignition', pedalPct: 100 }, 5).speedKmh).toBe(0);
    });

    it('rpm never passes the redline', () => {
        const s = drive(parked(), { pedalPct: 100 }, 60);
        expect(s.rpm).toBeLessThanOrEqual(REDLINE_RPM);
    });
});

describe('temperatures', () => {
    it('the engine warms up to the thermostat and stays there', () => {
        const s = drive(parked(18), { pedalPct: 20 }, 300);
        expect(s.coolantC).toBeGreaterThan(THERMOSTAT_C - 3);
        expect(s.coolantC).toBeLessThan(THERMOSTAT_C + 3);
    });

    it('idling from 18 °C reaches 70 °C within two minutes', () => {
        const s = drive(parked(18), {}, 120);
        expect(s.coolantC).toBeGreaterThanOrEqual(70);
    });

    it('a stopped engine cools down', () => {
        const hot = { ...parked(18), coolantC: 90 };
        expect(drive(hot, { key: 'ignition' }, 60).coolantC).toBeLessThan(90);
    });
});

describe('fault effects', () => {
    const warm = (): VehicleState => drive({ ...parked(18), coolantC: 85 }, {}, 3);

    it('misfire: rpm shakes, without it rpm is steady', () => {
        const spread = (fx?: FaultEffects): number => {
            let s = warm();
            const seen: number[] = [];
            for (let i = 0; i < 30; i++) {
                s = stepVehicle(s, { key: 'engine', pedalPct: 0, brake: false }, 0.1, fx);
                seen.push(s.rpm);
            }
            return Math.max(...seen) - Math.min(...seen);
        };
        expect(spread()).toBeLessThan(5);
        expect(spread({ misfire: true, lean: false })).toBeGreaterThan(40);
    });

    it('vacuum leak: short and long term fuel trims go positive once warm', () => {
        const s = drive(warm(), {}, 30, { misfire: false, lean: true });
        expect(s.stftPct).toBeGreaterThan(15);
        expect(s.ltftPct).toBeGreaterThan(5);
    });

    it('vacuum leak on a cold engine: open loop, trims stay at zero', () => {
        const s = drive(parked(5), {}, 5, { misfire: false, lean: true });
        expect(s.stftPct).toBe(0);
    });

    it('the same inputs always give the same numbers', () => {
        const fx: FaultEffects = { misfire: true, lean: true };
        expect(drive(parked(), { pedalPct: 30 }, 10, fx)).toEqual(drive(parked(), { pedalPct: 30 }, 10, fx));
    });
});
