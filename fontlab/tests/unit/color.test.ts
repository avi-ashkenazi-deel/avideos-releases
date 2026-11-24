import { describe, it, expect } from 'vitest';
import { DEFAULT_COLOR, DEFAULT_METRICS, type ColorSettings, type Contour, type Glyph, type Stroke, type Vec } from '../../src/core/glyph';
import { bboxContours, mapContours, pointInPolygon, signedArea } from '../../src/core/geometry';
import { glyphToContours } from '../../src/outline';
import { unionSets } from '../../src/dna/clip';
import { offsetContours } from '../../src/dna/offset';
import { colorLayers, moveColorGlyph, stripeCount, shadowOffset, outlineThickness, MAX_STROKE_LAYERS, type ColorGlyph } from '../../src/color/layers';
import { buildCpal, buildColr, colorGlyphName, planColorGlyphs, resolveColorBindings, fontGlyphNames, colorTables, parseHexColor } from '../../src/export/colr';
import { buildFont, fontToArrayBuffer, glyphName } from '../../src/export/otf';
import { injectTables, readTables } from '../../src/export/sfnt';
import { parse } from '../../src/vendor/opentype';

// ---------------------------------------------------------------- fixtures

const line = (id: string, pts: [number, number][], w = 40, cap: Stroke['cap'] = 'round'): Stroke => ({ id, cap, points: pts.map(([x, y]) => ({ x, y, w })) });
const strokeGlyph = (char: string, strokes: Stroke[], advance = 600): Glyph => ({ char, unicode: char.codePointAt(0)!, advance, source: 'drawn', kind: 'stroke', strokes });
const rect = (x0: number, y0: number, x1: number, y1: number): Contour => ({ points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });
const hole = (x0: number, y0: number, x1: number, y1: number): Contour => ({ points: [[x0, y0], [x0, y1], [x1, y1], [x1, y0]] });

/** "H": left stem, right stem, then the crossbar (drawn last) */
const H = strokeGlyph('H', [
  line('l', [[120, 0], [120, 700]]),
  line('r', [[480, 0], [480, 700]]),
  line('bar', [[120, 350], [480, 350]]),
]);
const builtOf = (g: Glyph) => ({ advance: g.advance, contours: glyphToContours(g) });
const builtH = builtOf(H);

/** outline "i": stem + dot */
const iGlyph: Glyph = { char: 'i', unicode: 105, advance: 300, source: 'imported', kind: 'outline', contours: [rect(100, 0, 200, 500), rect(100, 600, 200, 700)] };
const builtI = { advance: 300, contours: iGlyph.contours! };
/** a single rectangle */
const box: Glyph = { char: 'l', unicode: 108, advance: 300, source: 'imported', kind: 'outline', contours: [rect(100, 0, 200, 700)] };
const builtBox = { advance: 300, contours: box.contours! };

const on = (mode: ColorSettings['mode'], extra: Partial<ColorSettings> = {}): ColorSettings => ({ ...DEFAULT_COLOR, enabled: true, mode, ...extra });
const M = DEFAULT_METRICS;

const area = (cs: Contour[]) => cs.reduce((a, c) => a + signedArea(c.points), 0);
const unionArea = (c: ColorGlyph) => area(unionSets(c.layers.map((l) => l.contours)));
const closeTo = (a: number, b: number, rel = 0.01) => expect(Math.abs(a - b) / Math.abs(b)).toBeLessThan(rel);
/** nonzero-free containment for hole-consistent contours: inside an odd number of rings */
const inside = (p: Vec, cs: Contour[]) => cs.reduce((n, c) => n + (pointInPolygon(p, c.points) ? 1 : 0), 0) % 2 === 1;
/** colour seen at a point = the last layer (painted on top) containing it */
const colorAt = (c: ColorGlyph, p: Vec): number => { let col = -1; for (const l of c.layers) if (inside(p, l.contours)) col = l.color; return col; };

// ---------------------------------------------------------------- layers

