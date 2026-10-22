import { describe, it, expect } from 'vitest';
import { buildFont, fontToArrayBuffer } from '../../src/export/otf';
import { parse } from '../../src/vendor/opentype';
import { glyphToContours } from '../../src/outline';
import { importFont, pathToContours } from '../../src/inputs/fontimport';
import { DEFAULT_METRICS, CHARSET } from '../../src/core/glyph';
import type { Glyph } from '../../src/core/glyph';
import { signedArea } from '../../src/core/geometry';

function boxGlyph(ch: string, i: number): Glyph {
  const x = 60 + (i % 5) * 10;
  return { char: ch, unicode: ch.codePointAt(0)!, advance: 600, source: 'drawn', kind: 'stroke', strokes: [{ id: 's', cap: 'round', points: [{ x, y: 0, w: 40 }, { x: x + 300, y: 600, w: 40 }] }] };
}

describe('OTF export', () => {
  it('builds a font with all 62 glyphs that opentype.js can parse back', () => {
    const glyphs = [...CHARSET].map((ch, i) => { const g = boxGlyph(ch, i); return { char: ch, unicode: g.unicode, advance: g.advance, contours: glyphToContours(g) }; });
    const font = buildFont(glyphs, { familyName: 'Test Funk', metrics: DEFAULT_METRICS });
    const buf = fontToArrayBuffer(font);
    expect(buf.byteLength).toBeGreaterThan(1000);
    const f2 = parse(buf);
    expect(f2.glyphs.length).toBe(64); // .notdef + space + 62
    for (const ch of CHARSET) {
      const g = f2.charToGlyph(ch);
      expect(g.index).toBeGreaterThan(0);
      expect(g.unicode).toBe(ch.codePointAt(0));
      expect(g.advanceWidth).toBe(600);
      expect(g.path.commands.length).toBeGreaterThan(3);
    }
    expect((f2.names.unicode ?? f2.names).fontFamily.en).toBe('Test Funk');
  });
  it('round-trips through importFont with the same ink area (±8%)', () => {
    const g = boxGlyph('A', 0);
    const cs = glyphToContours(g);
    const buf = fontToArrayBuffer(buildFont([{ char: 'A', unicode: 65, advance: 600, contours: cs }], { familyName: 'RT', metrics: DEFAULT_METRICS }));
    const imp = importFont(buf, 'A');
    expect(imp.glyphs).toHaveLength(1);
    const a1 = cs.reduce((a, c) => a + signedArea(c.points), 0);
    const a2 = imp.glyphs[0].contours!.reduce((a, c) => a + signedArea(c.points), 0);
    expect(Math.abs(a1 - a2) / a1).toBeLessThan(0.08);
    expect(imp.glyphs[0].advance).toBe(600);
  });
  it('pathToContours flips y and flattens curves', () => {
    const cmds = [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 100, y: 0 }, { type: 'C', x1: 100, y1: -50, x2: 50, y2: -100, x: 0, y: -100 }, { type: 'Z' }];
    const cs = pathToContours(cmds, 1, true);
    expect(cs).toHaveLength(1);
    expect(Math.max(...cs[0].points.map((p) => p[1]))).toBeGreaterThan(90);
    expect(cs[0].points.length).toBeGreaterThan(5);
  });
});
