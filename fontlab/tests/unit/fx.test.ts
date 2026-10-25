import { describe, it, expect } from 'vitest';
import { applyStack, migrateDna, stackToDna, newStack, newLayer, newGroup, isIdentityStack, advanceAfterStack, ensureLayer, mutateStack } from '../../src/fx/stack';
import { FX, FX_DEFS, defaultParams } from '../../src/fx/registry';
import { PRESETS } from '../../src/fx/presets';
import { applyDna } from '../../src/dna';
import { glyphToContours } from '../../src/outline';
import { DEFAULT_METRICS, DEFAULT_DNA, type Glyph } from '../../src/core/glyph';
import { signedArea } from '../../src/core/geometry';
import { parseProject } from '../../src/project/schema';
import { newProject } from '../../src/core/glyph';

const n: Glyph = { char: 'n', unicode: 110, advance: 560, source: 'drawn', kind: 'stroke', strokes: [
  { id: 'a', cap: 'round', points: [{ x: 100, y: 0, w: 40 }, { x: 100, y: 500, w: 40 }] },
  { id: 'b', cap: 'round', points: [{ x: 100, y: 350, w: 40 }, { x: 250, y: 520, w: 40 }, { x: 420, y: 350, w: 40 }, { x: 420, y: 0, w: 40 }] },
] };
const box: Glyph = { char: 'o', unicode: 111, advance: 560, source: 'imported', kind: 'outline', contours: [
  { points: [[60, 0], [500, 0], [500, 500], [60, 500]] }, { points: [[150, 90], [150, 410], [410, 410], [410, 90]] } ] };
const area = (cs: { points: [number, number][] }[]) => cs.reduce((a, c) => a + signedArea(c.points), 0);
const M = DEFAULT_METRICS;