describe('colorLayers: off states', () => {
  it('returns null when disabled, without ink, or with fewer than two colours', () => {
    expect(colorLayers(H, builtH, { ...DEFAULT_COLOR, enabled: false }, M, 0)).toBeNull();
    expect(colorLayers(H, { advance: 600, contours: [] }, on('strokes'), M, 0)).toBeNull();
    expect(colorLayers(H, builtH, on('strokes', { palette: ['#ff0000'] }), M, 0)).toBeNull();
    expect(colorLayers(H, builtH, on('stripes', { palette: [] }), M, 0)).toBeNull();
    for (const mode of ['strokes', 'stripes', 'shadow', 'outline'] as const) expect(colorLayers(H, builtH, on(mode), M, 0)).not.toBeNull();
  });
});

describe('moveColorGlyph', () => {
  it('shifts every layer and the fallback, and can change the advance', () => {
    const c = colorLayers(H, builtH, on('shadow'), M, 0)!;
    const m = moveColorGlyph(c, 25, -5, 700);
    expect(m.advance).toBe(700);
    expect(moveColorGlyph(c, 25).advance).toBe(c.advance);
    expect(m.layers.map((l) => l.color)).toEqual(c.layers.map((l) => l.color));
    const a = bboxContours(c.fallback), b = bboxContours(m.fallback);
    expect(b.minX).toBeCloseTo(a.minX + 25); expect(b.maxY).toBeCloseTo(a.maxY - 5);
    m.layers.forEach((l, i) => {
      expect(bboxContours(l.contours).minX).toBeCloseTo(bboxContours(c.layers[i].contours).minX + 25);
      closeTo(area(l.contours), area(c.layers[i].contours), 1e-9);
    });
    expect(bboxContours(c.layers[0].contours).minX).toBeCloseTo(bboxContours(builtH.contours).minX + shadowOffset(0.5)); // the original is untouched
  });
});

