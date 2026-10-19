// @vitest-environment jsdom
// UI smoke test: needs `npm i -D jsdom`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bytes, CanFrame } from '../src/core/can/frame';
import { mountApp, type App } from '../src/ui/app';
import { MAX_ROWS } from '../src/ui/bus-log';
import { PID_COUNT } from './helpers/fake-vocab';

vi.mock('../src/core/obd/pids', async () => {
  const m = await import('./helpers/fake-vocab');
  return {
    getPid: m.getPid,
    parseSupported: m.decodeSupportedPids,
    decodeSupportedPids: m.decodeSupportedPids,
  };
});

type Listener = (f: CanFrame) => void;

function makeBus() {
  const listeners = new Set<Listener>();
  return {
    subscribe(l: Listener) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    emit(f: CanFrame) {
      for (const l of [...listeners]) l(f);
    },
    size: () => listeners.size,
  };
}

const RPM: CanFrame = { id: 0x7e8, data: [0x04, 0x41, 0x0c, 0x1a, 0xf8, 0x55, 0x55, 0x55], t: 24.9, from: 'ecu' };
const REQ: CanFrame = { id: 0x7df, data: [0x02, 0x01, 0x0c, 0x55, 0x55, 0x55, 0x55, 0x55], t: 19.4, from: 'tester' };

// The ECU supports PIDs 04, 05, 0C, 0D (the 01 00 mask also points to 01 20, which is empty)
const fakeRequest = vi.fn(async (p: Bytes): Promise<Bytes | null> => {
  if (p[0] === 0x01 && p[1] === 0x00) return [0x41, 0x00, 0x18, 0x18, 0x00, 0x01];
  if (p[0] === 0x01 && p[1] === 0x20) return [0x41, 0x20, 0x00, 0x00, 0x00, 0x00];
  if (p[0] === 0x01 && p[1] === 0x0c) return [0x41, 0x0c, 0x1a, 0xf8];
  if (p[0] === 0x01 && p[1] === 0x0d) return [0x41, 0x0d, 0x3c];
  return null;
});

let root: HTMLElement;
let bus: ReturnType<typeof makeBus>;
let app: App;

beforeEach(async () => {
  fakeRequest.mockClear();
  document.body.innerHTML = '<div id="app"></div>';
  document.documentElement.removeAttribute('data-theme');
  root = document.getElementById('app') as HTMLElement;
  bus = makeBus();
  app = mountApp(root, { bus, request: fakeRequest });
  await vi.waitFor(() => expect(root.querySelector('.status')?.textContent).toContain(`4 of ${PID_COUNT}`));
});

afterEach(() => app.destroy());

describe('mounting', () => {
  it('renders the scanner, log and inspector and subscribes to the bus', () => {
    expect(root.querySelector('.scanner-panel')).not.toBeNull();
    expect(root.querySelector('.log-panel')).not.toBeNull();
    expect(root.querySelector('.inspector')).not.toBeNull();
    expect(bus.size()).toBe(1);
  });

  it('destroy unsubscribes from the bus', () => {
    app.destroy();
    expect(bus.size()).toBe(0);
  });
});

