// Byte-by-byte explanation of a CAN frame: a short summary for the log and a full
// breakdown for the inspector. Pure logic, no DOM. The PID dictionary is passed in
// (Vocab), so this module does not depend on how pids.ts is laid out.
import type { Bytes, CanFrame } from '../can/frame';

export type ByteRole = 'pci' | 'service' | 'pid' | 'data' | 'pad' | 'error';
export type Direction = 'request' | 'response' | 'other';

export interface ByteInfo {
  index: number;
  value: number;
  role: ByteRole;
  /** Short label under the byte: PCI, mode, PID, A, B, - */
  short: string;
  /** Full explanation for the inspector */
  text: string;
}

export interface Calc {
  formula: string;
  substituted: string;
  result: string;
}

export interface FrameExplanation {
  direction: Direction;
  idText: string;
  /** One line for the log */
  summary: string;
  bytes: ByteInfo[];
  calc: Calc | null;
  notes: string[];
}

/** What explain.ts needs from a PID table entry. PidDef from pids.ts satisfies it. */
export interface PidInfo {
  pid: number;
  name: string;
  unit: string;
  length: number;
  formula: string;
  decode(data: Bytes): number;
  /** Text for the result when "value unit" is not enough (01 01: "MIL on, 3 code(s)") */
  show?(data: Bytes): string;
}

export interface Vocab {
  getPid(pid: number): PidInfo | undefined;
  /** Supported-PID bitmask: base 0x00 -> PIDs 01..20 */
  decodeSupportedPids?(base: number, data: Bytes): number[];
  /** Trouble code from two bytes: [0x03, 0x00] -> 'P0300' (stage 5) */
  decodeDtc?(a: number, b: number): string;
}

const h2 = (n: number): string => (n & 0xff).toString(16).toUpperCase().padStart(2, '0');
const h3 = (n: number): string => n.toString(16).toUpperCase().padStart(3, '0');

export function formatValue(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return String(Math.round(n * 100) / 100);
}

const MODE_NAMES: Record<number, string> = {
  0x01: 'current data',
  0x02: 'freeze frame data',
  0x03: 'stored trouble codes',
  0x04: 'clear codes and freeze frames',
  0x07: 'pending trouble codes',
  0x09: 'vehicle information',
  0x0a: 'permanent trouble codes',
};

const MODE9_PIDS: Record<number, string> = {
  0x00: 'supported PIDs of mode 09',
  0x02: 'VIN (vehicle identification number)',
  0x04: 'calibration ID',
  0x06: 'calibration verification number',
  0x0a: 'ECU name',
};
const MODE9_ASCII = new Set([0x02, 0x04, 0x0a]);

// Negative response codes
const NRC: Record<number, string> = {
  0x10: 'general reject',
  0x11: 'service not supported',
  0x12: 'sub-function not supported',
  0x13: 'incorrect message length or format',
  0x22: 'conditions not correct',
  0x31: 'request out of range (no such PID)',
  0x78: 'response pending (the ECU is still working on it)',
};

const LETTERS = ['A', 'B', 'C', 'D'];

export function modeName(mode: number): string {
  return MODE_NAMES[mode] ?? 'unknown mode';
}

export function directionOf(id: number): Direction {
  if (id === 0x7df || (id >= 0x7e0 && id <= 0x7e7)) return 'request';
  if (id >= 0x7e8 && id <= 0x7ef) return 'response';
  return 'other';
}

export function describeId(id: number): string {
  if (id === 0x7df) return `${h3(id)} - broadcast request: every ECU hears it`;
  if (id >= 0x7e0 && id <= 0x7e7) return `${h3(id)} - request to ECU #${id - 0x7e0 + 1} (physical)`;
  if (id >= 0x7e8 && id <= 0x7ef) return `${h3(id)} - response from ECU #${id - 0x7e8 + 1}`;
  return `${h3(id)} - outside the OBD-II range (7DF, 7E0-7E7, 7E8-7EF)`;
}

function stMinText(v: number): string {
  if (v <= 0x7f) return `${v} ms`;
  if (v >= 0xf1 && v <= 0xf9) return `${(v - 0xf0) * 100} µs`;
  return 'reserved';
}

