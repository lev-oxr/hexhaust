import { describe, expect, it } from 'vitest';
import { decodeVinResponse, encodeVin, isValidVin } from '../src/core/obd/vin';

const VIN = '1G1JC5444R7252367';
const RESP = [0x49, 0x02, 0x01, ...encodeVin(VIN)];

describe('VIN', () => {
    it('encodes to ASCII and back', () => {
        expect(encodeVin(VIN).slice(0, 3)).toEqual([0x31, 0x47, 0x31]);
        expect(decodeVinResponse(RESP)).toBe(VIN);
    });

    it('takes the last 17 bytes when the ECU pads the front with 00', () => {
        expect(decodeVinResponse([0x49, 0x02, 0x01, 0x00, 0x00, ...encodeVin(VIN)])).toBe(VIN);
    });

    it('rejects letters I, O, Q and a wrong length', () => {
        expect(isValidVin('1G1JC5444R725236O')).toBe(false);
        expect(isValidVin('1G1JC5444R72523')).toBe(false);
        expect(() => encodeVin('short')).toThrow();
    });

    it('not a VIN response → null', () => {
        expect(decodeVinResponse([0x41, 0x0c, 0x1a, 0xf8])).toBeNull();
        expect(decodeVinResponse(RESP.slice(0, 10))).toBeNull();
    });
});
