import { describe, it, expect } from 'vitest';
import { knifeGlyph, knifeCut, knifeMarks, KNIFE_EXTEND } from '../../src/inputs/draw/knife';
import { rectContour, ellipseContour } from '../../src/inputs/draw/shapes';
import { reverseContour } from '../../src/inputs/draw/pen';
import { flattenCurves } from '../../src/inputs/draw/curves';
import { signedArea, bboxOf } from '../../src/core/geometry';
import { glyphToContours } from '../../src/outline';
import { EditorModel } from '../../src/inputs/draw/editor';
import type { Glyph, CurveContour, Contour, Stroke, Vec } from '../../src/core/glyph';

const strokeLen = (s: Stroke) => s.points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - s.points[i].x, p.y - s.points[i].y), 0);
const area = (cs: Contour[]) => cs.reduce((sum, c) => sum + signedArea(c.points), 0);
const flat16 = (curves: CurveContour[]) => flattenCurves(curves, 16);
const chained = (c: CurveContour) => {
  expect(c.segments.length).toBeGreaterThan(0);
  expect(c.segments[0][0]).toEqual(c.start);
  for (let i = 1; i < c.segments.length; i++) expect(c.segments[i][0]).toEqual(c.segments[i - 1][3]);
  expect(c.segments[c.segments.length - 1][3]).toEqual(c.start);
};
/** curves and contours agree: contours are the flattening of curves */
const consistent = (g: Glyph) => {
  expect(g.curves).toBeDefined();
  g.curves!.forEach(chained);
  expect(g.contours).toEqual(flat16(g.curves!));
};

const stroke = (id: string, pts: [number, number][], w = 40, cap: Stroke['cap'] = 'flat'): Stroke => ({ id, cap, points: pts.map(([x, y]) => ({ x, y, w })) });
const strokeGlyph = (...strokes: Stroke[]): Glyph => ({ char: 'l', unicode: 108, advance: 500, source: 'drawn', kind: 'stroke', strokes });
const outlineGlyph = (curves: CurveContour[], strokes?: Stroke[]): Glyph => ({ char: 'o', unicode: 111, advance: 700, source: 'drawn', kind: 'outline', curves, contours: flat16(curves), ...(strokes ? { strokes } : {}) });
/** a ring: circle of radius 250 at (300, 300) with a counter of radius 150 */
const ring = () => outlineGlyph([ellipseContour([50, 50], [550, 550]), reverseContour(ellipseContour([150, 150], [450, 450]))]);
const RING_AREA = Math.PI * (250 * 250 - 150 * 150);

