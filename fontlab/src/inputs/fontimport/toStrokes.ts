/**
 * Outline glyph -> stroke glyph.
 *
 * Imported TTF/OTF glyphs arrive as filled contours. To let Weight, terminals
 * and the variable axes work on them we recover a centreline skeleton with a
 * per-point half-width:
 *
 *   rasterize (nonzero) -> ink mask -> Zhang–Suen thinning -> polylines
 *   -> graph clean-up (prune spurs, join through junctions) -> RDP + smooth
 *   resample -> half-width from the exact Euclidean distance transform.
 *
 * Pure typed-array code, no DOM; runs in the worker and in Node.
 * Input/output coordinates are font units (1000/em, y up).
 */
import type { Contour, Glyph, Stroke, StrokePoint, Vec } from '../../core/glyph';
import { uid } from '../../core/glyph';
import { clamp, resampleLinear, simplifyRDP, smoothResample } from '../../core/geometry';
import { rasterize, toFont, toPixel, type Bitmap } from '../../fx/raster/bitmap';
import { distanceTransform, sampleField, skeletonToPolylines, zhangSuen } from '../image/thin';

export interface ToStrokesOptions {
  /** raster resolution (default 512) */
  pxPerEm?: number;
  /** minimum full stroke width in font units (default 6) */
  minWidth?: number;
  /** RDP tolerance in pixels (default 1.5) */
  simplify?: number;
}

/** font units between resampled centreline points */
const SPACING_UNITS = 10;
/** padding around the ink when rasterizing, font units */
const PAD_UNITS = 40;
const MAX_HALF_W = 250;

interface Field {
  bmp: Bitmap;
  mask: Uint8Array;
  skel: Uint8Array;
  dt: Float32Array;
  /** median half-width along the skeleton, px */
  hwPx: number;
}

function buildField(contours: Contour[], pxPerEm: number): Field | undefined {
  const rings = contours.filter((c) => c.points.length >= 3);
  if (!rings.length) return undefined;
  const bmp = rasterize(rings, { pxPerEm, pad: PAD_UNITS });
  const { width: w, height: h, data } = bmp;
  const mask = new Uint8Array(w * h);
  let ink = 0;
  for (let i = 0; i < data.length; i++) if (data[i] >= 128) { mask[i] = 1; ink++; }
  if (!ink) return undefined;
  const skel = zhangSuen(mask, w, h);
  const dt = distanceTransform(mask, w, h);
  const samples: number[] = [];
  for (let i = 0; i < skel.length; i++) if (skel[i]) samples.push(dt[i]);
  if (!samples.length) return undefined;
  samples.sort((a, b) => a - b);
  const hwPx = Math.max(0.5, samples[samples.length >> 1] - 0.5);
  return { bmp, mask, skel, dt, hwPx };
}

/**
 * Convert one outline glyph to a stroke glyph. Non-outline or empty glyphs
 * are returned unchanged (same object).
 */
