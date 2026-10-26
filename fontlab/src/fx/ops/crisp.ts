/**
 * Crisp effects: deterministic geometric changes that keep corners sharp,
 * for "mutate it a little but keep it like the original". All outline-stage.
 */
import type { Contour, Vec } from '../../core/glyph';
import { bboxContours, clamp, dedupe, dist, signedArea } from '../../core/geometry';
import type { FxCtx, OutlineOp } from '../types';
import { normalizeContours } from '../../dna/clip';
import { differenceContours } from '../../outline/union';

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : d);

/** indices of real corners (angle over a lookahead distance, so curve facets don't count) */
export function findCorners(ring: Vec[], minDeg = 35, lookahead = 8): number[] {
  const n = ring.length;
  if (n < 3) return [];
  const cosMin = Math.cos((minDeg * Math.PI) / 180);
  const walk = (i: number, dir: 1 | -1) => { let acc = 0, j = i; for (let k = 0; k < n; k++) { const nj = (j + dir + n) % n; acc += dist(ring[j], ring[nj]); j = nj; if (acc >= lookahead) break; } return ring[j]; };
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = walk(i, -1), q = ring[i], r = walk(i, 1);
    const ax = q[0] - p[0], ay = q[1] - p[1], bx = r[0] - q[0], by = r[1] - q[1];
    const la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1;
    if ((ax * bx + ay * by) / (la * lb) < cosMin) out.push(i);
  }
  // collapse runs of adjacent candidates to their middle
  const merged: number[] = [];
  // (adjacent by distance, not by index: a 4-vertex square has 4 real corners)
  for (let k = 0; k < out.length; k++) { let j = k; while (j + 1 < out.length && out[j + 1] - out[j] <= 2 && dist(ring[out[j]], ring[out[j + 1]]) <= lookahead) j++; merged.push(out[Math.floor((k + j) / 2)]); k = j; }
  return merged;
}

/** point at `d` units from ring[i] walking along the ring in direction dir */
function along(ring: Vec[], i: number, dir: 1 | -1, d: number): Vec {
  const n = ring.length;
  let j = i, left = d;
  for (let k = 0; k < n; k++) {
    const nj = (j + dir + n) % n;
    const seg = dist(ring[j], ring[nj]);
    if (seg >= left) { const t = seg ? left / seg : 0; return [ring[j][0] + (ring[nj][0] - ring[j][0]) * t, ring[j][1] + (ring[nj][1] - ring[j][1]) * t]; }
    left -= seg; j = nj;
  }
  return ring[j];
}

/** is the turn at corner i convex with respect to the ink? (CCW outer: left turn = convex) */
function convexAt(ring: Vec[], i: number, ccw: boolean): boolean {
  const n = ring.length;
  const p = ring[(i - 1 + n) % n], q = ring[i], r = ring[(i + 1) % n];
  const cross = (q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]);
  return ccw ? cross > 0 : cross < 0;
}

/** Replace each selected corner by `make(a, v, b)` points; keeps everything else verbatim. */
function reshapeCorners(contours: Contour[], size: number, pick: (ring: Vec[], i: number, ccw: boolean, k: number) => boolean, make: (a: Vec, v: Vec, b: Vec, inward: Vec) => Vec[]): Contour[] {
  return contours.map((c) => {
    const ring = dedupe(c.points, 0.05);
    const n = ring.length;
    if (n < 4) return c;
    const ccw = signedArea(ring) > 0;
    const corners = new Set(findCorners(ring).filter((i, k) => pick(ring, i, ccw, k)));
    if (!corners.size) return c;
    const out: Vec[] = [];
    for (let i = 0; i < n; i++) {
      if (!corners.has(i)) { out.push(ring[i]); continue; }
      const prevL = dist(ring[(i - 1 + n) % n], ring[i]), nextL = dist(ring[i], ring[(i + 1) % n]);
      const s = Math.min(size, prevL * 0.9, nextL * 0.9, 1e9);
      if (s < 0.5) { out.push(ring[i]); continue; }
      const a = along(ring, i, -1, s), b = along(ring, i, 1, s);
      // inward unit vector (into the ink) = bisector pointing away from the corner for convex, toward for concave
      const mx = (a[0] + b[0]) / 2 - ring[i][0], my = (a[1] + b[1]) / 2 - ring[i][1];
      const ml = Math.hypot(mx, my) || 1;
      const inward: Vec = convexAt(ring, i, ccw) ? [mx / ml, my / ml] : [-mx / ml, -my / ml];
      out.push(...make(a, ring[i], b, inward));
    }
    return { points: out };
  });
}

/** bevel corners; `chance` < 1 turns it into a seeded "fracture" on some corners only */
export const chamfer: OutlineOp = (contours, p, ctx) => {
  const size = num(p.size, 2, 120, 24), chance = num(p.chance, 0, 1, 1), convexOnly = num(p.convexOnly, 0, 1, 1) >= 0.5;
  const rolls = new Map<string, boolean>();
  const roll = (key: string) => { if (!rolls.has(key)) rolls.set(key, ctx.rng() < chance); return rolls.get(key)!; };
  const out = reshapeCorners(contours, size, (ring, i, ccw) => (!convexOnly || convexAt(ring, i, ccw)) && roll(`${ring[i][0].toFixed(0)},${ring[i][1].toFixed(0)}`), (a, _v, b) => [a, b]);
  return normalizeContours(out);
};

/** true vector corner rounding (quadratic arc through the corner) */
export const roundVec: OutlineOp = (contours, p) => {
  const radius = num(p.radius, 2, 120, 20), steps = 6;
  const out = reshapeCorners(contours, radius, () => true, (a, v, b) => {
    const pts: Vec[] = [];
    for (let s = 0; s <= steps; s++) { const t = s / steps, mt = 1 - t; pts.push([mt * mt * a[0] + 2 * mt * t * v[0] + t * t * b[0], mt * mt * a[1] + 2 * mt * t * v[1] + t * t * b[1]]); }
    return pts;
  });
  return normalizeContours(out);
};

