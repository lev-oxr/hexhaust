// The common language between the scanner and any data source.
// It works at the level of OBD messages, not CAN frames: "sent 01 0C, got 41 0C 1A F8".

import type { Bytes } from '../core/can/frame';

/** How long to wait for a response unless told otherwise. */
export const DEFAULT_TIMEOUT_MS = 100;

/** After "response pending" (7F xx 78) the ECU may take this long (ISO 15765-4 P2*CAN). */
export const PENDING_TIMEOUT_MS = 5000;

export interface RequestOptions {
    /** true — to a specific module (7E0), false — broadcast (7DF). Defaults to false. */
    physical?: boolean;
    /** How long to wait for a response, ms. No answer in time — null. */
    timeoutMs?: number;
}

export interface Transport {
    /** Send a request and wait for its response. null — nobody answered in time. */
    request(payload: Bytes, opts?: RequestOptions): Promise<Bytes | null>;
    close(): Promise<void>;
}