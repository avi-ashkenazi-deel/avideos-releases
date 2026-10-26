import { describe, it, expect } from 'vitest';
import { glyphToContours } from '../../src/outline';
import type { Glyph } from '../../src/core/glyph';
import { signedArea } from '../../src/core/geometry';

const square: Glyph = { char: 'o', unicode: 111, advance: 600, source: 'imported', kind: 'outline', contours: [{ points: [[100, 0], [400, 0], [400, 300], [100, 300]] }] };
const area = (g: Glyph) => glyphToContours(g).reduce((a, c) => a + signedArea(c.points), 0);

describe('strokes drawn on top of an outline glyph', () => {
  it('a stroke away from the outline adds a second contour', () => {
    const g: Glyph = { ...square, strokes: [{ id: 's', cap: 'round', points: [{ x: 600, y: 0, w: 20, p: 0.5 }, { x: 600, y: 300, w: 20, p: 0.5 }] }] };
    expect(glyphToContours(square).length).toBe(1);
    expect(glyphToContours(g).length).toBe(2);
  });
  it('a stroke crossing the outline is unioned into it and grows the area', () => {
    const g: Glyph = { ...square, strokes: [{ id: 's', cap: 'flat', points: [{ x: 0, y: 150, w: 20, p: 0.5 }, { x: 500, y: 150, w: 20, p: 0.5 }] }] };
    const cs = glyphToContours(g);
    expect(cs.length).toBe(1);
    expect(area(g)).toBeGreaterThan(area(square) + 100 * 40 * 0.9); // two 100-unit stubs of width 40
  });
  it('an outline glyph with strokes but no contours still renders the strokes', () => {
    const g: Glyph = { ...square, contours: [], strokes: [{ id: 's', cap: 'round', points: [{ x: 0, y: 0, w: 20, p: 0.5 }, { x: 0, y: 300, w: 20, p: 0.5 }] }] };
    expect(glyphToContours(g).length).toBe(1);
  });
});
