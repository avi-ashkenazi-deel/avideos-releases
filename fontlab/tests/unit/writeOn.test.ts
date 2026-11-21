import { describe, it, expect } from 'vitest';
import { orderedStrokes, partialStroke, strokeLength, writeOnPlan, writeOnSvg } from '../../src/export/specimen/writeOn';
import { DEFAULT_METRICS, DEFAULT_STATS, type Contour, type Glyph, type Stroke } from '../../src/core/glyph';
import { generateGlyphs } from '../../src/generate/compose';
import { glyphToContours } from '../../src/outline';

const rect = (x0: number, y0: number, x1: number, y1: number): Contour => ({ points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });
const curvy: Stroke = { id: 'c', cap: 'round', points: Array.from({ length: 40 }, (_, i) => ({ x: i * 15, y: 200 + 150 * Math.sin(i / 6), w: 20 + i })) };

describe('partialStroke', () => {
  it('cuts the stroke by arc length', () => {
    const L = strokeLength(curvy);
    for (const t of [0.1, 0.33, 0.5, 0.77, 0.95]) {
      const p = partialStroke(curvy, t)!;
      expect(Math.abs(strokeLength(p) - t * L) / (t * L)).toBeLessThan(0.02);
      expect(p.points[0]).toEqual(curvy.points[0]);
    }
  });
  it('t = 1 is the full stroke, t = 0 is nothing', () => {
    expect(partialStroke(curvy, 1)).toBe(curvy);
    expect(partialStroke(curvy, 0)).toBeNull();
  });
});

describe('orderedStrokes', () => {
  it('keeps drawing order for stroke glyphs', () => {
    const strokes: Stroke[] = [
      { id: 'b', cap: 'round', points: [{ x: 400, y: 0, w: 30 }, { x: 400, y: 600, w: 30 }] },
      { id: 'a', cap: 'round', points: [{ x: 100, y: 600, w: 30 }, { x: 100, y: 0, w: 30 }] },
    ];
    const g: Glyph = { char: 'H', unicode: 72, advance: 600, source: 'drawn', kind: 'stroke', strokes };
    expect(orderedStrokes(g).map((s) => s.id)).toEqual(['b', 'a']);
  });
  it('skeletonises outline glyphs (cached) and orients strokes top→bottom / left→right', () => {
    const cache = new Map<string, Stroke[]>();
    const I: Glyph = { char: 'I', unicode: 73, advance: 300, source: 'imported', kind: 'outline', contours: [rect(110, 0, 190, 700)] };
    const a = orderedStrokes(I, cache);
    expect(a.length).toBeGreaterThanOrEqual(1);
    const s = a[0].points;
    expect(s[0].y).toBeGreaterThan(s[s.length - 1].y); // top → bottom
    expect(cache.size).toBe(1);
    expect(orderedStrokes(I, cache)[0]).toBe(a[0]); // cached, not re-skeletonised
    const dash: Glyph = { char: '-', unicode: 45, advance: 600, source: 'imported', kind: 'outline', contours: [rect(50, 300, 550, 370)] };
    const d = orderedStrokes(dash, cache)[0].points;
    expect(d[0].x).toBeLessThan(d[d.length - 1].x); // left → right
    // mixed glyph: skeleton first, then the drawn strokes
    const mixed: Glyph = { ...I, char: 'J', strokes: [curvy] };
    const m = orderedStrokes(mixed, cache);
    expect(m[m.length - 1]).toBe(curvy);
    expect(m.length).toBeGreaterThanOrEqual(2);
  });
});

describe('writeOnPlan + writeOnSvg', () => {
  const glyphs = generateGlyphs({ seeds: [], stats: { ...DEFAULT_STATS }, mutation: 0.2, glyphs: {} }, 1, 'Helo');
  const built: Record<string, { advance: number; contours: Contour[] }> = {};
  for (const [ch, g] of Object.entries(glyphs)) built[ch] = { advance: g.advance, contours: glyphToContours(g) };

  it('schedules strokes in order and ends at the last stroke', () => {
    const plan = writeOnPlan('Hello\nHe lo', { metrics: DEFAULT_METRICS, glyphs, built });
    expect(plan.items.map((i) => i.ch).join('')).toBe('HelloHelo');
    let prev = -1;
    for (const it of plan.items) {
      expect(it.starts.length).toBe(it.strokes.length);
      for (const s of it.starts) { expect(s).toBeGreaterThanOrEqual(prev); prev = s; }
    }
    const last = plan.items[plan.items.length - 1];
    expect(plan.durationMs).toBeCloseTo(last.starts[last.starts.length - 1] + last.durations[last.durations.length - 1], 6);
    expect(plan.durationMs).toBeGreaterThan(500);
    // second line sits below the first
    expect(plan.items[5].y).toBeLessThan(plan.items[0].y);
    // maxDurationMs speeds it up uniformly
    expect(writeOnPlan('Hello', { metrics: DEFAULT_METRICS, glyphs, built, maxDurationMs: 300 }).durationMs).toBeCloseTo(300, 6);
  });

  it('glyphs without strokes get a single fade slot; missing glyphs only advance', () => {
    const outlineOnly: Record<string, Glyph> = { H: { ...glyphs.H, kind: 'outline', strokes: undefined, contours: [] } };
    const plan = writeOnPlan('H?H', { metrics: DEFAULT_METRICS, glyphs: outlineOnly, built });
    expect(plan.items.map((i) => i.ch)).toEqual(['H', 'H']);
    expect(plan.items[0].strokes).toEqual([]);
    expect(plan.items[0].durations).toEqual([200]);
    expect(plan.items[1].x).toBeGreaterThan(built.H.advance + 400);
  });

  it('animated SVG is self-contained with one masked path per glyph', () => {
    const plan = writeOnPlan('Hello', { metrics: DEFAULT_METRICS, glyphs, built });
    const svg = writeOnSvg(plan, { fill: '#123', bg: '#fafafa' });
    expect(svg).toContain('<mask');
    expect(svg).toContain('stroke-dashoffset');
    expect(svg).toContain('@keyframes');
    expect(svg).toContain('infinite');
    const urls = svg.match(/https?:\/\/[^"'\s)]+/g) ?? [];
    expect(urls.every((u) => u === 'http://www.w3.org/2000/svg')).toBe(true);
    expect(svg.match(/ mask="url\(#/g)?.length).toBe(5);
    expect(svg.match(/<mask /g)?.length).toBe(5);
    expect(svg.match(/pathLength="1"/g)?.length).toBe(plan.items.reduce((a, i) => a + i.strokes.length, 0));
    const once = writeOnSvg(plan, { loop: false });
    expect(once).toContain('forwards');
    expect(once).not.toContain('infinite');
  });
});
