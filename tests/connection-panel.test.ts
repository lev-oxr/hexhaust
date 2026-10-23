// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualBus } from '../src/core/can/bus';
import { createSystemClock, type Clock } from '../src/core/clock';
import { Scanner } from '../src/core/scanner/scanner';
import { Car } from '../src/core/vehicle/car';
import { attachEcu } from '../src/core/vehicle/ecu';
import { createStubState } from '../src/core/vehicle/model';
import { SimTransport } from '../src/transport/sim';
import { SourceSwitch } from '../src/transport/source';
import { mountApp, type App } from '../src/ui/app';
import { createConnectionPanel, describeOpenError, type ConnectionPanel } from '../src/ui/connection-panel';
import { FakeCanable, type FakeCanableOptions } from './helpers/fake-canable';

let clock: Clock;
let simBus: VirtualBus;
let source: SourceSwitch;
let panel: ConnectionPanel | null = null;
let app: App | null = null;

const q = <T extends Element>(sel: string, root: ParentNode = document): T => root.querySelector<T>(sel)!;
const button = (text: string): HTMLButtonElement => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!;
const checkbox = (text: string): HTMLInputElement =>
  [...document.querySelectorAll('label')].find((l) => l.textContent?.includes(text))!.querySelector('input')!;

beforeEach(() => {
  vi.useFakeTimers();
  clock = createSystemClock();
  simBus = new VirtualBus(clock);
  attachEcu(simBus, clock, () => createStubState());
  source = new SourceSwitch({ clock, simBus, simTransport: new SimTransport(simBus, clock) });
  document.body.innerHTML = '';
});

afterEach(() => {
  panel?.destroy();
  app?.destroy();
  panel = null;
  app = null;
  vi.useRealTimers();
});

function mount(fake: (() => Promise<FakeCanable>) | FakeCanableOptions = {}, supported = true): void {
  const openLink = typeof fake === 'function' ? fake : async () => new FakeCanable(clock, fake);
  panel = createConnectionPanel({ source, openLink, supported });
  document.body.append(panel.root);
}

