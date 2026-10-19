// Scanner: what the user sees. It asks "what's the RPM?" and gets a number with units.
// It never sees frames itself — it talks to a Transport, so it works the same with the simulator and an ELM327.
//
// The key rule: only ONE request on the bus at a time. Otherwise you can't tell which response belongs
// to which request, and a real ELM327 can't handle parallel requests at all. Hence the queue.

import type { Bytes } from '../can/frame';
import { DEFAULT_TIMEOUT_MS, type RequestOptions, type Transport } from '../../transport/transport';
import { isNegativeResponse, isResponseTo } from '../obd/match';
import { parseSupported, getPid } from '../obd/pids';

export interface PidReading {
    pid: number;
    name: string;
    unit: string;
    value: number;
    /** Data bytes A, B… from the response — for the inspector in stage 4. */
    data: Bytes;
}

export interface ScannerOptions {
    /** Timeout for each request, ms. */
    timeoutMs?: number;
}

/** A request waiting its turn. resolve/reject are the "remote control" for the Promise we handed out. */
interface Job {
    payload: Bytes;
    opts: Required<RequestOptions>;
    resolve: (resp: Bytes | null) => void;
    reject: (err: unknown) => void;
}

export class Scanner {
    readonly timeoutMs: number;
    private readonly transport: Transport;
    private readonly queue: Job[] = [];
    private busy = false;

    constructor(transport: Transport, options: ScannerOptions = {}) {
        this.transport = transport;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    }

    /** How many requests haven't finished yet, including the one on the bus right now. */
    get pending(): number {
        return this.queue.length + (this.busy ? 1 : 0);
    }

    /**
     * Raw request: [0x01, 0x0C] → [0x41, 0x0C, 0x1A, 0xF8] or null.
     * Call it as many times in a row as you like — the requests go onto the bus one at a time.
     */
    request(payload: Bytes, opts: RequestOptions = {}): Promise<Bytes | null> {
        return new Promise((resolve, reject) => {
            this.queue.push({
                payload: [...payload],
                opts: {
                    physical: opts.physical ?? false,
                    timeoutMs: opts.timeoutMs ?? this.timeoutMs,
                },
                resolve,
                reject,
            });
            void this.pump(); // void: we deliberately don't await; pump drains the queue on its own
        });
    }

    /** Read one mode 01 PID and decode it using the table from pids.ts. */
    async readPid(pid: number): Promise<PidReading | null> {
        const def = getPid(pid);
        if (!def) throw new Error(`PID ${pid.toString(16)} немає в таблиці pids.ts`);

        const resp = await this.request([0x01, pid]);
        if (!resp || isNegativeResponse(resp)) return null;

        // 41 PID A B …: the data starts at the third byte
        const data = resp.slice(2, 2 + def.length);
        if (data.length !== def.length) return null; // response too short — better nothing than garbage

        return { pid, name: def.name, unit: def.unit, value: def.decode(data), data };
    }

    /**
     * Ask 01 00, then 01 20, 01 40… for as long as the ECU says "keep asking".
     * @returns a sorted list of data PIDs (without 00/20/40 themselves)
     */
    async readSupportedPids(): Promise<number[]> {
        const result: number[] = [];
        for (let base = 0x00; base <= 0xe0; base += 0x20) {
            const resp = await this.request([0x01, base]);
            if (!resp || isNegativeResponse(resp) || resp.length < 6) break;

            const pids = parseSupported(base, resp.slice(2, 6));
            result.push(...pids.filter((p) => p !== base + 0x20));
            if (!pids.includes(base + 0x20)) break; // last bit not set — there's nothing further
        }
        return result.sort((a, b) => a - b);
    }

    /** Takes requests from the queue one by one until it's empty. */
    private async pump(): Promise<void> {
        if (this.busy) return; // already running — it will pick up the new request itself
        this.busy = true;
        try {
            while (this.queue.length > 0) {
                const job = this.queue.shift()!;
                try {
                    const resp = await this.transport.request(job.payload, job.opts);
                    // Second line of defence. sim.ts already filters out foreign responses,
                    // but a real ELM327 will hand over whatever arrived.
                    job.resolve(resp && isResponseTo(job.payload, resp) ? resp : null);
                } catch (err) {
                    job.reject(err);
                }
            }
        } finally {
            this.busy = false;
        }
    }
}