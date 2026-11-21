import { describe, it, expect } from 'vitest';
import { PenPath, applyPenContour, reverseContour } from '../../src/inputs/draw/pen';
import { flattenCurves } from '../../src/inputs/draw/curves';
import { signedArea } from '../../src/core/geometry';
import { isLine } from '../../src/outline/fitCurves';
import { glyphToContours } from '../../src/outline';
import type { Glyph, CurveContour, Vec } from '../../src/core/glyph';

const area = (c: CurveContour) => signedArea(flattenCurves([c], 16)[0].points);
const chained = (c: CurveContour) => {
  expect(c.segments[0][0]).toEqual(c.start);
  for (let i = 1; i < c.segments.length; i++) expect(c.segments[i][0]).toEqual(c.segments[i - 1][3]);
  expect(c.segments[c.segments.length - 1][3]).toEqual(c.start);
};
const blank = (ch: string): Glyph => ({ char: ch, unicode: ch.codePointAt(0)!, advance: 520, source: 'drawn', kind: 'stroke', strokes: [] });
const square = (x0: number, y0: number, x1: number, y1: number): CurveContour => {
  const p = new PenPath();
  for (const v of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as Vec[]) p.addCorner(v);
  return p.toCurveContour();
};

describe('PenPath', () => {
  it('closes a corner-only triangle into 3 line segments, counter-clockwise', () => {
    const p = new PenPath();
    p.addCorner([100, 0]); p.addCorner([300, 0]); p.addCorner([200, 300]);
    const c = p.toCurveContour();
    expect(c.segments).toHaveLength(3);
    expect(c.segments.every((s) => isLine(s))).toBe(true);
    chained(c);
    expect(area(c)).toBeGreaterThan(0);
    expect(area(c)).toBeCloseTo(30000, 3);
  });

  it('reverses a clockwise-clicked square to counter-clockwise', () => {
    const p = new PenPath();
    // clockwise in y-up coordinates: up, right, down
    p.addCorner([0, 0]); p.addCorner([0, 100]); p.addCorner([100, 100]); p.addCorner([100, 0]);
    const c = p.toCurveContour();
    expect(c.segments).toHaveLength(4);
    chained(c);
    expect(c.start).toEqual([0, 0]);
    expect(area(c)).toBeCloseTo(10000, 3);
    // reversing twice is the identity
    expect(reverseContour(reverseContour(c))).toEqual(c);
  });

  it('a smooth point gives curve segments with mirrored handles', () => {
    const p = new PenPath();
    p.addCorner([0, 0]);
    p.addSmooth([200, 100]);
    p.setHandle([260, 160]);
    expect(p.anchors[1].hOut).toEqual([260, 160]);
    expect(p.anchors[1].hIn).toEqual([140, 40]);
    p.addCorner([0, 300]);
    const c = p.toCurveContour();
    expect(c.segments).toHaveLength(3);
    chained(c);
    expect(area(c)).toBeGreaterThan(0);
    // the two segments touching the smooth point are curves whose handles are collinear through it
    const into = c.segments.find((s) => s[3][0] === 200 && s[3][1] === 100)!;
    const outOf = c.segments.find((s) => s[0][0] === 200 && s[0][1] === 100)!;
    expect(isLine(into)).toBe(false);
    expect(isLine(outOf)).toBe(false);
    const a: Vec = into[2], b: Vec = outOf[1];
    expect((a[0] + b[0]) / 2).toBeCloseTo(200, 6);
    expect((a[1] + b[1]) / 2).toBeCloseTo(100, 6);
    // the segment between the two corners stays straight
    expect(c.segments.filter((s) => isLine(s))).toHaveLength(1);
  });

  it('addSmooth with a drag point and a cusp drag that moves only hOut', () => {
    const p = new PenPath();
    p.addSmooth([50, 50], [80, 50]);
    expect(p.anchors[0].hIn).toEqual([20, 50]);
    p.setHandle([50, 90], true);
    expect(p.anchors[0].hOut).toEqual([50, 90]);
    expect(p.anchors[0].hIn).toEqual([20, 50]);
  });

  it('removeLast, isNearStart and the closing rules', () => {
    const p = new PenPath();
    expect(p.canClose()).toBe(false);
    expect(p.isNearStart([0, 0], 10)).toBe(false);
    p.addCorner([0, 0]);
    expect(p.addCorner([0, 0])).toBe(false); // a click on top of the last point adds nothing
    expect(p.length).toBe(1);
    expect(p.isNearStart([5, 5], 10)).toBe(true);
    expect(p.isNearStart([20, 0], 10)).toBe(false);
    p.addCorner([100, 0]);
    expect(p.canClose()).toBe(false); // two corners are just a line
    p.setHandle([120, 60]);
    expect(p.canClose()).toBe(true); // two points with a curve make a lens
    expect(p.toCurveContour().segments).toHaveLength(2);
    p.setHandle([100, 0]); // dragged back onto the point: a corner again
    expect(p.canClose()).toBe(false);
    p.addCorner([50, 80]);
    expect(p.canClose()).toBe(true);
    expect(p.removeLast()).toBe(true);
    expect(p.length).toBe(2);
    p.removeLast(); p.removeLast();
    expect(p.removeLast()).toBe(false);
    expect(p.length).toBe(0);
  });
});

