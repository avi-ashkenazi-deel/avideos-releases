import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readPng } from './pngDecode';
import { otsuThreshold, toGray, binarize, connectedComponents, despeckle } from '../../src/inputs/image/raster';
import { segmentGlyphCells } from '../../src/inputs/image/segment';
import { zhangSuen, skeletonToPolylines, distanceTransform, sampleField } from '../../src/inputs/image/thin';
import { parsePotraceSvg } from '../../src/inputs/image/potrace';
import { traceImage, labelCells } from '../../src/inputs/image/index';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, '../fixtures/handwriting.png');

/** gray image helper: returns {width,height,data} with 1 channel */
function grayImage(w: number, h: number, fill: (x: number, y: number) => number) {
  const data = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = fill(x, y);
  return { width: w, height: h, data };
}
function rect(bin: Uint8Array, w: number, x0: number, y0: number, x1: number, y1: number) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) bin[y * w + x] = 1;
}

describe('raster', () => {
  it('otsu picks a threshold between two modes', () => {
    const img = grayImage(64, 64, (x) => (x < 20 ? 30 + (x % 5) : 220 - (x % 7)));
    const g = toGray(img);
    const t = otsuThreshold(g);
    expect(t).toBeGreaterThan(40);
    expect(t).toBeLessThan(210);
    const bin = binarize(g, t);
    let ink = 0;
    for (const v of bin) ink += v;
    expect(ink).toBe(20 * 64);
  });

  it('toGray composites RGBA over white and handles RGB', () => {
    const rgba = { width: 2, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0]) };
    const g = toGray(rgba);
    expect(g[0]).toBeCloseTo(0);
    expect(g[1]).toBeCloseTo(255);
    const rgb = { width: 1, height: 1, data: new Uint8ClampedArray([255, 255, 255]) };
    expect(toGray(rgb)[0]).toBeCloseTo(255);
  });

  it('connectedComponents finds exactly 3 separated squares', () => {
    const w = 100, h = 60;
    const bin = new Uint8Array(w * h);
    rect(bin, w, 5, 5, 14, 14);
    rect(bin, w, 40, 20, 49, 29);
    rect(bin, w, 80, 40, 89, 49);
    const comps = connectedComponents(bin, w, h);
    expect(comps.length).toBe(3);
    const sorted = comps.slice().sort((a, b) => a.bbox.x0 - b.bbox.x0);
    expect(sorted[0].bbox).toEqual({ x0: 5, y0: 5, x1: 14, y1: 14 });
    expect(sorted[0].pixels).toBe(100);
    expect(sorted[0].mask.length).toBe(100);
    expect(sorted[2].bbox.x0).toBe(80);
  });

  it('despeckle removes tiny components only', () => {
    const w = 40, h = 20;
    const bin = new Uint8Array(w * h);
    rect(bin, w, 2, 2, 9, 9);
    bin[15 * w + 30] = 1; bin[15 * w + 31] = 1;
    const out = despeckle(bin, w, h, 5);
    expect(connectedComponents(out, w, h).length).toBe(1);
    expect(out[15 * w + 30]).toBe(0);
    expect(out[2 * w + 2]).toBe(1);
  });
});

