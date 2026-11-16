import { describe, it, expect } from 'vitest';
import { buildFont, fontToArrayBuffer, glyphName, defaultLigatures, type OutlineGlyph, type FontFeatures } from '../../src/export/otf';
import { buildAll } from '../../src/pipeline/build';
import { parse } from '../../src/vendor/opentype';
import { DEFAULT_METRICS, newProject } from '../../src/core/glyph';
import type { Contour, Glyph } from '../../src/core/glyph';

const rect = (x0: number, y0: number, x1: number, y1: number): Contour => ({ points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });
const og = (ch: string, advance = 600, w = 300): OutlineGlyph => ({ char: ch, unicode: ch.codePointAt(0)!, advance, contours: [rect(50, 0, 50 + w, 600)] });

const BASE = ['H', 'e', 'l', 'o', 'a', '-', '>', '<', '='].map((c) => og(c));
const ARROWS = ['→', '←', '↔', '⇒'].map((c) => og(c, 900, 700));
const DIGITS = [og('0', 560, 400), og('1', 380, 200)];

function features(): FontFeatures {
  const tnum = DIGITS.map((d) => [glyphName(d.char, d.unicode), glyphName(d.char, d.unicode) + '.tnum'] as [string, string]);
  return {
    extraGlyphs: [
      { name: 'a.ss01', advance: 640, contours: [rect(40, 0, 400, 500)] },
      ...DIGITS.map((d) => ({ name: glyphName(d.char, d.unicode) + '.tnum', advance: 560, contours: d.contours })),
    ],
    singles: { ss01: [['a', 'a.ss01']], tnum },
    alternates: { a: ['a.ss01'] },
    ligatures: defaultLigatures(),
  };
}

/** CFF keeps glyph names but post v3 has none, so opentype.js' nameToGlyphIndex can't see them */
const byName = (f: any, name: string): number => { for (let i = 0; i < f.glyphs.length; i++) if (f.glyphs.get(i).name === name) return i; return -1; };
const tags = (f: any): string[] => f.tables.gsub.features.map((x: any) => x.tag);
const ligsByUnicode = (f: any) => f.substitution.getLigatures('liga', 'DFLT').map((l: any) => ({ sub: l.sub.map((i: number) => f.glyphs.get(i).unicode), by: f.glyphs.get(l.by).unicode }));

