import type { Vec, Contour, Stroke, StrokePoint } from './glyph';

export const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1]];
export const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1]];
export const scale = (a: Vec, s: number): Vec => [a[0] * s, a[1] * s];
export const len = (a: Vec): number => Math.hypot(a[0], a[1]);
export const dist = (a: Vec, b: Vec): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const norm = (a: Vec): Vec => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };
export const perp = (a: Vec): Vec => [-a[1], a[0]];
export const lerp = (a: Vec, b: Vec, t: number): Vec => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const lerpN = (a: number, b: number, t: number) => a + (b - a) * t;

export interface BBox { minX: number; minY: number; maxX: number; maxY: number }

export function bboxOf(points: Iterable<Vec>): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (minX === Infinity) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

export function bboxContours(contours: Contour[]): BBox {
  return bboxOf(contours.flatMap((c) => c.points));
}

export function bboxStrokes(strokes: Stroke[]): BBox {
  const pts: Vec[] = [];
  for (const s of strokes) for (const p of s.points) {
    pts.push([p.x - p.w, p.y - p.w], [p.x + p.w, p.y + p.w]);
  }
  return bboxOf(pts);
}

/** Signed area; positive = counter-clockwise in y-up coordinates. */
export function signedArea(poly: Vec[]): number {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function centroid(poly: Vec[]): Vec {
  let x = 0, y = 0;
  for (const p of poly) { x += p[0]; y += p[1]; }
  const n = poly.length || 1;
  return [x / n, y / n];
}

/** Ramer–Douglas–Peucker simplification on an open polyline. */
export function simplifyRDP(points: Vec[], tolerance: number): Vec[] {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1; keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  const t2 = tolerance * tolerance;
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0, idx = -1;
    const a = points[s], b = points[e];
    for (let i = s + 1; i < e; i++) {
      const d = segDist2(points[i], a, b);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > t2 && idx > 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return points.filter((_, i) => keep[i]);
}

function segDist2(p: Vec, a: Vec, b: Vec): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  const px = a[0] + t * dx - p[0], py = a[1] + t * dy - p[1];
  return px * px + py * py;
}

/** Catmull-Rom resample of an open polyline into roughly even spacing. */
export function smoothResample(points: Vec[], spacing: number): Vec[] {
  if (points.length < 2) return points.slice();
  if (points.length === 2) return resampleLinear(points, spacing);
  const out: Vec[] = [];
  const P = (i: number) => points[clamp(i, 0, points.length - 1)];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const segLen = dist(p1, p2);
    const steps = Math.max(1, Math.ceil(segLen / spacing));
    for (let s = 0; s < steps; s++) {
      const t = s / steps, t2 = t * t, t3 = t2 * t;
      out.push([
        0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

export function resampleLinear(points: Vec[], spacing: number): Vec[] {
  if (points.length < 2) return points.slice();
  const out: Vec[] = [points[0]];
  let carry = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const d = dist(a, b);
    if (d === 0) continue;
    let t = (spacing - carry) / d;
    while (t <= 1) {
      out.push(lerp(a, b, t));
      t += spacing / d;
    }
    carry = d - (t - spacing / d) * d;
  }
  const last = points[points.length - 1];
  if (dist(out[out.length - 1], last) > 1e-6) out.push(last);
  return out;
}

/** Resample a stroke's points (keeping widths) to even spacing. */
export function resampleStroke(points: StrokePoint[], spacing: number): StrokePoint[] {
  if (points.length < 2) return points.slice();
  const out: StrokePoint[] = [{ ...points[0] }];
  let acc = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d === 0) continue;
    let pos = spacing - acc;
    while (pos <= d) {
      const t = pos / d;
      out.push({ x: lerpN(a.x, b.x, t), y: lerpN(a.y, b.y, t), w: lerpN(a.w, b.w, t), p: a.p });
      pos += spacing;
    }
    acc = d - (pos - spacing);
  }
  const last = points[points.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(tail.x - last.x, tail.y - last.y) > 1e-6) out.push({ ...last });
  return out;
}

/** Apply an affine [a b c d e f] mapping (x,y) -> (a x + c y + e, b x + d y + f). */
export type Affine = [number, number, number, number, number, number];
export const affineApply = (m: Affine, p: Vec): Vec => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
export const affineIdentity: Affine = [1, 0, 0, 1, 0, 0];
export const affineShear = (slantDeg: number): Affine => [1, 0, Math.tan((slantDeg * Math.PI) / 180), 1, 0, 0];
export const affineTranslate = (dx: number, dy: number): Affine => [1, 0, 0, 1, dx, dy];
export const affineScale = (sx: number, sy: number, ox = 0, oy = 0): Affine => [sx, 0, 0, sy, ox - sx * ox, oy - sy * oy];

export function mapContours(contours: Contour[], f: (p: Vec) => Vec): Contour[] {
  return contours.map((c) => ({ points: c.points.map(f) }));
}
export function mapStrokes(strokes: Stroke[], f: (p: StrokePoint) => StrokePoint): Stroke[] {
  return strokes.map((s) => ({ ...s, points: s.points.map(f) }));
}

/** Remove consecutive duplicates and near-zero segments. */
export function dedupe(points: Vec[], eps = 0.01): Vec[] {
  const out: Vec[] = [];
  for (const p of points) {
    const q = out[out.length - 1];
    if (!q || dist(p, q) > eps) out.push(p);
  }
  if (out.length > 2 && dist(out[0], out[out.length - 1]) <= eps) out.pop();
  return out;
}

export function pointInPolygon(p: Vec, poly: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    const hit = (yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi + 1e-12) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}