export function outlineToStrokes(glyph: Glyph, opts: ToStrokesOptions = {}): Glyph {
  if (glyph.kind !== 'outline' || !glyph.contours?.length) return glyph;
  const pxPerEm = opts.pxPerEm ?? 512;
  const minHalf = (opts.minWidth ?? 6) / 2;
  const tol = opts.simplify ?? 1.5;

  const field = buildField(glyph.contours, pxPerEm);
  if (!field) return glyph;
  const { bmp, mask, skel, dt, hwPx } = field;
  const { width: W, height: H, scale } = bmp;

  let polys = skeletonToPolylines(skel, W, H, { minSpur: Math.max(4, hwPx) });
  polys = polys.filter((p) => p.length > 0);
  if (!polys.length) return glyph;

  const hwAt = (p: Vec) => Math.max(0.5, sampleField(dt, W, H, p[0], p[1]) - 0.5);
  const inkAt = (x: number, y: number) => {
    const ix = Math.floor(x), iy = Math.floor(y);
    return ix >= 0 && iy >= 0 && ix < W && iy < H && mask[iy * W + ix] === 1;
  };

  // graph clean-up in pixel space
  polys = cleanBranches(polys, { joinR: 3, minSpur: Math.max(6, 2 * hwPx), hwAt });

  // examine free ends: how far the ink continues past the skeleton end and
  // whether the end is flat (ink still full-width right before the edge)
  const ends: EndInfo[][] = polys.map((poly) => [probeEnd(poly, false, hwAt, inkAt, hwPx), probeEnd(poly, true, hwAt, inkAt, hwPx)]);
  const free = ends.flat().filter((e) => e.free);
  const flatCount = free.filter((e) => e.flat).length;
  const cap: Stroke['cap'] = free.length && flatCount / free.length >= 0.6 ? 'flat' : 'round';

  const strokes: Stroke[] = [];
  polys.forEach((poly, pi) => {
    const [e0, e1] = ends[pi];
    // extend free ends to the ink edge (flat) or to the cap circle centre (round)
    let pts = poly.slice();
    const ext0 = e0.free ? Math.max(0, e0.reach - (cap === 'round' ? e0.hw : 0)) : 0;
    const ext1 = e1.free ? Math.max(0, e1.reach - (cap === 'round' ? e1.hw : 0)) : 0;
    if (ext0 > 0.25) pts[0] = [pts[0][0] + e0.dir[0] * ext0, pts[0][1] + e0.dir[1] * ext0];
    if (ext1 > 0.25) pts[pts.length - 1] = [pts[pts.length - 1][0] + e1.dir[0] * ext1, pts[pts.length - 1][1] + e1.dir[1] * ext1];

    const closed = pts.length > 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1.5;
    if (pts.length >= 3) pts = simplifyRDP(pts, tol);
    // to font units, then resample evenly
    let fu: Vec[] = pts.map(([px, py]) => toFont(bmp, px, py));
    const spacing = SPACING_UNITS;
    if (fu.length >= 3) fu = smoothResample(fu, spacing);
    else if (fu.length === 2) fu = resampleLinear(fu, spacing);
    if (closed && fu.length > 3) fu[fu.length - 1] = fu[0];

    // widths from the EDT
    const raw = fu.map((p) => { const [px, py] = toPixel(bmp, p); return hwAt([px, py]) / scale; });
    // the extension zone near a free end has no reliable EDT: hold the width found just inside
    holdEndWidths(fu, raw, e0.free ? (ext0 + 0.5 * e0.hw) / scale : 0, e1.free ? (ext1 + 0.5 * e1.hw) / scale : 0);

    const points: StrokePoint[] = fu.map((p, i) => ({
      x: round1(p[0]),
      y: round1(p[1]),
      w: round1(clamp(raw[i], minHalf, MAX_HALF_W)),
    }));
    if (!points.length) return;
    strokes.push({ id: uid('s'), points, cap });
  });
  if (!strokes.length) return glyph;

  const out: Glyph = { ...glyph, kind: 'stroke', strokes: [...(glyph.strokes ?? []), ...strokes] };
  delete out.contours;
  return out;
}

/** Convert every outline glyph in the list; stroke glyphs pass through untouched. */
export function outlinesToStrokes(glyphs: Glyph[], opts: ToStrokesOptions = {}): Glyph[] {
  return glyphs.map((g) => (g.kind === 'outline' ? outlineToStrokes(g, opts) : g));
}

/**
 * Median full stroke width in font units: 2 × EDT along the skeleton for an
 * outline glyph, 2 × median half-width for a stroke glyph. 0 when empty.
 */
export function estimateStrokeWidth(glyph: Glyph, pxPerEm = 256): number {
  if (glyph.kind === 'stroke') {
    const ws = (glyph.strokes ?? []).flatMap((s) => s.points.map((p) => p.w)).filter((w) => Number.isFinite(w)).sort((a, b) => a - b);
    return ws.length ? 2 * ws[ws.length >> 1] : 0;
  }
  if (!glyph.contours?.length) return 0;
  const field = buildField(glyph.contours, pxPerEm);
  if (!field) return 0;
  return (2 * field.hwPx) / field.bmp.scale;
}

