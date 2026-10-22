import type { Stroke, Vec, StrokePoint } from '../core/glyph';
import { resampleStroke } from '../core/geometry';

export type Ring = Vec[];

/**
 * Expand a variable-width centreline stroke into ONE closed ribbon polygon:
 * left offsets forward, round cap, right offsets backward, round cap, with
 * round joins (arc fans) on the outer side of each turn. The ribbon may
 * self-intersect on the inner side of tight turns; polygon-clipping applies
 * the nonzero rule to self-crossing rings (same convention Skia's stroker
 * relies on), so `unionRings` resolves that correctly and cheaply.
 */
export function expandStroke(stroke: Stroke, opts: { spacing?: number; arcStep?: number } = {}): Ring[] {
  const pts = sanitize(stroke.points);
  if (pts.length === 0) return [];
  const minW = Math.max(1, Math.min(...pts.map((p) => p.w)));
  const spacing = opts.spacing ?? Math.max(5, Math.min(16, minW * 1.1));
  const arcStep = opts.arcStep ?? Math.PI / 9; // 20° per arc point

  if (pts.length === 1) return [disc(pts[0].x, pts[0].y, pts[0].w)];

  const rs = resampleStroke(pts, spacing);
  if (rs.length < 2) return [disc(rs[0].x, rs[0].y, rs[0].w)];
  const taper = stroke.cap === 'taper';
  const n = rs.length;
  const w = rs.map((p, i) => capWidth(p.w, i, n, taper));

  // segment directions
  const dir: Vec[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = rs[i + 1].x - rs[i].x, dy = rs[i + 1].y - rs[i].y;
    const l = Math.hypot(dx, dy) || 1;
    dir.push([dx / l, dy / l]);
  }
  const left: Vec[] = [];
  const right: Vec[] = [];
  const pushOffsets = (i: number, d: Vec) => {
    const nx = -d[1], ny = d[0];
    left.push([rs[i].x + nx * w[i], rs[i].y + ny * w[i]]);
    right.push([rs[i].x - nx * w[i], rs[i].y - ny * w[i]]);
  };
  pushOffsets(0, dir[0]);
  for (let i = 1; i < n - 1; i++) {
    const d0 = dir[i - 1], d1 = dir[i];
    const cross = d0[0] * d1[1] - d0[1] * d1[0];
    const dot = d0[0] * d1[0] + d0[1] * d1[1];
    const ang = Math.atan2(cross, dot);
    if (Math.abs(ang) < 1e-3) { pushOffsets(i, d1); continue; }
    // outer side gets an arc fan; inner side just gets both offsets (self-crossing is fine)
    const a0 = Math.atan2(d0[1], d0[0]) + Math.PI / 2;
    const steps = Math.max(1, Math.ceil(Math.abs(ang) / arcStep));
    if (ang < 0) {
      // right turn: left is outer
      for (let s = 0; s <= steps; s++) {
        const t = a0 + (ang * s) / steps;
        left.push([rs[i].x + Math.cos(t) * w[i], rs[i].y + Math.sin(t) * w[i]]);
      }
      pushInner(right, rs[i], w[i], [d0[1], -d0[0]], [d1[1], -d1[0]], ang);
    } else {
      // left turn: right is outer
      pushInner(left, rs[i], w[i], [-d0[1], d0[0]], [-d1[1], d1[0]], ang);
      const b0 = a0 + Math.PI;
      for (let s = 0; s <= steps; s++) {
        const t = b0 + (ang * s) / steps;
        right.push([rs[i].x + Math.cos(t) * w[i], rs[i].y + Math.sin(t) * w[i]]);
      }
    }
  }
  pushOffsets(n - 1, dir[n - 2]);

  const ring: Ring = [...left];
  // end cap
  if (stroke.cap !== 'flat' || taper) ring.push(...arc(rs[n - 1], w[n - 1], dir[n - 2], arcStep));
  for (let i = right.length - 1; i >= 0; i--) ring.push(right[i]);
  // start cap
  if (stroke.cap !== 'flat' || taper) ring.push(...arc(rs[0], w[0], [-dir[0][0], -dir[0][1]], arcStep));
  return [ring];
}


/** Inner side of a join: a single miter point for moderate angles (keeps the
 *  outline clean), both raw offsets for very sharp turns (self-crossing is
 *  resolved by the nonzero union). */
function pushInner(arr: Vec[], p: StrokePoint, w: number, n0: Vec, n1: Vec, ang: number) {
  if (Math.abs(ang) < (120 * Math.PI) / 180) {
    const mx = n0[0] + n1[0], my = n0[1] + n1[1];
    const ml = Math.hypot(mx, my) || 1;
    const k = w / Math.cos(ang / 2);
    arr.push([p.x + (mx / ml) * k, p.y + (my / ml) * k]);
  } else {
    arr.push([p.x + n0[0] * w, p.y + n0[1] * w]);
    arr.push([p.x + n1[0] * w, p.y + n1[1] * w]);
  }
}

/** semicircle from +90° to -90° around direction d (sweeping over the tip). */
function arc(p: StrokePoint, r: number, d: Vec, step: number): Vec[] {
  const base = Math.atan2(d[1], d[0]);
  const steps = Math.max(2, Math.ceil(Math.PI / step));
  const out: Vec[] = [];
  for (let s = 1; s < steps; s++) {
    const t = base + Math.PI / 2 - (Math.PI * s) / steps;
    out.push([p.x + Math.cos(t) * r, p.y + Math.sin(t) * r]);
  }
  return out;
}

function capWidth(w: number, i: number, n: number, taper: boolean): number {
  if (!taper) return w;
  const fade = 5;
  const d = Math.min(i, n - 1 - i);
  const t = Math.min(1, (d + 0.5) / fade);
  return Math.max(0.5, w * (0.15 + 0.85 * t));
}

export function disc(cx: number, cy: number, r: number, segments = 18): Ring {
  const ring: Ring = [];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    ring.push([cx + Math.cos(t) * r, cy + Math.sin(t) * r]);
  }
  return ring;
}

function sanitize(points: StrokePoint[]): StrokePoint[] {
  const out: StrokePoint[] = [];
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const q = out[out.length - 1];
    if (q && Math.hypot(p.x - q.x, p.y - q.y) < 0.25) { q.w = Math.max(q.w, p.w); continue; }
    out.push({ x: p.x, y: p.y, w: Math.max(0.5, Math.abs(p.w)), p: p.p });
  }
  return out;
}
