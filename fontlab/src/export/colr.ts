/**
 * COLR (version 0) and CPAL (version 0) table writers plus the bookkeeping that
 * turns per-letter colour layers into extra glyphs. Bytes only: the tables are
 * added to a built font with `injectTables` (sfnt.ts).
 *
 * Wiring (see `planColorGlyphs`):
 *   1. base glyph  = the letter itself, with the colour glyph's `fallback` outline and `advance`
 *   2. layer glyphs = unencoded extra glyphs `A.color0`, `A.color1`, … (same advance)
 *   3. COLR maps base glyph id → [layer glyph id, palette index]…, bottom layer first
 *   4. CPAL holds the palette
 */
import type { Contour } from '../core/glyph';
import type { ColorGlyph } from '../color/layers';

/** COLR palette index meaning "the text colour" */
export const FOREGROUND_COLOR = 0xffff;

export interface ColrLayerRecord { glyph: number; color: number }
export interface ColrRecord { glyph: number; layers: ColrLayerRecord[] }

export interface ColorExtraGlyph { name: string; advance: number; contours: Contour[] }
export interface ColorBinding { base: string; layers: { name: string; color: number }[] }
export interface ColorPlan { extraGlyphs: ColorExtraGlyph[]; bindings: ColorBinding[] }

/** '#rrggbb' (also '#rgb', with or without '#') → [r, g, b]; anything unreadable is black. */
export function parseHexColor(hex: string): [number, number, number] {
  let s = String(hex ?? '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3,4}$/i.test(s)) s = s.slice(0, 3).split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(s)) return [0, 0, 0];
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

/** CPAL version 0 with one palette; colour records are B, G, R, A with alpha 255. */
export function buildCpal(palette: string[]): Uint8Array {
  const colors = palette.length ? palette : ['#000000'];
  if (colors.length > 0xffff) throw new Error('CPAL: too many colours');
  const headerLen = 12 + 2; // header + colorRecordIndices[1]
  const out = new Uint8Array(headerLen + colors.length * 4);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 0);              // version
  dv.setUint16(2, colors.length);  // numPaletteEntries
  dv.setUint16(4, 1);              // numPalettes
  dv.setUint16(6, colors.length);  // numColorRecords
  dv.setUint32(8, headerLen);      // colorRecordsArrayOffset
  dv.setUint16(12, 0);             // colorRecordIndices[0]
  colors.forEach((hex, i) => {
    const [r, g, b] = parseHexColor(hex);
    out.set([b, g, r, 255], headerLen + i * 4);
  });
  return out;
}

/**
 * COLR version 0. Base glyph records are sorted by glyph id (renderers binary
 * search them); each base glyph's layer records are contiguous, bottom layer
 * first. Records without layers are skipped; a glyph listed twice keeps its
 * first record.
 */
export function buildColr(records: ColrRecord[]): Uint8Array {
  const seen = new Set<number>();
  const bases = records
    .filter((r) => r.layers.length > 0 && !seen.has(r.glyph) && (seen.add(r.glyph), true))
    .sort((a, b) => a.glyph - b.glyph);
  const numLayers = bases.reduce((s, r) => s + r.layers.length, 0);
  const u16 = (v: number, what: string) => {
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new Error(`COLR: ${what} out of range (${v})`);
    return v;
  };
  u16(bases.length, 'base glyph count');
  u16(numLayers, 'layer count');
  const baseOffset = 14, layerOffset = baseOffset + bases.length * 6;
  const out = new Uint8Array(layerOffset + numLayers * 4);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 0);               // version
  dv.setUint16(2, bases.length);    // numBaseGlyphRecords
  dv.setUint32(4, baseOffset);      // baseGlyphRecordsOffset
  dv.setUint32(8, layerOffset);     // layerRecordsOffset
  dv.setUint16(12, numLayers);      // numLayerRecords
  let first = 0;
  bases.forEach((r, i) => {
    const o = baseOffset + i * 6;
    dv.setUint16(o, u16(r.glyph, 'base glyph id'));
    dv.setUint16(o + 2, first);
    dv.setUint16(o + 4, r.layers.length);
    r.layers.forEach((l, k) => {
      const lo = layerOffset + (first + k) * 4;
      dv.setUint16(lo, u16(l.glyph, 'layer glyph id'));
      dv.setUint16(lo + 2, u16(l.color, 'palette index'));
    });
    first += r.layers.length;
  });
  return out;
}

