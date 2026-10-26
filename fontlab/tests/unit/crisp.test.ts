import { describe, it, expect } from 'vitest';
import { findCorners, chamfer, roundVec, inkTrap, offsetMiter, stretch, xHeight, stencil, crispWeight } from '../../src/fx/ops/crisp';
import { advanceAfterStack, newStack, newLayer, applyStack } from '../../src/fx/stack';
import { glyphToContours } from '../../src/outline';
import { makeRng } from '../../src/core/prng';
import { signedArea, bboxContours } from '../../src/core/geometry';
import { DEFAULT_METRICS, type Contour, type Glyph, type Vec } from '../../src/core/glyph';

const ctx = (char = 'a', seed = 1) => ({ rng: makeRng(seed), metrics: DEFAULT_METRICS, glyph: { char, unicode: char.codePointAt(0)!, advance: 500, source: 'imported', kind: 'outline', contours: [] } as Glyph, time: 0 });
const square = (x0: number, y0: number, s: number): Contour => ({ points: [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]] });
const circle = (r: number, n = 90): Contour => ({ points: Array.from({ length: n }, (_, i) => [Math.cos((i / n) * Math.PI * 2) * r + 300, Math.sin((i / n) * Math.PI * 2) * r + 300] as Vec) });
const area = (cs: Contour[]) => cs.reduce((a, c) => a + signedArea(c.points), 0);
const L: Contour = { points: [[0, 0], [300, 0], [300, 80], [80, 80], [80, 500], [0, 500]] }; // one concave corner at (80,80)
const H: Glyph = { char: 'H', unicode: 72, advance: 600, source: 'drawn', kind: 'stroke', strokes: [
  { id: 'a', cap: 'flat', points: [{ x: 100, y: 0, w: 40 }, { x: 100, y: 700, w: 40 }] },
  { id: 'b', cap: 'flat', points: [{ x: 420, y: 0, w: 40 }, { x: 420, y: 700, w: 40 }] },
  { id: 'c', cap: 'flat', points: [{ x: 100, y: 350, w: 40 }, { x: 420, y: 350, w: 40 }] }] };

