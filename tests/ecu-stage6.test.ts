// What stage 6 added to the ECU and its wire to the bus.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualBus } from '../src/core/can/bus';
import type { CanFrame } from '../src/core/can/frame';
import { createSystemClock, type Clock } from '../src/core/clock';
import { explainFrame } from '../src/core/obd/explain';
import { decodeMonitorStatus, encodeMonitorStatus, MONITOR_STATUS_INFO } from '../src/core/obd/monitor-status';
import { getPid, parseSupported } from '../src/core/obd/pids';
import { respond, SUPPORTED_PIDS } from '../src/core/vehicle/ecu';
import { createEcuLink } from '../src/core/vehicle/ecu-link';
import { createStubState } from '../src/core/vehicle/model';

const stub = createStubState();

describe('PID 01 01: MIL and number of stored codes', () => {
    it('stub: MIL on, 3 codes → A = 80 + 3 = 83', () => {
        expect(respond([0x01, 0x01], stub, false)).toEqual([0x41, 0x01, 0x83, 0x07, 0x65, 0x00]);
    });

    it('no codes, MIL off → A = 00', () => {
        expect(respond([0x01, 0x01], { ...stub, milOn: false, storedDtcs: [] }, false)?.[2]).toBe(0x00);
    });

    it('encode and decode agree', () => {
        expect(decodeMonitorStatus(encodeMonitorStatus(true, 5))).toEqual({ milOn: true, storedCount: 5 });
        expect(decodeMonitorStatus(encodeMonitorStatus(false, 200))).toEqual({ milOn: false, storedCount: 0x7f });
    });

    it('01 is advertised in the 01 00 mask', () => {
        expect(SUPPORTED_PIDS[0]).toBe(0x01);
        const mask = respond([0x01, 0x00], stub, false)!;
        expect(mask[2] & 0x80).toBe(0x80); // the very first bit is PID 01
    });

    it('the log explains it: A in binary, the formula, the result', () => {
        const vocab = { getPid: (p: number) => (p === 1 ? MONITOR_STATUS_INFO : getPid(p)), decodeSupportedPids: parseSupported };
        const ex = explainFrame({ id: 0x7e8, data: [0x06, 0x41, 0x01, 0x83, 0x07, 0x65, 0x00, 0x55] }, vocab);
        expect(ex.bytes[3].text).toContain('10000011');
        expect(ex.calc?.substituted).toBe('131 AND 7F; MIL = bit 7 of 131');
        expect(ex.calc?.result).toBe('3 code(s)');
    });
});

describe('fuel trims 06 and 07', () => {
    it('are answered from the state', () => {
        expect(respond([0x01, 0x06], { ...stub, stftPct: 0 }, false)).toEqual([0x41, 0x06, 0x80]);
        expect(respond([0x01, 0x07], { ...stub, ltftPct: 12.5 }, false)).toEqual([0x41, 0x07, 0x90]);
    });
});

describe('mode 04: clear codes', () => {
    it('engine running → refused, 7F 04 22 (conditions not correct)', () => {
        expect(respond([0x04], stub, false)).toEqual([0x7f, 0x04, 0x22]);
    });

    it('engine stopped → 44, on a broadcast too', () => {
        expect(respond([0x04], { ...stub, rpm: 0 }, false)).toEqual([0x44]);
        expect(respond([0x04], { ...stub, rpm: 0 }, true)).toEqual([0x44]);
    });
});

describe('ECU link: power and delay', () => {
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
    afterEach(() => vi.useRealTimers());

    it('without power the module hears nothing and sends nothing', () => {
        let on = false;
        const link = createEcuLink(bus, clock, { powered: () => on, extraDelayMs: () => 0 });
        const heard = vi.fn();
        link.subscribe(heard);
        bus.send({ id: 0x7df, data: [0x02, 0x01, 0x0c], from: 'tester' });
        link.send({ id: 0x7e8, data: [0x01, 0x44], from: 'ecu' });
        expect(heard).not.toHaveBeenCalled();
        expect(frames.filter((f) => f.from === 'ecu')).toEqual([]);

        on = true;
        bus.send({ id: 0x7df, data: [0x02, 0x01, 0x0c], from: 'tester' });
        expect(heard).toHaveBeenCalledTimes(1);
    });

    it('no delay: the frame goes out at once', () => {
        const link = createEcuLink(bus, clock, { powered: () => true, extraDelayMs: () => 0 });
        link.send({ id: 0x7e8, data: [0x01, 0x44], from: 'ecu' });
        expect(frames).toHaveLength(1);
    });

    it('with a delay: frames leave later, in the order they were sent, even if the delay shrinks', async () => {
        let delay = 100;
        const link = createEcuLink(bus, clock, { powered: () => true, extraDelayMs: () => delay });
        link.send({ id: 0x7e8, data: [0x01, 0x01], from: 'ecu' });
        delay = 10;
        link.send({ id: 0x7e8, data: [0x01, 0x02], from: 'ecu' });
        await vi.advanceTimersByTimeAsync(99);
        expect(frames).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(frames.map((f) => f.data[1])).toEqual([0x01, 0x02]);
    });

    it('dispose() drops the frames still waiting', async () => {
        const link = createEcuLink(bus, clock, { powered: () => true, extraDelayMs: () => 50 });
        link.send({ id: 0x7e8, data: [0x01, 0x44], from: 'ecu' });
        link.dispose();
        await vi.advanceTimersByTimeAsync(100);
        expect(frames).toHaveLength(0);
    });
});
