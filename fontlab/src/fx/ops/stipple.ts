import type { Contour, Vec } from '../../core/glyph';
import { bboxContours, pointInPolygon, signedArea } from '../../core/geometry';
import { disc, type Ring } from '../../outline/strokeExpand';
import { unionRings } from '../../outline/union';
import { unionSets } from '../../dna/clip';
import type { OutlineOp } from '../types';
import { hollow, num } from './hollow';

export const STIPPLE_MAX_DOTS = 900;

interface Dot { x: number; y: number }

/** y-intervals of ink along the vertical line x = px (even–odd over all ring edges). */
function inkRuns(contours: Contour[], px: number): [number, number][] {
  const ys: number[] = [];
  for (const c of contours) {
    const p = c.points;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const [xi, yi] = p[i], [xj, yj] = p[j];
      if ((xi > px) !== (xj > px)) ys.push(yi + ((px - xi) * (yj - yi)) / (xj - xi));
    }
  }
  ys.sort((a, b) => a - b);
  const runs: [number, number][] = [];
  for (let k = 0; k + 1 < ys.length; k += 2) runs.push([ys[k], ys[k + 1]]);
  return runs;
}

/** squared distance from p to the nearest edge of any ring */
function boundaryDist2(p: Vec, contours: Contour[]): number {
  let best = Infinity;
  for (const c of contours) {
    const pts = c.points;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[j], b = pts[i];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy;
      let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = a[0] + t * dx - p[0], ey = a[1] + t * dy - p[1];
      const d2 = ex * ex + ey * ey;
      if (d2 < best) best = d2;
    }
  }
  return best;
}

/** connected components of discs that overlap (centre distance < 2r), via a grid hash */
function overlapComponents(dots: Dot[], r: number): Int32Array {
  const n = dots.length;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const cell = 2 * r;
  const grid = new Map<string, number[]>();
  const key = (cx: number, cy: number) => `${cx},${cy}`;
  const lim2 = (2 * r) * (2 * r);
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(dots[i].x / cell), cy = Math.floor(dots[i].y / cell);
    for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
      const bucket = grid.get(key(cx + ox, cy + oy));
      if (!bucket) continue;
      for (const j of bucket) {
        const dx = dots[i].x - dots[j].x, dy = dots[i].y - dots[j].y;
        if (dx * dx + dy * dy < lim2) { const a = find(i), b = find(j); if (a !== b) parent[a] = b; }
      }
    }
    const k = key(cx, cy);
    const bucket = grid.get(k);
    if (bucket) bucket.push(i); else grid.set(k, [i]);
  }
  for (let i = 0; i < n; i++) parent[i] = find(i);
  return parent;
}

/**
 * Dot-filled letters. Candidate centres sit on a hex grid (row pitch
 * spacing·√3/2, odd rows shifted by spacing/2) over the ink bbox, each
 * jittered by up to jitter·spacing/2 from `ctx.rng`; centres inside the ink
 * (inside an outer ring, outside every hole) become discs of radius dotSize.
 *
 * gravity > 0 lets the dots fall: the glyph is cut into vertical columns
 * (max(spacing/2, 2·dotSize+2) wide), the ink runs along each column centre
 * are measured, and the dots of a run are re-stacked from its bottom upward
 * with pitch 2·dotSize+1; position interpolates original → settled by
 * `gravity`. keepOutline = 1 unions a thin shell of the original letter on
 * top. The dot count is capped at ~900 by widening the spacing. Only discs
 * that actually overlap go through the boolean union.
 */
