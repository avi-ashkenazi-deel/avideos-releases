/**
 * Group connected components into letter cells and text lines, in reading order.
 * All coordinates here are image pixels (y down).
 */
import { boxH, boxW, type Component, type PixelBox } from './raster';

export interface Cell {
  bbox: PixelBox;
  components: Component[];
  lineIndex: number;
  /** global reading-order index (line by line, left to right) */
  order: number;
}

export interface LineInfo {
  index: number;
  /** y of the baseline (bottom edge of the typical cell, exclusive pixel row) */
  baseline: number;
  /** estimated cap/ascender height in px above the baseline */
  capHeight: number;
  /** estimated x-height in px above the baseline */
  xHeight: number;
  top: number;
  bottom: number;
  /** indices into `cells` */
  cells: number[];
}

export interface Segmentation {
  cells: Cell[];
  lines: LineInfo[];
  /** image-wide estimates in px (median over lines) */
  estimates: { capHeight: number; xHeight: number };
}

const median = (v: number[]): number => {
  if (!v.length) return 0;
  const s = v.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const overlap1D = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0) + 1;

/**
 * Segment components into cells + lines. Components whose bboxes overlap
 * horizontally and sit vertically close are merged (i-dot + stem, '=' , ':' ...).
 */
export function segmentGlyphCells(components: Component[], _imgW: number, _imgH: number): Segmentation {
  const n = components.length;
  if (n === 0) return { cells: [], lines: [], estimates: { capHeight: 0, xHeight: 0 } };

  // typical "body" size: median height of the larger half of components
  const heights = components.map((c) => boxH(c.bbox)).sort((a, b) => a - b);
  const bodyH = median(heights.slice(Math.floor(heights.length / 2))) || heights[heights.length - 1];
  const vGapMax = Math.max(2, bodyH * 0.6);

  // union-find
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a: number, b: number) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };

  const idx = components.map((_, i) => i).sort((a, b) => components[a].bbox.x0 - components[b].bbox.x0);
  for (let ii = 0; ii < idx.length; ii++) {
    const i = idx[ii];
    const A = components[i].bbox;
    for (let jj = ii + 1; jj < idx.length; jj++) {
      const j = idx[jj];
      const B = components[j].bbox;
      if (B.x0 > A.x1) break; // sorted by x0: no horizontal overlap possible any more
      const hov = overlap1D(A.x0, A.x1, B.x0, B.x1);
      const minW = Math.min(boxW(A), boxW(B));
      if (hov < Math.max(1, minW * 0.4)) continue;
      const vgap = Math.max(A.y0, B.y0) - Math.min(A.y1, B.y1) - 1; // negative when overlapping
      if (vgap > vGapMax) continue;
      // when boxes overlap vertically but are both "big", require real horizontal containment
      // so neighbouring cursive letters with grazing bboxes do not fuse
      const bothBig = boxH(A) > bodyH * 0.5 && boxH(B) > bodyH * 0.5;
      if (vgap < 0 && bothBig && hov < minW * 0.75) continue;
      union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i); else groups.set(r, [i]);
  }
  const cells: Cell[] = [];
  for (const members of groups.values()) {
    const comps = members.map((m) => components[m]);
    const bbox: PixelBox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const c of comps) {
      bbox.x0 = Math.min(bbox.x0, c.bbox.x0); bbox.y0 = Math.min(bbox.y0, c.bbox.y0);
      bbox.x1 = Math.max(bbox.x1, c.bbox.x1); bbox.y1 = Math.max(bbox.y1, c.bbox.y1);
    }
    cells.push({ bbox, components: comps, lineIndex: 0, order: 0 });
  }

  // cluster into lines by vertical overlap
  const byY = cells.map((_, i) => i).sort((a, b) => (cells[a].bbox.y0 + cells[a].bbox.y1) - (cells[b].bbox.y0 + cells[b].bbox.y1));
  const lines: { top: number; bottom: number; cells: number[] }[] = [];
  for (const ci of byY) {
    const b = cells[ci].bbox;
    const ch = boxH(b);
    let best = -1, bestOv = 0;
    for (let li = 0; li < lines.length; li++) {
      const L = lines[li];
      const ov = overlap1D(b.y0, b.y1, L.top, L.bottom);
      const need = 0.4 * Math.min(ch, L.bottom - L.top + 1);
      if (ov >= need && ov > bestOv) { best = li; bestOv = ov; }
    }
    if (best < 0) lines.push({ top: b.y0, bottom: b.y1, cells: [ci] });
    else {
      const L = lines[best];
      L.top = Math.min(L.top, b.y0); L.bottom = Math.max(L.bottom, b.y1); L.cells.push(ci);
    }
  }
  lines.sort((a, b) => a.top - b.top);

  const infos: LineInfo[] = [];
  const ordered: Cell[] = [];
  let order = 0;
  lines.forEach((L, li) => {
    L.cells.sort((a, b) => cells[a].bbox.x0 - cells[b].bbox.x0);
    const lineCellIdx: number[] = [];
    for (const ci of L.cells) {
      const c = cells[ci];
      c.lineIndex = li; c.order = order++;
      lineCellIdx.push(ordered.length);
      ordered.push(c);
    }
    const lineCells = lineCellIdx.map((i) => ordered[i]);
    const lineH = L.bottom - L.top + 1;
    // baseline: median of cell bottoms, refined to the mode near the median (ignores descenders)
    const bottoms = lineCells.map((c) => c.bbox.y1 + 1);
    const medB = median(bottoms);
    const tol = Math.max(2, lineH * 0.15);
    const near = bottoms.filter((b) => Math.abs(b - medB) <= tol);
    const baseline = near.length ? near.reduce((s, v) => s + v, 0) / near.length : medB;
    // heights above baseline -> split into x-height group and tall group
    const hs = lineCells.map((c) => baseline - c.bbox.y0).filter((v) => v > 0);
    const { xHeight, capHeight } = splitHeights(hs);
    infos.push({ index: li, baseline, capHeight, xHeight, top: L.top, bottom: L.bottom, cells: lineCellIdx });
  });

  return {
    cells: ordered,
    lines: infos,
    estimates: {
      capHeight: median(infos.map((l) => l.capHeight)),
      xHeight: median(infos.map((l) => l.xHeight)),
    },
  };
}

/** 1-D two-means split of cell heights into {x-height, cap-height}. */
export function splitHeights(hs: number[]): { xHeight: number; capHeight: number } {
  if (hs.length === 0) return { xHeight: 0, capHeight: 0 };
  const max = Math.max(...hs), min = Math.min(...hs);
  if (hs.length === 1 || max - min < 0.2 * max) {
    const m = median(hs);
    // single group: treat it as the tall group when it's the only thing we have
    return { xHeight: m, capHeight: Math.max(m, max) };
  }
  let c0 = min, c1 = max;
  let lo: number[] = [], hi: number[] = [];
  for (let it = 0; it < 20; it++) {
    lo = []; hi = [];
    for (const h of hs) (Math.abs(h - c0) <= Math.abs(h - c1) ? lo : hi).push(h);
    const n0 = lo.length ? median(lo) : c0, n1 = hi.length ? median(hi) : c1;
    if (n0 === c0 && n1 === c1) break;
    c0 = n0; c1 = n1;
  }
  if (!lo.length || !hi.length) { const m = median(hs); return { xHeight: m, capHeight: max }; }
  return { xHeight: c0, capHeight: c1 };
}