describe('segment', () => {
  it('merges an i-dot with its stem and orders cells left to right', () => {
    const w = 200, h = 100;
    const bin = new Uint8Array(w * h);
    // 'l' at x 20..27, y 20..79 ; 'i' stem at x 60..67 y 40..79 with dot at y 22..29 ; 'o' block at x 120..150, y 40..79
    rect(bin, w, 20, 20, 27, 79);
    rect(bin, w, 60, 40, 67, 79);
    rect(bin, w, 61, 22, 66, 29);
    rect(bin, w, 120, 40, 150, 79);
    const comps = connectedComponents(bin, w, h);
    expect(comps.length).toBe(4);
    const seg = segmentGlyphCells(comps, w, h);
    expect(seg.cells.length).toBe(3);
    expect(seg.cells.map((c) => c.bbox.x0)).toEqual([20, 60, 120]);
    expect(seg.cells.map((c) => c.order)).toEqual([0, 1, 2]);
    const iCell = seg.cells[1];
    expect(iCell.components.length).toBe(2);
    expect(iCell.bbox.y0).toBe(22);
    expect(seg.lines.length).toBe(1);
    expect(seg.lines[0].baseline).toBeCloseTo(80, 5);
    // 'o' and i-stem are x-height (40 px), 'l' is tall (60 px)
    expect(seg.lines[0].xHeight).toBeCloseTo(40, 0);
    expect(seg.lines[0].capHeight).toBeGreaterThanOrEqual(58);
  });

  it('splits two text lines and keeps reading order', () => {
    const w = 120, h = 120;
    const bin = new Uint8Array(w * h);
    rect(bin, w, 60, 10, 70, 40); // line 1, second glyph
    rect(bin, w, 10, 10, 20, 40); // line 1, first glyph
    rect(bin, w, 10, 70, 20, 100); // line 2
    const seg = segmentGlyphCells(connectedComponents(bin, w, h), w, h);
    expect(seg.lines.length).toBe(2);
    expect(seg.cells.map((c) => [c.lineIndex, c.bbox.x0])).toEqual([[0, 10], [0, 60], [1, 10]]);
  });
});

describe('thin', () => {
  it('skeletonises a 20 px bar to a centre line with half-width ~10 from the DT', () => {
    const w = 120, h = 40;
    const mask = new Uint8Array(w * h);
    rect(mask, w, 10, 10, 109, 29); // 100 x 20 bar, rows 10..29
    const skel = zhangSuen(mask, w, h);
    let count = 0;
    for (const v of skel) count += v;
    expect(count).toBeGreaterThan(60);
    expect(count).toBeLessThan(140);
    const polys = skeletonToPolylines(skel, w, h);
    expect(polys.length).toBe(1);
    const poly = polys[0];
    const xs = poly.map((p) => p[0]);
    expect(Math.min(...xs)).toBeLessThan(25);
    expect(Math.max(...xs)).toBeGreaterThan(95);
    // centre rows are 19/20 -> centres 19.5 / 20.5
    for (const [, y] of poly) { expect(y).toBeGreaterThan(17); expect(y).toBeLessThan(23); }
    const dt = distanceTransform(mask, w, h);
    const mid = poly[Math.floor(poly.length / 2)];
    const hw = sampleField(dt, w, h, mid[0], mid[1]);
    expect(Math.abs(hw - 10)).toBeLessThanOrEqual(2);
    expect(dt[0]).toBe(0);
  });

  it('traces a closed loop (ring) as one closed polyline', () => {
    const w = 60, h = 60;
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const d = Math.hypot(x + 0.5 - 30, y + 0.5 - 30);
      if (d > 14 && d < 24) mask[y * w + x] = 1;
    }
    const skel = zhangSuen(mask, w, h);
    const polys = skeletonToPolylines(skel, w, h);
    expect(polys.length).toBe(1);
    const p = polys[0];
    expect(p.length).toBeGreaterThan(60);
    const [a, b] = [p[0], p[p.length - 1]];
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(0.01);
  });
});

describe('potrace svg parser', () => {
  it('parses potrace-style relative paths and applies the group transform', () => {
    const svg = '<svg><g transform="translate(0.000000,40.000000) scale(0.100000,-0.100000)" fill="#000000"><path d="M110 195 l0 -95 95 0 95 0 0 95 0 95 -95 0 -95 0 0 -95z"/></g></svg>';
    const cs = parsePotraceSvg(svg);
    expect(cs.length).toBe(1);
    const xs = cs[0].points.map((p) => p[0]), ys = cs[0].points.map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(11, 5);
    expect(Math.max(...xs)).toBeCloseTo(30, 5);
    expect(Math.min(...ys)).toBeCloseTo(40 - 29, 5);
    expect(Math.max(...ys)).toBeCloseTo(40 - 10, 5);
  });
});

