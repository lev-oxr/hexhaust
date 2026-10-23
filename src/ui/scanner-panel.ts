import type { Bytes } from '../core/can/frame';
import { decodeDtcList } from '../core/obd/dtc';
import { formatValue, type PidInfo, type Vocab } from '../core/obd/explain';
import { decodeVinResponse } from '../core/obd/vin';
import { el } from './dom';
import { hex2, hexBytes, parseHex } from './format';

export type RequestFn = (payload: Bytes) => Promise<Bytes | null>;

export interface ScannerPanelOptions {
  vocab: Vocab;
  request: RequestFn;
  /** Pause between polling rounds, ms */
  pollGapMs?: number;
  /** What the car is doing right now, to word failures correctly. Without a car the panel stays generic. */
  ecu?: { powered(): boolean; engineRunning(): boolean };
}

export interface ScannerPanel {
  root: HTMLElement;
  /** Find supported PIDs (repeats 01 00, 01 20, ...) */
  discover(): Promise<void>;
  /** The key went to Off: the status line must not claim the ECU still answers */
  ecuOff(): void;
  /** Put a message in the status line (a new data source, listen only…), unless a search is running */
  notice(text: string): void;
  /** A different data source is a different ECU: VIN, codes and Clear codes results from the old one no longer apply */
  resetOutputs(): void;
  /** Same as the Clear codes button; resolves to the text shown next to it */
  clearCodes(): Promise<string>;
  destroy(): void;
}

/** Every PID the vocabulary knows (except the bitmask PIDs 00, 20, 40, ...), ascending */
export function listPids(vocab: Vocab): PidInfo[] {
  const out: PidInfo[] = [];
  for (let p = 1; p <= 0xff; p++) {
    if (p % 0x20 === 0) continue;
    const def = vocab.getPid(p);
    if (def) out.push(def);
  }
  return out;
}

