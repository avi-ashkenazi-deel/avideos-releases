import { describe, it, expect } from 'vitest';
import { CHARSET, DEFAULT_STATS, type Glyph, type Stroke, type StyleStats } from '../../src/core/glyph';
import { bboxStrokes, signedArea } from '../../src/core/geometry';
import { makeRng, glyphRng } from '../../src/core/prng';
import { glyphToContours } from '../../src/outline/index';
import { recipes, missingRecipes } from '../../src/core/recipes';
import { generateGlyphs, regenerateOne, buildGlyph } from '../../src/generate/compose';
import { measureStats } from '../../src/generate/stats';
import { mutateStrokes } from '../../src/generate/mutate';
import { borrowStrokes } from '../../src/generate/borrow';
import { linePts, arcPts } from '../../src/generate/primitives';

const chars = [...CHARSET];

function project(overrides: Partial<{ seeds: Glyph[]; stats: StyleStats; mutation: number; glyphs: Record<string, Glyph> }> = {}) {
  return { seeds: [], stats: { ...DEFAULT_STATS }, mutation: 0.3, glyphs: {}, ...overrides };
}

function strokeGlyph(char: string, strokes: Stroke[], advance: number, extra: Partial<Glyph> = {}): Glyph {
  return { char, unicode: char.codePointAt(0)!, advance, source: 'drawn', kind: 'stroke', strokes, ...extra };
}

function mk(id: string, pts: [number, number][], w: number): Stroke {
  return { id, cap: 'round', points: pts.map(([x, y]) => ({ x, y, w })) };
}

describe('recipe library', () => {
  it('covers every character in CHARSET', () => {
    expect(missingRecipes()).toEqual([]);
    expect(Object.keys(recipes).length).toBeGreaterThanOrEqual(62);
    for (const ch of chars) expect(recipes[ch].id).toBe(ch);
  });

  it('builds sane skeletons directly', () => {
    for (const ch of chars) {
      const r = recipes[ch].build({ stats: DEFAULT_STATS, rng: makeRng(1), mutation: 0, params: {} });
      expect(r.strokes.length).toBeGreaterThan(0);
      expect(r.advance).toBeGreaterThan(0);
    }
  });
});

