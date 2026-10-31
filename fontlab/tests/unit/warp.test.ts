import { describe, it, expect } from 'vitest';
import { WARP_OPS, WARP_DEFS, rotate, flip, perspective, twist, pinch, pull, wave, ripple, bulge, refraction, wind, curl } from '../../src/fx/ops/warp';
import { glyphRng } from '../../src/core/prng';
import { signedArea, bboxContours } from '../../src/core/geometry';
import { unionContours } from '../../src/outline/union';
import { DEFAULT_METRICS, type Contour, type Glyph } from '../../src/core/glyph';
import type { FxCtx } from '../../src/fx/types';

const H_GLYPH: Glyph = { char: 'H', unicode: 72, advance: 600, source: 'drawn', kind: 'stroke', strokes: [
  { id: 'a', cap: 'flat', points: [{ x: 120, y: 0, w: 40 }, { x: 120, y: 700, w: 40 }] },
  { id: 'b', cap: 'flat', points: [{ x: 400, y: 0, w: 40 }, { x: 400, y: 700, w: 40 }] },
  { id: 'c', cap: 'flat', points: [{ x: 120, y: 350, w: 40 }, { x: 400, y: 350, w: 40 }] }] };
const ctx = (seed = 1): FxCtx => ({ rng: glyphRng(seed, 'H', 'L1'), metrics: DEFAULT_METRICS, glyph: H_GLYPH, time: 0 });

const rect = (x0: number, y0: number, x1: number, y1: number): Contour => ({ points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });
const RECT: Contour[] = [rect(100, 0, 400, 700)];
const TRI: Contour[] = [{ points: [[100, 0], [400, 0], [100, 700]] }];
const H: Contour[] = unionContours([rect(100, 0, 140, 700), rect(380, 0, 420, 700), rect(100, 330, 420, 370)]);

const absArea = (cs: Contour[]) => cs.reduce((a, c) => a + Math.abs(signedArea(c.points)), 0);
const netArea = (cs: Contour[]) => cs.reduce((a, c) => a + signedArea(c.points), 0);
const finite = (cs: Contour[]) => cs.every((c) => c.points.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])));
const centre = (cs: Contour[]) => { const b = bboxContours(cs); return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2]; };
const defaults = (key: string) => Object.fromEntries(WARP_DEFS[key].params.map((p) => [p.key, p.default]));
const KEYS = ['rotate', 'flip', 'perspective', 'twist', 'pinch', 'pull', 'wave', 'ripple', 'bulge', 'refraction', 'wind', 'curl'];

