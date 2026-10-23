// ISO-TP on the bus: ECU → FF, tester → FC, ECU → CFs. Fake time, no DOM.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualBus } from '../src/core/can/bus';
import { hex, type Bytes, type CanFrame } from '../src/core/can/frame';
import { createSystemClock, type Clock } from '../src/core/clock';
import { FLOW_STATUS } from '../src/core/isotp/flow-control';
import { segment } from '../src/core/isotp/segment';
import { sendIsoTp, type SendResult } from '../src/core/isotp/sender';
import { Scanner } from '../src/core/scanner/scanner';
import { attachEcu } from '../src/core/vehicle/ecu';
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

/** One log line per frame: '7E8 10 14 49 02 01 31 47 31' */
const line = (f: CanFrame): string => `${hex(f.id).padStart(3, '0')} ${hex(f.data)}`;
/** The PCI type of each frame: SF, FF, CF, FC */
const kinds = (fs: CanFrame[]): string[] => fs.map((f) => ['SF', 'FF', 'CF', 'FC'][f.data[0] >> 4] ?? '?');

const VIN = '1G1JC5444R7252367';
const VIN_RESPONSE: Bytes = [0x49, 0x02, 0x01, ...[...VIN].map((c) => c.charCodeAt(0))];

let clock: Clock;
let bus: VirtualBus;
let frames: CanFrame[];

beforeEach(() => {
    vi.useFakeTimers();
    clock = createSystemClock();
    bus = new VirtualBus(clock);
    frames = [];
    bus.subscribe((f) => frames.push(f));
});

afterEach(() => {
    vi.useRealTimers();
});

describe('Scanner ⇄ ECU: VIN over ISO-TP', () => {
    it('the VIN is reassembled, and the log shows SF → FF → FC → CF → CF', async () => {
        attachEcu(bus, clock, createStubState);
        const scanner = new Scanner(new SimTransport(bus, clock));

        const vin = track(scanner.readVin());
        await vi.advanceTimersByTimeAsync(50);

        expect(vin.value).toBe(VIN);
        expect(frames.map(line)).toEqual([
            '7DF 02 09 02 55 55 55 55 55',
            '7E8 10 14 49 02 01 31 47 31',
            '7E0 30 00 00 55 55 55 55 55', // FC to the ECU's physical address
            '7E8 21 4A 43 35 34 34 34 52',
            '7E8 22 37 32 35 32 33 36 37',
        ]);
        expect(frames.map((f) => f.from)).toEqual(['tester', 'ecu', 'tester', 'ecu', 'ecu']);
    });

    it('the request is answered in a few milliseconds, CFs at least 1 ms apart', async () => {
        attachEcu(bus, clock, createStubState);
        const scanner = new Scanner(new SimTransport(bus, clock));
        void scanner.readVin();
        await vi.advanceTimersByTimeAsync(50);

        const [req, ff, fc, cf1, cf2] = frames.map((f) => f.t);
        expect(ff - req).toBe(5); // ECU response delay
        expect(fc).toBe(ff); // the tester answers at once
        expect(cf1 - fc).toBeGreaterThanOrEqual(1);
        expect(cf2 - cf1).toBeGreaterThanOrEqual(1);
    });

    it('three stored codes come in two frames', async () => {
        attachEcu(bus, clock, createStubState);
        const scanner = new Scanner(new SimTransport(bus, clock));

        const codes = track(scanner.readDtcs(0x03));
        await vi.advanceTimersByTimeAsync(50);

        expect(codes.value).toEqual(['P0300', 'P0420', 'P0171']);
        expect(kinds(frames)).toEqual(['SF', 'FF', 'FC', 'CF']);
        expect(frames[1].data).toEqual([0x10, 0x08, 0x43, 0x03, 0x03, 0x00, 0x04, 0x20]);
    });

    it('no pending codes: a Single Frame 47 00', async () => {
        attachEcu(bus, clock, createStubState);
        const scanner = new Scanner(new SimTransport(bus, clock));

        const codes = track(scanner.readDtcs(0x07));
        await vi.advanceTimersByTimeAsync(50);

        expect(codes.value).toEqual([]);
        expect(frames.map(line)).toEqual(['7DF 01 07 55 55 55 55 55 55', '7E8 02 47 00 55 55 55 55 55']);
    });

    it('the next request goes on the bus only after the long response is complete', async () => {
        attachEcu(bus, clock, createStubState);
        const scanner = new Scanner(new SimTransport(bus, clock));
        void scanner.readVin();
        void scanner.readPid(0x0c);
        await vi.advanceTimersByTimeAsync(100);

        expect(kinds(frames)).toEqual(['SF', 'FF', 'FC', 'CF', 'CF', 'SF', 'SF']);
        expect(frames[5].data.slice(0, 3)).toEqual([0x02, 0x01, 0x0c]);
    });
});

