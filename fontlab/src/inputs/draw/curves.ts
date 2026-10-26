/**
 * Curve helpers for the point editor: conversions between the editable
 * `CurveContour` representation (closed loops of cubic Béziers) and the
 * flattened `Contour` polygons the rest of the pipeline consumes.
 * Pure functions, no DOM.
 */
import type { Contour, CurveContour, Vec } from '../../core/glyph';
import { dist, signedArea } from '../../core/geometry';
import { contourToCubics, flattenCubic, isLine, type Cubic } from '../../outline/fitCurves';

/** Straight segment in the canonical form c1 = p0, c2 = p3. */
export function lineSegment(a: Vec, b: Vec): Cubic {
  return [[a[0], a[1]], [a[0], a[1]], [b[0], b[1]], [b[0], b[1]]];
}

/** Elevate a quadratic (p0, q, p1) to a cubic. */
export function quadToCubic(p0: Vec, q: Vec, p1: Vec): Cubic {
  return [
    [p0[0], p0[1]],
    [p0[0] + (2 / 3) * (q[0] - p0[0]), p0[1] + (2 / 3) * (q[1] - p0[1])],
    [p1[0] + (2 / 3) * (q[0] - p1[0]), p1[1] + (2 / 3) * (q[1] - p1[1])],
    [p1[0], p1[1]],
  ];
}

/**
 * Flatten curve contours to polygons. Straight segments contribute only
 * their end point; curved ones `steps` points. The closing duplicate of the
 * start point is dropped; contours with fewer than 3 points are skipped.
 */
export function flattenCurves(curves: CurveContour[], steps = 8): Contour[] {
  const out: Contour[] = [];
  for (const c of curves) {
    if (!c.segments.length) continue;
    const pts: Vec[] = [[c.start[0], c.start[1]]];
    for (const seg of c.segments) {
      if (isLine(seg)) pts.push([seg[3][0], seg[3][1]]);
      else pts.push(...flattenCubic(seg, steps));
    }
    // drop closing duplicate(s)
    while (pts.length > 1 && dist(pts[0], pts[pts.length - 1]) < 1e-6) pts.pop();
    if (pts.length >= 3) out.push({ points: pts });
  }
  return out;
}

/**
 * Fit cubic segments to flattened polygons (corners preserved). Long
 * polygon edges are densified first so that corners of sparse (RDP
 * simplified) straight runs are not merged by the corner detector.
 */
export function curvesFromContours(contours: Contour[]): CurveContour[] {
  const out: CurveContour[] = [];
  for (const c of contours) {
    if (c.points.length < 3) continue;
    const cc = contourToCubics({ points: densify(c.points, 24) });
    if (!cc.segments.length) continue;
    out.push(normaliseContour({ start: cc.start, segments: cc.segments }));
  }
  return out;
}

/**
 * opentype.js path commands (M/L/C/Q/Z) → curve contours, using the same
 * coordinate convention as `pathToContours` (scale, optional y flip).
 * Quadratics are elevated to cubics; open contours are closed with a line.
 * Degenerate contours (|area| < 20 font units², as cleanContours drops) are skipped.
 */
export function curvesFromPathCommands(commands: any[], scale = 1, flipY = true): CurveContour[] {
  const out: CurveContour[] = [];
  const P = (x: number, y: number): Vec => [x * scale + 0, (flipY ? -y : y) * scale + 0]; // "+ 0" normalises -0
  let cur: CurveContour | null = null;
  let last: Vec = [0, 0];
  const flush = () => {
    if (cur && cur.segments.length) {
      closeContour(cur);
      const flat = flattenCurves([cur], 10);
      if (flat.length && Math.abs(signedArea(flat[0].points)) >= 20) out.push(cur);
    }
    cur = null;
  };
  for (const c of commands) {
    switch (c.type) {
      case 'M': flush(); last = P(c.x, c.y); cur = { start: last, segments: [] }; break;
      case 'L': { if (!cur) cur = { start: last, segments: [] }; const e = P(c.x, c.y); if (dist(e, last) > 1e-9) cur.segments.push(lineSegment(last, e)); last = e; break; }
      case 'C': { if (!cur) cur = { start: last, segments: [] }; const e = P(c.x, c.y); cur.segments.push([[last[0], last[1]], P(c.x1, c.y1), P(c.x2, c.y2), e]); last = e; break; }
      case 'Q': { if (!cur) cur = { start: last, segments: [] }; const e = P(c.x, c.y); cur.segments.push(quadToCubic(last, P(c.x1, c.y1), e)); last = e; break; }
      case 'Z': flush(); break;
    }
  }
  flush();
  return out;
}

/** Insert points along closed-polygon edges longer than `maxEdge`. */
export function densify(points: Vec[], maxEdge: number): Vec[] {
  const out: Vec[] = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i], b = points[(i + 1) % n];
    out.push(a);
    const L = dist(a, b);
    const k = Math.ceil(L / maxEdge);
    for (let j = 1; j < k; j++) out.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k]);
  }
  return out;
}

/** Append a closing line if the loop does not end where it starts. */
export function closeContour(c: CurveContour): void {
  if (!c.segments.length) return;
  const end = c.segments[c.segments.length - 1][3];
  if (dist(end, c.start) > 1e-6) c.segments.push(lineSegment(end, c.start));
  else c.segments[c.segments.length - 1][3] = [c.start[0], c.start[1]];
}

