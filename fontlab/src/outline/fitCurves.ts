import fitCurve from 'fit-curve';
import type { Contour, Vec } from '../core/glyph';
import { dist, dedupe, simplifyRDP, signedArea } from '../core/geometry';

export type Cubic = [Vec, Vec, Vec, Vec];

export interface CurvedContour {
  start: Vec;
  segments: Cubic[];
}

/** Drop slivers and simplify micro-facets left by boolean ops. */
export function cleanContours(contours: Contour[], minArea = 120, tol = 0.6): Contour[] {
  const out: Contour[] = [];
  for (const c of contours) {
    if (Math.abs(signedArea(c.points)) < minArea) continue;
    const closed = c.points.concat([c.points[0]]);
    let pts = simplifyRDP(closed, tol);
    pts = dedupe(pts, 0.05);
    if (pts.length >= 3) out.push({ points: pts });
  }
  return out;
}

/**
 * Convert a flattened closed polygon into cubic Bézier segments.
 * Corners (sharp direction changes measured over a lookahead distance) are
 * preserved as segment boundaries; smooth runs are fitted with fit-curve.
 */
export function contourToCubics(contour: Contour, maxError = 1.5, cornerDeg = 55, lookahead = 6): CurvedContour {
  const pts = dedupe(contour.points, 0.05);
  if (pts.length < 3) return { start: pts[0] ?? [0, 0], segments: [] };
  const n = pts.length;
  const cornerCos = Math.cos((cornerDeg * Math.PI) / 180);
  const corners: number[] = [];
  for (let i = 0; i < n; i++) {
    const q = pts[i];
    const p = walk(pts, i, -1, lookahead), r = walk(pts, i, +1, lookahead);
    const ax = q[0] - p[0], ay = q[1] - p[1], bx = r[0] - q[0], by = r[1] - q[1];
    const la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1;
    const cos = (ax * bx + ay * by) / (la * lb);
    if (cos < cornerCos) corners.push(i);
  }
  // collapse runs of adjacent corner candidates to the sharpest-looking middle one
  const merged: number[] = [];
  for (let k = 0; k < corners.length; k++) {
    let j = k;
    while (j + 1 < corners.length && corners[j + 1] - corners[j] <= 2) j++;
    merged.push(corners[Math.floor((k + j) / 2)]);
    k = j;
  }
  const startIdx = merged.length ? merged[0] : 0;
  const rotated = pts.slice(startIdx).concat(pts.slice(0, startIdx));
  const cornerSet = new Set(merged.map((c) => (c - startIdx + n) % n));
  const segments: Cubic[] = [];
  let runStart = 0;
  const flush = (a: number, b: number, closing: boolean) => {
    const run = rotated.slice(a, b + 1);
    if (closing) run.push(rotated[0]);
    if (run.length < 2) return;
    if (run.length === 2) { segments.push(lineCubic(run[0], run[1])); return; }
    const curves = fitCurve(run as [number, number][], maxError * maxError) as unknown as Cubic[];
    for (const c of curves) segments.push(c.map((p) => [p[0], p[1]] as Vec) as Cubic);
  };
  for (let i = 1; i < n; i++) {
    if (cornerSet.has(i)) { flush(runStart, i, false); runStart = i; }
  }
  flush(runStart, n - 1, true);
  if (segments.length) segments[segments.length - 1][3] = [rotated[0][0], rotated[0][1]];
  return { start: rotated[0], segments };
}

/** walk along a closed polyline from i in direction dir until `d` units away. */
function walk(pts: Vec[], i: number, dir: 1 | -1, d: number): Vec {
  const n = pts.length;
  let acc = 0, j = i;
  for (let k = 0; k < n; k++) {
    const nj = (j + dir + n) % n;
    acc += dist(pts[j], pts[nj]);
    j = nj;
    if (acc >= d) break;
  }
  return pts[j];
}

function lineCubic(a: Vec, b: Vec): Cubic {
  return [a, [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3], [a[0] + (2 * (b[0] - a[0])) / 3, a[1] + (2 * (b[1] - a[1])) / 3], b];
}

export function isLine(c: Cubic, eps = 0.3): boolean {
  const [a, c1, c2, b] = c;
  const l = dist(a, b) || 1;
  const d = (p: Vec) => Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / l;
  return d(c1) < eps && d(c2) < eps;
}

export function flattenCubic(c: Cubic, steps = 8): Vec[] {
  const out: Vec[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, mt = 1 - t;
    out.push([
      mt * mt * mt * c[0][0] + 3 * mt * mt * t * c[1][0] + 3 * mt * t * t * c[2][0] + t * t * t * c[3][0],
      mt * mt * mt * c[0][1] + 3 * mt * mt * t * c[1][1] + 3 * mt * t * t * c[2][1] + t * t * t * c[3][1],
    ]);
  }
  return out;
}
