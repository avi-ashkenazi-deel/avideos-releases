import type { Glyph, Vec, Contour } from '../core/glyph';
import { bboxContours, bboxStrokes, dist, signedArea, type BBox } from '../core/geometry';

export function glyphBBox(g: Glyph): BBox {
  if (g.kind === 'stroke') return bboxStrokes(g.strokes ?? []);
  const b = bboxContours(g.contours ?? []);
  if (!g.strokes?.length) return b;
  const s = bboxStrokes(g.strokes);
  return { minX: Math.min(b.minX, s.minX), minY: Math.min(b.minY, s.minY), maxX: Math.max(b.maxX, s.maxX), maxY: Math.max(b.maxY, s.maxY) };
}

/** Apply a point map to every coordinate of a glyph (strokes keep w/p). */
export function mapGlyph(g: Glyph, f: (p: Vec) => Vec): Glyph {
  if (g.kind === 'stroke') {
    return {
      ...g,
      strokes: (g.strokes ?? []).map((s) => ({
        ...s,
        points: s.points.map((p) => { const [x, y] = f([p.x, p.y]); return { ...p, x, y }; }),
      })),
    };
  }
  return { ...g, contours: (g.contours ?? []).map((c) => ({ points: c.points.map(f) })) };
}

/** Insert evenly spaced points along each edge of a closed ring, keeping every original vertex. */
export function densifyClosed(points: Vec[], spacing: number): Vec[] {
  const n = points.length;
  if (n < 3) return points.slice();
  const out: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const a = points[i], b = points[(i + 1) % n];
    out.push(a);
    const d = dist(a, b);
    const steps = Math.floor(d / spacing);
    for (let s = 1; s <= steps; s++) {
      const t = s / (steps + 1);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/**
 * Per-vertex unit normals of a closed ring pointing AWAY from the ink:
 * (dy, -dx) is outward for CCW outers and points into the hole for CW holes.
 */
export function ringNormals(points: Vec[]): Vec[] {
  const n = points.length;
  const out: Vec[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = points[(i - 1 + n) % n], q = points[(i + 1) % n];
    const dx = q[0] - p[0], dy = q[1] - p[1];
    const l = Math.hypot(dx, dy) || 1;
    out[i] = [dy / l, -dx / l];
  }
  return out;
}

/** Net ink area (outers positive, holes negative). */
export function inkArea(contours: Contour[]): number {
  let a = 0;
  for (const c of contours) a += signedArea(c.points);
  return a;
}

export const deg2rad = (d: number) => (d * Math.PI) / 180;
