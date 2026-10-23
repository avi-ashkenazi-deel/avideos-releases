import { describe, it, expect } from 'vitest';
import { BLOCKS, projectCharset, groupCharset, blockOf, samplePreview } from '../../src/core/charsets';
import { parseProject } from '../../src/project/schema';
import { newProject, DEFAULT_STATS, type Glyph } from '../../src/core/glyph';
import { decompose, dependsOn, dependencyChain, deriveGlyph } from '../../src/generate/derive';
import { generateGlyphs, dependentsOf, regenerateOne } from '../../src/generate/compose';
import { glyphToContours } from '../../src/outline';
import { bboxStrokes, signedArea } from '../../src/core/geometry';
import { makeRng } from '../../src/core/prng';
import { glyphName } from '../../src/export/otf';

const e: Glyph = { char: 'e', unicode: 101, advance: 520, source: 'drawn', kind: 'stroke', strokes: [
  { id: 'e1', cap: 'round', points: [{ x: 60, y: 250, w: 40 }, { x: 400, y: 250, w: 40 }] },
  { id: 'e2', cap: 'round', points: [{ x: 400, y: 250, w: 40 }, { x: 380, y: 450, w: 40 }, { x: 230, y: 500, w: 40 }, { x: 80, y: 400, w: 40 }, { x: 80, y: 120, w: 40 }, { x: 230, y: 0, w: 40 }, { x: 400, y: 60, w: 40 }] },
] };
const A: Glyph = { char: 'A', unicode: 65, advance: 640, source: 'drawn', kind: 'stroke', strokes: [
  { id: 'A1', cap: 'round', points: [{ x: 60, y: 0, w: 40 }, { x: 320, y: 700, w: 40 }, { x: 580, y: 0, w: 40 }] },
  { id: 'A2', cap: 'round', points: [{ x: 180, y: 250, w: 40 }, { x: 460, y: 250, w: 40 }] },
] };
const i: Glyph = { char: 'i', unicode: 105, advance: 220, source: 'drawn', kind: 'stroke', strokes: [
  { id: 'i1', cap: 'round', points: [{ x: 100, y: 0, w: 40 }, { x: 100, y: 500, w: 40 }] },
  { id: 'i2', cap: 'round', points: [{ x: 100, y: 660, w: 42 }] },
] };

describe('charsets', () => {
  it('projectCharset orders by block, dedupes, and appends custom chars', () => {
    const cs = projectCharset({ blocks: ['latin', 'hebrew', 'punct'], customChars: '★A★ ב' });
    expect(cs.slice(0, 3)).toEqual(['A', 'B', 'C']);
    expect(cs.indexOf('.')).toBeLessThan(cs.indexOf('א'));
    expect(cs.filter((c) => c === 'A')).toHaveLength(1);
    expect(cs[cs.length - 1]).toBe('★');
    expect(groupCharset(cs).map(([b]) => b)).toEqual(['latin', 'punct', 'hebrew', 'custom']);
    expect(blockOf('€')).toBe('symbols');
    expect(samplePreview({ blocks: ['latin', 'cyrillic'] }).split('\n')).toHaveLength(2);
  });
  it('blocks have no duplicate characters and no whitespace', () => {
    for (const b of BLOCKS) {
      const chars = [...b.chars];
      expect(new Set(chars).size).toBe(chars.length);
      expect(chars.some((c) => /\s/.test(c))).toBe(false);
    }
  });
  it('old project files migrate to latin-only', () => {
    const raw = JSON.parse(JSON.stringify(newProject('old'))) as Record<string, unknown>;
    delete raw.blocks; delete raw.customChars;
    const p = parseProject(raw);
    expect(p.blocks).toEqual(['latin']);
    expect(p.customChars).toBe('');
  });
});

describe('coverage', () => {
  it('every character of every block generates ink with default stats', () => {
    const all = BLOCKS.flatMap((b) => [...b.chars]);
    const out = generateGlyphs({ seeds: [], stats: { ...DEFAULT_STATS }, mutation: 0.3, glyphs: {} }, 11, all);
    const empty = all.filter((ch) => !out[ch]?.strokes?.some((s) => s.points.length));
    expect(empty).toEqual([]);
    for (const ch of all) {
      const cs = glyphToContours(out[ch]);
      expect(cs.reduce((a, c) => a + signedArea(c.points), 0), ch).toBeGreaterThan(0);
    }
  });
});

