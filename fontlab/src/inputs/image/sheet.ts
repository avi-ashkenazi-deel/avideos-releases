/**
 * Dense-sheet handling for the photo tracer: remove page frames, open away
 * thin halo lines, and split oversized blobs (several letters stuck together)
 * with projection profiles. Pure functions on binary masks (1 = ink).
 */
import { connectedComponents, compositeMask, boxH, boxW, type Component, type PixelBox } from './raster';
import { segmentGlyphCells, type Segmentation } from './segment';

const median = (v: number[]): number => {
  if (!v.length) return 0;
  const s = v.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Drop ink that is a page frame / scan edge: border-touching and spanning most of the image, or a huge hollow rectangle. */
export function removeFrame(bin: Uint8Array, w: number, h: number): { bin: Uint8Array; removed: number } {
  const out = new Uint8Array(bin);
  let removed = 0;
  for (const c of connectedComponents(bin, w, h)) {
    const bw = boxW(c.bbox), bh = boxH(c.bbox);
    const touches = c.bbox.x0 === 0 || c.bbox.y0 === 0 || c.bbox.x1 === w - 1 || c.bbox.y1 === h - 1;
    const spans = bw > 0.6 * w || bh > 0.6 * h;
    const fill = c.pixels / Math.max(1, bw * bh);
    const hollowHuge = bw > 0.8 * w && bh > 0.8 * h && fill < 0.15;
    if ((touches && spans) || hollowHuge) { clearComponent(out, w, c); removed++; }
  }
  return { bin: out, removed };
}

function clearComponent(bin: Uint8Array, w: number, c: Component): void {
  const bw = boxW(c.bbox);
  for (let y = c.bbox.y0; y <= c.bbox.y1; y++) for (let x = c.bbox.x0; x <= c.bbox.x1; x++) {
    if (c.mask[(y - c.bbox.y0) * bw + (x - c.bbox.x0)]) bin[y * w + x] = 0;
  }
}

/** Binary opening (erode then dilate) with a (2r+1)² square kernel. r = 0 returns a copy. */
export function opening(bin: Uint8Array, w: number, h: number, r: number): Uint8Array {
  r = Math.max(0, Math.min(3, Math.round(r)));
  if (r === 0) return new Uint8Array(bin);
  let cur = bin;
  for (let i = 0; i < r; i++) cur = erode1(cur, w, h);
  for (let i = 0; i < r; i++) cur = dilate1(cur, w, h);
  return cur;
}
function erode1(b: Uint8Array, w: number, h: number): Uint8Array {
  const o = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (b[i] && b[i - 1] && b[i + 1] && b[i - w] && b[i + w] && b[i - w - 1] && b[i - w + 1] && b[i + w - 1] && b[i + w + 1]) o[i] = 1;
  }
  return o;
}
function dilate1(b: Uint8Array, w: number, h: number): Uint8Array {
  const o = new Uint8Array(b);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!b[y * w + x]) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && yy < h && xx >= 0 && xx < w) o[yy * w + xx] = 1;
    }
  }
  return o;
}

/** runs of indices where profile[i] > thr, merging gaps shorter than minGap */
function runs(profile: Float64Array | number[], thr: number, minGap: number): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= profile.length; i++) {
    const on = i < profile.length && profile[i] > thr;
    if (on && start < 0) start = i;
    if (!on && start >= 0) { out.push([start, i - 1]); start = -1; }
  }
  // merge tiny gaps
  const merged: [number, number][] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] - 1 < minGap) last[1] = r[1]; else merged.push([r[0], r[1]]);
  }
  return merged;
}

/**
 * Split one oversized mask into letter-sized sub-boxes using projection
 * profiles: rows → text lines, columns → letters, then pitch-based cuts for
 * pieces that are still too wide. Returns boxes in reading order (local coords).
 */
export function splitMask(mask: Uint8Array, W: number, H: number): PixelBox[] {
  const rowP = new Float64Array(H), colP = new Float64Array(W);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (mask[y * W + x]) { rowP[y]++; colP[x]++; }
  const rowMax = Math.max(...rowP);
  if (rowMax === 0) return [];
  const bands = runs(rowP, rowMax * 0.08, 2).filter(([a, b]) => b - a + 1 >= 3);
  const boxes: PixelBox[] = [];
  for (const [y0, y1] of bands) {
    const bandH = y1 - y0 + 1;
    const cp = new Float64Array(W);
    for (let y = y0; y <= y1; y++) for (let x = 0; x < W; x++) if (mask[y * W + x]) cp[x]++;
    const cmax = Math.max(...cp);
    if (cmax === 0) continue;
    let pieces = runs(cp, cmax * 0.12, 2).filter(([a, b]) => b - a + 1 >= 2);
    // pitch-based cuts for pieces that are still several letters wide
    const widths = pieces.map(([a, b]) => b - a + 1);
    const normal = widths.filter((w) => w <= bandH * 1.6);
    const pitch = normal.length >= 2 ? median(normal) : Math.max(4, Math.round(bandH * 0.7));
    const refined: [number, number][] = [];
    const cut = (a: number, b: number, depth: number) => {
      const wdt = b - a + 1;
      const wide = wdt > bandH * 1.6 || (wdt > pitch * 1.6 && wdt > bandH * 1.1);
      if (!wide || depth > 3) { refined.push([a, b]); return; }
      const k = Math.max(2, Math.round(wdt / pitch));
      let pieceMax = 0; for (let x = a; x <= b; x++) pieceMax = Math.max(pieceMax, cp[x]);
      let bestX = -1, bestV = Infinity;
      for (let i = 1; i < k; i++) {
        const target = a + (wdt * i) / k;
        const lo = Math.max(a + 2, Math.floor(target - wdt * 0.12)), hi = Math.min(b - 2, Math.ceil(target + wdt * 0.12));
        for (let x = lo; x <= hi; x++) if (cp[x] < bestV) { bestV = cp[x]; bestX = x; }
        if (bestX >= 0) break; // cut at the weakest column of the first slot, then recurse
      }
      // only cut through a real valley (glued feet / serifs), never through a solid stroke (W, M)
      if (bestX < 0 || bestV > pieceMax * 0.35) { refined.push([a, b]); return; }
      cut(a, bestX - 1, depth + 1); cut(bestX + 1, b, depth + 1);
    };
    for (const [a, b] of pieces) cut(a, b, 0);
    pieces = refined;
    for (const [x0, x1] of pieces) {
      // tighten vertical extent of this piece
      let py0 = y1, py1 = y0;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (mask[y * W + x]) { if (y < py0) py0 = y; if (y > py1) py1 = y; break; }
      if (py1 >= py0) boxes.push({ x0, y0: py0, x1, y1: py1 });
    }
  }
  return boxes;
}