describe('crisp ops', () => {
  it('findCorners: 4 on a square, none on a circle, 6 on an L', () => {
    expect(findCorners(square(0, 0, 400).points)).toHaveLength(4);
    expect(findCorners(circle(200).points)).toHaveLength(0);
    expect(findCorners(L.points)).toHaveLength(6);
  });
  it('chamfer bevels: 8 vertices, less area; chance 0 is identity; chance 0.5 is seeded', () => {
    const c = chamfer([square(0, 0, 400)], { size: 40, chance: 1, convexOnly: 1 }, ctx());
    expect(c[0].points.length).toBe(8);
    expect(area(c)).toBeLessThan(160000);
    expect(area(c)).toBeGreaterThan(160000 - 4 * 800 - 1);
    expect(chamfer([square(0, 0, 400)], { size: 40, chance: 0, convexOnly: 1 }, ctx())[0].points.length).toBe(4);
    const a = chamfer([square(0, 0, 400)], { size: 40, chance: 0.5, convexOnly: 1 }, ctx('a', 3));
    const b = chamfer([square(0, 0, 400)], { size: 40, chance: 0.5, convexOnly: 1 }, ctx('a', 3));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
  it('roundVec rounds corners, keeps area within 5 %, adds points; circles untouched', () => {
    const r = roundVec([square(0, 0, 400)], { radius: 30 }, ctx());
    expect(r[0].points.length).toBeGreaterThan(8);
    expect(Math.abs(area(r) - 160000) / 160000).toBeLessThan(0.05);
    expect(roundVec([circle(200)], { radius: 30 }, ctx())[0].points.length).toBe(90);
  });
  it('inkTrap notches only the concave corner of an L', () => {
    const t = inkTrap([L], { depth: 20, width: 24 }, ctx());
    expect(area(t)).toBeLessThan(area([L]));
    expect(area(t)).toBeGreaterThan(area([L]) - 24 * 24);
    // convex corners survive exactly
    expect(t[0].points.some((p) => p[0] === 0 && p[1] === 0)).toBe(true);
    expect(t[0].points.some((p) => p[0] === 300 && p[1] === 0)).toBe(true);
  });
  it('offsetMiter keeps square corners square and handles holes and miter limits', () => {
    const grown = offsetMiter([square(100, 100, 400)], 20);
    expect(grown).toHaveLength(1);
    expect(grown[0].points.length).toBe(4);
    const bb = bboxContours(grown);
    expect(bb.minX).toBeCloseTo(80, 0); expect(bb.maxX).toBeCloseTo(520, 0);
    const shrunk = offsetMiter([square(100, 100, 400)], -20);
    expect(bboxContours(shrunk).minX).toBeCloseTo(120, 0);
    const ring: Contour[] = [square(0, 0, 500), { points: [[150, 150], [150, 350], [350, 350], [350, 150]] }];
    const fat = offsetMiter(ring, 20);
    const hole = fat.find((c) => signedArea(c.points) < 0)!;
    expect(Math.abs(signedArea(hole.points))).toBeLessThan(200 * 200); // hole shrank
    const star: Contour = { points: Array.from({ length: 10 }, (_, i) => { const r = i % 2 ? 60 : 200, a = (i / 10) * Math.PI * 2; return [300 + Math.cos(a) * r, 300 + Math.sin(a) * r] as Vec; }) };
    const s = offsetMiter([star], 15);
    expect(s[0].points.length).toBeGreaterThan(10); // some tips bevelled
    for (const c of s) for (const p of c.points) { expect(Number.isFinite(p[0])).toBe(true); expect(Number.isFinite(p[1])).toBe(true); }
  });
  it('crispWeight grows/shrinks an H without rounding its corners', () => {
    const cs = glyphToContours(H);
    const bold = crispWeight(cs, { amount: 0.6 }, ctx('H'));
    expect(area(bold)).toBeGreaterThan(area(cs));
    expect(findCorners(bold[0].points).length).toBe(findCorners(cs[0].points).length);
    expect(area(crispWeight(cs, { amount: -0.4 }, ctx('H')))).toBeLessThan(area(cs));
  });
  it('stretch scales the bbox; xHeight touches lowercase only', () => {
    const s = stretch([square(60, 0, 400)], { width: 1.5, height: 0.5 }, ctx());
    const bb = bboxContours(s);
    expect(bb.maxX - bb.minX).toBeCloseTo(600, 0); expect(bb.maxY).toBeCloseTo(200, 0); expect(bb.minX).toBeCloseTo(60, 0);
    expect(bboxContours(xHeight([square(0, 0, 400)], { scale: 1.2 }, ctx('a'))).maxY).toBeCloseTo(480, 0);
    expect(bboxContours(xHeight([square(0, 0, 400)], { scale: 1.2 }, ctx('A'))).maxY).toBeCloseTo(400, 0);
  });
  it('stencil cuts bars out of an H and never empties it', () => {
    const cs = glyphToContours(H);
    const st = stencil(cs, { gap: 14, spacing: 180, angle: 0, phase: 0.4, jitter: 0 }, ctx('H'));
    expect(st.length).toBeGreaterThan(cs.length);
    expect(area(st)).toBeLessThan(area(cs));
    expect(area(st)).toBeGreaterThan(area(cs) * 0.7);
    expect(stencil(cs, { gap: 60, spacing: 40, angle: 0, phase: 0, jitter: 0 }, ctx('H')).length).toBeGreaterThan(0);
  });
  it('tracking and stretch change the advance; crisp presets run through the stack', () => {
    const s = newStack(1); s.groups[0].layers = [newLayer('tracking', { amount: 40 })];
    expect(advanceAfterStack(H, s)).toBe(640);
    const t = newStack(1); t.groups[0].layers = [newLayer('stretch', { width: 1.5, height: 1 })];
    expect(advanceAfterStack(H, t)).toBe(60 + 540 * 1.5);
    for (const type of ['chamfer', 'roundVec', 'inkTrap', 'stretch', 'xHeight', 'stencil', 'crispWeight', 'tracking']) {
      const st = newStack(2); st.groups[0].layers = [newLayer(type)];
      expect(area(applyStack(H, st, DEFAULT_METRICS)), type).toBeGreaterThan(0);
    }
  });
});
