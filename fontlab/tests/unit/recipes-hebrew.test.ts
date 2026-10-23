import { describe, it, expect } from 'vitest';
import { DEFAULT_STATS, type Glyph, type Stroke } from '../../src/core/glyph';
import { bboxStrokes, signedArea } from '../../src/core/geometry';
import { makeRng } from '../../src/core/prng';
import { glyphToContours } from '../../src/outline/index';
import { frame, type RecipeCtx } from '../../src/core/recipes/common';
import { hebrew } from '../../src/core/recipes/hebrew';

const LETTERS = [...'אבגדהוזחטיכךלםמןנסעףפץצקרשת'];
const FINALS = [...'ךןףץק'];
const NARROW = [...'וזיןך'];
const WIDE = [...'שםת'];

function ctx(mutation = 0.3, seed = 1): RecipeCtx {
  return { stats: { ...DEFAULT_STATS }, rng: makeRng(seed), mutation, params: {} };
}

function build(ch: string, mutation = 0.3, seed = 1) {
  const r = hebrew[ch].build(ctx(mutation, seed));
  return { ...r, strokes: r.strokes.map((s, i) => ({ ...s, id: `${ch}${i}` })) };
}

/** centreline extents (what the recipes control; stroke width is added by the outline pass) */
function centreBox(strokes: Stroke[]) {
  let minY = Infinity, maxY = -Infinity;
  for (const s of strokes) for (const p of s.points) { if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
  return { minY, maxY };
}

function inkWidth(strokes: Stroke[]) {
  const bb = bboxStrokes(strokes);
  return bb.maxX - bb.minX;
}

function toGlyph(ch: string, strokes: Stroke[], advance: number): Glyph {
  return { char: ch, unicode: ch.codePointAt(0)!, advance, source: 'generated', kind: 'stroke', strokes };
}

describe('hebrew recipes', () => {
  const f = frame(ctx());
  const H = 0.78 * f.cap;
  const built = Object.fromEntries(LETTERS.map((ch) => [ch, build(ch)]));

  it('has a recipe for all 27 letters, keyed and id-ed by the character', () => {
    expect(Object.keys(hebrew).sort()).toEqual([...LETTERS].sort());
    for (const ch of LETTERS) expect(hebrew[ch].id).toBe(ch);
  });

  it('builds sane skeletons: strokes, finite points, positive advance, ink inside the box', () => {
    const { ascender, descender } = DEFAULT_STATS;
    for (const ch of LETTERS) {
      const { strokes, advance } = built[ch];
      expect(strokes.length, `${ch} strokes`).toBeGreaterThanOrEqual(1);
      expect(advance, `${ch} advance`).toBeGreaterThan(0);
      let n = 0;
      for (const s of strokes) for (const p of s.points) {
        expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.w), `${ch} finite`).toBe(true);
        expect(p.w).toBeGreaterThan(0);
        n++;
      }
      expect(n, `${ch} points`).toBeGreaterThanOrEqual(2);
      const bb = bboxStrokes(strokes);
      expect(bb.minX, `${ch} minX`).toBeGreaterThanOrEqual(-50);
      expect(bb.maxX, `${ch} maxX`).toBeLessThanOrEqual(advance + 50);
      expect(bb.minY, `${ch} minY`).toBeGreaterThanOrEqual(descender - 80);
      expect(bb.maxY, `${ch} maxY`).toBeLessThanOrEqual(ascender + 80);
    }
  });

  it('tops sit on the body height (ל reaches the ascender)', () => {
    for (const ch of LETTERS) {
      const { maxY } = centreBox(built[ch].strokes);
      if (ch === 'ל') expect(Math.abs(maxY - f.asc), 'ל top').toBeLessThanOrEqual(40);
      else expect(Math.abs(maxY - H), `${ch} top`).toBeLessThanOrEqual(40);
    }
  });

  it('finals and ק descend, everything else sits on the baseline', () => {
    const limit = -0.4 * Math.abs(f.desc);
    for (const ch of LETTERS) {
      const { minY } = centreBox(built[ch].strokes);
      if (FINALS.includes(ch)) expect(minY, `${ch} bottom`).toBeLessThan(limit);
      else expect(minY, `${ch} bottom`).toBeGreaterThanOrEqual(-40);
    }
  });

  it('narrow letters are narrower than the wide ones', () => {
    const widest = Math.max(...NARROW.map((ch) => inkWidth(built[ch].strokes)));
    const narrowest = Math.min(...WIDE.map((ch) => inkWidth(built[ch].strokes)));
    expect(widest).toBeLessThan(narrowest);
    for (const ch of NARROW) expect(built[ch].advance, `${ch} advance`).toBeLessThan(Math.min(...WIDE.map((w) => built[w].advance)));
  });

  it('outlines to at least one contour with positive total area', () => {
    for (const ch of LETTERS) {
      const g = toGlyph(ch, built[ch].strokes, built[ch].advance);
      const contours = glyphToContours(g);
      expect(contours.length, `${ch} contours`).toBeGreaterThanOrEqual(1);
      const area = contours.reduce((a, c) => a + signedArea(c.points), 0);
      expect(area, `${ch} area`).toBeGreaterThan(0);
    }
  });

  it('is deterministic for the same seed and differs across seeds', () => {
    for (const ch of LETTERS) {
      expect(JSON.stringify(build(ch))).toBe(JSON.stringify(build(ch)));
      expect(JSON.stringify(build(ch, 0.3, 2))).not.toBe(JSON.stringify(build(ch, 0.3, 1)));
    }
  });

  it('builds at zero mutation and with heavy / wide params', () => {
    for (const ch of LETTERS) {
      const a = hebrew[ch].build({ ...ctx(0), params: {} });
      expect(a.strokes.length).toBeGreaterThan(0);
      const b = hebrew[ch].build({ stats: { ...DEFAULT_STATS, strokeWidth: 180 }, rng: makeRng(3), mutation: 1, params: { width: 1.4 } });
      expect(b.strokes.length).toBeGreaterThan(0);
      expect(b.advance).toBeGreaterThan(a.advance);
    }
  });
});
