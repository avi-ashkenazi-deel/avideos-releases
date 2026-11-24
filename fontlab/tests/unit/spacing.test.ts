import { describe, it, expect } from 'vitest';
import { DEFAULT_METRICS, newProject, type Contour, type Glyph, type Vec } from '../../src/core/glyph';
import { glyphToContours } from '../../src/outline';
import { flattenCurves, lineSegment } from '../../src/inputs/draw/curves';
import {
  edgeProfile, inkBounds, zoneFor, stemBearing, charCase, PROFILE_SAMPLES,
  sidebearings, shiftGlyph, autoSpaceGlyph, autoSpaceProject,
  autoKern, mergeKerning, pairGap, kernClass, createProfileCache, type KernGlyph,
} from '../../src/spacing';

const M = DEFAULT_METRICS; // ascender 800, descender -200, xHeight 500, capHeight 700

// ---- synthetic shapes (contours with their left edge at x = 0) ------------------------------
const rect = (x0: number, y0: number, x1: number, y1: number): Contour => ({ points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });
const ngon = (cx: number, cy: number, r: number, n: number, cw = false): Contour => ({
  points: Array.from({ length: n }, (_, i) => {
    const a = ((cw ? -i : i) / n) * Math.PI * 2;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Vec;
  }),
});
const poly = (...pts: Vec[]): Contour => ({ points: pts });
// every letter is ONE simple polygon (glyphToContours reads overlapping outline contours as holes)
const SHAPES: Record<string, Contour[]> = {
  I: [rect(0, 0, 90, 700)],
  l: [rect(0, 0, 90, 740)],
  H: [poly([0, 0], [90, 0], [90, 305], [410, 305], [410, 0], [500, 0], [500, 700], [410, 700], [410, 395], [90, 395], [90, 700], [0, 700])],
  n: [poly([0, 0], [90, 0], [90, 410], [280, 410], [280, 0], [370, 0], [370, 500], [0, 500])],
  o: [ngon(250, 250, 250, 24), ngon(250, 250, 160, 24, true)],
  T: [poly([205, 0], [295, 0], [295, 610], [500, 610], [500, 700], [0, 700], [0, 610], [205, 610])],
  L: [poly([0, 0], [420, 0], [420, 90], [90, 90], [90, 700], [0, 700])],
  A: [poly([0, 0], [90, 0], [250, 546], [410, 0], [500, 0], [295, 700], [205, 700])],
  V: [poly([205, 0], [295, 0], [500, 700], [410, 700], [250, 154], [90, 700], [0, 700])],
  '.': [rect(0, 0, 90, 90)],
};
const outline = (ch: string, contours: Contour[], extra: Partial<Glyph> = {}): Glyph => ({
  char: ch, unicode: ch.codePointAt(0)!, advance: 600, source: 'imported', kind: 'outline', contours, ...extra,
});
const xs = (cs: Contour[]) => cs.flatMap((c) => c.points.map((p) => p[0]));
const minX = (cs: Contour[]) => Math.min(...xs(cs));
const maxX = (cs: Contour[]) => Math.max(...xs(cs));
const bearings = (ch: string, tightness = 0.5, shape = SHAPES[ch]) => {
  const p = edgeProfile(shape, M);
  return sidebearings(p, zoneFor(ch, M, p), { metrics: M, tightness });
};
/** auto-spaced, built set ready for the kerner */
function spacedSet(chars: string[], tightness = 0.5, shapeOf: (ch: string) => Contour[] = (ch) => SHAPES[ch]): Record<string, KernGlyph> {
  const out: Record<string, KernGlyph> = {};
  for (const ch of chars) {
    const g = autoSpaceGlyph(outline(ch, shapeOf(ch)), { metrics: M, tightness });
    out[ch] = { advance: g.advance, contours: glyphToContours(g) };
  }
  return out;
}