describe('knife on strokes', () => {
  it('splits a vertical stroke crossed by a horizontal cut into two strokes', () => {
    const g = strokeGlyph(stroke('a', [[100, 0], [100, 300], [100, 600]]));
    const out = knifeGlyph(g, [0, 200], [200, 200])!;
    expect(out).not.toBeNull();
    expect(out.strokes).toHaveLength(2);
    const [lo, hi] = out.strokes!;
    expect(lo.points.map((p) => [p.x, p.y])).toEqual([[100, 0], [100, 200]]);
    expect(hi.points.map((p) => [p.x, p.y])).toEqual([[100, 200], [100, 300], [100, 600]]);
    expect(strokeLen(lo) + strokeLen(hi)).toBeCloseTo(600, 6);
    expect(new Set([lo.id, hi.id, 'a']).size).toBe(3); // new ids
    expect(lo.cap).toBe('flat');
    expect(g.strokes).toHaveLength(1); // the input is not mutated
  });

  it('interpolates the width at the cut', () => {
    const g = strokeGlyph({ id: 'a', cap: 'round', points: [{ x: 100, y: 0, w: 20 }, { x: 100, y: 400, w: 60 }] });
    const out = knifeGlyph(g, [0, 100], [200, 100])!;
    expect(out.strokes![0].points[1]).toMatchObject({ x: 100, y: 100, w: 30 });
    expect(out.strokes![1].points[0]).toMatchObject({ x: 100, y: 100, w: 30 });
  });

  it('with a gap, pulls both new ends back by half the gap', () => {
    const g = strokeGlyph(stroke('a', [[100, 0], [100, 600]]));
    const out = knifeGlyph(g, [0, 300], [200, 300], 24)!;
    const [lo, hi] = out.strokes!;
    expect(lo.points[lo.points.length - 1].y).toBeCloseTo(288, 6);
    expect(hi.points[0].y).toBeCloseTo(312, 6);
    expect(strokeLen(lo) + strokeLen(hi)).toBeCloseTo(600 - 24, 6);
  });

  it('with a gap and round caps, also clears the caps so the visible gap is the gap', () => {
    const g = strokeGlyph(stroke('a', [[100, 0], [100, 600]], 40, 'round'));
    const out = knifeGlyph(g, [0, 300], [200, 300], 24)!;
    const [lo, hi] = out.strokes!;
    expect(strokeLen(lo) + strokeLen(hi)).toBeCloseTo(600 - 24 - 2 * 40, 6);
    // the built letter is two blobs 24 units apart
    const built = glyphToContours(out);
    expect(built).toHaveLength(2);
    const ys = built.map((c) => bboxOf(c.points)).sort((m, n) => m.minY - n.minY);
    expect(ys[1].minY - ys[0].maxY).toBeGreaterThan(22);
    expect(ys[1].minY - ys[0].maxY).toBeLessThan(26);
  });

  it('never pulls a short stub away completely', () => {
    const g = strokeGlyph(stroke('a', [[100, 0], [100, 100]], 45, 'round'));
    const out = knifeGlyph(g, [0, 50], [200, 50], 24)!;
    expect(out.strokes).toHaveLength(2);
    for (const s of out.strokes!) expect(strokeLen(s)).toBeGreaterThan(5);
  });

  it('leaves a stroke the segment does not reach untouched', () => {
    const a = stroke('a', [[100, 0], [100, 600]]), b = stroke('b', [[400, 0], [400, 600]]);
    const out = knifeGlyph(strokeGlyph(a, b), [0, 300], [200, 300])!;
    expect(out.strokes).toHaveLength(3);
    expect(out.strokes![2]).toEqual(b); // same id, same points
    // 5 % past the end of the drag still counts, further does not
    const reach = 200 * KNIFE_EXTEND;
    expect(knifeGlyph(strokeGlyph(stroke('c', [[200 + reach - 1, 0], [200 + reach - 1, 600]])), [0, 300], [200, 300])).not.toBeNull();
    expect(knifeGlyph(strokeGlyph(stroke('c', [[200 + reach + 1, 0], [200 + reach + 1, 600]])), [0, 300], [200, 300])).toBeNull();
  });

  it('cuts a stroke at every crossing', () => {
    const zig = stroke('z', [[0, 0], [100, 400], [200, 0], [300, 400]]);
    const res = knifeCut(strokeGlyph(zig), [-50, 200], [350, 200])!;
    expect(res.strokes).toBe(1);
    expect(res.glyph.strokes).toHaveLength(4);
    expect(res.glyph.strokes!.reduce((s, st) => s + strokeLen(st), 0)).toBeCloseTo(strokeLen(zig), 6);
  });

  it('returns null when the cut misses, runs along the tip, or has no length', () => {
    const g = strokeGlyph(stroke('a', [[100, 0], [100, 600]]), { id: 'dot', cap: 'round', points: [{ x: 300, y: 300, w: 50 }] });
    expect(knifeGlyph(g, [0, 700], [200, 700])).toBeNull();
    expect(knifeGlyph(g, [0, 600], [200, 600])).toBeNull(); // exactly at the end: nothing to split off
    expect(knifeGlyph(g, [250, 300], [350, 300])).toBeNull(); // a dot has no centreline
    expect(knifeGlyph(g, [50, 300], [50, 300])).toBeNull();
  });
});

