// Inspector: byte-by-byte breakdown of the selected frame and the formula with the numbers filled in.
import { el } from './dom';
import { formatTime, hex2 } from './format';
import type { LogEntry } from './bus-log';

export interface Inspector {
    root: HTMLElement;
    show(entry: LogEntry | null): void;
}

const DIR_TEXT = { request: 'tester → ECU', response: 'ECU → tester', other: 'another module on the bus' } as const;

export function createInspector(): Inspector {
    const root = el('section', 'panel inspector');
    root.setAttribute('aria-labelledby', 'insp-title');
    const head = el('header', 'panel-head');
    const title = el('h2', 'panel-title', 'Frame breakdown');
    title.id = 'insp-title';
    const meta = el('span', 'panel-meta');
    head.append(title, meta);
    const body = el('div', 'insp-body');
    body.setAttribute('aria-live', 'polite');
    root.append(head, body);

    function renderEmpty(): void {
        meta.textContent = '';
        const p = el(
            'p',
            'empty',
            'Click a row in the log and every byte is explained here: what it is, why it is there and how the number comes out of it.',
        );
        body.replaceChildren(p);
    }

    function show(entry: LogEntry | null): void {
        if (!entry) return renderEmpty();
        const { frame, ex } = entry;
        meta.textContent = `frame #${entry.seq + 1} · ${formatTime(frame.t)} · ${DIR_TEXT[ex.direction]}`;

        const idLine = el('p', 'insp-id');
        idLine.append(el('span', 'tag', 'CAN ID'), document.createTextNode(' ' + ex.idText));

        // Strip of byte cells
        const strip = el('div', 'strip');
        for (const b of ex.bytes) {
            const cell = el('div', `strip-cell role-${b.role}`);
            cell.title = b.text;
            cell.append(el('span', 'strip-hex', hex2(b.value)), el('span', 'strip-short', b.short));
            strip.append(cell);
        }

        // Per-byte explanations
        const list = el('ol', 'byte-list');
        for (const b of ex.bytes) {
            const li = el('li', `byte-item role-${b.role}`);
            li.append(el('span', 'bi-idx', `byte ${b.index}`), el('span', 'bi-hex', hex2(b.value)), el('span', 'bi-text', b.text));
            list.append(li);
        }

        const parts: HTMLElement[] = [idLine, strip, list];

        if (ex.calc) {
            const calc = el('div', 'calc');
            calc.append(el('h3', 'calc-title', 'How the bytes become a value'));
            const rows: [string, string][] = [
                ['formula', ex.calc.formula],
                ['with numbers', ex.calc.substituted],
                ['result', ex.calc.result],
            ];
            for (const [k, v] of rows) {
                const r = el('div', k === 'result' ? 'calc-row calc-result' : 'calc-row');
                r.append(el('span', 'calc-k', k), el('code', 'calc-v', v));
                calc.append(r);
            }
            parts.push(calc);
        }

        // Frames of a long message: where this frame stands and what the whole message says
        if (entry.message) {
            const msg = el('div', 'calc msg');
            msg.append(el('h3', 'calc-title', 'Long message (ISO-TP)'));
            for (const [k, v] of entry.message.rows) {
                const r = el('div', k === 'meaning' ? 'calc-row calc-result' : 'calc-row');
                r.append(el('span', 'calc-k', k), el('code', 'calc-v', v));
                msg.append(r);
            }
            parts.push(msg);
        }

        if (ex.notes.length > 0) {
            const notes = el('ul', 'notes');
            for (const n of ex.notes) notes.append(el('li', undefined, n));
            parts.push(notes);
        }

        body.replaceChildren(...parts);
    }

    renderEmpty();
    return { root, show };
}