describe('edge profiles', () => {
  it('is exact for a rectangle and NaN where there is no ink', () => {
    const p = edgeProfile([rect(100, 0, 200, 700)], M, { samples: 50 }); // 20-unit bands
    expect(p.ys.length).toBe(50);
    expect(p.ys[0]).toBe(-190);
    expect(p.ys[49]).toBe(790);
    p.ys.forEach((y, i) => {
      if (y > 0 && y < 700) { expect(p.left[i]).toBe(100); expect(p.right[i]).toBe(200); }
      else { expect(p.left[i]).toBeNaN(); expect(p.right[i]).toBeNaN(); }
    });
    expect(inkBounds(p)).toEqual({ minX: 100, maxX: 200 });
    expect(edgeProfile([rect(100, 0, 200, 700)], M).ys.length).toBe(PROFILE_SAMPLES);
    expect(inkBounds(edgeProfile([], M))).toBeNull();
  });
  it('reports the extreme of the outline inside each band, holes ignored, overshoots folded into the end bands', () => {
    // right triangle: the hypotenuse runs from (100, 0) to (0, 100)
    const p = edgeProfile([{ points: [[0, 0], [100, 0], [0, 100]] }], M, { samples: 50 });
    const i = p.ys.indexOf(30); // band 20…40
    expect(p.left[i]).toBe(0);
    expect(p.right[i]).toBeCloseTo(80, 9);
    const ring = edgeProfile(SHAPES.o, M);
    const mid = ring.ys.findIndex((y) => y > 240 && y < 262);
    expect(ring.left[mid]).toBeCloseTo(0, 6);
    expect(ring.right[mid]).toBeCloseTo(500, 6);
    const tall = edgeProfile([rect(10, 700, 60, 900)], M, { samples: 50 });
    expect(tall.left[49]).toBe(10);
    expect(tall.right[49]).toBe(60);
  });
  it('picks the zone by Unicode case', () => {
    expect(charCase('n')).toBe('lower');
    expect(charCase('Ж')).toBe('upper');
    expect(charCase('ж')).toBe('lower');
    expect(charCase('é')).toBe('lower');
    expect(charCase('7')).toBe('digit');
    expect(charCase('.')).toBe('other');
    expect(charCase('א')).toBe('other');
    expect(zoneFor('n', M)).toEqual([0, 500]);
    expect(zoneFor('д', M)).toEqual([0, 500]);
    expect(zoneFor('H', M)).toEqual([0, 700]);
    expect(zoneFor('Д', M)).toEqual([0, 700]);
    expect(zoneFor('7', M)).toEqual([0, 700]);
    const dot = edgeProfile(SHAPES['.'], M, { samples: 50 });
    expect(zoneFor('.', M, dot)).toEqual([0, 100]); // own extent, on band edges
    expect(zoneFor('.', M)).toEqual([M.descender, M.ascender]);
    // a lowercase glyph with no ink in the x-height zone falls back to its own extent
    const high = edgeProfile([rect(0, 600, 50, 700)], M, { samples: 50 });
    expect(zoneFor('n', M, high)).toEqual([600, 700]);
  });
});

