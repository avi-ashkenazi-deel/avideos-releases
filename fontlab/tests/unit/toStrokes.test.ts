import { describe, it, expect } from 'vitest';
import { outlineToStrokes, outlinesToStrokes, estimateStrokeWidth } from '../../src/inputs/fontimport/toStrokes';
import { glyphToContours } from '../../src/outline';
import { bboxStrokes, signedArea } from '../../src/core/geometry';
import type { Contour, Glyph, Vec } from '../../src/core/glyph';

const rect = (x0: number, y0: number, x1: number, y1: number): Contour => ({ points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });
const circle = (cx: number, cy: number, r: number, ccw: boolean, n = 96): Contour => {
  const pts: Vec[] = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2 * (ccw ? 1 : -1); pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return { points: pts };
};
const outline = (char: string, contours: Contour[], advance = 600): Glyph =>
  ({ char, unicode: char.codePointAt(0)!, advance, source: 'imported', kind: 'outline', contours });

const area = (cs: Contour[]) => cs.reduce((a, c) => a + signedArea(c.points), 0);
const median = (xs: number[]) => { const s = xs.slice().sort((a, b) => a - b); return s[s.length >> 1]; };

describe('outlineToStrokes', () => {
  it('turns a 60 x 600 rectangle into one vertical stroke of half-width ~30', () => {
    const g = outline('l', [rect(100, 0, 160, 600)], 260);
    const t0 = performance.now();
    const r = outlineToStrokes(g);
    const ms = performance.now() - t0;
    console.log(`rect: ${ms.toFixed(1)} ms`);
    expect(r.kind).toBe('stroke');
    expect(r.contours).toBeUndefined();
    expect(r.advance).toBe(260);
    expect(r.char).toBe('l');
    expect(r.source).toBe('imported');
    expect(r.strokes).toHaveLength(1);
    const pts = r.strokes![0].points;
    expect(pts.length).toBeGreaterThan(10);
    for (const p of pts) {
      expect(Math.abs(p.w - 30)).toBeLessThanOrEqual(4);
      expect(Math.abs(p.x - 130)).toBeLessThanOrEqual(3);
    }
    const ys = pts.map((p) => p.y);
    const extent = Math.max(...ys) - Math.min(...ys);
    expect(Math.abs(extent - 600)).toBeLessThanOrEqual(40);
    // a flat-ended rectangle is detected as flat-terminal
    expect(r.strokes![0].cap).toBe('flat');
    expect(g.kind).toBe('outline'); // input untouched
  });

  it('turns a ring into a closed centreline whose expansion has an outer ring and a hole', () => {
    const g = outline('o', [circle(300, 300, 250, true), circle(300, 300, 190, false)]);
    const r = outlineToStrokes(g);
    expect(r.kind).toBe('stroke');
    expect(r.strokes!.length).toBeGreaterThanOrEqual(1);
    expect(r.strokes!.length).toBeLessThanOrEqual(2);
    const all = r.strokes!.flatMap((s) => s.points);
    for (const p of all) {
      expect(Math.abs(p.w - 30)).toBeLessThanOrEqual(5);
      const rad = Math.hypot(p.x - 300, p.y - 300);
      expect(Math.abs(rad - 220)).toBeLessThanOrEqual(6);
    }
    // closed-ish: first and last point of the (main) stroke meet
    const main = r.strokes!.slice().sort((a, b) => b.points.length - a.points.length)[0].points;
    const gap = Math.hypot(main[0].x - main[main.length - 1].x, main[0].y - main[main.length - 1].y);
    expect(gap).toBeLessThan(25);
    const cs = glyphToContours(r);
    expect(cs).toHaveLength(2);
    expect(cs.filter((c) => signedArea(c.points) > 0)).toHaveLength(1);
    expect(cs.filter((c) => signedArea(c.points) < 0)).toHaveLength(1);
    const a0 = area(glyphToContours(g)), a1 = area(cs);
    expect(Math.abs(a1 - a0) / a0).toBeLessThan(0.2);
  });

  it('turns an H made of three rectangles into 2-4 strokes covering the H', () => {
    const g = outline('H', [rect(50, 0, 130, 700), rect(370, 0, 450, 700), rect(130, 320, 370, 380)], 500);
    const r = outlineToStrokes(g);
    expect(r.kind).toBe('stroke');
    expect(r.strokes!.length).toBeGreaterThanOrEqual(2);
    expect(r.strokes!.length).toBeLessThanOrEqual(4);
    const bb = bboxStrokes(r.strokes!);
    expect(bb.minX).toBeLessThan(60); expect(bb.maxX).toBeGreaterThan(440);
    expect(bb.minY).toBeLessThan(10); expect(bb.maxY).toBeGreaterThan(690);
    // stems ~80 wide, bar ~60 wide
    const ws = r.strokes!.map((s) => median(s.points.map((p) => p.w)));
    expect(Math.max(...ws)).toBeGreaterThan(34); expect(Math.max(...ws)).toBeLessThan(46);
    expect(Math.min(...ws)).toBeGreaterThan(24); expect(Math.min(...ws)).toBeLessThan(36);
    // ink is reproduced: area within 25 %
    const a0 = area(glyphToContours(g)), a1 = area(glyphToContours(r));
    expect(Math.abs(a1 - a0) / a0).toBeLessThan(0.25);
  });

  it('returns empty / non-outline glyphs unchanged (same object)', () => {
    const empty = outline('x', []);
    expect(outlineToStrokes(empty)).toBe(empty);
    const degenerate = outline('y', [{ points: [[0, 0], [1, 0]] }]);
    expect(outlineToStrokes(degenerate)).toBe(degenerate);
    const stroke: Glyph = { char: 'i', unicode: 105, advance: 200, source: 'drawn', kind: 'stroke', strokes: [] };
    expect(outlineToStrokes(stroke)).toBe(stroke);
    const list = outlinesToStrokes([stroke, outline('l', [rect(100, 0, 160, 600)])]);
    expect(list[0]).toBe(stroke);
    expect(list[1].kind).toBe('stroke');
  });

  it('is deterministic apart from stroke ids', () => {
    const g = outline('H', [rect(50, 0, 130, 700), rect(370, 0, 450, 700), rect(130, 320, 370, 380)]);
    const strip = (r: Glyph) => r.strokes!.map((s) => ({ cap: s.cap, points: s.points }));
    expect(strip(outlineToStrokes(g))).toEqual(strip(outlineToStrokes(g)));
  });

  it('estimateStrokeWidth reports ~60 for a 60-wide bar and the median width of a stroke glyph', () => {
    const g = outline('l', [rect(100, 0, 160, 600)]);
    expect(Math.abs(estimateStrokeWidth(g) - 60)).toBeLessThan(8);
    expect(estimateStrokeWidth(outline('x', []))).toBe(0);
    const s: Glyph = { char: 'i', unicode: 105, advance: 200, source: 'drawn', kind: 'stroke', strokes: [{ id: 'a', cap: 'round', points: [{ x: 0, y: 0, w: 20 }, { x: 0, y: 100, w: 24 }, { x: 0, y: 200, w: 22 }] }] };
    expect(estimateStrokeWidth(s)).toBe(44);
  });

  it('converts a glyph in well under 60 ms at 512 px/em', () => {
    const g = outline('H', [rect(50, 0, 130, 700), rect(370, 0, 450, 700), rect(130, 320, 370, 380)]);
    outlineToStrokes(g); // warm up
    const t0 = performance.now();
    const N = 5;
    for (let i = 0; i < N; i++) outlineToStrokes(g);
    const ms = (performance.now() - t0) / N;
    console.log(`H @512px/em: ${ms.toFixed(1)} ms per glyph`);
    expect(ms).toBeLessThan(60);
  });
});