export const stipple: OutlineOp = (contours, params, ctx) => {
  if (contours.length === 0) return contours;
  let spacing = num(params.spacing, 10, 120, 36);
  const dotSize = num(params.dotSize, 3, 60, 12);
  const jitter = num(params.jitter, 0, 1, 0.5);
  const gravity = num(params.gravity, 0, 1, 0);
  const keepOutline = num(params.keepOutline, 0, 1, 0) >= 0.5;
  const { rng } = ctx;

  const outers = contours.filter((c) => c.points.length >= 3 && signedArea(c.points) > 0);
  const holes = contours.filter((c) => c.points.length >= 3 && signedArea(c.points) < 0);
  if (outers.length === 0) return contours;
  const inside = (p: Vec) => outers.some((o) => pointInPolygon(p, o.points)) && !holes.some((h) => pointInPolygon(p, h.points));

  const b = bboxContours(contours);
  const w = b.maxX - b.minX, h = b.maxY - b.minY;
  if (w <= 0 || h <= 0) return contours;

  // candidate count on a hex grid ≈ area / (spacing² · √3/2): pre-widen so the
  // candidate set itself stays bounded, then verify the kept count.
  const hexArea = (s: number) => (s * s * Math.sqrt(3)) / 2;
  const maxCandidates = STIPPLE_MAX_DOTS * 4;
  if (((w + spacing) * (h + spacing)) / hexArea(spacing) > maxCandidates) {
    spacing = Math.sqrt(((w + spacing) * (h + spacing)) / ((maxCandidates * Math.sqrt(3)) / 2));
  }

  const sample = (s: number): Dot[] => {
    const rowPitch = (s * Math.sqrt(3)) / 2;
    const colPitch = s / 2;
    const cols = Math.floor(w / colPitch) + 2;
    const rows = Math.floor(h / rowPitch) + 2;
    const x0 = b.minX + (w - (cols - 1) * colPitch) / 2;
    const y0 = b.minY + (h - (rows - 1) * rowPitch) / 2;
    const dots: Dot[] = [];
    const amp = (jitter * s) / 2;
    for (let r = 0; r < rows; r++) {
      const y = y0 + r * rowPitch;
      for (let c = r % 2; c < cols; c += 2) {
        // always draw both jitter numbers so the sequence is grid-stable
        const jx = rng.range(-amp, amp), jy = rng.range(-amp, amp);
        const p: Vec = [x0 + c * colPitch + jx, y + jy];
        if (inside(p)) dots.push({ x: p[0], y: p[1] });
      }
    }
    return dots;
  };

  let dots = sample(spacing);
  for (let tries = 0; dots.length > STIPPLE_MAX_DOTS && tries < 3; tries++) {
    spacing *= Math.sqrt(dots.length / STIPPLE_MAX_DOTS) * 1.05;
    dots = sample(spacing);
  }

  if (gravity > 0 && dots.length) {
    const pitch = 2 * dotSize + 1;
    const binW = Math.max(spacing / 2, 2 * dotSize + 2);
    const nBins = Math.max(1, Math.ceil(w / binW));
    const bins: Dot[][] = Array.from({ length: nBins }, () => []);
    for (const d of dots) bins[Math.min(nBins - 1, Math.max(0, Math.floor((d.x - b.minX) / binW)))].push(d);
    bins.forEach((list, bi) => {
      if (list.length === 0) return;
      const bx = b.minX + (bi + 0.5) * binW;
      const runs = inkRuns(contours, bx);
      if (runs.length === 0) {
        // column centre misses the ink: let each dot drop along its own x instead
        for (const d of list) {
          const own = inkRuns(contours, d.x).filter(([lo, hi]) => d.y >= lo - 1 && d.y <= hi + 1);
          if (own.length) d.y += (Math.min(own[0][1] - dotSize, own[0][0] + dotSize) - d.y) * gravity;
        }
        return;
      }
      list.sort((p, q) => p.y - q.y);
      const buckets: Dot[][] = runs.map(() => []);
      for (const d of list) {
        // the run containing the dot's y, else the nearest run
        let best = 0, bestD = Infinity;
        for (let i = 0; i < runs.length; i++) {
          const [lo, hi] = runs[i];
          const dd = d.y < lo ? lo - d.y : d.y > hi ? d.y - hi : 0;
          if (dd < bestD) { bestD = dd; best = i; }
        }
        buckets[best].push(d);
      }
      buckets.forEach((bucket, i) => {
        const [lo, hi] = runs[i];
        const top = Math.max(lo + dotSize, hi - dotSize);
        bucket.forEach((d, k) => {
          const sy = Math.min(top, lo + dotSize + k * pitch);
          d.x += (bx - d.x) * gravity;
          d.y += (sy - d.y) * gravity;
        });
      });
    });
  }

  if (dots.length === 0) return keepOutline ? hollow(contours, { inset: dotSize * 0.6, inline: 0 }, ctx) : contours;

  // group discs: lone discs are emitted as-is, overlapping clusters are unioned;
  // with keepOutline, clusters touching the shell are unioned with it.
  const comp = overlapComponents(dots, dotSize);
  const shellW = dotSize * 0.6;
  const nearLim2 = (dotSize + shellW + 1) ** 2;
  const nearComp = new Set<number>();
  if (keepOutline) for (let i = 0; i < dots.length; i++) if (boundaryDist2([dots[i].x, dots[i].y], contours) < nearLim2) nearComp.add(comp[i]);
  const size = new Map<number, number>();
  for (let i = 0; i < dots.length; i++) size.set(comp[i], (size.get(comp[i]) ?? 0) + 1);

  const out: Contour[] = [];
  const cluster: Ring[] = [];
  const near: Contour[] = [];
  for (let i = 0; i < dots.length; i++) {
    const ring = disc(dots[i].x, dots[i].y, dotSize, 12);
    if (nearComp.has(comp[i])) near.push({ points: ring });
    else if (size.get(comp[i])! > 1) cluster.push(ring);
    else out.push({ points: ring });
  }
  if (cluster.length) out.push(...unionRings(cluster));
  if (keepOutline) {
    const shell = hollow(contours, { inset: shellW, inline: 0 }, ctx);
    out.push(...(near.length ? unionSets([shell, near]) : shell));
  }
  return out.length ? out : contours;
};
