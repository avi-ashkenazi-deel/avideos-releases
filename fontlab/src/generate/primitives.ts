/**
 * Parametric stroke primitives. All coordinates are font units (1000/em,
 * baseline y = 0, y up). Every primitive returns a densely sampled centreline
 * `Stroke` (a vertex roughly every STEP units) so later DNA / mutation passes
 * have vertices to displace. Width comes from StyleStats.strokeWidth (full
 * width; point `w` is the half width), cap style from StyleStats.terminal.
 *
 * Angles are degrees in standard maths orientation: 0 = +x (right),
 * 90 = +y (up). An arc sweeps from a0 to a1 in the signed direction, so
 * a1 > a0 is counter-clockwise and a1 < a0 clockwise.
 */
import type { CapStyle, Stroke, StrokePoint, StyleStats, Vec } from '../core/glyph';
import type { Rng } from '../core/prng';
import { clamp, dist, smoothResample } from '../core/geometry';

export interface PrimCtx {
  stats: StyleStats;
  rng: Rng;
  /** 0..1 */
  mutation: number;
}

export const STEP = 12;
const DEG = Math.PI / 180;

/* ------------------------------------------------------------------ */
/* point-array builders (no width, no rng)                              */
/* ------------------------------------------------------------------ */

export function linePts(x0: number, y0: number, x1: number, y1: number, step = STEP): Vec[] {
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
  const out: Vec[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
  }
  return out;
}

export function arcPts(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, step = STEP): Vec[] {
  const sweep = a1 - a0;
  const approxLen = Math.abs(sweep) * DEG * ((Math.abs(rx) + Math.abs(ry)) / 2);
  const n = Math.max(4, Math.ceil(approxLen / step));
  const out: Vec[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (a0 + (sweep * i) / n) * DEG;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
}

/** Concatenate point runs, dropping coincident junction points. */
export function joinPts(...pieces: Vec[][]): Vec[] {
  const out: Vec[] = [];
  for (const piece of pieces) {
    for (const p of piece) {
      const q = out[out.length - 1];
      if (!q || dist(p, q) > 0.5) out.push(p);
    }
  }
  return out;
}

/** Smooth Catmull-Rom curve through control points, densely resampled. */
export function curvePts(ctrl: Vec[], step = STEP): Vec[] {
  return smoothResample(ctrl, step);
}

/** Polyline with (sharp) corners, each segment densified. */
export function polyPts(pts: Vec[], step = STEP): Vec[] {
  const pieces: Vec[][] = [];
  for (let i = 0; i < pts.length - 1; i++) pieces.push(linePts(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], step));
  return pts.length < 2 ? pts.slice() : joinPts(...pieces);
}

/* ------------------------------------------------------------------ */
/* stroke construction                                                  */
/* ------------------------------------------------------------------ */

export interface StrokeOpts {
  cap?: CapStyle;
  /** multiply the stroke width (e.g. 0.85 for hairline-ish bars) */
  widthMul?: number;
}

export function halfWidth(stats: StyleStats): number {
  const sw = Number.isFinite(stats.strokeWidth) ? stats.strokeWidth : 90;
  return clamp(sw, 4, 400) / 2;
}

function mut(ctx: PrimCtx): number {
  return clamp(Number.isFinite(ctx.mutation) ? ctx.mutation : 0, 0, 1);
}

/** Wrap a point run into a Stroke with width (+ subtle seeded width variation). */
export function strokeFrom(ctx: PrimCtx, pts: Vec[], opts: StrokeOpts = {}): Stroke {
  const m = mut(ctx);
  const hw = halfWidth(ctx.stats) * (opts.widthMul ?? 1) * (1 + clamp(ctx.rng.gauss(0, 0.05 * m), -0.2, 0.2));
  const salt = ctx.rng.range(0, 100);
  const wv = clamp(Number.isFinite(ctx.stats.widthVariance) ? ctx.stats.widthVariance : 0, 0, 1) * 0.35;
  const cap: CapStyle = opts.cap ?? ctx.stats.terminal ?? 'round';
  const points: StrokePoint[] = pts.map(([x, y], i) => ({
    x, y,
    w: Math.max(0.5, hw * (1 + (wv > 0 ? wv * ctx.rng.noise2(i * 0.12 + salt, salt) : 0))),
  }));
  return { id: '', points, cap };
}

/** ±(4% * mutation) size jitter factor. */
function sizeJitter(ctx: PrimCtx): number {
  return clamp(1 + ctx.rng.gauss(0, 0.04 * mut(ctx)), 0.9, 1.1);
}

/** small endpoint jitter in units, scaled by mutation */
function endJitter(ctx: PrimCtx): number {
  return ctx.rng.gauss(0, 3 * mut(ctx));
}