/** Ensure segment chaining (p3 of i === p0 of i+1) and a closed loop. */
export function normaliseContour(c: CurveContour): CurveContour {
  const segs = c.segments.map((s) => s.map((p) => [p[0], p[1]] as Vec) as Cubic);
  const out: CurveContour = { start: [c.start[0], c.start[1]], segments: segs };
  if (segs.length) {
    segs[0][0] = [out.start[0], out.start[1]];
    for (let i = 1; i < segs.length; i++) segs[i][0] = [segs[i - 1][3][0], segs[i - 1][3][1]];
    closeContour(out);
  }
  return out;
}

/** Point on a cubic at parameter t. */
export function cubicAt(c: Cubic, t: number): Vec {
  const mt = 1 - t;
  return [
    mt * mt * mt * c[0][0] + 3 * mt * mt * t * c[1][0] + 3 * mt * t * t * c[2][0] + t * t * t * c[3][0],
    mt * mt * mt * c[0][1] + 3 * mt * mt * t * c[1][1] + 3 * mt * t * t * c[2][1] + t * t * t * c[3][1],
  ];
}

/** de Casteljau subdivision at t → two cubics sharing the split point. */
export function splitCubic(c: Cubic, t: number): [Cubic, Cubic] {
  const L = (a: Vec, b: Vec): Vec => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const [p0, p1, p2, p3] = c;
  const p01 = L(p0, p1), p12 = L(p1, p2), p23 = L(p2, p3);
  const p012 = L(p01, p12), p123 = L(p12, p23);
  const m = L(p012, p123);
  if (isLine(c)) return [lineSegment(p0, m), lineSegment(m, p3)];
  return [[[p0[0], p0[1]], p01, p012, m], [[m[0], m[1]], p123, p23, [p3[0], p3[1]]]];
}

/** Nearest parameter on a cubic to point q (coarse sampling + ternary refinement). */
export function nearestT(c: Cubic, q: Vec, samples = 24): { t: number; d: number } {
  let best = 0, bestD = Infinity;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const d = dist(cubicAt(c, t), q);
    if (d < bestD) { bestD = d; best = t; }
  }
  let lo = Math.max(0, best - 1 / samples), hi = Math.min(1, best + 1 / samples);
  for (let k = 0; k < 24; k++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (dist(cubicAt(c, m1), q) < dist(cubicAt(c, m2), q)) hi = m2; else lo = m1;
  }
  const t = (lo + hi) / 2;
  return { t, d: dist(cubicAt(c, t), q) };
}

/**
 * Replace two consecutive segments a (p0..m) and b (m..p3) by one cubic
 * fitted through their sampled points, with end tangents preserved
 * (Schneider's single-cubic least-squares step). Two lines join into a line.
 */
export function joinSegments(a: Cubic, b: Cubic): Cubic {
  const p0 = a[0], p3 = b[3];
  if (isLine(a) && isLine(b)) return lineSegment(p0, p3);
  const chord = dist(p0, p3) || 1;
  const tanOf = (from: Vec, to: Vec, fallbackFrom: Vec, fallbackTo: Vec): Vec => {
    let dx = to[0] - from[0], dy = to[1] - from[1];
    if (Math.hypot(dx, dy) < 1e-6) { dx = fallbackTo[0] - fallbackFrom[0]; dy = fallbackTo[1] - fallbackFrom[1]; }
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  };
  const t1 = tanOf(a[0], a[1], a[0], a[3]);
  const t2 = tanOf(b[3], b[2], b[3], b[0]);
  // sample both pieces with chord-length parameterisation
  const pts: Vec[] = [];
  const N = 12;
  for (let i = 0; i <= N; i++) pts.push(cubicAt(a, i / N));
  for (let i = 1; i <= N; i++) pts.push(cubicAt(b, i / N));
  const u: number[] = [0];
  for (let i = 1; i < pts.length; i++) u.push(u[i - 1] + dist(pts[i - 1], pts[i]));
  const total = u[u.length - 1] || 1;
  for (let i = 0; i < u.length; i++) u[i] /= total;
  let c11 = 0, c12 = 0, c22 = 0, x1 = 0, x2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const t = u[i], mt = 1 - t;
    const b0 = mt * mt * mt, b1 = 3 * mt * mt * t, b2 = 3 * mt * t * t, b3 = t * t * t;
    const a1: Vec = [t1[0] * b1, t1[1] * b1];
    const a2: Vec = [t2[0] * b2, t2[1] * b2];
    c11 += a1[0] * a1[0] + a1[1] * a1[1];
    c12 += a1[0] * a2[0] + a1[1] * a2[1];
    c22 += a2[0] * a2[0] + a2[1] * a2[1];
    const tmp: Vec = [
      pts[i][0] - (b0 * p0[0] + b1 * p0[0] + b2 * p3[0] + b3 * p3[0]),
      pts[i][1] - (b0 * p0[1] + b1 * p0[1] + b2 * p3[1] + b3 * p3[1]),
    ];
    x1 += a1[0] * tmp[0] + a1[1] * tmp[1];
    x2 += a2[0] * tmp[0] + a2[1] * tmp[1];
  }
  const det = c11 * c22 - c12 * c12;
  let alpha1 = 0, alpha2 = 0;
  if (Math.abs(det) > 1e-12) { alpha1 = (x1 * c22 - x2 * c12) / det; alpha2 = (c11 * x2 - c12 * x1) / det; }
  if (!(alpha1 > 1e-6) || !(alpha2 > 1e-6) || alpha1 > chord * 2 || alpha2 > chord * 2) { alpha1 = chord / 3; alpha2 = chord / 3; }
  return [
    [p0[0], p0[1]],
    [p0[0] + t1[0] * alpha1, p0[1] + t1[1] * alpha1],
    [p3[0] + t2[0] * alpha2, p3[1] + t2[1] * alpha2],
    [p3[0], p3[1]],
  ];
}
