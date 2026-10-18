// Basic types for bytes and frames.
// Step 2 only needs Bytes and a few helpers; CanFrame is added in step 3.
 
/** An array of bytes; every element is an integer 0–255. */
export type Bytes = number[];
 
/** Formats one byte or an array of bytes as 'XX' or 'XX XX XX'. */
export function hex(value: number | Bytes): string {
  const bytes = typeof value === 'number' ? [value] : value;
  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}
 
/** Parses '41 0C 1A F8' or '410C1AF8' into an array of bytes. */
export function fromHex(text: string): Bytes {
  const clean = text.replace(/\s+/g, '');
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error(`Invalid hex string: "${text}"`);
  }
  const bytes: Bytes = [];
  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(parseInt(clean.slice(i, i + 2), 16));
  }
  return bytes;
}
 
/** True if n is an integer 0–255. */
export function isByte(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= 0xff;
}