function maskRange(base: number): string {
  return `${h2(base + 1)}-${h2(base + 0x20)}`;
}

function bin8(n: number): string {
  return (n & 0xff).toString(2).padStart(8, '0');
}

/** '(256 × A + B) / 4' with A=26, B=248 -> '(256 × 26 + 248) / 4' */
function substitute(formula: string, values: number[]): string {
  return formula.replace(/\b([A-D])\b/g, (m, l: string) => {
    const v = values[LETTERS.indexOf(l)];
    return v === undefined ? m : String(v);
  });
}

export function explainFrame(frame: Pick<CanFrame, 'id' | 'data'>, vocab: Vocab): FrameExplanation {
  const { id, data } = frame;
  const direction = directionOf(id);
  const notes: string[] = [];
  const slots: (ByteInfo | undefined)[] = new Array<ByteInfo | undefined>(data.length).fill(undefined);
  const val = (i: number): number => data[i] ?? 0;
  const put = (index: number, role: ByteRole, short: string, text: string): void => {
    if (index >= 0 && index < data.length) slots[index] = { index, value: val(index), role, short, text };
  };

  let summary = '';
  let calc: Calc | null = null;
  // Indices of payload bytes (after the PCI); no request parsing for CF and FC frames.
  const payload: number[] = [];
  let padFrom = data.length;

  const pciType = val(0) >> 4;
  switch (pciType) {
    case 0x0: {
      let len = val(0) & 0x0f;
      if (len < 1 || len > 7) {
        notes.push(`Length ${len} is impossible for a Single Frame: allowed 1-7 bytes.`);
      }
      len = Math.max(0, Math.min(len, data.length - 1));
      put(0, 'pci', 'PCI', `Single Frame (high nibble 0): the whole message fits in this frame. Low nibble ${val(0) & 0x0f} is the number of payload bytes that follow.`);
      for (let i = 1; i <= len; i++) payload.push(i);
      padFrom = 1 + len;
      break;
    }
    case 0x1: {
      const total = ((val(0) & 0x0f) << 8) | val(1);
      put(0, 'pci', 'PCI', 'First Frame (high nibble 1): the message is too long for one frame. This is the first of several; Consecutive Frames follow.');
      put(1, 'pci', 'len', `Total message length: ${total} bytes. Together with the low nibble of the first byte it forms a 12-bit number.`);
      for (let i = 2; i < data.length; i++) payload.push(i);
      summary = `First Frame · ${total} bytes`;
      break;
    }
    case 0x2: {
      const seq = val(0) & 0x0f;
      put(0, 'pci', 'PCI', `Consecutive Frame (high nibble 2): continuation of a long message. Low nibble ${seq} is the sequence number, counted in a circle 1..F, 0, 1..`);
      for (let i = 1; i < data.length; i++) {
        put(i, 'data', 'data', 'Continuation of the message. Without the earlier frames the meaning of this byte is unknown; whoever reassembles the message decodes it (stage 5).');
      }
      summary = `Consecutive Frame #${seq}`;
      break;
    }
    case 0x3: {
      const fs = val(0) & 0x0f;
      const fsText = fs === 0 ? 'CTS: keep sending' : fs === 1 ? 'WAIT: hold on' : fs === 2 ? 'OVFLW: buffer overflow, the message will not fit' : 'unknown status';
      put(0, 'pci', 'PCI', `Flow Control (high nibble 3): the receiver tells the sender how to send Consecutive Frames. Low nibble ${fs} - ${fsText}.`);
      put(1, 'pci', 'BS', `Block Size = ${val(1)}: how many Consecutive Frames may be sent in a row before waiting for another Flow Control. 0 means no limit.`);
      put(2, 'pci', 'STmin', `STmin = ${stMinText(val(2))}: minimum gap between Consecutive Frames.`);
      padFrom = 3;
      summary = `Flow Control · ${fsText}`;
      break;
    }
    default: {
      put(0, 'pci', 'PCI', `Unknown PCI type (high nibble ${pciType}). ISO-TP only has 0-3.`);
      notes.push('The first byte does not look like an ISO-TP PCI: this is not an OBD frame or it is corrupted.');
      for (let i = 1; i < data.length; i++) put(i, 'data', 'data', 'Unknown data.');
      summary = 'Unknown frame';
    }
  }

  // ----- Payload: service, PID, data -----
  if (payload.length > 0) {
    const sIdx = payload[0] ?? 0;
    const s = val(sIdx);
    const rest = payload.slice(1);
    const isResp = direction === 'response';

    if (!isResp) {
      put(sIdx, 'service', 'mode', `Mode (service) ${h2(s)}: ${modeName(s)}.`);
      let pidInfo: PidInfo | undefined;
      let pidCode: number | undefined;
      if (s === 0x01) {
        // On CAN one request may ask for up to six PIDs.
        for (const i of rest) {
          const code = val(i);
          const def = vocab.getPid(code);
          put(i, 'pid', 'PID', `PID ${h2(code)}: ${pidName(code, def, s)}.`);
          if (pidCode === undefined) {
            pidCode = code;
            pidInfo = def;
          }
        }
      } else if (s === 0x02 || s === 0x09) {
        const i = rest[0];
        if (i !== undefined) {
          pidCode = val(i);
          pidInfo = s === 0x02 ? vocab.getPid(pidCode) : undefined;
          put(i, 'pid', 'PID', `PID ${h2(pidCode)}: ${pidName(pidCode, pidInfo, s)}.`);
        }
        const j = rest[1];
        if (j !== undefined) put(j, 'data', 'frame #', `Freeze frame number ${h2(val(j))}.`);
        for (const k of rest.slice(2)) put(k, 'data', 'data', 'Extra data after the request.');
      } else {
        for (const i of rest) put(i, 'data', 'data', 'Additional request data.');
      }
      if (pciType === 0x0) {
        summary = pidCode !== undefined ? `request ${h2(s)} ${h2(pidCode)} · ${pidName(pidCode, pidInfo, s)}` : `request ${h2(s)} · ${modeName(s)}`;
      }
    } else if (s === 0x7f) {
      put(sIdx, 'error', '7F', 'Byte 7F marks a negative response: the ECU understood the request but refused it.');
      const reqIdx = rest[0];
      const nrcIdx = rest[1];
      if (reqIdx !== undefined) put(reqIdx, 'service', 'mode', `Requested mode ${h2(val(reqIdx))}: ${modeName(val(reqIdx))}. This is the request the ECU refused.`);
      if (nrcIdx !== undefined) put(nrcIdx, 'error', 'code', `Reason code ${h2(val(nrcIdx))}: ${NRC[val(nrcIdx)] ?? 'unknown code'}.`);
      for (const i of rest.slice(2)) put(i, 'data', 'data', 'Extra data.');
      if (pciType === 0x0) {
        summary = `refusal: mode ${reqIdx !== undefined ? h2(val(reqIdx)) : '??'} · ${nrcIdx !== undefined ? (NRC[val(nrcIdx)] ?? `code ${h2(val(nrcIdx))}`) : 'no code'}`;
      }
    } else {
      const mode = s - 0x40;
      const known = MODE_NAMES[mode] !== undefined;
      put(
        sIdx,
        'service',
        'mode',
        known
          ? `Positive response: ${h2(mode)} + 40 = ${h2(s)}. Mode ${h2(mode)}: ${modeName(mode)}.`
          : `${h2(s)} does not look like a response to a known mode (it should be mode + 40).`,
      );
      if (!known) notes.push(`Service byte ${h2(s)} does not match any mode of this simulator.`);
      const res = explainResponseBody(mode, rest, pciType === 0x0);
      if (res.summary && pciType === 0x0) summary = res.summary;
      if (res.calc) calc = res.calc;
      if (pciType === 0x1 && res.summary) summary = `First Frame · ${((val(0) & 0x0f) << 8) | val(1)} bytes · ${res.summary}`;
    }
  }

  // ----- Padding -----
  for (let i = padFrom; i < data.length; i++) {
    if (slots[i] === undefined) {
      put(i, 'pad', '-', `Padding (${h2(val(i))}): a CAN frame here is always 8 bytes, unused space is filled. The value does not matter.`);
    }
  }

  const bytes: ByteInfo[] = slots.map((b, i) => b ?? { index: i, value: val(i), role: 'data', short: 'data', text: 'Byte without an explanation.' });
  if (!summary) summary = direction === 'other' ? 'frame outside OBD-II' : 'frame';

  return { direction, idText: describeId(id), summary, bytes, calc, notes };

  // ===== local helpers =====

  function pidName(code: number, def: PidInfo | undefined, mode: number): string {
    if (mode === 0x09) return MODE9_PIDS[code] ?? 'unknown mode 09 PID';
    if (code % 0x20 === 0) return `supported PIDs ${maskRange(code)}`;
    return def ? def.name : 'unknown PID';
  }

  function explainResponseBody(mode: number, rest: number[], single: boolean): { summary: string; calc: Calc | null } {
    const out = { summary: '', calc: null as Calc | null };
    if (mode === 0x01 || mode === 0x02) {
      const pIdx = rest[0];
      if (pIdx === undefined) return out;
      const code = val(pIdx);
      const def = vocab.getPid(code);
      put(pIdx, 'pid', 'PID', `PID ${h2(code)}: ${pidName(code, def, mode)}. The ECU repeats the PID from the request so the answer can be matched to it.`);
      let dataIdx = rest.slice(1);
      if (mode === 0x02 && dataIdx[0] !== undefined) {
        put(dataIdx[0], 'data', 'frame #', `Freeze frame number ${h2(val(dataIdx[0]))}.`);
        dataIdx = dataIdx.slice(1);
      }
      const isMask = code % 0x20 === 0;
      const need = isMask ? 4 : def ? def.length : dataIdx.length;
      const used = dataIdx.slice(0, need);
      const extra = dataIdx.slice(need);
      used.forEach((i, k) => {
        const letter = LETTERS[k] ?? '?';
        put(
          i,
          'data',
          letter,
          isMask
            ? `Bits ${letter}: PIDs ${h2(code + 8 * k + 1)}-${h2(code + 8 * k + 8)}. Each bit is one PID, the most significant bit is the lowest PID.`
            : `${letter} = ${val(i)} (0x${h2(val(i))}, binary ${bin8(val(i))}). PID data, see the formula below.`,
        );
      });
      for (const i of extra) put(i, 'data', 'data', 'Extra data after the PID value.');
      if (!single) return out;
      if (isMask) {
        out.summary = `response: supported PIDs ${maskRange(code)}`;
        if (used.length === 4 && vocab.decodeSupportedPids) {
          const vals = used.map(val);
          const list = vocab.decodeSupportedPids(code, vals);
          out.calc = {
            formula: 'bit = 1 -> PID is supported',
            substituted: vals.map(bin8).join(' '),
            result: list.length > 0 ? list.map(h2).join(', ') : 'no PIDs',
          };
        }
      } else if (def && used.length >= def.length) {
        const vals = used.map(val);
        const value = def.decode(vals);
        const shown = def.show ? def.show(vals) : `${formatValue(value)}${def.unit ? ' ' + def.unit : ''}`;
        out.summary = `response: ${def.name} = ${shown}`;
        out.calc = { formula: def.formula, substituted: substitute(def.formula, vals), result: shown };
      } else if (def) {
        out.summary = `response: ${def.name} (missing bytes)`;
        notes.push(`PID ${h2(code)} needs ${def.length} data byte(s), the frame has ${used.length}.`);
      } else {
        out.summary = `response to PID ${h2(code)}`;
      }
      return out;
    }

    if (mode === 0x03 || mode === 0x07 || mode === 0x0a) {
      const nIdx = rest[0];
      if (nIdx === undefined) return out;
      const count = val(nIdx);
      put(nIdx, 'data', 'N', `Number of trouble codes: ${count}. CAN adds this byte; classic OBD does not have it.`);
      const body = rest.slice(1);
      for (let k = 0; k < body.length; k += 2) {
        const a = body[k];
        const b = body[k + 1];
        if (a === undefined) break;
        if (b !== undefined) {
          const code = vocab.decodeDtc ? vocab.decodeDtc(val(a), val(b)) : `${h2(val(a))} ${h2(val(b))}`;
          put(a, 'data', 'DTC', `Trouble code ${code}: first of two bytes (${h2(val(a))}).`);
          put(b, 'data', 'DTC', `Trouble code ${code}: second of two bytes (${h2(val(b))}).`);
        } else {
          put(a, 'data', 'DTC', `First byte of a trouble code (${h2(val(a))}); the second arrives in the next frame.`);
        }
      }
      if (single) out.summary = `response: ${count === 0 ? 'no codes' : `${count} trouble code(s)`} · ${modeName(mode)}`;
      return out;
    }

    if (mode === 0x04) {
      for (const i of rest) put(i, 'data', 'data', 'Extra data.');
      if (single) out.summary = 'response: codes cleared';
      return out;
    }

    if (mode === 0x09) {
      const pIdx = rest[0];
      if (pIdx === undefined) return out;
      const code = val(pIdx);
      put(pIdx, 'pid', 'PID', `PID ${h2(code)}: ${pidName(code, undefined, 0x09)}.`);
      const body = rest.slice(1);
      if (code === 0x00) {
        body.slice(0, 4).forEach((i, k) => {
          const letter = LETTERS[k] ?? '?';
          put(i, 'data', letter, `Bits ${letter}: mode 09 PIDs ${h2(8 * k + 1)}-${h2(8 * k + 8)}. Each bit is one PID, the most significant bit is the lowest PID.`);
        });
        for (const i of body.slice(4)) put(i, 'data', 'data', 'Extra data.');
        if (single && body.length >= 4 && vocab.decodeSupportedPids) {
          const vals = body.slice(0, 4).map(val);
          const list = vocab.decodeSupportedPids(0x00, vals);
          out.calc = {
            formula: 'bit = 1 -> mode 09 PID is supported',
            substituted: vals.map(bin8).join(' '),
            result: list.length > 0 ? list.map((p) => `${h2(p)} ${MODE9_PIDS[p] ?? ''}`.trim()).join(', ') : 'no PIDs',
          };
        }
      } else if (MODE9_ASCII.has(code)) {
        body.forEach((i, k) => {
          if (k === 0) {
            put(i, 'data', 'N', `Number of data items: ${val(i)}. For a VIN this is 1.`);
          } else {
            const ch = val(i);
            const printable = ch >= 0x20 && ch < 0x7f;
            put(i, 'data', printable ? String.fromCharCode(ch) : '·', `ASCII character ${printable ? `"${String.fromCharCode(ch)}"` : '(not printable)'} (0x${h2(ch)}). Part of the text in the response.`);
          }
        });
      } else {
        for (const i of body) put(i, 'data', 'data', 'Response data.');
      }
      out.summary = single ? `response: ${MODE9_PIDS[code] ?? `PID ${h2(code)}`}` : (MODE9_PIDS[code] ?? `mode 09 PID ${h2(code)}`);
      return out;
    }

    for (const i of rest) put(i, 'data', 'data', 'Response data.');
    out.summary = `response of mode ${h2(mode)}`;
    return out;
  }
}

