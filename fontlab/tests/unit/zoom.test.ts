import { describe, it, expect } from 'vitest';
import { NO_ZOOM, applyZoom, zoomAbout, clampZoom, isZoomed, MIN_ZOOM, MAX_ZOOM } from '../../src/inputs/draw/zoom';
import { fitView, type View } from '../../src/ui/render';
import { EditorModel } from '../../src/inputs/draw/editor';
import { DEFAULT_METRICS } from '../../src/core/glyph';
import type { Glyph, Vec } from '../../src/core/glyph';

const base: View = { ox: 40, oy: 400, s: 0.4 };
const toCanvas = (v: View, p: Vec): Vec => [v.ox + p[0] * v.s, v.oy - p[1] * v.s];

describe('canvas zoom', () => {
  it('no zoom leaves the view alone', () => {
    expect(applyZoom(base, NO_ZOOM)).toEqual(base);
    expect(isZoomed(NO_ZOOM)).toBe(false);
  });

  it('a pinch keeps the point under the fingers in place', () => {
    const p: Vec = [300, 250];                 // a font point
    const from = toCanvas(base, p);            // where the fingers start
    const z = zoomAbout(NO_ZOOM, from, from, 3);
    expect(z.k).toBe(3);
    const after = toCanvas(applyZoom(base, z), p);
    expect(after[0]).toBeCloseTo(from[0], 6);
    expect(after[1]).toBeCloseTo(from[1], 6);
    expect(isZoomed(z)).toBe(true);
  });

  it('moving both fingers pans: the point follows the midpoint', () => {
    const p: Vec = [120, 500];
    const from = toCanvas(base, p), to: Vec = [from[0] + 60, from[1] - 35];
    const after = toCanvas(applyZoom(base, zoomAbout(NO_ZOOM, from, to, 1.5)), p);
    expect(after[0]).toBeCloseTo(to[0], 6);
    expect(after[1]).toBeCloseTo(to[1], 6);
  });

  it('a second pinch continues from the first', () => {
    const p: Vec = [0, 0];
    const z1 = zoomAbout(NO_ZOOM, [100, 100], [100, 100], 2);
    const at = toCanvas(applyZoom(base, z1), p);
    const z2 = zoomAbout(z1, at, at, 2);
    expect(z2.k).toBe(4);
    const after = toCanvas(applyZoom(base, z2), p);
    expect(after[0]).toBeCloseTo(at[0], 6);
    expect(after[1]).toBeCloseTo(at[1], 6);
  });

  it('zoom is limited and the letter cannot be pushed off screen', () => {
    expect(zoomAbout(NO_ZOOM, [0, 0], [0, 0], 1000).k).toBe(MAX_ZOOM);
    expect(zoomAbout(NO_ZOOM, [0, 0], [0, 0], 0.001).k).toBe(MIN_ZOOM);
    const w = 390, h = 460;
    const far = clampZoom({ k: 2, tx: 5000, ty: -5000 }, w, h);
    // part of the fitted view (0..w*k, 0..h*k) is still inside the canvas
    expect(far.tx).toBeLessThan(w);
    expect(far.tx + w * far.k).toBeGreaterThan(0);
    expect(far.ty + h * far.k).toBeGreaterThan(0);
    expect(far.ty).toBeLessThan(h);
  });
});

describe('fitView on a narrow canvas', () => {
  const m = DEFAULT_METRICS;
  it('is unchanged when the letter fits the width', () => {
    expect(fitView(480, 504, m, 24, 520)).toEqual(fitView(480, 504, m));
  });
  it('scales a wide letter down to the width and centres it vertically', () => {
    const tall = fitView(390, 700, m), v = fitView(390, 700, m, 24, 1000);
    expect(v.s).toBeLessThan(tall.s);
    // the whole advance fits between the paddings
    expect(v.ox + 1000 * v.s).toBeLessThanOrEqual(390 - 24 + 1e-6);
    // ascender and descender are equally far from the top and bottom edge
    const top = v.oy - (m.ascender + 80) * v.s, bottom = v.oy - (m.descender - 80) * v.s;
    expect(top).toBeCloseTo(700 - bottom, 6);
  });
});

describe('several fingers on the point editor', () => {
  const glyph = (): Glyph => ({
    char: 'l', unicode: 108, advance: 400, source: 'drawn', kind: 'stroke',
    strokes: [{ id: 'a', cap: 'round', points: [{ x: 100, y: 0, w: 40 }, { x: 100, y: 300, w: 40 }, { x: 100, y: 600, w: 20 }] }],
  });

  it('each finger moves its own point, and they do not undo each other', () => {
    const m = new EditorModel(glyph());
    m.beginDrag();
    m.dragMany([{ refs: [{ stroke: 0, point: 0 }], dx: -50, dy: 10 }, { refs: [{ stroke: 0, point: 2 }], dx: 80, dy: -20 }]);
    // a later frame: only the first finger moved further
    m.dragMany([{ refs: [{ stroke: 0, point: 0 }], dx: -70, dy: 10 }, { refs: [{ stroke: 0, point: 2 }], dx: 80, dy: -20 }]);
    const pts = m.getGlyph().strokes![0].points;
    expect([pts[0].x, pts[0].y]).toEqual([30, 10]);
    expect([pts[1].x, pts[1].y]).toEqual([100, 300]);
    expect([pts[2].x, pts[2].y]).toEqual([180, 580]);
    expect(m.nodePos({ stroke: 0, point: 2 })).toEqual([180, 580]);
  });

  it('the whole gesture is one undo step', () => {
    const m = new EditorModel(glyph());
    m.beginDrag();
    m.dragMany([{ refs: [{ stroke: 0, point: 0 }], dx: -50, dy: 0 }, { refs: [{ stroke: 0, point: 2 }], dx: 50, dy: 0 }]);
    expect(m.endDrag()).toBe(true);
    expect(m.undo()).toBe(true);
    expect(m.getGlyph().strokes![0].points.map((p) => p.x)).toEqual([100, 100, 100]);
    expect(m.canUndo()).toBe(false);
  });

  it('a point and a curve handle can be dragged together', () => {
    const k = 55.22847498;
    const circle: Glyph = {
      char: 'o', unicode: 111, advance: 400, source: 'drawn', kind: 'outline',
      curves: [{ start: [300, 200], segments: [
        [[300, 200], [300, 200 + k], [200 + k, 300], [200, 300]],
        [[200, 300], [200 - k, 300], [100, 200 + k], [100, 200]],
        [[100, 200], [100, 200 - k], [200 - k, 100], [200, 100]],
        [[200, 100], [200 + k, 100], [300, 200 - k], [300, 200]],
      ] }],
    };
    const m = new EditorModel(circle);
    m.beginDrag();
    m.dragMany([{ refs: [{ contour: 0, segment: 2 }], dx: -40, dy: 0 }], [{ ref: { contour: 0, segment: 0, handle: 1 }, pos: [340, 280] }]);
    const c = m.getGlyph().curves![0];
    expect(c.segments[2][0]).toEqual([60, 200]);   // the anchor moved
    expect(c.segments[1][3]).toEqual([60, 200]);   // and the segment before it still ends there
    expect(c.segments[0][1]).toEqual([340, 280]);  // the handle went where its finger is
    expect(m.endDrag()).toBe(true);
  });
});
