import type { Vec } from '../../core/glyph';
import { simplifyRDP, signedArea, dedupe } from '../../core/geometry';
import { unionContours } from '../../outline/union';
import { cleanContours } from '../../outline/fitCurves';
import type { OutlineOp } from '../types';
import { num } from './hollow';

/** `k` evenly spaced vertices of a ring (all of them when it has fewer). */
function evenlySpaced(pts: Vec[], k: number): Vec[] {
  const n = pts.length;
  if (n <= k) return pts.slice();
  const out: Vec[] = [];
  for (let i = 0; i < k; i++) out.push(pts[Math.floor((i * n) / k)]);
  return out;
}

/** RDP on a closed ring: close it, simplify, drop the duplicated closing vertex. */
function simplifyRing(pts: Vec[], tol: number, minSeg: number): Vec[] | null {
  const src = dedupe(pts, 0.05);
  if (src.length < 3) return null;
  const want = signedArea(src) > 0;
  let out = simplifyRDP(src.concat([src[0]]), tol);
  out.pop();
  out = dedupe(out, 0.05);
  const ok = (r: Vec[]) => r.length >= 3 && Math.abs(signedArea(r)) > 1 && (signedArea(r) > 0) === want;
  if (out.length < minSeg || !ok(out)) out = evenlySpaced(src, Math.max(minSeg, 3));
  return ok(out) ? out : null;
}

const orient = (a: Vec, b: Vec, c: Vec) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/** true when two closed segments cross properly (shared endpoints don't count). */
function segmentsCross(a: Vec, b: Vec, c: Vec, d: Vec): boolean {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

/** Any proper crossing between edges of the given rings (self or mutual)? */
function ringsCross(rings: Vec[][]): boolean {
  type Seg = { a: Vec; b: Vec; minX: number; maxX: number; minY: number; maxY: number };
  const segs: Seg[] = [];
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      segs.push({ a, b, minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]), minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1]) });
    }
  }
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    for (let j = i + 1; j < segs.length; j++) {
      const t = segs[j];
      if (t.minX > s.maxX || t.maxX < s.minX || t.minY > s.maxY || t.maxY < s.minY) continue;
      if (segmentsCross(s.a, s.b, t.a, t.b)) return true;
    }
  }
  return false;
}

/**
 * Faceted, crystal-like letters: every ring is reduced to a coarse polygon by
 * Ramer–Douglas–Peucker at `tolerance` font units, never below `minSegments`
 * vertices (falling back to evenly spaced original vertices). Rings that end
 * up crossing themselves or each other are re-resolved with a boolean union.
 */
export const lowpoly: OutlineOp = (contours, params) => {
  if (contours.length === 0) return contours;
  const tolerance = num(params.tolerance, 4, 120, 30);
  const minSegments = Math.round(num(params.minSegments, 3, 12, 4));

  const rings: Vec[][] = [];
  for (const c of contours) {
    const r = simplifyRing(c.points, tolerance, minSegments);
    if (r) rings.push(r);
  }
  if (rings.length === 0) return contours;
  if (!ringsCross(rings)) return rings.map((points) => ({ points }));

  const out = cleanContours(unionContours(rings.map((points) => ({ points }))), 1, 0.05);
  return out.length ? out : contours;
};
