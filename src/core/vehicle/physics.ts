// Car physics: pedal → engine speed → gear → vehicle speed, plus warm-up.
// A pure function: (state, inputs, dt) → new state. No timers, no randomness,
// so a test can drive the car for "10 seconds" in a loop and get the same numbers every time.
//
// The model is deliberately simple. It only has to move the bytes in a believable way:
// a cold engine idles high, pressing the pedal raises the RPM, the gearbox shifts up,
// the coolant warms to ~90 °C and stays there.

import type { VehicleState } from './model';

export type KeyPosition = 'off' | 'ignition' | 'engine';

export interface CarInputs {
    /** off: everything is dead, the ECU is not on the bus. ignition: ECU on, engine stopped. engine: running. */
    key: KeyPosition;
    /** Accelerator pedal, 0–100 %. */
    pedalPct: number;
    /** Brake pedal pressed. */
    brake: boolean;
}

/** What the active faults do to the physics. faults.ts fills this in. */
export interface FaultEffects {
    /** Misfire: the RPM shakes. */
    misfire: boolean;
    /** Lean mixture (vacuum leak): the ECU adds fuel, the fuel trims go positive. */
    lean: boolean;
}

export const NO_EFFECTS: FaultEffects = { misfire: false, lean: false };

// ─── Numbers that shape the car ─────────────────────────────────────────────

export const WARM_IDLE_RPM = 800;
/** At 0 °C the engine idles at 1300 rpm, warming up brings it down to 800 by 70 °C. */
export const COLD_IDLE_RPM = 1300;
export const WARM_COOLANT_C = 70;
export const THERMOSTAT_C = 90;
export const REDLINE_RPM = 6500;

/** RPM per 1 km/h in each gear. Index 0 is unused: gears are 1–5. */
export const GEAR_RPM_PER_KMH = [0, 120, 70, 48, 36, 29] as const;
/** The strongest acceleration in each gear at full pedal, km/h per second. */
const GEAR_ACCEL = [0, 12, 8, 5.5, 4, 3] as const;
const TOP_GEAR = 5;
const BRAKE_DECEL = 25; // km/h per second
const DOWNSHIFT_RPM = 1100;
/** Below this speed the clutch slips: the engine is not tied to the wheels. */
const CLUTCH_KMH = 5;

/** Idle speed for this coolant temperature. A cold engine idles faster to warm up. */
export function idleTarget(coolantC: number): number {
    if (coolantC >= WARM_COOLANT_C) return WARM_IDLE_RPM;
    const cold = Math.max(0, coolantC) / WARM_COOLANT_C; // 0 at 0 °C … 1 at 70 °C
    return COLD_IDLE_RPM - (COLD_IDLE_RPM - WARM_IDLE_RPM) * cold;
}

/** A parked car with the key out. The engine has the outside temperature. */
export function createParkedState(base: VehicleState, ambientC = 18): VehicleState {
    return {
        ...base,
        rpm: 0,
        speedKmh: 0,
        gear: 1,
        coolantC: ambientC,
        intakeAirC: ambientC,
        ambientC,
        engineLoadPct: 0,
        throttlePct: 0,
        mapKpa: base.baroKpa,
        mafGs: 0,
        timingAdvanceDeg: 0,
        runTimeS: 0,
        moduleVoltageV: 12.6,
        stftPct: 0,
        ltftPct: 0,
    };
}

