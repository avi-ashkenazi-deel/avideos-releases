/**
 * Diacritic marks, built in a local frame centred on x = 0 with the mark's
 * attachment line at y = 0 (above-marks hang upward from 0, below-marks
 * downward). `placeMark` positions them relative to a base glyph's ink.
 */
import type { Stroke, StyleStats } from '../glyph';
import type { Rng } from '../prng';
import { arc, bar, dot, path, poly, curve, diagonal } from '../../generate/primitives';
import { clamp } from '../geometry';

export type MarkId = 'grave' | 'acute' | 'circumflex' | 'tilde' | 'macron' | 'breve' | 'dotaccent' | 'dieresis' | 'ring' | 'hungarumlaut' | 'caron' | 'cedilla' | 'ogonek' | 'commaabove';

/** combining code point → mark */
export const COMBINING: Record<number, MarkId> = {
  0x300: 'grave', 0x301: 'acute', 0x302: 'circumflex', 0x303: 'tilde', 0x304: 'macron', 0x306: 'breve',
  0x307: 'dotaccent', 0x308: 'dieresis', 0x30a: 'ring', 0x30b: 'hungarumlaut', 0x30c: 'caron',
  0x327: 'cedilla', 0x328: 'ogonek', 0x315: 'commaabove',
};

export const BELOW_MARKS: ReadonlySet<MarkId> = new Set<MarkId>(['cedilla', 'ogonek']);

export interface MarkCtx { stats: StyleStats; rng: Rng; mutation: number; params: Record<string, number> }

export interface MarkSpec {
  /** 'above' | 'below' | 'right' (comma-style caron on d l t L) */
  pos: 'above' | 'below' | 'right';
  /** approximate height of the mark, for stacking / gap decisions */
  height: number;
  strokes: Stroke[];
}

const fin = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * Build a mark. `w` is the available width (≈ base ink width), `upper` flattens
 * the mark for capitals. Output is centred on x = 0, attachment line y = 0.
 */
export function buildMark(id: MarkId, ctx: MarkCtx, w: number, upper: boolean): MarkSpec {
  const s = ctx.stats;
  const xh = clamp(fin(s.xHeight, 500), 150, 900);
  const sw = clamp(fin(s.strokeWidth, 90), 4, 400);
  const hw = sw / 2;
  const k = upper ? 0.72 : 1;                 // flatter on capitals
  const mw = clamp(w * 0.55, xh * 0.3, xh * 0.6); // mark width
  const mh = clamp(xh * 0.22, sw * 1.1, xh * 0.3) * k; // mark height
  const c = ctx as unknown as Parameters<typeof bar>[0];
  const above = (strokes: Stroke[], height = mh): MarkSpec => ({ pos: 'above', height, strokes });
  switch (id) {
    case 'acute': return above([diagonal(c, -mw * 0.2, 0, mw * 0.25, mh)]);
    case 'grave': return above([diagonal(c, mw * 0.2, 0, -mw * 0.25, mh)]);
    case 'circumflex': return above([poly(c, [[-mw / 2, 0], [0, mh], [mw / 2, 0]])]);
    case 'caron': return above([poly(c, [[-mw / 2, mh], [0, 0], [mw / 2, mh]])]);
    case 'tilde': return above([curve(c, [[-mw / 2, 0], [-mw / 4, mh], [mw / 4, 0], [mw / 2, mh]])], mh);
    case 'macron': return above([bar(c, -mw / 2, mw / 2, mh * 0.45)], mh * 0.5);
    case 'breve': return above([arc(c, 0, mh, mw / 2, mh, 180, 360)]);
    case 'dotaccent': return above([dot(c, 0, hw * 1.1, hw)], sw);
    case 'dieresis': return above([dot(c, -mw * 0.33, hw * 1.1, hw), dot(c, mw * 0.33, hw * 1.1, hw)], sw);
    case 'ring': { const r = clamp(mh * 0.55, hw * 1.2, xh * 0.16); return above([arc(c, 0, r, r, r, 0, 360)], r * 2); }
    case 'hungarumlaut': return above([diagonal(c, -mw * 0.45, 0, -mw * 0.1, mh), diagonal(c, mw * 0.1, 0, mw * 0.45, mh)]);
    case 'commaabove': return { pos: 'right', height: mh, strokes: [path(c, [[0, 0], [hw * 0.3, -mh * 0.5], [-hw * 0.4, -mh * 1.0]])] };
    case 'cedilla': return { pos: 'below', height: mh, strokes: [path(c, [[0, 0], [0, -mh * 0.35], [mw * 0.3, -mh * 0.55], [mw * 0.2, -mh * 1.05], [-mw * 0.25, -mh * 1.05]])] };
    case 'ogonek': return { pos: 'below', height: mh, strokes: [path(c, [[0, 0], [-mw * 0.25, -mh * 0.5], [-mw * 0.1, -mh * 1.0], [mw * 0.25, -mh * 0.95]])] };
  }
}
