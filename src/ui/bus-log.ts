// Bus log: one row per frame, at most MAX_ROWS rows. Click or Enter selects a frame for the inspector.
import type { CanFrame } from '../core/can/frame';
import { explainFrame, type FrameExplanation, type Vocab } from '../core/obd/explain';
import { el } from './dom';
import { formatTime, hex2, hexId } from './format';
import { MessageTracker, type MessageInfo } from '../core/obd/message-tracker';
import { createLatenessTracker, markLate } from '../core/obd/lateness';

export interface LogEntry {
    seq: number;
    frame: CanFrame;
    ex: FrameExplanation;
    /** Only for frames of a long message (First / Consecutive Frame) */
    message?: MessageInfo;
}

export const MAX_ROWS = 400;

export interface LogEntry {
    seq: number;
    frame: CanFrame;
    ex: FrameExplanation;
    late?: boolean;
}

export interface BusLogOptions {
    vocab: Vocab;
    onSelect(entry: LogEntry): void;
    /** The log was emptied: whatever was selected is gone */
    onClear?(): void;
}

export interface BusLog {
    root: HTMLElement;
    add(frame: CanFrame): void;
    /** A line between frames for something that is not a frame (the ECU went off, came back) */
    mark(text: string): void;
    clear(): void;
    /** How many rows are currently kept (for tests) */
    rowCount(): number;
}

const WHO: Record<FrameExplanation['direction'], { text: string; cls: string }> = {
    request: { text: 'tester', cls: 'who-tester' },
    response: { text: 'ECU', cls: 'who-ecu' },
    other: { text: 'other', cls: 'who-other' },
};

