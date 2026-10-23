import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualBus } from '../src/core/can/bus';
import type { CanFrame } from '../src/core/can/frame';
import { createSystemClock, type Clock } from '../src/core/clock';
import { Scanner } from '../src/core/scanner/scanner';
import { attachEcu } from '../src/core/vehicle/ecu';
import { createStubState } from '../src/core/vehicle/model';
import { SimTransport } from '../src/transport/sim';
import { SourceSwitch, isObdId, isReadOnlyRequest, type SourceState } from '../src/transport/source';
import { FakeCanable } from './helpers/fake-canable';

let clock: Clock;
let simBus: VirtualBus;
let source: SourceSwitch;
let scanner: Scanner;
let logged: CanFrame[];
let states: SourceState['kind'][];

beforeEach(() => {
    vi.useFakeTimers();
    clock = createSystemClock();
    simBus = new VirtualBus(clock);
    // The simulated car answers 1000 rpm, the "real" one behind the fake adapter the stub's 1726.
    attachEcu(simBus, clock, () => ({ ...createStubState(), rpm: 1000 }));
    source = new SourceSwitch({ clock, simBus, simTransport: new SimTransport(simBus, clock) });
    scanner = new Scanner(source.transport);
    logged = [];
    source.frames.subscribe((f) => logged.push(f));
    states = [];
    source.onChange((s) => states.push(s.kind));
});

afterEach(() => {
    vi.useRealTimers();
});

async function settle<T>(p: Promise<T>, ms = 5000): Promise<T> {
    await vi.advanceTimersByTimeAsync(ms);
    return p;
}

const connect = (fake: FakeCanable, listenOnly = false) => settle(source.connect(fake, { bitrate: 500, listenOnly }));