describe('scanner', () => {
  it('finds supported PIDs: the rest are disabled', () => {
    const rows = [...root.querySelectorAll<HTMLElement>('.pid-row')];
    expect(rows).toHaveLength(PID_COUNT);
    const off = rows.filter((r) => r.classList.contains('unsupported')).map((r) => r.querySelector('.td-pid')?.textContent);
    expect(off).toEqual(['0F', '11', '2F']);
    expect(rows.find((r) => r.querySelector('.td-pid')?.textContent === '0F')?.querySelector<HTMLInputElement>('input')?.disabled).toBe(true);
  });

  it('PIDs 0C and 0D are ticked by default', () => {
    const checked = [...root.querySelectorAll<HTMLInputElement>('.pid-row input:checked')].map((c) => c.closest('tr')?.querySelector('.td-pid')?.textContent);
    expect(checked).toEqual(['0C', '0D']);
  });

  it('↻ reads once and shows the value', async () => {
    const row = [...root.querySelectorAll<HTMLElement>('.pid-row')].find((r) => r.querySelector('.td-pid')?.textContent === '0C') as HTMLElement;
    row.querySelector<HTMLButtonElement>('.btn-icon')?.click();
    await vi.waitFor(() => expect(row.querySelector('.val')?.textContent).toBe('1726 rpm'));
    expect(fakeRequest).toHaveBeenCalledWith([0x01, 0x0c]);
  });

  it('a PID without a response shows "no response"', async () => {
    const row = [...root.querySelectorAll<HTMLElement>('.pid-row')].find((r) => r.querySelector('.td-pid')?.textContent === '04') as HTMLElement;
    row.querySelector<HTMLButtonElement>('.btn-icon')?.click();
    await vi.waitFor(() => expect(row.querySelector('.val')?.textContent).toBe('no response'));
  });

  it('polling cycles through the ticked PIDs and then stops', async () => {
    const btn = root.querySelector<HTMLButtonElement>('.btn-primary') as HTMLButtonElement;
    btn.click();
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    await vi.waitFor(() => {
      expect(fakeRequest).toHaveBeenCalledWith([0x01, 0x0c]);
      expect(fakeRequest).toHaveBeenCalledWith([0x01, 0x0d]);
    });
    btn.click();
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('manual request: input error and a response', async () => {
    const input = root.querySelector<HTMLInputElement>('.manual-input') as HTMLInputElement;
    const form = root.querySelector<HTMLFormElement>('.manual') as HTMLFormElement;
    const out = root.querySelector('.manual-out') as HTMLElement;

    input.value = 'zz';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(out.textContent).toContain('zz');
    expect(out.classList.contains('is-error')).toBe(true);

    input.value = '01 0D';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(out.textContent).toBe('Response: 41 0D 3C'));
  });
});

describe('bus log', () => {
  it('adds a row per frame with time, sender, ID, bytes and a summary', () => {
    bus.emit(REQ);
    bus.emit(RPM);
    const rows = root.querySelectorAll('.log-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector('.c-who')?.textContent).toBe('tester');
    expect(rows[1]?.querySelector('.c-who')?.textContent).toBe('ECU');
    expect(rows[1]?.querySelector('.c-time')?.textContent).toBe('24.9 ms');
    expect(rows[1]?.querySelector('.c-id')?.textContent).toBe('7E8');
    expect(rows[1]?.querySelectorAll('.b')).toHaveLength(8);
    expect(rows[1]?.querySelector('.c-desc')?.textContent).toBe('response: Engine speed = 1726 rpm');
    expect(root.querySelector('.log-list .empty')).toBeNull();
  });

  it(`keeps at most ${MAX_ROWS} rows`, () => {
    for (let i = 0; i < MAX_ROWS + 50; i++) bus.emit({ ...RPM, t: i });
    expect(root.querySelectorAll('.log-row')).toHaveLength(MAX_ROWS);
    expect(root.querySelector('.log-panel .panel-meta')?.textContent).toContain(`${MAX_ROWS + 50} frames`);
    // the oldest rows were dropped: the first row now has t = 50
    expect(root.querySelector('.log-row .c-time')?.textContent).toBe('50.0 ms');
  });

  it('"Clear" brings back the empty state', () => {
    bus.emit(RPM);
    (root.querySelector('.log-panel .btn-quiet') as HTMLButtonElement).click();
    expect(root.querySelectorAll('.log-row')).toHaveLength(0);
    expect(root.querySelector('.log-list .empty')).not.toBeNull();
  });
});

describe('inspector', () => {
  it('shows a hint at start', () => {
    expect(root.querySelector('.inspector .empty')).not.toBeNull();
  });

  it('clicking a row shows the byte breakdown and the calculation', () => {
    bus.emit(RPM);
    (root.querySelector('.log-row') as HTMLElement).click();
    expect(root.querySelector('.log-row')?.getAttribute('aria-selected')).toBe('true');
    expect(root.querySelectorAll('.strip-cell')).toHaveLength(8);
    expect(root.querySelectorAll('.byte-item')).toHaveLength(8);
    const calc = [...root.querySelectorAll('.calc-v')].map((n) => n.textContent);
    expect(calc).toEqual(['(256 × A + B) / 4', '(256 × 26 + 248) / 4', '1726 rpm']);
    expect(root.querySelector('.inspector .panel-meta')?.textContent).toContain('ECU → tester');
  });

  it('a request has no calculation block; Enter selects too', () => {
    bus.emit(REQ);
    const row = root.querySelector('.log-row') as HTMLElement;
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(root.querySelector('.calc')).toBeNull();
    expect(root.querySelector('.inspector .panel-meta')?.textContent).toContain('tester → ECU');
  });

  it('arrow keys move to the neighbouring frame', () => {
    bus.emit(REQ);
    bus.emit(RPM);
    const rows = root.querySelectorAll<HTMLElement>('.log-row');
    (rows[0] as HTMLElement).click();
    (rows[0] as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(rows[1]?.getAttribute('aria-selected')).toBe('true');
    expect(rows[0]?.getAttribute('aria-selected')).toBe('false');
  });

  it('characters from the bus never become markup', () => {
    // A CF whose bytes read as <b>
    bus.emit({ id: 0x7e8, data: [0x21, 0x3c, 0x62, 0x3e, 0x3c, 0x69, 0x3e, 0x55], t: 1, from: 'ecu' });
    (root.querySelector('.log-row') as HTMLElement).click();
    expect(root.querySelector('.inspector b')).toBeNull();
    expect(root.querySelector('.inspector i')).toBeNull();
  });
});

describe('theme', () => {
  it('the button cycles auto -> light -> dark -> auto and sets data-theme', () => {
    const btn = root.querySelector<HTMLButtonElement>('.theme-btn') as HTMLButtonElement;
    expect(btn.textContent).toContain('auto');
    btn.click();
    expect(document.documentElement.dataset.theme).toBe('light');
    btn.click();
    expect(document.documentElement.dataset.theme).toBe('dark');
    btn.click();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});
