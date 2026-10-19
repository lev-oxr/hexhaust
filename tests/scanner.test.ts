import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualBus } from '../src/core/can/bus';
import type { Bytes, CanFrame } from '../src/core/can/frame';
import { createSystemClock, type Clock } from '../src/core/clock';
import { Scanner } from '../src/core/scanner/scanner';
import { attachEcu, SUPPORTED_PIDS } from '../src/core/vehicle/ecu';
import { createStubState } from '../src/core/vehicle/model';
import { SimTransport } from '../src/transport/sim';
import type { Transport } from '../src/transport/transport';

/** Peek at a Promise: has it settled yet, and with what. */
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
let frames: CanFrame[];
let scanner: Scanner;

beforeEach(() => {
    vi.useFakeTimers(); // fake time first, then the clock
    clock = createSystemClock();
    bus = new VirtualBus(clock);
    frames = [];
    bus.subscribe((f) => frames.push(f));
    scanner = new Scanner(new SimTransport(bus, clock));
});

afterEach(() => {
    vi.useRealTimers();
});

/** Answer "on behalf of the ECU" by hand — to control exactly what arrives and when. */
function injectEcuFrame(data: Bytes): void {
    bus.send({ id: 0x7e8, data, from: 'ecu' });
}

describe('Timeout', () => {
    it('a request with no response returns null after exactly 100 ms', async () => {
        const result = track(scanner.request([0x01, 0x0c])); // no ECU attached

        await vi.advanceTimersByTimeAsync(99);
        expect(result.done).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        expect(result.done).toBe(true);
        expect(result.value).toBeNull();
    });

    it('a response arriving after 200 ms is ignored', async () => {
        attachEcu(bus, clock, createStubState, { responseDelayMs: 200 });

        const result = track(scanner.readPid(0x0c));
        await vi.advanceTimersByTimeAsync(100);
        expect(result.value).toBeNull();

        await vi.advanceTimersByTimeAsync(100); // the response did arrive — it's in the log…
        expect(frames.map((f) => f.from)).toEqual(['tester', 'ecu']);
        expect(result.value).toBeNull(); // …but the result didn't change
    });

    it('a custom timeout for an individual request', async () => {
        const result = track(scanner.request([0x01, 0x0c], { timeoutMs: 500 }));
        await vi.advanceTimersByTimeAsync(499);
        expect(result.done).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(result.value).toBeNull();
    });
});

describe('Response to this exact request', () => {
    it('a late response to a previous request is not confused with the new one', async () => {
        // 1. Ask for RPM — nobody answers, timeout at 100 ms.
        const rpm = track(scanner.request([0x01, 0x0c]));
        // 2. Queue speed right away — it goes onto the bus at 100 ms.
        const speed = track(scanner.request([0x01, 0x0d]));
        await vi.advanceTimersByTimeAsync(110);
        expect(rpm.value).toBeNull();
        expect(speed.done).toBe(false);

        // 3. At 110 ms the RPM finally arrives. That's not an answer to 01 0D!
        injectEcuFrame([0x04, 0x41, 0x0c, 0x1a, 0xf8]);
        await vi.advanceTimersByTimeAsync(0);
        expect(speed.done).toBe(false);

        // 4. At 120 ms — the real speed response.
        await vi.advanceTimersByTimeAsync(10);
        injectEcuFrame([0x03, 0x41, 0x0d, 0x3c]);
        await vi.advanceTimersByTimeAsync(0);
        expect(speed.value).toEqual([0x41, 0x0d, 0x3c]);
    });

    it('the scanner discards a foreign response even if the transport let it through', async () => {
        // This is how an ELM327 behaves: it hands over whatever arrived, unchecked.
        const careless: Transport = {
            request: async () => [0x41, 0x0d, 0x3c],
            close: async () => { },
        };
        const s = new Scanner(careless);
        expect(await s.request([0x01, 0x0c])).toBeNull();
        expect(await s.request([0x01, 0x0d])).toEqual([0x41, 0x0d, 0x3c]);
    });
});

describe('Queue', () => {
    it('the next request goes onto the bus only after the previous one is answered', async () => {
        attachEcu(bus, clock, createStubState, { responseDelayMs: 5 });

        const a = track(scanner.readPid(0x0c));
        const b = track(scanner.readPid(0x0d));
        expect(scanner.pending).toBe(2);
        await vi.advanceTimersByTimeAsync(20);

        expect(frames.map((f) => `${f.from} ${f.data[2].toString(16)} @${f.t}`)).toEqual([
            'tester c @0',
            'ecu c @5',
            'tester d @5',
            'ecu d @10',
        ]);
        expect(a.value?.value).toBe(1726);
        expect(b.value?.value).toBe(60);
        expect(scanner.pending).toBe(0);
    });

    it('a transport error fails only its own request, the queue keeps going', async () => {
        let calls = 0;
        const flaky: Transport = {
            request: async () => {
                calls += 1;
                if (calls === 1) throw new Error('adapter disconnected');
                return [0x41, 0x0d, 0x3c];
            },
            close: async () => { },
        };
        const s = new Scanner(flaky);
        const first = s.request([0x01, 0x0d]);
        const second = s.request([0x01, 0x0d]);
        await expect(first).rejects.toThrow('adapter disconnected');
        await expect(second).resolves.toEqual([0x41, 0x0d, 0x3c]);
    });
});

describe('Full chain: scanner → sim.ts → bus → ECU', () => {
    beforeEach(() => {
        attachEcu(bus, clock, createStubState);
    });

    it('01 0D at 60 km/h → 41 0D 3C', async () => {
        const result = track(scanner.request([0x01, 0x0d]));
        await vi.advanceTimersByTimeAsync(10);
        expect(result.value).toEqual([0x41, 0x0d, 0x3c]);

        // And on the bus — real 8-byte frames with the right IDs
        expect(frames.map((f) => [f.id, f.data])).toEqual([
            [0x7df, [0x02, 0x01, 0x0d, 0x55, 0x55, 0x55, 0x55, 0x55]],
            [0x7e8, [0x03, 0x41, 0x0d, 0x3c, 0x55, 0x55, 0x55, 0x55]],
        ]);
    });

    it('readPid(0x0C) → Engine speed: 1726 rpm', async () => {
        const result = track(scanner.readPid(0x0c));
        await vi.advanceTimersByTimeAsync(10);
        expect(result.value).toMatchObject({ value: 1726, data: [0x1a, 0xf8] });
    });

    it('readSupportedPids() collects all the masks', async () => {
        const result = track(scanner.readSupportedPids());
        await vi.advanceTimersByTimeAsync(100);
        expect(result.value).toEqual([...SUPPORTED_PIDS]);
    });

    it('a physical request with an unknown service → 7F 22 11 from 7E8', async () => {
        const result = track(scanner.request([0x22, 0xf1, 0x90], { physical: true }));
        await vi.advanceTimersByTimeAsync(10);
        expect(result.value).toEqual([0x7f, 0x22, 0x11]);
        expect(frames.map((f) => f.id)).toEqual([0x7e0, 0x7e8]);
    });

    it('a detached ECU no longer responds', async () => {
        const detached = new VirtualBus(clock);
        const detach = attachEcu(detached, clock, createStubState);
        const s = new Scanner(new SimTransport(detached, clock));
        detach();
        const result = track(s.request([0x01, 0x0c]));
        await vi.advanceTimersByTimeAsync(100);
        expect(result.value).toBeNull();
    });
});