/**
 * Minimal ZIP writer: "store" method only (no compression), no dependencies.
 * Writes local file headers, a central directory and the end-of-central-directory record,
 * with real CRC-32s and UTF-8 file names (general purpose flag bit 11). Runs in the browser,
 * workers and Node. No ZIP64: fewer than 65,535 entries and less than 4 GB in total.
 */

export interface ZipEntry { path: string; data: Uint8Array | string }

let crcTable: Uint32Array | null = null;

/** CRC-32 (IEEE 802.3, the one ZIP/PNG/gzip use). `crc32("123456789") === 0xCBF43926`. */
export function crc32(data: Uint8Array | string): number {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS time/date words (2 s resolution, years 1980–2107). UTC fields keep the output reproducible. */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, d.getUTCFullYear()));
  const clamped = year !== d.getUTCFullYear();
  const month = clamped ? 1 : d.getUTCMonth() + 1;
  const day = clamped ? 1 : d.getUTCDate();
  const time = clamped ? 0 : (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  return { time, date: ((year - 1980) << 9) | (month << 5) | day };
}

/** Forward slashes, no leading slash, no `.`/`..`/empty segments. */
function cleanPath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
  if (!parts.length || parts.includes('..')) throw new Error(`zip: bad path "${path}"`);
  return parts.join('/');
}

/**
 * Pack files into an uncompressed ZIP archive. Paths use `/`; folders are implied by the paths
 * (no separate directory entries). A path that appears twice keeps its last content.
 */
export function zipStore(files: ZipEntry[], date: Date = new Date()): Uint8Array {
  const enc = new TextEncoder();
  const byPath = new Map<string, Uint8Array>();
  for (const f of files) byPath.set(cleanPath(f.path), typeof f.data === 'string' ? enc.encode(f.data) : f.data);
  const entries = [...byPath].map(([path, data]) => ({ name: enc.encode(path), data, crc: crc32(data), offset: 0 }));
  if (entries.length > 0xfffe) throw new Error('zip: too many files');

  let size = 22;
  for (const e of entries) {
    if (e.name.length > 0xffff) throw new Error('zip: file name too long');
    size += 30 + e.name.length + e.data.length + 46 + e.name.length;
  }
  if (size > 0xfffffffe) throw new Error('zip: archive too large');

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  const { time, date: day } = dosDateTime(date);
  const FLAGS = 0x0800;        // bit 11: names are UTF-8
  const VERSION_NEEDED = 20;   // 2.0
  let p = 0;

  for (const e of entries) {
    e.offset = p;
    view.setUint32(p, 0x04034b50, true);
    view.setUint16(p + 4, VERSION_NEEDED, true);
    view.setUint16(p + 6, FLAGS, true);
    view.setUint16(p + 8, 0, true);            // method: stored
    view.setUint16(p + 10, time, true);
    view.setUint16(p + 12, day, true);
    view.setUint32(p + 14, e.crc, true);
    view.setUint32(p + 18, e.data.length, true);
    view.setUint32(p + 22, e.data.length, true);
    view.setUint16(p + 26, e.name.length, true);
    view.setUint16(p + 28, 0, true);           // extra field length
    out.set(e.name, p + 30);
    out.set(e.data, p + 30 + e.name.length);
    p += 30 + e.name.length + e.data.length;
  }

  const cdStart = p;
  for (const e of entries) {
    view.setUint32(p, 0x02014b50, true);
    view.setUint16(p + 4, (3 << 8) | 20, true); // made by: Unix, spec 2.0 (so the mode below is honoured)
    view.setUint16(p + 6, VERSION_NEEDED, true);
    view.setUint16(p + 8, FLAGS, true);
    view.setUint16(p + 10, 0, true);
    view.setUint16(p + 12, time, true);
    view.setUint16(p + 14, day, true);
    view.setUint32(p + 16, e.crc, true);
    view.setUint32(p + 20, e.data.length, true);
    view.setUint32(p + 24, e.data.length, true);
    view.setUint16(p + 28, e.name.length, true);
    view.setUint16(p + 30, 0, true);           // extra
    view.setUint16(p + 32, 0, true);           // comment
    view.setUint16(p + 34, 0, true);           // disk number
    view.setUint16(p + 36, 0, true);           // internal attributes
    view.setUint32(p + 38, (0o100644 << 16) >>> 0, true); // regular file, rw-r--r--
    view.setUint32(p + 42, e.offset, true);
    out.set(e.name, p + 46);
    p += 46 + e.name.length;
  }

  const cdSize = p - cdStart;
  view.setUint32(p, 0x06054b50, true);
  view.setUint16(p + 4, 0, true);
  view.setUint16(p + 6, 0, true);
  view.setUint16(p + 8, entries.length, true);
  view.setUint16(p + 10, entries.length, true);
  view.setUint32(p + 12, cdSize, true);
  view.setUint32(p + 16, cdStart, true);
  view.setUint16(p + 20, 0, true);             // comment length
  return out;
}
