// The ECU only reads the VehicleState interface, so ecu.ts won't need changes once the model comes alive.

export interface VehicleState {
    rpm: number; // rev/min
    speedKmh: number; // km/h
    coolantC: number; // °C
    intakeAirC: number; // °C
    ambientC: number; // °C
    engineLoadPct: number; // %
    throttlePct: number; // %
    fuelLevelPct: number; // %
    mapKpa: number; // intake manifold pressure, kPa
    baroKpa: number; // barometric pressure, kPa
    mafGs: number; // mass air flow, g/s
    timingAdvanceDeg: number; // ignition timing advance, °
    runTimeS: number; // s since engine start
    moduleVoltageV: number; // control module supply voltage, V
}

/** Engine partly warmed up, car doing 60 km/h. The numbers match the examples in the plan. */
export function createStubState(): VehicleState {
    return {
        rpm: 1726, // → 1A F8
        speedKmh: 60, // → 3C
        coolantC: 35, // → 4B
        intakeAirC: 25,
        ambientC: 18,
        engineLoadPct: 32,
        throttlePct: 18,
        fuelLevelPct: 64,
        mapKpa: 45,
        baroKpa: 101,
        mafGs: 8.5,
        timingAdvanceDeg: 12,
        runTimeS: 420,
        moduleVoltageV: 14.1,
    };
}