// Car panel: key, pedals, gauges, MIL, faults. It drives the Car and redraws on every car step.
import type { Car } from '../core/vehicle/car';
import { canRun, FAULTS, type CodeStatus, type FaultDef, type FaultId } from '../core/vehicle/faults';
import type { KeyPosition } from '../core/vehicle/physics';
import { el } from './dom';
import { createGauge } from './gauge';

export interface CarPanel {
    root: HTMLElement;
    destroy(): void;
}

const KEYS: { value: KeyPosition; label: string }[] = [
    { value: 'off', label: 'Off' },
    { value: 'ignition', label: 'Ignition' },
    { value: 'engine', label: 'Engine' },
];

/** Extra ECU delay on top of its normal ~5 ms. The scanner waits 100 ms. */
const ECU_TIMING: { extraMs: number; label: string }[] = [
    { extraMs: 0, label: 'Normal · 5 ms' },
    { extraMs: 75, label: 'Slow · 80 ms' },
    { extraMs: 145, label: 'Too slow · 150 ms' },
];

const STATUS_TEXT: Record<CodeStatus, string> = {
    none: 'no code',
    detecting: 'detecting…',
    pending: 'pending (07)',
    stored: 'stored (03)',
    'stored-pending': 'stored (03) + pending (07)',
};

let uid = 0;

/** A row of radio buttons that looks like a segmented switch. Arrow keys work natively. */
function segmented<T extends string | number>(
    legend: string,
    items: { value: T; label: string }[],
    onPick: (v: T) => void,
): { root: HTMLFieldSetElement; set(v: T): void } {
    const name = `seg-${++uid}`;
    const root = el('fieldset', 'seg');
    root.append(el('legend', 'seg-legend', legend));
    const box = el('div', 'seg-box');
    const inputs = new Map<T, HTMLInputElement>();
    for (const it of items) {
        const label = el('label', 'seg-item');
        const input = el('input');
        input.type = 'radio';
        input.name = name;
        input.value = String(it.value);
        input.addEventListener('change', () => {
            if (input.checked) onPick(it.value);
        });
        label.append(input, el('span', undefined, it.label));
        box.append(label);
        inputs.set(it.value, input);
    }
    root.append(box);
    return {
        root,
        set(v) {
            const input = inputs.get(v);
            if (input && !input.checked) input.checked = true;
        },
    };
}

