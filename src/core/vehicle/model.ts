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
    vin: string; // 17 characters, mode 09 PID 02
    storedDtcs: string[]; // confirmed trouble codes, mode 03
    pendingDtcs: string[]; // pending trouble codes, mode 07
    gear: number; // 1–5, for the dashboard
    stftPct: number; // short term fuel trim, % (PID 06)
    ltftPct: number; // long term fuel trim, % (PID 07)
    milOn: boolean; // malfunction indicator lamp ("check engine"), bit 7 of PID 01 byte A
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
        vin: '1G1JC5444R7252367', // a textbook example VIN with a valid check digit
        // Three codes = 2 + 3 × 2 = 8 bytes in the response: one more than a Single Frame holds.
        storedDtcs: ['P0300', 'P0420', 'P0171'],
        pendingDtcs: [],
        gear: 5,
        stftPct: 0,
        ltftPct: 0,
        milOn: true, // three stored codes → the lamp is on
    };
}