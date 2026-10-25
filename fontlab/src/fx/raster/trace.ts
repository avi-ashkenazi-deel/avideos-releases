/**
 * Bitmap → closed contours via marching squares.
 *
 * The 0/255 mask is contoured at iso level 128 with linear interpolation on
 * the cell edges. Segments are joined into rings through a flat
 * edge-key → next-edge-key table (O(n), no searching). Winding is consistent:
 * walking a ring keeps ink on the left in y-up font space, so outer rings
 * come out CCW (positive `signedArea`) and holes CW.
 */
import type { Contour, Vec } from '../../core/glyph';
import { dedupe, simplifyRDP, signedArea } from '../../core/geometry';
import { toFont, type Bitmap } from './bitmap';

export interface TraceOptions {
  /** Chaikin smoothing passes (default 1) */
  smooth?: number;
  /** RDP tolerance in pixels (default 0.6) */
  tolerance?: number;
}

const ISO = 128;

/*
 * Cell corners in clockwise screen order (x right, y down):
 *   0 = top-left, 1 = top-right, 2 = bottom-right, 3 = bottom-left.
 * Edge k sits between corner k and corner (k+1)%4:
 *   0 = top, 1 = right, 2 = bottom, 3 = left.
 * Mask bits: TL=8, TR=4, BR=2, BL=1.
 *
 * A contour segment leaves a cell through an "exit" edge (corner k inside,
 * corner k+1 outside, walking the cell boundary clockwise) and enters through
 * an "entry" edge. We walk entry → exit, which keeps ink on the screen-left
 * of the walk (counter-clockwise on screen, y down); flipping y into font
 * space turns that into CCW with positive `signedArea`.
 * Saddles (5 and 10) are paired at runtime using the cell-centre average.
 */
const SEG_FROM = new Int8Array(16).fill(-1);
const SEG_TO = new Int8Array(16).fill(-1);
(() => {
  const bit = [8, 4, 2, 1];
  for (let m = 1; m < 15; m++) {
    if (m === 5 || m === 10) continue;
    for (let k = 0; k < 4; k++) {
      const a = (m & bit[k]) !== 0, b = (m & bit[(k + 1) & 3]) !== 0;
      if (a && !b) SEG_FROM[m] = k;
      if (!a && b) SEG_TO[m] = k;
    }
  }
})();