// ---------------------------------------------------------------------------
// skeleton graph clean-up

interface EndInfo {
  free: boolean;
  /** unit direction pointing OUT of the polyline at this end (px) */
  dir: Vec;
  /** half-width at the end (px) */
  hw: number;
  /** ink distance along `dir` from the end point to the boundary (px) */
  reach: number;
  flat: boolean;
}

function arcLength(p: Vec[]): number {
  let l = 0;
  for (let i = 1; i < p.length; i++) l += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return l;
}

/** unit direction from the point `back` px into the polyline towards its end */
function endDirection(poly: Vec[], atEnd: boolean, back: number): Vec {
  const n = poly.length;
  if (n < 2) return [1, 0];
  const end = atEnd ? poly[n - 1] : poly[0];
  let acc = 0;
  let ref: Vec = atEnd ? poly[n - 2] : poly[1];
  for (let k = 1; k < n; k++) {
    const q = atEnd ? poly[n - 1 - k] : poly[k];
    const prev = atEnd ? poly[n - k] : poly[k - 1];
    acc += Math.hypot(q[0] - prev[0], q[1] - prev[1]);
    ref = q;
    if (acc >= back) break;
  }
  const dx = end[0] - ref[0], dy = end[1] - ref[1];
  const l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
}

function probeEnd(poly: Vec[], atEnd: boolean, hwAt: (p: Vec) => number, inkAt: (x: number, y: number) => boolean, hwMed: number): EndInfo {
  const n = poly.length;
  const closed = n > 2 && Math.hypot(poly[0][0] - poly[n - 1][0], poly[0][1] - poly[n - 1][1]) < 1.5;
  const p = atEnd ? poly[n - 1] : poly[0];
  const hw = hwAt(p);
  if (closed || n < 2) return { free: false, dir: [1, 0], hw, reach: 0, flat: false };
  const dir = endDirection(poly, atEnd, Math.max(3, hwMed));
  const limit = Math.max(4, 3 * hw);
  let reach = 0;
  while (reach < limit && inkAt(p[0] + dir[0] * (reach + 0.5), p[1] + dir[1] * (reach + 0.5))) reach += 0.5;
  // flat if ink is still (almost) full width right before the edge
  let flat = false;
  if (hw >= 2) {
    const t = Math.max(0, reach - 1.5);
    const cx = p[0] + dir[0] * t, cy = p[1] + dir[1] * t;
    const px = -dir[1] * hw * 0.8, py = dir[0] * hw * 0.8;
    flat = inkAt(cx + px, cy + py) && inkAt(cx - px, cy - py);
  }
  return { free: true, dir, hw, reach, flat };
}

/** Replace widths within `d0` / `d1` font units of the ends by the first width found beyond. */
function holdEndWidths(pts: Vec[], w: number[], d0: number, d1: number): void {
  const n = pts.length;
  if (n < 2) return;
  if (d0 > 0) {
    let acc = 0, k = 0;
    while (k < n - 1 && acc < d0) { acc += Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]); k++; }
    const hold = w[Math.min(k, n - 1)];
    for (let i = 0; i < k; i++) w[i] = Math.max(w[i], hold);
  }
  if (d1 > 0) {
    let acc = 0, k = n - 1;
    while (k > 0 && acc < d1) { acc += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]); k--; }
    const hold = w[Math.max(k, 0)];
    for (let i = n - 1; i > k; i--) w[i] = Math.max(w[i], hold);
  }
}

interface CleanOpts {
  /** endpoints closer than this (px) are the same node */
  joinR: number;
  /** branches hanging off a junction shorter than this (px) are removed */
  minSpur: number;
  hwAt: (p: Vec) => number;
}

