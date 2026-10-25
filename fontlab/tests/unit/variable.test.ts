import { describe, it, expect } from 'vitest';
import { buildVarPayload, planMasters } from '../../src/export/variable/masters';
import { newProject, DEFAULT_DNA } from '../../src/core/glyph';
import type { Glyph } from '../../src/core/glyph';
import { signedArea } from '../../src/core/geometry';

function project() {
  const p = newProject('VarTest');
  const n: Glyph = { char: 'n', unicode: 110, advance: 560, source: 'drawn', kind: 'stroke', strokes: [
    { id: 'a', cap: 'round', points: [{ x: 100, y: 0, w: 40 }, { x: 100, y: 500, w: 40 }] },
    { id: 'b', cap: 'round', points: [{ x: 100, y: 350, w: 40 }, { x: 250, y: 520, w: 40 }, { x: 420, y: 350, w: 40 }, { x: 420, y: 0, w: 40 }] },
  ] };
  const o: Glyph = { char: 'o', unicode: 111, advance: 560, source: 'imported', kind: 'outline', contours: [
    { points: [[60, 0], [500, 0], [500, 500], [60, 500]] }, { points: [[150, 90], [150, 410], [410, 410], [410, 90]] },
  ] };
  p.glyphs = { n, o };
  return p;
}

describe('variable masters', () => {
  it('plans a star designspace around the current DNA', () => {
    const plan = planMasters({ ...DEFAULT_DNA, weight: 0.25 }, ['wght', 'WOBL']);
    expect(plan.axes.map((a) => a.tag)).toEqual(['wght', 'WOBL']);
    expect(plan.axes[0].default).toBe(600);
    expect(plan.locations).toHaveLength(4); // default, wght min, wght max, WOBL max
    expect(plan.dnaFor({ wght: 900, WOBL: 0 }).weight).toBeCloseTo(1);
    expect(plan.dnaFor({ wght: 500, WOBL: 100 }).wobble).toBeCloseTo(1);
  });
  it('produces point-compatible masters for stroke and outline glyphs across all axes', () => {
    const payload = buildVarPayload(project(), ['wght', 'slnt', 'WOBL', 'MELT', 'BNCE']);
    expect(payload.masters.length).toBeGreaterThanOrEqual(6);
    for (const name of ['n', 'o']) {
      const ref = payload.masters[0].glyphs[name].contours.map((c) => c.length);
      expect(ref.length).toBeGreaterThan(0);
      for (const m of payload.masters) {
        expect(m.glyphs[name].contours.map((c) => c.length)).toEqual(ref);
        for (const c of m.glyphs[name].contours) for (const [x, y] of c) { expect(Number.isFinite(x)).toBe(true); expect(Number.isFinite(y)).toBe(true); }
      }
    }
    // heavy master has more ink than light master for the stroke glyph
    const area = (m: typeof payload.masters[0]) => m.glyphs.n.contours.reduce((a, c) => a + Math.abs(signedArea(c as any)), 0);
    const light = payload.masters.find((m) => m.location.wght === 100)!, heavy = payload.masters.find((m) => m.location.wght === 900)!;
    expect(area(heavy)).toBeGreaterThan(area(light));
    expect(payload.glyphOrder).toEqual(['.notdef', 'space', 'n', 'o']);
    expect(payload.unicodes.n).toBe(110);
  });
});
