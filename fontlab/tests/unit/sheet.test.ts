import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { removeFrame, opening, splitMask, segmentSheet } from '../../src/inputs/image/sheet';
import { connectedComponents } from '../../src/inputs/image/raster';
import { traceImage, labelCellsDetailed, type TracedCell } from '../../src/inputs/image';
import { decodePng } from './pngDecode';

const blank = (w: number, h: number) => new Uint8Array(w * h);
const fill = (b: Uint8Array, w: number, x0: number, y0: number, x1: number, y1: number) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) b[y * w + x] = 1; };
const hollow = (b: Uint8Array, w: number, x0: number, y0: number, x1: number, y1: number, t: number) => { fill(b, w, x0, y0, x1, y0 + t - 1); fill(b, w, x0, y1 - t + 1, x1, y1); fill(b, w, x0, y0, x0 + t - 1, y1); fill(b, w, x1 - t + 1, y0, x1, y1); };

describe('sheet: frame + opening', () => {
  it('removeFrame drops a border frame and keeps the letters', () => {
    const w = 200, h = 120, b = blank(w, h);
    hollow(b, w, 0, 0, w - 1, h - 1, 4);
    fill(b, w, 40, 40, 60, 90); fill(b, w, 100, 40, 120, 90);
    const r = removeFrame(b, w, h);
    expect(r.removed).toBe(1);
    expect(connectedComponents(r.bin, w, h)).toHaveLength(2);
  });
  it('opening r=1 removes 1-px lines but keeps 6-px bars', () => {
    const w = 120, h = 60, b = blank(w, h);
    fill(b, w, 10, 30, 110, 30);          // 1 px line
    fill(b, w, 20, 10, 100, 15);          // 6 px bar
    const o = opening(b, w, h, 1);
    const comps = connectedComponents(o, w, h);
    expect(comps).toHaveLength(1);
    expect(comps[0].bbox.y0).toBe(10);
    expect(comps[0].pixels).toBeGreaterThan(400);
  });
});

describe('sheet: splitMask', () => {
  it('splits a 3×5 grid of touching rectangles into 15 boxes in reading order', () => {
    const W = 260, H = 160, m = blank(W, H);
    // rectangles 40×40 with 10px paper gaps, joined by a 1px mesh so one blob
    for (let r = 0; r < 3; r++) for (let c = 0; c < 5; c++) fill(m, W, 5 + c * 50, 5 + r * 50, 5 + c * 50 + 39, 5 + r * 50 + 39);
    for (let r = 0; r < 3; r++) fill(m, W, 0, 5 + r * 50 + 20, W - 1, 5 + r * 50 + 20); // horizontal 1px mesh lines through each row
    const boxes = splitMask(m, W, H);
    expect(boxes.length).toBe(15);
    for (let i = 1; i < 5; i++) expect(boxes[i].x0).toBeGreaterThan(boxes[i - 1].x1);
    expect(boxes[5].y0).toBeGreaterThan(boxes[0].y1);
  });
  it('pitch-cuts a wide run with no clean gap', () => {
    const W = 300, H = 60, m = blank(W, H);
    fill(m, W, 10, 10, 289, 49);               // one wide bar 280×40: 7× its height
    for (let i = 1; i < 7; i++) fill(m, W, 10 + i * 40, 10, 10 + i * 40, 49); // same ink: no valley at all
    const boxes = splitMask(m, W, H);
    expect(boxes.length).toBeGreaterThanOrEqual(4); // recursion limited, but it must cut
  });
});