/** Name of layer `i` of a colour glyph: `A.color0`, `A.color1`, … */
export function colorGlyphName(baseName: string, i: number): string {
  return `${baseName}.color${i}`;
}

/**
 * Turn colour glyphs into the extra (unencoded) layer glyphs to append to the
 * font and the name-level COLR bindings. `name` is the base glyph's name in the
 * font (`glyphName(char, unicode)`, or e.g. `a.ss01` for an alternate) and
 * `advance` its advance; layer glyphs take the colour glyph's own advance
 * (shadow / outline widen the letter), which the base glyph must use too.
 */
export function planColorGlyphs(items: { name: string; advance: number; color: ColorGlyph }[]): ColorPlan {
  const extraGlyphs: ColorExtraGlyph[] = [];
  const bindings: ColorBinding[] = [];
  const used = new Set<string>();
  for (const item of items) {
    if (!item?.name || !item.color || used.has(item.name)) continue;
    const layers: ColorBinding['layers'] = [];
    item.color.layers.forEach((layer) => {
      if (!layer.contours.length) return;
      const name = colorGlyphName(item.name, layers.length);
      extraGlyphs.push({ name, advance: item.color.advance ?? item.advance, contours: layer.contours });
      layers.push({ name, color: layer.color });
    });
    if (!layers.length) continue;
    used.add(item.name);
    bindings.push({ base: item.name, layers });
  }
  return { extraGlyphs, bindings };
}

/**
 * Resolve name-level bindings to glyph ids. `glyphNames[i]` is the name of
 * glyph i in the finished font (see `fontGlyphNames`). Bindings whose base or
 * any layer glyph is missing from the font are dropped whole, so a letter is
 * either fully coloured or plain.
 */
export function resolveColorBindings(bindings: ColorBinding[], glyphNames: string[]): ColrRecord[] {
  const idOf = new Map<string, number>();
  glyphNames.forEach((name, i) => { if (name && !idOf.has(name)) idOf.set(name, i); });
  const records: ColrRecord[] = [];
  for (const b of bindings) {
    const glyph = idOf.get(b.base);
    if (glyph === undefined || glyph === 0) continue;
    const layers: ColrLayerRecord[] = [];
    for (const l of b.layers) {
      const id = idOf.get(l.name);
      if (id === undefined) { layers.length = 0; break; }
      layers.push({ glyph: id, color: l.color });
    }
    if (layers.length) records.push({ glyph, layers });
  }
  return records;
}

/** Glyph names by glyph id of an opentype.js Font (as returned by `buildFont`). */
export function fontGlyphNames(font: any): string[] {
  const names: string[] = [];
  for (let i = 0; i < font.glyphs.length; i++) names.push(font.glyphs.get(i).name ?? '');
  return names;
}

/**
 * The two tables for a built font, ready for `injectTables(otf, tables)`;
 * null when no binding resolves (the font then simply stays monochrome).
 */
export function colorTables(font: any, bindings: ColorBinding[], palette: string[]): { COLR: Uint8Array; CPAL: Uint8Array } | null {
  const records = resolveColorBindings(bindings, fontGlyphNames(font));
  if (!records.length) return null;
  const top = Math.max(...records.flatMap((r) => r.layers.map((l) => (l.color === FOREGROUND_COLOR ? 0 : l.color))));
  // every palette index used must exist in CPAL (OTS rejects the font otherwise)
  const colors = palette.slice();
  while (colors.length <= top) colors.push(colors[colors.length % Math.max(1, palette.length)] ?? '#000000');
  return { COLR: buildColr(records), CPAL: buildCpal(colors) };
}
