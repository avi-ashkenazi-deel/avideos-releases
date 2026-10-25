/**
 * Minimal bitmap type + a scanline rasterizer (nonzero winding) so raster
 * effects run in the worker and in Node without a canvas.
 *
 * Pixel grid: row 0 is the TOP. `origin` is the font-unit position of the
 * bottom-left corner of the bitmap; `scale` is pixels per font unit.
 */
import type { Contour, Vec } from '../../core/glyph';
import { bboxContours } from '../../core/geometry';

export interface Bitmap {
  width: number;
  height: number;
  /** 0 = paper, 255 = ink (ops may hold intermediate greys) */
  data: Uint8Array;
  origin: Vec;
  scale: number;
}

export interface RasterOptions {
  /** pixels per em (1000 font units) */
  pxPerEm?: number;
  /** padding around the ink, in font units */
  pad?: number;
}

export function makeBitmap(width: number, height: number, origin: Vec, scale: number, fill = 0): Bitmap {
  const data = new Uint8Array(Math.max(1, width * height));
  if (fill) data.fill(fill);
  return { width: Math.max(1, width), height: Math.max(1, height), data, origin, scale };
}

export function cloneBitmap(b: Bitmap): Bitmap {
  return { ...b, data: new Uint8Array(b.data) };
}

/** font units → pixel coords (x right, y down) */
export function toPixel(b: Bitmap, p: Vec): Vec {
  return [(p[0] - b.origin[0]) * b.scale, b.height - (p[1] - b.origin[1]) * b.scale];
}
/** pixel coords → font units */
export function toFont(b: Bitmap, px: number, py: number): Vec {
  return [b.origin[0] + px / b.scale, b.origin[1] + (b.height - py) / b.scale];
}

/**
 * Rasterize contours (nonzero winding) into a fresh bitmap that covers their
 * bbox plus padding. Uses a per-row crossing scan with coverage of pixel
 * centres; good enough at 128–512 px/em for texture work.
 */
export function rasterize(contours: Contour[], opts: RasterOptions = {}): Bitmap {
  const pxPerEm = opts.pxPerEm ?? 160;
  const pad = opts.pad ?? 80;
  const scale = pxPerEm / 1000;
  const rings = contours.filter((c) => c.points.length >= 3);
  if (!rings.length) return makeBitmap(2, 2, [0, 0], scale);
  const bb = bboxContours(rings);
  const origin: Vec = [bb.minX - pad, bb.minY - pad];
  const width = Math.ceil((bb.maxX - bb.minX + 2 * pad) * scale) + 1;
  const height = Math.ceil((bb.maxY - bb.minY + 2 * pad) * scale) + 1;
  const bmp = makeBitmap(width, height, origin, scale);
  fillInto(bmp, rings, 255);
  return bmp;
}

/** Fill contours into an existing bitmap (nonzero). */
export function fillInto(bmp: Bitmap, contours: Contour[], value = 255): void {
  type Edge = { x0: number; y0: number; x1: number; y1: number; dir: number };
  const edges: Edge[] = [];
  for (const c of contours) {
    const n = c.points.length;
    for (let i = 0; i < n; i++) {
      const a = toPixel(bmp, c.points[i]), b = toPixel(bmp, c.points[(i + 1) % n]);
      if (a[1] === b[1]) continue;
      if (a[1] < b[1]) edges.push({ x0: a[0], y0: a[1], x1: b[0], y1: b[1], dir: 1 });
      else edges.push({ x0: b[0], y0: b[1], x1: a[0], y1: a[1], dir: -1 });
    }
  }
  if (!edges.length) return;
  edges.sort((p, q) => p.y0 - q.y0);
  const xs: { x: number; dir: number }[] = [];
  let next = 0;
  const active: Edge[] = [];
  for (let row = 0; row < bmp.height; row++) {
    const y = row + 0.5;
    while (next < edges.length && edges[next].y0 <= y) active.push(edges[next++]);
    xs.length = 0;
    for (let i = active.length - 1; i >= 0; i--) {
      const e = active[i];
      if (e.y1 <= y) { active.splice(i, 1); continue; }
      if (e.y0 > y) continue;
      const t = (y - e.y0) / (e.y1 - e.y0);
      xs.push({ x: e.x0 + (e.x1 - e.x0) * t, dir: e.dir });
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p.x - q.x);
    let wind = 0;
    const base = row * bmp.width;
    for (let i = 0; i < xs.length - 1; i++) {
      wind += xs[i].dir;
      if (wind === 0) continue;
      const xa = Math.max(0, Math.ceil(xs[i].x - 0.5)), xb = Math.min(bmp.width - 1, Math.floor(xs[i + 1].x - 0.5));
      for (let x = xa; x <= xb; x++) bmp.data[base + x] = value;
    }
  }
}

/** Threshold greys back to a clean 0/255 mask (in place). */
export function threshold(bmp: Bitmap, t = 128): Bitmap {
  const d = bmp.data;
  for (let i = 0; i < d.length; i++) d[i] = d[i] >= t ? 255 : 0;
  return bmp;
}

/** Ink pixel count (for tests / heuristics). */
export function inkPixels(bmp: Bitmap): number {
  let n = 0;
  for (let i = 0; i < bmp.data.length; i++) if (bmp.data[i] >= 128) n++;
  return n;
}
