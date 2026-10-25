import { describe, it, expect } from 'vitest';
import type { Glyph, Contour, Stroke, StrokePoint } from '../../src/core/glyph';
import { DEFAULT_METRICS } from '../../src/core/glyph';
import { signedArea, centroid, pointInPolygon } from '../../src/core/geometry';
import { makeRng } from '../../src/core/prng';
import { glyphToContours } from '../../src/outline';
import type { FxCtx } from '../../src/fx/types';
import { hollow, lowpoly, stipple, OUTLINE_OPS, STIPPLE_MAX_DOTS } from '../../src/fx/ops';
import { stipple as stippleDirect } from '../../src/fx/ops/stipple';

// ---------- synthetic glyphs ----------
function stroke(id: string, pts: [number, number][], w = 45): Stroke {
  return { id, cap: 'round', points: pts.map(([x, y]): StrokePoint => ({ x, y, w })) };
}
function arcPts(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) { const t = a0 + ((a1 - a0) * i) / n; out.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry]); }
  return out;
}
const oGlyph: Glyph = { char: 'o', unicode: 111, advance: 560, source: 'drawn', kind: 'stroke',
  strokes: [stroke('o1', arcPts(280, 250, 190, 230, Math.PI / 2, Math.PI / 2 + Math.PI * 2, 48))] };
const lGlyph: Glyph = { char: 'l', unicode: 108, advance: 260, source: 'drawn', kind: 'stroke',
  strokes: [stroke('l1', [[130, 740], [130, 500], [130, 250], [130, 0]])] };
const nGlyph: Glyph = { char: 'n', unicode: 110, advance: 600, source: 'drawn', kind: 'stroke',
  strokes: [
    stroke('n1', [[110, 0], [110, 250], [110, 500]]),
    stroke('n2', [[110, 330], ...arcPts(300, 310, 190, 190, Math.PI, 0, 14), [490, 150], [490, 0]]),
  ] };
const thinGlyph: Glyph = { char: 'i', unicode: 105, advance: 200, source: 'drawn', kind: 'stroke',
  strokes: [stroke('i1', [[100, 500], [100, 250], [100, 0]], 5)] };
const square: Contour[] = [
  { points: [[0, 0], [400, 0], [400, 400], [0, 400]] },          // outer CCW
  { points: [[100, 100], [100, 300], [300, 300], [300, 100]] },  // hole CW
];

const sets: Record<string, Contour[]> = {
  o: glyphToContours(oGlyph),
  l: glyphToContours(lGlyph),
  n: glyphToContours(nGlyph),
  square,
};

const ctx = (seed = 7, glyph: Glyph = nGlyph): FxCtx => ({ rng: makeRng(seed), metrics: DEFAULT_METRICS, glyph, time: 0 });
const inkArea = (cs: Contour[]) => cs.reduce((a, c) => a + signedArea(c.points), 0);
const vertexCount = (cs: Contour[]) => cs.reduce((a, c) => a + c.points.length, 0);
const allFinite = (cs: Contour[]) => cs.every((c) => c.points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));
const outers = (cs: Contour[]) => cs.filter((c) => signedArea(c.points) > 0);
const holes = (cs: Contour[]) => cs.filter((c) => signedArea(c.points) < 0);
const insideInk = (p: [number, number], cs: Contour[]) =>
  outers(cs).some((o) => pointInPolygon(p, o.points)) && !holes(cs).some((h) => pointInPolygon(p, h.points));

/** clean: every ring has ≥3 finite vertices, at least one outer, outers positive. */
function expectClean(cs: Contour[]) {
  expect(cs.length).toBeGreaterThanOrEqual(1);
  expect(allFinite(cs)).toBe(true);
  expect(JSON.stringify(cs)).not.toContain('null');
  for (const c of cs) expect(c.points.length).toBeGreaterThanOrEqual(3);
  expect(outers(cs).length).toBeGreaterThanOrEqual(1);
  // the largest ring must be an outer
  const biggest = cs.reduce((a, c) => (Math.abs(signedArea(c.points)) > Math.abs(signedArea(a.points)) ? c : a), cs[0]);
  expect(signedArea(biggest.points)).toBeGreaterThan(0);
}