describe('knife on outlines', () => {
  const rect = () => outlineGlyph([rectContour([100, 0], [300, 600])]);

  it('cuts a rectangle into two closed parts that keep the total area', () => {
    const g = rect();
    const res = knifeCut(g, [50, 200], [350, 200])!;
    expect(res).not.toBeNull();
    expect(res.parts).toBe(1);
    const out = res.glyph;
    expect(out.curves).toHaveLength(2);
    expect(out.contours).toHaveLength(2);
    consistent(out);
    const areas = out.contours!.map((c) => signedArea(c.points)).sort((m, n) => m - n);
    expect(areas[0]).toBeCloseTo(200 * 200, 6);
    expect(areas[1]).toBeCloseTo(200 * 400, 6); // both counter-clockwise (positive)
    // the pieces touch along the cut
    const boxes = out.contours!.map((c) => bboxOf(c.points)).sort((m, n) => m.minY - n.minY);
    expect(boxes[0].maxY).toBeCloseTo(200, 9);
    expect(boxes[1].minY).toBeCloseTo(200, 9);
    // the build closes the seam again: one shape, same area
    const built = glyphToContours(out);
    expect(built).toHaveLength(1);
    expect(area(built)).toBeCloseTo(120000, 0);
    expect(g.curves).toHaveLength(1); // the input is not mutated
  });

  it('the pieces are separate shapes in Edit points', () => {
    const out = knifeGlyph(rect(), [50, 200], [350, 200])!;
    const m = new EditorModel(out);
    // move the lower piece (its 4 nodes) down: a real gap opens
    const lower = out.curves!.findIndex((c) => bboxOf(flat16([c])[0].points).maxY <= 200.001);
    expect(lower).toBeGreaterThanOrEqual(0);
    const moved: Glyph = { ...out, curves: out.curves!.map((c, i) => (i !== lower ? c : { start: [c.start[0], c.start[1] - 50], segments: c.segments.map((s) => s.map((p) => [p[0], p[1] - 50] as Vec) as CurveContour['segments'][number]) })) };
    moved.contours = flat16(moved.curves!);
    expect(glyphToContours(moved)).toHaveLength(2);
    expect(m.getGlyph().curves).toHaveLength(2);
  });

  it('with a gap, removes a strip as wide as the gap', () => {
    const res = knifeCut(rect(), [50, 200], [350, 200], 24)!;
    const out = res.glyph;
    expect(res.parts).toBe(1);
    expect(out.curves).toHaveLength(2);
    consistent(out);
    expect(area(out.contours!)).toBeGreaterThan(120000 - 200 * 24 - 200);
    expect(area(out.contours!)).toBeLessThan(120000 - 200 * 24 + 200);
    for (const c of out.contours!) expect(signedArea(c.points)).toBeGreaterThan(0);
    const built = glyphToContours(out);
    expect(built).toHaveLength(2);
    const boxes = built.map((c) => bboxOf(c.points)).sort((m, n) => m.minY - n.minY);
    expect(boxes[1].minY - boxes[0].maxY).toBeGreaterThan(22);
    expect(boxes[1].minY - boxes[0].maxY).toBeLessThan(26);
  });

  it('cuts at any angle', () => {
    const out = knifeGlyph(rect(), [50, 100], [350, 400])!;
    expect(out.curves).toHaveLength(2);
    consistent(out);
    expect(area(out.contours!)).toBeCloseTo(120000, 6);
    const gapped = knifeGlyph(rect(), [50, 100], [350, 400], 24)!;
    expect(glyphToContours(gapped)).toHaveLength(2);
    expect(area(gapped.contours!)).toBeGreaterThan(120000 - 24 * 200 * Math.SQRT2 - 300);
    expect(area(gapped.contours!)).toBeLessThan(120000 - 24 * 200 * Math.SQRT2 + 300);
  });

  it('returns null when the cut misses or stops inside the ink', () => {
    expect(knifeGlyph(rect(), [50, 700], [350, 700])).toBeNull();
    expect(knifeGlyph(rect(), [400, 0], [400, 600])).toBeNull();
    expect(knifeGlyph(rect(), [50, 200], [200, 200])).toBeNull(); // ends in the middle of the stem
    expect(knifeGlyph(rect(), [150, 200], [250, 200])).toBeNull(); // entirely inside
    expect(knifeGlyph(rect(), [50, 200], [200, 200], 24)).toBeNull();
    expect(knifeMarks(rect(), [50, 200], [200, 200]).spans).toHaveLength(0);
    expect(knifeMarks(rect(), [50, 200], [350, 200]).spans).toEqual([[[100, 200], [300, 200]]]);
  });

  it('a cut through one stem leaves the other shapes alone', () => {
    const left = rectContour([100, 0], [200, 600]), right = rectContour([400, 0], [500, 600]);
    const g = outlineGlyph([left, right]);
    const res = knifeCut(g, [50, 300], [250, 300])!;
    expect(res.parts).toBe(1);
    expect(res.glyph.curves).toHaveLength(3);
    expect(res.glyph.curves![2]).toEqual(right); // untouched part keeps its curves, in place
    consistent(res.glyph);
    // through both
    expect(knifeCut(g, [50, 300], [550, 300])!.parts).toBe(2);
  });

  it('cuts both the outline and a stroke drawn on top of it', () => {
    const g = outlineGlyph([rectContour([100, 0], [300, 600])], [stroke('s', [[450, 0], [450, 600]])]);
    const res = knifeCut(g, [50, 250], [500, 250])!;
    expect(res.parts).toBe(1);
    expect(res.strokes).toBe(1);
    expect(res.glyph.curves).toHaveLength(2);
    expect(res.glyph.strokes).toHaveLength(2);
    consistent(res.glyph);
    // only the stroke is reached
    const only = knifeCut(g, [400, 250], [500, 250])!;
    expect(only.parts).toBe(0);
    expect(only.strokes).toBe(1);
    expect(only.glyph.curves).toEqual(g.curves);
    expect(only.glyph.contours).toEqual(g.contours);
  });

  it('a ring cut through one side stays valid and keeps its area', () => {
    const g = ring();
    expect(Math.abs(area(g.contours!) - RING_AREA) / RING_AREA).toBeLessThan(0.01);
    const before = area(g.contours!);
    // zero gap: outer and counter become one loop with a seam; nothing is lost
    const out = knifeGlyph(g, [0, 300], [300, 300])!;
    expect(out).not.toBeNull();
    expect(out.curves).toHaveLength(1);
    consistent(out);
    expect(area(out.contours!)).toBeCloseTo(before, 3);
    const built = glyphToContours(out);
    expect(built).toHaveLength(2); // still a ring once built
    expect(Math.abs(area(built) - before) / before).toBeLessThan(0.005);
    // with a gap the ring opens into a "C": one contour, no counter
    const open = knifeGlyph(g, [0, 300], [300, 300], 24)!;
    consistent(open);
    const builtOpen = glyphToContours(open);
    expect(builtOpen).toHaveLength(1);
    expect(area(builtOpen)).toBeLessThan(before - 24 * 100 * 0.8);
    expect(area(builtOpen)).toBeGreaterThan(before - 24 * 100 * 1.3);
  });

  it('a ring cut straight through becomes two halves', () => {
    const g = ring();
    const before = area(g.contours!);
    const out = knifeGlyph(g, [0, 300], [600, 300])!;
    expect(out.curves).toHaveLength(2);
    consistent(out);
    const areas = out.contours!.map((c) => signedArea(c.points));
    expect(areas[0]).toBeGreaterThan(0);
    expect(areas[0]).toBeCloseTo(areas[1], 3);
    expect(areas[0] + areas[1]).toBeCloseTo(before, 3);
    const built = glyphToContours(out);
    expect(Math.abs(area(built) - before) / before).toBeLessThan(0.005);
    const gapped = knifeGlyph(g, [0, 300], [600, 300], 24)!;
    consistent(gapped);
    expect(glyphToContours(gapped)).toHaveLength(2);
  });

  it('with a gap, one slit runs across a counter the knife passes through', () => {
    // a frame whose counter starts 5 units above the cut line: the ink just under the counter is inside the gap too
    const frame = outlineGlyph([rectContour([0, 0], [600, 600]), reverseContour(rectContour([200, 300], [400, 500]))]);
    const out = knifeGlyph(frame, [-20, 305], [620, 305], 24)!;
    consistent(out);
    const built = glyphToContours(out);
    expect(built).toHaveLength(2);
    const boxes = built.map((c) => bboxOf(c.points)).sort((m, n) => m.minY - n.minY);
    expect(boxes[0].maxY).toBeCloseTo(293, 0); // flat top: no bump left under the counter
    expect(boxes[1].minY).toBeCloseTo(317, 0);
    // the knife stops inside the counter: only the left side is cut, the frame stays in one piece
    const half = knifeGlyph(frame, [-20, 305], [300, 305], 24)!;
    expect(glyphToContours(half)).toHaveLength(1);
    expect(area(half.contours!)).toBeGreaterThan(320000 - 24 * 224 - 300);
    expect(area(half.contours!)).toBeLessThan(320000 - 24 * 200 + 300);
  });

  it('cutting only through the counter side-to-side does nothing to a ring the knife does not leave', () => {
    // starts and ends in the counter, crosses no ink
    expect(knifeGlyph(ring(), [200, 300], [400, 300])).toBeNull();
    // starts in the counter, leaves through the right side: one span, outer ↔ counter
    const out = knifeGlyph(ring(), [300, 300], [600, 300])!;
    expect(out.curves).toHaveLength(1);
  });

  it('cuts a plain polygon outline (no curves) and keeps it a polygon', () => {
    const g: Glyph = { char: 'i', unicode: 105, advance: 400, source: 'traced', kind: 'outline', contours: [{ points: [[100, 0], [300, 0], [300, 600], [100, 600]] }] };
    const out = knifeGlyph(g, [50, 200], [350, 200])!;
    expect(out.curves).toBeUndefined();
    expect(out.contours).toHaveLength(2);
    expect(area(out.contours!)).toBeCloseTo(120000, 6);
    for (const c of out.contours!) expect(signedArea(c.points)).toBeGreaterThan(0);
    const gapped = knifeGlyph(g, [50, 200], [350, 200], 24)!;
    expect(gapped.curves).toBeUndefined();
    expect(area(gapped.contours!)).toBeCloseTo(120000 - 200 * 24, 3);
    expect(glyphToContours(gapped)).toHaveLength(2);
  });
});
