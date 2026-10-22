/**
 * Skeletonisation: Zhang–Suen thinning, skeleton -> polylines, and an exact
 * Euclidean distance transform for stroke half-widths. Pure typed-array code.
 * Pixel coordinates (x = column, y = row), y down.
 */
import type { Vec } from '../../core/glyph';

/** Zhang–Suen thinning of a binary mask (1 = ink) to a 1-px wide 8-connected skeleton. */
export function zhangSuen(mask: Uint8Array, w: number, h: number): Uint8Array {
  const W = w + 2, H = h + 2;
  const img = new Uint8Array(W * H);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img[(y + 1) * W + x + 1] = mask[y * w + x] ? 1 : 0;
  const del: number[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      del.length = 0;
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          const i = y * W + x;
          if (!img[i]) continue;
          const p2 = img[i - W], p3 = img[i - W + 1], p4 = img[i + 1], p5 = img[i + W + 1];
          const p6 = img[i + W], p7 = img[i + W - 1], p8 = img[i - 1], p9 = img[i - W - 1];
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;
          let a = 0;
          if (!p2 && p3) a++; if (!p3 && p4) a++; if (!p4 && p5) a++; if (!p5 && p6) a++;
          if (!p6 && p7) a++; if (!p7 && p8) a++; if (!p8 && p9) a++; if (!p9 && p2) a++;
          if (a !== 1) continue;
          if (step === 0) {
            if (p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0) continue;
          } else {
            if (p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) continue;
          }
          del.push(i);
        }
      }
      if (del.length) { changed = true; for (const i of del) img[i] = 0; }
    }
  }
  // staircase clean-up
  removeStaircases(img, W, H);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = img[(y + 1) * W + x + 1];
  return out;
}

/**
 * Sequential clean-up of the Zhang–Suen result: delete any pixel whose
 * foreground neighbours form a single genuinely 8-connected group (so removing
 * it keeps connectivity), that has at least one background 4-neighbour (so no
 * hole is created) and that is not an end point. This removes the 2-px wide
 * diagonal staircases Zhang–Suen is known to leave behind.
 */
function removeStaircases(img: Uint8Array, W: number, H: number): void {
  const off = [-W, -W + 1, 1, W + 1, W, W - 1, -1, -W - 1]; // N NE E SE S SW W NW
  const nb = new Uint8Array(8);
  const comp = new Int8Array(8);
  let changed = true;
  while (changed) {
    changed = false;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (!img[i]) continue;
        let b = 0;
        for (let k = 0; k < 8; k++) { nb[k] = img[i + off[k]]; b += nb[k]; }
        if (b < 2) continue;
        if (nb[0] && nb[2] && nb[4] && nb[6]) continue; // no background 4-neighbour
        // count 8-connected groups among the foreground neighbours (true adjacency, not crossing number)
        let groups = 0;
        comp.fill(-1);
        for (let k = 0; k < 8; k++) {
          if (!nb[k] || comp[k] >= 0) continue;
          groups++;
          const stack = [k];
          comp[k] = groups;
          while (stack.length) {
            const c = stack.pop()!;
            for (const d of [1, 7, 2, 6]) {
              const m = (c + d) % 8;
              if (!nb[m] || comp[m] >= 0) continue;
              // ring neighbours (d = 1 or 7) are always 8-adjacent; two apart only if both are 4-positions (even)
              if (d === 2 || d === 6) { if (c % 2 !== 0 || m % 2 !== 0) continue; }
              comp[m] = groups; stack.push(m);
            }
          }
        }
        if (groups === 1) { img[i] = 0; changed = true; }
      }
    }
  }
}

const N8: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

function degreeMap(skel: Uint8Array, w: number, h: number): Uint8Array {
  const deg = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!skel[y * w + x]) continue;
    let d = 0;
    for (const [dx, dy] of N8) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && skel[ny * w + nx]) d++;
    }
    deg[y * w + x] = d;
  }
  return deg;
}

export interface PolylineOptions {
  /** branches ending in a free end shorter than this (px) are pruned */
  minSpur?: number;
}

/**
 * Trace a 1-px skeleton into polylines between end points and junctions,
 * prune short spurs and join polylines that meet at degree-2 nodes.
 * Returned points are pixel centres (x + 0.5, y + 0.5).
 */
