// Minibar: the things you watch while working further down the page (MIL, codes, ECU) and Clear codes.
// Sticks to the top of the window, because on a laptop screen the scanner sits below the Car panel.
import type { Car } from '../core/vehicle/car';
import { el } from './dom';

export interface Minibar {
  root: HTMLElement;
  /** Forget the last Clear codes result (a different data source) */
  reset(): void;
  destroy(): void;
}

/** @param clear sends mode 04 through the scanner and resolves to the text to show */
export function createMinibar(car: Car, clear: () => Promise<string>): Minibar {
  const root = el('div', 'minibar');
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Quick status');

  const mil = el('span', 'mini-item');
  const codes = el('span', 'mini-item');
  const ecu = el('span', 'mini-item');
  const btn = el('button', 'btn', 'Clear codes (04)');
  btn.type = 'button';
  const out = el('span', 'mini-out');
  out.setAttribute('role', 'status');
  root.append(mil, codes, ecu, btn, out);

  btn.addEventListener('click', () => {
    btn.disabled = true;
    void clear().then((text) => {
      btn.disabled = false;
      out.textContent = text;
    });
  });

  const setText = (node: HTMLElement, text: string): void => {
    if (node.textContent !== text) node.textContent = text;
  };
  let situation = '';
  function render(): void {
    const s = car.state;
    // "refused: engine still running" is wrong the moment the engine stops or the codes are gone
    const now = `${car.running}|${s.milOn}|${s.storedDtcs.join()}|${s.pendingDtcs.join()}`;
    if (now !== situation && !btn.disabled) out.textContent = '';
    situation = now;
    const parts = [
      s.storedDtcs.length > 0 ? `stored ${s.storedDtcs.join(', ')}` : '',
      s.pendingDtcs.length > 0 ? `pending ${s.pendingDtcs.join(', ')}` : '',
    ].filter(Boolean);
    setText(mil, `MIL ${s.milOn ? 'on' : 'off'}`);
    mil.classList.toggle('is-on', s.milOn);
    setText(codes, parts.length > 0 ? parts.join(' · ') : 'no codes');
    setText(ecu, `ECU ${car.powered ? 'on' : 'off'}`);
    ecu.classList.toggle('is-off', !car.powered);
  }
  const unsubscribe = car.subscribe(render);
  render();

  return { root, reset: () => void (out.textContent = ''), destroy: unsubscribe };
}
