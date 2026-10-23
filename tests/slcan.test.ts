import { describe, expect, it } from 'vitest';
import {
    BITRATE_COMMANDS,
    LineSplitter,
    describeBusStatus,
    encodeFrame,
    parseBusStatus,
    parseLine,
    parseVersion,
} from '../src/transport/slcan';

describe('encodeFrame', () => {
    it('ID, length, bytes in upper-case hex', () => {
        expect(encodeFrame(0x7df, [0x02, 0x01, 0x0c, 0x55, 0x55, 0x55, 0x55, 0x55])).toBe('t7DF802010C5555555555');
        expect(encodeFrame(0x7e0, [0x30, 0x00, 0x00])).toBe('t7E03300000');
        expect(encodeFrame(0x0a, [])).toBe('t00A0');
    });

    it('refuses what a classic 11-bit frame cannot carry', () => {
        expect(() => encodeFrame(0x800, [])).toThrow(RangeError);
        expect(() => encodeFrame(0x7df, [1, 2, 3, 4, 5, 6, 7, 8, 9])).toThrow(RangeError);
        expect(() => encodeFrame(0x7df, [256])).toThrow(RangeError);
    });

    it('500 kbit/s is S6, 250 is S5', () => {
        expect(BITRATE_COMMANDS[500]).toBe('S6');
        expect(BITRATE_COMMANDS[250]).toBe('S5');
    });
});

describe('parseLine', () => {
    it('a received frame', () => {
        expect(parseLine('t7E8804410C1AF8555555')).toEqual({
            kind: 'frame',
            frame: { id: 0x7e8, data: [0x04, 0x41, 0x0c, 0x1a, 0xf8, 0x55, 0x55, 0x55], extended: false, fd: false, remote: false },
        });
    });

    it('a short frame (DLC 3) and lower-case hex', () => {
        const t = parseLine('t7e8303410d');
        expect(t.kind === 'frame' && t.frame.data).toEqual([0x03, 0x41, 0x0d]);
    });

    it('29-bit, CAN FD and remote frames', () => {
        const ext = parseLine('T18DAF11080210030000000000');
        expect(ext.kind === 'frame' && [ext.frame.id, ext.frame.extended]).toEqual([0x18daf110, true]);

        const fd = parseLine(`b7E89${'11'.repeat(12)}`);
        expect(fd.kind === 'frame' && [fd.frame.fd, fd.frame.data.length]).toEqual([true, 12]);

        const rtr = parseLine('r1238');
        expect(rtr.kind === 'frame' && rtr.frame.remote).toBe(true);
    });

    it('a frame whose length does not match its DLC is not a frame', () => {
        expect(parseLine('t7E880441').kind).toBe('other');
        expect(parseLine('t7E89' + '00'.repeat(9)).kind).toBe('other');
    });

    it('feedback: bare CR = ok, BEL = fail, advanced "#" and "#1"', () => {
        expect(parseLine('')).toEqual({ kind: 'ok' });
        expect(parseLine('\x07')).toEqual({ kind: 'fail' });
        expect(parseLine('#')).toEqual({ kind: 'ok' });
        expect(parseLine('#9')).toEqual({ kind: 'fail', code: '9' });
    });

    it('version text, bus status, anything else', () => {
        expect(parseLine('+Board: Multiboard').kind).toBe('info');
        expect(parseLine('E2310800C').kind).toBe('status');
        expect(parseLine('v1.0 https://github.com/normaldotcom/canable2-fw').kind).toBe('other');
    });
});

describe('bus status', () => {
    it('E2310800C: passive, no ACK, Tx timeout, 128 / 12 errors', () => {
        expect(parseBusStatus('E2310800C')).toEqual({
            state: 'passive',
            lastError: 'no ACK received',
            flags: ['Tx timeout'],
            txErrors: 128,
            rxErrors: 12,
        });
    });

    it('several flags at once', () => {
        expect(parseBusStatus('E300F0000')?.flags).toEqual(['Rx failed', 'Tx failed', 'CAN Tx buffer overflow', 'USB IN buffer overflow']);
    });

    it('explains "no ACK" in OBD terms', () => {
        expect(describeBusStatus(parseBusStatus('E03020800')!)).toMatch(/ignition off, or CAN-H \/ CAN-L not connected/);
        expect(describeBusStatus(parseBusStatus('E21000000')!)).toMatch(/wrong bitrate/);
        expect(describeBusStatus(parseBusStatus('E30000000')!)).toMatch(/Bus off/);
    });

    it('not a status line', () => {
        expect(parseBusStatus('E2')).toBeNull();
        expect(parseBusStatus('E7310800C')).toBeNull();
    });
});

describe('parseVersion', () => {
    it('CANable 2.5', () => {
        const info = parseVersion('+Board: Multiboard\tMCU: STM32G431\tSlcan: 105\tSerial: 206249E3946306550');
        expect(info).toMatchObject({ firmware: 'canable-2.5', board: 'Multiboard', slcanVersion: 105, serial: '206249E3946306550' });
    });

    it('legacy canable2-fw', () => {
        expect(parseVersion('v1.0-abc123 https://github.com/normaldotcom/canable2-fw')).toEqual({
            firmware: 'legacy',
            text: 'v1.0-abc123 https://github.com/normaldotcom/canable2-fw',
        });
    });
});

describe('LineSplitter', () => {
    it('lines can arrive in pieces', () => {
        const s = new LineSplitter();
        expect(s.push('t7E88044')).toEqual([]);
        expect(s.push('10C1AF8555555\rt7E8')).toEqual(['t7E8804410C1AF8555555']);
        expect(s.push('303410D\r')).toEqual(['t7E8303410D']);
    });

    it('a bare CR is an empty token, BEL is a token of its own', () => {
        expect(new LineSplitter().push('\r\x07\r')).toEqual(['', '\x07', '']);
    });

    it('keeps tabs (the version string), drops line feeds and NULs', () => {
        expect(new LineSplitter().push('+A: 1\tB: 2\r\n\u0000x\r')).toEqual(['+A: 1\tB: 2', 'x']);
    });
});