export function skeletonToPolylines(skel: Uint8Array, w: number, h: number, opts: PolylineOptions = {}): Vec[][] {
  const minSpur = opts.minSpur ?? 6;
  const deg = degreeMap(skel, w, h);
  const isJ = (i: number) => deg[i] >= 3;

  // junction clusters -> node ids
  const node = new Int32Array(w * h).fill(-1);
  let nodeCount = 0;
  for (let i = 0; i < w * h; i++) {
    if (!skel[i] || !isJ(i) || node[i] >= 0) continue;
    const id = nodeCount++;
    const stack = [i];
    node[i] = id;
    while (stack.length) {
      const c = stack.pop()!;
      const x = c % w, y = (c - x) / w;
      for (const [dx, dy] of N8) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (skel[ni] && isJ(ni) && node[ni] < 0) { node[ni] = id; stack.push(ni); }
      }
    }
  }
  const nodeKeyOf = (i: number) => (node[i] >= 0 ? node[i] : nodeCount + i);

  const visited = new Uint8Array(w * h);
  type Branch = { pts: number[]; a: number; b: number; freeA: boolean; freeB: boolean };
  const branches: Branch[] = [];

  const nextFrom = (i: number): number => {
    const x = i % w, y = (i - x) / w;
    for (const [dx, dy] of N8) { // 4-neighbours listed first
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (skel[ni] && !visited[ni] && !isJ(ni)) return ni;
    }
    return -1;
  };
  const adjacentJunction = (i: number, excludeNode: number): number => {
    const x = i % w, y = (i - x) / w;
    for (const [dx, dy] of N8) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (skel[ni] && isJ(ni) && node[ni] !== excludeNode) return ni;
    }
    return -1;
  };
  const touchesNode = (i: number, nid: number): boolean => {
    if (nid < 0) return false;
    const x = i % w, y = (i - x) / w;
    for (const [dx, dy] of N8) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (node[ny * w + nx] === nid) return true;
    }
    return false;
  };

  const walk = (start: number, first: number) => {
    const pts = [start];
    const startNode = isJ(start) ? node[start] : -1;
    let leaving = startNode >= 0;
    let cur = first;
    while (cur >= 0) {
      visited[cur] = 1;
      pts.push(cur);
      if (deg[cur] === 1) break;
      if (leaving && !touchesNode(cur, startNode)) leaving = false;
      const j = adjacentJunction(cur, leaving ? startNode : -1);
      if (j >= 0) { pts.push(j); break; }
      cur = nextFrom(cur);
    }
    const a = pts[0], b = pts[pts.length - 1];
    branches.push({ pts, a, b, freeA: !isJ(a), freeB: !isJ(b) });
  };

  // 1. from end points
  for (let i = 0; i < w * h; i++) {
    if (!skel[i] || deg[i] !== 1 || visited[i]) continue;
    visited[i] = 1;
    const nx = nextFrom(i);
    if (nx >= 0) walk(i, nx);
    else {
      const j = adjacentJunction(i, -1);
      if (j >= 0) branches.push({ pts: [i, j], a: i, b: j, freeA: true, freeB: false });
    }
  }
  // 2. from junctions
  for (let i = 0; i < w * h; i++) {
    if (!skel[i] || !isJ(i)) continue;
    let nx: number;
    while ((nx = nextFrom(i)) >= 0) walk(i, nx);
  }
  // 3. remaining closed loops (no end points, no junctions)
  const adjacent = (i: number, j: number) => Math.abs((i % w) - (j % w)) <= 1 && Math.abs(Math.floor(i / w) - Math.floor(j / w)) <= 1;
  for (let i = 0; i < w * h; i++) {
    if (!skel[i] || visited[i] || isJ(i) || deg[i] === 0) continue;
    visited[i] = 1;
    const pts = [i];
    let cur = nextFrom(i);
    while (cur >= 0) { visited[cur] = 1; pts.push(cur); cur = nextFrom(cur); }
    const closed = pts.length > 2 && adjacent(pts[pts.length - 1], i);
    if (closed) pts.push(i);
    branches.push({ pts, a: i, b: closed ? i : pts[pts.length - 1], freeA: true, freeB: true });
  }
  // isolated single pixels (dots)
  for (let i = 0; i < w * h; i++) {
    if (skel[i] && deg[i] === 0 && !visited[i]) { visited[i] = 1; branches.push({ pts: [i], a: i, b: i, freeA: true, freeB: true }); }
  }

  const toVec = (i: number): Vec => [(i % w) + 0.5, Math.floor(i / w) + 0.5];
  const arcLen = (pts: number[]) => {
    let l = 0;
    for (let k = 1; k < pts.length; k++) { const p = toVec(pts[k - 1]), q = toVec(pts[k]); l += Math.hypot(q[0] - p[0], q[1] - p[1]); }
    return l;
  };

  // 4. prune spurs: branches with one free end attached to a junction, shorter than minSpur
  let kept = branches.filter((b) => !((b.freeA !== b.freeB) && arcLen(b.pts) < minSpur));
  // tiny fragments entirely inside junction clusters
  kept = kept.filter((b) => !(!b.freeA && !b.freeB && b.pts.length <= 2 && node[b.a] === node[b.b]));

  // 5. join at nodes where exactly two branch ends meet
  let merged = true;
  while (merged) {
    merged = false;
    const ends = new Map<number, { bi: number; atStart: boolean }[]>();
    kept.forEach((b, bi) => {
      if (b.a === b.b && b.pts.length > 2) return; // closed loop
      const ka = nodeKeyOf(b.a), kb = nodeKeyOf(b.b);
      (ends.get(ka) ?? ends.set(ka, []).get(ka)!).push({ bi, atStart: true });
      (ends.get(kb) ?? ends.set(kb, []).get(kb)!).push({ bi, atStart: false });
    });
    for (const [, list] of ends) {
      if (list.length !== 2) continue;
      const [e0, e1] = list;
      if (e0.bi === e1.bi) continue;
      const A = kept[e0.bi], B = kept[e1.bi];
      let pa = e0.atStart ? A.pts.slice().reverse() : A.pts.slice();
      const pb = e1.atStart ? B.pts.slice() : B.pts.slice().reverse();
      if (pa[pa.length - 1] === pb[0]) pa = pa.concat(pb.slice(1)); else pa = pa.concat(pb);
      const na = e0.atStart ? A.b : A.a, nb = e1.atStart ? B.b : B.a;
      const nbr: Branch = { pts: pa, a: na, b: nb, freeA: !isJ(na), freeB: !isJ(nb) };
      kept = kept.filter((_, i) => i !== e0.bi && i !== e1.bi);
      kept.push(nbr);
      merged = true;
      break;
    }
  }

  return kept.map((b) => b.pts.map(toVec));
}