/** Moves value toward target. tau is the time constant in seconds: after tau it has covered ~63 %. */
function approach(value: number, target: number, dtS: number, tau: number): number {
    return value + (target - value) * (1 - Math.exp(-dtS / tau));
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/**
 * One simulation step.
 * @param dtS step length in seconds (the car ticks every 0.1 s)
 */
export function stepVehicle(
    s: VehicleState,
    inp: CarInputs,
    dtS: number,
    fx: FaultEffects = NO_EFFECTS,
): VehicleState {
    const running = inp.key === 'engine';
    const powered = inp.key !== 'off';
    const pedal = powered ? clamp(inp.pedalPct, 0, 100) / 100 : 0;
    const throttle = running ? pedal : 0;

    // ── Speed ── the engine pushes only while running; drag and the brake always slow the car.
    const drag = s.speedKmh > 0 ? 0.5 + s.speedKmh * s.speedKmh * 0.00025 : 0;
    const push = running ? throttle * GEAR_ACCEL[s.gear] : 0;
    const brake = inp.brake ? BRAKE_DECEL : 0;
    const speedKmh = Math.max(0, s.speedKmh + (push - drag - brake) * dtS);

    // ── Gear ── an automatic box: shift up later when the pedal is pressed harder.
    let gear = s.gear;
    if (speedKmh < CLUTCH_KMH) {
        gear = 1;
    } else if (running) {
        const upshiftRpm = 2000 + 2500 * throttle;
        if (gear < TOP_GEAR && speedKmh * GEAR_RPM_PER_KMH[gear] > upshiftRpm) gear++;
        else if (gear > 1 && speedKmh * GEAR_RPM_PER_KMH[gear] < DOWNSHIFT_RPM) gear--;
    }

    // ── Engine speed ──
    const idle = idleTarget(s.coolantC);
    let rpmTarget = 0;
    if (running) {
        rpmTarget =
            speedKmh < CLUTCH_KMH
                ? idle + throttle * 3500 // standing still: the pedal revs the engine freely
                : Math.max(idle, speedKmh * GEAR_RPM_PER_KMH[gear]); // in gear: the wheels set the RPM
        rpmTarget = Math.min(rpmTarget, REDLINE_RPM);
    }
    let rpm = approach(s.rpm, rpmTarget, dtS, running ? 0.15 : 0.3);
    if (!running && rpm < 20) rpm = 0;
    if (running && fx.misfire) {
        // A missing cylinder makes the crankshaft stumble. A sine of the run time instead of
        // Math.random(): the shake looks random but the tests stay repeatable.
        rpm += Math.sin(s.runTimeS * 23) * 60;
    }
    rpm = Math.max(0, rpm);

    // ── Temperatures ── heat from combustion, the thermostat holds ~90 °C, losses to the air.
    let coolantC = s.coolantC;
    if (running) coolantC += (0.6 + (rpm / 1000) * 0.5 + throttle * 1.5) * dtS;
    if (coolantC > THERMOSTAT_C) coolantC -= (coolantC - THERMOSTAT_C) * Math.min(1, 0.8 * dtS);
    coolantC -= (coolantC - s.ambientC) * 0.002 * dtS;
    const intakeAirC = approach(s.intakeAirC, s.ambientC + (running ? 8 + (coolantC - s.ambientC) * 0.1 : 0), dtS, 20);

    // ── Air and fuel ── intake vacuum at idle, atmospheric pressure with the engine stopped.
    const mapKpa = running ? 28 + throttle * 70 : s.baroKpa;
    const mafGs = running ? (rpm / 1000) * (2.2 + throttle * 14) : 0;
    const engineLoadPct = running ? clamp(18 + throttle * 75 + (push > 0 ? 5 : 0), 0, 100) : 0;
    const throttlePct = powered ? 4 + pedal * 80 : 0; // the throttle sensor works with the ignition on
    const timingAdvanceDeg = running ? clamp(8 + (rpm / 1000) * 4 - throttle * 6, -10, 40) : 0;

    // Fuel trims: with a vacuum leak, unmetered air makes the mixture lean, the ECU adds fuel.
    // Closed loop starts only once the engine is warm enough (~40 °C).
    const closedLoop = running && coolantC >= 40;
    const stftTarget = closedLoop ? (fx.lean ? 18 : Math.sin(s.runTimeS * 3) * 2) : 0;
    const stftPct = approach(s.stftPct, stftTarget, dtS, 0.5);
    const ltftPct = approach(s.ltftPct, closedLoop && fx.lean ? 12 : 0, dtS, 15);

    const fuelLevelPct = Math.max(0, s.fuelLevelPct - mafGs * dtS * 0.0004);

    return {
        ...s,
        rpm,
        speedKmh,
        gear,
        coolantC,
        intakeAirC,
        engineLoadPct,
        throttlePct,
        fuelLevelPct,
        mapKpa,
        mafGs,
        timingAdvanceDeg,
        runTimeS: running ? s.runTimeS + dtS : 0,
        moduleVoltageV: running ? 14.1 : powered ? 12.4 : 12.6,
        stftPct,
        ltftPct,
    };
}