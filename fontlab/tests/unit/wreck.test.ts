import { describe, it, expect } from 'vitest';
import { WRECK_OPS, WRECK_DEFS } from '../../src/fx/ops/wreck';
import { glyphRng } from '../../src/core/prng';
import { bboxContours } from '../../src/core/geometry';
import { inkArea } from '../../src/dna/util';
import { unionContours } from '../../src/outline/union';
import { DEFAULT_METRICS, type Contour, type Glyph } from '../../src/core/glyph';
import type { FxCtx } from '../../src/fx/types';

const glyph: Glyph = { char: 'H', unicode: 72, advance: 600, source: 'drawn', kind: 'stroke', strokes: [
  { id: 'a', cap: 'flat', points: [{ x: 100, y: 0, w: 40 }, { x: 100, y: 700, w: 40 }] }] };
const ctx = (seed = 1): FxCtx => ({ rng: glyphRng(seed, 'H', 'layer-1'), metrics: DEFAULT_METRICS, glyph, time: 0 });

const rect: Contour[] = [{ points: [[100, 0], [400, 0], [400, 700], [100, 700]] }];
const box = (x0: number, y0: number, x1: number, y1: number): Contour => ({ points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });
const H: Contour[] = unionContours([box(60, 0, 140, 700), box(460, 0, 540, 700), box(140, 310, 460, 390)]);
const defaults = (key: string) => Object.fromEntries(WRECK_DEFS[key].params.map((p) => [p.key, p.default]));
const finite = (cs: Contour[]) => cs.every((c) => c.points.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])));
const { echo, slice, holes, spikes, gridSnap, crush } = WRECK_OPS;

describe('wreck ops', () => {
  it('defs and ops agree', () => {
    expect(Object.keys(WRECK_DEFS).sort()).toEqual(Object.keys(WRECK_OPS).sort());
    for (const d of Object.values(WRECK_DEFS)) for (const p of d.params) { expect(p.default).toBeGreaterThanOrEqual(p.min); expect(p.default).toBeLessThanOrEqual(p.max); }
  });

  it('echo grows area and never returns empty', () => {
    for (const src of [rect, H]) {
      const out = echo(src, { copies: 3, dx: 18, dy: -12 }, ctx());
      expect(out.length).toBeGreaterThan(0);
      expect(inkArea(out)).toBeGreaterThan(inkArea(src));
    }
    expect(echo(rect, { copies: 3, dx: 0, dy: 0 }, ctx())).toBe(rect);
  });

  it('slice keeps area within 5 % and returns at least one contour', () => {
    for (const src of [rect, H]) {
      const out = slice(src, { strips: 6, shift: 30 }, ctx());
      expect(out.length).toBeGreaterThanOrEqual(1);
      expect(Math.abs(inkArea(out) - inkArea(src)) / inkArea(src)).toBeLessThan(0.05);
    }
  });

  it('holes shrinks area at amount 1, never empties, amount 0 is identity', () => {
    for (const src of [rect, H]) {
      const out = holes(src, { amount: 1, size: 40 }, ctx());
      expect(out.length).toBeGreaterThan(0);
      expect(inkArea(out)).toBeGreaterThan(0);
      expect(inkArea(out)).toBeLessThan(inkArea(src));
    }
    expect(holes(rect, { amount: 0, size: 40 }, ctx())).toBe(rect);
  });

  it('holes: same seed identical, different seed different', () => {
    const a = holes(H, { amount: 0.5, size: 40 }, ctx(7));
    const b = holes(H, { amount: 0.5, size: 40 }, ctx(7));
    const c = holes(H, { amount: 0.5, size: 40 }, ctx(8));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });

  it('spikes grows area and is seeded', () => {
    for (const src of [rect, H]) {
      const out = spikes(src, { amount: 0.4, length: 60 }, ctx());
      expect(out.length).toBeGreaterThan(0);
      expect(inkArea(out)).toBeGreaterThan(inkArea(src));
    }
    expect(JSON.stringify(spikes(H, { amount: 0.4, length: 60 }, ctx(3)))).toBe(JSON.stringify(spikes(H, { amount: 0.4, length: 60 }, ctx(3))));
    expect(spikes(rect, { amount: 0, length: 60 }, ctx())).toBe(rect);
  });

  it('gridSnap puts every coordinate on the grid', () => {
    for (const cell of [40, 30, 12]) for (const src of [rect, H]) {
      const out = gridSnap(src, { cell }, ctx());
      expect(out.length).toBeGreaterThan(0);
      expect(inkArea(out)).toBeGreaterThan(0);
      for (const c of out) for (const p of c.points) {
        expect(Math.abs(p[0] / cell - Math.round(p[0] / cell))).toBeLessThan(1e-6);
        expect(Math.abs(p[1] / cell - Math.round(p[1] / cell))).toBeLessThan(1e-6);
      }
    }
  });

  it('crush lowers the bbox height and keeps at least one contour', () => {
    for (const src of [rect, H]) {
      const out = crush(src, { amount: 0.5 }, ctx());
      expect(out.length).toBeGreaterThanOrEqual(1);
      const b0 = bboxContours(src), b1 = bboxContours(out);
      expect(b1.maxY - b1.minY).toBeLessThan(b0.maxY - b0.minY);
      expect(inkArea(out)).toBeGreaterThan(0);
    }
    expect(crush(rect, { amount: 0 }, ctx())).toBe(rect);
  });

  it('every op with defaults on the H returns finite coordinates and positive area', () => {
    for (const key of Object.keys(WRECK_OPS)) {
      const out = WRECK_OPS[key](H, defaults(key), ctx(5));
      expect(out.length, key).toBeGreaterThan(0);
      expect(finite(out), key).toBe(true);
      expect(inkArea(out), key).toBeGreaterThan(0);
    }
  });
});