describe('warp ops', () => {
  it('fixtures are sane: rect CCW, H unioned into one contour', () => {
    expect(signedArea(RECT[0].points)).toBeGreaterThan(0);
    expect(H).toHaveLength(1);
    expect(signedArea(H[0].points)).toBeGreaterThan(0);
  });

  it('exports all 12 ops with matching defs', () => {
    expect(Object.keys(WARP_OPS)).toEqual(KEYS);
    expect(Object.keys(WARP_DEFS)).toEqual(KEYS);
    for (const k of KEYS) for (const p of WARP_DEFS[k].params) { expect(p.default).toBeGreaterThanOrEqual(p.min); expect(p.default).toBeLessThanOrEqual(p.max); }
  });

  it('rotate 90 swaps the bbox w/h and keeps area', () => {
    const r = rotate(RECT, { degrees: 90 }, ctx());
    const b = bboxContours(r);
    expect(Math.abs(b.maxX - b.minX - 700)).toBeLessThanOrEqual(2);
    expect(Math.abs(b.maxY - b.minY - 300)).toBeLessThanOrEqual(2);
    expect(Math.abs(absArea(r) - absArea(RECT)) / absArea(RECT)).toBeLessThan(0.01);
    expect(signedArea(r[0].points)).toBeGreaterThan(0);
  });

  it('flip horizontal mirrors x about the centre and keeps positive signed area', () => {
    const f = flip(TRI, { horizontal: 1, vertical: 0 }, ctx());
    const b0 = bboxContours(TRI), b1 = bboxContours(f);
    const cx = (b0.minX + b0.maxX) / 2;
    expect(b1.minX).toBeCloseTo(2 * cx - b0.maxX, 6);
    expect(b1.maxX).toBeCloseTo(2 * cx - b0.minX, 6);
    expect(f[0].points.some((p) => p[0] === 400 && p[1] === 700)).toBe(true); // the apex (100,700) mirrored
    expect(signedArea(f[0].points)).toBeGreaterThan(0);
    const fv = flip(TRI, { horizontal: 0, vertical: 1 }, ctx());
    expect(signedArea(fv[0].points)).toBeGreaterThan(0);
    expect(bboxContours(fv).maxY).toBeCloseTo(700, 6);
    const both = flip(TRI, { horizontal: 1, vertical: 1 }, ctx());
    expect(signedArea(both[0].points)).toBeGreaterThan(0);
    expect(both[0].points.some((p) => p[0] === 400 && p[1] === 0)).toBe(true);
  });

  it('identity parameters return the same array', () => {
    expect(perspective(RECT, { amount: 0 }, ctx())).toBe(RECT);
    expect(rotate(RECT, { degrees: 0 }, ctx())).toBe(RECT);
    expect(flip(RECT, { horizontal: 0, vertical: 0 }, ctx())).toBe(RECT);
    expect(twist(RECT, { degrees: 0 }, ctx())).toBe(RECT);
    expect(pinch(RECT, { amount: 0 }, ctx())).toBe(RECT);
    expect(pull(RECT, { amount: 0 }, ctx())).toBe(RECT);
    expect(wave(RECT, { amount: 0, waves: 2 }, ctx())).toBe(RECT);
    expect(ripple(RECT, { amount: 0, waves: 2 }, ctx())).toBe(RECT);
    expect(bulge(RECT, { amount: 0 }, ctx())).toBe(RECT);
    expect(refraction(RECT, { amount: 0, bands: 5 }, ctx())).toBe(RECT);
    expect(wind(RECT, { amount: 0, gust: 0.3 }, ctx())).toBe(RECT);
    expect(curl(RECT, { degrees: 0 }, ctx())).toBe(RECT);
    for (const k of KEYS) expect(WARP_OPS[k]([], defaults(k), ctx())).toEqual([]);
  });

  it('pinch keeps the bbox height and narrows the waist', () => {
    const p = pinch(RECT, { amount: 0.5 }, ctx());
    const b0 = bboxContours(RECT), b1 = bboxContours(p);
    expect(b1.maxY - b1.minY).toBeCloseTo(b0.maxY - b0.minY, 0);
    const cy = (b0.minY + b0.maxY) / 2;
    const pts = p.flatMap((c) => c.points);
    const extent = (sel: (y: number) => boolean) => { const xs = pts.filter((q) => sel(q[1])).map((q) => q[0]); return Math.max(...xs) - Math.min(...xs); };
    const mid = extent((y) => Math.abs(y - cy) < 10), top = extent((y) => y > b0.maxY - 10);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(top);
    expect(top).toBeCloseTo(300, 0);
    // negative amount bulges instead
    const q = pinch(RECT, { amount: -0.5 }, ctx());
    const qp = q.flatMap((c) => c.points).filter((v) => Math.abs(v[1] - cy) < 10).map((v) => v[0]);
    expect(Math.max(...qp) - Math.min(...qp)).toBeGreaterThan(300);
  });

  it('pull/twist/wave/ripple/bulge/wind/curl keep |area| within 15 %, with finite coords', () => {
    const cases: [string, Contour[]][] = [
      ['pull', pull(RECT, defaults('pull'), ctx())],
      ['twist', twist(RECT, defaults('twist'), ctx())],
      ['wave', wave(RECT, defaults('wave'), ctx())],
      ['ripple', ripple(RECT, defaults('ripple'), ctx())],
      ['bulge', bulge(RECT, { amount: 0.3 }, ctx())],
      ['wind', wind(RECT, defaults('wind'), ctx())],
      ['curl', curl(RECT, defaults('curl'), ctx())],
    ];
    for (const [name, out] of cases) {
      expect(out.length, name).toBeGreaterThanOrEqual(1);
      expect(finite(out), name).toBe(true);
      expect(Math.abs(absArea(out) - absArea(RECT)) / absArea(RECT), name).toBeLessThan(0.15);
    }
  });

  it('bulge inflates for k > 0, deflates for k < 0, leaves the bbox corners in place', () => {
    const grow = bulge(RECT, { amount: 0.4 }, ctx()), shrink = bulge(RECT, { amount: -0.4 }, ctx());
    expect(absArea(grow)).toBeGreaterThan(absArea(RECT) * 1.1);
    expect(absArea(shrink)).toBeLessThan(absArea(RECT) * 0.9);
    // the bbox corners sit at r = R and are pinned; the shrunk shape stays inside the original bbox, the grown one spills past it
    for (const out of [grow, shrink]) for (const c of [[100, 0], [400, 0], [400, 700], [100, 700]]) expect(out[0].points.some((q) => Math.abs(q[0] - c[0]) < 1e-6 && Math.abs(q[1] - c[1]) < 1e-6)).toBe(true);
    const bs = bboxContours(shrink), bg = bboxContours(grow);
    expect(bs.minX).toBeCloseTo(100, 6); expect(bs.maxX).toBeCloseTo(400, 6); expect(bs.minY).toBeCloseTo(0, 6); expect(bs.maxY).toBeCloseTo(700, 6);
    expect(bg.minX).toBeLessThan(100); expect(bg.maxX).toBeGreaterThan(400); expect(bg.minY).toBeLessThan(0); expect(bg.maxY).toBeGreaterThan(700);
  });

  it('refraction returns finite contours and stair-steps the sides', () => {
    const r = refraction(RECT, { amount: 24, bands: 5 }, ctx());
    expect(r.length).toBeGreaterThanOrEqual(1);
    expect(finite(r)).toBe(true);
    const b = bboxContours(r);
    expect(b.minX).toBeCloseTo(100 - 24, 6);
    expect(b.maxX).toBeCloseTo(400 + 24, 6);
    expect(Math.abs(absArea(r) - absArea(RECT)) / absArea(RECT)).toBeLessThan(0.01);
    const rh = refraction(H, defaults('refraction'), ctx());
    expect(rh.length).toBeGreaterThanOrEqual(1);
    expect(finite(rh)).toBe(true);
  });

  it('every op with default params on the H returns ink', () => {
    for (const k of KEYS) {
      const out = WARP_OPS[k](H, defaults(k), ctx());
      expect(out.length, k).toBeGreaterThanOrEqual(1);
      expect(finite(out), k).toBe(true);
      expect(absArea(out), k).toBeGreaterThan(0);
      expect(netArea(out), k).toBeGreaterThan(0);
    }
  });

  it('every op (but rotate/curl) keeps the bbox centre within 60 units', () => {
    for (const fixture of [RECT, H]) {
      const [cx0, cy0] = centre(fixture);
      for (const k of KEYS) {
        if (k === 'rotate' || k === 'curl') continue;
        const [cx1, cy1] = centre(WARP_OPS[k](fixture, defaults(k), ctx()));
        expect(Math.hypot(cx1 - cx0, cy1 - cy0), k).toBeLessThan(60);
      }
    }
  });

  it('wind is deterministic for a given ctx and responds to the seed', () => {
    const a = wind(H, defaults('wind'), ctx(7)), b = wind(H, defaults('wind'), ctx(7));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = wind(H, defaults('wind'), ctx(8));
    expect(JSON.stringify(c)).not.toBe(JSON.stringify(a));
  });

  it('out-of-range and missing params are clamped / defaulted', () => {
    const r = rotate(RECT, { degrees: 1e9 }, ctx());
    const b = bboxContours(r);
    expect(b.maxY - b.minY).toBeCloseTo(700, 0); // clamped to 180: a half turn keeps the bbox
    expect(finite(wave(RECT, {}, ctx()))).toBe(true);
    expect(finite(refraction(RECT, { amount: 500, bands: 99 }, ctx()))).toBe(true);
  });
});
