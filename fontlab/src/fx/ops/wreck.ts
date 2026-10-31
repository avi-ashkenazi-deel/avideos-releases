/**
 * Wreck ops: structural "destroyer" outline effects. Copies, slices, holes,
 * spikes, grid quantisation and a vertical crush. All outline-stage, all
 * boolean-clean (results go through the polygon clipper).
 */
import type { Contour, Vec } from '../../core/glyph';
import { bboxContours, clamp, dedupe, mapContours, pointInPolygon, signedArea } from '../../core/geometry';
import type { Ring } from '../../outline/strokeExpand';
import { intersectRect, normalizeContours, subtractRings, unionSets, unionWithRings } from '../../dna/clip';
import { densifyClosed, inkArea, ringNormals } from '../../dna/util';
import type { FxCtx, FxParamDef, OutlineOp } from '../types';

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : d);

const hasInk = (cs: Contour[]) => cs.some((c) => c.points.length >= 3);
/** never hand back nothing when the input had ink */
const orInput = (out: Contour[], input: Contour[]) => (out.length === 0 && hasInk(input) ? input : out);
const translate = (cs: Contour[], dx: number, dy: number) => mapContours(cs, ([x, y]) => [x + dx, y + dy]);
/** nonzero containment: inside more outers than holes */
function insideInk(p: Vec, contours: Contour[]): boolean {
  let w = 0;
  for (const c of contours) {
    if (c.points.length < 3 || !pointInPolygon(p, c.points)) continue;
    w += signedArea(c.points) > 0 ? 1 : -1;
  }
  return w > 0;
}
/** drop degenerate rings */
const cleanup = (cs: Contour[], minArea: number) => cs.map((c) => ({ points: dedupe(c.points) })).filter((c) => c.points.length >= 3 && Math.abs(signedArea(c.points)) >= minArea);

/** union of the glyph with N translated copies */
const echo: OutlineOp = (contours, params) => {
  const copies = Math.round(num(params.copies, 1, 6, 2));
  const dx = num(params.dx, -80, 80, 18);
  const dy = num(params.dy, -80, 80, -12);
  if (!hasInk(contours) || (dx === 0 && dy === 0)) return contours;
  const sets: Contour[][] = [contours];
  for (let i = 1; i <= copies; i++) sets.push(translate(contours, i * dx, i * dy));
  return orInput(unionSets(sets), contours);
};

/** horizontal bands, alternately shifted left / right */
const slice: OutlineOp = (contours, params) => {
  const strips = Math.round(num(params.strips, 2, 14, 6));
  const shift = num(params.shift, 0, 120, 30);
  if (!hasInk(contours) || shift === 0) return contours;
  const b = bboxContours(contours);
  const h = b.maxY - b.minY;
  if (h <= 0) return contours;
  const x0 = b.minX - 10, x1 = b.maxX + 10;
  const sets: Contour[][] = [];
  for (let i = 0; i < strips; i++) {
    const y0 = b.minY + (h * i) / strips - (i === 0 ? 1 : 0);
    const y1 = b.minY + (h * (i + 1)) / strips + (i === strips - 1 ? 1 : 0);
    const band = intersectRect(contours, y0, y1, x0, x1);
    if (band.length === 0) continue;
    sets.push(translate(band, i % 2 === 0 ? shift : -shift, 0));
  }
  return orInput(unionSets(sets), contours);
};

/** subtract seeded circles whose centres lie inside the ink */
const holes: OutlineOp = (contours, params, ctx) => {
  const amount = num(params.amount, 0, 1, 0.5);
  const size = num(params.size, 10, 120, 40);
  if (!hasInk(contours) || amount <= 0) return contours;
  const b = bboxContours(contours);
  const pitch = size * 1.6;
  const rings: Ring[] = [];
  const rng = ctx.rng;
  for (let y = b.minY + pitch * 0.5; y <= b.maxY; y += pitch) {
    for (let x = b.minX + pitch * 0.5; x <= b.maxX; x += pitch) {
      // draw every random value regardless of outcome so the pattern is stable per seed
      const cx = x + rng.range(-0.4, 0.4) * pitch;
      const cy = y + rng.range(-0.4, 0.4) * pitch;
      const keep = rng() < amount;
      const r = size * rng.range(0.5, 1);
      if (!keep || rings.length >= 80 || !insideInk([cx, cy], contours)) continue;
      const ring: Ring = [];
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        ring.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
      }
      rings.push(ring);
    }
  }
  if (rings.length === 0) return contours;
  return orInput(subtractRings(contours, rings), contours);
};

