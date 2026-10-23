import { VirtualBus } from './core/can/bus';
import { createSystemClock } from './core/clock';
import { Scanner } from './core/scanner/scanner';
import { Car } from './core/vehicle/car';
import { attachEcu } from './core/vehicle/ecu';
import { createEcuLink } from './core/vehicle/ecu-link';
import { createStubState } from './core/vehicle/model';
import { isWebSerialSupported, openWebSerial, requestSerialPort } from './transport/serial-link';
import { SimTransport } from './transport/sim';
import { SourceSwitch } from './transport/source';
import { mountApp } from './ui/app';

const clock = createSystemClock();
const bus = new VirtualBus(clock);

// Stage 6: a live car instead of the fixed stub. The stub only lends the fixed facts (VIN, fuel level).
const car = new Car(clock, createStubState(), { ambientC: 18, key: 'ignition' });
// The ECU's wire to the bus: dead with the key off, late with the "slow ECU" protocol fault
const ecuLink = createEcuLink(bus, clock, {
  powered: () => car.powered,
  extraDelayMs: () => car.ecuExtraDelayMs,
});
attachEcu(ecuLink, clock, () => car.state, { onClearDtcs: () => car.clearDtcs() });
car.start();

// Stage 7: the scanner talks to source.transport, the log listens to source.frames.
// Connect a CAN adapter and both switch to the real car; the same ISO-TP code runs over the real bus.
const source = new SourceSwitch({ clock, simBus: bus, simTransport: new SimTransport(bus, clock) });
const scanner = new Scanner(source.transport);

mountApp(document.querySelector<HTMLDivElement>('#app')!, {
  bus: source.frames,
  request: (payload) => scanner.request(payload),
  car,
  source,
  serialSupported: isWebSerialSupported(),
  openLink: async () => openWebSerial(await requestSerialPort()),
});
