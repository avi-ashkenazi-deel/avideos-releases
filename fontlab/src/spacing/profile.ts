/**
 * Edge profiles: for a set of filled contours, the leftmost and rightmost ink
 * x in a stack of horizontal bands between descender and ascender. This is
 * the only geometry the auto spacer and the auto kerner look at, so it is
 * cheap (one pass over the polygon edges) and safe to cache per glyph.
 * Pure TypeScript, no DOM: runs in the worker and in Node tests.
 */
import type { Contour, FontMetrics } from '../core/glyph';

export interface EdgeProfile {
  /** band centre heights, bottom to top, evenly spaced between descender and ascender */
  ys: number[];
  /** leftmost ink x in each band; NaN where the band has no ink */
  left: number[];
  /** rightmost ink x in each band; NaN where the band has no ink */
  right: number[];
}

/** [yMin, yMax] in font units */
export type Zone = [number, number];

export const PROFILE_SAMPLES = 48;

/**
 * Tunable constants of the spacing model. Lengths are fractions of the
 * x-height unless noted, so the model scales with the design.
 */
export const SPACING = {
  /** bearing of a flat stem at tightness 0 and 1 (× xHeight) */
  stemTight: 0.07,
  stemLoose: 0.27,
  /** how deep white is counted into an open shape (× xHeight) */
  depth: 0.2,
  /** smallest bearing as a fraction of the stem bearing, and in absolute units */
  floor: 0.2,
  minBearing: 8,
};

const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0);

/** The side bearing a straight stem gets at this tightness (0 = tight … 1 = loose). */
export function stemBearing(metrics: Pick<FontMetrics, 'xHeight'>, tightness: number): number {
  const t = clamp01(Number.isFinite(tightness) ? tightness : 0.5);
  const xh = metrics.xHeight > 0 ? metrics.xHeight : 500;
  return xh * (SPACING.stemTight + (SPACING.stemLoose - SPACING.stemTight) * t);
}

/** Depth limit for open shapes, in font units. */
export function depthLimit(metrics: Pick<FontMetrics, 'xHeight'>): number {
  return (metrics.xHeight > 0 ? metrics.xHeight : 500) * SPACING.depth;
}

/**
 * Leftmost / rightmost ink per horizontal band. Each band covers
 * (ascender − descender) / samples units; the value is the extreme of the
 * outline anywhere inside the band (not only on its centre line), so a gap
 * measured between two profiles is never larger than the true gap at any
 * height. Ink below the descender / above the ascender is folded into the
 * first / last band. The outermost crossings bound the ink for nonzero fill
 * whatever the contour directions are, so holes need no special care.
 */
export function edgeProfile(
  contours: Contour[],
  metrics: Pick<FontMetrics, 'ascender' | 'descender'>,
  opts: { samples?: number } = {},
): EdgeProfile {
  const n = Math.max(2, Math.floor(opts.samples ?? PROFILE_SAMPLES));
  const y0 = metrics.descender;
  const span = metrics.ascender - metrics.descender;
  const h = (span > 0 ? span : 1000) / n;
  const left: number[] = new Array(n).fill(Infinity);
  const right: number[] = new Array(n).fill(-Infinity);
  const last = n - 1;
  for (const c of contours) {
    const pts = c.points;
    const m = pts.length;
    if (m < 2) continue;
    let ax = pts[m - 1][0], ay = pts[m - 1][1];
    for (let j = 0; j < m; j++) {
      const bx = pts[j][0], by = pts[j][1];
      if (ay !== by) {
        let x1 = ax, y1 = ay, x2 = bx, y2 = by;
        if (y1 > y2) { x1 = bx; y1 = by; x2 = ax; y2 = ay; }
        let i0 = Math.floor((y1 - y0) / h);
        let i1 = Math.ceil((y2 - y0) / h) - 1; // a band the edge only touches from below gets no ink
        if (i0 < 0) i0 = 0; else if (i0 > last) i0 = last;
        if (i1 > last) i1 = last;
        if (i1 < i0) i1 = i0;
        const slope = (x2 - x1) / (y2 - y1);
        for (let i = i0; i <= i1; i++) {
          const lo = i === 0 ? y1 : Math.max(y1, y0 + i * h);
          const hi = i === last ? y2 : Math.min(y2, y0 + (i + 1) * h);
          const xa = lo === y1 ? x1 : x1 + (lo - y1) * slope;
          const xb = hi === y2 ? x2 : x1 + (hi - y1) * slope;
          if (xa < left[i]) left[i] = xa;
          if (xb < left[i]) left[i] = xb;
          if (xa > right[i]) right[i] = xa;
          if (xb > right[i]) right[i] = xb;
        }
      }
      ax = bx; ay = by;
    }
  }
  const ys: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    ys[i] = y0 + (i + 0.5) * h;
    if (left[i] === Infinity) { left[i] = NaN; right[i] = NaN; }
  }
  return { ys, left, right };
}

