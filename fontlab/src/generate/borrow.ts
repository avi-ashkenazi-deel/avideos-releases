/**
 * Derive related letters from a drawn parent seed by transforming its strokes
 * (n -> h m u, b/d/p/q family by mirroring, M <-> W) instead of running the
 * recipe. Only applies when the parent seed exists and looks sane; otherwise
 * returns null so the caller falls through to the recipe.
 */
import type { Glyph, Stroke, StrokePoint, StyleStats } from '../core/glyph';
import { bboxStrokes } from '../core/geometry';
import { linePts } from './primitives';

type Op = 'mirrorX' | 'flipY' | 'rot180' | 'extendTop' | 'dupRight' | 'rotBox';

interface Rule { parent: string; op: Op; }

/** target -> ordered candidate rules (first with an available parent wins) */
const RULES: Record<string, Rule[]> = {
  h: [{ parent: 'n', op: 'extendTop' }],
  m: [{ parent: 'n', op: 'dupRight' }],
  u: [{ parent: 'n', op: 'rotBox' }],
  n: [{ parent: 'u', op: 'rotBox' }],
  d: [{ parent: 'b', op: 'mirrorX' }, { parent: 'p', op: 'rot180' }, { parent: 'q', op: 'flipY' }],
  b: [{ parent: 'd', op: 'mirrorX' }, { parent: 'q', op: 'rot180' }, { parent: 'p', op: 'flipY' }],
  p: [{ parent: 'b', op: 'flipY' }, { parent: 'q', op: 'mirrorX' }, { parent: 'd', op: 'rot180' }],
  q: [{ parent: 'd', op: 'flipY' }, { parent: 'p', op: 'mirrorX' }, { parent: 'b', op: 'rot180' }],
  W: [{ parent: 'M', op: 'flipY' }],
  M: [{ parent: 'W', op: 'flipY' }],
};

export function borrowParents(char: string): string[] {
  return (RULES[char] ?? []).map((r) => r.parent);
}

function cloneStrokes(strokes: Stroke[]): Stroke[] {
  return strokes.map((s) => ({ id: s.id, cap: s.cap, points: s.points.map((p) => ({ ...p })) }));
}

function saneSeed(g: Glyph | undefined): g is Glyph & { strokes: Stroke[] } {
  if (!g || g.kind !== 'stroke' || !Array.isArray(g.strokes)) return false;
  const strokes = g.strokes.filter((s) => s && Array.isArray(s.points) && s.points.length > 0);
  if (strokes.length < 1 || strokes.length > 8) return false;
  for (const s of strokes) for (const p of s.points) if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.w)) return false;
  const bb = bboxStrokes(strokes);
  const w = bb.maxX - bb.minX, h = bb.maxY - bb.minY;
  return w > 20 && h > 20 && w < 2000 && h < 2000;
}

function mapPts(strokes: Stroke[], f: (p: StrokePoint) => StrokePoint): Stroke[] {
  return strokes.map((s) => ({ ...s, points: s.points.map(f) }));
}

/** extend the top of the leftmost stem up to the ascender (n -> h) */
function extendTop(strokes: Stroke[], stats: StyleStats): Stroke[] | null {
  const bb = bboxStrokes(strokes);
  // find the stroke endpoint closest to the top-left corner
  let best: { si: number; end: 'start' | 'end'; d: number } | null = null;
  strokes.forEach((s, si) => {
    const a = s.points[0], b = s.points[s.points.length - 1];
    const da = Math.hypot(a.x - bb.minX, a.y - bb.maxY), db = Math.hypot(b.x - bb.minX, b.y - bb.maxY);
    if (!best || da < best.d) best = { si, end: 'start', d: da };
    if (db < best.d) best = { si, end: 'end', d: db };
  });
  if (!best) return null;
  const b = best as { si: number; end: 'start' | 'end'; d: number };
  const s = strokes[b.si];
  const tip = b.end === 'start' ? s.points[0] : s.points[s.points.length - 1];
  const height = bb.maxY - bb.minY;
  // the tip must be near the top of the n and the new top must be above it
  if (tip.y < bb.minY + height * 0.5) return null;
  const topY = Math.max(stats.ascender - tip.w, tip.y + height * 0.3);
  if (topY <= tip.y + 10) return null;
  const ext = linePts(tip.x, topY, tip.x, tip.y).map(([x, y]): StrokePoint => ({ x, y, w: tip.w, p: tip.p }));
  if (b.end === 'start') s.points = [...ext, ...s.points.slice(1)];
  else s.points = [...s.points.slice(0, -1), ...ext.reverse()];
  return strokes;
}

/** duplicate the whole n shifted right so its stem lands on the first n's right leg (n -> m) */
function dupRight(strokes: Stroke[]): Stroke[] | null {
  const bb = bboxStrokes(strokes);
  const w0 = Math.max(...strokes.flatMap((s) => s.points.map((p) => p.w)));
  const shift = bb.maxX - bb.minX - 2 * w0;
  if (shift < 20) return null;
  const copy = mapPts(cloneStrokes(strokes), (p) => ({ ...p, x: p.x + shift }));
  return [...strokes, ...copy];
}

export function applyBorrowOp(op: Op, parent: Glyph & { strokes: Stroke[] }, stats: StyleStats): Stroke[] | null {
  const strokes = cloneStrokes(parent.strokes.filter((s) => s.points.length > 0));
  const bb = bboxStrokes(strokes);
  const cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
  const xhMid = stats.xHeight / 2;
  switch (op) {
    case 'mirrorX': return mapPts(strokes, (p) => ({ ...p, x: 2 * cx - p.x }));
    case 'flipY': {
      // b/d/p/q: flip about the x-height midline so bowls stay on the baseline.
      // M/W: flip about the box centre.
      const axis = /[bdpq]/.test(parent.char) ? xhMid : cy;
      return mapPts(strokes, (p) => ({ ...p, y: 2 * axis - p.y }));
    }
    case 'rot180': {
      const axis = /[bdpq]/.test(parent.char) ? xhMid : cy;
      return mapPts(strokes, (p) => ({ ...p, x: 2 * cx - p.x, y: 2 * axis - p.y }));
    }
    case 'rotBox': return mapPts(strokes, (p) => ({ ...p, x: 2 * cx - p.x, y: 2 * cy - p.y }));
    case 'extendTop': return extendTop(strokes, stats);
    case 'dupRight': return dupRight(strokes);
  }
}

export interface Borrowed { strokes: Stroke[]; parent: string; op: Op; }

/**
 * Try to derive `char` from an existing seed. Returns null when no rule
 * applies or the parent seed looks unusable.
 */
export function borrowStrokes(char: string, seeds: ReadonlyMap<string, Glyph>, stats: StyleStats): Borrowed | null {
  const rules = RULES[char];
  if (!rules) return null;
  for (const rule of rules) {
    const parent = seeds.get(rule.parent);
    if (!saneSeed(parent)) continue;
    try {
      const strokes = applyBorrowOp(rule.op, parent, stats);
      if (strokes && strokes.length && strokes.every((s) => s.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)))) {
        return { strokes, parent: rule.parent, op: rule.op };
      }
    } catch {
      /* fall through to next rule */
    }
  }
  return null;
}
