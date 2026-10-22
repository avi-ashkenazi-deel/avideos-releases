import type { Contour, Vec } from '../core/glyph';
import { dedupe } from '../core/geometry';
import { disc, type Ring } from '../outline/strokeExpand';
import { unionWithRings, subtractRings } from './clip';

/**
 * Closed ribbon of half-width r around a closed ring: left offsets forward with
 * round joins, round cap, right offsets backward, round cap (same construction
 * as `expandStroke`, but vertex-preserving and without resampling). The ring
 * self-crosses on the inner side of tight turns; nonzero clipping resolves it.
 * Together with a disc at vertex 0 this is the Minkowski sum of the ring's
 * boundary with a disc of radius r.
 */
export function ribbonRing(ring: Vec[], r: number, arcStep = Math.PI / 9): Ring[] {
  const pts = dedupe(ring, 0.05);
  if (pts.length < 2) return pts.length ? [disc(pts[0][0], pts[0][1], r)] : [];
  const path = pts.concat([pts[0]]);
  const n = path.length;
  const dir: Vec[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = path[i + 1][0] - path[i][0], dy = path[i + 1][1] - path[i][1];
    const l = Math.hypot(dx, dy) || 1;
    dir.push([dx / l, dy / l]);
  }
  const left: Vec[] = [], right: Vec[] = [];
  const pushOffsets = (i: number, d: Vec) => {
    left.push([path[i][0] - d[1] * r, path[i][1] + d[0] * r]);
    right.push([path[i][0] + d[1] * r, path[i][1] - d[0] * r]);
  };
  pushOffsets(0, dir[0]);
  for (let i = 1; i < n - 1; i++) {
    const d0 = dir[i - 1], d1 = dir[i];
    const cross = d0[0] * d1[1] - d0[1] * d1[0];
    const dot = d0[0] * d1[0] + d0[1] * d1[1];
    const ang = Math.atan2(cross, dot);
    if (Math.abs(ang) < 1e-3) { pushOffsets(i, d1); continue; }
    const a0 = Math.atan2(d0[1], d0[0]) + Math.PI / 2;
    const steps = Math.max(1, Math.ceil(Math.abs(ang) / arcStep));
    const p = path[i];
    if (ang < 0) {
      for (let s = 0; s <= steps; s++) {
        const t = a0 + (ang * s) / steps;
        left.push([p[0] + Math.cos(t) * r, p[1] + Math.sin(t) * r]);
      }
      pushInner(right, p, r, [d0[1], -d0[0]], [d1[1], -d1[0]], ang);
    } else {
      pushInner(left, p, r, [-d0[1], d0[0]], [-d1[1], d1[0]], ang);
      const b0 = a0 + Math.PI;
      for (let s = 0; s <= steps; s++) {
        const t = b0 + (ang * s) / steps;
        right.push([p[0] + Math.cos(t) * r, p[1] + Math.sin(t) * r]);
      }
    }
  }
  pushOffsets(n - 1, dir[n - 2]);
  const out: Ring = [...left];
  out.push(...arc(path[n - 1], r, dir[n - 2], arcStep));
  for (let i = right.length - 1; i >= 0; i--) out.push(right[i]);
  out.push(...arc(path[0], r, [-dir[0][0], -dir[0][1]], arcStep));
  // the two caps don't cover the inner wedge at the closure vertex: add a disc
  return [out, disc(pts[0][0], pts[0][1], r, 12)];
}

function pushInner(arr: Vec[], p: Vec, w: number, n0: Vec, n1: Vec, ang: number) {
  if (Math.abs(ang) < (120 * Math.PI) / 180) {
    const mx = n0[0] + n1[0], my = n0[1] + n1[1];
    const ml = Math.hypot(mx, my) || 1;
    const k = w / Math.cos(ang / 2);
    arr.push([p[0] + (mx / ml) * k, p[1] + (my / ml) * k]);
  } else {
    arr.push([p[0] + n0[0] * w, p[1] + n0[1] * w]);
    arr.push([p[0] + n1[0] * w, p[1] + n1[1] * w]);
  }
}

function arc(p: Vec, r: number, d: Vec, step: number): Vec[] {
  const base = Math.atan2(d[1], d[0]);
  const steps = Math.max(2, Math.ceil(Math.PI / step));
  const out: Vec[] = [];
  for (let s = 1; s < steps; s++) {
    const t = base + Math.PI / 2 - (Math.PI * s) / steps;
    out.push([p[0] + Math.cos(t) * r, p[1] + Math.sin(t) * r]);
  }
  return out;
}

/** Round-cornered polygon offset: d > 0 grows the ink, d < 0 erodes it inward. */
export function offsetContours(contours: Contour[], d: number): Contour[] {
  if (Math.abs(d) < 0.05 || contours.length === 0) return contours;
  const r = Math.abs(d);
  const arcStep = r < 6 ? Math.PI / 4 : r < 15 ? Math.PI / 6 : Math.PI / 9;
  const rings: Ring[] = [];
  for (const c of contours) rings.push(...ribbonRing(c.points, r, arcStep));
  return d > 0 ? unionWithRings(contours, rings) : subtractRings(contours, rings);
}