describe('auto spacing', () => {
  it('gives a straight stem equal bearings that grow with tightness', () => {
    let prev = 0;
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      for (const ch of ['I', 'l', 'H', 'n']) {
        const { lsb, rsb } = bearings(ch, t);
        expect(lsb, `${ch} @${t}`).toBe(rsb);
        expect(lsb).toBe(Math.round(stemBearing(M, t)));
      }
      const b = bearings('I', t).lsb;
      expect(b).toBeGreaterThan(prev);
      prev = b;
    }
    expect(bearings('I', 0).lsb).toBeGreaterThanOrEqual(25);
    expect(bearings('I', 1).lsb).toBeLessThanOrEqual(150);
  });
  it('gives rounds less than stems, and open shapes (T, V, A, the right of L) close to nothing', () => {
    const stem = bearings('I').lsb;
    const o = bearings('o');
    expect(o.lsb).toBe(o.rsb);
    expect(o.lsb).toBeLessThan(stem * 0.8);
    expect(o.lsb).toBeGreaterThan(stem * 0.25);
    for (const ch of ['T', 'V', 'A']) {
      const b = bearings(ch);
      expect(b.lsb, ch).toBe(b.rsb);
      expect(b.lsb, ch).toBeLessThanOrEqual(stem * 0.35);
      expect(b.lsb, ch).toBeGreaterThan(0);
    }
    const L = bearings('L');
    expect(L.lsb).toBe(stem);
    expect(L.rsb).toBeLessThanOrEqual(stem * 0.35);
    // a tail outside the zone eats into the bearing but never below the floor
    const j = bearings('j', 0.5, [poly([0, -200], [190, -200], [190, 500], [100, 500], [100, -110], [0, -110])]);
    expect(j.lsb).toBeLessThan(stem);
    expect(j.lsb).toBeGreaterThan(0);
    expect(j.rsb).toBe(stem);
  });
  it('shiftGlyph moves strokes, contours and curves and leaves the source alone', () => {
    const curves = [{ start: [10, 0] as Vec, segments: [lineSegment([10, 0], [60, 0]), lineSegment([60, 0], [60, 80]), lineSegment([60, 80], [10, 0])] }];
    const g = outline('x', flattenCurves(curves), {
      curves,
      strokes: [{ id: 's', cap: 'round', points: [{ x: 20, y: 0, w: 10, p: 0.5 }, { x: 20.04, y: 50, w: 10 }] }],
    });
    const before = JSON.stringify(g);
    const s = shiftGlyph(g, 12.34);
    expect(JSON.stringify(g)).toBe(before);
    expect(s).not.toBe(g);
    expect(s.contours).toEqual([{ points: [[22.3, 0], [72.3, 0], [72.3, 80]] }]);
    expect(s.curves![0].start).toEqual([22.3, 0]);
    expect(s.curves![0].segments[1]).toEqual([[72.3, 0], [72.3, 0], [72.3, 80], [72.3, 80]]);
    expect(s.strokes![0].points).toEqual([{ x: 32.3, y: 0, w: 10, p: 0.5 }, { x: 32.4, y: 50, w: 10 }]);
    expect(flattenCurves(s.curves!)).toEqual(s.contours);
    expect(s.advance).toBe(g.advance);
  });
  it('autoSpaceGlyph sets a stroke glyph on its new bearings', () => {
    const g: Glyph = { char: 'l', unicode: 108, advance: 400, source: 'drawn', kind: 'stroke', strokes: [
      { id: 'a', cap: 'flat', points: [{ x: 300, y: 0, w: 45 }, { x: 300, y: 740, w: 45 }] },
    ] };
    const before = JSON.stringify(g);
    const s = autoSpaceGlyph(g, { metrics: M, tightness: 0.5 });
    expect(JSON.stringify(g)).toBe(before);
    expect(s).not.toBe(g);
    const stem = Math.round(stemBearing(M, 0.5));
    const cs = glyphToContours(s);
    expect(minX(cs)).toBeCloseTo(stem, 0);
    expect(s.advance).toBe(Math.round(stem + (maxX(cs) - minX(cs)) + stem));
    expect(s.strokes![0].points[0].x).toBeCloseTo(stem + 45, 0);
    expect(s.strokes![0].points[1].y).toBe(740);
    // tighter setting → narrower glyph
    expect(autoSpaceGlyph(g, { metrics: M, tightness: 0 }).advance).toBeLessThan(s.advance);
    // a second pass has nothing left to do
    expect(autoSpaceGlyph(s, { metrics: M, tightness: 0.5 })).toBe(s);
  });
  it('autoSpaceGlyph moves contours, curves and drawn-on strokes of an outline glyph together', () => {
    const pts: Vec[] = [[200, 0], [290, 0], [290, 700], [200, 700]];
    const curves = [{ start: pts[0], segments: pts.map((p, i) => lineSegment(p, pts[(i + 1) % 4])) }];
    const g = outline('H', flattenCurves(curves), {
      curves,
      strokes: [{ id: 'bar', cap: 'flat', points: [{ x: 245, y: 350, w: 45 }, { x: 600, y: 350, w: 45 }] }],
    });
    const s = autoSpaceGlyph(g, { metrics: M, tightness: 0.5 });
    const dx = s.contours![0].points[0][0] - 200;
    expect(dx).not.toBe(0);
    expect(s.contours![0].points.map((p) => p[0] - dx)).toEqual([200, 290, 290, 200]);
    expect(s.curves![0].start[0] - dx).toBeCloseTo(200, 9);
    expect(flattenCurves(s.curves!)).toEqual(s.contours);
    expect(s.strokes![0].points.map((p) => +(p.x - dx).toFixed(6))).toEqual([245, 600]);
    const cs = glyphToContours(s);
    const { lsb, rsb } = (() => { const p = edgeProfile(glyphToContours(g), M); return sidebearings(p, zoneFor('H', M, p), { metrics: M, tightness: 0.5 }); })();
    expect(minX(cs)).toBeCloseTo(lsb, 0);
    expect(s.advance - maxX(cs)).toBeCloseTo(rsb, 0);
  });
  it('leaves locked and empty glyphs alone (same reference)', () => {
    const locked = outline('I', SHAPES.I, { spacingLocked: true });
    expect(autoSpaceGlyph(locked, { metrics: M, tightness: 0.5 })).toBe(locked);
    const empty: Glyph = { char: 'x', unicode: 120, advance: 320, source: 'generated', kind: 'stroke', strokes: [] };
    expect(autoSpaceGlyph(empty, { metrics: M, tightness: 0.5 })).toBe(empty);
    // `locked` only protects the shape from the generator, not the spacing
    const kept = outline('I', SHAPES.I, { locked: true });
    expect(autoSpaceGlyph(kept, { metrics: M, tightness: 0.5 })).not.toBe(kept);
  });
  it('autoSpaceProject returns new glyphs and does not mutate the project', () => {
    const p = newProject('t');
    p.spacing.tightness = 0.25;
    p.glyphs = {
      I: outline('I', SHAPES.I), o: outline('o', SHAPES.o), T: outline('T', SHAPES.T),
      L: outline('L', SHAPES.L, { spacingLocked: true }),
      x: { char: 'x', unicode: 120, advance: 320, source: 'generated', kind: 'stroke', strokes: [] },
    };
    p.alternates = { I: [outline('I', [rect(40, 0, 160, 700)])] };
    const snapshot = JSON.stringify(p);
    const glyphsRef = p.glyphs;
    const r = autoSpaceProject(p);
    expect(JSON.stringify(p)).toBe(snapshot);
    expect(p.glyphs).toBe(glyphsRef);
    expect(r.glyphs).not.toBe(p.glyphs);
    expect(r.changed.sort()).toEqual(['I', 'T', 'o']);
    expect(r.glyphs.L).toBe(p.glyphs.L);
    expect(r.glyphs.x).toBe(p.glyphs.x);
    const stem = Math.round(stemBearing(M, 0.25));
    expect(r.glyphs.I.advance).toBe(stem + 90 + stem);
    expect(minX(r.glyphs.I.contours!)).toBe(stem);
    expect(r.alternates.I[0].advance).toBe(stem + 120 + stem);
    expect(p.alternates.I[0].advance).toBe(600);
    // only the requested characters
    const part = autoSpaceProject(p, ['o', 'missing']);
    expect(part.changed).toEqual(['o']);
    expect(part.glyphs.I).toBe(p.glyphs.I);
    // spacing twice changes nothing more
    expect(autoSpaceProject({ ...p, glyphs: r.glyphs }).changed).toEqual([]);
  });
});

