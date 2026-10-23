import { describe, it, expect } from 'vitest';
import { DEFAULT_STATS, type Glyph, type Stroke } from '../../src/core/glyph';
import { bboxOf, bboxStrokes, signedArea, type BBox } from '../../src/core/geometry';
import { makeRng } from '../../src/core/prng';
import { glyphToContours } from '../../src/outline/index';
import { cyrillic } from '../../src/core/recipes/cyrillic';
import type { RecipeResult } from '../../src/core/recipes/common';

const UPPER = [...'БГДЖЗИЛПУФЦЧШЩЪЫЬЭЮЯЄҐ'];
const LOWER = [...'бдф'];
const ALL = [...UPPER, ...LOWER];

const { capHeight: cap, xHeight: xh, ascender: asc, descender: desc } = DEFAULT_STATS;

function build(ch: string, seed = 1): RecipeResult {
  return cyrillic[ch].build({ stats: DEFAULT_STATS, rng: makeRng(seed), mutation: 0.3, params: {} });
}

/** centreline bbox (no stroke width): where the skeleton sits against the metrics */
function coreBox(strokes: Stroke[]): BBox {
  return bboxOf(strokes.flatMap((s) => s.points.map((p): [number, number] => [p.x, p.y])));
}

function toGlyph(ch: string, r: RecipeResult): Glyph {
  return {
    char: ch,
    unicode: ch.codePointAt(0)!,
    advance: r.advance,
    source: 'generated',
    kind: 'stroke',
    strokes: r.strokes.map((s, i) => ({ ...s, id: `t${i}` })),
  };
}

describe('cyrillic recipes', () => {
  it('has a recipe for every delivered character, keyed and id-ed by the character', () => {
    expect(Object.keys(cyrillic).sort()).toEqual([...ALL].sort());
    for (const ch of ALL) expect(cyrillic[ch].id).toBe(ch);
  });

  it('builds finite skeletons with a positive advance and ink inside the box', () => {
    for (const ch of ALL) {
      const r = build(ch);
      expect(r.strokes.length, ch).toBeGreaterThanOrEqual(1);
      for (const s of r.strokes) {
        expect(s.points.length, ch).toBeGreaterThan(0);
        for (const p of s.points) {
          expect(Number.isFinite(p.x), `${ch} x`).toBe(true);
          expect(Number.isFinite(p.y), `${ch} y`).toBe(true);
          expect(p.w, `${ch} w`).toBeGreaterThan(0);
        }
      }
      expect(r.advance, ch).toBeGreaterThan(0);
      const bb = bboxStrokes(r.strokes);
      expect(bb.minX, `${ch} minX`).toBeGreaterThanOrEqual(-50);
      expect(bb.maxX, `${ch} maxX`).toBeLessThanOrEqual(r.advance + 50);
      expect(bb.minY, `${ch} minY`).toBeGreaterThanOrEqual(desc - 80);
      expect(bb.maxY, `${ch} maxY`).toBeLessThanOrEqual(asc + 80);
    }
  });

  it('aligns uppercase to the cap height and the baseline', () => {
    for (const ch of UPPER) {
      const bb = coreBox(build(ch).strokes);
      if (ch === 'Ф') {
        // stem pokes slightly above the cap line
        expect(bb.maxY, ch).toBeGreaterThan(cap - 40);
        expect(bb.maxY, ch).toBeLessThan(cap + 60);
      } else if (ch === 'Ґ') {
        // upturned serif rises above the cap line
        expect(bb.maxY, ch).toBeGreaterThan(cap + 30);
        expect(bb.maxY, ch).toBeLessThanOrEqual(cap + 0.15 * cap);
      } else {
        expect(Math.abs(bb.maxY - cap), `${ch} top`).toBeLessThanOrEqual(40);
      }
      expect(bb.minY, `${ch} bottom`).toBeGreaterThanOrEqual(-0.2 * cap);
      expect(bb.minY, `${ch} bottom`).toBeLessThanOrEqual(40);
    }
    // the letters with tails / feet really do go below the baseline
    for (const ch of 'ДЦЩ') expect(coreBox(build(ch).strokes).minY, ch).toBeLessThan(-0.05 * cap);
  });

  it('gives the lowercase forms their ascender / descender', () => {
    const b = coreBox(build('б').strokes);
    expect(Math.abs(b.maxY - asc), 'б top').toBeLessThanOrEqual(60);
    expect(b.minY, 'б bottom').toBeGreaterThan(-40);

    const d = coreBox(build('д').strokes);
    expect(d.minY, 'д bottom').toBeLessThan(0);
    expect(d.maxY, 'д top').toBeLessThan(xh + 40);

    const f = coreBox(build('ф').strokes);
    expect(f.minY, 'ф bottom').toBeLessThan(0);
    expect(f.minY, 'ф bottom').toBeLessThan(desc + 40);
    expect(Math.abs(f.maxY - asc), 'ф top').toBeLessThanOrEqual(40);
  });

  it('converts to filled contours with positive total area', () => {
    for (const ch of ALL) {
      const contours = glyphToContours(toGlyph(ch, build(ch)));
      expect(contours.length, ch).toBeGreaterThanOrEqual(1);
      const area = contours.reduce((s, c) => s + signedArea(c.points), 0);
      expect(area, ch).toBeGreaterThan(0);
    }
  });

  it('is deterministic for the same seed and differs across seeds', () => {
    for (const ch of ALL) {
      expect(JSON.stringify(build(ch, 1)), ch).toBe(JSON.stringify(build(ch, 1)));
    }
    expect(JSON.stringify(build('Ж', 1))).not.toBe(JSON.stringify(build('Ж', 2)));
  });
});