export interface SheetOptions {
  /** opening radius in px; 'auto' picks 0–2 from the image */
  cleanupPx?: number | 'auto';
  /** split oversized blobs (default true) */
  split?: boolean;
  /** drop frames (default true) */
  removeFrames?: boolean;
}

export interface SheetInfo { framesRemoved: number; splits: number; cleanupPx: number }

/** Full sheet-aware segmentation: frame removal → opening → components → merge → split oversized → merge again. */
export function segmentSheet(binIn: Uint8Array, w: number, h: number, opts: SheetOptions = {}): { seg: Segmentation; info: SheetInfo; bin: Uint8Array } {
  let bin = binIn;
  let framesRemoved = 0;
  if (opts.removeFrames !== false) { const r = removeFrame(bin, w, h); bin = r.bin; framesRemoved = r.removed; }
  let comps = connectedComponents(bin, w, h);
  const imgArea = w * h;
  const giant = comps.some((c) => boxW(c.bbox) * boxH(c.bbox) > 0.4 * imgArea);
  let cleanupPx = 0;
  if (opts.cleanupPx === 'auto' || opts.cleanupPx === undefined) {
    // only clean when letters are glued into one blob (halo mesh); clean scans keep their sharp corners
    cleanupPx = giant ? (h >= 600 ? 2 : 1) : 0;
  } else cleanupPx = Math.max(0, Math.min(3, Math.round(opts.cleanupPx)));
  if (cleanupPx > 0) { bin = opening(bin, w, h, cleanupPx); comps = connectedComponents(bin, w, h); }
  if (comps.length === 0) return { seg: { cells: [], lines: [], estimates: { capHeight: 0, xHeight: 0 } }, info: { framesRemoved, splits: 0, cleanupPx }, bin };

  let seg = segmentGlyphCells(comps, w, h);
  let splits = 0;
  if (opts.split !== false) {
    const heights = seg.cells.map((c) => boxH(c.bbox)).sort((a, b) => a - b);
    const bodyH = median(heights.slice(0, Math.max(1, Math.ceil(heights.length * 0.7)))) || heights[0];
    const single = seg.cells.length === 1;
    // per-line median cell width: a cell much wider than its neighbours is probably two letters
    const lineMedW = seg.lines.map((L) => median(L.cells.map((i) => boxW(seg.cells[i].bbox))));
    const next: Component[] = [];
    for (const cell of seg.cells) {
      const bw = boxW(cell.bbox), bh = boxH(cell.bbox);
      const medW = lineMedW[cell.lineIndex] || bodyH;
      const oversized = single ? bw * bh > 0.4 * imgArea || bw > bh * 1.8 : bh > bodyH * 2.2 || bw > bodyH * 1.7 || (seg.lines[cell.lineIndex].cells.length >= 4 && bw > medW * 1.6);
      if (!oversized) { next.push(...cell.components); continue; }
      const cm = compositeMask(cell.components, cell.bbox, 0);
      const boxes = splitMask(cm.mask, cm.width, cm.height);
      if (boxes.length <= 1) { next.push(...cell.components); continue; }
      splits++;
      for (const b of boxes) {
        const sw = b.x1 - b.x0 + 1, sh = b.y1 - b.y0 + 1;
        const sub = new Uint8Array(sw * sh);
        for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) sub[y * sw + x] = cm.mask[(b.y0 + y) * cm.width + (b.x0 + x)];
        for (const c of connectedComponents(sub, sw, sh)) {
          if (c.pixels < 4) continue;
          next.push({ ...c, bbox: { x0: c.bbox.x0 + b.x0 + cm.originX, y0: c.bbox.y0 + b.y0 + cm.originY, x1: c.bbox.x1 + b.x0 + cm.originX, y1: c.bbox.y1 + b.y0 + cm.originY } });
        }
      }
    }
    if (splits) seg = segmentGlyphCells(next, w, h);
  }
  return { seg, info: { framesRemoved, splits, cleanupPx }, bin };
}
