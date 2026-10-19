import { VirtualBus } from './core/can/bus';
import { createSystemClock } from './core/clock';
import { Scanner } from './core/scanner/scanner';
import { attachEcu } from './core/vehicle/ecu';
import { createStubState } from './core/vehicle/model';
import { SimTransport } from './transport/sim';
import { mountApp } from './ui/app';

const clock = createSystemClock();
const bus = new VirtualBus(clock);

const state = createStubState();
attachEcu(bus, clock, () => state);

const scanner = new Scanner(new SimTransport(bus, clock));

mountApp(document.querySelector<HTMLDivElement>('#app')!, {
  bus,
  request: (payload) => scanner.request(payload),
});