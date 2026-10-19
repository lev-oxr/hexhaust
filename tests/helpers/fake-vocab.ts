import type { Bytes } from '../../src/core/can/frame';
import type { PidInfo } from '../../src/core/obd/explain';

const A = (d: Bytes): number => d[0] ?? 0;
const B = (d: Bytes): number => d[1] ?? 0;

const TABLE: PidInfo[] = [
  { pid: 0x04, name: 'Engine load', unit: '%', length: 1, decode: (d) => (A(d) * 100) / 255, formula: '100 × A / 255' },
  { pid: 0x05, name: 'Coolant temperature', unit: '°C', length: 1, decode: (d) => A(d) - 40, formula: 'A − 40' },
  { pid: 0x0c, name: 'Engine speed', unit: 'rpm', length: 2, decode: (d) => (256 * A(d) + B(d)) / 4, formula: '(256 × A + B) / 4' },
  { pid: 0x0d, name: 'Vehicle speed', unit: 'km/h', length: 1, decode: (d) => A(d), formula: 'A' },
  { pid: 0x0f, name: 'Intake air temperature', unit: '°C', length: 1, decode: (d) => A(d) - 40, formula: 'A − 40' },
  { pid: 0x11, name: 'Throttle position', unit: '%', length: 1, decode: (d) => (A(d) * 100) / 255, formula: '100 × A / 255' },
  { pid: 0x2f, name: 'Fuel level', unit: '%', length: 1, decode: (d) => (A(d) * 100) / 255, formula: '100 × A / 255' },
];

export const PID_COUNT = TABLE.length;

export const getPid = (pid: number): PidInfo | undefined => TABLE.find((d) => d.pid === pid);

export function decodeSupportedPids(base: number, data: Bytes): number[] {
  const res: number[] = [];
  for (let bit = 0; bit < 32; bit++) {
    if (((data[bit >> 3] ?? 0) & (0x80 >> (bit & 7))) !== 0) res.push(base + bit + 1);
  }
  return res;
}