describe('traceImage on the handwriting fixture', () => {
  const img = readPng(FIXTURE);

  it('decodes the fixture', () => {
    expect(img.width).toBe(900);
    expect(img.height).toBe(300);
  });

  it('strokes mode returns 3 cells in order with sane geometry', async () => {
    const res = await traceImage(img, { mode: 'strokes' });
    expect(res.lines).toBe(1);
    expect(res.cells.length).toBe(3);
    expect(res.cells.map((c) => c.cellIndex)).toEqual([0, 1, 2]);
    expect(res.cells.map((c) => c.bbox.x0)).toEqual(res.cells.map((c) => c.bbox.x0).slice().sort((a, b) => a - b));
    for (const cell of res.cells) {
      const g = cell.glyph;
      expect(g.kind).toBe('stroke');
      expect(g.char).toBe('');
      expect(g.strokes!.length).toBeGreaterThanOrEqual(1);
      let minY = Infinity, maxY = -Infinity, minX = Infinity;
      for (const s of g.strokes!) for (const p of s.points) {
        expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.w)).toBe(true);
        expect(p.w).toBeGreaterThanOrEqual(6);
        expect(p.w).toBeLessThanOrEqual(120);
        minY = Math.min(minY, p.y - p.w); maxY = Math.max(maxY, p.y + p.w); minX = Math.min(minX, p.x - p.w);
      }
      const inkH = maxY - minY;
      expect(inkH).toBeGreaterThanOrEqual(250);
      expect(inkH).toBeLessThanOrEqual(800);
      expect(minY).toBeGreaterThan(-60); // sits on the baseline
      expect(minX).toBeGreaterThan(20);
      expect(g.advance).toBeGreaterThan(120);
      expect(cell.thumbnail.mask.length).toBe(cell.thumbnail.width * cell.thumbnail.height);
    }
    // 'b' (middle) is the tall one and should hit the target cap height
    const b = res.cells[1].glyph;
    let top = -Infinity;
    for (const s of b.strokes!) for (const p of s.points) top = Math.max(top, p.y + p.w);
    expect(top).toBeGreaterThan(600);
    expect(top).toBeLessThan(800);
    // the brush was 14 px wide: half-width should be ~7 px * scale
    const mid = b.strokes!.flatMap((s) => s.points.map((p) => p.w)).sort((x, y) => x - y);
    const medianW = mid[mid.length >> 1];
    expect(Math.abs(medianW - 7 * res.scale)).toBeLessThan(2.5 * res.scale);
    expect(res.estimates.capHeight).toBeCloseTo(700, 0);
    expect(res.estimates.xHeight).toBeLessThan(res.estimates.capHeight);

    const labelled = labelCells(res.cells, 'a b\nc');
    expect(labelled.map((g) => g.char)).toEqual(['a', 'b', 'c']);
    expect(labelled.map((g) => g.unicode)).toEqual([97, 98, 99]);
    expect(res.cells[2].glyph.char).toBe('c');
  });

  it('outline mode traces closed contours via potrace (wasm runs in Node with the require shim)', async () => {
    const res = await traceImage(img, { mode: 'outline' });
    expect(res.cells.length).toBe(3);
    for (const cell of res.cells) {
      const g = cell.glyph;
      expect(g.kind).toBe('outline');
      expect(g.contours!.length).toBeGreaterThanOrEqual(1);
      for (const c of g.contours!) {
        expect(c.points.length).toBeGreaterThanOrEqual(3);
        for (const p of c.points) expect(Number.isFinite(p[0]) && Number.isFinite(p[1])).toBe(true);
      }
    }
    // 'b' has a counter: expect at least 2 contours (outer + hole)
    expect(res.cells[1].glyph.contours!.length).toBeGreaterThanOrEqual(2);
  });
});