describe('colorLayers: strokes', () => {
  it('gives each drawn stroke its own colour, in drawing order, later strokes on top', () => {
    const c = colorLayers(H, builtH, on('strokes'), M, 5)!;
    expect(c.layers.map((l) => l.color)).toEqual([0, 1, 2]);
    expect(c.advance).toBe(600);
    expect(c.fallback).toHaveLength(builtH.contours.length);
    closeTo(area(c.fallback), area(builtH.contours), 1e-6);
    expect(colorAt(c, [120, 600])).toBe(0);  // left stem
    expect(colorAt(c, [480, 100])).toBe(1);  // right stem
    expect(colorAt(c, [300, 350])).toBe(2);  // crossbar
    expect(colorAt(c, [120, 350])).toBe(2);  // the crossbar was drawn last: it covers the junction
    expect(colorAt(c, [120, 420])).toBe(0);  // … but only as wide as it was drawn
    expect(colorAt(c, [300, 600])).toBe(-1); // no ink between the stems
  });
  it('partitions the built shape: the union of the layers is the built ink', () => {
    const c = colorLayers(H, builtH, on('strokes'), M, 0)!;
    closeTo(unionArea(c), area(builtH.contours));
    // every layer stays inside the silhouette
    for (const l of c.layers) closeTo(area(unionSets([builtH.contours, l.contours])), area(builtH.contours), 1e-3);
    // each layer is its own stroke: the stems run under the crossbar (no seam between layers) …
    expect(inside([120, 350], c.layers[0].contours)).toBe(true);
    expect(inside([480, 350], c.layers[1].contours)).toBe(true);
    // … without following its edges along the silhouette, and the crossbar does not spill over the stems
    expect(inside([175, 350], c.layers[0].contours)).toBe(false);
    expect(inside([175, 385], c.layers[0].contours)).toBe(false);
    expect(inside([120, 440], c.layers[2].contours)).toBe(false);
  });
  it('handles flat and tapered stroke ends', () => {
    for (const cap of ['flat', 'taper'] as const) {
      const g = strokeGlyph('H', [
        line('l', [[120, 0], [120, 700]], 40, cap),
        line('r', [[480, 0], [480, 700]], 40, cap),
        line('bar', [[120, 350], [480, 350]], 30, cap),
      ]);
      const built = builtOf(g);
      const c = colorLayers(g, built, on('strokes'), M, 0)!;
      expect(c.layers.map((l) => l.color), cap).toEqual([0, 1, 2]);
      closeTo(unionArea(c), area(built.contours));
      expect(colorAt(c, [120, 600])).toBe(0);
      expect(colorAt(c, [480, 100])).toBe(1);
      expect(colorAt(c, [300, 350])).toBe(2);
      expect(colorAt(c, [120, 395])).toBe(0); // just above the crossbar the stem shows
    }
  });
  it('cycles a short palette', () => {
    const c = colorLayers(H, builtH, on('strokes', { palette: ['#000000', '#ffffff'] }), M, 0)!;
    expect(c.layers.map((l) => l.color)).toEqual([0, 1, 0]);
  });
  it('follows a slanted build (effects move the ink away from the drawn strokes)', () => {
    const k = Math.tan((20 * Math.PI) / 180);
    const shear = (p: Vec): Vec => [p[0] + p[1] * k + 35, p[1]];
    const built = { advance: 600, contours: mapContours(builtH.contours, shear) };
    const c = colorLayers(H, built, on('strokes'), M, 0)!;
    expect(c.layers.map((l) => l.color)).toEqual([0, 1, 2]);
    closeTo(unionArea(c), area(built.contours));
    expect(colorAt(c, shear([120, 650]))).toBe(0);
    expect(colorAt(c, shear([120, 50]))).toBe(0);
    expect(colorAt(c, shear([480, 650]))).toBe(1);
    expect(colorAt(c, shear([300, 350]))).toBe(2);
    expect(colorAt(c, shear([120, 350]))).toBe(2);
    // moved ink: lower layers reach a few units under the crossbar's edge, not all the way through
    expect(inside(shear([120, 386]), c.layers[0].contours)).toBe(true);
    expect(inside(shear([120, 350]), c.layers[0].contours)).toBe(false);
  });
  it('follows a bolder and a thinner build', () => {
    for (const d of [30, -22]) {
      const built = { advance: 600, contours: offsetContours(builtH.contours, d) };
      const c = colorLayers(H, built, on('strokes'), M, 0)!;
      expect(c.layers.map((l) => l.color)).toEqual([0, 1, 2]);
      closeTo(unionArea(c), area(built.contours));
      expect(colorAt(c, [120, 600])).toBe(0);
      expect(colorAt(c, [120 + (40 + d) * 0.8, 600])).toBe(0); // the stem keeps its whole width
      expect(colorAt(c, [300, 350 + (40 + d) * 0.8])).toBe(2);  // and so does the crossbar
      expect(colorAt(c, [120, 350 + (40 + d) + 12])).toBe(0);   // without creeping up the stem
    }
  });
  it('keeps ink that no stroke ribbon reaches (it joins the nearest stroke)', () => {
    const blob = rect(700, 300, 800, 400); // far right of the right stem
    const bridge = rect(480, 330, 750, 370);
    const built = { advance: 900, contours: unionSets([builtH.contours, [blob], [bridge]]) };
    const c = colorLayers(H, built, on('strokes'), M, 0)!;
    closeTo(unionArea(c), area(built.contours));
    expect(colorAt(c, [780, 390])).toBe(1);
  });
  it('never splits parts smaller than a stroke is wide', () => {
    const dot: Contour = rect(280, 760, 320, 800); // a crumb above the crossbar, far from every stroke
    const built = { advance: 600, contours: [...builtH.contours, dot] };
    const c = colorLayers(H, built, on('strokes'), M, 0)!;
    closeTo(unionArea(c), area(built.contours));
    const owners = c.layers.filter((l) => inside([300, 780], l.contours));
    expect(owners).toHaveLength(1);
  });
  it('caps the number of layers for very long drawings', () => {
    const strokes = Array.from({ length: 30 }, (_, i) => line('s' + i, [[60 + i * 30, 0], [60 + i * 30, 700]], 18));
    const g = strokeGlyph('m', strokes, 1100);
    const built = builtOf(g);
    const c = colorLayers(g, built, on('strokes'), M, 0)!;
    expect(c.layers.length).toBe(MAX_STROKE_LAYERS);
    closeTo(unionArea(c), area(built.contours));
    expect(c.layers.every((l) => l.color >= 0 && l.color < 4)).toBe(true);
  });
  it('splits letters without strokes by connected part, cycling from the letter index', () => {
    const c = colorLayers(iGlyph, builtI, on('strokes'), M, 2)!;
    expect(c.layers).toHaveLength(2);
    expect(c.layers.map((l) => l.color)).toEqual([2, 3]);
    expect(colorAt(c, [150, 650])).not.toBe(colorAt(c, [150, 250]));
    closeTo(unionArea(c), area(builtI.contours));
    // no source glyph at all behaves the same
    expect(colorLayers(undefined, builtI, on('strokes'), M, 2)!.layers.map((l) => l.color)).toEqual([2, 3]);
  });
  it('gives a one-part letter one colour that changes with its position in the charset', () => {
    const cols = [0, 1, 2, 3, 4, 5].map((i) => {
      const c = colorLayers(box, builtBox, on('strokes'), M, i)!;
      expect(c.layers).toHaveLength(1);
      return c.layers[0].color;
    });
    expect(cols).toEqual([0, 1, 2, 3, 0, 1]);
    // a single-stroke letter too
    const l = strokeGlyph('l', [line('s', [[150, 0], [150, 700]])], 300);
    expect(colorLayers(l, builtOf(l), on('strokes'), M, 3)!.layers.map((x) => x.color)).toEqual([3]);
  });
  it('keeps holes with their part and merges many parts into at most one layer per colour', () => {
    const o = { advance: 700, contours: [rect(100, 0, 600, 700), hole(200, 100, 500, 600)] };
    const c = colorLayers(undefined, o, on('strokes'), M, 1)!;
    expect(c.layers).toHaveLength(1);
    expect(c.layers[0].contours).toHaveLength(2);
    closeTo(area(c.layers[0].contours), 500 * 700 - 300 * 500);
    const dots = { advance: 700, contours: Array.from({ length: 40 }, (_, i) => rect(20 + i * 16, 0, 30 + i * 16, 10 + i)) };
    const d = colorLayers(undefined, dots, on('strokes'), M, 0)!;
    expect(d.layers).toHaveLength(4);
    expect(d.layers.reduce((n, l) => n + l.contours.length, 0)).toBe(40);
  });
});

