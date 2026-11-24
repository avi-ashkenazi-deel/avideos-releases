/**
 * Binary GPOS table with a single `kern` feature: pair adjustment (lookup
 * type 2) as Format 1 subtables, i.e. explicit glyph pairs with an XAdvance
 * on the first glyph. opentype.js cannot write GPOS, so the bytes are made
 * here and added with `injectTables(otf, { GPOS: bytes })`.
 */

export interface GlyphPair { left: number; right: number; value: number }

export interface GposOptions {
  /** script tags that get the feature (default DFLT, latn, cyrl) */
  scripts?: string[];
  /** size limit of one PairPos subtable in bytes (default 60000, at most 65000) */
  maxSubtableBytes?: number;
}

class Bytes {
  private b = new Uint8Array(1024);
  length = 0;
  private room(n: number): void {
    if (this.length + n <= this.b.length) return;
    const grown = new Uint8Array(Math.max(this.b.length * 2, this.length + n));
    grown.set(this.b.subarray(0, this.length));
    this.b = grown;
  }
  u16(v: number): this { this.room(2); this.b[this.length++] = (v >>> 8) & 0xff; this.b[this.length++] = v & 0xff; return this; }
  i16(v: number): this { return this.u16(v & 0xffff); }
  u32(v: number): this { return this.u16((v >>> 16) & 0xffff).u16(v & 0xffff); }
  tag(t: string): this { this.room(4); for (let i = 0; i < 4; i++) this.b[this.length++] = t.charCodeAt(i) & 0xff; return this; }
  bytes(u: Uint8Array): this { this.room(u.length); this.b.set(u, this.length); this.length += u.length; return this; }
  done(): Uint8Array { return this.b.slice(0, this.length); }
}

interface FirstGlyph { first: number; seconds: number[]; values: number[] }

/** Coverage table for sorted glyph ids: format 1 (list) or 2 (ranges), whichever is smaller. */
function coverage(gids: number[]): Uint8Array {
  const ranges: [number, number, number][] = [];
  gids.forEach((g, i) => {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === g - 1) last[1] = g; else ranges.push([g, g, i]);
  });
  const w = new Bytes();
  if (4 + ranges.length * 6 < 4 + gids.length * 2) {
    w.u16(2).u16(ranges.length);
    for (const [start, end, index] of ranges) w.u16(start).u16(end).u16(index);
  } else {
    w.u16(1).u16(gids.length);
    for (const g of gids) w.u16(g);
  }
  return w.done();
}

/** PairPosFormat1: ValueFormat1 = XAdvance, ValueFormat2 = none. */
function pairPosSubtable(group: FirstGlyph[]): Uint8Array {
  const cov = coverage(group.map((g) => g.first));
  const header = 10 + group.length * 2;
  const w = new Bytes();
  w.u16(1).u16(header).u16(0x0004).u16(0).u16(group.length);
  let offset = header + cov.length;
  for (const g of group) { w.u16(offset); offset += 2 + g.seconds.length * 4; }
  w.bytes(cov);
  for (const g of group) {
    w.u16(g.seconds.length);
    for (let i = 0; i < g.seconds.length; i++) w.u16(g.seconds[i]).i16(g.values[i]);
  }
  return w.done();
}

/** Upper bound of a subtable's size (coverage counted as format 1). */
const SUBTABLE_BASE = 10 + 4;
const firstGlyphSize = (g: FirstGlyph) => 2 + 2 + 2 + g.seconds.length * 4;

/**
 * GPOS 1.0 table kerning the given glyph-index pairs, or null when there is
 * nothing to write. Pairs with glyph 0 (.notdef), out-of-range ids or a zero
 * value are dropped; a repeated pair keeps its last value. Values are XAdvance
 * adjustments in font units (negative = tighter), clamped to int16.
 *
 * Glyph ids are sorted in the coverage and second glyphs inside every PairSet.
 * When the pairs do not fit one subtable they are split (a first glyph's
 * pairs always stay together); when the subtables no longer fit the lookup's
 * 16-bit offsets they are reached through Extension (type 9) subtables.
 */