/**
 * Exact Euclidean distance (in px) from each pixel to the nearest background
 * pixel; pixels outside the mask count as background. 0 for background pixels.
 * Felzenszwalb & Huttenlocher separable algorithm.
 */
export function distanceTransform(mask: Uint8Array, w: number, h: number): Float32Array {
  const W = w + 2, H = h + 2;
  const INF = 1e20;
  const f = new Float64Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const inside = x > 0 && y > 0 && x <= w && y <= h && mask[(y - 1) * w + (x - 1)];
    f[y * W + x] = inside ? INF : 0;
  }
  const n = Math.max(W, H);
  const d = new Float64Array(n), z = new Float64Array(n + 1), v = new Int32Array(n), g = new Float64Array(n);
  const dt1d = (len: number) => {
    let k = 0;
    v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = ((g[q] + q * q) - (g[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((g[q] + q * q) - (g[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + g[v[k]];
    }
  };
  // columns
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) g[y] = f[y * W + x];
    dt1d(H);
    for (let y = 0; y < H; y++) f[y * W + x] = d[y];
  }
  // rows
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) g[x] = f[y * W + x];
    dt1d(W);
    for (let x = 0; x < W; x++) f[y * W + x] = d[x];
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(f[(y + 1) * W + x + 1]);
  return out;
}

/** Bilinear sample of a per-pixel field at a pixel-centre coordinate. */
export function sampleField(field: Float32Array, w: number, h: number, x: number, y: number): number {
  const fx = Math.min(w - 1, Math.max(0, x - 0.5)), fy = Math.min(h - 1, Math.max(0, y - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  const a = field[y0 * w + x0], b = field[y0 * w + x1], c = field[y1 * w + x0], dd = field[y1 * w + x1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + dd * tx) * ty;
}