interface Row {
  def: PidInfo;
  tr: HTMLTableRowElement;
  check: HTMLInputElement;
  value: HTMLElement;
  once: HTMLButtonElement;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const DEFAULT_ON = [0x0c, 0x0d];

export function createScannerPanel(opts: ScannerPanelOptions): ScannerPanel {
  const { vocab, request } = opts;
  const gap = opts.pollGapMs ?? 300;
  const pids = listPids(vocab);
  const silent = (): string => (opts.ecu && !opts.ecu.powered() ? 'no response: the ECU is off (key Off)' : 'no response');

  const root = el('section', 'panel scanner-panel');
  root.setAttribute('aria-labelledby', 'scan-title');

  const head = el('header', 'panel-head');
  const title = el('h2', 'panel-title', 'Scanner');
  title.id = 'scan-title';
  const spacer = el('span', 'spacer');
  const pollBtn = el('button', 'btn btn-primary', '▶ Poll');
  pollBtn.type = 'button';
  pollBtn.setAttribute('aria-pressed', 'false');
  head.append(title, spacer, pollBtn);

  const statusRow = el('div', 'status-row');
  const status = el('span', 'status', 'Looking for supported PIDs…');
  status.setAttribute('role', 'status');
  const findBtn = el('button', 'btn btn-quiet', 'Find again');
  findBtn.type = 'button';
  statusRow.append(status, findBtn);

  const table = el('table', 'pid-table');
  const thead = el('thead');
  const hr = el('tr');
  for (const [text, cls] of [['', 'th-check'], ['PID', 'th-pid'], ['Parameter', 'th-name'], ['Value', 'th-val'], ['', 'th-once']] as const) {
    const th = el('th', cls, text);
    th.scope = 'col';
    hr.append(th);
  }
  thead.append(hr);
  const tbody = el('tbody');
  table.append(thead, tbody);
  const tableWrap = el('div', 'table-wrap');
  tableWrap.append(table);

  const rows = new Map<number, Row>();
  for (const def of pids) {
    const tr = el('tr', 'pid-row');
    const check = el('input');
    check.type = 'checkbox';
    check.checked = DEFAULT_ON.includes(def.pid);
    check.setAttribute('aria-label', `Poll ${def.name}`);
    const tdCheck = el('td', 'td-check');
    tdCheck.append(check);

    const name = el('td', 'td-name');
    name.append(el('span', 'pid-name', def.name), el('span', 'pid-formula', def.formula));

    const value = el('span', 'val', '-');
    const tdVal = el('td', 'td-val');
    tdVal.append(value);

    const once = el('button', 'btn btn-icon', '↻');
    once.type = 'button';
    once.title = 'Read once: the request and the response show up in the log';
    once.setAttribute('aria-label', `Read ${def.name} once`);
    const tdOnce = el('td', 'td-once');
    tdOnce.append(once);

    tr.append(tdCheck, el('td', 'td-pid', hex2(def.pid)), name, tdVal, tdOnce);
    tbody.append(tr);
    const row: Row = { def, tr, check, value, once };
    rows.set(def.pid, row);
    once.addEventListener('click', () => void readOnce(row));
  }

  // Vehicle info: responses longer than one frame (ISO-TP)
  const vehicle = el('div', 'vehicle');
  vehicle.append(el('h3', 'sub-title', 'Long responses (ISO-TP)'));
  const vinBtn = el('button', 'btn', 'Read VIN');
  vinBtn.type = 'button';
  vinBtn.title = 'Request 09 02: 20 bytes, sent as First Frame + Consecutive Frames';
  const vinOut = el('output', 'vehicle-out', '-');
  const dtcBtn = el('button', 'btn', 'Read codes');
  dtcBtn.type = 'button';
  dtcBtn.title = 'Request 03: stored trouble codes. Three or more codes take several frames';
  const dtcOut = el('output', 'vehicle-out', '-');
  // mode 04, clear trouble codes
  const clearBtn = el('button', 'btn', 'Clear codes (04)');
  clearBtn.type = 'button';
  clearBtn.title = 'Request 04: forget stored and pending codes and turn the MIL off. The ECU refuses while the engine runs';
  const clearOut = el('output', 'vehicle-out', '-');
  for (const [btn, out] of [[vinBtn, vinOut], [dtcBtn, dtcOut], [clearBtn, clearOut]] as const) {
    out.setAttribute('role', 'status');
    const line = el('div', 'vehicle-line');
    line.append(btn, out);
    vehicle.append(line);
  }

  // Manual request
  const manual = el('form', 'manual');
  manual.noValidate = true;
  const manualLabel = el('label', 'manual-label', 'Your own request (hex)');
  const manualInput = el('input', 'manual-input');
  manualInput.type = 'text';
  manualInput.placeholder = '01 0C';
  manualInput.autocomplete = 'off';
  manualInput.spellcheck = false;
  manualInput.id = 'manual-input';
  manualLabel.htmlFor = manualInput.id;
  const manualBtn = el('button', 'btn', 'Send');
  manualBtn.type = 'submit';
  const manualOut = el('p', 'manual-out');
  manualOut.setAttribute('role', 'status');
  const manualLine = el('div', 'manual-line');
  manualLine.append(manualInput, manualBtn);
  manual.append(manualLabel, manualLine, manualOut);

 root.append(head, statusRow, vehicle, tableWrap, manual); // the long-response buttons sit above the long PID table

  // ---------- Logic ----------
  let alive = true;
  let polling = false;

  const TICK = 'Tick at least one PID.';
  /** The status line without the passing "Tick at least one PID." */
  let baseStatus = status.textContent ?? '';
  const setStatus = (text: string): void => {
    baseStatus = text;
    status.textContent = text;
  };
  const showTick = (): void => {
    status.textContent = TICK;
  };
  const clearTick = (): void => {
    if (status.textContent === TICK) status.textContent = baseStatus;
  };
  for (const r of rows.values()) r.check.addEventListener('change', clearTick);

  const checkedRows = (): Row[] => [...rows.values()].filter((r) => r.check.checked && !r.check.disabled);

  function setValue(row: Row, text: string, state: 'ok' | 'none' | 'error' | 'busy', title = ''): void {
    row.value.textContent = text;
    row.value.className = `val val-${state}`;
    row.value.title = title;
  }

  async function safeRequest(payload: Bytes): Promise<Bytes | null> {
    try {
      return await request(payload);
    } catch {
      return null;
    }
  }

  /** For the buttons: with a real adapter the reason ("Service 04 is blocked", "Listen only") is the answer. */
  async function tryRequest(payload: Bytes): Promise<{ resp: Bytes | null; error?: string }> {
    try {
      return { resp: await request(payload) };
    } catch (err) {
      return { resp: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function readOnce(row: Row): Promise<void> {
    setValue(row, '…', 'busy');
    const { resp, error } = await tryRequest([0x01, row.def.pid]);
    if (!alive) return;
    if (error) {
      // Listen only (or an adapter failure): the request never left, which is not the same as a silent ECU.
      setValue(row, 'not sent', 'error', error);
      setStatus(error);
      return;
    }
    if (!resp) return setValue(row, 'no response', 'none', 'The ECU stayed silent: timeout, or the PID is not supported');
    if (resp[0] === 0x7f) return setValue(row, `refusal ${hex2(resp[2] ?? 0)}`, 'error', hexBytes(resp));
    if (resp[0] !== 0x41 || resp[1] !== row.def.pid) return setValue(row, '?', 'error', `Unexpected response: ${hexBytes(resp)}`);
    try {
      const v = row.def.decode(resp.slice(2, 2 + row.def.length));
      setValue(row, `${formatValue(v)}${row.def.unit ? ' ' + row.def.unit : ''}`, 'ok', hexBytes(resp));
    } catch {
      setValue(row, '?', 'error', `Could not decode: ${hexBytes(resp)}`);
    }
  }

  function setPolling(on: boolean): void {
    polling = on;
    pollBtn.textContent = on ? '■ Stop' : '▶ Poll';
    pollBtn.setAttribute('aria-pressed', String(on));
    pollBtn.classList.toggle('is-on', on);
  }

  async function pollLoop(): Promise<void> {
    while (alive && polling) {
      const batch = checkedRows();
      if (batch.length === 0) {
        setPolling(false);
        showTick();
        return;
      }
      for (const row of batch) {
        if (!alive || !polling) return;
        await readOnce(row);
      }
      await sleep(gap);
    }
  }

  pollBtn.addEventListener('click', () => {
    if (polling) {
      setPolling(false);
      return;
    }
    clearTick();
    if (checkedRows().length === 0) {
      showTick();
      return;
    }
    clearTick();
    setPolling(true);
    void pollLoop();
  });

  let discovering = false;
  async function discover(): Promise<void> {
    if (discovering) return;
    discovering = true;
    findBtn.disabled = true;
    setStatus('Looking for supported PIDs…');
    const supported = new Set<number>();
    let answered = false;
    let base = 0;
    while (alive && base <= 0xc0) {
      const resp = await safeRequest([0x01, base]);
      if (!resp || resp[0] !== 0x41 || resp[1] !== base) break;
      answered = true;
      const list = vocab.decodeSupportedPids ? vocab.decodeSupportedPids(base, resp.slice(2, 6)) : [];
      list.forEach((p) => supported.add(p));
      if (!list.includes(base + 0x20)) break;
      base += 0x20;
    }
    discovering = false;
    findBtn.disabled = false;
    if (!alive) return;

    if (!answered) {
      for (const row of rows.values()) markSupport(row, true);
      setStatus('The ECU did not answer 01 00. All PIDs stay available to try.');
      return;
    }
    let found = 0;
    for (const row of rows.values()) {
      const ok = supported.has(row.def.pid);
      if (ok) found++;
      markSupport(row, ok);
    }
    setStatus(`ECU supports ${found} of ${rows.size} PIDs in this table.`);
  }

  function markSupport(row: Row, ok: boolean): void {
    row.tr.classList.toggle('unsupported', !ok);
    row.check.disabled = !ok;
    row.once.disabled = !ok;
    if (!ok) row.check.checked = false;
    row.tr.title = ok ? '' : 'The ECU did not list this PID in its support bitmasks (01 00, 01 20, ...)';
  }

  findBtn.addEventListener('click', () => void discover());

    /** Shows a result in an output line; red when something went wrong. */
  function showOut(out: HTMLElement, text: string, ok: boolean): void {
    out.textContent = text;
    out.className = ok ? 'vehicle-out' : 'vehicle-out is-error';
  }

  vinBtn.addEventListener('click', () => {
    vinBtn.disabled = true;
    showOut(vinOut, '…', true);
    void tryRequest([0x09, 0x02]).then(({ resp, error }) => {
      vinBtn.disabled = false;
      if (!alive) return;
      if (!resp) return showOut(vinOut, error ?? silent(), false);
      const vin = decodeVinResponse(resp);
      showOut(vinOut, vin ?? `not a VIN: ${hexBytes(resp)}`, vin !== null);
    });
  });

  dtcBtn.addEventListener('click', () => {
    dtcBtn.disabled = true;
    showOut(dtcOut, '…', true);
    void tryRequest([0x03]).then(({ resp, error }) => {
      dtcBtn.disabled = false;
      if (!alive) return;
      if (!resp) return showOut(dtcOut, error ?? silent(), false);
      if (resp[0] !== 0x43) return showOut(dtcOut, `unexpected: ${hexBytes(resp)}`, false);
      const count = resp[1] ?? 0;
      const body = resp.slice(2, 2 + 2 * count);
      if (body.length !== 2 * count) return showOut(dtcOut, `cut off: ${hexBytes(resp)}`, false);
      const codes = decodeDtcList(body);
      showOut(dtcOut, codes.length > 0 ? codes.join(', ') : 'no codes', true);
    });
  });

  function clearCodes(): Promise<string> {
    clearBtn.disabled = true;
    showOut(clearOut, '…', true);
    return tryRequest([0x04]).then(({ resp, error }) => {
      clearBtn.disabled = false;
      if (!alive) return '';
      let text: string;
      let ok = false;
      if (error) text = error;
      else if (!resp) text = silent();
      else if (resp[0] === 0x44) {
        text = 'cleared (44)';
        ok = true;
        showOut(dtcOut, '-', true); // the codes shown above are gone now: read them again
      } else if (resp[0] === 0x7f && resp[2] === 0x22) {
        // rpm is still above 0 for a moment after the key leaves Engine
        text = `refused: ${hexBytes(resp)}, ${opts.ecu && !opts.ecu.engineRunning() ? 'engine still turning, wait a second' : 'stop the engine first'}`;
      } else text = `unexpected: ${hexBytes(resp)}`;
      showOut(clearOut, text, ok);
      return text;
    });
  }
  clearBtn.addEventListener('click', () => void clearCodes());

  manual.addEventListener('submit', (e) => {
    e.preventDefault();
    const parsed = parseHex(manualInput.value);
    if (!parsed.ok) {
      manualOut.className = 'manual-out is-error';
      manualOut.textContent = parsed.error;
      return;
    }
    manualOut.className = 'manual-out';
    manualOut.textContent = 'Waiting for the response…';
    manualBtn.disabled = true;
    void tryRequest(parsed.bytes).then(({ resp, error }) => {
      manualBtn.disabled = false;
      if (!alive) return;
      manualOut.textContent = resp ? `Response: ${hexBytes(resp)}` : (error ?? 'No response (100 ms timeout).');
      manualOut.className = resp ? 'manual-out' : 'manual-out is-error';
    });
  });

  return {
    root,
    discover,
    clearCodes,
    ecuOff() {
      if (!discovering) setStatus('ECU is off (key Off): nothing answers until Ignition.');
    },
    notice(text) {
      if (!discovering) setStatus(text);
    },
    resetOutputs() {
      for (const out of [vinOut, dtcOut, clearOut]) showOut(out, '-', true);
    },
    destroy() {
      alive = false;
      polling = false;
    },
  };
}