describe('generateGlyphs', () => {
  const glyphs = generateGlyphs(project(), 42);

  it('produces a glyph for every char with finite dense strokes', () => {
    expect(Object.keys(glyphs).sort()).toEqual([...chars].sort());
    for (const ch of chars) {
      const g = glyphs[ch];
      expect(g.char).toBe(ch);
      expect(g.unicode).toBe(ch.codePointAt(0));
      expect(g.kind).toBe('stroke');
      expect(g.source).toBe('generated');
      expect(g.recipe?.id).toBe(ch);
      expect(g.recipe?.seed).toBe(42);
      expect(g.strokes!.length).toBeGreaterThanOrEqual(1);
      expect(g.advance).toBeGreaterThan(0);
      let n = 0;
      for (const s of g.strokes!) {
        expect(s.id).toBeTruthy();
        for (const p of s.points) {
          expect(Number.isFinite(p.x)).toBe(true);
          expect(Number.isFinite(p.y)).toBe(true);
          expect(Number.isFinite(p.w)).toBe(true);
          expect(p.w).toBeGreaterThan(0);
          n++;
        }
      }
      expect(n).toBeGreaterThanOrEqual(2);
    }
  });

  it('keeps ink inside the advance box and vertical metrics', () => {
    const { ascender, descender } = DEFAULT_STATS;
    for (const ch of chars) {
      const g = glyphs[ch];
      const bb = bboxStrokes(g.strokes!);
      expect(bb.minX, `${ch} minX`).toBeGreaterThanOrEqual(-50);
      expect(bb.maxX, `${ch} maxX`).toBeLessThanOrEqual(g.advance + 50);
      expect(bb.minY, `${ch} minY`).toBeGreaterThanOrEqual(descender - 60);
      expect(bb.maxY, `${ch} maxY`).toBeLessThanOrEqual(ascender + 60);
    }
  });

  it('respects vertical classes (x-height, ascenders, descenders)', () => {
    const { xHeight, capHeight } = DEFAULT_STATS;
    const top = (ch: string) => bboxStrokes(glyphs[ch].strokes!).maxY;
    const bottom = (ch: string) => bboxStrokes(glyphs[ch].strokes!).minY;
    for (const ch of 'acemnorsuvwxz') expect(top(ch), ch).toBeLessThan(xHeight + 90);
    for (const ch of 'bdfhklt') expect(top(ch), ch).toBeGreaterThan(xHeight + 60);
    for (const ch of 'gjpqy') expect(bottom(ch), ch).toBeLessThan(-100);
    for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') expect(top(ch), ch).toBeGreaterThan(capHeight - 60);
  });

  it('converts every glyph to filled contours with positive total area', () => {
    for (const ch of chars) {
      const contours = glyphToContours(glyphs[ch]);
      expect(contours.length, ch).toBeGreaterThanOrEqual(1);
      const area = contours.reduce((s, c) => s + signedArea(c.points), 0);
      expect(area, ch).toBeGreaterThan(0);
    }
  });

  it('is deterministic for the same seed and differs for a different seed', () => {
    const a = JSON.stringify(generateGlyphs(project(), 7));
    const b = JSON.stringify(generateGlyphs(project(), 7));
    expect(a).toBe(b);
    const c = generateGlyphs(project(), 8);
    const g7 = generateGlyphs(project(), 7);
    const differing = chars.filter((ch) => JSON.stringify(g7[ch]) !== JSON.stringify(c[ch]));
    expect(differing.length).toBeGreaterThan(0);
  });

  it('is independent of processing order (glyph-scoped rng)', () => {
    const all = generateGlyphs(project(), 99);
    const only = generateGlyphs(project(), 99, 'kQ3');
    expect(JSON.stringify(only.k)).toBe(JSON.stringify(all.k));
    expect(JSON.stringify(only.Q)).toBe(JSON.stringify(all.Q));
    expect(JSON.stringify(only['3'])).toBe(JSON.stringify(all['3']));
    expect(Object.keys(only).sort()).toEqual(['3', 'Q', 'k']);
  });

  it('keeps seeds and locked glyphs verbatim', () => {
    const seedA = strokeGlyph('A', [mk('sa', [[0, 0], [100, 700], [200, 0]], 40)], 320);
    const lockedB = strokeGlyph('B', [mk('lb', [[0, 0], [0, 700]], 40)], 400, { source: 'generated', locked: true });
    const out = generateGlyphs(project({ seeds: [seedA], glyphs: { B: lockedB } }), 1);
    expect(out.A).toBe(seedA);
    expect(out.B).toBe(lockedB);
    expect(out.C.source).toBe('generated');
  });

  it('works with zero mutation and with garbage stats', () => {
    const zero = generateGlyphs(project({ mutation: 0 }), 3);
    expect(Object.keys(zero).length).toBe(62);
    const garbage = { ...DEFAULT_STATS, strokeWidth: NaN, xHeight: -5, capHeight: Infinity, spacing: NaN, wobbleAmp: 1e9, slantDeg: NaN } as StyleStats;
    const out = generateGlyphs(project({ stats: garbage }), 3);
    for (const ch of chars) {
      const g = out[ch];
      expect(g.advance).toBeGreaterThan(0);
      for (const s of g.strokes!) for (const p of s.points) expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.w)).toBe(true);
    }
  });

  it('applies slant from stats', () => {
    const slanted = buildGlyph('l', { ...DEFAULT_STATS, slantDeg: 12 }, 0, 5);
    const pts = slanted.strokes![0].points;
    const topP = pts.reduce((a, b) => (b.y > a.y ? b : a));
    const botP = pts.reduce((a, b) => (b.y < a.y ? b : a));
    expect(topP.x).toBeGreaterThan(botP.x + 100);
  });
});

describe('regenerateOne', () => {
  it('re-rolls a glyph with a new seed and records it', () => {
    const p = project();
    const a = regenerateOne('g', p, 11);
    const b = regenerateOne('g', p, 12);
    const a2 = regenerateOne('g', p, 11);
    expect(a.recipe?.seed).toBe(11);
    expect(JSON.stringify(a)).toBe(JSON.stringify(a2));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).toBe(JSON.stringify(generateGlyphs(p, 11).g));
  });

  it('returns locked glyphs untouched', () => {
    const locked = strokeGlyph('g', [mk('x', [[0, 0], [0, 500]], 40)], 300, { locked: true });
    expect(regenerateOne('g', project({ glyphs: { g: locked } }), 5)).toBe(locked);
  });
});