describe('auto kerning', () => {
  const chars = ['H', 'I', 'n', 'o', 'T', 'L', 'A', 'V', '.'];
  const set = spacedSet(chars);
  const opts = { metrics: M, tightness: 0.5 };
  const kern = autoKern(set, opts);

  it('leaves well-spaced flat and round pairs alone', () => {
    for (const p of ['HH', 'II', 'HI', 'IH', 'nn', 'oo', 'no', 'on', 'Ho', 'In']) expect(kern[p], p).toBeUndefined();
  });
  it('tightens the classic open pairs', () => {
    for (const p of ['AV', 'VA', 'LT', 'LV', 'To', 'T.', 'V.']) expect(kern[p], p).toBeLessThan(0);
    expect(kern.AV).toBe(kern.VA);
    expect(kern.AV).toBeLessThanOrEqual(-40);
    expect(kern.AV).toBeGreaterThanOrEqual(-160);
    expect(kern.To).toBeLessThanOrEqual(-50);
    // a letter that reaches the bar's height cannot slide under it
    expect(kern.TI).toBeUndefined();
    expect(kern.TT).toBeUndefined();
  });
  it('rounds to multiples of 5 and never produces zeros or sub-threshold pairs', () => {
    expect(Object.keys(kern).length).toBeGreaterThan(5);
    for (const [p, v] of Object.entries(kern)) {
      expect([...p].length).toBe(2);
      expect(Math.abs(v % 5), p).toBe(0);
      expect(Math.abs(v), p).toBeGreaterThanOrEqual(12);
    }
  });
  it('never kerns shapes into each other', () => {
    for (const t of [0, 0.5, 1]) {
      const s = spacedSet(chars, t);
      const k = autoKern(s, { metrics: M, tightness: t });
      for (const [p, v] of Object.entries(k)) {
        const [a, b] = [...p];
        expect(pairGap(s[a], s[b], M, v), `${p} @${t}`).toBeGreaterThanOrEqual(10);
        expect(v, p).toBeGreaterThanOrEqual(-0.35 * s[a].advance - 2.5);
        expect(v, p).toBeLessThanOrEqual(60);
      }
      // closing up never goes below the distance of two stems (minus rounding)
      const stems = pairGap(s.I, s.I, M);
      for (const p of ['AV', 'To', 'LT']) if (k[p]) { const [a, b] = [...p]; expect(pairGap(s[a], s[b], M, k[p]), p).toBeGreaterThanOrEqual(stems * 0.9 - 3); }
    }
  });
  it('separates shapes that touch', () => {
    const s: Record<string, KernGlyph> = {
      // an f-like hook hanging over the advance, next to a full-height stem
      f: { advance: 200, contours: [poly([60, 0], [150, 0], [150, 650], [280, 650], [280, 740], [60, 740])] },
      l: { advance: 260, contours: [rect(85, 0, 175, 740)] },
      n: set.n, I: set.I, H: set.H, o: set.o,
    };
    expect(pairGap(s.f, s.l, M)).toBe(5);
    const k = autoKern(s, opts);
    expect(k.fl).toBeGreaterThan(0);
    expect(k.fl % 5).toBe(0);
    expect(pairGap(s.f, s.l, M, k.fl)).toBeGreaterThanOrEqual(30);
    expect(k.fn).toBeUndefined(); // n ends below the hook
  });
  it('respects threshold, maxPairs, chars and strength', () => {
    const all = autoKern(set, { ...opts, threshold: 0 });
    const strong = autoKern(set, { ...opts, threshold: 70 });
    expect(Object.keys(strong).length).toBeGreaterThan(0);
    expect(Object.keys(strong).length).toBeLessThan(Object.keys(all).length);
    for (const v of Object.values(strong)) expect(Math.abs(v)).toBeGreaterThanOrEqual(70);

    const top = autoKern(set, { ...opts, maxPairs: 3 });
    expect(Object.keys(top).length).toBe(3);
    const third = Object.values(kern).map(Math.abs).sort((a, b) => b - a)[2];
    for (const v of Object.values(top)) expect(Math.abs(v)).toBeGreaterThanOrEqual(third);
    expect(autoKern(set, { ...opts, maxPairs: 0 })).toEqual({});

    const sub = autoKern(set, { ...opts, chars: ['A', 'V'] });
    expect(Object.keys(sub).sort()).toEqual(['AV', 'VA']);
    expect(sub.AV).toBe(kern.AV);

    const half = autoKern(set, { ...opts, strength: 0.5, threshold: 0 });
    for (const [p, v] of Object.entries(all)) {
      if (v >= 0) continue;
      expect(Math.abs((half[p] ?? 0) - v / 2), p).toBeLessThanOrEqual(5);
    }
    expect(half.AV).toBeGreaterThan(all.AV);
    expect(autoKern(set, { ...opts, strength: 0 })).toEqual({});
  });
  it('kerns within a script, digits and punctuation against letters, and skips symbols and Hebrew', () => {
    expect(kernClass('A')).toBe(kernClass('é'));
    expect(kernClass('Д')).not.toBe(kernClass('D'));
    expect(kernClass('7')).toBeGreaterThan(0);
    expect(kernClass("'")).toBe(kernClass('.'));
    for (const ch of ['א', '$', '→', '+', '(']) expect(kernClass(ch), ch).toBe(0);
    // Cyrillic А / У drawn like A / V, Hebrew and a symbol drawn like V
    const shapeOf = (ch: string) => ({ А: SHAPES.A, У: SHAPES.V, א: SHAPES.V, $: SHAPES.V, 7: SHAPES.T } as Record<string, Contour[]>)[ch] ?? SHAPES[ch];
    const s = spacedSet(['A', 'V', 'А', 'У', 'א', '$', '7', '.'], 0.5, shapeOf);
    const k = autoKern(s, opts);
    expect(k.AV).toBeLessThan(0);
    expect(k['АУ']).toBe(k.AV);           // Cyrillic pair
    expect(k['AУ']).toBeUndefined();      // Latin + Cyrillic
    expect(k['АV']).toBeUndefined();
    expect(k['Aא']).toBeUndefined();
    expect(k['אA']).toBeUndefined();
    expect(k['A$']).toBeUndefined();
    expect(k['7.']).toBeLessThan(0);      // digit + punctuation
    expect(k['7A']).toBeLessThan(0);      // digit + letter (7 is drawn like T here)
    expect(k['7А']).toBeLessThan(0);      // … of any script
    expect(k['..']).toBeUndefined();      // punctuation + punctuation
  });
  it('does not re-space a font that is looser than the tightness setting', () => {
    const loose = spacedSet(chars, 1);
    const k = autoKern(loose, { metrics: M, tightness: 0 });
    for (const p of ['HH', 'II', 'nn', 'HI', 'In']) expect(k[p], p).toBeUndefined();
    expect(k.AV).toBeLessThan(0);
    // … unless the caller insists on a target
    expect(autoKern(loose, { metrics: M, tightness: 0, target: 2 * stemBearing(M, 0) }).HH).toBeLessThan(0);
  });
  it('is fast enough to run on every build and reuses cached profiles', () => {
    const base = Object.keys(SHAPES);
    const big: Record<string, KernGlyph> = {};
    for (let i = 0; i < 400; i++) {
      const ch = String.fromCodePoint(0x100 + i); // Latin Extended letters
      const src = set[base[i % base.length]] ?? spacedSet([base[i % base.length]])[base[i % base.length]];
      big[ch] = { advance: src.advance, contours: src.contours.map((c) => ({ points: c.points.map((p) => [p[0], p[1]] as Vec) })) };
    }
    const cache = createProfileCache();
    const t0 = performance.now();
    const a = autoKern(big, { ...opts, profiles: cache });
    const cold = performance.now() - t0;
    const t1 = performance.now();
    const b = autoKern(big, { ...opts, profiles: cache });
    const warm = performance.now() - t1;
    expect(b).toEqual(a);
    expect(Object.keys(a).length).toBe(3000); // capped by maxPairs
    expect(cold).toBeLessThan(300);
    expect(warm).toBeLessThan(300);
  });
});

describe('mergeKerning', () => {
  it('lets manual pairs win and a manual 0 remove an automatic pair', () => {
    const auto = { AV: -85, To: -60, LT: -40 };
    const manual = { AV: -120, To: 0, xy: 15, zz: 0 };
    const merged = mergeKerning(auto, manual);
    expect(merged).toEqual({ AV: -120, LT: -40, xy: 15 });
    expect(auto).toEqual({ AV: -85, To: -60, LT: -40 });
    expect(mergeKerning(auto, {})).toEqual(auto);
    expect(mergeKerning({}, manual)).toEqual({ AV: -120, xy: 15 });
  });
});