describe('colorLayers: stripes', () => {
  it('cuts horizontal bands that add up to the built ink', () => {
    for (const amount of [0, 0.5, 1]) {
      const c = colorLayers(H, builtH, on('stripes', { amount }), M, 0)!;
      closeTo(unionArea(c), area(builtH.contours));
      expect(c.advance).toBe(600);
      expect(c.layers.length).toBeLessThanOrEqual(4);
      expect(new Set(c.layers.map((l) => l.color)).size).toBe(c.layers.length);
    }
    expect([0, 0.5, 1].map(stripeCount)).toEqual([2, 7, 12]);
  });
  it('uses one grid for every letter: band k (from the ascender) takes colour k mod n', () => {
    const amount = 0.5, n = 4;
    const h = (M.ascender - M.descender) / stripeCount(amount);
    const want = (y: number) => Math.floor((M.ascender - y) / h) % n;
    const cH = colorLayers(H, builtH, on('stripes', { amount }), M, 0)!;
    const cI = colorLayers(iGlyph, builtI, on('stripes', { amount }), M, 7)!;
    for (const y of [20, 130, 260, 345, 410, 520, 640, 690]) {
      expect(colorAt(cH, [120, y]), `H at y=${y}`).toBe(want(y));
      if (y < 500 || y > 600) expect(colorAt(cI, [150, y]), `i at y=${y}`).toBe(want(y));
    }
    // two colours only
    const c2 = colorLayers(H, builtH, on('stripes', { amount: 0, palette: ['#111111', '#eeeeee'] }), M, 0)!;
    expect(colorAt(c2, [120, 600])).toBe(0);
    expect(colorAt(c2, [120, 100])).toBe(1);
  });
  it('keeps ink above the ascender and below the descender', () => {
    const tall = { advance: 300, contours: [rect(100, -400, 200, 1100)] };
    const c = colorLayers(undefined, tall, on('stripes'), M, 0)!;
    closeTo(unionArea(c), 100 * 1500);
  });
});

