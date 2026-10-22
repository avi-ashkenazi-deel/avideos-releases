import { describe, it, expect } from 'vitest';
import type { Glyph, Contour, DnaParams, Stroke, StrokePoint } from '../../src/core/glyph';
import { DEFAULT_DNA, DEFAULT_METRICS } from '../../src/core/glyph';
import { signedArea, bboxContours } from '../../src/core/geometry';
import { glyphToContours } from '../../src/outline';
import { applyDna, advanceAfterDna, isIdentityDna, POINT_PRESERVING_OPS } from '../../src/dna';

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
const boxGlyph: Glyph = { char: 'B', unicode: 66, advance: 600, source: 'imported', kind: 'outline',
  contours: [
    { points: [[60, 0], [520, 0], [520, 700], [60, 700]] },        // outer CCW
    { points: [[200, 120], [200, 580], [380, 580], [380, 120]] },  // hole CW
  ] };
const glyphs = [oGlyph, lGlyph, nGlyph, boxGlyph];

const OPS = ['weight', 'slant', 'wobble', 'melt', 'inflate', 'erode', 'glitch', 'bounce', 'jitter'] as const;
const RANDOM_OPS = ['wobble', 'bounce', 'jitter', 'glitch', 'erode', 'melt'] as const;
const dnaWith = (patch: Partial<DnaParams>): DnaParams => ({ ...DEFAULT_DNA, seed: 7, ...patch });
const absArea = (cs: Contour[]) => cs.reduce((a, c) => a + Math.abs(signedArea(c.points)), 0);
const inkArea = (cs: Contour[]) => cs.reduce((a, c) => a + signedArea(c.points), 0);
const allFinite = (cs: Contour[]) => cs.every((c) => c.points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));
const run = (g: Glyph, patch: Partial<DnaParams>) => applyDna(g, dnaWith(patch), DEFAULT_METRICS);

describe('dna: each op at 0.5 on every synthetic glyph', () => {
  for (const op of OPS) {
    for (const g of glyphs) {
      it(`${op} on '${g.char}' yields finite, non-empty contours`, () => {
        const out = run(g, { [op]: 0.5 });
        expect(out.length).toBeGreaterThanOrEqual(1);
        expect(allFinite(out)).toBe(true);
        expect(JSON.stringify(out)).not.toContain('null');
      });
    }
  }
});

describe('dna: identity & determinism', () => {
  it('isIdentityDna', () => {
    expect(isIdentityDna(DEFAULT_DNA)).toBe(true);
    expect(isIdentityDna({ ...DEFAULT_DNA, seed: 99 })).toBe(true);
    expect(isIdentityDna(dnaWith({ melt: 0.1 }))).toBe(false);
  });
  it('identity dna returns glyphToContours output', () => {
    for (const g of glyphs) expect(run(g, {})).toEqual(glyphToContours(g));
  });
  it('same seed => identical JSON', () => {
    for (const g of glyphs) {
      const all = { weight: 0.5, slant: 0.5, wobble: 0.5, melt: 0.5, inflate: 0.5, erode: 0.5, glitch: 0.5, bounce: 0.5, jitter: 0.5 };
      expect(JSON.stringify(run(g, all))).toBe(JSON.stringify(run(g, all)));
    }
  });
  it('different seed => different JSON for random ops', () => {
    for (const op of RANDOM_OPS) {
      const a = JSON.stringify(applyDna(nGlyph, dnaWith({ [op]: 0.5, seed: 7 }), DEFAULT_METRICS));
      const b = JSON.stringify(applyDna(nGlyph, dnaWith({ [op]: 0.5, seed: 8 }), DEFAULT_METRICS));
      expect(a, op).not.toBe(b);
    }
  });
  it('POINT_PRESERVING_OPS excludes the topology-changing ops', () => {
    expect(POINT_PRESERVING_OPS).not.toContain('inflate');
    expect(POINT_PRESERVING_OPS).not.toContain('erode');
    expect(POINT_PRESERVING_OPS).not.toContain('glitch');
  });
});

