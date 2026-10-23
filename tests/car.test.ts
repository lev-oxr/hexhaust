// Stage 6 end to end, without the DOM: pedal → car → ECU → bus → scanner.
// "Done" for stage 6: moving the pedal changes the bytes in the responses to 01 0C and 01 0D.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualBus } from '../src/core/can/bus';
import type { Bytes, CanFrame } from '../src/core/can/frame';
import { createSystemClock, type Clock } from '../src/core/clock';
import { decodeMonitorStatus } from '../src/core/obd/monitor-status';
import { Scanner } from '../src/core/scanner/scanner';
import { Car } from '../src/core/vehicle/car';
import { attachEcu } from '../src/core/vehicle/ecu';
import { createEcuLink, type EcuLink } from '../src/core/vehicle/ecu-link';
import { createStubState } from '../src/core/vehicle/model';
import { SimTransport } from '../src/transport/sim';

function track<T>(promise: Promise<T>) {
    const state: { done: boolean; value?: T } = { done: false };
    void promise.then((value) => {
        state.done = true;
        state.value = value;
    });
    return state;
}

let clock: Clock;
let bus: VirtualBus;
let car: Car;
let link: EcuLink;
let scanner: Scanner;
let frames: CanFrame[];
let extraDelay = 0;

beforeEach(() => {
    vi.useFakeTimers();
    clock = createSystemClock();
    bus = new VirtualBus(clock);
    frames = [];
    bus.subscribe((f) => frames.push(f));
    car = new Car(clock, createStubState(), { ambientC: 18 });
    extraDelay = 0;
    link = createEcuLink(bus, clock, { powered: () => car.powered, extraDelayMs: () => extraDelay });
    attachEcu(link, clock, () => car.state, { onClearDtcs: () => car.clearDtcs() });
    scanner = new Scanner(new SimTransport(bus, clock));
    car.start();
});

afterEach(() => {
    car.stop();
    vi.useRealTimers();
});

/** Ask and let the fake time run until the answer (or the timeout). */
async function ask(payload: Bytes): Promise<Bytes | null> {
    const r = track(scanner.request(payload));
    await vi.advanceTimersByTimeAsync(150);
    expect(r.done).toBe(true);
    return r.value ?? null;
}

async function drive(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
}

describe('the car on a timer', () => {
    it('steps every 100 ms and tells its subscribers', async () => {
        const seen = vi.fn();
        car.subscribe(seen);
        car.setKey('engine');
        seen.mockClear();
        await drive(1000);
        expect(seen).toHaveBeenCalledTimes(10);
        expect(car.state.runTimeS).toBeCloseTo(1);
    });

    it('stop() stops the steps', async () => {
        car.setKey('engine');
        car.stop();
        const t = car.state.runTimeS;
        await drive(1000);
        expect(car.state.runTimeS).toBe(t);
    });
});

describe('key positions on the bus', () => {
    it('key off: the ECU is not on the bus, every request times out, nothing comes back', async () => {
        expect(await ask([0x01, 0x0c])).toBeNull();
        expect(frames.filter((f) => f.from === 'ecu')).toEqual([]);
    });

    it('ignition: the ECU answers, rpm is 0 → 41 0C 00 00', async () => {
        car.setKey('ignition');
        expect(await ask([0x01, 0x0c])).toEqual([0x41, 0x0c, 0x00, 0x00]);
    });

    it('engine running: rpm is at idle', async () => {
        car.setKey('engine');
        await drive(3000);
        const resp = (await ask([0x01, 0x0c]))!;
        const rpm = (resp[2] * 256 + resp[3]) / 4;
        expect(rpm).toBeGreaterThan(900); // cold engine, high idle
        expect(rpm).toBeLessThan(1300);
    });

    it('the key goes off while the ECU is about to answer: the answer is lost', async () => {
        car.setKey('ignition');
        extraDelay = 50;
        const r = track(scanner.request([0x01, 0x0c]));
        await drive(20);
        car.setKey('off');
        await drive(200);
        expect(r.value).toBeNull();
    });
});