describe('applyPenContour', () => {
  const box = square(100, 100, 300, 400);

  it('no glyph → a new drawn outline glyph', () => {
    const g = applyPenContour(undefined, 'x', box, blank('x'));
    expect(g.kind).toBe('outline');
    expect(g.source).toBe('drawn');
    expect(g.char).toBe('x');
    expect(g.strokes).toBeUndefined();
    expect(g.curves).toHaveLength(1);
    expect(g.contours).toHaveLength(1);
    expect(g.advance).toBe(520);
    expect(glyphToContours(g)).toHaveLength(1);
  });

  it('a generated glyph is replaced', () => {
    const gen: Glyph = { ...blank('x'), source: 'generated', strokes: [{ id: 's1', cap: 'round', points: [{ x: 0, y: 0, w: 20 }, { x: 0, y: 100, w: 20 }] }], recipe: { id: 'r', seed: 1 } as any };
    const g = applyPenContour(gen, 'x', box, blank('x'));
    expect(g.source).toBe('drawn');
    expect(g.strokes).toBeUndefined();
    expect(g.recipe).toBeUndefined();
    expect(g.curves).toHaveLength(1);
  });

  it('a stroke glyph becomes outline and keeps its strokes', () => {
    const st: Glyph = { ...blank('l'), strokes: [{ id: 's1', cap: 'round', points: [{ x: 400, y: 0, w: 20 }, { x: 400, y: 600, w: 20 }] }] };
    const g = applyPenContour(st, 'l', box, blank('l'));
    expect(g.kind).toBe('outline');
    expect(g.strokes).toHaveLength(1);
    expect(g.curves).toHaveLength(1);
    expect(g.contours).toHaveLength(1);
    expect(st.kind).toBe('stroke'); // input untouched
    expect(glyphToContours(g)).toHaveLength(2); // box + stroke ribbon, apart
  });

  it('an outline glyph gets the contour appended (curves fitted first); a shape inside ink cuts a hole', () => {
    const outer: Glyph = { ...blank('o'), kind: 'outline', strokes: undefined, contours: flattenCurves([square(50, 0, 450, 500)]) };
    const g = applyPenContour(outer, 'o', box, blank('o'));
    expect(g.curves).toHaveLength(2);
    expect(g.contours).toHaveLength(2);
    expect(outer.curves).toBeUndefined();
    const built = glyphToContours(g);
    const areas = built.map((c) => signedArea(c.points)).sort((a, b) => a - b);
    expect(areas).toHaveLength(2);
    expect(Math.sign(areas[0])).not.toBe(Math.sign(areas[1])); // outer + hole
    // appending again keeps existing curves
    const g2 = applyPenContour(g, 'o', square(600, 0, 700, 100), blank('o'));
    expect(g2.curves).toHaveLength(3);
    expect(g2.curves![0]).toEqual(g.curves![0]);
  });

  it('widens the advance when the shape sticks out', () => {
    const g = applyPenContour(undefined, 'x', square(100, 0, 700, 300), blank('x'));
    expect(g.advance).toBe(740);
  });
});