describe('sheet: end to end on the dense specimen fixture', () => {
  const png = decodePng(fs.readFileSync('tests/fixtures/sheet.png'));
  it('segmentSheet finds 32 cells on 4 lines, removing the frame and splitting the mesh', async () => {
    const res = await traceImage(png, { mode: 'strokes' });
    expect(res.lines).toBe(4);
    expect(res.cells.length).toBe(32);
    expect(res.info.framesRemoved + res.info.splits).toBeGreaterThan(0);
    // reading order: first row left→right
    const first = res.cells.filter((c) => c.lineIndex === 0).sort((a, b) => a.cellIndex - b.cellIndex);
    expect(first).toHaveLength(8);
    for (let i = 1; i < first.length; i++) expect(first[i].bbox.x0).toBeGreaterThan(first[i - 1].bbox.x0);
    for (const c of res.cells) expect(c.glyph.strokes!.length).toBeGreaterThan(0);
  });
  it('without split/cleanup the same image collapses to one cell (the old behaviour)', () => {
    const w = png.width, h = png.height;
    const gray = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) gray[i] = png.data[i * 4];
    const bin = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) bin[i] = gray[i] < 128 ? 1 : 0;
    const r = segmentSheet(bin, w, h, { split: false, cleanupPx: 0, removeFrames: false });
    expect(r.seg.cells.length).toBe(1);
  });
  it('labelCellsDetailed reports missing / extra and honours skipped cells', async () => {
    const res = await traceImage(png, { mode: 'strokes' });
    const cells = res.cells as TracedCell[];
    const l30 = labelCellsDetailed(cells, 'abcdefghijklmnopqrstuvwxyz0123'.slice(0, 30));
    expect(l30.glyphs).toHaveLength(30); expect(l30.missing).toBe(2); expect(l30.extra).toBe(0);
    expect(l30.assigned.slice(0, 3)).toEqual(['a', 'b', 'c']); expect(l30.assigned.slice(-2)).toEqual([null, null]);
    const l34 = labelCellsDetailed(cells, 'abcdefghijklmnopqrstuvwxyz01234567');
    expect(l34.extra).toBe(2); expect(l34.glyphs).toHaveLength(32);
    const skip = labelCellsDetailed(cells, 'xyz', new Set([0]));
    expect(skip.assigned[0]).toBeNull(); expect(skip.assigned[1]).toBe('x');
  });
});

describe('light-on-dark and heavy letters', () => {
  const dark = decodePng(fs.readFileSync('tests/fixtures/sheet-dark.png'));
  it('auto-detects white letters on black and finds all 32 cells without cleanup', async () => {
    const res = await traceImage(dark, { mode: 'outline' });
    expect(res.inverted).toBe(true);
    expect(res.info.cleanupPx).toBe(0);
    expect(res.cells.length).toBe(32);
    expect(res.lines).toBe(4);
    for (const c of res.cells) expect(c.glyph.contours!.length).toBeGreaterThan(0);
  });
  it('explicit invert:false on the dark sheet gives the old garbage (so auto matters)', async () => {
    const res = await traceImage(dark, { mode: 'outline', invert: false });
    expect(res.inverted).toBe(false);
    expect(res.cells.length).not.toBe(32);
  });
  it('flags heavy letters; the thin handwriting fixture is not heavy', async () => {
    const heavy = await traceImage(dark, { mode: 'outline' });
    expect(heavy.heavy).toBe(true);
    const hw = decodePng(fs.readFileSync('tests/fixtures/handwriting.png'));
    const light = await traceImage(hw, { mode: 'outline' });
    expect(light.heavy).toBe(false);
    expect(light.inverted).toBe(false);
  });
  it('strokes mode goes through the outline skeletoniser: flat caps stay flat (stem spans the full height)', async () => {
    const res = await traceImage(dark, { mode: 'strokes' });
    const stem = res.cells[0].glyph; // first shape is a plain stem
    expect(stem.kind).toBe('stroke');
    const ys = stem.strokes!.flatMap((s) => s.points.map((p) => p.y));
    const outline = (await traceImage(dark, { mode: 'outline' })).cells[0].glyph;
    const oys = outline.contours!.flatMap((c) => c.points.map((p) => p[1]));
    expect(Math.max(...ys)).toBeGreaterThan(Math.max(...oys) - 30);
    expect(Math.min(...ys)).toBeLessThan(Math.min(...oys) + 30);
  });
});

describe('tightly cropped dark frame (no paper margin)', () => {
  const tight = decodePng(fs.readFileSync('tests/fixtures/sheet-dark-tight.png'));
  it('still detects light-on-dark and finds all cells as crisp outlines', async () => {
    const res = await traceImage(tight, { mode: 'outline' });
    expect(res.inverted).toBe(true);
    expect(res.heavy).toBe(true);
    expect(res.cells.length).toBe(32);
    expect(res.lines).toBe(4);
  });
  it('a thin dark frame or mesh on white never triggers inversion', async () => {
    const light = decodePng(fs.readFileSync('tests/fixtures/sheet.png'));
    expect((await traceImage(light, { mode: 'outline' })).inverted).toBe(false);
  });
});
