import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanFrame } from '../src/core/can/frame';
import { createSystemClock, type Clock } from '../src/core/clock';
import { Scanner } from '../src/core/scanner/scanner';
import type { BusStatus } from '../src/transport/slcan';
import { SlcanBus, type TraceLine } from '../src/transport/slcan-bus';
import { SimTransport } from '../src/transport/sim';
import { FakeCanable, type FakeCanableOptions } from './helpers/fake-canable';

let clock: Clock;

beforeEach(() => {
    vi.useFakeTimers();
    clock = createSystemClock();
});

afterEach(() => {
    vi.useRealTimers();
});

function make(opts: FakeCanableOptions = {}) {
    const fake = new FakeCanable(clock, opts);
    const trace: TraceLine[] = [];
    const statuses: BusStatus[] = [];
    const onDisconnect = vi.fn();
    const onRejected = vi.fn();
    const bus = new SlcanBus(fake, clock, {
        onTrace: (l) => trace.push(l),
        onStatus: (s) => statuses.push(s),
        onDisconnect,
        onRejected,
    });
    const frames: CanFrame[] = [];
    bus.subscribe((f) => frames.push(f));
    return { fake, bus, trace, statuses, frames, onDisconnect, onRejected };
}

async function settle<T>(p: Promise<T>, ms = 5000): Promise<T> {
    await vi.advanceTimersByTimeAsync(ms);
    return p;
}

const kinds = (fs: CanFrame[]): string[] => fs.map((f) => `${f.from} ${['SF', 'FF', 'CF', 'FC'][f.data[0] >> 4]}`);

describe('start', () => {
    it('CANable 2.5: close, ask the version, error reports, 500k, one-shot, normal mode, open', async () => {
        const { fake, bus } = make();
        const info = await settle(bus.start({ bitrate: 500, listenOnly: false }));
        expect(fake.received).toEqual(['C', 'V', 'C', 'ME', 'S6', 'A0', 'M0', 'O']);
        expect(info).toMatchObject({ firmware: 'canable-2.5', board: 'Multiboard', slcanVersion: 105 });
        expect(bus.isOpen).toBe(true);
        expect(fake.isOpen && fake.oneShot && !fake.silent && fake.errorReports).toBe(true);
    });

    it('legacy firmware: no ME, no waiting for feedback', async () => {
        const { fake, bus } = make({ firmware: 'legacy' });
        const info = await settle(bus.start({ bitrate: 250, listenOnly: true }));
        expect(info.firmware).toBe('legacy');
        expect(fake.received).toEqual(['C', 'V', 'C', 'S5', 'A0', 'M1', 'O']);
        expect(fake.silent).toBe(true);
    });

    it('nothing answers "V": NOT_SLCAN', async () => {
        const { bus } = make({ dead: true });
        const p = bus.start({ bitrate: 500, listenOnly: false });
        const check = expect(p).rejects.toMatchObject({ code: 'NOT_SLCAN' });
        await vi.advanceTimersByTimeAsync(2000);
        await check;
        expect(bus.isOpen).toBe(false);
    });

    it('the adapter refuses a command: REJECTED, with the command named', async () => {
        const { bus } = make({ reject: ['S6'] });
        const p = bus.start({ bitrate: 500, listenOnly: false });
        const check = expect(p).rejects.toMatchObject({ code: 'REJECTED', message: expect.stringContaining('"S6"') });
        await vi.advanceTimersByTimeAsync(2000);
        await check;
    });

    it('replies cut into 3-character USB chunks still work', async () => {
        const { bus } = make({ chunkSize: 3 });
        expect((await settle(bus.start({ bitrate: 500, listenOnly: false }))).board).toBe('Multiboard');
    });

    it('never sends a bare CR: legacy firmware would repeat the previous frame', async () => {
        const { fake, bus } = make({ firmware: 'legacy' });
        await settle(bus.start({ bitrate: 500, listenOnly: false }));
        bus.send({ id: 0x7df, data: [0x01, 0x04], from: 'tester' });
        await settle(bus.reconfigure({ bitrate: 500, listenOnly: false }));
        await bus.close();
        expect(fake.rawWritten.startsWith('\r')).toBe(false);
        expect(fake.rawWritten).not.toContain('\r\r');
    });
});

