/**
 * Minimal sfnt (OpenType/TrueType) surgery: add or replace whole tables in a
 * built font. Used for tables opentype.js cannot write (GPOS kerning) or that
 * are simpler to emit as bytes (COLR, CPAL). Rebuilds the table directory,
 * 4-byte padding, per-table checksums and head.checkSumAdjustment.
 */

export interface SfntTable { tag: string; data: Uint8Array }

export function readTables(font: ArrayBuffer | Uint8Array): { version: number; tables: SfntTable[] } {
  const u8 = font instanceof Uint8Array ? font : new Uint8Array(font);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const version = dv.getUint32(0);
  const n = dv.getUint16(4);
  const tables: SfntTable[] = [];
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    const tag = String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
    const offset = dv.getUint32(o + 8), length = dv.getUint32(o + 12);
    tables.push({ tag, data: u8.slice(offset, offset + length) });
  }
  return { version, tables };
}

export function tableChecksum(data: Uint8Array): number {
  let sum = 0;
  const n = Math.ceil(data.length / 4) * 4;
  for (let i = 0; i < n; i += 4) {
    const v = ((data[i] ?? 0) << 24) | ((data[i + 1] ?? 0) << 16) | ((data[i + 2] ?? 0) << 8) | (data[i + 3] ?? 0);
    sum = (sum + (v >>> 0)) >>> 0;
  }
  return sum;
}

export function writeTables(version: number, tables: SfntTable[]): ArrayBuffer {
  const sorted = [...tables].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const n = sorted.length;
  const headerLen = 12 + n * 16;
  let total = headerLen;
  for (const t of sorted) total += Math.ceil(t.data.length / 4) * 4;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, version);
  dv.setUint16(4, n);
  const maxPow = Math.floor(Math.log2(Math.max(1, n)));
  dv.setUint16(6, (1 << maxPow) * 16);
  dv.setUint16(8, maxPow);
  dv.setUint16(10, n * 16 - (1 << maxPow) * 16);
  let offset = headerLen;
  let headOffset = -1;
  sorted.forEach((t, i) => {
    const o = 12 + i * 16;
    for (let k = 0; k < 4; k++) out[o + k] = t.tag.charCodeAt(k);
    let data = t.data;
    if (t.tag === 'head') { data = data.slice(); data[8] = data[9] = data[10] = data[11] = 0; headOffset = offset; }
    out.set(data, offset);
    dv.setUint32(o + 4, tableChecksum(data));
    dv.setUint32(o + 8, offset);
    dv.setUint32(o + 12, data.length);
    offset += Math.ceil(data.length / 4) * 4;
  });
  if (headOffset >= 0) dv.setUint32(headOffset + 8, (0xb1b0afba - tableChecksum(out)) >>> 0);
  return out.buffer;
}

/** Add or replace tables (4-character tags) in a font; `null` removes a table. */
export function injectTables(font: ArrayBuffer | Uint8Array, add: Record<string, Uint8Array | null>): ArrayBuffer {
  const { version, tables } = readTables(font);
  const map = new Map(tables.map((t) => [t.tag, t.data]));
  for (const [tag, data] of Object.entries(add)) {
    if (tag.length !== 4) throw new Error(`bad table tag "${tag}"`);
    if (data) map.set(tag, data); else map.delete(tag);
  }
  return writeTables(version, [...map].map(([tag, data]) => ({ tag, data })));
}