/**
 * Treat the polylines as a graph: cluster their endpoints into nodes, prune
 * short spurs, join the two branches meeting at a degree-2 node and, at
 * junctions, merge the most collinear pair of branches into one through
 * stroke (so an 'H' becomes two stems + a bar instead of five pieces).
 */
function cleanBranches(input: Vec[][], o: CleanOpts): Vec[][] {
  let brs = input.map((p) => p.slice());
  const isClosed = (p: Vec[]) => p.length > 2 && Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]) < 1.5;

  for (let iter = 0; iter < 200; iter++) {
    // ends
    type End = { bi: number; atEnd: boolean; p: Vec };
    const ends: End[] = [];
    brs.forEach((p, bi) => {
      if (p.length === 0 || isClosed(p)) return;
      ends.push({ bi, atEnd: false, p: p[0] });
      if (p.length > 1) ends.push({ bi, atEnd: true, p: p[p.length - 1] });
    });
    // cluster endpoints (union-find)
    const parent = ends.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) {
      if (Math.hypot(ends[i].p[0] - ends[j].p[0], ends[i].p[1] - ends[j].p[1]) <= o.joinR) parent[find(i)] = find(j);
    }
    const nodes = new Map<number, End[]>();
    ends.forEach((e, i) => { const r = find(i); (nodes.get(r) ?? nodes.set(r, []).get(r)!).push(e); });
    const degreeOf = (bi: number, atEnd: boolean): number => {
      for (const list of nodes.values()) if (list.some((e) => e.bi === bi && e.atEnd === atEnd)) return list.length;
      return 1;
    };

    let changed = false;

    // 1. prune spurs: one free end, other end at a junction, short
    for (let bi = 0; bi < brs.length && !changed; bi++) {
      const p = brs[bi];
      if (p.length === 0 || isClosed(p)) continue;
      const dA = degreeOf(bi, false), dB = degreeOf(bi, true);
      const spur = (dA === 1 && dB >= 3) || (dB === 1 && dA >= 3);
      if (spur && arcLength(p) < o.minSpur) { brs.splice(bi, 1); changed = true; }
    }
    if (changed) continue;

    // 2./3. join at nodes
    for (const list of nodes.values()) {
      if (list.length < 2) continue;
      let pair: [End, End] | undefined;
      if (list.length === 2) {
        if (list[0].bi !== list[1].bi) pair = [list[0], list[1]];
      } else {
        // most collinear pair: both outward directions point at the node, so a
        // through stroke has them opposite (dot -> -1)
        let best = 0.5;
        for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
          const a = list[i], b = list[j];
          if (a.bi === b.bi) continue;
          const back = Math.max(3, o.hwAt(a.p));
          const da = endDirection(brs[a.bi], a.atEnd, back), db = endDirection(brs[b.bi], b.atEnd, back);
          const dot = da[0] * db[0] + da[1] * db[1];
          if (dot < best) { best = dot; pair = [a, b]; }
        }
        if (best > -0.5) pair = undefined;
      }
      if (!pair) continue;
      const [a, b] = pair;
      const A = brs[a.bi], B = brs[b.bi];
      const head = a.atEnd ? A.slice() : A.slice().reverse(); // ends at the node
      const tail = b.atEnd ? B.slice().reverse() : B.slice(); // starts at the node
      const last = head[head.length - 1], first = tail[0];
      const merged = Math.hypot(last[0] - first[0], last[1] - first[1]) < 1e-6 ? head.concat(tail.slice(1)) : head.concat(tail);
      const hi = Math.max(a.bi, b.bi), lo = Math.min(a.bi, b.bi);
      brs.splice(hi, 1); brs.splice(lo, 1);
      brs.push(merged);
      changed = true;
      break;
    }
    if (!changed) break;
  }
  return brs.filter((p) => p.length > 0);
}

const round1 = (v: number) => Math.round(v * 10) / 10;