describe('SourceSwitch', () => {
    it('starts on the simulator', async () => {
        expect(source.state.kind).toBe('sim');
        expect((await settle(scanner.readPid(0x0c)))?.value).toBe(1000);
        expect(logged.map((f) => f.from)).toEqual(['tester', 'ecu']);
    });

    it('after connecting, the same scanner reads the car behind the adapter', async () => {
        const fake = new FakeCanable(clock);
        const info = await connect(fake);
        expect(info.firmware).toBe('canable-2.5');
        expect(states).toEqual(['connecting', 'can']);
        expect(source.state).toMatchObject({ kind: 'can', bitrate: 500, listenOnly: false });

        logged.length = 0;
        expect((await settle(scanner.readPid(0x0c)))?.value).toBe(1726);
        expect(logged.map((f) => [f.from, f.id])).toEqual([
            ['tester', 0x7df],
            ['ecu', 0x7e8],
        ]);
    });

    it('VIN and codes over ISO-TP through the adapter', async () => {
        await connect(new FakeCanable(clock));
        expect(await settle(scanner.readVin())).toBe('1G1JC5444R7252367');
        expect(await settle(scanner.readDtcs())).toEqual(['P0300', 'P0420', 'P0171']);
    });

    it('simulator frames stay out of the log while the car is the source', async () => {
        await connect(new FakeCanable(clock));
        logged.length = 0;
        simBus.send({ id: 0x7df, data: [0x02, 0x01, 0x0d], from: 'tester' });
        await vi.advanceTimersByTimeAsync(50);
        expect(logged).toEqual([]);
    });

    it('non-OBD frames are hidden and counted; untick "OBD only" to see them', async () => {
        const fake = new FakeCanable(clock);
        await connect(fake);
        logged.length = 0;
        fake.busFrame(0x3c0, [0x00, 0x01]);
        fake.busFrame(0x7e8, [0x03, 0x41, 0x0d, 0x00]);
        await vi.advanceTimersByTimeAsync(20);
        expect(logged.map((f) => f.id)).toEqual([0x7e8]);
        expect(source.hidden).toBe(1);

        source.obdOnly = false;
        fake.busFrame(0x3c0, [0x00, 0x02]);
        await vi.advanceTimersByTimeAsync(20);
        expect(logged.map((f) => f.id)).toEqual([0x7e8, 0x3c0]);
    });

    it('listen only: requests are refused, the adapter is silent; switching it off reopens in normal mode', async () => {
        const fake = new FakeCanable(clock);
        await connect(fake, true);
        expect(fake.silent).toBe(true);
        await expect(source.transport.request([0x01, 0x0c])).rejects.toMatchObject({ code: 'LISTEN_ONLY' });

        await settle(source.setListenOnly(false));
        expect(fake.silent).toBe(false);
        expect(source.state).toMatchObject({ kind: 'can', listenOnly: false });
        expect(fake.received.slice(-6)).toEqual(['C', 'ME', 'S6', 'A0', 'M0', 'O']);
        expect((await settle(scanner.readPid(0x0c)))?.value).toBe(1726);
    });

    it('state-changing services are blocked on a real car until allowed', async () => {
        const fake = new FakeCanable(clock);
        await connect(fake);
        await expect(source.transport.request([0x04])).rejects.toMatchObject({ code: 'BLOCKED' });
        expect(fake.received.some((c) => c.startsWith('t7DF801045'))).toBe(false);

        source.allowStateChanges = true;
        const resp = await settle(source.transport.request([0x04]));
        expect(resp?.[0] === 0x44 || resp?.[0] === 0x7f).toBe(true); // the stub engine runs: 7F 04 22
    });

    it('the simulator never blocks', async () => {
        const p = source.transport.request([0x04]).then(
            () => 'sent',
            () => 'blocked',
        );
        await vi.advanceTimersByTimeAsync(200);
        expect(await p).toBe('sent');
    });

    it('no car: the request times out and the bus status says "no ACK"', async () => {
        await connect(new FakeCanable(clock, { noCar: true }));
        expect(await settle(scanner.readPid(0x0c))).toBeNull();
        expect(source.busStatus?.lastError).toBe('no ACK received');
    });

    it('cable pulled: back on the simulator with a note; permissions reset', async () => {
        const fake = new FakeCanable(clock);
        await connect(fake);
        source.allowStateChanges = true;
        fake.unplug();
        await vi.advanceTimersByTimeAsync(0);
        expect(source.state).toMatchObject({ kind: 'sim', note: expect.stringMatching(/disconnected/) });
        expect(source.allowStateChanges).toBe(false);
        expect((await settle(scanner.readPid(0x0c)))?.value).toBe(1000);
    });

    it('a failed connect leaves the simulator in place and says why', async () => {
        const p = source.connect(new FakeCanable(clock, { dead: true }), { bitrate: 500, listenOnly: false });
        const check = expect(p).rejects.toMatchObject({ code: 'NOT_SLCAN' });
        await vi.advanceTimersByTimeAsync(3000);
        await check;
        expect(source.state).toMatchObject({ kind: 'sim', note: expect.stringMatching(/slcan/) });
        expect(states).toEqual(['connecting', 'sim']);
    });

    it('"Back to simulator" during connecting cancels cleanly', async () => {
        const fake = new FakeCanable(clock);
        const p = source.connect(fake, { bitrate: 500, listenOnly: false });
        const check = expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
        await source.useSimulator();
        await vi.advanceTimersByTimeAsync(3000);
        await check;
        expect(source.state.kind).toBe('sim');
    });

    it('the raw log keeps the whole conversation, frames included', async () => {
        await connect(new FakeCanable(clock));
        await settle(scanner.readPid(0x0c));
        const raw = source.rawLog();
        expect(raw).toMatch(/> C\n/);
        expect(raw).toMatch(/< \+Board: Multiboard/);
        expect(raw).toMatch(/> t7DF802010C5555555555\n/);
        expect(raw).toMatch(/< t7E8804410C1AF8555555\n/);
    });

    it('back to the simulator closes the port', async () => {
        const fake = new FakeCanable(clock);
        await connect(fake);
        const closeSpy = vi.spyOn(fake, 'close');
        await source.useSimulator();
        expect(closeSpy).toHaveBeenCalled();
        expect(fake.received.at(-1)).toBe('C');
    });
});

describe('helpers', () => {
    it.each([[[0x01, 0x0c]], [[0x03]], [[0x07]], [[0x09, 0x02]], [[0x22, 0xf4, 0x00]], [[0x19, 0x02, 0xff]]])('%j is read-only', (req) => {
        expect(isReadOnlyRequest(req)).toBe(true);
    });

    it.each([[[0x04]], [[0x08, 0x01]], [[0x10, 0x03]], [[0x11, 0x01]], [[0x2e, 0xf1, 0x90]], [[0x31, 0x01]], [[]]])('%j is not', (req) => {
        expect(isReadOnlyRequest(req)).toBe(false);
    });

    it('OBD IDs', () => {
        expect([0x7df, 0x7e0, 0x7e7, 0x7e8, 0x7ef].every(isObdId)).toBe(true);
        expect([0x7de, 0x7f0, 0x3c0, 0x18daf110].some(isObdId)).toBe(false);
    });
});