describe('fx ops: registry', () => {
  it('OUTLINE_OPS exposes the three ops', () => {
    expect(Object.keys(OUTLINE_OPS).sort()).toEqual(['hollow', 'lowpoly', 'stipple']);
    expect(OUTLINE_OPS.hollow).toBe(hollow);
    expect(OUTLINE_OPS.lowpoly).toBe(lowpoly);
    expect(OUTLINE_OPS.stipple).toBe(stipple);
    expect(stippleDirect).toBe(stipple);
  });
  it('every op tolerates empty input and NaN params', () => {
    for (const op of Object.values(OUTLINE_OPS)) {
      expect(op([], { inset: NaN, tolerance: NaN, spacing: NaN }, ctx())).toEqual([]);
      for (const cs of Object.values(sets)) expectClean(op(cs, { inset: NaN, inline: NaN, tolerance: NaN, minSegments: NaN, spacing: NaN, dotSize: NaN, jitter: NaN, gravity: NaN, keepOutline: NaN }, ctx()));
    }
  });
});

describe('fx ops: hollow', () => {
  for (const [name, cs] of Object.entries(sets)) {
    it(`reduces ink area on '${name}' and stays clean`, () => {
      const out = hollow(cs, { inset: 24, inline: 0 }, ctx());
      expectClean(out);
      expect(inkArea(out)).toBeLessThan(inkArea(cs));
      expect(inkArea(out)).toBeGreaterThan(0);
    });
  }
  it('square with hole becomes two shells: ≥1 outer and ≥1 hole', () => {
    const out = hollow(square, { inset: 20, inline: 0 }, ctx());
    expect(outers(out).length).toBeGreaterThanOrEqual(1);
    expect(holes(out).length).toBeGreaterThanOrEqual(1);
    // shell area: outer 400² − 360² plus inner 240² − 200² (round corners make it slightly smaller)
    const expected = (400 * 400 - 360 * 360) + (240 * 240 - 200 * 200);
    expect(inkArea(out)).toBeGreaterThan(expected * 0.9);
    expect(inkArea(out)).toBeLessThan(expected * 1.05);
    // the centre of the former hole stays empty; the centre of the shell band is ink
    expect(insideInk([200, 200], out)).toBe(false);
    expect(insideInk([10, 200], out)).toBe(true);
    expect(insideInk([60, 200], out)).toBe(false);
  });
  it('inline > 0 adds area back but stays below the original', () => {
    for (const cs of [sets.square, sets.o, sets.n]) {
      const plain = hollow(cs, { inset: 16, inline: 0 }, ctx());
      const inl = hollow(cs, { inset: 16, inline: 8 }, ctx());
      expectClean(inl);
      expect(inkArea(inl)).toBeGreaterThan(inkArea(plain));
      expect(inkArea(inl)).toBeLessThan(inkArea(cs));
    }
  });
  it('tiny stroke (w=5) with inset 24 returns the original contours', () => {
    const thin = glyphToContours(thinGlyph);
    expect(hollow(thin, { inset: 24, inline: 0 }, ctx())).toBe(thin);
  });
  it('clamps params', () => {
    const a = hollow(square, { inset: 1000, inline: -5 }, ctx());
    const b = hollow(square, { inset: 80, inline: 0 }, ctx());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('fx ops: lowpoly', () => {
  for (const [name, cs] of Object.entries(sets)) {
    it(`drops vertices on '${name}', keeps ≥ minSegments per ring, area within 25% at tol 10`, () => {
      const out = lowpoly(cs, { tolerance: 10, minSegments: 4 }, ctx());
      expectClean(out);
      if (name !== 'square') expect(vertexCount(out)).toBeLessThan(vertexCount(cs));
      else expect(vertexCount(out)).toBeLessThanOrEqual(vertexCount(cs));
      for (const c of out) expect(c.points.length).toBeGreaterThanOrEqual(4);
      expect(inkArea(out)).toBeGreaterThan(inkArea(cs) * 0.75);
      expect(inkArea(out)).toBeLessThan(inkArea(cs) * 1.25);
    });
  }
  it('coarse tolerance yields very few vertices but respects minSegments', () => {
    const out = lowpoly(sets.o, { tolerance: 120, minSegments: 6 }, ctx());
    expectClean(out);
    for (const c of out) expect(c.points.length).toBeGreaterThanOrEqual(6);
    expect(vertexCount(out)).toBeLessThan(40);
  });
  it('square with hole is already minimal: unchanged', () => {
    const out = lowpoly(square, { tolerance: 30, minSegments: 4 }, ctx());
    expect(inkArea(out)).toBeCloseTo(inkArea(square), 3);
    expect(vertexCount(out)).toBe(8);
  });
  it('is deterministic (no rng use)', () => {
    expect(JSON.stringify(lowpoly(sets.n, { tolerance: 30, minSegments: 4 }, ctx(1))))
      .toBe(JSON.stringify(lowpoly(sets.n, { tolerance: 30, minSegments: 4 }, ctx(2))));
  });
});

describe('fx ops: stipple', () => {
  const P = { spacing: 36, dotSize: 12, jitter: 0.5, gravity: 0, keepOutline: 0 };
  const dotArea = Math.PI * 12 * 12;
  /** centroids of the small (single-dot sized) rings */
  const dotCentres = (cs: Contour[]) =>
    cs.filter((c) => signedArea(c.points) > 0 && signedArea(c.points) < dotArea * 1.3).map((c) => centroid(c.points));

  for (const [name, cs] of Object.entries(sets)) {
    it(`fills '${name}' with dots whose centres lie inside the original ink`, () => {
      const out = stipple(cs, P, ctx());
      expectClean(out);
      const centres = dotCentres(out);
      expect(centres.length).toBeGreaterThan(3);
      for (const p of centres) expect(insideInk(p, cs)).toBe(true);
      expect(inkArea(out)).toBeLessThan(inkArea(cs));
    });
  }
  it('gravity 1 moves the mean dot y down vs gravity 0', () => {
    for (const cs of [sets.o, sets.n, sets.l, sets.square]) {
      const a = dotCentres(stipple(cs, { ...P, gravity: 0 }, ctx(3)));
      const b = dotCentres(stipple(cs, { ...P, gravity: 1 }, ctx(3)));
      const meanY = (ps: [number, number][]) => ps.reduce((s, p) => s + p[1], 0) / ps.length;
      expect(meanY(b)).toBeLessThan(meanY(a) - 10);
      // settled dots still sit on ink
      for (const p of b) expect(insideInk(p, cs)).toBe(true);
    }
  });
  it('is deterministic for the same seed and differs for another', () => {
    const a = JSON.stringify(stipple(sets.n, P, ctx(11)));
    const b = JSON.stringify(stipple(sets.n, P, ctx(11)));
    const c = JSON.stringify(stipple(sets.n, P, ctx(12)));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
  it('respects the dot cap on a large shape with tiny spacing', () => {
    const big: Contour[] = [{ points: [[0, 0], [1000, 0], [1000, 1000], [0, 1000]] }];
    const out = stipple(big, { spacing: 10, dotSize: 3, jitter: 0, gravity: 0, keepOutline: 0 }, ctx());
    expectClean(out);
    expect(out.length).toBeLessThanOrEqual(STIPPLE_MAX_DOTS);
    expect(out.length).toBeGreaterThan(STIPPLE_MAX_DOTS / 2);
  });
  it('keepOutline=1 adds a shell so the hole of the square survives as a hole', () => {
    const out = stipple(square, { ...P, keepOutline: 1 }, ctx());
    expectClean(out);
    expect(holes(out).length).toBeGreaterThanOrEqual(1);
    expect(insideInk([2, 200], out)).toBe(true);
    expect(inkArea(out)).toBeGreaterThan(inkArea(stipple(square, P, ctx())));
  });
  it('a typical lowercase glyph with defaults runs quickly', () => {
    stipple(sets.n, P, ctx()); // warm up
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) stipple(sets.n, P, ctx(i));
    const ms = (performance.now() - t0) / 5;
    expect(ms).toBeLessThan(150); // generous CI budget; target < 40 ms
  });
});