describe('colorLayers: shadow', () => {
  it('puts a shifted copy (colour 1) under the letter (colour 0) and widens the advance', () => {
    for (const amount of [0, 0.5, 1]) {
      const d = shadowOffset(amount);
      expect(d).toBeCloseTo(10 + amount * 70);
      const c = colorLayers(H, builtH, on('shadow', { amount }), M, 0)!;
      expect(c.layers.map((l) => l.color)).toEqual([1, 0]);
      expect(c.advance).toBeCloseTo(600 + d);
      const top = bboxContours(c.layers[1].contours), cast = bboxContours(c.layers[0].contours), b = bboxContours(builtH.contours);
      expect(top).toEqual(b);
      expect(cast.minX).toBeCloseTo(b.minX + d); expect(cast.maxX).toBeCloseTo(b.maxX + d);
      expect(cast.minY).toBeCloseTo(b.minY - d); expect(cast.maxY).toBeCloseTo(b.maxY - d);
      closeTo(area(c.layers[0].contours), area(builtH.contours), 1e-6);
      // fallback = both layers together (it is also the bounding box renderers clip to)
      closeTo(area(c.fallback), unionArea(c), 1e-6);
      const f = bboxContours(c.fallback);
      expect(f.minX).toBeCloseTo(b.minX); expect(f.maxX).toBeCloseTo(b.maxX + d);
      expect(f.minY).toBeCloseTo(b.minY - d); expect(f.maxY).toBeCloseTo(b.maxY);
    }
  });
});

describe('colorLayers: outline', () => {
  it('puts a rim (colour 1) under the letter (colour 0), shifted right so it clears the left sidebearing', () => {
    for (const amount of [0, 0.5, 1]) {
      const t = outlineThickness(amount);
      expect(t).toBeCloseTo(8 + amount * 40);
      const c = colorLayers(H, builtH, on('outline', { amount }), M, 0)!;
      expect(c.layers.map((l) => l.color)).toEqual([1, 0]);
      expect(c.advance).toBeCloseTo(600 + 2 * t);
      const b = bboxContours(builtH.contours), rim = bboxContours(c.layers[0].contours), top = bboxContours(c.layers[1].contours);
      expect(top.minX).toBeCloseTo(b.minX + t); expect(top.maxX).toBeCloseTo(b.maxX + t);
      expect(top.minY).toBeCloseTo(b.minY); expect(top.maxY).toBeCloseTo(b.maxY);
      expect(Math.abs(rim.minX - b.minX)).toBeLessThan(1.5);          // left edge where the letter's used to be
      expect(Math.abs(rim.maxX - (b.maxX + 2 * t))).toBeLessThan(1.5);
      expect(Math.abs(rim.minY - (b.minY - t))).toBeLessThan(1.5);
      expect(Math.abs(rim.maxY - (b.maxY + t))).toBeLessThan(1.5);
      expect(area(c.layers[0].contours)).toBeGreaterThan(area(builtH.contours) * 1.1);
      // the rim contains the letter, and is the fallback shape
      closeTo(unionArea(c), area(c.layers[0].contours), 1e-3);
      closeTo(area(c.fallback), area(c.layers[0].contours), 1e-6);
      expect(colorAt(c, [120 + t, 600])).toBe(0);
      expect(colorAt(c, [120 + t - 40 - t / 2, 600])).toBe(1);
    }
  });
});

