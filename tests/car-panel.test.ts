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

describe('BUG-1: a hidden tab does not make healthy replies LATE', () => {
    const setHidden = (hidden: boolean): void => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
        document.dispatchEvent(new Event('visibilitychange'));
    };
    afterEach(() => setHidden(false));

    it('the clock stands still while hidden and goes on afterwards', () => {
        const clock = createSystemClock();
        vi.advanceTimersByTime(100);
        setHidden(true);
        vi.advanceTimersByTime(5000);
        expect(clock.now()).toBe(100);
        setHidden(false);
        vi.advanceTimersByTime(50);
        expect(clock.now()).toBe(150);
    });

    it('the car does not step on throttled timers while hidden', () => {
        const car = new Car(createSystemClock(), createStubState(), { key: 'engine' });
        car.start();
        vi.advanceTimersByTime(1000);
        const rpm = car.state.rpm;
        setHidden(true);
        vi.advanceTimersByTime(3000);
        expect(car.state.rpm).toBe(rpm);
        car.stop();
    });
});

describe('car panel: QA fixes', () => {
    const mount = (): CarPanel => {
        panel.destroy(); // the one from beforeEach
        panel = createCarPanel(car);
        document.body.replaceChildren(panel.root);
        return panel;
    };
    const gear = (p: CarPanel): string => p.root.querySelectorAll('.readout-v')[0].textContent ?? '';

    it('BUG-6: engine off while rolling shows N, parked shows P', () => {
        const p = mount();
        car.setKey('ignition');
        expect(gear(p)).toBe('P');
        (car as unknown as { current: unknown }).current = { ...car.state, speedKmh: 27, gear: 3 };
        car.setPedal(0); // triggers a redraw
        expect(gear(p)).toBe('N');
        car.setKey('engine');
        expect(gear(p)).toBe('3');
    });

    it('proposal 1: a ticked fault says what the monitor waits for', () => {
        const p = mount();
        car.setFault('lean', true);
        const chip = p.root.querySelectorAll('.chip')[1];
        expect(chip.textContent).toBe('start the engine');
        car.setKey('engine');
        expect(chip.textContent).toBe('waiting for 40 °C');
    });

    it('proposal 5: the bulb check is named', () => {
        const p = mount();
        expect(p.root.querySelector('.mil-note')!.textContent).toBe('');
        car.setKey('ignition');
        expect(p.root.querySelector('.mil-note')!.textContent).toContain('bulb check');
    });
});
