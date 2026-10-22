import { describe, it, expect } from 'vitest';
import { parseProject, serializeProject } from '../../src/project/schema';
import { newProject } from '../../src/core/glyph';
import { makeRng, glyphRng } from '../../src/core/prng';

describe('project schema', () => {
  it('round-trips', () => {
    const p = newProject('Zig');
    p.glyphs['a'] = { char: 'a', unicode: 97, advance: 500, source: 'drawn', kind: 'stroke', strokes: [{ id: 's1', cap: 'round', points: [{ x: 0, y: 0, w: 30 }] }] };
    p.dna.wobble = 0.4;
    const q = parseProject(JSON.parse(serializeProject(p)));
    expect(q).toEqual(p);
  });
  it('rejects garbage and drops malformed glyphs', () => {
    expect(() => parseProject(null)).toThrow();
    expect(() => parseProject({ version: 2 })).toThrow();
    const q = parseProject({ version: 1, glyphs: { a: { char: 'a' }, b: { char: 'b', unicode: 98, advance: 1, kind: 'outline', contours: [] } } });
    expect(Object.keys(q.glyphs)).toEqual(['b']);
  });
});

describe('prng', () => {
  it('is deterministic per seed and independent per glyph', () => {
    const a = makeRng(7), b = makeRng(7), c = makeRng(8);
    const sa = [a(), a(), a.noise2(1, 2)], sb = [b(), b(), b.noise2(1, 2)], sc = [c(), c(), c.noise2(1, 2)];
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
    expect(glyphRng(1, 'a')()).toBe(glyphRng(1, 'a')());
    expect(glyphRng(1, 'a')()).not.toBe(glyphRng(1, 'b')());
  });
});