describe('colorLayers: letters made of many small parts', () => {
  // a field of 60 dots, 22 units across, 34 apart (what a stipple effect leaves)
  const dot = (cx: number, cy: number): Contour => ({ points: Array.from({ length: 12 }, (_, i) => [cx + Math.cos((i / 12) * 2 * Math.PI) * 11, cy + Math.sin((i / 12) * 2 * Math.PI) * 11] as Vec) });
  const dots = { advance: 500, contours: Array.from({ length: 60 }, (_, i) => dot(80 + (i % 6) * 34, 20 + Math.floor(i / 6) * 68 + (i % 2) * 9)) };
  it('outline: the rim is the round offset of every dot', () => {
    const c = colorLayers(undefined, dots, on('outline', { amount: 0.5 }), M, 0)!;
    const t = outlineThickness(0.5);
    const want = offsetContours(dots.contours, t);
    closeTo(area(c.layers[0].contours), area(want), 0.02);
    const b = bboxContours(dots.contours), rim = bboxContours(c.layers[0].contours);
    expect(Math.abs(rim.minX - b.minX)).toBeLessThan(1.5);
    expect(Math.abs(rim.maxX - (b.maxX + 2 * t))).toBeLessThan(1.5);
    expect(Math.abs(rim.maxY - (b.maxY + t))).toBeLessThan(1.5);
    expect(c.layers[1].contours).toHaveLength(60);
    closeTo(unionArea(c), area(c.layers[0].contours), 1e-3); // the rim contains every dot
    expect(c.layers[0].contours.every((k) => k.points.every((q) => Number.isFinite(q[0]) && Number.isFinite(q[1])))).toBe(true);
  });
  it('stripes: dots inside a band keep their shape, dots on a band edge are cut', () => {
    const c = colorLayers(undefined, dots, on('stripes', { amount: 0.5 }), M, 0)!;
    closeTo(unionArea(c), area(dots.contours));
    const h = (M.ascender - M.descender) / stripeCount(0.5);
    for (const k of dots.contours) {
      const [x, y] = [k.points.reduce((a, q) => a + q[0], 0) / 12, k.points.reduce((a, q) => a + q[1], 0) / 12];
      expect(colorAt(c, [x, y])).toBe(Math.floor((M.ascender - y) / h) % 4);
    }
  });
  it('shadow and strokes keep every dot', () => {
    const sh = colorLayers(undefined, dots, on('shadow'), M, 0)!;
    expect(sh.layers.map((l) => l.contours.length)).toEqual([60, 60]);
    closeTo(area(sh.fallback), unionArea(sh), 1e-6);
    const st = colorLayers(undefined, dots, on('strokes'), M, 0)!;
    expect(st.layers.reduce((n, l) => n + l.contours.length, 0)).toBe(60);
    // with strokes underneath, each dot goes whole to the stroke it sits on
    const g = strokeGlyph('n', [line('a', [[80, 0], [80, 700]]), line('b', [[250, 0], [250, 700]])], 500);
    const sg = colorLayers(g, dots, on('strokes'), M, 0)!;
    expect(sg.layers.map((l) => l.color)).toEqual([0, 1]);
    expect(sg.layers.reduce((n, l) => n + l.contours.length, 0)).toBe(60);
    expect(colorAt(sg, [80, 20])).toBe(0);
    expect(colorAt(sg, [250, 20])).toBe(1);
  });
});

// ---------------------------------------------------------------- tables

function parseCpalBytes(u8: Uint8Array) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const version = dv.getUint16(0), numPaletteEntries = dv.getUint16(2), numPalettes = dv.getUint16(4), numColorRecords = dv.getUint16(6), offset = dv.getUint32(8);
  const indices = Array.from({ length: numPalettes }, (_, i) => dv.getUint16(12 + i * 2));
  const colors = Array.from({ length: numColorRecords }, (_, i) => ({ b: u8[offset + i * 4], g: u8[offset + i * 4 + 1], r: u8[offset + i * 4 + 2], a: u8[offset + i * 4 + 3] }));
  return { version, numPaletteEntries, numPalettes, numColorRecords, offset, indices, colors };
}
function parseColrBytes(u8: Uint8Array) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const version = dv.getUint16(0), numBase = dv.getUint16(2), baseOffset = dv.getUint32(4), layerOffset = dv.getUint32(8), numLayers = dv.getUint16(12);
  const bases = Array.from({ length: numBase }, (_, i) => ({ glyph: dv.getUint16(baseOffset + i * 6), first: dv.getUint16(baseOffset + i * 6 + 2), count: dv.getUint16(baseOffset + i * 6 + 4) }));
  const layers = Array.from({ length: numLayers }, (_, i) => ({ glyph: dv.getUint16(layerOffset + i * 4), color: dv.getUint16(layerOffset + i * 4 + 2) }));
  return { version, baseOffset, layerOffset, bases, layers, length: u8.length };
}

describe('CPAL', () => {
  it('writes a version 0 table with one palette of BGRA records', () => {
    const t = parseCpalBytes(buildCpal(['#ff3b3b', '#0a84ff', '#FFD166', '#3c7']));
    expect(t).toMatchObject({ version: 0, numPaletteEntries: 4, numPalettes: 1, numColorRecords: 4, offset: 14, indices: [0] });
    expect(t.colors).toEqual([
      { r: 0xff, g: 0x3b, b: 0x3b, a: 255 },
      { r: 0x0a, g: 0x84, b: 0xff, a: 255 },
      { r: 0xff, g: 0xd1, b: 0x66, a: 255 },
      { r: 0x33, g: 0xcc, b: 0x77, a: 255 },
    ].map(({ r, g, b, a }) => ({ b, g, r, a })));
    expect(buildCpal(['#000000', '#ffffff']).length).toBe(14 + 8);
    expect(parseHexColor('nonsense')).toEqual([0, 0, 0]);
    expect(parseHexColor('0A84ff')).toEqual([10, 132, 255]);
  });
});

