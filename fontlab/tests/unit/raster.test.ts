import { describe, it, expect } from 'vitest';
import { rasterize, inkPixels, makeBitmap, fillInto } from '../../src/fx/raster/bitmap';
import { traceBitmap } from '../../src/fx/raster/trace';
import { blob, round, pixel, crunch, inkNoise, morph } from '../../src/fx/raster/ops';
import { reactionDiffusion } from '../../src/fx/raster/reactionDiffusion';
import { runRaster, RASTER_OPS, type RasterStep } from '../../src/fx/raster';
import { signedArea } from '../../src/core/geometry';
import { makeRng } from '../../src/core/prng';
import { glyphToContours } from '../../src/outline';
import { DEFAULT_METRICS, type Contour, type Glyph, type Vec } from '../../src/core/glyph';
import type { FxCtx } from '../../src/fx/types';

const circle = (cx: number, cy: number, r: number, n = 96, cw = false): Contour => {
  const pts: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((cw ? -i : i) / n) * Math.PI * 2;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return { points: pts };
};
const square = (x0: number, y0: number, s: number): Contour => ({ points: [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]] });

const dummyGlyph: Glyph = { char: 'a', unicode: 97, advance: 500, source: 'generated', kind: 'outline', contours: [] };
const ctxOf = (seed = 1, time = 0): FxCtx => ({ rng: makeRng(seed), metrics: DEFAULT_METRICS, glyph: dummyGlyph, time });

const totalArea = (cs: Contour[]) => cs.reduce((a, c) => a + signedArea(c.points), 0);
const finite = (cs: Contour[]) => cs.every((c) => c.points.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])));

describe('traceBitmap', () => {
  it('round-trips a 300-unit circle: 1 CCW ring, area within 3 %', () => {
    const c = circle(0, 0, 150);
    const bmp = rasterize([c], { pxPerEm: 160, pad: 80 });
    const rings = traceBitmap(bmp);
    expect(rings).toHaveLength(1);
    const a = signedArea(rings[0].points);
    expect(a).toBeGreaterThan(0);
    const expected = Math.PI * 150 * 150;
    expect(Math.abs(a - expected) / expected).toBeLessThan(0.03);
  });
  it('a ring (circle with hole) gives 2 rings with opposite signs', () => {
    const bmp = rasterize([circle(0, 0, 150), circle(0, 0, 70, 96, true)], { pxPerEm: 160 });
    const rings = traceBitmap(bmp);
    expect(rings).toHaveLength(2);
    const areas = rings.map((r) => signedArea(r.points)).sort((p, q) => q - p);
    expect(areas[0]).toBeGreaterThan(0);
    expect(areas[1]).toBeLessThan(0);
    expect(Math.abs(areas[1]) / areas[0]).toBeCloseTo((70 * 70) / (150 * 150), 1);
  });
  it('traces a 300×300 bitmap quickly', () => {
    const bmp = makeBitmap(300, 300, [0, 0], 1);
    const cs: Contour[] = [];
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) cs.push(circle(25 + i * 50, 25 + j * 50, 18));
    fillInto(bmp, cs);
    traceBitmap(bmp); // warm up
    const t0 = performance.now();
    const rings = traceBitmap(bmp);
    const ms = performance.now() - t0;
    console.log(`trace 300×300: ${ms.toFixed(2)} ms, ${rings.length} rings`);
    expect(rings).toHaveLength(36);
    expect(ms).toBeLessThan(60);
  });
  it('handles empty / tiny bitmaps', () => {
    expect(traceBitmap(makeBitmap(2, 2, [0, 0], 1))).toEqual([]);
    expect(traceBitmap(makeBitmap(1, 1, [0, 0], 1, 255)).length).toBeLessThanOrEqual(1);
  });
});

