// Assembles the UI: scanner, bus log and inspector. The core does not need to know about this file.
import '../styles/main.css';
import type { Bytes, CanFrame } from '../core/can/frame';
import type { Vocab } from '../core/obd/explain';
import { parseSupported, getPid } from '../core/obd/pids';
import { createBusLog } from './bus-log';
import { el } from './dom';
import { createInspector } from './inspector';
import { createScannerPanel, type RequestFn } from './scanner-panel';
import { createThemeToggle } from './theme';
import { decodeDtc } from '../core/obd/dtc';
import '../styles/car.css';                       // next to main.css
import { MONITOR_STATUS_INFO, MONITOR_STATUS_PID } from '../core/obd/monitor-status';
import type { Car } from '../core/vehicle/car';
import { createCarPanel } from './car-panel';

export interface AppDeps {
  /** Virtual bus: subscribing to frames is all the UI needs */
  bus: { subscribe(listener: (frame: CanFrame) => void): () => void };
  /** Send an OBD request and wait for the response (null means timeout) */
  car?: Car;
  request: RequestFn;
}

/** Dictionary for frame breakdowns: PIDs from pids.ts, trouble codes from dtc.ts. */
export const vocab: Vocab = { getPid, decodeSupportedPids: parseSupported, decodeDtc };

/**
 * The log also explains 41 01 … (MIL and code count). The scanner table keeps the plain pids.ts list:
 * PID 01 is not a "number with units", so it is read by hand: 01 01 in "Your own request".
 */
const logVocab: Vocab = {
  ...vocab,
  getPid: (pid) => (pid === MONITOR_STATUS_PID ? MONITOR_STATUS_INFO : vocab.getPid(pid)),
};

export interface App {
  destroy(): void;
}

export function mountApp(root: HTMLElement, deps: AppDeps): App {
  const header = el('header', 'app-head');
  const brand = el('div', 'brand');
  brand.append(el('h1', 'brand-name', 'Hexhaust'), el('p', 'brand-sub', 'OBD sandbox: see every byte between the scanner and the engine ECU'));
  header.append(brand, createThemeToggle());

  const inspector = createInspector();
  const log = createBusLog({
    vocab: logVocab,
    onSelect(entry) {
      inspector.show(entry);
      // On a narrow screen the inspector sits below the log: scroll it into view
      const narrow = typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 900px)').matches;
      if (narrow) inspector.root.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    },
  });
  const scanner = createScannerPanel({ vocab, request: (p: Bytes) => deps.request(p) });

  const main = el('main', 'layout');
  const side = el('div', 'col col-side');
  const carPanel = deps.car ? createCarPanel(deps.car) : null;
  if (carPanel) side.append(carPanel.root);
  side.append(scanner.root);
  const wide = el('div', 'col col-main');
  wide.append(log.root, inspector.root);
  main.append(side, wide);

  root.replaceChildren(header, main);

  const unsubscribe = deps.bus.subscribe((f) => log.add(f));
  void scanner.discover();
  // the ECU comes back on the bus when the key leaves "Off": look for its PIDs again,
  // the way a real scanner reconnects.
  let wasPowered = deps.car?.powered ?? true;
  const unsubscribeCar = deps.car?.subscribe((car) => {
    if (car.powered && !wasPowered) void scanner.discover();
    wasPowered = car.powered;
  });

  return {
    destroy() {
      unsubscribe();
      scanner.destroy();
      carPanel?.destroy();
      unsubscribeCar?.();
    },
  };
}
