import polygonClipping from 'polygon-clipping';
import type { Contour, Vec } from '../core/glyph';
import { dedupe, signedArea, pointInPolygon } from '../core/geometry';
import type { Ring } from './strokeExpand';

type PC = typeof polygonClipping;
const pc: PC = (polygonClipping as any).default ?? polygonClipping;

function toMulti(contours: Contour[]): [number, number][][][] {
  // Each contour as its own polygon; clipper sorts out holes by winding/containment.
  return contours.filter((c) => c.points.length >= 3).map((c) => [c.points.map((p) => [p[0], p[1]] as [number, number])]);
}

function fromMulti(mp: [number, number][][][]): Contour[] {
  const out: Contour[] = [];
  for (const poly of mp) {
    for (const ring of poly) {
      const pts = dedupe(ring.map((p) => [p[0], p[1]] as Vec));
      if (pts.length >= 3 && Math.abs(signedArea(pts)) > 0.5) out.push({ points: pts });
    }
  }
  return out;
}

/** Union many simple rings into clean contours (outer CCW, holes CW). */
export function unionRings(rings: Ring[]): Contour[] {
  const polys = rings.filter((r) => r.length >= 3).map((r) => [r.map((p) => [p[0], p[1]] as [number, number])]);
  if (polys.length === 0) return [];
  try {
    return fromMulti(pc.union(...(polys as [any, ...any[]])));
  } catch {
    // extremely rare degenerate input: retry with rounded coordinates
    const rounded = polys.map((p) => p.map((r) => r.map(([x, y]) => [Math.round(x * 4) / 4, Math.round(y * 4) / 4] as [number, number])));
    return fromMulti(pc.union(...(rounded as [any, ...any[]])));
  }
}

/**
 * Union existing contours (imported / traced / post-DNA) into clean contours.
 * Contours are grouped by nesting depth (even = outer, odd = hole in its
 * parent) so holes survive the union regardless of winding convention, and
 * overlapping outers at the same depth merge correctly.
 */
/** Group contours into polygon-clipping polygons by nesting depth (even = outer with its odd-depth holes). */
export function toPolygons(contours: Contour[]): [number, number][][][] {
  const cs = contours.filter((c) => c.points.length >= 3);
  const n = cs.length;
  if (n === 0) return [];
  const depth = new Array<number>(n).fill(0);
  const parent = new Array<number>(n).fill(-1);
  const areas = cs.map((c) => Math.abs(signedArea(c.points)));
  for (let i = 0; i < n; i++) {
    const probe = probePoint(cs[i].points);
    let best = -1;
    for (let j = 0; j < n; j++) {
      if (i === j || areas[j] <= areas[i]) continue;
      if (pointInPolygon(probe, cs[j].points)) { depth[i]++; if (best < 0 || areas[j] < areas[best]) best = j; }
    }
    parent[i] = best;
  }
  const polys: [number, number][][][] = [];
  for (let i = 0; i < n; i++) {
    if (depth[i] % 2 !== 0) continue;
    const rings: [number, number][][] = [cs[i].points.map((p) => [p[0], p[1]] as [number, number])];
    for (let j = 0; j < n; j++) if (parent[j] === i && depth[j] === depth[i] + 1) rings.push(cs[j].points.map((p) => [p[0], p[1]] as [number, number]));
    polys.push(rings);
  }
  return polys;
}

/**
 * Union existing contours (imported / traced / post-DNA) into clean contours.
 * Holes survive regardless of winding convention; overlapping outers merge.
 */
export function unionContours(contours: Contour[]): Contour[] {
  const polys = toPolygons(contours);
  if (polys.length === 0) return [];
  return fromMulti(pc.union(...(polys as [any, ...any[]])));
}

export type BooleanOp = 'union' | 'subtract' | 'intersect' | 'xor';

/** Generic boolean between two contour sets. */
export function booleanContours(a: Contour[], b: Contour[], op: BooleanOp): Contour[] {
  const pa = toPolygons(a), pb = toPolygons(b);
  if (op === 'union') { const all = [...pa, ...pb]; return all.length ? fromMulti(pc.union(...(all as [any, ...any[]]))) : []; }
  if (!pa.length) return op === 'xor' ? (pb.length ? fromMulti(pc.union(...(pb as [any, ...any[]]))) : []) : [];
  if (!pb.length) return op === 'intersect' ? [] : fromMulti(pc.union(...(pa as [any, ...any[]])));
  const A = pa as any, B = pb as any;
  switch (op) {
    case 'subtract': return fromMulti(pc.difference(A, B));
    case 'intersect': return fromMulti(pc.intersection(A, B));
    case 'xor': return fromMulti(pc.xor(A, B));
  }
}

/** a point guaranteed to be just inside the ring near its first vertex */
function probePoint(ring: Vec[]): Vec {
  // midpoint of first edge nudged along the inward normal (orientation-agnostic: test both sides)
  const a = ring[0], b = ring[1];
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  const nx = -dy / l, ny = dx / l;
  const p1: Vec = [mx + nx * 0.01, my + ny * 0.01];
  return pointInPolygon(p1, ring) ? p1 : [mx - nx * 0.01, my - ny * 0.01];
}

/** Subtract `cutters` from `subject`. */
export function differenceContours(subject: Contour[], cutters: Ring[]): Contour[] {
  const s = toMulti(subject);
  if (s.length === 0) return [];
  const c = cutters.filter((r) => r.length >= 3).map((r) => [r.map((p) => [p[0], p[1]] as [number, number])]);
  if (c.length === 0) return subject;
  return fromMulti(pc.difference(s as any, ...(c as [any, ...any[]])));
}