export function traceBitmap(bmp: Bitmap, opts: TraceOptions = {}): Contour[] {
  const smooth = Math.max(0, Math.floor(opts.smooth ?? 1));
  const tolerance = Math.max(0, opts.tolerance ?? 0.6);
  const w = bmp.width, h = bmp.height;
  if (w < 1 || h < 1) return [];

  // padded copy so rings close at the bitmap border
  const W = w + 2, H = h + 2;
  const P = new Uint8Array(W * H);
  for (let y = 0; y < h; y++) P.set(bmp.data.subarray(y * w, y * w + w), (y + 1) * W + 1);

  const nKeys = W * H * 2;
  const next = new Int32Array(nKeys).fill(-1);
  const ex = new Float32Array(nKeys);
  const ey = new Float32Array(nKeys);
  const starts: number[] = [];

  // Edge key helpers (virtual coords px,py ∈ [0,W) × [0,H)).
  // Horizontal edge (px,py)-(px+1,py): key = (py*W+px)*2.  Vertical (px,py)-(px,py+1): +1.
  const edgeKey = (px: number, py: number, edge: number): number => {
    switch (edge) {
      case 0: return (py * W + px) * 2;
      case 1: return (py * W + px + 1) * 2 + 1;
      case 2: return ((py + 1) * W + px) * 2;
      default: return (py * W + px) * 2 + 1;
    }
  };
  // Crossing point on an edge, in real pixel coordinates (pixel centres at +0.5).
  const setPoint = (key: number, px: number, py: number, edge: number, a: number, b: number, c: number, d: number) => {
    let x: number, y: number;
    switch (edge) {
      case 0: { const t = (ISO - a) / (b - a); x = px - 0.5 + t; y = py - 0.5; break; }
      case 1: { const t = (ISO - b) / (c - b); x = px + 0.5; y = py - 0.5 + t; break; }
      case 2: { const t = (ISO - d) / (c - d); x = px - 0.5 + t; y = py + 0.5; break; }
      default: { const t = (ISO - a) / (d - a); x = px - 0.5; y = py - 0.5 + t; break; }
    }
    ex[key] = x; ey[key] = y;
  };
  // emit(exit, entry): the stored segment runs entry → exit (see note above)
  const emit = (px: number, py: number, to: number, from: number, a: number, b: number, c: number, d: number) => {
    const kf = edgeKey(px, py, from), kt = edgeKey(px, py, to);
    setPoint(kf, px, py, from, a, b, c, d);
    setPoint(kt, px, py, to, a, b, c, d);
    next[kf] = kt;
    starts.push(kf);
  };

  for (let py = 0; py < H - 1; py++) {
    const row = py * W, rowB = row + W;
    for (let px = 0; px < W - 1; px++) {
      const a = P[row + px], b = P[row + px + 1], c = P[rowB + px + 1], d = P[rowB + px];
      const m = (a >= ISO ? 8 : 0) | (b >= ISO ? 4 : 0) | (c >= ISO ? 2 : 0) | (d >= ISO ? 1 : 0);
      if (m === 0 || m === 15) continue;
      if (m === 10) {
        // TL & BR ink. exits: top(0), bottom(2); entries: right(1), left(3)
        if ((a + b + c + d) * 0.25 >= ISO) { emit(px, py, 0, 1, a, b, c, d); emit(px, py, 2, 3, a, b, c, d); }
        else { emit(px, py, 0, 3, a, b, c, d); emit(px, py, 2, 1, a, b, c, d); }
      } else if (m === 5) {
        // TR & BL ink. exits: right(1), left(3); entries: top(0), bottom(2)
        if ((a + b + c + d) * 0.25 >= ISO) { emit(px, py, 3, 0, a, b, c, d); emit(px, py, 1, 2, a, b, c, d); }
        else { emit(px, py, 1, 0, a, b, c, d); emit(px, py, 3, 2, a, b, c, d); }
      } else {
        emit(px, py, SEG_FROM[m], SEG_TO[m], a, b, c, d);
      }
    }
  }

  // Follow rings.
  const visited = new Uint8Array(nKeys);
  const minAreaPx = 4; // (2 px)²
  const out: Contour[] = [];
  for (let s = 0; s < starts.length; s++) {
    const start = starts[s];
    if (visited[start]) continue;
    let ring: Vec[] = [];
    let cur = start;
    let guard = nKeys;
    do {
      visited[cur] = 1;
      ring.push([ex[cur], ey[cur]]);
      cur = next[cur];
    } while (cur >= 0 && cur !== start && !visited[cur] && --guard > 0);
    if (ring.length < 3) continue;

    for (let i = 0; i < smooth; i++) ring = chaikinClosed(ring);
    if (tolerance > 0 && ring.length > 3) {
      ring.push(ring[0]);
      ring = simplifyRDP(ring, tolerance);
      ring.pop();
    }
    ring = dedupe(ring, 0.01);
    if (ring.length < 3) continue;
    if (Math.abs(signedArea(ring)) < minAreaPx) continue;
    out.push({ points: ring.map((p) => toFont(bmp, p[0], p[1])) });
  }
  return out;
}

function chaikinClosed(pts: Vec[]): Vec[] {
  const n = pts.length;
  const out: Vec[] = new Array(n * 2);
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    out[2 * i] = [0.75 * p[0] + 0.25 * q[0], 0.75 * p[1] + 0.25 * q[1]];
    out[2 * i + 1] = [0.25 * p[0] + 0.75 * q[0], 0.25 * p[1] + 0.75 * q[1]];
  }
  return out;
}