export function createBusLog(opts: BusLogOptions): BusLog {
    const root = el('section', 'panel log-panel');
    root.setAttribute('aria-labelledby', 'log-title');

    const head = el('header', 'panel-head');
    const title = el('h2', 'panel-title', 'Bus log');
    title.id = 'log-title';
    const counter = el('span', 'panel-meta');
    const spacer = el('span', 'spacer');
    const followLabel = el('label', 'check');
    const follow = el('input');
    follow.type = 'checkbox';
    follow.checked = true;
    followLabel.append(follow, el('span', undefined, 'follow new'));
    const clearBtn = el('button', 'btn btn-quiet', 'Clear');
    clearBtn.type = 'button';
    head.append(title, counter, spacer, followLabel, clearBtn);

    const list = el('div', 'log-list');
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'CAN frames in the order they were sent');
    const empty = el('p', 'empty', 'No frames yet. Press ↻ next to any PID or "Poll" and the request and response will show up here.');

    root.append(head, list);
    list.append(empty);

    const entries = new Map<number, LogEntry>();
    const tracker = new MessageTracker(opts.vocab);
    let seq = 0;
    let total = 0;
    let selected: HTMLElement | null = null;
    const lastRow = new Map<number, { entry: LogEntry; row: HTMLElement }>(); // newest frame per response ID
    const lateness = createLatenessTracker();

    const updateCounter = (): void => {
        counter.textContent = total > MAX_ROWS ? `${total} frames, showing the last ${MAX_ROWS}` : `${total} frames`;
    };
    updateCounter();

    const atBottom = (): boolean => list.scrollHeight - list.scrollTop - list.clientHeight < 24;

    function select(row: HTMLElement): void {
        const entry = entries.get(Number(row.dataset.seq));
        if (!entry) return;
        if (selected) {
            selected.classList.remove('selected');
            selected.setAttribute('aria-selected', 'false');
        }
        selected = row;
        row.classList.add('selected');
        row.setAttribute('aria-selected', 'true');
        opts.onSelect(entry);
    }

    function buildRow(entry: LogEntry): HTMLElement {
        const { frame, ex } = entry;
        const row = el('div', entry.late ? 'log-row is-late' : 'log-row');
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', 'false');
        row.tabIndex = 0;
        row.dataset.seq = String(entry.seq);

        const who = WHO[ex.direction];
        row.append(
            el('span', 'c-time', formatTime(frame.t)),
            el('span', `c-who ${who.cls}`, who.text),
            el('span', 'c-id', hexId(frame.id)),
        );

        const bytes = el('span', 'c-bytes');
        for (const b of ex.bytes) bytes.append(el('span', `b role-${b.role}`, hex2(b.value)));
        row.append(bytes, el('span', 'c-desc', ex.summary));
        return row;
    }

    list.addEventListener('click', (e) => {
        const row = (e.target as HTMLElement).closest<HTMLElement>('.log-row');
        if (row) select(row);
    });

    list.addEventListener('keydown', (e) => {
        const row = (e.target as HTMLElement).closest<HTMLElement>('.log-row');
        if (!row) return;
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            select(row);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            let next = (e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling) as HTMLElement | null;
            while (next && !next.classList.contains('log-row')) {
                next = (e.key === 'ArrowDown' ? next.nextElementSibling : next.previousElementSibling) as HTMLElement | null; // skip marks
            }
            if (next) {
                next.focus();
                select(next);
            }
        }
    });

    // Scrolling up turns "follow new" off, scrolling back to the bottom turns it on again.
    list.addEventListener('scroll', () => {
        follow.checked = atBottom();
    });
    follow.addEventListener('change', () => {
        if (follow.checked) list.scrollTop = list.scrollHeight;
    });

    clearBtn.addEventListener('click', () => clear());

    /** A long message that never finished: say so on its last frame, the way a receiver would notice. */
    function flagStalled(): void {
        for (const { id, next } of tracker.stalled()) {
            const last = lastRow.get(id);
            if (!last) continue;
            const cf = next.toString(16).toUpperCase();
            last.entry.ex.summary += ` · incomplete: waiting for CF #${cf}`;
            last.entry.ex.notes.push(
                `The long message stopped here: Consecutive Frame #${cf} never came (the scanner gave up or the ECU went off).`,
            );
            const desc = last.row.querySelector('.c-desc');
            if (desc) desc.textContent = last.entry.ex.summary;
        }
    }

    function mark(text: string): void {
        flagStalled();
        if (empty.isConnected) empty.remove();
        const stick = follow.checked;
        const line = el('div', 'log-mark', text);
        line.setAttribute('role', 'presentation');
        list.append(line);
        if (stick) list.scrollTop = list.scrollHeight;
    }

    function add(frame: CanFrame): void {
        if (empty.isConnected) empty.remove();
        // A new request (Single Frame from the tester) while a long answer is half-received: the old one is abandoned
        if (frame.from === 'tester' && frame.data[0] >> 4 === 0) flagStalled();
        const stick = follow.checked;
        const entry: LogEntry = { seq: seq++, frame, ex: explainFrame(frame, opts.vocab) };
        if (entry.ex.direction !== 'other') entry.message = tracker.annotate(frame, entry.ex);
        const late = lateness.check(frame);
        if (late) {
            markLate(entry.ex, late);
            entry.late = true;
        }
        entries.set(entry.seq, entry);
        const row = buildRow(entry);
        list.append(row);
        if (entry.ex.direction === 'response') lastRow.set(frame.id, { entry, row });
        total++;
        while (list.childElementCount > MAX_ROWS) {
            const first = list.firstElementChild as HTMLElement;
            entries.delete(Number(first.dataset.seq));
            if (first === selected) selected = null;
            for (const [id, v] of lastRow) if (v.row === first) lastRow.delete(id);
            first.remove();
        }
        updateCounter();
        if (stick) list.scrollTop = list.scrollHeight;
    }

    function clear(): void {
        list.replaceChildren(empty);
        entries.clear();
        lastRow.clear();
        tracker.reset();
        selected = null;
        total = 0;
        follow.checked = true;
        updateCounter();
        opts.onClear?.();
    }

    return { root, add, mark, clear, rowCount: () => entries.size };
}
