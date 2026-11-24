import { describe, it, expect } from 'vitest';
import { runChecks, applyFix, CHECK_LIMITS, type BuiltShapes, type Issue } from '../../src/check/checks';
import { CHARSET, DEFAULT_STATS, newProject, type Contour, type FontProject, type Glyph, type Vec } from '../../src/core/glyph';
import { generateGlyphs } from '../../src/generate/compose';
import { buildAll } from '../../src/pipeline/build';
import { curvesFromContours, flattenCurves } from '../../src/inputs/draw/curves';

const rect = (x0: number, y0: number, x1: number, y1: number): Contour => ({ points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });
const blob = (cx: number, cy: number, r: number, n: number): Contour => ({ points: Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)] as Vec) });

function outline(ch: string, contours: Contour[], advance = 600, extra: Partial<Glyph> = {}): Glyph {
  return { char: ch, unicode: ch.codePointAt(0)!, advance, source: 'drawn', kind: 'outline', contours, ...extra };
}

/** Built shapes straight from the outline glyphs (no clean-up, so tests control every contour). */
function shapes(p: FontProject): BuiltShapes {
  const out: BuiltShapes = {};
  for (const [ch, g] of Object.entries(p.glyphs)) out[ch] = { advance: g.advance, contours: g.contours ?? [] };
  return out;
}

/** A tidy, complete Latin font made of plain bars: 100-unit stems, capitals 700 tall, lowercase 500. */
function tidy(name = 'Tidy Sans'): FontProject {
  const p = newProject(name);
  for (const ch of CHARSET) {
    const lower = /[a-z]/.test(ch);
    p.glyphs[ch] = outline(ch, [rect(60, 0, 160, lower ? 500 : 700), rect(160, 0, 440, 100)], 500);
  }
  return p;
}

const ids = (issues: Issue[]) => issues.map((i) => i.id);
const find = (issues: Issue[], id: string) => issues.find((i) => i.id === id);
const check = (p: FontProject, extra?: { kerning?: Record<string, number> }) => runChecks(p, shapes(p), extra);

