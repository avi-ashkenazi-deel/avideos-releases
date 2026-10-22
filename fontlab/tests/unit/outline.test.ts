import { describe, it, expect } from 'vitest';
import { expandStroke } from '../../src/outline/strokeExpand';
import { unionRings } from '../../src/outline/union';
import { contourToCubics, cleanContours, flattenCubic } from '../../src/outline/fitCurves';
import { glyphToContours } from '../../src/outline';
import { signedArea } from '../../src/core/geometry';
import { makeRng } from '../../src/core/prng';
import type { Glyph, Stroke } from '../../src/core/glyph';

const stroke = (pts: [number, number, number][], cap: Stroke['cap'] = 'round'): Stroke => ({ id: 'x', cap, points: pts.map(([x, y, w]) => ({ x, y, w })) });

describe('strokeExpand + union', () => {
  it('a straight stroke becomes one contour with area ≈ 2wL + πw²', () => {
    const s = stroke([[0, 0, 40], [400, 0, 40]]);
    const cs = unionRings(expandStroke(s));
    expect(cs).toHaveLength(1);
    const a = signedArea(cs[0].points);
    expect(a).toBeGreaterThan(0); // outer contours CCW
    expect(Math.abs(a - (2 * 40 * 400 + Math.PI * 40 * 40))).toBeLessThan(600);
  });
  it('flat caps have no cap area', () => {
    const cs = unionRings(expandStroke(stroke([[0, 0, 40], [400, 0, 40]], 'flat')));
    expect(Math.abs(signedArea(cs[0].points) - 2 * 40 * 400)).toBeLessThan(50);
  });
  it('a hairpin resolves to a single solid contour (nonzero rule)', () => {
    const s = stroke([[100, 0, 40], [500, 0, 40], [520, 20, 40], [100, 30, 40]]);
    const cs = unionRings(expandStroke(s));
    expect(cs.filter((c) => signedArea(c.points) > 0)).toHaveLength(1);
    expect(cs.every((c) => Math.abs(signedArea(c.points)) > 60 || signedArea(c.points) > 0)).toBe(true);
  });
  it('a closed ring stroke produces an outer contour and a hole', () => {
    const pts: [number, number, number][] = [];
    for (let i = 0; i <= 64; i++) { const t = (i / 64) * Math.PI * 2; pts.push([250 + Math.cos(t) * 200, 250 + Math.sin(t) * 200, 40]); }
    const cs = cleanContours(unionRings(expandStroke(stroke(pts))));
    expect(cs).toHaveLength(2);
    const areas = cs.map((c) => signedArea(c.points)).sort((a, b) => a - b);
    expect(areas[0]).toBeLessThan(0);
    expect(areas[1]).toBeGreaterThan(0);
    expect(Math.abs(Math.abs(areas[0]) - Math.PI * 160 * 160)).toBeLessThan(0.05 * Math.PI * 160 * 160);
  });
  it('fuzzed strokes never crash and always yield finite, positive total area', () => {
    const rng = makeRng(42);
    for (let k = 0; k < 60; k++) {
      const n = rng.int(1, 30);
      const pts: [number, number, number][] = [];
      let x = rng.range(0, 600), y = rng.range(-200, 700);
      for (let i = 0; i < n; i++) { x += rng.gauss(0, 60); y += rng.gauss(0, 60); pts.push([x, y, rng.range(1, 90)]); }
      const cap = rng.pick(['round', 'flat', 'taper'] as const);
      const cs = unionRings(expandStroke(stroke(pts, cap)));
      const total = cs.reduce((a, c) => a + signedArea(c.points), 0);
      expect(Number.isFinite(total)).toBe(true);
      expect(total).toBeGreaterThan(0);
      for (const c of cs) for (const p of c.points) { expect(Number.isFinite(p[0])).toBe(true); expect(Number.isFinite(p[1])).toBe(true); }
    }
  });
  it('a single-point stroke is a disc', () => {
    const cs = unionRings(expandStroke(stroke([[10, 10, 30]])));
    expect(cs).toHaveLength(1);
    expect(Math.abs(signedArea(cs[0].points) - Math.PI * 900)).toBeLessThan(120);
  });
});

describe('fitCurves', () => {
  it('fits a circle with few segments and small deviation', () => {
    const pts: [number, number][] = [];
    for (let i = 0; i < 90; i++) { const t = (i / 90) * Math.PI * 2; pts.push([Math.cos(t) * 200, Math.sin(t) * 200]); }
    const cc = contourToCubics({ points: pts }, 1.5);
    expect(cc.segments.length).toBeLessThanOrEqual(8);
    for (const seg of cc.segments) for (const p of flattenCubic(seg, 10)) expect(Math.abs(Math.hypot(p[0], p[1]) - 200)).toBeLessThan(2);
  });
  it('keeps the four corners of a square', () => {
    const pts: [number, number][] = [];
    for (let i = 0; i < 20; i++) pts.push([i * 10, 0]);
    for (let i = 0; i < 20; i++) pts.push([200, i * 10]);
    for (let i = 0; i < 20; i++) pts.push([200 - i * 10, 200]);
    for (let i = 0; i < 20; i++) pts.push([0, 200 - i * 10]);
    const cc = contourToCubics({ points: pts }, 1);
    expect(cc.segments.length).toBe(4);
    const last = cc.segments[cc.segments.length - 1];
    expect(last[3]).toEqual(cc.start);
  });
  it('cleanContours drops slivers', () => {
    const out = cleanContours([{ points: [[0, 0], [1, 0], [1, 1]] }, { points: [[0, 0], [100, 0], [100, 100], [0, 100]] }]);
    expect(out).toHaveLength(1);
  });
});

describe('glyphToContours', () => {
  it('unions overlapping strokes of a glyph into clean contours', () => {
    const g: Glyph = { char: 'l', unicode: 108, advance: 300, source: 'drawn', kind: 'stroke', strokes: [stroke([[100, 0, 40], [100, 700, 40]]), stroke([[60, 350, 40], [140, 350, 40]])] };
    const cs = glyphToContours(g);
    expect(cs).toHaveLength(1);
  });
  it('outline glyphs pass through union + cleanup', () => {
    const g: Glyph = { char: 'o', unicode: 111, advance: 500, source: 'imported', kind: 'outline', contours: [{ points: [[0, 0], [400, 0], [400, 400], [0, 400]] }, { points: [[100, 100], [100, 300], [300, 300], [300, 100]] }] };
    const cs = glyphToContours(g);
    expect(cs).toHaveLength(2);
  });
});
