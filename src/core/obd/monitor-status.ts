// PID 01 01: "monitor status since DTCs cleared". This is how a scanner sees the MIL ("check engine").
//
//   A  bit 7    MIL on
//      bits 0-6 number of stored trouble codes
//   B  which continuous monitors exist (misfire, fuel system, components) and whether they finished
//   C  which non-continuous monitors this engine has (catalyst, EVAP, O2 sensor, O2 heater…)
//   D  which of them have NOT finished yet (0 = all done)
//
// It is kept out of pids.ts on purpose: it is not a "number with units" like the rest of the table,
// and pids.ts stays a clean table of linear formulas.

import type { Bytes } from '../can/frame';
import type { PidInfo } from './explain';

export const MONITOR_STATUS_PID = 0x01;

/** B: misfire, fuel system and comprehensive component monitors supported and complete; spark ignition. */
const CONTINUOUS = 0x07;
/** C: catalyst, EVAP system, O2 sensor and O2 sensor heater monitors are supported. */
const SUPPORTED = 0x65;
/** D: all of them complete. */
const INCOMPLETE = 0x00;

export function encodeMonitorStatus(milOn: boolean, storedCount: number): Bytes {
    const a = (milOn ? 0x80 : 0) | Math.min(0x7f, Math.max(0, storedCount));
    return [a, CONTINUOUS, SUPPORTED, INCOMPLETE];
}

export function decodeMonitorStatus(data: Bytes): { milOn: boolean; storedCount: number } {
    const a = data[0] ?? 0;
    return { milOn: (a & 0x80) !== 0, storedCount: a & 0x7f };
}

/** Entry for the frame explainer (the bus log), so 41 01 … gets a formula like any other PID. */
export const MONITOR_STATUS_INFO: PidInfo = {
    pid: MONITOR_STATUS_PID,
    name: 'Monitor status: MIL and stored code count',
    unit: 'code(s)',
    length: 4,
    formula: 'A AND 7F; MIL = bit 7 of A',
    decode: (data) => decodeMonitorStatus(data).storedCount,
};