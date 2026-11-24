import { describe, it, expect } from 'vitest';
import { newProject, DEFAULT_STATS } from '../../src/core/glyph';
import { projectCharset } from '../../src/core/charsets';
import { generateGlyphs } from '../../src/generate/compose';
import { buildAll } from '../../src/pipeline/build';
import { parse } from '../../src/vendor/opentype';

describe('exported OTF stays on the built shapes', () => {
  it('every glyph box in the font matches its polygon box (no stray curve handles, no drift)', () => {
    const p = newProject('Accuracy');
    p.blocks = ['latin', 'punct', 'symbols', 'ui', 'accents', 'cyrillic', 'hebrew'];
    p.glyphs = generateGlyphs({ seeds: [], stats: { ...DEFAULT_STATS }, mutation: 0.3, glyphs: {} }, 42, projectCharset(p));
    const res = buildAll(p);
    const font = parse(res.otf!);
    let worst = 0, worstCh = '';
    for (const g of Object.values(res.glyphs)) {
      if (!g.contours.length) continue;
      const xs = g.contours.flatMap((c) => c.points.map((q) => q[0])), ys = g.contours.flatMap((c) => c.points.map((q) => q[1]));
      const bb = font.charToGlyph(g.char).getBoundingBox();
      const d = Math.max(Math.abs(bb.x1 - Math.min(...xs)), Math.abs(bb.x2 - Math.max(...xs)), Math.abs(bb.y1 - Math.min(...ys)), Math.abs(bb.y2 - Math.max(...ys)));
      if (d > worst) { worst = d; worstCh = g.char; }
    }
    expect(worst, `worst glyph: ${worstCh}`).toBeLessThan(8);
  }, 30000);
});