describe('Long responses: the slow and the broken', () => {
    /** Plays the ECU by hand: answers the request with these frames after `delay` ms each. */
    function fakeEcu(script: (send: (data: Bytes) => void) => void): void {
        bus.subscribe((f) => {
            if (f.from === 'tester' && f.id === 0x7df) script((data) => bus.send({ id: 0x7e8, data, from: 'ecu' }));
        });
    }

    it('a missing CF: the request gives null, not half a VIN', async () => {
        const [ff, , cf2] = segment(VIN_RESPONSE);
        fakeEcu((send) => {
            send(ff);
            clock.setTimeout(() => send(cf2), 2); // CF #1 got lost
        });
        const transport = new SimTransport(bus, clock);

        const result = track(transport.request([0x09, 0x02]));
        await vi.advanceTimersByTimeAsync(5);

        expect(result.done).toBe(true);
        expect(result.value).toBeNull();
    });

    it('the CFs stop: null 100 ms after the last frame', async () => {
        const [ff, cf1] = segment(VIN_RESPONSE);
        fakeEcu((send) => {
            send(ff);
            clock.setTimeout(() => send(cf1), 80);
        });
        const result = track(new SimTransport(bus, clock).request([0x09, 0x02]));

        await vi.advanceTimersByTimeAsync(179); // the last frame at 80 ms, 99 ms of silence since
        expect(result.done).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(result.value).toBeNull();
    });

    it('the timeout counts silence, not the whole transfer: 3 frames 80 ms apart still arrive', async () => {
        const [ff, cf1, cf2] = segment(VIN_RESPONSE);
        fakeEcu((send) => {
            clock.setTimeout(() => send(ff), 80);
            clock.setTimeout(() => send(cf1), 160);
            clock.setTimeout(() => send(cf2), 240);
        });
        const result = track(new SimTransport(bus, clock).request([0x09, 0x02]));
        await vi.advanceTimersByTimeAsync(240);
        expect(result.value).toEqual(VIN_RESPONSE);
    });

    it('a late long response to an old request: no FC, the new request waits for its own', async () => {
        const transport = new SimTransport(bus, clock);
        const result = track(transport.request([0x01, 0x0d]));

        // Someone's VIN arrives while we wait for the speed
        bus.send({ id: 0x7e8, data: segment(VIN_RESPONSE)[0], from: 'ecu' });
        bus.send({ id: 0x7e8, data: [0x03, 0x41, 0x0d, 0x3c], from: 'ecu' });
        await vi.advanceTimersByTimeAsync(0);

        expect(result.value).toEqual([0x41, 0x0d, 0x3c]);
        expect(kinds(frames.filter((f) => f.from === 'tester'))).toEqual(['SF']); // no Flow Control sent
    });

    it('a detached ECU stops a long response halfway', async () => {
        const detach = attachEcu(bus, clock, createStubState, { responseDelayMs: 5 });
        const scanner = new Scanner(new SimTransport(bus, clock));
        const vin = track(scanner.readVin());

        await vi.advanceTimersByTimeAsync(5); // FF and FC are out, the CFs are not
        detach();
        await vi.advanceTimersByTimeAsync(200);

        expect(kinds(frames)).toEqual(['SF', 'FF', 'FC']);
        expect(vin.value).toBeNull();
    });
});

describe('sendIsoTp(): the sender follows Flow Control', () => {
    /** Starts sending 20 bytes from 7E8; FC is expected on 7E0. */
    function start(fcTimeoutMs?: number) {
        const ended: SendResult[] = [];
        sendIsoTp(bus, clock, VIN_RESPONSE, {
            txId: 0x7e8,
            rxId: 0x7e0,
            from: 'ecu',
            fcTimeoutMs,
            onEnd: (r) => ended.push(r),
        });
        return ended;
    }
    const fc = (b0: number, bs = 0, st = 0): void => bus.send({ id: 0x7e0, data: [b0, bs, st], from: 'tester' });
    const cfs = (): CanFrame[] => frames.filter((f) => f.from === 'ecu' && f.data[0] >> 4 === 2);

    it('a short message is one Single Frame, sent at once', () => {
        const ended: SendResult[] = [];
        sendIsoTp(bus, clock, [0x41, 0x0d, 0x3c], { txId: 0x7e8, rxId: 0x7e0, from: 'ecu', onEnd: (r) => ended.push(r) });
        expect(frames.map(line)).toEqual(['7E8 03 41 0D 3C 55 55 55 55']);
        expect(ended).toEqual(['sent']);
    });

    it('without an FC only the FF goes out; after 1000 ms the sender gives up', async () => {
        const ended = start();
        await vi.advanceTimersByTimeAsync(999);
        expect(ended).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(ended).toEqual(['no-flow-control']);
        expect(kinds(frames)).toEqual(['FF']);
    });

    it('STmin = 10 ms spaces the CFs 10 ms apart', async () => {
        start();
        fc(0x30, 0, 10);
        await vi.advanceTimersByTimeAsync(100);
        const [a, b] = cfs();
        expect(a.t - frames[1].t).toBe(10);
        expect(b.t - a.t).toBe(10);
    });

    it('BS = 1: one CF per Flow Control', async () => {
        const ended = start();
        fc(0x30, 1);
        await vi.advanceTimersByTimeAsync(50);
        expect(cfs()).toHaveLength(1);

        fc(0x30, 1);
        await vi.advanceTimersByTimeAsync(50);
        expect(cfs()).toHaveLength(2);
        expect(ended).toEqual(['sent']);
    });

    it('WAIT postpones, OVERFLOW aborts', async () => {
        const ended = start(100);
        fc(0x30 | FLOW_STATUS.WAIT);
        await vi.advanceTimersByTimeAsync(90);
        fc(0x30 | FLOW_STATUS.WAIT); // the 100 ms wait starts again
        await vi.advanceTimersByTimeAsync(90);
        expect(ended).toEqual([]);

        fc(0x30 | FLOW_STATUS.OVERFLOW);
        expect(ended).toEqual(['overflow']);
        await vi.advanceTimersByTimeAsync(100);
        expect(cfs()).toHaveLength(0);
    });

    it("an FC on someone else's ID does not count", async () => {
        const ended = start(100);
        bus.send({ id: 0x7e1, data: [0x30, 0, 0], from: 'tester' });
        await vi.advanceTimersByTimeAsync(100);
        expect(ended).toEqual(['no-flow-control']);
    });
});