describe('connection panel', () => {
  it('starts on the simulator, 500 kbit/s selected', () => {
    mount();
    expect(q('.conn-badge').textContent).toBe('Simulator');
    expect(q<HTMLSelectElement>('#conn-rate').value).toBe('500');
    expect(button('Back to simulator').hidden).toBe(true);
    expect(checkbox('Listen only').closest('label')!.hidden).toBe(true);
  });

  it('without Web Serial the button is disabled and the hint says which browsers work', () => {
    mount({}, false);
    expect(button('Connect CAN adapter').disabled).toBe(true);
    expect(q('.conn-hint').textContent).toMatch(/Chrome/);
  });

  it('connect: firmware, bitrate, bus status, switches, conversation', async () => {
    mount();
    q<HTMLSelectElement>('#conn-rate').value = '250';
    button('Connect CAN adapter').click();
    await vi.advanceTimersByTimeAsync(3000);

    expect(q('.conn-badge').textContent).toBe('Car');
    expect(q('.conn-facts').textContent).toContain('CANable 2.5 · Multiboard · slcan 105');
    expect(q('.conn-facts').textContent).toContain('250 kbit/s');
    expect(q('.conn-bus').textContent).toBe('Bus status: no errors reported.');
    expect(checkbox('Listen only').checked).toBe(false);
    expect(checkbox('Log only OBD frames').checked).toBe(true);
    expect(q('.conn-trace-list').textContent).toContain('S5');
    expect(q('.conn-trace-list').textContent).not.toContain('t7DF'); // frames go to the bus log, not here
  });

  it('QA: the panel is folded on the simulator and opens when a car is connected', async () => {
    mount();
    expect(q<HTMLDetailsElement>('.conn-fold').open).toBe(false);
    button('Connect CAN adapter').click();
    await vi.advanceTimersByTimeAsync(3000);
    expect(q<HTMLDetailsElement>('.conn-fold').open).toBe(true);
    expect([...document.querySelectorAll<HTMLElement>('.conn-note')].filter((n) => !n.hidden).map((n) => n.textContent).join(' ')).toMatch(/04 erases/);
  });

  it('QA BUG-5: the keyboard focus moves to Back to simulator when Connect disappears, and back', async () => {
    mount();
    button('Connect CAN adapter').focus();
    button('Connect CAN adapter').click();
    await vi.advanceTimersByTimeAsync(3000);
    expect(document.activeElement).toBe(button('Back to simulator'));
    button('Back to simulator').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.activeElement).toBe(button('Connect CAN adapter'));
  });

  it('QA BUG-5: Listen only keeps the focus after the adapter reopens', async () => {
    mount();
    button('Connect CAN adapter').click();
    await vi.advanceTimersByTimeAsync(3000);
    const listen = checkbox('Listen only');
    listen.focus();
    listen.click();
    await vi.advanceTimersByTimeAsync(3000);
    expect(document.activeElement).toBe(listen);
  });

  it('QA BUG-7: unplugging while connecting ends with the same message as unplugging later', async () => {
    const fake = new FakeCanable(clock);
    mount(async () => fake);
    button('Connect CAN adapter').click();
    await vi.advanceTimersByTimeAsync(10);
    fake.unplug();
    await vi.advanceTimersByTimeAsync(3000);
    expect(source.state).toEqual({ kind: 'sim', note: 'The adapter disconnected. Back on the simulator.' });
  });

  it('QA BUG-7: unplugging during a request ends it at once, not after the timeout', async () => {
    const fake = new FakeCanable(clock);
    mount(async () => fake);
    button('Connect CAN adapter').click();
    await vi.advanceTimersByTimeAsync(3000);
    const pending = source.transport.request([0x09, 0x02], { timeoutMs: 5000 });
    let done = false;
    void pending.then(() => (done = true));
    fake.unplug();
    await vi.advanceTimersByTimeAsync(50);
    expect(done).toBe(true);
  });

  it('listen only: the badge says so and the adapter reopens silent', async () => {
    const fake = new FakeCanable(clock);
    mount(async () => fake);
    button('Connect CAN adapter').click();
    await vi.advanceTimersByTimeAsync(3000);

    checkbox('Listen only').click();
    await vi.advanceTimersByTimeAsync(3000);
    expect(fake.silent).toBe(true);
    expect(q('.conn-badge').textContent).toBe('Car · listen only');
    expect(checkbox('Allow state-changing').disabled).toBe(true);
  });

  it('no car: the bus line turns red and says what "no ACK" usually means', async () => {
    mount({ noCar: true });
    button('Connect CAN adapter').click();
    await vi.advanceTimersByTimeAsync(3000);
    void source.transport.request([0x01, 0x0c]);
    await vi.advanceTimersByTimeAsync(200);
    expect(q('.conn-bus').className).toContain('is-error');
    expect(q('.conn-bus').textContent).toMatch(/ignition off, or CAN-H/);
  });

  it('the switches reach the source', async () => {
    mount();
    button('Connect CAN adapter').click();
    await vi.advanceTimersByTimeAsync(3000);
    checkbox('Allow state-changing').click();
    checkbox('Log only OBD frames').click();
    expect(source.allowStateChanges).toBe(true);
    expect(source.obdOnly).toBe(false);

    button('Back to simulator').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(source.allowStateChanges).toBe(false);
    expect(q('.conn-badge').textContent).toBe('Simulator');
  });

  it('the picker closed: a calm message, still on the simulator', async () => {
    mount(async () => {
      throw Object.assign(new Error('No port selected by the user.'), { name: 'NotFoundError' });
    });
    button('Connect CAN adapter').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(q('.conn-status').textContent).toBe('No port chosen.');
    expect(source.state.kind).toBe('sim');
  });

  it('not an slcan adapter: the reason stays on screen', async () => {
    mount({ dead: true });
    button('Connect CAN adapter').click();
    await vi.advanceTimersByTimeAsync(3000);
    expect(q('.conn-status').textContent).toMatch(/slcan firmware/);
    expect(q('.conn-status').className).toContain('is-error');
  });

  it('adapter text never becomes markup', async () => {
    const fake = new FakeCanable(clock, { dead: true });
    mount(async () => fake);
    button('Connect CAN adapter').click();
    fake.emit('<img src=x onerror=alert(1)>\r');
    await vi.advanceTimersByTimeAsync(3000);
    expect(document.querySelector('img')).toBeNull();
  });

  it.each([
    ['NotFoundError', /No port/],
    ['InvalidStateError', /already open/],
    ['NetworkError', /another app/],
    ['SecurityError', /https/],
  ])('describeOpenError: %s', (name, re) => {
    expect(describeOpenError(Object.assign(new Error('x'), { name }))).toMatch(re);
  });
});

describe('the whole app with a real car', () => {
  it('hides the simulated car, marks the log, finds the PIDs of the car behind the adapter', async () => {
    document.body.innerHTML = '<div id="app"></div>';
    const car = new Car(clock, createStubState(), { ambientC: 18, key: 'ignition' });
    const scanner = new Scanner(source.transport);
    app = mountApp(document.getElementById('app')!, {
      bus: source.frames,
      request: (p) => scanner.request(p),
      car,
      source,
      serialSupported: true,
      openLink: async () => new FakeCanable(clock),
    });
    await vi.advanceTimersByTimeAsync(1000);
    const carPanel = q<HTMLElement>('.car-panel');
    expect(carPanel.hidden).toBe(false);

    button('Connect CAN adapter').click();
    await vi.advanceTimersByTimeAsync(3000);
    expect(carPanel.hidden).toBe(true);
    expect(q<HTMLElement>('.minibar').hidden).toBe(true);
    expect(q('.log-list').textContent).toContain('Source: car through the CAN adapter, 500 kbit/s');
    expect(q('.scanner-panel .status').textContent).toMatch(/ECU supports/);

    // Codes blocked on a real car: the reason shows, not "no response"
    button('Clear codes').click();
    await vi.advanceTimersByTimeAsync(100);
    expect(document.body.textContent).toMatch(/Service 04 can change the car's state/);

    button('Back to simulator').click();
    await vi.advanceTimersByTimeAsync(1000);
    expect(carPanel.hidden).toBe(false);
    expect(q('.log-list').textContent).toContain('Source: simulator');
  });
});
