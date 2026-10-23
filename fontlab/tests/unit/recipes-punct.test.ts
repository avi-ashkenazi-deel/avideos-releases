import { describe, it, expect } from 'vitest';
import { DEFAULT_STATS, type Glyph } from '../../src/core/glyph';
import { bboxStrokes, signedArea } from '../../src/core/geometry';
import { makeRng } from '../../src/core/prng';
import { glyphToContours } from '../../src/outline/index';
import { frame, type RecipeCtx, type RecipeResult } from '../../src/core/recipes/common';
import { punct } from '../../src/core/recipes/punct';
import { symbols } from '../../src/core/recipes/symbols';

const PUNCT = [...'.,;:!?¡¿\'"‘’“”«»-–—_()[]{}/\\|@#&*+=<>~^%'];
const SYMBOLS = [...'$€£¥¢©®™°±×÷•…§¶†‡µ¬'];

function ctx(seed = 1): RecipeCtx {
  return { stats: { ...DEFAULT_STATS }, rng: makeRng(seed), mutation: 0.3, params: {} };
}

function build(char: string, seed = 1): RecipeResult {
  const r = punct[char] ?? symbols[char];
  if (!r) throw new Error(`no recipe for ${JSON.stringify(char)}`);
  return r.build(ctx(seed));
}

function inkWidth(char: string): number {
  const bb = bboxStrokes(build(char).strokes);
  return bb.maxX - bb.minX;
}

describe('punctuation & symbol recipes', () => {
  it('covers exactly the listed characters with id = char', () => {
    expect(Object.keys(punct).sort()).toEqual([...PUNCT].sort());
    expect(Object.keys(symbols).sort()).toEqual([...SYMBOLS].sort());
    for (const ch of PUNCT) expect(punct[ch].id).toBe(ch);
    for (const ch of SYMBOLS) expect(symbols[ch].id).toBe(ch);
    // no overlap between the two tables
    for (const ch of PUNCT) expect(symbols[ch]).toBeUndefined();
  });

  const f = frame(ctx());

  for (const ch of [...PUNCT, ...SYMBOLS]) {
    it(`builds a sane skeleton for ${JSON.stringify(ch)}`, () => {
      const r = build(ch);
      expect(r.strokes.length).toBeGreaterThanOrEqual(1);
      expect(r.advance).toBeGreaterThan(0);
      for (const s of r.strokes) {
        expect(s.points.length).toBeGreaterThan(0);
        for (const p of s.points) {
          expect(Number.isFinite(p.x)).toBe(true);
          expect(Number.isFinite(p.y)).toBe(true);
          expect(Number.isFinite(p.w)).toBe(true);
          expect(p.w).toBeGreaterThan(0);
        }
      }
      const bb = bboxStrokes(r.strokes);
      expect(bb.minX).toBeGreaterThanOrEqual(-50);
      expect(bb.maxX).toBeLessThanOrEqual(r.advance + 50);
      expect(bb.minY).toBeGreaterThanOrEqual(f.desc - 80);
      expect(bb.maxY).toBeLessThanOrEqual(f.asc + 80);

      const g: Glyph = {
        char: ch,
        unicode: ch.codePointAt(0)!,
        advance: r.advance,
        source: 'generated',
        kind: 'stroke',
        strokes: r.strokes,
      };
      const contours = glyphToContours(g);
      expect(contours.length).toBeGreaterThanOrEqual(1);
      const area = contours.reduce((a, c) => a + signedArea(c.points), 0);
      expect(area).toBeGreaterThan(0);
    });
  }

  it('period is a single one-point stroke sitting on the baseline', () => {
    const r = build('.');
    expect(r.strokes.length).toBe(1);
    expect(r.strokes[0].points.length).toBe(1);
    const p = r.strokes[0].points[0];
    expect(Math.abs(p.y - f.hw)).toBeLessThan(5);
    expect(Math.abs(p.w - f.hw)).toBeLessThan(f.hw * 0.15);
  });

  it('( and ) are mirror images', () => {
    expect(Math.abs(inkWidth('(') - inkWidth(')'))).toBeLessThanOrEqual(2);
    expect(Math.abs(inkWidth('[') - inkWidth(']'))).toBeLessThanOrEqual(2);
    expect(Math.abs(inkWidth('{') - inkWidth('}'))).toBeLessThanOrEqual(2);
    const l = bboxStrokes(build('(').strokes), rr = bboxStrokes(build(')').strokes);
    expect(Math.abs(l.minY - rr.minY)).toBeLessThanOrEqual(2);
    expect(Math.abs(l.maxY - rr.maxY)).toBeLessThanOrEqual(2);
  });

  it('dashes are ordered: em > en > hyphen', () => {
    const hy = inkWidth('-'), en = inkWidth('–'), em = inkWidth('—');
    expect(em).toBeGreaterThan(en);
    expect(en).toBeGreaterThan(hy);
  });

  it('colon dots sit at hw and xh - hw', () => {
    const ys = build(':').strokes.map((s) => s.points[0].y).sort((a, b) => a - b);
    expect(Math.abs(ys[0] - f.hw)).toBeLessThan(5);
    expect(Math.abs(ys[1] - (f.xh - f.hw))).toBeLessThan(5);
  });

  it('¡ and ¿ are 180° rotations of ! and ? about the x-height midpoint', () => {
    for (const [a, b] of [['!', '¡'], ['?', '¿']]) {
      const ba = bboxStrokes(build(a).strokes), bb = bboxStrokes(build(b).strokes);
      expect(Math.abs((ba.maxX - ba.minX) - (bb.maxX - bb.minX))).toBeLessThanOrEqual(2);
      expect(Math.abs(bb.maxY - (f.xh - ba.minY))).toBeLessThanOrEqual(2);
      expect(Math.abs(bb.minY - (f.xh - ba.maxY))).toBeLessThanOrEqual(2);
    }
  });

  it('is deterministic for a given seed and varies across seeds', () => {
    for (const ch of [...PUNCT, ...SYMBOLS]) {
      expect(JSON.stringify(build(ch, 1))).toBe(JSON.stringify(build(ch, 1)));
    }
    expect(JSON.stringify(build('&', 1))).not.toBe(JSON.stringify(build('&', 2)));
  });

  it('scales with the metrics', () => {
    const big: RecipeCtx = { ...ctx(), stats: { ...DEFAULT_STATS, capHeight: 900, xHeight: 650, ascender: 950 } };
    const small = bboxStrokes(punct['@'].build(ctx()).strokes);
    const large = bboxStrokes(punct['@'].build(big).strokes);
    expect(large.maxY - large.minY).toBeGreaterThan(small.maxY - small.minY);
  });
});