describe('runChecks', () => {
  it('finds nothing wrong with a clean font', () => {
    expect(check(tidy())).toEqual([]);
  });

  it('empty: mostly empty sets are a hint to generate, a few gaps are a warning', () => {
    const blank = runChecks(newProject('Blank'), {});
    expect(ids(blank)).toEqual(['empty:latin']);
    expect(blank[0].severity).toBe('info');
    expect(blank[0].chars).toHaveLength(62);
    expect(blank[0].detail).toMatch(/Generate/);

    const p = tidy();
    delete p.glyphs.Q;
    p.glyphs.z = outline('z', []);            // present but nothing drawn
    p.glyphs['7'] = { char: '7', unicode: 55, advance: 500, source: 'drawn', kind: 'stroke', strokes: [] };
    const gaps = check(p);
    expect(ids(gaps)).toEqual(['empty:latin']);
    expect(gaps[0].severity).toBe('warn');
    expect(gaps[0].chars.sort()).toEqual(['7', 'Q', 'z']);
    expect(gaps[0].detail).toContain('Q');

    // other scripts only count once switched on; custom characters too
    const q = tidy();
    q.blocks = ['latin', 'hebrew'];
    q.customChars = '☃';
    q.glyphs['א'] = outline('א', [rect(60, 0, 400, 500)]);
    const more = check(q);
    expect(ids(more).sort()).toEqual(['empty:custom', 'empty:hebrew']);
    expect(find(more, 'empty:hebrew')!.severity).toBe('info');
    expect(find(more, 'empty:hebrew')!.chars).not.toContain('א');
    expect(find(more, 'empty:custom')!.chars).toEqual(['☃']);
  });

  it('duplicate-case: lowercase that copies the capital, and the fix clears it', () => {
    const p = tidy();
    for (const ch of 'abc') p.glyphs[ch] = outline(ch, p.glyphs[ch.toUpperCase()].contours!.map((c) => ({ points: c.points.map(([x, y]) => [x + 1, y - 1] as Vec) })), 501);
    p.glyphs.d = outline('d', p.glyphs.D.contours!, 520);                       // same shape, different advance: not a copy
    p.glyphs.e = outline('e', [rect(60, 0, 160, 700), rect(160, 0, 440, 130)], 500); // same box, 6% more ink
    p.seeds = [p.glyphs.a, p.glyphs.A];
    const issue = find(check(p), 'duplicate-case')!;
    expect(issue.severity).toBe('warn');
    expect(issue.chars).toEqual(['a', 'b', 'c']);
    expect(issue.fix?.id).toBe('clear-duplicate-lowercase');

    const res = applyFix(p, shapes(p), 'clear-duplicate-lowercase');
    expect(res.changed).toEqual(['a', 'b', 'c']);
    expect(res.message).toMatch(/3/);
    expect(p.glyphs.a).toBeUndefined();
    expect(p.glyphs.A).toBeDefined();
    expect(p.glyphs.d).toBeDefined();
    expect(p.seeds.map((g) => g.char)).toEqual(['A']);
    const after = check(p);
    expect(find(after, 'duplicate-case')).toBeUndefined();
    expect(find(after, 'empty:latin')!.chars).toEqual(['a', 'b', 'c']);
    expect(applyFix(p, shapes(p), 'clear-duplicate-lowercase').changed).toEqual([]);
  });

  it('specks: stray tiny contours, removed from outline sources (contours and curves)', () => {
    const p = tidy();
    p.glyphs.A.contours!.push(rect(300, 400, 310, 410));          // 10 × 10 box
    p.glyphs.B.contours!.push(rect(300, 400, 340, 403));          // 40 × 3 sliver: 120 units²
    p.glyphs.C.contours!.push(rect(300, 400, 320, 420));          // 20 × 20: a real dot, kept
    const withCurves = [rect(60, 0, 160, 700), rect(300, 300, 308, 308), rect(160, 0, 440, 100)];
    p.glyphs.D = outline('D', withCurves, 500, { curves: curvesFromContours(withCurves) });
    p.glyphs.D.contours = flattenCurves(p.glyphs.D.curves!);
    p.glyphs['.'] = outline('.', [rect(50, 0, 60, 10)], 200);     // a lone small dot is the letter itself
    p.customChars = '.';
    p.alternates = { E: [outline('E', [rect(60, 0, 160, 700), rect(200, 200, 205, 205)])] };
    const issue = find(check(p), 'specks')!;
    expect(issue.severity).toBe('warn');
    expect(issue.chars.sort()).toEqual(['A', 'B', 'D', 'E']);
    expect(issue.fix?.id).toBe('remove-specks');

    const res = applyFix(p, shapes(p), 'remove-specks');
    expect(res.changed.sort()).toEqual(['A', 'B', 'D', 'E']);
    expect(p.glyphs.A.contours).toHaveLength(2);
    expect(p.glyphs.B.contours).toHaveLength(2);
    expect(p.glyphs.C.contours).toHaveLength(3);
    expect(p.glyphs.D.curves).toHaveLength(2);
    expect(p.glyphs.D.contours).toHaveLength(2);
    expect(p.glyphs.D.contours).toEqual(flattenCurves(p.glyphs.D.curves!));
    expect(p.glyphs['.'].contours).toHaveLength(1);
    expect(p.alternates.E[0].contours).toHaveLength(1);
    expect(find(check(p), 'specks')).toBeUndefined();
    expect(applyFix(p, shapes(p), 'remove-specks').changed).toEqual([]);
  });

  it('specks that only exist in the built shape have no automatic fix', () => {
    const p = tidy();
    const built = shapes(p);
    built.A = { advance: 500, contours: [...built.A.contours, rect(300, 400, 306, 406)] };
    const issue = find(runChecks(p, built), 'specks')!;
    expect(issue.chars).toEqual(['A']);
    expect(issue.fix).toBeUndefined();
    expect(issue.detail).toMatch(/effects/);
  });

  it('clipping: ink beyond ascender / descender, fixed by fitting the metrics', () => {
    const p = tidy();
    p.glyphs.A.contours!.push(rect(200, 700, 260, 930.4));
    p.glyphs.g.contours!.push(rect(200, -306.5, 260, 0));
    p.glyphs.h.contours!.push(rect(200, 500, 260, 804));          // 4 over: within the slack
    const issue = find(check(p), 'clipping')!;
    expect(issue.severity).toBe('warn');
    expect(issue.chars).toEqual(['A', 'g']);
    expect(issue.detail).toMatch(/A reaches above/);
    expect(issue.detail).toMatch(/g reaches below/);
    expect(issue.fix?.id).toBe('fit-metrics');

    const res = applyFix(p, shapes(p), 'fit-metrics');
    expect(p.metrics.ascender).toBe(931 + CHECK_LIMITS.fitMargin);
    expect(p.metrics.descender).toBe(-307 - CHECK_LIMITS.fitMargin);
    expect(res.message).toMatch(/951/);
    expect(res.changed).toEqual([]);
    expect(find(check(p), 'clipping')).toBeUndefined();
    // already fits: nothing moves
    const before = { ...p.metrics };
    expect(applyFix(p, shapes(p), 'fit-metrics').message).toMatch(/already/);
    expect(p.metrics).toEqual(before);
  });

  it('overflow: ink far outside the advance box', () => {
    const p = tidy();
    p.glyphs.A.contours!.push(rect(-60, 300, 60, 400));
    p.glyphs.B.contours!.push(rect(440, 300, 540, 400));
    p.glyphs.C.contours!.push(rect(440, 300, 525, 400));          // 25 over: fine
    const issue = find(check(p), 'overflow')!;
    expect(issue.severity).toBe('warn');
    expect(issue.chars).toEqual(['A', 'B']);
    expect(issue.fix?.id).toBe('auto-space');
    // the app owns this fix
    const snapshot = JSON.stringify(p);
    expect(applyFix(p, shapes(p), 'auto-space').changed).toEqual([]);
    expect(JSON.stringify(p)).toBe(snapshot);
  });

  it('width outliers: far wider or narrower than the other letters of the same kind', () => {
    const p = tidy();
    p.glyphs.A = outline('A', [rect(60, 0, 160, 700), rect(160, 0, 1400, 100)], 1460);
    p.glyphs.b = outline('b', [rect(60, 0, 160, 500), rect(160, 0, 200, 100)], 260);
    p.glyphs.i = outline('i', [rect(60, 0, 160, 500)], 220);                              // narrow by nature
    p.glyphs.M = outline('M', [rect(60, 0, 160, 700), rect(160, 0, 880, 100)], 940);      // wide by nature: 2.2×
    const issue = find(check(p), 'width-outliers')!;
    expect(issue.chars).toEqual(['A', 'b']);
    expect(issue.severity).toBe('warn');
    expect(issue.detail).toMatch(/A \(\d+% wider\)/);
    expect(issue.detail).toMatch(/b \(\d+% narrower\)/);
    // too few letters to judge
    const few = newProject('Few');
    for (const ch of 'ABCD') few.glyphs[ch] = outline(ch, [rect(60, 0, 460, 700)], 500);
    few.glyphs.E = outline('E', [rect(60, 0, 1460, 700)], 1500);
    expect(find(check(few), 'width-outliers')).toBeUndefined();
  });

  it('height outliers: capitals and x-height letters that miss the common height', () => {
    const p = tidy();
    p.glyphs.A = outline('A', [rect(60, 0, 160, 920), rect(160, 0, 440, 100)], 500);
    p.metrics.ascender = 1000;
    p.glyphs.x = outline('x', [rect(60, 0, 160, 420), rect(160, 0, 440, 100)], 500);
    p.glyphs.b = outline('b', [rect(60, 0, 160, 720), rect(160, 0, 440, 100)], 500);      // ascender letter: not compared
    p.glyphs.n = outline('n', [rect(60, 0, 160, 540), rect(160, 0, 440, 100)], 500);      // 8% taller: fine
    const issue = find(check(p), 'height-outliers')!;
    expect(issue.chars).toEqual(['A', 'x']);
    expect(issue.severity).toBe('warn');                   // A is 31% taller
    expect(issue.detail).toMatch(/A \(31% taller\)/);
    expect(issue.detail).toMatch(/x \(16% shorter\)/);
    p.glyphs.A = outline('A', [rect(60, 0, 160, 700), rect(160, 0, 440, 100)], 500);
    expect(find(check(p), 'height-outliers')!.severity).toBe('info');
  });

  it('height outliers respect a font that bounces on purpose (robust spread)', () => {
    const p = tidy();
    [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].forEach((ch, i) => { p.glyphs[ch] = outline(ch, [rect(60, 0, 160, 600 + (i % 5) * 50), rect(160, 0, 440, 100)], 500); });
    expect(find(check(p), 'height-outliers')).toBeUndefined();
  });

  it('weight outliers: much bolder or lighter than the rest', () => {
    const p = tidy();
    p.glyphs.A = outline('A', [rect(60, 0, 440, 700)], 500);                                  // a solid slab
    p.glyphs.b = outline('b', [rect(60, 0, 80, 500), rect(80, 0, 440, 20)], 500);             // hairline
    const issue = find(check(p), 'weight-outliers')!;
    expect(issue.chars).toEqual(['A', 'b']);
    expect(issue.detail).toMatch(/A \(\d+% bolder\)/);
    expect(issue.detail).toMatch(/b \(\d+% lighter\)/);
    expect(['info', 'warn']).toContain(issue.severity);
  });

  it('heavy outlines: too many points in a letter or in the whole font', () => {
    const p = tidy();
    p.glyphs.A = outline('A', [blob(250, 350, 200, 1600)], 500);
    const one = check(p);
    expect(find(one, 'heavy-outlines')!.chars).toEqual(['A']);
    expect(find(one, 'heavy-font')).toBeUndefined();
    // 62 letters × 2,500 points
    const built = shapes(tidy());
    const big = blob(250, 300, 200, 2500);
    for (const ch of Object.keys(built)) built[ch] = { advance: 500, contours: [big] };
    const all = runChecks(tidy(), built);
    expect(find(all, 'heavy-font')!.detail).toContain('155,000');
    expect(find(all, 'heavy-outlines')!.chars).toHaveLength(62);
  });

  it('name: still "Untitled"', () => {
    for (const name of ['Untitled', '  untitled 2 ', '']) {
      const issue = find(check(tidy(name)), 'name')!;
      expect(issue.fix?.id).toBe('name-font');
      expect(issue.severity).toBe('warn');
    }
    expect(find(check(newProject()), 'name')).toBeDefined();
    expect(find(check(tidy('Untitledish')), 'name')).toBeUndefined();
    const p = tidy('Untitled');
    expect(applyFix(p, shapes(p), 'name-font')).toMatchObject({ changed: [] });
    expect(p.name).toBe('Untitled');
  });

  it('metrics sanity: guide lines out of order are errors and come first', () => {
    const p = tidy('Untitled');
    p.metrics = { upm: 1000, ascender: 650, descender: 0, xHeight: 700, capHeight: 700 };
    const issues = check(p);
    expect(issues[0].id).toBe('metrics');
    expect(issues[0].severity).toBe('error');
    expect(issues[0].detail).toMatch(/x-height \(700\) is not below the cap height/);
    expect(issues[0].detail).toMatch(/cap height \(700\) is above the ascender \(650\)/);
    expect(issues[0].detail).toMatch(/descender \(0\) is not below the baseline/);
    // errors, then warnings, then hints
    const rank = { error: 0, warn: 1, info: 2 };
    const order = issues.map((i) => rank[i.severity]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order).toContain(1);
    expect(find(check(tidy()), 'metrics')).toBeUndefined();
  });

  it('kerning: extreme values and too many pairs', () => {
    const p = tidy();
    expect(check(p, { kerning: { AV: -85, To: -300, LT: 150 } })).toEqual([]);
    const issues = check(p, { kerning: { AV: -420, To: -60, 'T.': 151, LT: 150 } });
    expect(ids(issues)).toEqual(['kerning-extreme']);
    expect(issues[0].chars).toEqual(['AV', 'T.']);
    expect(issues[0].detail).toContain('AV (-420)');
    const many: Record<string, number> = {};
    for (let i = 0; i < 5001; i++) many[String.fromCharCode(0x4e00 + (i % 100)) + String.fromCharCode(0x4e00 + Math.floor(i / 100))] = -20;
    const count = check(p, { kerning: many });
    expect(ids(count)).toEqual(['kerning-count']);
    expect(count[0].title).toContain('5,001');
  });

  it('gives every issue a plain title, an explanation and unique ids', () => {
    const p = newProject();
    p.blocks = ['latin', 'cyrillic'];
    p.metrics.descender = 10;
    p.glyphs.A = outline('A', [rect(-80, -300, 700, 1200), rect(300, 300, 305, 305)], 500);
    p.glyphs.a = outline('a', p.glyphs.A.contours!, 500);
    const issues = runChecks(p, shapes(p), { kerning: { AV: -900 } });
    expect(new Set(ids(issues)).size).toBe(issues.length);
    for (const want of ['metrics', 'name', 'clipping', 'overflow', 'duplicate-case', 'specks', 'kerning-extreme', 'empty:latin', 'empty:cyrillic']) expect(ids(issues)).toContain(want);
    for (const i of issues) {
      expect(i.title.length).toBeGreaterThan(8);
      expect(i.detail.length).toBeGreaterThan(40);
      expect(i.detail).toMatch(/\.$/);
      expect(Array.isArray(i.chars)).toBe(true);
      if (i.fix) expect(i.fix.label.length).toBeGreaterThan(3);
    }
  });
});

describe('runChecks on a generated alphabet', () => {
  it('reports no errors and no outliers for default stats', () => {
    const p = newProject('Generated Sans');
    p.glyphs = generateGlyphs({ seeds: [], stats: { ...DEFAULT_STATS }, mutation: 0.3, glyphs: {} }, 42);
    const built = buildAll(p, { otf: false }).glyphs;
    const issues = runChecks(p, built);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    for (const id of ['metrics', 'name', 'duplicate-case', 'specks', 'heavy-outlines', 'heavy-font', 'width-outliers', 'height-outliers', 'weight-outliers', 'empty:latin']) expect(ids(issues)).not.toContain(id);
    // the only thing left to say: round strokes dip a little past the default descender; one click fits it
    expect(issues.every((i) => i.id === 'clipping' || i.id === 'overflow')).toBe(true);
    if (find(issues, 'clipping')) {
      applyFix(p, built, 'fit-metrics');
      expect(find(runChecks(p, built), 'clipping')).toBeUndefined();
    }
  });
});
