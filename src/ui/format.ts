// Small formatting helpers for the UI. No DOM, so they are easy to test.
import type { Bytes } from '../core/can/frame';

export const hex2 = (n: number): string => (n & 0xff).toString(16).toUpperCase().padStart(2, '0');
export const hexId = (id: number): string => id.toString(16).toUpperCase().padStart(3, '0');
export const hexBytes = (b: Bytes): string => b.map(hex2).join(' ');

/** 19.4 -> "19.4 ms", 12345 -> "12.35 s" */
export function formatTime(ms: number): string {
  if (!Number.isFinite(ms)) return '-';
  if (ms >= 10000) return `${(ms / 1000).toFixed(2)} s`;
  return `${ms.toFixed(1)} ms`;
}

export type ParsedHex = { ok: true; bytes: Bytes } | { ok: false; error: string };

/**
 * Parses a manual request: "01 0C", "010C", "0x01, 0x0C".
 * A single frame (Single Frame) holds 1 to 7 bytes.
 */
export function parseHex(text: string): ParsedHex {
  const cleaned = text.replace(/0x/gi, ' ').replace(/[\s,;:-]+/g, ' ').trim();
  if (cleaned === '') return { ok: false, error: 'Enter bytes, for example 01 0C.' };
  let tokens = cleaned.split(' ');
  if (tokens.length === 1 && (tokens[0] ?? '').length > 2) {
    tokens = (tokens[0] ?? '').match(/.{1,2}/g) ?? [];
  }
  const bytes: Bytes = [];
  for (const t of tokens) {
    if (!/^[0-9a-f]{1,2}$/i.test(t)) return { ok: false, error: `"${t}" is not a hex byte (00-FF).` };
    bytes.push(parseInt(t, 16));
  }
  if (bytes.length > 7) return { ok: false, error: 'One frame holds up to 7 request bytes.' };
  return { ok: true, bytes };
}