describe('effect stack', () => {
  it('identity stack equals plain contours', () => {
    expect(isIdentityStack(newStack())).toBe(true);
    expect(applyStack(n, newStack(), M)).toEqual(glyphToContours(n));
  });
  it('migrated DNA reproduces the legacy pipeline for a single op', () => {
    const dna = { ...DEFAULT_DNA, melt: 0.6, seed: 3 };
    const stack = migrateDna(dna);
    expect(stack.groups[0].layers.map((l) => l.type)).toEqual(['melt']);
    // legacy ops are seeded by op name, stack layers by layer id; compare ink area instead of exact points
    const a = area(applyStack(n, stack, M)), b = area(applyDna(n, dna, M));
    expect(Math.abs(a - b) / b).toBeLessThan(0.15);
    expect(stackToDna(stack)).toEqual(dna);
  });
  it('every registered effect runs on stroke and outline glyphs and returns finite, inked contours', () => {
    for (const def of FX_DEFS) {
      const s = newStack(5); s.groups[0].layers = [newLayer(def.type)];
      for (const g of [n, box]) {
        const cs = applyStack(g, s, M);
        expect(cs.length, def.type).toBeGreaterThan(0);
        for (const c of cs) for (const p of c.points) { expect(Number.isFinite(p[0])).toBe(true); expect(Number.isFinite(p[1])).toBe(true); }
        expect(area(cs), def.type).toBeGreaterThan(0);
      }
    }
  });
  it('layer order matters and a skeleton op after an outline op uses its contour form', () => {
    const a = newStack(1); a.groups[0].layers = [newLayer('inflate', { amount: 0.5 }), newLayer('erode', { amount: 0.5 })];
    const b = newStack(1); b.groups[0].layers = [newLayer('erode', { amount: 0.5 }), newLayer('inflate', { amount: 0.5 })];
    expect(JSON.stringify(applyStack(n, a, M))).not.toBe(JSON.stringify(applyStack(n, b, M)));
    const c = newStack(1); c.groups[0].layers = [newLayer('inflate', { amount: 0.3 }), newLayer('slant', { amount: 1 })];
    const cs = applyStack(n, c, M);
    const top = Math.max(...cs.flatMap((k) => k.points.map((p) => p[1])));
    const topX = cs.flatMap((k) => k.points).filter((p) => p[1] > top - 30).map((p) => p[0]);
    const botX = cs.flatMap((k) => k.points).filter((p) => p[1] < 30).map((p) => p[0]);
    expect(Math.max(...topX)).toBeGreaterThan(Math.max(...botX));
  });
  it('a subtract group makes a hollow ring (fat minus original)', () => {
    const s = newStack(2);
    s.groups[0].layers = [newLayer('inflate', { amount: 0.6 })];
    const g = newGroup('subtract'); g.layers = []; s.groups.push(g);
    const cs = applyStack(n, s, M);
    expect(cs.some((c) => signedArea(c.points) < 0)).toBe(true); // holes exist
    expect(area(cs)).toBeLessThan(area(applyStack(n, { ...s, groups: [s.groups[0]] }, M)));
    const inter = { ...s, groups: [s.groups[0], { ...g, op: 'intersect' as const }] };
    expect(Math.abs(area(applyStack(n, inter, M)) - area(glyphToContours(n))) / area(glyphToContours(n))).toBeLessThan(0.1);
  });
  it('is deterministic per layer id and seed; time drifts noise ops smoothly', () => {
    const s = newStack(9); s.groups[0].layers = [newLayer('wobble', { amount: 0.6 })];
    expect(JSON.stringify(applyStack(n, s, M))).toBe(JSON.stringify(applyStack(n, JSON.parse(JSON.stringify(s)), M)));
    expect(JSON.stringify(applyStack(n, { ...s, seed: 10 }, M))).not.toBe(JSON.stringify(applyStack(n, s, M)));
    const ink = newStack(9); ink.groups[0].layers = [newLayer('inkNoise')];
    expect(JSON.stringify(applyStack(n, { ...ink, time: 0.5 }, M))).not.toBe(JSON.stringify(applyStack(n, ink, M)));
  });
  it('advance follows weight/inflate/jitter in the base group only', () => {
    const s = newStack(1); s.groups[0].layers = [newLayer('weight', { amount: 1 }), newLayer('inflate', { amount: 0.5 })];
    expect(advanceAfterStack(n, s)).toBe(560 + 60 + 40);
    const g = newGroup('union'); g.layers = [newLayer('inflate', { amount: 1 })]; s.groups.push(g);
    expect(advanceAfterStack(n, s)).toBe(560 + 60 + 40);
  });
  it('presets build valid stacks and all run', () => {
    for (const [name, build] of Object.entries(PRESETS)) {
      const s = build(4);
      for (const g of s.groups) for (const l of g.layers) { expect(FX[l.type], `${name}:${l.type}`).toBeTruthy(); for (const k of Object.keys(l.params)) expect(k in defaultParams(l.type)).toBe(true); }
      if (name === 'Coral') continue; // slow; covered by the raster tests
      expect(applyStack(n, s, M).length, name).toBeGreaterThan(0);
    }
  });
  it('project files: old dna migrates, new fx parses and drops unknown layers', () => {
    const old = JSON.parse(JSON.stringify(newProject('x'))) as Record<string, any>;
    delete old.fx; old.dna = { ...DEFAULT_DNA, weight: 0.5, erode: 0.2, seed: 7 };
    const p = parseProject(old);
    expect(p.fx.seed).toBe(7);
    expect(p.fx.groups[0].layers.map((l) => l.type)).toEqual(['weight', 'erode']);
    const fresh = JSON.parse(JSON.stringify(newProject('y')));
    fresh.fx.groups[0].layers = [{ id: 'a', type: 'nope', enabled: true, params: {} }, { id: 'b', type: 'hollow', enabled: true, params: { inset: 30, bogus: 'x' } }];
    const q = parseProject(fresh);
    expect(q.fx.groups[0].layers.map((l) => l.type)).toEqual(['hollow']);
    expect(q.fx.groups[0].layers[0].params).toEqual({ inset: 30, inline: 0 });
  });
  it('ensureLayer and mutateStack keep params in range', () => {
    const s = newStack(1);
    const l = ensureLayer(s, 'melt'); expect(ensureLayer(s, 'melt')).toBe(l);
    s.groups[0].layers.push(newLayer('hollow'));
    for (let i = 0; i < 20; i++) mutateStack(s, 0.9);
    for (const g of s.groups) for (const x of g.layers) for (const p of FX[x.type].def.params) { expect(x.params[p.key]).toBeGreaterThanOrEqual(p.min); expect(x.params[p.key]).toBeLessThanOrEqual(p.max); }
  });
});
