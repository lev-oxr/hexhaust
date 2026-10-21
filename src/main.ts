import { VirtualBus } from './core/can/bus';
import { createSystemClock } from './core/clock';
import { Scanner } from './core/scanner/scanner';
import { Car } from './core/vehicle/car';
import { attachEcu } from './core/vehicle/ecu';
import { createEcuLink } from './core/vehicle/ecu-link';
import { createStubState } from './core/vehicle/model';
import { SimTransport } from './transport/sim';
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

const scanner = new Scanner(new SimTransport(bus, clock));

mountApp(document.querySelector<HTMLDivElement>('#app')!, {
  bus,
  request: (payload) => scanner.request(payload),
  car,
});