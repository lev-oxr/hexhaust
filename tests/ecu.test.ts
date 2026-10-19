import { describe, expect, it } from 'vitest';
import { isResponseTo } from '../src/core/obd/match';
import { parseSupported } from '../src/core/obd/pids';
import { respond, SUPPORTED_PIDS } from '../src/core/vehicle/ecu';
import { createStubState } from '../src/core/vehicle/model';

const state = createStubState(); // 1726 rpm, 60 km/h, 35 °C

describe('ECU: respond()', () => {
    it.each([
        { req: [0x01, 0x0c], resp: [0x41, 0x0c, 0x1a, 0xf8], what: 'engine speed 1726 rpm' },
        { req: [0x01, 0x0d], resp: [0x41, 0x0d, 0x3c], what: 'vehicle speed 60 km/h' },
        { req: [0x01, 0x05], resp: [0x41, 0x05, 0x4b], what: 'coolant temperature 35 °C' },
    ])('$what: $req → $resp', ({ req, resp }) => {
        expect(respond(req, state, false)).toEqual(resp);
    });

    it('answers a broadcast and a physical request identically', () => {
        expect(respond([0x01, 0x0c], state, true)).toEqual(respond([0x01, 0x0c], state, false));
    });

    it('takes values from the state at the time of the request', () => {
        expect(respond([0x01, 0x0d], { ...state, speedKmh: 100 }, false)).toEqual([0x41, 0x0d, 0x64]);
    });

    it('stays silent on an unsupported PID — for a physical request too', () => {
        expect(respond([0x01, 0x0a], state, false)).toBeNull();
        expect(respond([0x01, 0x0a], state, true)).toBeNull();
    });

    it('unknown service: silent on 7DF, replies 7F xx 11 on 7E0', () => {
        expect(respond([0x22, 0xf1, 0x90], state, false)).toBeNull();
        expect(respond([0x22, 0xf1, 0x90], state, true)).toEqual([0x7f, 0x22, 0x11]);
    });

    it('stays silent on an empty request and on several PIDs at once', () => {
        expect(respond([], state, true)).toBeNull();
        expect(respond([0x01], state, true)).toBeNull();
        expect(respond([0x01, 0x0c, 0x0d], state, true)).toBeNull();
    });

    it('every response passes the isResponseTo check', () => {
        for (const pid of SUPPORTED_PIDS) {
            const resp = respond([0x01, pid], state, false);
            expect(resp, `PID ${pid.toString(16)}`).not.toBeNull();
            expect(isResponseTo([0x01, pid], resp!)).toBe(true);
        }
    });
});

describe('ECU: supported PID masks', () => {
    /** Walk 01 00 → 01 20 → … the way the scanner will. */
    function walkMasks(): number[] {
        const found: number[] = [];
        for (let base = 0; base <= 0xe0; base += 0x20) {
            const resp = respond([0x01, base], state, false);
            if (!resp) break;
            expect(resp.slice(0, 2)).toEqual([0x41, base]);
            const pids = parseSupported(base, resp.slice(2));
            found.push(...pids.filter((p) => p !== base + 0x20));
            if (!pids.includes(base + 0x20)) break;
        }
        return found;
    }

    it('01 00 is always answered and lists engine speed and vehicle speed', () => {
        const resp = respond([0x01, 0x00], state, false);
        expect(resp).toHaveLength(6);
        const pids = parseSupported(0, resp!.slice(2));
        expect(pids).toContain(0x0c);
        expect(pids).toContain(0x0d);
    });

    it('the mask chain yields exactly the PIDs the ECU responds to', () => {
        expect(walkMasks()).toEqual([...SUPPORTED_PIDS]);
    });

    it('the ECU stays silent for a range with nothing in it', () => {
        expect(respond([0x01, 0xe0], state, false)).toBeNull();
    });
});