/** Horizontal ink extent of a profile, or null when it has no ink. */
export function inkBounds(p: EdgeProfile): { minX: number; maxX: number } | null {
  let minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < p.ys.length; i++) {
    const l = p.left[i];
    if (l !== l) continue;
    if (l < minX) minX = l;
    if (p.right[i] > maxX) maxX = p.right[i];
  }
  return minX === Infinity ? null : { minX, maxX };
}

/** Vertical ink extent (band edges) of a profile, or null when it has no ink. */
export function inkZone(p: EdgeProfile): Zone | null {
  const n = p.ys.length;
  const h = n > 1 ? p.ys[1] - p.ys[0] : 0;
  let lo = -1, hi = -1;
  for (let i = 0; i < n; i++) if (p.left[i] === p.left[i]) { if (lo < 0) lo = i; hi = i; }
  return lo < 0 ? null : [p.ys[lo] - h / 2, p.ys[hi] + h / 2];
}

export type CharCase = 'lower' | 'upper' | 'digit' | 'other';

/** Letter case by Unicode case mapping (works for Latin, accents, Cyrillic, Greek …). */
export function charCase(ch: string): CharCase {
  if (ch >= '0' && ch <= '9' && ch.length === 1) return 'digit';
  const lower = ch.toLowerCase(), upper = ch.toUpperCase();
  if (lower !== ch) return 'upper';
  if (upper !== ch) return 'lower';
  return 'other';
}

/**
 * The vertical zone a character is spaced in: lowercase → baseline…x-height
 * (ascenders, descenders and accents do not count), uppercase and digits →
 * baseline…cap height, everything else → the glyph's own vertical extent
 * (needs `profile`; without it the full descender…ascender range).
 * A cased glyph with no ink in its zone falls back to its own extent.
 */
export function zoneFor(ch: string, metrics: FontMetrics, profile?: EdgeProfile): Zone {
  const kind = charCase(ch);
  let zone: Zone | null = null;
  if (kind === 'lower') zone = [0, metrics.xHeight];
  else if (kind === 'upper' || kind === 'digit') zone = [0, metrics.capHeight];
  if (zone && profile) {
    let ink = false;
    for (let i = 0; i < profile.ys.length && !ink; i++) {
      ink = profile.ys[i] >= zone[0] && profile.ys[i] <= zone[1] && profile.left[i] === profile.left[i];
    }
    if (!ink) zone = null;
  }
  if (zone) return zone;
  const own = profile ? inkZone(profile) : null;
  if (!own) return [metrics.descender, metrics.ascender];
  return [Math.max(metrics.descender, own[0]), Math.min(metrics.ascender, own[1])];
}

/** Indices [i0, i1) of the bands whose centre lies inside the zone. */
export function zoneBands(ys: number[], zone: Zone): [number, number] {
  let i0 = 0;
  while (i0 < ys.length && ys[i0] < zone[0]) i0++;
  let i1 = i0;
  while (i1 < ys.length && ys[i1] <= zone[1]) i1++;
  return [i0, i1];
}
