import polygonClipping from 'polygon-clipping';
import type { Contour, Vec } from '../core/glyph';
import { dedupe, signedArea, pointInPolygon, bboxOf } from '../core/geometry';
import type { Ring } from '../outline/strokeExpand';

type PC = typeof polygonClipping;
const pc: PC = (polygonClipping as any).default ?? polygonClipping;

type P = [number, number];
type Poly = P[][];
type Multi = Poly[];

const toRing = (pts: Vec[]): P[] => pts.map((p) => [p[0], p[1]] as P);

/**
 * Contours -> MultiPolygon with holes attached to their enclosing outer.
 * (polygon-clipping ignores winding: a CW hole passed as its own polygon would
 * be treated as filled ink, so we must group explicitly.)
 */
export function toMulti(contours: Contour[]): Multi {
  const outers: { ring: P[]; pts: Vec[]; area: number; holes: P[][] }[] = [];
  const holes: Vec[][] = [];
  for (const c of contours) {
    if (c.points.length < 3) continue;
    const a = signedArea(c.points);
    if (Math.abs(a) < 1e-6) continue;
    if (a > 0) outers.push({ ring: toRing(c.points), pts: c.points, area: a, holes: [] });
    else holes.push(c.points);
  }
  for (const h of holes) {
    const probe = h[0];
    let best = -1, bestArea = Infinity;
    for (let i = 0; i < outers.length; i++) {
      const o = outers[i];
      if (o.area < bestArea && pointInPolygon(probe, o.pts)) { best = i; bestArea = o.area; }
    }
    if (best >= 0) outers[best].holes.push(toRing(h));
    else outers.push({ ring: toRing(h), pts: h, area: -signedArea(h), holes: [] }); // orphan: keep as ink
  }
  return outers.map((o) => [o.ring, ...o.holes]);
}

export function fromMulti(mp: Multi): Contour[] {
  const out: Contour[] = [];
  for (const poly of mp) {
    for (const ring of poly) {
      const pts = dedupe(ring.map((p) => [p[0], p[1]] as Vec));
      if (pts.length >= 3 && Math.abs(signedArea(pts)) > 0.5) out.push({ points: pts });
    }
  }
  return out;
}

const ringsToPolys = (rings: Ring[]): Poly[] => rings.filter((r) => r.length >= 3).map((r) => [toRing(r)]);

function roundMulti(m: Multi): Multi {
  return m.map((poly) => poly.map((r) => r.map(([x, y]) => [Math.round(x * 4) / 4, Math.round(y * 4) / 4] as P)));
}

/** Run a clipping op; on the (very rare) degenerate-input throw, retry with rounded coords. */
function safe(op: (...g: Multi[]) => Multi, geoms: Multi[]): Contour[] {
  try {
    return fromMulti(op(...geoms));
  } catch {
    try { return fromMulti(op(...geoms.map(roundMulti))); } catch { return fromMulti(geoms[0]); }
  }
}

/** Re-resolve a contour set with nonzero semantics (fixes self-intersections / overlaps). */
export function normalizeContours(contours: Contour[]): Contour[] {
  const m = toMulti(contours);
  if (m.length === 0) return [];
  return safe((...g) => pc.union(...(g as [Multi, ...Multi[]])), [m]);
}

/** ink ∪ rings */
export function unionWithRings(contours: Contour[], rings: Ring[]): Contour[] {
  const m = toMulti(contours);
  const r = ringsToPolys(rings);
  if (m.length === 0 && r.length === 0) return [];
  return safe((...g) => pc.union(...(g as [Multi, ...Multi[]])), [m, ...r.map((p) => [p])]);
}

/** ink − rings */
export function subtractRings(contours: Contour[], rings: Ring[]): Contour[] {
  const m = toMulti(contours);
  if (m.length === 0) return [];
  const r = ringsToPolys(rings);
  if (r.length === 0) return contours;
  return safe((s, ...c) => pc.difference(s, ...c), [m, r]);
}

/** Union several contour sets (each already hole-consistent). */
export function unionSets(sets: Contour[][]): Contour[] {
  const ms = sets.map(toMulti).filter((m) => m.length > 0);
  if (ms.length === 0) return [];
  if (ms.length === 1) return fromMulti(ms[0]);
  return safe((...g) => pc.union(...(g as [Multi, ...Multi[]])), ms);
}

/** ink ∩ axis-aligned rect. Pass ±Infinity-free bounds; x bounds default to the ink bbox (padded). */
export function intersectRect(contours: Contour[], y0: number, y1: number, x0?: number, x1?: number): Contour[] {
  const m = toMulti(contours);
  if (m.length === 0 || y1 <= y0) return [];
  if (x0 === undefined || x1 === undefined) {
    const b = bboxOf(contours.flatMap((c) => c.points));
    x0 = b.minX - 10; x1 = b.maxX + 10;
  }
  const rect: Multi = [[[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]];
  return safe((s, r) => pc.intersection(s, r), [m, rect]);
}