describe('derivation', () => {
  const ctx = { stats: { ...DEFAULT_STATS }, rng: makeRng(3), mutation: 0.2 };
  it('decomposes accented letters and reports dependencies', () => {
    expect(decompose('é')).toEqual({ base: 'e', marks: ['acute'] });
    expect(decompose('ḁ')).toBeNull(); // ring below: not in our mark table → falls through
    expect(decompose('Ǘ')).toEqual({ base: 'U', marks: ['dieresis', 'acute'] });
    expect(decompose('e')).toBeNull();
    expect(dependsOn('А')).toBe('A');
    expect(dependsOn('в')).toBe('В');
    expect(dependencyChain('ё')).toEqual(['е', 'e']);
    expect(dependencyChain('Ё')).toEqual(['Е', 'E']);
  });
  it('é keeps the drawn e verbatim and adds one mark above it', () => {
    const g = deriveGlyph('é', (c) => (c === 'e' ? e : undefined), ctx, 1)!;
    expect(g.kind).toBe('stroke');
    expect(g.strokes!.length).toBe(e.strokes!.length + 1);
    expect(g.strokes!.slice(0, 2).map((s) => s.points)).toEqual(e.strokes!.map((s) => s.points));
    const mark = bboxStrokes([g.strokes![2]]);
    expect(mark.minY).toBeGreaterThan(bboxStrokes(e.strokes!).maxY);
    expect(g.recipe?.id).toBe('compose:e+acute');
  });
  it('capitals get a flatter, closer mark; cedilla hangs below the baseline', () => {
    const upper = deriveGlyph('Á', (c) => (c === 'A' ? A : undefined), ctx, 1)!;
    const lower = deriveGlyph('é', (c) => (c === 'e' ? e : undefined), ctx, 1)!;
    const gapU = bboxStrokes([upper.strokes!.at(-1)!]).minY - 700;
    const gapL = bboxStrokes([lower.strokes!.at(-1)!]).minY - 500;
    expect(gapU).toBeLessThan(gapL);
    const c: Glyph = { ...e, char: 'c', unicode: 99, strokes: [e.strokes![1]] };
    const ced = deriveGlyph('ç', (ch) => (ch === 'c' ? c : undefined), ctx, 1)!;
    expect(bboxStrokes([ced.strokes!.at(-1)!]).minY).toBeLessThan(-10);
  });
  it('ï drops the dot of i before adding the dieresis; ı is a dotless alias', () => {
    const g = deriveGlyph('ï', (c) => (c === 'i' ? i : undefined), ctx, 1)!;
    expect(g.strokes!.some((s) => s.points.length === 1 && s.points[0].y === 660)).toBe(false);
    expect(g.strokes!.length).toBe(1 + 2);
    const dl = deriveGlyph('ı', (c) => (c === 'i' ? i : undefined), ctx, 1)!;
    expect(dl.strokes!.length).toBe(1);
  });
  it('Cyrillic А is a clone of the drawn A; в is a small-cap of В', () => {
    const a = deriveGlyph('А', (c) => (c === 'A' ? A : undefined), ctx, 1)!;
    expect(a.strokes!.map((s) => s.points)).toEqual(A.strokes!.map((s) => s.points));
    expect(a.unicode).toBe(0x410);
    const B: Glyph = { ...A, char: 'В', unicode: 0x412 };
    const v = deriveGlyph('в', (c) => (c === 'В' ? B : undefined), ctx, 1)!;
    const bb = bboxStrokes(v.strokes!);
    expect(Math.abs(bb.maxY - DEFAULT_STATS.xHeight)).toBeLessThan(25);
    expect(bb.minY).toBeGreaterThan(-60); expect(bb.minY).toBeLessThanOrEqual(0);
    expect(v.advance).toBeLessThan(A.advance);
  });
  it('works for outline bases too (marks become contours)', () => {
    const o: Glyph = { char: 'o', unicode: 111, advance: 500, source: 'imported', kind: 'outline', contours: [
      { points: [[60, 0], [440, 0], [440, 500], [60, 500]] }, { points: [[140, 80], [140, 420], [360, 420], [360, 80]] } ] };
    const g = deriveGlyph('ö', (c) => (c === 'o' ? o : undefined), ctx, 1)!;
    expect(g.kind).toBe('outline');
    expect(g.contours!.length).toBe(4);
    expect(glyphToContours(g).length).toBe(4);
  });
  it('generateGlyphs resolves chains through the project (ё → е → drawn e) and finds dependents', () => {
    const p = newProject();
    p.blocks = ['latin', 'cyrillic', 'accents'];
    p.seeds = [e];
    const out = generateGlyphs({ seeds: p.seeds, stats: p.stats, mutation: 0.3, glyphs: {} }, 5, ['е', 'ё', 'Ё', 'é', 'в', 'ı']);
    expect(out['е'].strokes!.map((s) => s.points)).toEqual(e.strokes!.map((s) => s.points));
    expect(out['ё'].strokes!.length).toBe(e.strokes!.length + 2);
    expect(out['Ё'].recipe?.id).toBe('compose:Е+dieresis');
    for (const g of Object.values(out)) {
      const cs = glyphToContours(g);
      expect(cs.reduce((a, c) => a + signedArea(c.points), 0)).toBeGreaterThan(0);
    }
    expect(dependentsOf('e', ['é', 'è', 'А', 'ё', 'x'])).toEqual(['é', 'è', 'ё']);
    const re = regenerateOne('é', { seeds: p.seeds, stats: p.stats, mutation: 0.3, glyphs: out }, 9);
    expect(re.strokes!.length).toBe(e.strokes!.length + 1);
  });
  it('AGL names for punctuation, uniXXXX elsewhere', () => {
    expect(glyphName('.', 46)).toBe('period');
    expect(glyphName('?', 63)).toBe('question');
    expect(glyphName('€', 0x20ac)).toBe('Euro');
    expect(glyphName('א', 0x5d0)).toBe('uni05D0');
    expect(glyphName('Ж', 0x416)).toBe('uni0416');
  });
});
