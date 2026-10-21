// @vitest-environment jsdom
// Car panel smoke test: the controls drive the Car, the Car's steps redraw the panel.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSystemClock } from '../src/core/clock';
import { Car } from '../src/core/vehicle/car';
import { createStubState } from '../src/core/vehicle/model';
import { createCarPanel, type CarPanel } from '../src/ui/car-panel';

let car: Car;
let panel: CarPanel;
const $ = <T extends Element = HTMLElement>(sel: string): T => panel.root.querySelector<T>(sel)!;
const $$ = <T extends Element = HTMLElement>(sel: string): T[] => [...panel.root.querySelectorAll<T>(sel)];

beforeEach(() => {
  vi.useFakeTimers();
  car = new Car(createSystemClock(), createStubState(), { ambientC: 18 });
  panel = createCarPanel(car);
  document.body.replaceChildren(panel.root);
});

afterEach(() => {
  panel.destroy();
  car.stop();
  vi.useRealTimers();
});

function pickKey(label: string): void {
  const item = $$('.seg-item').find((l) => l.textContent === label)!;
  const input = item.querySelector('input')!;
  input.checked = true;
  input.dispatchEvent(new Event('change'));
}

describe('car panel', () => {
  it('key off: dead gauges, ECU off, MIL dark', () => {
    expect($('.gauge').getAttribute('aria-valuetext')).toBe('off');
    expect($$('.readout-v')[2].textContent).toBe('off');
    expect($('.mil').classList.contains('is-on')).toBe(false);
  });

  it('the key radios turn the key; ignition lights the MIL for a bulb check', () => {
    pickKey('Ignition');
    expect(car.inputs.key).toBe('ignition');
    expect($$('.readout-v')[2].textContent).toBe('on');
    expect($('.mil').classList.contains('is-on')).toBe(true);
  });

  it('engine running with no codes: MIL off; the tachometer follows the steps', async () => {
    pickKey('Engine');
    car.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect($('.mil').classList.contains('is-on')).toBe(false);
    const rpm = Number($('.gauge').getAttribute('aria-valuenow'));
    expect(rpm).toBeGreaterThan(900);
  });

  it('the pedal slider sets the pedal', () => {
    const range = $<HTMLInputElement>('.pedal-range');
    range.value = '40';
    range.dispatchEvent(new Event('input'));
    expect(car.inputs.pedalPct).toBe(40);
    expect($('.pedal-value').textContent).toBe('40 %');
  });

  it('the brake works while held, from the keyboard too', () => {
    const brake = $<HTMLButtonElement>('.brake');
    brake.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    expect(car.inputs.brake).toBe(true);
    expect(brake.getAttribute('aria-pressed')).toBe('true');
    brake.dispatchEvent(new KeyboardEvent('keyup', { key: ' ' }));
    expect(car.inputs.brake).toBe(false);
  });

  it('a fault checkbox breaks the part; its chip follows the code', async () => {
    pickKey('Engine');
    const box = $$<HTMLInputElement>('.fault input')[0]; // misfire
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(car.faults.isActive('misfire')).toBe(true);
    car.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect($('.chip').textContent).toBe('stored (03) + pending (07)');
    expect($('.mil').classList.contains('is-on')).toBe(true);
  });

  it('the protocol fault switch sets the ECU delay', () => {
    const item = $$('.seg-item').find((l) => l.textContent?.startsWith('Too slow'))!;
    const input = item.querySelector('input')!;
    input.checked = true;
    input.dispatchEvent(new Event('change'));
    expect(car.ecuExtraDelayMs).toBe(145);
  });
});