/** ink traps: notches cut into the ink at concave corners (where strokes meet) */
export const inkTrap: OutlineOp = (contours, p) => {
  const depth = num(p.depth, 2, 80, 18), width = num(p.width, 2, 120, 22);
  const out = reshapeCorners(contours, width, (ring, i, ccw) => !convexAt(ring, i, ccw), (a, v, b, inward) => [a, [v[0] + inward[0] * depth, v[1] + inward[1] * depth], b]);
  return normalizeContours(out);
};

/** anisotropic scale about the baseline / left sidebearing: condensed, extended, tall, squat */
export const stretch: OutlineOp = (contours, p) => {
  const sx = num(p.width, 0.4, 2.2, 1), sy = num(p.height, 0.4, 2.2, 1);
  if (sx === 1 && sy === 1) return contours;
  const b = bboxContours(contours);
  const x0 = b.minX;
  return contours.map((c) => ({ points: c.points.map(([x, y]) => [x0 + (x - x0) * sx, y * sy] as Vec) }));
};

/** scale lowercase glyphs only (x-height play) */
export const xHeight: OutlineOp = (contours, p, ctx) => {
  const sy = num(p.scale, 0.6, 1.6, 1.15);
  const ch = ctx.glyph.char;
  const lower = ch.length > 0 && ch.toLowerCase() === ch && ch.toUpperCase() !== ch;
  if (!lower || sy === 1) return contours;
  return contours.map((c) => ({ points: c.points.map(([x, y]) => [x, y * sy] as Vec) }));
};

/** stencil bridges: subtract thin bars across the glyph at a regular spacing */
export const stencil: OutlineOp = (contours, p, ctx) => {
  const gap = num(p.gap, 2, 60, 14), spacing = num(p.spacing, 40, 600, 180), angleDeg = num(p.angle, -90, 90, 0), phase = num(p.phase, 0, 1, 0.35), jitter = num(p.jitter, 0, 1, 0);
  const b = bboxContours(contours);
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const R = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2 + gap;
  const a = (angleDeg * Math.PI) / 180;
  const ux = Math.cos(a), uy = Math.sin(a);          // bar direction
  const nx = -uy, ny = ux;                            // across bars
  const bars: Vec[][] = [];
  const start = -R + spacing * phase;
  for (let o = start; o <= R; o += spacing) {
    const off = o + (jitter ? (ctx.rng() - 0.5) * spacing * 0.5 * jitter : 0);
    const c0x = cx + nx * off, c0y = cy + ny * off;
    const h = gap / 2;
    bars.push([
      [c0x - ux * R - nx * h, c0y - uy * R - ny * h], [c0x + ux * R - nx * h, c0y + uy * R - ny * h],
      [c0x + ux * R + nx * h, c0y + uy * R + ny * h], [c0x - ux * R + nx * h, c0y - uy * R + ny * h],
    ]);
  }
  const out = differenceContours(contours, bars);
  return out.length ? out : contours;
};

/** miter-join offset: bold/thin with corners kept sharp (bevels only past the miter limit) */
export function offsetMiter(contours: Contour[], d: number, miterLimit = 4): Contour[] {
  if (Math.abs(d) < 0.01) return contours;
  const out: Contour[] = [];
  for (const c of contours) {
    const ring = dedupe(c.points, 0.05);
    const n = ring.length;
    if (n < 3) continue;
    const pts: Vec[] = [];
    for (let i = 0; i < n; i++) {
      const p = ring[(i - 1 + n) % n], q = ring[i], r = ring[(i + 1) % n];
      const e1: Vec = [q[0] - p[0], q[1] - p[1]], e2: Vec = [r[0] - q[0], r[1] - q[1]];
      const l1 = Math.hypot(e1[0], e1[1]) || 1, l2 = Math.hypot(e2[0], e2[1]) || 1;
      // outward normal (right of travel for CCW outers; same formula shrinks CW holes)
      const n1: Vec = [e1[1] / l1, -e1[0] / l1], n2: Vec = [e2[1] / l2, -e2[0] / l2];
      const mx = n1[0] + n2[0], my = n1[1] + n2[1];
      const dot = n1[0] * n2[0] + n1[1] * n2[1];
      const denom = 1 + dot;
      if (denom < 1e-6 || Math.hypot(mx, my) < 1e-6) { pts.push([q[0] + n1[0] * d, q[1] + n1[1] * d], [q[0] + n2[0] * d, q[1] + n2[1] * d]); continue; }
      const k = d / denom; // miter vector = (n1+n2) * d / (1 + n1·n2)
      const miterLen = Math.hypot(mx * k, my * k);
      if (miterLen > miterLimit * Math.abs(d)) { pts.push([q[0] + n1[0] * d, q[1] + n1[1] * d], [q[0] + n2[0] * d, q[1] + n2[1] * d]); continue; }
      pts.push([q[0] + mx * k, q[1] + my * k]);
    }
    out.push({ points: pts });
  }
  return normalizeContours(out);
}

export const crispWeight: OutlineOp = (contours, p) => offsetMiter(contours, num(p.amount, -1, 1, 0.3) * 35);

/** tracking: only the advance changes; handled in advanceAfterStack. The op is identity on contours. */
export const tracking: OutlineOp = (contours) => contours;

export const CRISP_OPS: Record<string, OutlineOp> = { chamfer, roundVec, inkTrap, stretch, xHeight, stencil, crispWeight, tracking };
export type { FxCtx };