describe('raster ops', () => {
  const base = rasterize([square(0, 0, 400)], { pxPerEm: 160, pad: 120 });

  it('pixel: traced edges are axis-aligned square blocks', () => {
    const out = pixel(rasterize([circle(0, 0, 200)], { pxPerEm: 160, pad: 120 }), { size: 10 }, ctxOf());
    const vals = new Set(out.data);
    expect([...vals].every((v) => v === 0 || v === 255)).toBe(true);
    const rings = traceBitmap(out, { smooth: 0, tolerance: 0.25 });
    expect(rings.length).toBeGreaterThan(0);
    const px = 1 / out.scale;
    for (const r of rings) {
      const n = r.points.length;
      for (let i = 0; i < n; i++) {
        const a = r.points[i], b = r.points[(i + 1) % n];
        const dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]);
        if (Math.hypot(dx, dy) < px) continue; // marching-squares corner chamfers (< 1 px)
        expect(Math.min(dx, dy)).toBeLessThan(1e-6 * px);
      }
    }
  });

  it('blob merges two discs 20 px apart into one ring at blur 12', () => {
    const px = 1000 / 160;
    const r = 30 * px; // 30 px radius discs, 20 px gap
    const discs = [circle(-(r + 10 * px), 0, r), circle(r + 10 * px, 0, r)];
    const bmp = rasterize(discs, { pxPerEm: 160, pad: 200 });
    expect(traceBitmap(bmp)).toHaveLength(2);
    expect(traceBitmap(blob(bmp, { blur: 3 }, ctxOf()))).toHaveLength(2); // light blur keeps them apart
    const merged = blob(bmp, { blur: 12, threshold: 72 }, ctxOf());
    expect(traceBitmap(merged)).toHaveLength(1);
    expect(inkPixels(bmp)).toBe(inkPixels(rasterize(discs, { pxPerEm: 160, pad: 200 }))); // input untouched
  });

  it('morph: +10 grows ink, −10 shrinks it, both roughly by the perimeter band', () => {
    const n0 = inkPixels(base);
    const grown = morph(base, { amount: 10 }, ctxOf());
    const shrunk = morph(base, { amount: -10 }, ctxOf());
    expect(inkPixels(grown)).toBeGreaterThan(n0);
    expect(inkPixels(shrunk)).toBeLessThan(n0);
    const side = 400 * 0.16;
    expect(inkPixels(grown)).toBeCloseTo((side + 20) ** 2 - (4 - Math.PI) * 100, -3);
    expect(inkPixels(shrunk)).toBeCloseTo((side - 20) ** 2, -3);
    expect(inkPixels(base)).toBe(n0);
  });

  it('round on a square removes corner pixels but keeps ≥ 90 % area', () => {
    const out = round(base, { radius: 6 }, ctxOf());
    const w = base.width;
    // find the top-left ink corner of the original square
    let corner = -1;
    for (let i = 0; i < base.data.length; i++) if (base.data[i] >= 128) { corner = i; break; }
    expect(corner).toBeGreaterThanOrEqual(0);
    expect(out.data[corner]).toBe(0);
    expect(out.data[corner + 1]).toBe(0);
    expect(out.data[corner + w]).toBe(0);
    expect(inkPixels(out)).toBeGreaterThan(0.9 * inkPixels(base));
    expect(inkPixels(out)).toBeLessThan(inkPixels(base));
  });

  it('crunch and inkNoise return ≥ 1 finite ring', () => {
    const c = traceBitmap(crunch(base, {}, ctxOf()));
    expect(c.length).toBeGreaterThanOrEqual(1);
    expect(finite(c)).toBe(true);
    const n = traceBitmap(inkNoise(base, {}, ctxOf(3, 0)));
    expect(n.length).toBeGreaterThanOrEqual(1);
    expect(finite(n)).toBe(true);
  });

  it('inkNoise drifts with time and is deterministic per seed', () => {
    const a = inkNoise(base, {}, ctxOf(7, 0));
    const a2 = inkNoise(base, {}, ctxOf(7, 0));
    const b = inkNoise(base, {}, ctxOf(7, 0.5));
    expect(Buffer.from(a.data).equals(Buffer.from(a2.data))).toBe(true);
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(false);
  });

  it('ops survive tiny bitmaps and NaN params', () => {
    const tiny = makeBitmap(2, 2, [0, 0], 0.16, 255);
    const bad = { blur: NaN, radius: NaN, size: NaN, resolution: NaN, amount: NaN, softness: NaN, steps: NaN, threshold: NaN };
    for (const [name, op] of Object.entries(RASTER_OPS)) {
      const out = op(tiny, bad, ctxOf());
      expect(out.width, name).toBe(2);
      expect(out.height, name).toBe(2);
      expect(out.data.length, name).toBe(4);
    }
  });
});

