import { VirtualBus } from './core/can/bus';
import { formatFrame, hex } from './core/can/frame';
import { createSystemClock } from './core/clock';
import { Scanner } from './core/scanner/scanner';
import { attachEcu } from './core/vehicle/ecu';
import { createStubState } from './core/vehicle/model';
import { SimTransport } from './transport/sim';

const clock = createSystemClock();
const bus = new VirtualBus(clock);

// Temporary "bus log": just another subscriber. Remove this line and nothing breaks.
bus.subscribe((frame) => console.log(formatFrame(frame)));

const state = createStubState();
attachEcu(bus, clock, () => state);

const scanner = new Scanner(new SimTransport(bus, clock));

async function demo(): Promise<void> {
  console.log('— Which PIDs does the ECU support?');
  const supported = await scanner.readSupportedPids();
  console.log('ECU supports:', supported.map((p) => hex(p)).join(' '));

  console.log('— Engine RPM');
  const rpm = await scanner.readPid(0x0c);
  console.log(rpm ? `RPM: ${rpm.value} ${rpm.unit}` : 'RPM: no response');

  console.log('— Unsupported PID 0A: the ECU stays silent, the scanner waits 100 ms');
  const silent = await scanner.request([0x01, 0x0a]);
  console.log(silent ? hex(silent) : 'No response (timeout)');

  console.log('— Unknown service 22 as a physical request to 7E0');
  const negative = await scanner.request([0x22, 0xf1, 0x90], { physical: true });
  console.log(negative ? `Negative response: ${hex(negative)} (11 = service not supported)` : 'No response');
}

void demo();

// So the page isn't blank. typeof — because this file can also run in Node.
if (typeof document !== 'undefined') {
  document.querySelector('#app')!.textContent = 'Result in the console (F12 → Console).';
}