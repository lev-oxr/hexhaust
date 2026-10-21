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

export interface AppDeps {
  /** Virtual bus: subscribing to frames is all the UI needs */
  bus: { subscribe(listener: (frame: CanFrame) => void): () => void };
  /** Send an OBD request and wait for the response (null means timeout) */
  request: RequestFn;
}

/** Dictionary for frame breakdowns: PIDs from pids.ts, trouble codes from dtc.ts. */
export const vocab: Vocab = { getPid, decodeSupportedPids: parseSupported, decodeDtc };

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
    vocab,
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
  side.append(scanner.root);
  const wide = el('div', 'col col-main');
  wide.append(log.root, inspector.root);
  main.append(side, wide);

  root.replaceChildren(header, main);

  const unsubscribe = deps.bus.subscribe((f) => log.add(f));
  void scanner.discover();

  return {
    destroy() {
      unsubscribe();
      scanner.destroy();
    },
  };
}