describe('frames', () => {
    it('send pads to 8 bytes, writes one t-line and shows the frame as "tester"', async () => {
        const { fake, bus, frames } = make({ noCar: true });
        await settle(bus.start({ bitrate: 500, listenOnly: false }));
        bus.send({ id: 0x7df, data: [0x02, 0x01, 0x0c], from: 'tester' });
        expect(fake.received.at(-1)).toBe('t7DF802010C5555555555');
        expect(frames).toEqual([
            { id: 0x7df, data: [0x02, 0x01, 0x0c, 0x55, 0x55, 0x55, 0x55, 0x55], t: expect.any(Number), from: 'tester' },
        ]);
    });

    it('listen only: send throws LISTEN_ONLY and nothing is written', async () => {
        const { fake, bus } = make();
        await settle(bus.start({ bitrate: 500, listenOnly: true }));
        const before = fake.received.length;
        expect(() => bus.send({ id: 0x7df, data: [0x02, 0x01, 0x0c], from: 'tester' })).toThrow(/Listen only/);
        expect(fake.received.length).toBe(before);
    });

    it('not open yet: send throws', () => {
        const { bus } = make();
        expect(() => bus.send({ id: 0x7df, data: [0x02, 0x01, 0x0c], from: 'tester' })).toThrow(/not on the bus/);
    });

    it('frames from the car arrive as "ecu"; another tester\'s request as "tester"', async () => {
        const { fake, bus, frames } = make({ noCar: true });
        await settle(bus.start({ bitrate: 500, listenOnly: true }));
        fake.busFrame(0x7e8, [0x03, 0x41, 0x0d, 0x3c]);
        fake.busFrame(0x7df, [0x02, 0x01, 0x0d]);
        fake.emit('r1230\r'); // a remote frame: ignored
        await vi.advanceTimersByTimeAsync(20);
        expect(frames.map((f) => [f.id, f.from])).toEqual([
            [0x7e8, 'ecu'],
            [0x7df, 'tester'],
        ]);
    });

    it('no car: CANable 2.5 reports "no ACK" through onStatus', async () => {
        const { bus, statuses } = make({ noCar: true });
        await settle(bus.start({ bitrate: 500, listenOnly: false }));
        bus.send({ id: 0x7df, data: [0x02, 0x01, 0x0c], from: 'tester' });
        await vi.advanceTimersByTimeAsync(20);
        expect(statuses[0]).toMatchObject({ lastError: 'no ACK received', flags: ['Tx failed'] });
    });

    it('a BEL nobody waited for counts as a rejected frame', async () => {
        const { fake, bus, onRejected } = make();
        await settle(bus.start({ bitrate: 500, listenOnly: false }));
        fake.emit('\x07');
        expect(onRejected).toHaveBeenCalledTimes(1);
    });

    it('the trace marks frame lines so the panel can hide them', async () => {
        const { bus, trace } = make();
        await settle(bus.start({ bitrate: 500, listenOnly: false }));
        bus.send({ id: 0x7df, data: [0x02, 0x01, 0x0c], from: 'tester' });
        await vi.advanceTimersByTimeAsync(50);
        expect(
            trace
                .filter((l) => !l.frame)
                .map((l) => `${l.dir} ${l.text}`)
                .slice(0, 4),
        ).toEqual(['out C', 'out V', expect.stringMatching(/^in \+Board/), 'out C']);
        expect(trace.filter((l) => l.frame).map((l) => l.dir)).toEqual(['out', 'in']);
    });
});

describe('SimTransport over the real bus', () => {
    it('01 0C → 41 0C 1A F8, through the adapter and back', async () => {
        const { bus } = make();
        await settle(bus.start({ bitrate: 500, listenOnly: false }));
        const scanner = new Scanner(new SimTransport(bus, clock));
        expect((await settle(scanner.readPid(0x0c)))?.value).toBe(1726);
    });

    it('VIN: we send the Flow Control ourselves, the log sees SF → FF → FC → CF → CF in order', async () => {
        const { bus, frames, fake } = make({ chunkSize: 7 });
        await settle(bus.start({ bitrate: 500, listenOnly: false }));
        const scanner = new Scanner(new SimTransport(bus, clock));
        expect(await settle(scanner.readVin())).toBe('1G1JC5444R7252367');
        expect(kinds(frames)).toEqual(['tester SF', 'ecu FF', 'tester FC', 'ecu CF', 'ecu CF']);
        expect(fake.received).toContain(`t7E08300000${'55'.repeat(5)}`); // FC 30 00 00 to 7E0, padded
    });
});

describe('disconnect', () => {
    it('cable pulled: onDisconnect once, send throws DISCONNECTED', async () => {
        const { fake, bus, onDisconnect } = make();
        await settle(bus.start({ bitrate: 500, listenOnly: false }));
        fake.unplug();
        expect(onDisconnect).toHaveBeenCalledTimes(1);
        expect(() => bus.send({ id: 0x7df, data: [0x02, 0x01, 0x0c], from: 'tester' })).toThrow(/disconnected/);
    });

    it('cable pulled while starting: DISCONNECTED, not NOT_SLCAN', async () => {
        const { fake, bus } = make();
        const p = bus.start({ bitrate: 500, listenOnly: false });
        const check = expect(p).rejects.toMatchObject({ code: 'DISCONNECTED' });
        fake.unplug();
        await vi.advanceTimersByTimeAsync(2000);
        await check;
    });

    it('close() leaves the bus with "C" and is not an unexpected disconnect', async () => {
        const { fake, bus, onDisconnect } = make();
        await settle(bus.start({ bitrate: 500, listenOnly: false }));
        await bus.close();
        expect(fake.received.at(-1)).toBe('C');
        expect(onDisconnect).not.toHaveBeenCalled();
    });
});
