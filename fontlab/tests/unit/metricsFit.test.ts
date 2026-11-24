import { describe, it, expect } from 'vitest';
import { newProject, DEFAULT_STATS } from '../../src/core/glyph';
import { projectCharset } from '../../src/core/charsets';
import { generateGlyphs } from '../../src/generate/compose';
import { fitVerticalMetrics } from '../../src/generate/metrics';
import { buildAll } from '../../src/pipeline/build';
import { runChecks } from '../../src/check/checks';

describe('fitVerticalMetrics', () => {
  it('a freshly generated alphabet no longer clips after the metrics are fitted', () => {
    const p = newProject('Generated Sans');
    p.glyphs = generateGlyphs({ seeds: [], stats: { ...DEFAULT_STATS }, mutation: 0.3, glyphs: {} }, 7, projectCharset(p));
    const before = runChecks(p, buildAll(p, { otf: false }).glyphs);
    expect(before.some((i) => i.id === 'clipping')).toBe(true);
    const m0 = { ...p.metrics };
    fitVerticalMetrics(p);
    expect(p.metrics.descender).toBeLessThan(m0.descender);
    expect(p.metrics.ascender).toBeGreaterThanOrEqual(m0.ascender);
    const after = runChecks(p, buildAll(p, { otf: false }).glyphs);
    expect(after.some((i) => i.id === 'clipping')).toBe(false);
    expect(after.filter((i) => i.severity === 'error')).toEqual([]);
  });
  it('only widens, and leaves a nearly empty font alone', () => {
    const p = newProject();
    p.metrics.ascender = 2000; p.metrics.descender = -900;
    p.glyphs = generateGlyphs({ seeds: [], stats: { ...DEFAULT_STATS }, mutation: 0, glyphs: {} }, 1, ['a', 'b', 'c', 'd', 'e']);
    fitVerticalMetrics(p);
    expect(p.metrics).toMatchObject({ ascender: 2000, descender: -900 });
    const q = newProject();
    const m = { ...q.metrics };
    fitVerticalMetrics(q);
    expect(q.metrics).toEqual(m);
  });
});