describe('reactionDiffusion', () => {
  const letter = rasterize([square(0, 0, 500), circle(250, 250, 160, 64, true)], { pxPerEm: 160, pad: 150 });
  it('returns ≥ 1 ring, deterministic per seed/time, differs between seeds, fast', () => {
    reactionDiffusion(letter, {}, ctxOf(1)); // warm up JIT
    const t0 = performance.now();
    const a = reactionDiffusion(letter, {}, ctxOf(1));
    const ms = performance.now() - t0;
    console.log(`reactionDiffusion ${letter.width}×${letter.height} px, defaults: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(400);
    const rings = traceBitmap(a);
    expect(rings.length).toBeGreaterThanOrEqual(1);
    expect(finite(rings)).toBe(true);
    const a2 = reactionDiffusion(letter, {}, ctxOf(1));
    expect(Buffer.from(a.data).equals(Buffer.from(a2.data))).toBe(true);
    const b = reactionDiffusion(letter, {}, ctxOf(2));
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(false);
    const inv = reactionDiffusion(letter, { invert: 1 }, ctxOf(1));
    expect(inkPixels(inv)).toBe(a.data.length - inkPixels(a));
  });
});

describe('runRaster', () => {
  const glyph: Glyph = {
    char: 'h', unicode: 104, advance: 560, source: 'drawn', kind: 'stroke',
    strokes: [
      { id: 'a', cap: 'round', points: [{ x: 80, y: 0, w: 45 }, { x: 80, y: 700, w: 45 }] },
      { id: 'b', cap: 'round', points: [{ x: 80, y: 350, w: 45 }, { x: 250, y: 520, w: 45 }, { x: 420, y: 350, w: 45 }, { x: 420, y: 0, w: 45 }] },
    ],
  };
  const contours = glyphToContours(glyph);
  it('end-to-end returns clean contours with positive total area', () => {
    const steps: RasterStep[] = [
      { op: RASTER_OPS.blob, params: { blur: 6 }, ctx: ctxOf(1) },
      { op: RASTER_OPS.inkNoise, params: { amount: 0.5 }, ctx: ctxOf(2, 0.2) },
    ];
    const out = runRaster(contours, steps);
    expect(out.length).toBeGreaterThan(0);
    expect(finite(out)).toBe(true);
    const area = totalArea(out);
    expect(area).toBeGreaterThan(0);
    const inArea = totalArea(contours);
    expect(area).toBeGreaterThan(inArea * 0.4);
    expect(area).toBeLessThan(inArea * 2.5);
    // every output contour is non-degenerate and the outer ones are CCW
    const outers = out.filter((c) => signedArea(c.points) > 0);
    expect(outers.length).toBeGreaterThan(0);
    for (const c of out) expect(c.points.length).toBeGreaterThanOrEqual(3);
  });
  it('with no steps it round-trips the glyph', () => {
    const out = runRaster(contours, []);
    const a = totalArea(out), b = totalArea(contours);
    expect(Math.abs(a - b) / b).toBeLessThan(0.05);
    expect(runRaster([], [])).toEqual([]);
  });
});