describe('dna: geometric effects', () => {
  it('inflate increases ink area (and the total |area| of hole-free glyphs)', () => {
    for (const g of glyphs) expect(inkArea(run(g, { inflate: 0.5 })), g.char).toBeGreaterThan(inkArea(run(g, {})) * 1.05);
    for (const g of [lGlyph, nGlyph]) expect(absArea(run(g, { inflate: 0.5 }))).toBeGreaterThan(absArea(run(g, {})) * 1.05);
  });
  it('negative weight on the outline glyph decreases ink area, positive increases it', () => {
    const base = inkArea(run(boxGlyph, {}));
    expect(inkArea(run(boxGlyph, { weight: -0.5 }))).toBeLessThan(base * 0.95);
    expect(inkArea(run(boxGlyph, { weight: 0.5 }))).toBeGreaterThan(base * 1.05);
  });
  it('positive weight on stroke glyphs increases area, negative decreases it', () => {
    for (const g of [oGlyph, lGlyph, nGlyph]) {
      const base = inkArea(run(g, {}));
      expect(inkArea(run(g, { weight: 0.5 })), g.char).toBeGreaterThan(base * 1.1);
      expect(inkArea(run(g, { weight: -0.5 })), g.char).toBeLessThan(base * 0.9);
    }
  });
  it('slant 1 moves the top of the stem right of the bottom', () => {
    const out = run(lGlyph, { slant: 1 });
    const pts = out.flatMap((c) => c.points);
    const top = pts.filter(([, y]) => y > 650), bottom = pts.filter(([, y]) => y < 60);
    const mean = (ps: [number, number][]) => ps.reduce((a, p) => a + p[0], 0) / ps.length;
    expect(mean(top)).toBeGreaterThan(mean(bottom) + 300);
  });
  it('erode at 0.6 reduces area and never increases it', () => {
    for (const g of glyphs) {
      const base = inkArea(run(g, {}));
      for (const seed of [1, 7, 42]) {
        const eroded = inkArea(applyDna(g, dnaWith({ erode: 0.6, seed }), DEFAULT_METRICS));
        expect(eroded, `${g.char} seed ${seed}`).toBeLessThan(base);
      }
    }
  });
  it('melt pulls the bottom of the glyph below the baseline', () => {
    expect(bboxContours(run(nGlyph, { melt: 0.5 })).minY).toBeLessThan(bboxContours(run(nGlyph, {})).minY - 10);
  });
  it('bounce moves the glyph vertically', () => {
    const a = bboxContours(run(nGlyph, {})), b = bboxContours(run(nGlyph, { bounce: 1 }));
    expect(Math.abs(a.minY - b.minY)).toBeGreaterThan(5);
  });
  it('glitch produces horizontal discontinuity (wider bbox)', () => {
    const a = bboxContours(run(lGlyph, {})), b = bboxContours(run(lGlyph, { glitch: 1 }));
    expect(b.maxX - b.minX).toBeGreaterThan(a.maxX - a.minX + 20);
  });
  it('advanceAfterDna', () => {
    expect(advanceAfterDna(nGlyph, DEFAULT_DNA)).toBe(600);
    expect(advanceAfterDna(nGlyph, dnaWith({ inflate: 0.5 }))).toBe(640);
    expect(advanceAfterDna(nGlyph, dnaWith({ weight: 0.5 }))).toBe(630);
    expect(advanceAfterDna(nGlyph, dnaWith({ weight: -0.5 }))).toBe(600);
    expect(advanceAfterDna(nGlyph, dnaWith({ slant: 1, bounce: 1 }))).toBe(600);
    const j = advanceAfterDna(nGlyph, dnaWith({ jitter: 1 }));
    expect(j).not.toBe(600);
    expect(Math.abs(j - 600)).toBeLessThanOrEqual(90);
    expect(j).toBe(advanceAfterDna(nGlyph, dnaWith({ jitter: 1 })));
  });
});

describe('dna: performance', () => {
  it('applyDna with every param at 0.5 on the n glyph runs in < 400 ms', () => {
    const all = dnaWith({ weight: 0.5, slant: 0.5, wobble: 0.5, melt: 0.5, inflate: 0.5, erode: 0.5, glitch: 0.5, bounce: 0.5, jitter: 0.5 });
    applyDna(nGlyph, all, DEFAULT_METRICS); // warm-up (JIT)
    const t0 = performance.now();
    const out = applyDna(nGlyph, all, DEFAULT_METRICS);
    const ms = performance.now() - t0;
    const t1 = performance.now();
    for (const g of glyphs) applyDna(g, all, DEFAULT_METRICS);
    const ms4 = (performance.now() - t1) / glyphs.length;
    // eslint-disable-next-line no-console
    console.log(`applyDna(all=0.5) on 'n': ${ms.toFixed(1)} ms (${out.length} contours); mean over 4 glyphs: ${ms4.toFixed(1)} ms`);
    expect(out.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(400);
  });
});