describe('COLR', () => {
  it('writes sorted base glyph records with contiguous layers', () => {
    const bytes = buildColr([
      { glyph: 9, layers: [{ glyph: 20, color: 1 }, { glyph: 21, color: 0 }] },
      { glyph: 3, layers: [{ glyph: 30, color: 2 }, { glyph: 31, color: 3 }, { glyph: 32, color: 0 }] },
      { glyph: 5, layers: [] },                          // nothing to paint: skipped
      { glyph: 3, layers: [{ glyph: 99, color: 0 }] },  // duplicate base: first wins
    ]);
    const t = parseColrBytes(bytes);
    expect(t.version).toBe(0);
    expect(t.baseOffset).toBe(14);
    expect(t.layerOffset).toBe(14 + 2 * 6);
    expect(t.length).toBe(14 + 2 * 6 + 5 * 4);
    expect(t.bases).toEqual([{ glyph: 3, first: 0, count: 3 }, { glyph: 9, first: 3, count: 2 }]);
    expect(t.layers).toEqual([{ glyph: 30, color: 2 }, { glyph: 31, color: 3 }, { glyph: 32, color: 0 }, { glyph: 20, color: 1 }, { glyph: 21, color: 0 }]);
    expect(() => buildColr([{ glyph: 70000, layers: [{ glyph: 1, color: 0 }] }])).toThrow();
    expect(parseColrBytes(buildColr([])).bases).toEqual([]);
  });
});

describe('colour glyph planning', () => {
  it('names layer glyphs and binds them to their base glyph', () => {
    expect(colorGlyphName('A', 0)).toBe('A.color0');
    expect(colorGlyphName('a.ss01', 2)).toBe('a.ss01.color2');
    const cH = colorLayers(H, builtH, on('shadow'), M, 0)!;
    const cI = colorLayers(iGlyph, builtI, on('shadow'), M, 1)!;
    const plan = planColorGlyphs([{ name: 'H', advance: 600, color: cH }, { name: 'i', advance: 300, color: cI }]);
    expect(plan.extraGlyphs.map((g) => g.name)).toEqual(['H.color0', 'H.color1', 'i.color0', 'i.color1']);
    expect(plan.extraGlyphs.map((g) => g.advance)).toEqual([cH.advance, cH.advance, cI.advance, cI.advance]);
    expect(plan.extraGlyphs[0].contours).toBe(cH.layers[0].contours);
    expect(plan.bindings).toEqual([
      { base: 'H', layers: [{ name: 'H.color0', color: 1 }, { name: 'H.color1', color: 0 }] },
      { base: 'i', layers: [{ name: 'i.color0', color: 1 }, { name: 'i.color1', color: 0 }] },
    ]);
    const names = ['.notdef', 'space', 'H', 'i', 'H.color0', 'H.color1', 'i.color0'];
    // 'i.color1' is missing from the font: that letter stays plain
    expect(resolveColorBindings(plan.bindings, names)).toEqual([{ glyph: 2, layers: [{ glyph: 4, color: 1 }, { glyph: 5, color: 0 }] }]);
  });
});