describe('borrow', () => {
  const hw = 45;
  const nStem = mk('n1', linePts(0, 0, 0, 500, 10) as [number, number][], hw);
  const nArch = mk('n2', [...arcPts(140, 350, 140, 150, 180, 0, 10), ...linePts(280, 350, 280, 0, 10)] as [number, number][], hw);
  const nSeed = strokeGlyph('n', [nStem, nArch], 400);
  const bSeed = strokeGlyph('b', [mk('b1', linePts(0, 0, 0, 740, 10) as [number, number][], hw), mk('b2', arcPts(150, 250, 150, 262, 90, 450, 10) as [number, number][], hw)], 420);
  const seeds = new Map<string, Glyph>([['n', nSeed], ['b', bSeed]]);

  it('derives h, m, u from n and d, p, q from b', () => {
    const h = borrowStrokes('h', seeds, DEFAULT_STATS)!;
    expect(h.parent).toBe('n');
    expect(bboxStrokes(h.strokes).maxY).toBeGreaterThan(700);
    const m = borrowStrokes('m', seeds, DEFAULT_STATS)!;
    expect(bboxStrokes(m.strokes).maxX - bboxStrokes(m.strokes).minX).toBeGreaterThan(bboxStrokes(nSeed.strokes!).maxX * 1.5);
    const u = borrowStrokes('u', seeds, DEFAULT_STATS)!;
    expect(bboxStrokes(u.strokes).minY).toBeCloseTo(bboxStrokes(nSeed.strokes!).minY, 3);
    const d = borrowStrokes('d', seeds, DEFAULT_STATS)!;
    expect(d.parent).toBe('b');
    // d's stem is on the right
    const stemX = d.strokes[0].points[0].x;
    expect(stemX).toBeGreaterThan(bboxStrokes(d.strokes).minX + 200);
    const p = borrowStrokes('p', seeds, DEFAULT_STATS)!;
    expect(bboxStrokes(p.strokes).minY).toBeLessThan(-150);
    expect(bboxStrokes(p.strokes).maxY).toBeLessThan(560);
    const q = borrowStrokes('q', seeds, DEFAULT_STATS)!;
    expect(bboxStrokes(q.strokes).minY).toBeLessThan(-150);
    expect(borrowStrokes('x', seeds, DEFAULT_STATS)).toBeNull();
    expect(borrowStrokes('h', new Map(), DEFAULT_STATS)).toBeNull();
  });

  it('is used by generateGlyphs when the parent seed exists', () => {
    const out = generateGlyphs(project({ seeds: [nSeed, bSeed] }), 2);
    expect(out.h.recipe?.id).toBe('borrow:n>h');
    expect(out.m.recipe?.id).toBe('borrow:n>m');
    expect(out.u.recipe?.id).toBe('borrow:n>u');
    expect(out.d.recipe?.id).toBe('borrow:b>d');
    expect(out.p.recipe?.id).toBe('borrow:b>p');
    expect(out.q.recipe?.id).toBe('borrow:b>q');
    expect(out.n).toBe(nSeed);
    expect(out.o.recipe?.id).toBe('o');
    for (const ch of 'hmudpq') {
      const contours = glyphToContours(out[ch]);
      expect(contours.reduce((s, c) => s + signedArea(c.points), 0)).toBeGreaterThan(0);
    }
  });

  it('ignores unusable parents', () => {
    const junk = strokeGlyph('n', [mk('j', [[0, 0], [NaN, 5]], 10)], 100);
    expect(borrowStrokes('h', new Map([['n', junk]]), DEFAULT_STATS)).toBeNull();
    const outline: Glyph = { char: 'n', unicode: 110, advance: 300, source: 'traced', kind: 'outline', contours: [{ points: [[0, 0], [100, 0], [100, 100]] }] };
    expect(borrowStrokes('h', new Map([['n', outline]]), DEFAULT_STATS)).toBeNull();
  });
});