describe('OpenType features (GSUB)', () => {
  it('maps component chars to AGL names', () => {
    expect(['-', '>', '<', '='].map((c) => glyphName(c, c.codePointAt(0)!))).toEqual(['hyphen', 'greater', 'less', 'equal']);
    expect(defaultLigatures()[0].sub).toEqual(['less', 'hyphen', 'greater']); // longest first
  });

  it('writes ss01, salt, tnum and arrow ligatures that parse back', () => {
    const buf = fontToArrayBuffer(buildFont([...BASE, ...ARROWS, ...DIGITS], { familyName: 'Feat', metrics: DEFAULT_METRICS, features: features() }));
    const f = parse(buf);
    expect(f.tables.gsub).toBeTruthy();
    const t = tags(f);
    for (const tag of ['ss01', 'tnum', 'liga', 'salt']) expect(t).toContain(tag);
    expect([...t]).toEqual([...t].sort()); // FeatureList must be tag-sorted
    // both DFLT and latn scripts point at the same features
    const scripts = f.tables.gsub.scripts.map((s: any) => s.tag);
    expect(scripts).toEqual(['DFLT', 'latn']);
    expect(f.tables.gsub.scripts[1].script.defaultLangSys.featureIndexes).toEqual(f.tables.gsub.scripts[0].script.defaultLangSys.featureIndexes);

    // ligatures: all four, longest (<->) before <- in the `less` set
    const ligs = ligsByUnicode(f);
    expect(ligs).toContainEqual({ sub: [0x2d, 0x3e], by: 0x2192 });
    expect(ligs).toContainEqual({ sub: [0x3c, 0x2d], by: 0x2190 });
    expect(ligs).toContainEqual({ sub: [0x3c, 0x2d, 0x3e], by: 0x2194 });
    expect(ligs).toContainEqual({ sub: [0x3d, 0x3e], by: 0x21d2 });
    const lessLigs = ligs.filter((l: any) => l.sub[0] === 0x3c);
    expect(lessLigs[0].sub).toHaveLength(3);
    // NB: opentype.js' stringToGlyphs only runs liga inside Latin-letter runs, so it leaves '->'
    // alone; browsers (HarfBuzz) do apply it — the lookup table above is what matters.

    // ss01 single substitution a → a.ss01
    const a = f.charToGlyph('a').index, aAlt = byName(f, 'a.ss01');
    expect(aAlt).toBeGreaterThan(0);
    expect(f.glyphs.get(aAlt).advanceWidth).toBe(640);
    expect(f.substitution.getSingle('ss01', 'DFLT')).toContainEqual({ sub: a, by: aAlt });
    expect(f.substitution.getAlternates('salt', 'DFLT')).toContainEqual({ sub: a, by: [aAlt] });

    // tabular digits share one advance
    const z = f.glyphs.get(byName(f, 'zero.tnum')), o = f.glyphs.get(byName(f, 'one.tnum'));
    expect(z.name).toBe('zero.tnum');
    expect(o.name).toBe('one.tnum');
    expect(z.advanceWidth).toBe(o.advanceWidth);
    expect(z.unicode).toBeUndefined();
    expect(f.substitution.getSingle('tnum', 'DFLT')).toHaveLength(2);
  });

  it('skips rules whose glyphs are missing (partial build / no arrows)', () => {
    const feats = features();
    feats.singles!.ss02 = [['a', 'a.ss02']]; // alternate glyph not supplied
    const font = buildFont([...BASE, ...DIGITS], { familyName: 'NoArrows', metrics: DEFAULT_METRICS, features: feats });
    const f = parse(fontToArrayBuffer(font));
    const t = tags(f);
    expect(t).not.toContain('liga');
    expect(t).not.toContain('ss02');
    expect(t).toContain('ss01');
    expect(f.stringToGlyphs('->')).toHaveLength(2);
  });

  it('builds a font with no GSUB when no rule resolves', () => {
    const font = buildFont([og('H')], { familyName: 'Plain', metrics: DEFAULT_METRICS, features: { ligatures: defaultLigatures() } });
    const f = parse(fontToArrayBuffer(font));
    expect(f.tables.gsub).toBeFalsy();
    expect(f.glyphs.length).toBe(3);
  });
});

function stroke(ch: string, x0: number, x1: number, advance = 600): Glyph {
  return { char: ch, unicode: ch.codePointAt(0)!, advance, source: 'drawn', kind: 'stroke', strokes: [{ id: 's', cap: 'round', points: [{ x: x0, y: 0, w: 40 }, { x: x1, y: 600, w: 40 }] }] };
}

describe('buildAll features', () => {
  it('emits ss01 + tnum from project alternates and digits', () => {
    const p = newProject('Alt');
    for (const [ch, adv] of [['a', 520], ['b', 520], ['0', 560], ['1', 360]] as const) p.glyphs[ch] = stroke(ch, 80, 300, adv);
    p.alternates = { a: [stroke('a', 60, 420, 600)] };
    const res = buildAll(p);
    expect(Object.keys(res.glyphs).sort()).toEqual(['0', '1', 'a', 'b']); // alternates kept out of the char map
    expect(res.alternates['a#ss01']).toBeTruthy();
    expect(res.alternates['a#ss01']).not.toBe(res.glyphs.a);
    const f = parse(res.otf!);
    const t = tags(f);
    expect(t).toContain('ss01');
    expect(t).toContain('salt');
    expect(t).toContain('tnum');
    expect(f.glyphs.get(byName(f, 'a.ss01')).advanceWidth).toBe(600);
    expect(f.glyphs.get(byName(f, 'zero.tnum')).advanceWidth).toBe(560);
    expect(f.glyphs.get(byName(f, 'one.tnum')).advanceWidth).toBe(560);
    expect(structuredClone(res).alternates['a#ss01'].advance).toBe(600);
  });

  it('partial builds drop alternates whose base char is not built', () => {
    const p = newProject('Part');
    p.glyphs.a = stroke('a', 80, 300); p.glyphs.H = stroke('H', 80, 300);
    p.alternates = { a: [stroke('a', 60, 420)] };
    const res = buildAll(p, { chars: ['H'] });
    expect(res.alternates).toEqual({});
    const f = parse(res.otf!);
    expect(f.tables.gsub).toBeFalsy();
  });
});
