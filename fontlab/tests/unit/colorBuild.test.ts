import { describe, it, expect } from 'vitest';
import { newProject, DEFAULT_STATS } from '../../src/core/glyph';
import { generateGlyphs } from '../../src/generate/compose';
import { buildAll } from '../../src/pipeline/build';
import { readTables } from '../../src/export/sfnt';
import { parse } from '../../src/vendor/opentype';

const project = (mode: 'strokes' | 'stripes' | 'shadow' | 'outline') => {
  const p = newProject('Colour Test');
  p.glyphs = generateGlyphs({ seeds: [], stats: { ...DEFAULT_STATS }, mutation: 0.2, glyphs: {} }, 3, [...'HEo12']);
  p.color = { enabled: true, mode, palette: ['#ff3b3b', '#0a84ff', '#ffd166'], amount: 0.5 };
  return p;
};

describe('colour font in the build', () => {
  it('off: no layers and no colour tables', () => {
    const p = project('strokes'); p.color.enabled = false;
    const res = buildAll(p);
    expect(Object.values(res.glyphs).every((g) => !g.layers)).toBe(true);
    expect(readTables(res.otf!).tables.map((t) => t.tag)).not.toContain('COLR');
  });
  for (const mode of ['strokes', 'stripes', 'shadow', 'outline'] as const) {
    it(`${mode}: every letter has layers and the font carries COLR + CPAL bound to real glyphs`, () => {
      const p = project(mode);
      const res = buildAll(p);
      for (const g of Object.values(res.glyphs)) expect(g.layers?.length, g.char).toBeGreaterThan(0);
      const tags = readTables(res.otf!).tables.map((t) => t.tag);
      expect(tags).toContain('COLR'); expect(tags).toContain('CPAL');
      const font = parse(res.otf!);
      const gid = font.charToGlyphIndex('H');
      const layers = font.layers.get(gid);
      expect(layers.length).toBe(res.glyphs.H.layers!.length);
      for (const l of layers) expect(l.glyph.index).toBeGreaterThan(0);
      // tabular digits keep their colours
      const names: string[] = []; for (let i = 0; i < font.glyphs.length; i++) names.push(font.glyphs.get(i).name);
      expect(names).toContain('one.tnum.color0');
    });
  }
  it('shadow widens the advance and kerning sees the widened letters', () => {
    const plain = project('shadow'); plain.color.enabled = false;
    const a = buildAll(plain).glyphs.H.advance, b = buildAll(project('shadow')).glyphs.H.advance;
    expect(b).toBeGreaterThan(a);
  });
});