describe('mutateStrokes', () => {
  const base = [mk('a', linePts(0, 0, 0, 500, 10) as [number, number][], 40), mk('b', arcPts(100, 250, 100, 250, 0, 360, 10) as [number, number][], 40)];

  it('is deterministic and leaves input untouched', () => {
    const before = JSON.stringify(base);
    const a = mutateStrokes(base, 0.5, makeRng(3));
    const b = mutateStrokes(base, 0.5, makeRng(3));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(base)).toBe(before);
    expect(JSON.stringify(a)).not.toBe(before);
  });

  it('returns a copy unchanged at amount 0 and moves points modestly at amount 1', () => {
    const zero = mutateStrokes(base, 0, makeRng(3));
    expect(JSON.stringify(zero)).toBe(JSON.stringify(base));
    const one = mutateStrokes(base, 1, makeRng(3));
    let maxD = 0;
    one.forEach((s, si) => s.points.forEach((p, pi) => {
      const q = base[si].points[pi];
      maxD = Math.max(maxD, Math.hypot(p.x - q.x, p.y - q.y));
    }));
    expect(maxD).toBeGreaterThan(0);
    expect(maxD).toBeLessThan(80);
  });
});

describe('measureStats', () => {
  it('returns base for no seeds or garbage', () => {
    expect(measureStats([], DEFAULT_STATS)).toEqual(DEFAULT_STATS);
    const junk = [null, {}, { char: 'a', kind: 'stroke', strokes: [{ points: [{ x: NaN, y: 1, w: 3 }] }] }] as unknown as Glyph[];
    const s = measureStats(junk, DEFAULT_STATS);
    for (const k of Object.keys(s) as (keyof StyleStats)[]) {
      const v = s[k];
      if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('recovers metrics from a synthetic seed set', () => {
    // synthesise seeds with a known style: width 120, xh 480, cap 680, asc 760, desc -210, spacing 40
    const style: StyleStats = { ...DEFAULT_STATS, strokeWidth: 120, xHeight: 480, capHeight: 680, ascender: 760, descender: -210, spacing: 40, overshoot: 10, slantDeg: 0, wobbleAmp: 0 };
    const seedChars = [...'nmxzoebdhgpHEILO'];
    const seeds = seedChars.map((ch) => buildGlyph(ch, style, 0, 1));
    const m = measureStats(seeds, DEFAULT_STATS);
    expect(Math.abs(m.strokeWidth - 120) / 120).toBeLessThan(0.2);
    expect(Math.abs(m.xHeight - 480)).toBeLessThan(40);
    expect(Math.abs(m.capHeight - 680)).toBeLessThan(40);
    expect(Math.abs(m.ascender - 760)).toBeLessThan(40);
    expect(Math.abs(m.descender + 210)).toBeLessThan(40);
    expect(Math.abs(m.spacing - 40)).toBeLessThan(15);
    expect(Math.abs(m.slantDeg)).toBeLessThan(3);
    expect(m.overshoot).toBeGreaterThanOrEqual(0);
    expect(m.overshoot).toBeLessThanOrEqual(30);
    expect(m.wobbleAmp).toBeLessThan(5);
    expect(m.terminal).toBe('round');
  });

  it('detects slant and wobble', () => {
    const slanty = [...'nmxzHEIL'].map((ch) => buildGlyph(ch, { ...DEFAULT_STATS, slantDeg: 12 }, 0, 1));
    const m = measureStats(slanty, DEFAULT_STATS);
    expect(m.slantDeg).toBeGreaterThan(6);
    const rng = glyphRng(5, 'wob');
    const wobbly = [strokeGlyph('l', [mk('w', linePts(0, 0, 0, 700, 8).map(([x, y]) => [x + rng.range(-12, 12), y] as [number, number]), 40)], 200)];
    const w = measureStats(wobbly, DEFAULT_STATS);
    expect(w.wobbleAmp).toBeGreaterThan(2);
  });

  it('estimates width from outline seeds', () => {
    // a 100 x 600 rectangle outline => ribbon width ~ 2*area/perimeter = 2*60000/1400 ≈ 86
    const outline: Glyph = { char: 'I', unicode: 73, advance: 220, source: 'traced', kind: 'outline', contours: [{ points: [[60, 0], [160, 0], [160, 600], [60, 600]] }] };
    const m = measureStats([outline], DEFAULT_STATS);
    expect(m.strokeWidth).toBeGreaterThan(60);
    expect(m.strokeWidth).toBeLessThan(110);
    expect(m.capHeight).toBeGreaterThan(500);
    expect(m.spacing).toBeCloseTo(60, 0);
  });
});
