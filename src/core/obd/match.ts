// Is this response an answer to this particular request?
// Without this check you get the classic bug: the answer to a previous request arrives late,
// while we're already waiting for the next one — and the scanner shows RPM in the speed field.

import type { Bytes } from '../can/frame';

/** First byte of a negative response: 7F <service> <reason code>. */
export const NEGATIVE_RESPONSE = 0x7f;

/** The most common reason codes (NRC). */
export const NRC = {
    SERVICE_NOT_SUPPORTED: 0x11,
    /** "Wait, still working on it." We'll handle it together with the slow ECU in stage 6. */
    RESPONSE_PENDING: 0x78,
    /** "Not now." Mode 04 with the engine running gets this. */
    CONDITIONS_NOT_CORRECT: 0x22,
} as const;

/** Services where the second response byte echoes the PID from the request. */
const ECHOES_PID = new Set([0x01, 0x02, 0x09]);

export function isNegativeResponse(resp: Bytes): boolean {
    return resp.length >= 3 && resp[0] === NEGATIVE_RESPONSE;
}

/**
 * 01 0C    →  41 0C 1A F8   yes: service + 0x40, same PID
 * 01 0C    →  41 0D 3C      no: different PID
 * 22 F1 90 →  7F 22 11      yes: negative response to service 22
 */
export function isResponseTo(req: Bytes, resp: Bytes): boolean {
    if (req.length === 0 || resp.length === 0) return false;
    const service = req[0];

    if (resp[0] === NEGATIVE_RESPONSE) {
        return isNegativeResponse(resp) && resp[1] === service;
    }

    if (resp[0] !== service + 0x40) return false;

    if (ECHOES_PID.has(service) && req.length >= 2) {
        return resp.length >= 2 && resp[1] === req[1];
    }
    return true;
}