/**
 * One line about a whole message, once ISO-TP has glued its frames together.
 * 49 02 01 '1G1…'   -> 'VIN 1G1JC5444R7252367'
 * 43 03 03 00 …     -> '3 stored trouble code(s): P0300, P0420, P0171'
 */
export function summarizeMessage(payload: Bytes, vocab: Vocab): string {
  const [sid = 0, second = 0] = payload;
  if (sid === 0x49 && (second === 0x02 || second === 0x04 || second === 0x0a)) {
    const text = String.fromCharCode(...payload.slice(3).filter((c) => c >= 0x20 && c < 0x7f));
    const what = second === 0x02 ? 'VIN' : (MODE9_PIDS[second] ?? 'text');
    return `${what} ${text}`;
  }
  if (sid === 0x43 || sid === 0x47 || sid === 0x4a) {
    const codes: string[] = [];
    for (let i = 2; i + 1 < payload.length && codes.length < second; i += 2) {
      const a = payload[i] ?? 0;
      const b = payload[i + 1] ?? 0;
      codes.push(vocab.decodeDtc ? vocab.decodeDtc(a, b) : `${h2(a)} ${h2(b)}`);
    }
    const kind = sid === 0x43 ? 'stored' : sid === 0x47 ? 'pending' : 'permanent';
    return `${second} ${kind} trouble code(s): ${codes.join(', ')}`;
  }
  return `${payload.length} bytes: ${payload.slice(0, 8).map(h2).join(' ')}${payload.length > 8 ? ' …' : ''}`;
}