export function createCarPanel(car: Car): CarPanel {
    const root = el('section', 'panel car-panel');
    root.setAttribute('aria-labelledby', 'car-title');

    // ── Header with the MIL ──
    const head = el('header', 'panel-head');
    const title = el('h2', 'panel-title', 'Car');
    title.id = 'car-title';
    const mil = el('span', 'mil', 'CHECK ENGINE');
    mil.setAttribute('role', 'img');
    const milNote = el('span', 'mil-note');
    head.append(title, el('span', 'spacer'), milNote, mil);

    const body = el('div', 'car-body');

    // ── Key ──
    const key = segmented('Key', KEYS, (k) => car.setKey(k));

    // ── Gauges and readouts ──
    const tacho = createGauge({
        label: 'Engine speed',
        unit: 'rpm',
        max: 7000,
        majorStep: 1000,
        redFrom: 6000,
        tickLabel: (v) => String(v / 1000),
    });
    const speedo = createGauge({ label: 'Vehicle speed', unit: 'km/h', max: 200, majorStep: 40 });
    const gauges = el('div', 'gauges');
    gauges.append(tacho.root, speedo.root);

    const readouts = el('dl', 'readouts');
    const readout = (label: string): HTMLElement => {
        const box = el('div', 'readout');
        const dd = el('dd', 'readout-v', '-');
        box.append(el('dt', 'readout-k', label), dd);
        readouts.append(box);
        return dd;
    };
    const gearOut = readout('Gear');
    const coolantOut = readout('Coolant');
    const ecuOut = readout('ECU');

    // ── Pedals ──
    const pedals = el('div', 'pedals');
    const pedalLabel = el('label', 'pedal');
    const pedalHead = el('span', 'pedal-head');
    const pedalValue = el('span', 'pedal-value', '0 %');
    pedalHead.append(el('span', undefined, 'Accelerator'), pedalValue);
    const pedal = el('input', 'pedal-range');
    pedal.type = 'range';
    pedal.min = '0';
    pedal.max = '100';
    pedal.step = '1';
    pedal.value = '0';
    pedal.addEventListener('input', () => car.setPedal(Number(pedal.value)));
    pedalLabel.append(pedalHead, pedal);

    const brake = el('button', 'btn brake', 'Brake');
    brake.type = 'button';
    brake.title = 'Hold to brake (mouse, touch, Space or Enter)';
    brake.setAttribute('aria-pressed', 'false');
    const setBrake = (on: boolean): void => {
        if (car.inputs.brake !== on) car.setBrake(on);
    };
    brake.addEventListener('pointerdown', (e) => {
        brake.setPointerCapture?.(e.pointerId);
        setBrake(true);
    });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur'] as const)
        brake.addEventListener(ev, () => setBrake(false));
    brake.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            if (!e.repeat) setBrake(true);
        }
    });
    brake.addEventListener('keyup', (e) => {
        if (e.key === ' ' || e.key === 'Enter') setBrake(false);
    });
    pedals.append(pedalLabel, brake);

    // ── Faults ──
    const faults = el('section', 'faults');
    faults.setAttribute('aria-labelledby', 'faults-title');
    const faultsTitle = el('h3', 'sub-title', 'Faults');
    faultsTitle.id = 'faults-title';
    faults.append(faultsTitle);
    const chips = new Map<FaultId, HTMLElement>();
    const boxes = new Map<FaultId, HTMLInputElement>();
    const faultList = el('ul', 'fault-list');
    for (const f of FAULTS) {
        const li = el('li', 'fault');
        const label = el('label', 'fault-label');
        const box = el('input');
        box.type = 'checkbox';
        box.addEventListener('change', () => car.setFault(f.id, box.checked));
        label.append(box, el('span', 'fault-title', f.title), el('code', 'fault-dtc', f.dtc));
        const chip = el('span', 'chip', STATUS_TEXT.none);
        chip.setAttribute('aria-live', 'polite');
        li.append(label, chip, el('p', 'fault-hint', f.hint));
        faultList.append(li);
        chips.set(f.id, chip);
        boxes.set(f.id, box);
    }
    faults.append(
        faultList,
        el(
            'p',
            'car-hint',
            'A two-trip code is first only pending. Turn the key to Ignition and back to Engine (a new drive cycle) with the fault still there, and it is stored with the MIL. Clear codes (04) works only with the engine stopped.',
        ),
    );

    const timing = segmented(
        'Protocol fault: ECU response time (the scanner waits 100 ms)',
        ECU_TIMING.map((t) => ({ value: t.extraMs, label: t.label })),
        (ms) => car.setEcuExtraDelay(ms),
    );
    faults.append(timing.root);

    body.append(key.root, gauges, readouts, pedals, faults);
    root.append(head, body);

    // ── Redraw on every car step ──
    const setText = (node: HTMLElement, text: string): void => {
        if (node.textContent !== text) node.textContent = text;
    };

    /** An enabled fault the monitor cannot see yet: say what it is waiting for instead of "no code" */
    function waitingText(f: FaultDef): string {
        if (!car.running) return 'start the engine';
        return canRun(f, { running: true, coolantC: car.state.coolantC }) ? STATUS_TEXT.none : `waiting for ${f.warmC} °C`;
    }

    function render(): void {
        const s = car.state;
        const inp = car.inputs;
        const powered = car.powered;

        key.set(inp.key);
        timing.set(car.ecuExtraDelayMs);
        tacho.set(powered ? s.rpm : null);
        speedo.set(powered ? s.speedKmh : null);
        // Engine off: parked (P) or coasting in neutral (N); the gear number only means something while running
        setText(gearOut, !powered ? '-' : car.running ? String(s.gear) : s.speedKmh < 1 ? 'P' : 'N');
        setText(coolantOut, powered ? `${Math.round(s.coolantC)} °C` : '-');
        setText(ecuOut, powered ? 'on' : 'off');
        ecuOut.classList.toggle('is-off', !powered);

        if (pedal.value !== String(inp.pedalPct)) pedal.value = String(inp.pedalPct);
        setText(pedalValue, `${Math.round(inp.pedalPct)} %`);
        brake.classList.toggle('is-on', inp.brake);
        brake.setAttribute('aria-pressed', String(inp.brake));

        // The lamp lights for a bulb check with the ignition on, then shows the real MIL once running
        const milLit = powered && (s.milOn || !car.running);
        setText(milNote, powered && !car.running ? 'bulb check at Ignition' : '');
        mil.classList.toggle('is-on', milLit);
        mil.setAttribute('aria-label', milLit ? 'MIL on' : 'MIL off');
        mil.title = !powered
            ? 'MIL (malfunction indicator lamp). The key is off.'
            : !car.running
              ? 'Bulb check: with the ignition on and the engine stopped the lamp always lights. PID 01 01 still reports the real MIL state.'
              : s.milOn
                ? 'The ECU has a confirmed code and keeps the MIL on. PID 01 01: bit 7 of A = 1.'
                : 'No confirmed code: the MIL is off. PID 01 01: bit 7 of A = 0.';

        for (const f of FAULTS) {
            const st = car.faults.status(f.id);
            const chip = chips.get(f.id)!;
            setText(chip, st === 'none' && car.faults.isActive(f.id) ? waitingText(f) : STATUS_TEXT[st]);
            chip.className = `chip chip-${st}`;
            const box = boxes.get(f.id)!;
            if (box.checked !== car.faults.isActive(f.id)) box.checked = car.faults.isActive(f.id);
        }
    }

    const unsubscribe = car.subscribe(render);
    render();

    return {
        root,
        destroy() {
            unsubscribe();
        },
    };
}