export function buildGposKern(pairs: GlyphPair[], opts: GposOptions = {}): Uint8Array | null {
  const byFirst = new Map<number, Map<number, number>>();
  for (const p of pairs ?? []) {
    if (!p) continue;
    const { left, right } = p;
    const value = Math.max(-32768, Math.min(32767, Math.round(p.value)));
    if (!Number.isInteger(left) || !Number.isInteger(right) || left <= 0 || right <= 0 || left > 0xffff || right > 0xffff) continue;
    if (!Number.isFinite(value)) continue;
    let m = byFirst.get(left);
    if (!m) byFirst.set(left, (m = new Map()));
    if (value === 0) m.delete(right); else m.set(right, value);
  }
  const firsts: FirstGlyph[] = [];
  for (const first of [...byFirst.keys()].sort((a, b) => a - b)) {
    const m = byFirst.get(first)!;
    if (!m.size) continue;
    const seconds = [...m.keys()].sort((a, b) => a - b);
    firsts.push({ first, seconds, values: seconds.map((s) => m.get(s)!) });
  }
  if (!firsts.length) return null;

  // split into subtables: every offset inside a subtable must stay below 65536
  const limit = Math.max(64, Math.min(65000, Math.floor(opts.maxSubtableBytes ?? 60000)));
  const groups: FirstGlyph[][] = [];
  let cur: FirstGlyph[] = [], size = SUBTABLE_BASE;
  for (const f of firsts) {
    const s = firstGlyphSize(f);
    if (cur.length && size + s > limit) { groups.push(cur); cur = []; size = SUBTABLE_BASE; }
    cur.push(f); size += s;
  }
  groups.push(cur);
  const subtables = groups.map(pairPosSubtable);

  // ---- ScriptList: every script has only a default LangSys with feature 0
  const scripts = [...new Set((opts.scripts ?? ['DFLT', 'latn', 'cyrl']).filter((t) => typeof t === 'string' && t.length === 4))].sort();
  if (!scripts.length) scripts.push('DFLT');
  const scriptList = new Bytes().u16(scripts.length);
  scripts.forEach((t, i) => scriptList.tag(t).u16(2 + scripts.length * 6 + i * 12));
  for (let i = 0; i < scripts.length; i++) {
    scriptList.u16(4).u16(0);                  // Script: defaultLangSys offset, no LangSysRecords
    scriptList.u16(0).u16(0xffff).u16(1).u16(0); // LangSys: lookupOrder, no required feature, 1 feature: index 0
  }

  // ---- FeatureList: 'kern' → lookup 0
  const featureList = new Bytes().u16(1).tag('kern').u16(8).u16(0).u16(1).u16(0);

  // ---- LookupList: one lookup
  const count = subtables.length;
  const lookupHeader = 6 + count * 2;
  let directEnd = lookupHeader;
  for (let i = 0; i < count - 1; i++) directEnd += subtables[i].length;
  const direct = directEnd <= 0xffff; // offset of the last subtable
  const lookupList = new Bytes().u16(1).u16(4);
  if (direct) {
    lookupList.u16(2).u16(0).u16(count);
    let off = lookupHeader;
    for (const s of subtables) { lookupList.u16(off); off += s.length; }
  } else {
    if (lookupHeader + (count - 1) * 8 > 0xffff) throw new Error('too many kerning subtables');
    lookupList.u16(9).u16(0).u16(count);
    for (let i = 0; i < count; i++) lookupList.u16(lookupHeader + i * 8);
    let pos = lookupHeader + count * 8; // where the next PairPos subtable starts, from the lookup
    subtables.forEach((s, i) => {
      lookupList.u16(1).u16(2).u32(pos - (lookupHeader + i * 8)); // ExtensionPosFormat1 → PairPos
      pos += s.length;
    });
  }
  for (const s of subtables) lookupList.bytes(s);

  const out = new Bytes();
  out.u16(1).u16(0);
  out.u16(10).u16(10 + scriptList.length).u16(10 + scriptList.length + featureList.length);
  out.bytes(scriptList.done()).bytes(featureList.done()).bytes(lookupList.done());
  return out.done();
}

/**
 * Character pairs (`{ AV: -85 }`) → glyph-index pairs for `buildGposKern`.
 * `charToIndex` is e.g. `(ch) => font.charToGlyphIndex(ch)`; pairs with a
 * missing glyph (index 0), a zero value or a key that is not exactly two
 * characters are dropped.
 */
export function kernToGlyphPairs(pairsByChar: Record<string, number>, charToIndex: (ch: string) => number): GlyphPair[] {
  const out: GlyphPair[] = [];
  const memo = new Map<string, number>(); // opentype.js' cmap lookup is slow enough to matter for thousands of pairs
  const index = (ch: string): number => {
    let i = memo.get(ch);
    if (i === undefined) { i = charToIndex(ch); memo.set(ch, i); }
    return i;
  };
  for (const [key, v] of Object.entries(pairsByChar ?? {})) {
    const cs = [...key];
    if (cs.length !== 2 || !Number.isFinite(v)) continue;
    const value = Math.round(v);
    if (!value) continue;
    const left = index(cs[0]), right = index(cs[1]);
    if (!(left > 0) || !(right > 0)) continue;
    out.push({ left, right, value });
  }
  return out;
}

/**
 * The same pairs as an AFDKO feature block for a UFO's features.fea:
 * `feature kern { pos A V -85; … } kern;`. `nameOf` maps a character to its
 * glyph name (return '' to skip). Empty string when there are no pairs.
 */
export function kerningFea(pairsByChar: Record<string, number>, nameOf: (ch: string) => string): string {
  const lines: [string, string, number][] = [];
  for (const [key, v] of Object.entries(pairsByChar ?? {})) {
    const cs = [...key];
    if (cs.length !== 2 || !Number.isFinite(v)) continue;
    const value = Math.round(v);
    if (!value) continue;
    const a = nameOf(cs[0]), b = nameOf(cs[1]);
    if (!a || !b) continue;
    lines.push([a, b, value]);
  }
  if (!lines.length) return '';
  lines.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
  return `feature kern {\n${lines.map(([a, b, v]) => `  pos ${a} ${b} ${v};`).join('\n')}\n} kern;\n`;
}