describe('done criterion: the pedal moves the bytes of 01 0C and 01 0D', () => {
    it('pressing the pedal raises engine speed and vehicle speed in the responses', async () => {
        car.setKey('engine');
        await drive(3000);
        const idleRpm = await ask([0x01, 0x0c]);
        const idleSpeed = await ask([0x01, 0x0d]);
        expect(idleSpeed).toEqual([0x41, 0x0d, 0x00]);

        car.setPedal(50);
        await drive(8000);
        const rpm = (await ask([0x01, 0x0c]))!;
        const speed = (await ask([0x01, 0x0d]))!;

        expect(rpm).not.toEqual(idleRpm);
        expect(speed[2]).toBeGreaterThan(20); // km/h
        expect((rpm[2] * 256 + rpm[3]) / 4).toBeGreaterThan(1500);
    });
});

describe('faults through the scanner', () => {
    it('misfire: 07 and 03 list P0300, PID 01 01 shows the MIL', async () => {
        car.setKey('engine');
        car.setFault('misfire', true);
        await drive(3000);

        expect(await ask([0x07])).toEqual([0x47, 0x01, 0x03, 0x00]);
        expect(await ask([0x03])).toEqual([0x43, 0x01, 0x03, 0x00]);
        const status = (await ask([0x01, 0x01]))!;
        expect(decodeMonitorStatus(status.slice(2))).toEqual({ milOn: true, storedCount: 1 });
    });

    it('two-trip code: pending first, stored after an engine restart', async () => {
        car.setKey('engine');
        car.setFault('lean', true);
        await drive(60_000); // warm up past 40 °C and let the monitor see it
        expect(car.state.pendingDtcs).toEqual(['P0171']);
        expect(car.state.storedDtcs).toEqual([]);

        car.setKey('ignition'); // end of drive cycle 1
        car.setKey('engine');
        await drive(5000);
        expect(car.state.storedDtcs).toEqual(['P0171']);
        expect(car.state.milOn).toBe(true);
        // and the fuel trim shows why
        const stft = (await ask([0x01, 0x06]))!;
        expect(((stft[2] - 128) * 100) / 128).toBeGreaterThan(10);
    });

    it('mode 04 with the engine running is refused: 7F 04 22, codes stay', async () => {
        car.setKey('engine');
        car.setFault('misfire', true);
        await drive(3000);
        expect(await ask([0x04])).toEqual([0x7f, 0x04, 0x22]);
        expect(car.state.storedDtcs).toEqual(['P0300']);
    });

    it('mode 04 with the engine stopped: 44, codes and MIL gone', async () => {
        car.setKey('engine');
        car.setFault('misfire', true);
        await drive(3000);
        car.setKey('ignition');
        await drive(3000); // let the engine spin down to 0 rpm
        expect(await ask([0x04])).toEqual([0x44]);
        expect(car.state.storedDtcs).toEqual([]);
        expect(car.state.milOn).toBe(false);
        expect(await ask([0x03])).toEqual([0x43, 0x00]);
    });
});

describe('protocol fault: slow ECU', () => {
    beforeEach(() => car.setKey('ignition'));

    it('80 ms: slow, but still in time', async () => {
        extraDelay = 75;
        expect(await ask([0x01, 0x0d])).toEqual([0x41, 0x0d, 0x00]);
    });

    it('150 ms: the scanner times out, the response still shows up on the bus later', async () => {
        extraDelay = 145;
        expect(await ask([0x01, 0x0d])).toBeNull();
        await drive(100);
        const late = frames.filter((f) => f.from === 'ecu');
        expect(late).toHaveLength(1);
        const req = frames.find((f) => f.from === 'tester')!;
        expect(late[0].t - req.t).toBeGreaterThanOrEqual(150);
    });
});
