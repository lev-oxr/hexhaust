// Needle gauge (tachometer, speedometer) drawn in SVG. role="meter" so screen readers get the value.
import { el } from './dom';

export interface GaugeOptions {
  label: string;
  unit: string;
  max: number;
  /** Distance between numbered ticks */
  majorStep: number;
  /** Where the red zone starts (tachometer) */
  redFrom?: number;
  /** Tick numbers: 7000 -> "7" on a tachometer */
  tickLabel?: (v: number) => string;
}

export interface Gauge {
  root: HTMLElement;
  /** null: the instrument is dead (key off) */
  set(value: number | null): void;
}

const NS = 'http://www.w3.org/2000/svg';
const CX = 60;
const CY = 58;
const R = 46;
const SWEEP = 120; // degrees each side of straight up

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** Point on a circle; angle in degrees, 0 = straight up, clockwise. */
function at(deg: number, r: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [CX + r * Math.sin(a), CY - r * Math.cos(a)];
}

function arc(from: number, to: number, r: number): string {
  const [x1, y1] = at(from, r);
  const [x2, y2] = at(to, r);
  const large = to - from > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

export function createGauge(o: GaugeOptions): Gauge {
  const angleOf = (v: number): number => -SWEEP + (Math.min(Math.max(v, 0), o.max) / o.max) * 2 * SWEEP;

  const root = el('div', 'gauge');
  root.setAttribute('role', 'meter');
  root.setAttribute('aria-label', o.label);
  root.setAttribute('aria-valuemin', '0');
  root.setAttribute('aria-valuemax', String(o.max));

  const pic = svg('svg', { viewBox: '0 0 120 100', class: 'gauge-svg', 'aria-hidden': 'true' });
  pic.append(svg('path', { d: arc(-SWEEP, SWEEP, R), class: 'g-track' }));
  if (o.redFrom !== undefined) pic.append(svg('path', { d: arc(angleOf(o.redFrom), SWEEP, R), class: 'g-red' }));

  const nums: SVGTextElement[] = []; // drawn after the needle, so the needle passes under the numbers
  for (let v = 0; v <= o.max; v += o.majorStep) {
    const a = angleOf(v);
    const [x1, y1] = at(a, R - 1);
    const [x2, y2] = at(a, R - 7);
    pic.append(svg('line', { x1, y1, x2, y2, class: 'g-tick' }));
    const [tx, ty] = at(a, R - 15);
    const t = svg('text', { x: tx.toFixed(1), y: (ty + 3).toFixed(1), class: 'g-num' });
    t.textContent = o.tickLabel ? o.tickLabel(v) : String(v);
    nums.push(t);
  }

  const needle = svg('line', { x1: CX, y1: CY + 6, x2: CX, y2: CY - R + 8, class: 'g-needle' });
  pic.append(needle, svg('circle', { cx: CX, cy: CY, r: 4, class: 'g-hub' }), ...nums);

  const value = svg('text', { x: CX, y: 88, class: 'g-value' });
  const unit = svg('text', { x: CX, y: 98, class: 'g-unit' });
  unit.textContent = o.unit;
  pic.append(value, unit);

  root.append(pic, el('span', 'gauge-label', o.label));

  let last: string | null = '';
  function set(v: number | null): void {
    const shown = v === null ? '-' : String(Math.round(v));
    if (shown === last) return;
    last = shown;
    value.textContent = shown;
    needle.setAttribute('transform', `rotate(${angleOf(v ?? 0).toFixed(1)} ${CX} ${CY})`);
    root.classList.toggle('is-dead', v === null);
    root.setAttribute('aria-valuenow', String(v === null ? 0 : Math.round(v)));
    root.setAttribute('aria-valuetext', v === null ? 'off' : `${shown} ${o.unit}`);
  }
  set(null);
  return { root, set };
}