describe('colour font end to end', () => {
  const settings = on('strokes');
  const letters = [
    { g: H, built: builtH },
    { g: iGlyph, built: builtI },
    { g: box, built: builtBox },
  ];
  const make = (s: ColorSettings) => {
    const colored = letters.map(({ g, built }, i) => ({ g, built, color: colorLayers(g, built, s, M, i)! }));
    const plan = planColorGlyphs(colored.map(({ g, built, color }) => ({ name: glyphName(g.char, g.unicode), advance: built.advance, color })));
    const font = buildFont(
      colored.map(({ g, color }) => ({ char: g.char, unicode: g.unicode, advance: color.advance, contours: color.fallback })),
      { familyName: 'Color Test', metrics: M, features: { extraGlyphs: plan.extraGlyphs } },
    );
    const tables = colorTables(font, plan.bindings, s.palette)!;
    return { colored, plan, font, tables, otf: injectTables(fontToArrayBuffer(font), tables) };
  };

  it('adds COLR and CPAL to a font that still parses', () => {
    const { colored, plan, font, tables, otf } = make(settings);
    const tags = readTables(otf).tables.map((t) => t.tag);
    expect(tags).toContain('COLR');
    expect(tags).toContain('CPAL');
    const names = fontGlyphNames(font);
    expect(names.slice(0, 5)).toEqual(['.notdef', 'space', 'H', 'i', 'l']);
    expect(names.slice(5)).toEqual(plan.extraGlyphs.map((g) => g.name));

    // our own reading of the bytes
    const colr = parseColrBytes(tables.COLR);
    expect(colr.bases.map((b) => b.glyph)).toEqual([2, 3, 4]);
    expect(colr.bases.map((b) => b.count)).toEqual(colored.map((c) => c.color.layers.length));
    colr.bases.forEach((b, k) => {
      const want = colored[k].color.layers.map((l, i) => ({ glyph: names.indexOf(colorGlyphName(names[b.glyph], i)), color: l.color }));
      expect(colr.layers.slice(b.first, b.first + b.count)).toEqual(want);
    });
    expect(parseCpalBytes(tables.CPAL).numPaletteEntries).toBe(settings.palette.length);

    // opentype.js reads the same thing
    const f = parse(otf);
    expect(f.tables.colr.version).toBe(0);
    expect(f.tables.colr.baseGlyphRecords).toHaveLength(3);
    expect(f.tables.cpal.numPaletteEntries).toBe(4);
    expect(f.palettes.getAll()).toEqual([settings.palette.map((c) => c.toLowerCase() + 'ff')]);
    const hId = f.charToGlyphIndex('H');
    const hLayers = f.layers.get(hId);
    expect(hLayers.map((l: any) => l.paletteIndex)).toEqual([0, 1, 2]);
    expect(hLayers.map((l: any) => l.glyph.name ?? names[l.glyph.index])).toEqual(['H.color0', 'H.color1', 'H.color2']);
    expect(hLayers.every((l: any) => l.glyph.advanceWidth === 600)).toBe(true);
    expect(f.layers.get(f.charToGlyphIndex('i')).map((l: any) => l.paletteIndex)).toEqual([1, 2]);
    expect(f.layers.get(f.charToGlyphIndex('l')).map((l: any) => l.paletteIndex)).toEqual([2]);
    expect(f.layers.get(1)).toEqual([]); // space has no colour layers
    // layer outlines survive: the three H layers together cover the H
    for (const l of hLayers) expect(l.glyph.path.commands.length).toBeGreaterThan(3);
  });

  it('widens the base glyph for shadow and outline, layers included', () => {
    for (const mode of ['shadow', 'outline'] as const) {
      const s = on(mode, { amount: 0.5 });
      const { otf } = make(s);
      const f = parse(otf);
      const extra = mode === 'shadow' ? shadowOffset(0.5) : 2 * outlineThickness(0.5);
      const base = f.charToGlyph('H');
      expect(base.advanceWidth).toBe(Math.round(600 + extra));
      const layers = f.layers.get(base.index);
      expect(layers.map((l: any) => l.paletteIndex)).toEqual([1, 0]);
      expect(layers.every((l: any) => l.glyph.advanceWidth === base.advanceWidth)).toBe(true);
      // the base outline (fallback) bounds every layer
      const bb = base.getBoundingBox();
      for (const l of layers) {
        const lb = l.glyph.getBoundingBox();
        expect(lb.x1).toBeGreaterThanOrEqual(bb.x1 - 2); expect(lb.x2).toBeLessThanOrEqual(bb.x2 + 2);
        expect(lb.y1).toBeGreaterThanOrEqual(bb.y1 - 2); expect(lb.y2).toBeLessThanOrEqual(bb.y2 + 2);
      }
    }
  });

  it('pads CPAL when a layer uses a colour beyond the palette, and reports nothing to do as null', () => {
    const font = buildFont([{ char: 'H', unicode: 72, advance: 600, contours: builtH.contours }], { familyName: 'Pad', metrics: M, features: { extraGlyphs: [{ name: 'H.color0', advance: 600, contours: builtH.contours }] } });
    const t = colorTables(font, [{ base: 'H', layers: [{ name: 'H.color0', color: 5 }] }], ['#112233', '#445566'])!;
    expect(parseCpalBytes(t.CPAL).numPaletteEntries).toBe(6);
    expect(colorTables(font, [{ base: 'Q', layers: [{ name: 'Q.color0', color: 0 }] }], ['#112233', '#445566'])).toBeNull();
  });
});
