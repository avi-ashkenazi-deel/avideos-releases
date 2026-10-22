import type { Contour, Vec } from '../core/glyph';
import { bboxContours, pointInPolygon, signedArea } from '../core/geometry';
import { disc, type Ring } from '../outline/strokeExpand';
import type { OpCtx } from './types';
import { densifyClosed, ringNormals, inkArea } from './util';
import { subtractRings } from './clip';

export const ERODE_MIN_AREA = 60;

/**
 * Rust: roughen every edge inward with small noise (amp 6·amount), then bite
 * seeded discs out of the ink — most centred near the outline, a few inside.
 * Material is only ever removed; slivers under 60 units² are dropped.
 */
export function erode(contours: Contour[], amount: number, ctx: OpCtx): Contour[] {
  if (contours.length === 0) return contours;
  const { rng } = ctx;
  const { noise2 } = rng;
  const area = Math.max(0, inkArea(contours));

  // 1. inward roughening
  const amp = amount * 6;
  const verts: Vec[] = [];
  const norms: Vec[] = [];
  const rough: Contour[] = contours.map((c) => {
    const pts = densifyClosed(c.points, 8);
    const nrm = ringNormals(pts);
    const out = pts.map((p, i) => {
      const k = -amp * (0.5 + 0.5 * noise2(p[0] * 0.05, p[1] * 0.05));
      const q: Vec = [p[0] + nrm[i][0] * k, p[1] + nrm[i][1] * k];
      verts.push(q); norms.push(nrm[i]);
      return q;
    });
    return { points: out };
  });

  // 2. bite discs
  const outers = rough.filter((c) => signedArea(c.points) > 0);
  const holes = rough.filter((c) => signedArea(c.points) < 0);
  const inside = (p: Vec) => outers.some((o) => pointInPolygon(p, o.points)) && !holes.some((h) => pointInPolygon(p, h.points));
  const b = bboxContours(rough);
  const m = Math.round(amount * 40) + Math.round((amount * area) / 8000);
  const bites: Ring[] = [];
  for (let j = 0; j < m && verts.length > 0; j++) {
    const r = rng.range(4, 22 * amount + 6);
    let cx: number, cy: number;
    if (j % 4 === 3) {
      // interior pit: a few random probes, else fall back to an edge bite
      let found: Vec | null = null;
      for (let tries = 0; tries < 6 && !found; tries++) {
        const p: Vec = [rng.range(b.minX, b.maxX), rng.range(b.minY, b.maxY)];
        if (inside(p)) found = p;
      }
      if (found) { cx = found[0]; cy = found[1]; }
      else { const v = verts[rng.int(0, verts.length - 1)]; cx = v[0]; cy = v[1]; }
    } else {
      const idx = rng.int(0, verts.length - 1);
      const v = verts[idx], nv = norms[idx];
      const off = rng.range(-1, 1) * r;
      cx = v[0] + nv[0] * off; cy = v[1] + nv[1] * off;
    }
    bites.push(disc(cx, cy, r, r < 10 ? 10 : 14));
  }
  const result = subtractRings(rough, bites);
  return result.filter((c) => Math.abs(signedArea(c.points)) >= ERODE_MIN_AREA);
}
