/**
 * Build a glyph FROM another glyph in the project: accented letters from the
 * base + a mark, Ø/Ł/Đ from the base + an extra stroke, Cyrillic look-alikes
 * as clones of Latin glyphs, lowercase Cyrillic as small capitals. Works for
 * stroke and outline bases (marks are converted to contours for the latter).
 */
import type { Glyph, Stroke, Contour, StyleStats, Vec } from '../core/glyph';
import type { Rng } from '../core/prng';
import { bboxStrokes, bboxContours, clamp, type BBox } from '../core/geometry';
import { ALIASES, SMALLCAPS, ADDITIONS, DOTTED_BASES, COMMA_CARON_BASES } from '../core/recipes/aliases';
import { COMBINING, buildMark, BELOW_MARKS, type MarkId, type MarkSpec } from '../core/recipes/marks';
import { diagonal, bar } from './primitives';
import { glyphToContours } from '../outline';

export type BaseLookup = (ch: string) => Glyph | undefined;

export interface Decomposition { base: string; marks: MarkId[] }

/** NFD decomposition into a single base char + known marks, else null. */
export function decompose(ch: string): Decomposition | null {
  if ([...ch].length !== 1) return null;
  const nfd = ch.normalize('NFD');
  const cps = [...nfd].map((c) => c.codePointAt(0)!);
  if (cps.length < 2) return null;
  const base = String.fromCodePoint(cps[0]);
  const marks: MarkId[] = [];
  for (const cp of cps.slice(1)) {
    const m = COMBINING[cp];
    if (!m) return null;
    marks.push(m);
  }
  return { base, marks };
}

/** What a character is derived from, if anything (one level). */
export function dependsOn(ch: string): string | null {
  const d = decompose(ch);
  if (d) return d.base;
  if (ADDITIONS[ch]) return ADDITIONS[ch].base;
  if (ALIASES[ch]) return ALIASES[ch];
  if (SMALLCAPS[ch]) return SMALLCAPS[ch];
  return null;
}

/** Full dependency chain (nearest first). */
export function dependencyChain(ch: string): string[] {
  const out: string[] = [];
  let cur: string | null = ch;
  while ((cur = dependsOn(cur)) && !out.includes(cur) && out.length < 8) out.push(cur);
  return out;
}

export interface DeriveCtx { stats: StyleStats; rng: Rng; mutation: number }

const hasInk = (g: Glyph | undefined): g is Glyph => !!g && (g.kind === 'stroke' ? !!g.strokes?.some((s) => s.points.length) : !!g.contours?.some((c) => c.points.length >= 3));

function inkBBox(g: Glyph): BBox {
  return g.kind === 'stroke' ? bboxStrokes(g.strokes!) : bboxContours(g.contours!);
}

function cloneStrokes(strokes: Stroke[], prefix: string): Stroke[] {
  return strokes.map((s, i) => ({ id: `${prefix}_${i}`, cap: s.cap, points: s.points.map((p) => ({ ...p })) }));
}
function cloneContours(contours: Contour[]): Contour[] {
  return contours.map((c) => ({ points: c.points.map((p) => [p[0], p[1]] as Vec) }));
}

/** Remove the dot of i / j so an above-mark can replace it. */
function dotless(g: Glyph, stats: StyleStats): Glyph {
  const xh = clamp(stats.xHeight || 500, 150, 900);
  if (g.kind === 'stroke') {
    const strokes = g.strokes!.filter((s) => {
      const b = bboxStrokes([s]);
      const small = b.maxY - b.minY < xh * 0.3 && b.maxX - b.minX < xh * 0.3;
      return !(small && b.minY > xh * 0.95);
    });
    return strokes.length ? { ...g, strokes } : g;
  }
  const contours = g.contours!.filter((c) => {
    const b = bboxContours([c]);
    const small = b.maxY - b.minY < xh * 0.3 && b.maxX - b.minX < xh * 0.3;
    return !(small && b.minY > xh * 0.95);
  });
  return contours.length ? { ...g, contours } : g;
}

/** Append strokes to a glyph of either kind. */
function addStrokes(g: Glyph, extra: Stroke[], ch: string): Glyph {
  if (g.kind === 'stroke') return { ...g, strokes: [...g.strokes!, ...cloneStrokes(extra, `d${ch.codePointAt(0)!.toString(36)}`)] };
  const extraContours = glyphToContours({ char: ch, unicode: 0, advance: 0, source: 'generated', kind: 'stroke', strokes: extra });
  return { ...g, contours: [...g.contours!, ...extraContours] };
}

function translate(strokes: Stroke[], dx: number, dy: number): Stroke[] {
  return strokes.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) }));
}

function placeMark(spec: MarkSpec, base: BBox, upper: boolean, stats: StyleStats, stackOffset: number): Stroke[] {
  const sw = clamp(stats.strokeWidth || 90, 4, 400);
  const cx = (base.minX + base.maxX) / 2;
  if (spec.pos === 'above') {
    const gap = upper ? sw * 0.55 : sw * 0.8;
    return translate(spec.strokes, cx, base.maxY + gap + sw * 0.5 + stackOffset);
  }
  if (spec.pos === 'right') return translate(spec.strokes, base.maxX + sw * 0.9, base.maxY);
  // below: cedilla hangs from the bottom centre; ogonek from the bottom right
  const x = spec.strokes.length && spec.strokes[0].points.length && spec.strokes[0].points[1]?.x < 0 ? base.maxX - sw * 0.8 : cx;
  return translate(spec.strokes, x, base.minY - sw * 0.3);
}

