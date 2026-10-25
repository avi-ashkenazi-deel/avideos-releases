import polygonClipping from 'polygon-clipping';
import type { Contour } from '../../core/glyph';
import { offsetContours } from '../../dna/offset';
import { toMulti, fromMulti, unionSets } from '../../dna/clip';
import type { OutlineOp } from '../types';

type PC = typeof polygonClipping;
const pc: PC = (polygonClipping as any).default ?? polygonClipping;
type Multi = ReturnType<typeof toMulti>;

/** Finite number clamped to [lo, hi]; NaN / undefined fall back to `def`. */
export function num(v: number | undefined, lo: number, hi: number, def: number): number {
  const x = typeof v === 'number' && Number.isFinite(v) ? v : def;
  return Math.min(hi, Math.max(lo, x));
}

const roundMulti = (m: Multi): Multi =>
  m.map((poly) => poly.map((r) => r.map(([x, y]) => [Math.round(x * 4) / 4, Math.round(y * 4) / 4] as [number, number])));

/**
 * subject − cutters, both hole-consistent contour sets (outers CCW, holes CW).
 * Unlike `subtractRings`, the cutters' holes are respected (not treated as ink).
 */
export function subtractContourSets(subject: Contour[], cutters: Contour[]): Contour[] {
  const s = toMulti(subject);
  if (s.length === 0) return [];
  const c = toMulti(cutters);
  if (c.length === 0) return subject;
  try {
    return fromMulti(pc.difference(s, c));
  } catch {
    try { return fromMulti(pc.difference(roundMulti(s), roundMulti(c))); } catch { return subject; }
  }
}

/**
 * Outlined letter: keep only a shell of width `inset` along every edge
 * (ink − ink inset by `inset`). With `inline` > 0 the body further inside
 * (inset by `inset + inline`) is unioned back, leaving a thin counter-line
 * running inside the letter — the classic inline face.
 *
 * Strokes thinner than 2·inset vanish entirely under the inset, so their
 * shell is simply the whole stroke; an empty result returns the input.
 */
export const hollow: OutlineOp = (contours, params) => {
  if (contours.length === 0) return contours;
  const inset = num(params.inset, 4, 80, 24);
  const inline = num(params.inline, 0, 60, 0);

  const core = offsetContours(contours, -inset);
  let out = core.length ? subtractContourSets(contours, core) : contours;

  if (inline > 0 && core.length) {
    const body = offsetContours(contours, -(inset + inline));
    if (body.length) out = unionSets([out, body]);
  }
  return out.length ? out : contours;
};