/** outward triangles at a seeded fraction of the (densified) vertices */
const spikes: OutlineOp = (contours, params, ctx) => {
  const amount = num(params.amount, 0, 1, 0.4);
  const length = num(params.length, 10, 200, 60);
  if (!hasInk(contours) || amount <= 0) return contours;
  const hw = length * 0.35 * 0.5;
  const rings: Ring[] = [];
  const rng = ctx.rng;
  outer: for (const c of contours) {
    if (c.points.length < 3) continue;
    const ring = densifyClosed(dedupe(c.points), 20);
    const normals = ringNormals(ring);
    for (let i = 0; i < ring.length; i++) {
      if (rng() >= amount) continue;
      if (rings.length >= 400) break outer;
      const v = ring[i], n = normals[i];
      const t: Vec = [-n[1], n[0]];
      // base sits 2 units inside the ink so the triangle always overlaps it
      const bx = v[0] - n[0] * 2, by = v[1] - n[1] * 2;
      rings.push([
        [bx - t[0] * hw, by - t[1] * hw],
        [bx + t[0] * hw, by + t[1] * hw],
        [v[0] + n[0] * length, v[1] + n[1] * length],
      ]);
    }
  }
  if (rings.length === 0) return contours;
  return orInput(unionWithRings(contours, rings), contours);
};

/** quantise every vertex to a grid */
const gridSnap: OutlineOp = (contours, params) => {
  const cell = num(params.cell, 8, 120, 40);
  if (!hasInk(contours)) return contours;
  const snap = ([x, y]: Vec): Vec => [Math.round(x / cell) * cell, Math.round(y / cell) * cell];
  const minArea = cell * cell;
  const snapped = cleanup(contours.map((c) => ({ points: densifyClosed(c.points, cell / 2).map(snap) })), minArea);
  if (snapped.length === 0) return contours;
  // the clipper can add off-grid intersection vertices; pull those back onto the grid too
  const out = cleanup(mapContours(normalizeContours(snapped), snap), minArea);
  return orInput(out.length ? out : snapped, contours);
};

/** insert vertices where edges cross y = level */
function splitAtY(points: Vec[], level: number): Vec[] {
  const n = points.length;
  const out: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const a = points[i], b = points[(i + 1) % n];
    out.push(a);
    if ((a[1] < level && b[1] > level) || (a[1] > level && b[1] < level)) {
      const t = (level - a[1]) / (b[1] - a[1]);
      out.push([a[0] + (b[0] - a[0]) * t, level]);
    }
  }
  return out;
}

/** squash a horizontal band around xHeight/2 to zero height */
const crush: OutlineOp = (contours, params, ctx: FxCtx) => {
  const amount = num(params.amount, 0, 1, 0.5);
  if (!hasInk(contours) || amount <= 0) return contours;
  const b = bboxContours(contours);
  const bh = amount * (b.maxY - b.minY) * 0.6;
  if (bh <= 0) return contours;
  const c = ctx.metrics.xHeight / 2;
  const b0 = c - bh / 2, b1 = c + bh / 2;
  const squash = ([x, y]: Vec): Vec => (y >= b1 ? [x, y - bh] : y > b0 ? [x, b0] : [x, y]);
  const mapped = cleanup(contours.map((k) => ({ points: splitAtY(splitAtY(k.points, b0), b1).map(squash) })), 1);
  if (mapped.length === 0) return contours;
  const out = normalizeContours(mapped);
  if (out.length === 0 || inkArea(out) <= 0) return orInput(mapped, contours);
  return out;
};

export const WRECK_OPS: Record<string, OutlineOp> = { echo, slice, holes, spikes, gridSnap, crush };

export const WRECK_DEFS: Record<string, { label: string; hint: string; params: FxParamDef[] }> = {
  echo: {
    label: 'Echo',
    hint: 'Repeated offset copies',
    params: [
      { key: 'copies', label: 'Copies', min: 1, max: 6, step: 1, default: 2 },
      { key: 'dx', label: 'Offset x', min: -80, max: 80, step: 1, default: 18 },
      { key: 'dy', label: 'Offset y', min: -80, max: 80, step: 1, default: -12 },
    ],
  },
  slice: {
    label: 'Slice',
    hint: 'Horizontal bands shifted apart',
    params: [
      { key: 'strips', label: 'Strips', min: 2, max: 14, step: 1, default: 6 },
      { key: 'shift', label: 'Shift', min: 0, max: 120, step: 1, default: 30 },
    ],
  },
  holes: {
    label: 'Holes',
    hint: 'Swiss-cheese the letter',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'size', label: 'Size', min: 10, max: 120, step: 1, default: 40 },
    ],
  },
  spikes: {
    label: 'Spikes',
    hint: 'Thorns sprouting from the outline',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, default: 0.4 },
      { key: 'length', label: 'Length', min: 10, max: 200, step: 1, default: 60 },
    ],
  },
  gridSnap: {
    label: 'Grid snap',
    hint: 'Everything on a grid',
    params: [{ key: 'cell', label: 'Cell', min: 8, max: 120, step: 1, default: 40 }],
  },
  crush: {
    label: 'Crush',
    hint: 'Squash the middle band flat',
    params: [{ key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, default: 0.5 }],
  },
};