function additionStrokes(kind: string, base: Glyph, ctx: DeriveCtx): Stroke[] {
  const b = inkBBox(base);
  const sw = clamp(ctx.stats.strokeWidth || 90, 4, 400);
  const c = ctx as unknown as Parameters<typeof bar>[0];
  const w = b.maxX - b.minX, h = b.maxY - b.minY;
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  switch (kind) {
    case 'slash': return [diagonal(c, cx - w * 0.42, cy - h * 0.55, cx + w * 0.42, cy + h * 0.55)];
    case 'lbar': return [diagonal(c, b.minX - sw * 0.3, h * 0.38 + b.minY, b.minX + Math.max(sw * 1.4, w * 0.45), h * 0.58 + b.minY)];
    case 'hbar': return [bar(c, b.minX - sw * 0.6, b.minX + Math.max(sw * 1.5, w * 0.5), cy)];
    case 'midbar': return [bar(c, cx - w * 0.45, cx + w * 0.45, b.maxY - h * 0.28)];
  }
  return [];
}

function smallCap(upper: Glyph, ch: string, stats: StyleStats): Glyph {
  const xh = clamp(stats.xHeight || 500, 150, 900);
  const b = inkBBox(upper);
  const cap = Math.max(b.maxY, 1);
  const sy = xh / cap, sx = Math.min(1, sy * 1.08);
  const spacing = clamp(stats.spacing || 60, 0, 400);
  const map = (x: number, y: number): Vec => [spacing + (x - b.minX) * sx, y * sy];
  const advance = Math.round((b.maxX - b.minX) * sx + 2 * spacing);
  if (upper.kind === 'stroke') {
    const strokes = cloneStrokes(upper.strokes!, `sc${ch.codePointAt(0)!.toString(36)}`).map((s) => ({ ...s, points: s.points.map((p) => { const [x, y] = map(p.x, p.y); return { ...p, x, y }; }) }));
    return { ...upper, char: ch, unicode: ch.codePointAt(0)!, advance, strokes, source: 'generated', locked: false };
  }
  const contours = cloneContours(upper.contours!).map((c) => ({ points: c.points.map(([x, y]) => map(x, y)) }));
  return { ...upper, char: ch, unicode: ch.codePointAt(0)!, advance, contours, source: 'generated', locked: false };
}

/**
 * Derive `ch` from a base glyph supplied by `lookup`. Returns null when the
 * character is not derivable or the base has no ink (caller falls back).
 */
export function deriveGlyph(ch: string, lookup: BaseLookup, ctx: DeriveCtx, seed: number): Glyph | null {
  const unicode = ch.codePointAt(0)!;
  const d = decompose(ch);
  if (d) {
    let base = lookup(d.base);
    if (!hasInk(base)) return null;
    const upper = inkBBox(base).maxY > clamp(ctx.stats.xHeight || 500, 150, 900) * 1.25 && d.base.toUpperCase() === d.base;
    if (DOTTED_BASES.has(d.base) && d.marks.some((m) => !BELOW_MARKS.has(m))) base = dotless(base, ctx.stats);
    let g: Glyph = base.kind === 'stroke'
      ? { ...base, char: ch, unicode, source: 'generated', locked: false, strokes: cloneStrokes(base.strokes!, `c${unicode.toString(36)}`) }
      : { ...base, char: ch, unicode, source: 'generated', locked: false, contours: cloneContours(base.contours!) };
    const bb = inkBBox(base);
    let stack = 0;
    for (const m of d.marks) {
      const id: MarkId = m === 'caron' && COMMA_CARON_BASES.has(d.base) ? 'commaabove' : m;
      const spec = buildMark(id, { stats: ctx.stats, rng: ctx.rng, mutation: ctx.mutation, params: {} }, bb.maxX - bb.minX, upper);
      g = addStrokes(g, placeMark(spec, bb, upper, ctx.stats, stack), ch);
      if (spec.pos === 'above') stack += spec.height + clamp(ctx.stats.strokeWidth || 90, 4, 400) * 0.6;
    }
    const nb = inkBBox(g);
    g.advance = Math.max(base.advance, Math.round(nb.maxX + clamp(ctx.stats.spacing || 60, 0, 400)));
    g.recipe = { id: `compose:${d.base}+${d.marks.join('+')}`, seed, params: {} };
    return g;
  }
  const add = ADDITIONS[ch];
  if (add) {
    const base = lookup(add.base);
    if (!hasInk(base)) return null;
    const g: Glyph = base.kind === 'stroke'
      ? { ...base, char: ch, unicode, source: 'generated', locked: false, strokes: cloneStrokes(base.strokes!, `a${unicode.toString(36)}`) }
      : { ...base, char: ch, unicode, source: 'generated', locked: false, contours: cloneContours(base.contours!) };
    const out = addStrokes(g, additionStrokes(add.add, base, ctx), ch);
    out.recipe = { id: `add:${add.base}+${add.add}`, seed, params: {} };
    return out;
  }
  const alias = ALIASES[ch];
  if (alias) {
    let base = lookup(alias);
    if (!hasInk(base)) return null;
    if (ch === 'ı') base = dotless(base, ctx.stats);
    const g: Glyph = base.kind === 'stroke'
      ? { ...base, char: ch, unicode, source: 'generated', locked: false, strokes: cloneStrokes(base.strokes!, `l${unicode.toString(36)}`) }
      : { ...base, char: ch, unicode, source: 'generated', locked: false, contours: cloneContours(base.contours!) };
    g.recipe = { id: `alias:${alias}`, seed, params: {} };
    return g;
  }
  const sc = SMALLCAPS[ch];
  if (sc) {
    const base = lookup(sc);
    if (!hasInk(base)) return null;
    const g = smallCap(base, ch, ctx.stats);
    g.recipe = { id: `smallcap:${sc}`, seed, params: {} };
    return g;
  }
  return null;
}
