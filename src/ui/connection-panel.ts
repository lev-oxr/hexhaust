// "Data source" panel: the simulator, or a real car through a CANable adapter (slcan over Web Serial).
// Shows what the adapter reported, the bus status, listen-only and safety switches, and the raw conversation.
import type { SerialLink } from '../transport/serial-link';
import { BITRATES, describeBusStatus, type Bitrate, type BusStatus } from '../transport/slcan';
import type { TraceLine } from '../transport/slcan-bus';
import type { SourceState, SourceSwitch } from '../transport/source';
import { el } from './dom';
import { formatTime } from './format';

export interface ConnectionPanelOptions {
  source: SourceSwitch;
  /** Ask the browser for a serial port and open it. Must run inside the click handler. */
  openLink(): Promise<SerialLink>;
  /** Is Web Serial available here? */
  supported: boolean;
}

export interface ConnectionPanel {
  root: HTMLElement;
  destroy(): void;
}

const MAX_TRACE = 200;

export function createConnectionPanel(opts: ConnectionPanelOptions): ConnectionPanel {
  const { source } = opts;

  const root = el('section', 'panel conn-panel');
  root.setAttribute('aria-labelledby', 'conn-title');

  const head = el('header', 'panel-head');
  const title = el('h2', 'panel-title', 'Data source');
  title.id = 'conn-title';
  const badge = el('span', 'conn-badge');
  head.append(title, el('span', 'spacer'), badge);

  const body = el('div', 'conn-body');

  // --- Connect row ---
  const connectRow = el('div', 'conn-row');
  const rateLabel = el('label', 'conn-rate');
  const rate = el('select');
  rate.id = 'conn-rate';
  for (const r of BITRATES) rate.append(new Option(`${r} kbit/s`, String(r)));
  rateLabel.htmlFor = rate.id;
  rateLabel.append(el('span', undefined, 'Bitrate'), rate);
  const connectBtn = el('button', 'btn btn-primary', 'Connect CAN adapter…');
  connectBtn.type = 'button';
  const disconnectBtn = el('button', 'btn', 'Back to simulator');
  disconnectBtn.type = 'button';
  connectRow.append(rateLabel, el('span', 'spacer'), connectBtn, disconnectBtn);

  const hint = el('p', 'conn-hint');
  const status = el('p', 'conn-status');
  status.setAttribute('role', 'status');

  // --- Adapter facts ---
  const facts = el('dl', 'conn-facts');
  const busLine = el('p', 'conn-bus');
  busLine.setAttribute('role', 'status');

  // --- Switches ---
  const listenLabel = el('label', 'check conn-check');
  const listen = el('input');
  listen.type = 'checkbox';
  listenLabel.append(listen, el('span', undefined, 'Listen only: receive, never send (not even acknowledgements)'));

  const obdLabel = el('label', 'check conn-check');
  const obd = el('input');
  obd.type = 'checkbox';
  obd.checked = source.obdOnly;
  const hiddenCount = el('span', 'conn-count');
  obdLabel.append(obd, el('span', undefined, 'Log only OBD frames (7DF, 7E0–7EF)'), hiddenCount);

  const allowLabel = el('label', 'check conn-check');
  const allow = el('input');
  allow.type = 'checkbox';
  allowLabel.append(allow, el('span', undefined, 'Allow state-changing services (04 clears codes and readiness monitors)'));

  // --- Raw conversation ---
  const details = el('details', 'conn-trace');
  const summary = el('summary', undefined, 'Adapter conversation');
  const traceList = el('ol', 'conn-trace-list');
  traceList.setAttribute('aria-label', 'Commands sent to the adapter and its answers');
  const download = el('button', 'btn btn-quiet', 'Download raw log (.txt)');
  download.type = 'button';
  details.append(summary, traceList, download);

  body.append(connectRow, hint, status, facts, busLine, listenLabel, obdLabel, allowLabel, details);
  root.append(head, body);

  // ---------- Logic ----------
  let busy = false;
  /** Why the last attempt failed before the adapter was reached (picker closed, port busy). */
  let openError = '';

  function fact(name: string, value: string): void {
    facts.append(el('dt', undefined, name), el('dd', undefined, value));
  }

  function showBus(s: BusStatus | null): void {
    if (source.state.kind !== 'can') {
      busLine.hidden = true;
      return;
    }
    busLine.hidden = false;
    const legacy = source.state.info.firmware === 'legacy';
    busLine.textContent = s ? describeBusStatus(s) : legacy ? 'Bus status: not reported by this firmware.' : 'Bus status: no errors reported.';
    busLine.className = s && (s.lastError || s.state !== 'active') ? 'conn-bus is-error' : 'conn-bus';
  }

  function render(s: SourceState): void {
    const real = s.kind === 'can';
    badge.textContent = s.kind === 'sim' ? 'Simulator' : s.kind === 'connecting' ? 'Connecting…' : s.listenOnly ? 'Car · listen only' : 'Car';
    badge.className = `conn-badge is-${s.kind}${real && s.listenOnly ? ' is-listen' : ''}`;
    root.classList.toggle('is-real', real);

    connectBtn.hidden = s.kind !== 'sim';
    connectBtn.disabled = !opts.supported || busy;
    rate.disabled = s.kind !== 'sim' || !opts.supported;
    disconnectBtn.hidden = s.kind === 'sim';

    for (const label of [listenLabel, obdLabel, allowLabel]) label.hidden = !real;
    listen.checked = real && s.listenOnly;
    allow.checked = source.allowStateChanges;
    allow.disabled = real && s.listenOnly;

    facts.replaceChildren();
    facts.hidden = !real;
    if (real) {
      const { info } = s;
      fact('Firmware', info.firmware === 'canable-2.5' ? `CANable 2.5 · ${info.board ?? '?'} · slcan ${info.slcanVersion ?? '?'}` : `legacy slcan · ${info.text}`);
      fact('Bitrate', `${s.bitrate} kbit/s`);
    }
    showBus(source.busStatus);
    updateHidden();

    if (s.kind !== 'sim') openError = '';
    if (s.kind === 'sim') {
      const text = openError || s.note || '';
      status.textContent = text;
      status.className = text ? 'conn-status is-error' : 'conn-status';
    } else if (s.kind === 'connecting') {
      status.className = 'conn-status';
      status.textContent = 'Talking to the adapter…';
    } else {
      status.className = 'conn-status';
      status.textContent = s.listenOnly
        ? 'On the bus, listening. Behind a gateway (VW and most new cars) the OBD port stays silent until someone asks.'
        : 'On the bus. The scanner and the log now show your car.';
    }
  }

  function updateHidden(): void {
    hiddenCount.textContent = source.state.kind === 'can' && source.hidden > 0 ? ` · ${source.hidden} hidden` : '';
  }

  hint.textContent = opts.supported
    ? 'CANable with slcan firmware (SH-C31A: flash Slcan 2.5 first). OBD pins 6 → CAN-H, 14 → CAN-L, 5 → GND, pin 16 not connected. Termination switch off, ignition on.'
    : 'Real adapters need Web Serial: desktop Chrome, Edge or Opera. Firefox, Safari and phones can use the simulator only.';

  connectBtn.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    connectBtn.disabled = true;
    traceList.replaceChildren();
    openError = '';
    status.className = 'conn-status';
    status.textContent = 'Choose the adapter in the browser window…';
    try {
      let link: SerialLink;
      try {
        link = await opts.openLink();
      } catch (err) {
        openError = describeOpenError(err);
        return;
      }
      // Adapter-level failures (no answer to "V"…) come back as the source's note.
      await source.connect(link, { bitrate: Number(rate.value) as Bitrate, listenOnly: false }).catch(() => undefined);
    } finally {
      busy = false;
      render(source.state);
    }
  });

  disconnectBtn.addEventListener('click', () => void source.useSimulator());

  listen.addEventListener('change', () => {
    listen.disabled = true;
    void source
      .setListenOnly(listen.checked)
      .catch((err: unknown) => {
        status.className = 'conn-status is-error';
        status.textContent = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        listen.disabled = false;
        listen.checked = source.state.kind === 'can' && source.state.listenOnly;
      });
  });

  obd.addEventListener('change', () => {
    source.obdOnly = obd.checked;
  });

  allow.addEventListener('change', () => {
    source.allowStateChanges = allow.checked;
  });

  download.addEventListener('click', () => {
    const blob = new Blob([source.rawLog()], { type: 'text/plain' });
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = `hexhaust-slcan-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  function addTrace(l: TraceLine): void {
    if (l.frame) {
      updateHidden(); // frames go to the bus log; here only the count of hidden ones moves
      return;
    }
    const li = el('li', `trace-${l.dir}`);
    li.append(el('span', 'trace-t', formatTime(l.t)), el('span', 'trace-dir', l.dir === 'out' ? '→' : '←'), el('span', 'trace-text', l.text));
    traceList.append(li);
    while (traceList.childElementCount > MAX_TRACE) traceList.firstElementChild?.remove();
    if (details.open) li.scrollIntoView?.({ block: 'nearest' });
  }

  const offState = source.onChange(render);
  const offTrace = source.onTrace(addTrace);
  const offStatus = source.onBusStatus(showBus);
  render(source.state);

  return {
    root,
    destroy() {
      offState();
      offTrace();
      offStatus();
    },
  };
}

/** Errors from requestPort() / port.open() in words a person can act on. */
export function describeOpenError(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  if (name === 'NotFoundError') return 'No port chosen.';
  if (name === 'SecurityError') return 'The browser blocked serial access (the page must be https or localhost).';
  if (name === 'InvalidStateError') return 'That port is already open. Close it in the other tab or app (screen, a terminal…).';
  if (name === 'NetworkError') return 'Could not open the port. Is another app using it?';
  return err instanceof Error ? err.message : String(err);
}