/* ------------------------------------------------------------------ */
/* primitives                                                           */
/* ------------------------------------------------------------------ */

export function line(ctx: PrimCtx, x0: number, y0: number, x1: number, y1: number, opts?: StrokeOpts): Stroke {
  const j = endJitter(ctx), k = endJitter(ctx);
  return strokeFrom(ctx, linePts(x0, y0 + j, x1, y1 + k), opts);
}

/** vertical stem at x from y0 to y1 */
export function stem(ctx: PrimCtx, x: number, y0: number, y1: number, opts?: StrokeOpts): Stroke {
  const j = endJitter(ctx);
  return strokeFrom(ctx, linePts(x + j * 0.3, y0, x + j * 0.3, y1), opts);
}

/** horizontal bar at y from x0 to x1 */
export function bar(ctx: PrimCtx, x0: number, x1: number, y: number, opts?: StrokeOpts): Stroke {
  const j = endJitter(ctx);
  return strokeFrom(ctx, linePts(x0, y + j * 0.3, x1, y + j * 0.3), opts);
}

export function diagonal(ctx: PrimCtx, x0: number, y0: number, x1: number, y1: number, opts?: StrokeOpts): Stroke {
  return line(ctx, x0, y0, x1, y1, opts);
}

/** elliptical arc centred (cx,cy), radii rx/ry, from a0 to a1 degrees (signed sweep). */
export function arc(ctx: PrimCtx, cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, opts?: StrokeOpts): Stroke {
  const s = sizeJitter(ctx);
  return strokeFrom(ctx, arcPts(cx, cy, rx * s, ry * s, a0, a1), opts);
}

/** closed ellipse (bowl / counter), starting and ending at the top. */
export function bowl(ctx: PrimCtx, cx: number, cy: number, rx: number, ry: number, opts?: StrokeOpts): Stroke {
  const s = sizeJitter(ctx);
  const pts = arcPts(cx, cy, rx * s, ry * s, 90, 450);
  // overlap the seam slightly so the join is seamless after expansion
  pts.push(...arcPts(cx, cy, rx * s, ry * s, 450, 470).slice(1));
  return strokeFrom(ctx, pts, opts);
}

/**
 * Arch for n / m / h: starts on the left stem at (x0, yTop - ry), sweeps over
 * the shoulder to the right stem and runs down to (x1, yFoot).
 */
export function arch(ctx: PrimCtx, x0: number, x1: number, yTop: number, yFoot: number, ry: number, opts?: StrokeOpts): Stroke {
  const s = sizeJitter(ctx);
  const rx = (x1 - x0) / 2;
  const cy = yTop - ry;
  const pts = joinPts(
    arcPts(x0 + rx, cy, rx, ry * s, 180, 0),
    linePts(x1, cy, x1, yFoot),
  );
  return strokeFrom(ctx, pts, opts);
}

/**
 * Cup for u / U / J-like bottoms: from (x0, yTop) down the left, round
 * bottom (lowest point at yBottom), up the right to (x1, yTop).
 */
export function cup(ctx: PrimCtx, x0: number, x1: number, yTop: number, yBottom: number, ry: number, opts?: StrokeOpts): Stroke {
  const s = sizeJitter(ctx);
  const rx = (x1 - x0) / 2;
  const cy = yBottom + ry;
  const pts = joinPts(
    linePts(x0, yTop, x0, cy),
    arcPts(x0 + rx, cy, rx, ry * s, 180, 360),
    linePts(x1, cy, x1, yTop),
  );
  return strokeFrom(ctx, pts, opts);
}

/** short terminal hook: an arc, tapered if the style terminal is taper. */
export function hook(ctx: PrimCtx, cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, opts?: StrokeOpts): Stroke {
  return arc(ctx, cx, cy, rx, ry, a0, a1, opts);
}

/** dot (i / j): a single point whose half width is r. */
export function dot(ctx: PrimCtx, x: number, y: number, r: number): Stroke {
  const s = sizeJitter(ctx);
  const jx = endJitter(ctx) * 0.5, jy = endJitter(ctx) * 0.5;
  return { id: '', cap: 'round', points: [{ x: x + jx, y: y + jy, w: Math.max(1, r * s) }] };
}

/** generic path from an arbitrary (already dense) point run */
export function path(ctx: PrimCtx, pts: Vec[], opts?: StrokeOpts): Stroke {
  return strokeFrom(ctx, pts, opts);
}

/** polyline with corners */
export function poly(ctx: PrimCtx, pts: Vec[], opts?: StrokeOpts): Stroke {
  return strokeFrom(ctx, polyPts(pts), opts);
}

/** smooth curve through control points */
export function curve(ctx: PrimCtx, ctrl: Vec[], opts?: StrokeOpts): Stroke {
  return strokeFrom(ctx, curvePts(ctrl), opts);
}
