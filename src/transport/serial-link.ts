// The wire to a USB serial device: text in, text out.
// SlcanBus only knows the SerialLink interface, so tests plug in a fake adapter (tests/helpers/fake-canable.ts)
// and the browser plugs in Web Serial (desktop Chrome / Edge / Opera, https or localhost).

export interface SerialLink {
    /** Send text as-is. The caller adds the '\r' at the end of each command. */
    write(text: string): Promise<void>;
    /** Text from the device, chunk by chunk, as it arrives. A chunk can stop in the middle of a line. */
    onData(listener: (text: string) => void): () => void;
    /** Called once when the link goes away: unplugged, or close(). */
    onClose(listener: (reason?: unknown) => void): () => void;
    close(): Promise<void>;
}

// ---------- Minimal Web Serial types ----------
// TypeScript's lib.dom has no Web Serial (only Chromium ships it), so we describe the part we use.

export interface WebSerialPort {
    open(options: { baudRate: number }): Promise<void>;
    close(): Promise<void>;
    readonly readable: ReadableStream<Uint8Array> | null;
    readonly writable: WritableStream<Uint8Array> | null;
}

interface WebSerial {
    requestPort(options?: object): Promise<WebSerialPort>;
}

function webSerial(): WebSerial | undefined {
    if (typeof navigator === 'undefined') return undefined;
    return (navigator as Navigator & { serial?: WebSerial }).serial;
}

/** Desktop Chrome / Edge / Opera over https or localhost. Not Firefox, not Safari, not phones. */
export function isWebSerialSupported(): boolean {
    return webSerial() !== undefined;
}

/** Opens the browser's port picker. Must be called from a click handler (user gesture). */
export async function requestSerialPort(): Promise<WebSerialPort> {
    const serial = webSerial();
    if (!serial) throw new Error('This browser has no Web Serial. Use desktop Chrome or Edge.');
    return serial.requestPort();
}

/**
 * Opens a port and turns it into a SerialLink.
 * A CANable with slcan firmware is a USB CDC device: the baud rate is ignored, USB always runs at full speed.
 */
export async function openWebSerial(port: WebSerialPort, baudRate = 115200): Promise<SerialLink> {
    await port.open({ baudRate });
    if (!port.readable || !port.writable) {
        await port.close().catch(() => undefined);
        throw new Error('The port opened but has no data streams.');
    }

    const dataListeners = new Set<(text: string) => void>();
    const closeListeners = new Set<(reason?: unknown) => void>();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder(); // slcan is plain ASCII
    const reader = port.readable.getReader();
    const writer = port.writable.getWriter();
    let closed = false;
    let closing = false;

    const finish = (reason?: unknown): void => {
        if (closed) return;
        closed = true;
        for (const l of [...closeListeners]) l(reason);
    };

    // Read loop: runs until the port goes away or close() cancels the reader.
    void (async () => {
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                const text = decoder.decode(value, { stream: true });
                if (text) for (const l of [...dataListeners]) l(text);
            }
            finish();
        } catch (err) {
            // A real disconnect (cable pulled) lands here; our own close() lands here too, quietly.
            finish(closing ? undefined : err);
        }
    })();

    return {
        async write(text) {
            if (closed) throw new Error('The adapter is disconnected.');
            await writer.write(encoder.encode(text));
        },
        onData(listener) {
            dataListeners.add(listener);
            return () => void dataListeners.delete(listener);
        },
        onClose(listener) {
            closeListeners.add(listener);
            return () => void closeListeners.delete(listener);
        },
        async close() {
            if (closed) return;
            closing = true;
            // Order matters: a port won't close while its streams are locked.
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
            await writer.close().catch(() => undefined);
            writer.releaseLock();
            await port.close().catch(() => undefined);
            finish();
        },
    };
}
