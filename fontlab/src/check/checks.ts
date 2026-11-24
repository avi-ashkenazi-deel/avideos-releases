/**
 * Automatic quality checks ("is my font OK?"), a lightweight Font Bakery for FontLab.
 * Pure functions, no DOM: `runChecks` looks at the project and its built shapes and returns
 * plain-language issues; `applyFix` repairs the ones that can be repaired automatically.
 */
import type { Contour, FontProject, Glyph, Vec } from '../core/glyph';
import { BLOCK_BY_ID, blockChars, blockOf, projectCharset } from '../core/charsets';
import { bboxOf, signedArea, type BBox } from '../core/geometry';
import { flattenCurves } from '../inputs/draw/curves';

export type Severity = 'error' | 'warn' | 'info';
export type FixId = 'fit-metrics' | 'remove-specks' | 'clear-duplicate-lowercase' | 'name-font' | 'auto-space';
export interface Issue {
  /** check id; the per-script "empty" check adds the block: `empty:latin`, `empty:cyrillic` … */
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  /** letters concerned (kerning issues list pairs, e.g. `AV`) */
  chars: string[];
  fix?: { id: FixId; label: string };
}
export type BuiltShapes = Record<string, { advance: number; contours: Contour[] }>;

/** Every threshold in one place (font units, 1000 per em). */
export const CHECK_LIMITS = {
  /** a contour smaller than this area (units²) … */
  speckArea: 150,
  /** … or fitting inside a box this small is a stray speck */
  speckBox: 12,
  /** ink may pass the ascender / descender by this much before it counts as clipping */
  clipSlack: 5,
  /** margin the "fit metrics" fix leaves beyond the ink */
  fitMargin: 20,
  /** ink may stick out of its advance box by this much on either side */
  overflow: 30,
  /** upper/lowercase pairs count as the same shape within these tolerances */
  sameAdvance: 2, sameBox: 2, sameArea: 0.01,
  /** outlier checks need at least this many letters in a group */
  minGroup: 6,
  /** a letter is an outlier beyond this many robust standard deviations (1.4826 × MAD) … */
  madSigmas: 3,
  /** … and beyond these relative limits */
  widthMax: 1.75, widthMaxWide: 2.3, widthMin: 0.45,
  height: 0.12,
  weight: 0.45,
  /** points in one letter / in the whole font */
  glyphPoints: 1500, fontPoints: 150_000,
  /** kerning pairs outside this range, and how many pairs is too many */
  kernMin: -300, kernMax: 150, kernPairs: 5000,
} as const;

const L = CHECK_LIMITS;

/* ------------------------------------------------------------------ measuring */

/** Same test the letter grid uses: any stroke point or any real contour. */
function hasInk(g: Glyph | undefined | null): boolean {
  if (!g) return false;
  return (g.strokes?.some((s) => s.points.length > 0) ?? false) || (g.contours?.some((c) => c.points.length >= 3) ?? false);
}

function isSpeck(points: Vec[]): boolean {
  if (points.length < 3) return true;
  if (Math.abs(signedArea(points)) < L.speckArea) return true;
  const b = bboxOf(points);
  return b.maxX - b.minX < L.speckBox && b.maxY - b.minY < L.speckBox;
}

/** Indexes of stray specks: tiny contours next to at least one real contour. */
function speckIndexes(contours: Contour[]): number[] {
  const real = contours.filter((c) => c.points.length >= 3);
  if (real.length < 2) return [];
  const out: number[] = [];
  contours.forEach((c, i) => { if (c.points.length >= 3 && isSpeck(c.points)) out.push(i); });
  return out.length < real.length ? out : [];
}

interface Shape { advance: number; box: BBox; area: number; perimeter: number; points: number; contours: Contour[] }

function measure(b: { advance: number; contours: Contour[] } | undefined): Shape | null {
  if (!b) return null;
  const contours = (b.contours ?? []).filter((c) => c.points.length >= 3);
  if (!contours.length) return null;
  let area = 0, perimeter = 0, points = 0;
  const all: Vec[] = [];
  for (const c of contours) {
    area += signedArea(c.points);
    points += c.points.length;
    for (let i = 0, n = c.points.length; i < n; i++) {
      const p = c.points[i], q = c.points[(i + 1) % n];
      perimeter += Math.hypot(q[0] - p[0], q[1] - p[1]);
      all.push(p);
    }
  }
  return { advance: b.advance, box: bboxOf(all), area, perimeter, points, contours };
}

function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Median and robust standard deviation (1.4826 × median absolute deviation). */
function robust(xs: number[]): { med: number; sigma: number } {
  const med = median(xs);
  return { med, sigma: 1.4826 * median(xs.map((x) => Math.abs(x - med))) };
}

const list = (chars: string[], max = 16) => (chars.length > max ? `${chars.slice(0, max).join(' ')} and ${chars.length - max} more` : chars.join(' '));
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const pct = (v: number) => `${Math.round(Math.abs(v) * 100)}%`;

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';
const XHEIGHT_LETTERS = 'acemnorsuvwxz';
const CYRILLIC = blockChars('cyrillic');
/** letters that are narrow / wide by nature: never reported as too narrow / given more room */
const NARROW = new Set([...'IJijlftr1ІіЇїЈјГгוין']);
const WIDE = new Set([...'MWmwЖШЩЮЫжшщюыФфМмש']);

function letterGroups(): { name: string; chars: string[] }[] {
  return [
    { name: 'capitals', chars: [...UPPER] },
    { name: 'lowercase letters', chars: [...LOWER] },
    { name: 'digits', chars: [...DIGITS] },
    { name: 'Cyrillic capitals', chars: CYRILLIC.filter((c) => c !== c.toLowerCase()) },
    { name: 'Cyrillic lowercase letters', chars: CYRILLIC.filter((c) => c !== c.toUpperCase()) },
    { name: 'Hebrew letters', chars: blockChars('hebrew') },
  ];
}

/* ------------------------------------------------------------------ checks */

function checkEmpty(project: FontProject): Issue[] {
  const groups = new Map<string, { total: number; empty: string[] }>();
  for (const ch of projectCharset(project)) {
    const id = blockOf(ch);
    if (!groups.has(id)) groups.set(id, { total: 0, empty: [] });
    const g = groups.get(id)!;
    g.total++;
    if (!hasInk(project.glyphs[ch])) g.empty.push(ch);
  }
  const out: Issue[] = [];
  for (const [id, g] of groups) {
    if (!g.empty.length) continue;
    const name = BLOCK_BY_ID[id]?.name ?? 'Custom characters';
    if (g.empty.length > g.total / 2) {
      out.push({
        id: `empty:${id}`, severity: 'info', chars: g.empty,
        title: `${name}: ${g.empty.length} of ${g.total} still empty`,
        detail: 'Most of this set has nothing in it yet. Draw a few letters, then press Generate to make the rest in the same style.',
      });
    } else {
      out.push({
        id: `empty:${id}`, severity: 'warn', chars: g.empty,
        title: `${name}: ${plural(g.empty.length, 'empty letter')}`,
        detail: `Nothing is drawn for ${list(g.empty)}. Typing them will show a blank box or another font. Draw them, or press Generate to fill them in.`,
      });
    }
  }
  return out;
}

function sameShape(a: Shape, b: Shape): boolean {
  if (Math.abs(a.advance - b.advance) > L.sameAdvance) return false;
  for (const k of ['minX', 'minY', 'maxX', 'maxY'] as const) if (Math.abs(a.box[k] - b.box[k]) > L.sameBox) return false;
  return Math.abs(a.area - b.area) <= L.sameArea * Math.max(Math.abs(a.area), Math.abs(b.area));
}

function duplicateLowercase(shapes: Map<string, Shape>): string[] {
  const out: string[] = [];
  for (const [ch, lower] of shapes) {
    const up = ch.toUpperCase();
    if (up === ch || [...up].length !== 1) continue;
    const upper = shapes.get(up);
    if (upper && sameShape(lower, upper)) out.push(ch);
  }
  return out;
}

function checkDuplicateCase(shapes: Map<string, Shape>): Issue[] {
  const chars = duplicateLowercase(shapes);
  if (!chars.length) return [];
  return [{
    id: 'duplicate-case', severity: 'warn', chars,
    title: `${plural(chars.length, 'lowercase letter')} just ${chars.length === 1 ? 'copies its' : 'copy their'} capital`,
    detail: `The lowercase ${list(chars)} ${chars.length === 1 ? 'is' : 'are'} the same shape as the capital. That is typical of an all-caps font that was imported. Keep it if you want caps only; otherwise clear the copies, then draw or generate real lowercase letters.`,
    fix: { id: 'clear-duplicate-lowercase', label: 'Clear copied lowercase' },
  }];
}

function sourceSpecks(g: Glyph | undefined): boolean {
  return !!g && g.kind === 'outline' && speckIndexes(g.contours ?? []).length > 0;
}

function checkSpecks(project: FontProject, shapes: Map<string, Shape>): Issue[] {
  const chars = new Set<string>();
  let fixable = false;
  for (const [ch, g] of Object.entries(project.glyphs)) if (sourceSpecks(g)) { chars.add(ch); fixable = true; }
  for (const [ch, list] of Object.entries(project.alternates ?? {})) if (Array.isArray(list) && list.some(sourceSpecks)) { chars.add(ch); fixable = true; }
  for (const [ch, s] of shapes) if (speckIndexes(s.contours).length) chars.add(ch);
  if (!chars.size) return [];
  const cs = [...chars];
  return [{
    id: 'specks', severity: 'warn', chars: cs,
    title: `Stray specks in ${plural(cs.length, 'letter')}`,
    detail: `${list(cs)} ${cs.length === 1 ? 'has' : 'have'} tiny leftover shapes (smaller than ${L.speckBox}×${L.speckBox} units), usually dust from a scan or a slip of the pen. They show up as dots in large text.`
      + (fixable ? '' : ' They come from the effects, not from your drawing: turn the effect down or clean the letter by hand.'),
    ...(fixable ? { fix: { id: 'remove-specks' as const, label: 'Remove specks' } } : {}),
  }];
}

function inkExtent(shapes: Map<string, Shape>): { top: number; bottom: number } {
  let top = -Infinity, bottom = Infinity;
  for (const s of shapes.values()) { top = Math.max(top, s.box.maxY); bottom = Math.min(bottom, s.box.minY); }
  return { top, bottom };
}

function checkClipping(project: FontProject, shapes: Map<string, Shape>): Issue[] {
  const { ascender, descender } = project.metrics;
  const high: string[] = [], low: string[] = [];
  for (const [ch, s] of shapes) {
    if (s.box.maxY > ascender + L.clipSlack) high.push(ch);
    if (s.box.minY < descender - L.clipSlack) low.push(ch);
  }
  if (!high.length && !low.length) return [];
  const parts: string[] = [];
  if (high.length) parts.push(`${list(high)} ${high.length === 1 ? 'reaches' : 'reach'} above the top line (ascender ${Math.round(ascender)})`);
  if (low.length) parts.push(`${list(low)} ${low.length === 1 ? 'reaches' : 'reach'} below the bottom line (descender ${Math.round(descender)})`);
  const chars = [...new Set([...high, ...low])];
  return [{
    id: 'clipping', severity: 'warn', chars,
    title: `${plural(chars.length, 'letter')} may get cut off`,
    detail: `${parts.join('; ')}. Many apps crop whatever sticks out of the line box, and lines of text can collide. Fit the font's top and bottom lines to the letters, or make these letters smaller.`,
    fix: { id: 'fit-metrics', label: 'Fit line height to letters' },
  }];
}

function checkOverflow(shapes: Map<string, Shape>): Issue[] {
  const chars: string[] = [];
  for (const [ch, s] of shapes) if (s.box.minX < -L.overflow || s.box.maxX > s.advance + L.overflow) chars.push(ch);
  if (!chars.length) return [];
  return [{
    id: 'overflow', severity: 'warn', chars,
    title: `${plural(chars.length, 'letter')} ${chars.length === 1 ? 'sticks' : 'stick'} out of ${chars.length === 1 ? 'its' : 'their'} space`,
    detail: `${list(chars)} ${chars.length === 1 ? 'is' : 'are'} drawn more than ${L.overflow} units outside the room the letter takes up in a line, so ${chars.length === 1 ? 'it' : 'they'} will overlap neighbours. Fine for a swash; otherwise respace the letters.`,
    fix: { id: 'auto-space', label: 'Space letters automatically' },
  }];
}

interface Outlier { ch: string; ratio: number }

/** Letters of one group whose value is far from the group's median, by a relative limit AND by spread. */
function outliers(chars: string[], shapes: Map<string, Shape>, value: (s: Shape) => number, far: (ratio: number, ch: string) => boolean): { med: number; found: Outlier[] } | null {
  const vals: [string, number][] = [];
  for (const ch of chars) { const s = shapes.get(ch); if (s) vals.push([ch, value(s)]); }
  if (vals.length < L.minGroup) return null;
  const { med, sigma } = robust(vals.map((v) => v[1]));
  if (!(med > 0)) return null;
  const found: Outlier[] = [];
  for (const [ch, v] of vals) {
    if (Math.abs(v - med) <= L.madSigmas * sigma) continue;
    if (far(v / med, ch)) found.push({ ch, ratio: v / med });
  }
  return { med, found };
}

function describe(found: Outlier[], more: string, less: string): string {
  return found.map((o) => `${o.ch} (${pct(o.ratio - 1)} ${o.ratio > 1 ? more : less})`).join(', ');
}

function checkWidths(shapes: Map<string, Shape>): Issue[] {
  const all: Outlier[] = [];
  const notes: string[] = [];
  for (const g of letterGroups()) {
    const r = outliers(g.chars, shapes, (s) => s.box.maxX - s.box.minX, (ratio, ch) =>
      ratio > (WIDE.has(ch) ? L.widthMaxWide : L.widthMax) || (ratio < L.widthMin && !NARROW.has(ch)));
    if (!r?.found.length) continue;
    all.push(...r.found);
    notes.push(`Among the ${g.name}: ${describe(r.found, 'wider', 'narrower')}.`);
  }
  if (!all.length) return [];
  return [{
    id: 'width-outliers', severity: all.some((o) => o.ratio > 2 * L.widthMax || o.ratio < L.widthMin / 2) ? 'warn' : 'info', chars: all.map((o) => o.ch),
    title: `${plural(all.length, 'letter')} much wider or narrower than the rest`,
    detail: `${notes.join(' ')} Compared with the typical letter of the same kind. Check they are not stretched, squashed or drawn at a different size.`,
  }];
}

function checkHeights(project: FontProject, shapes: Map<string, Shape>): Issue[] {
  const all: Outlier[] = [];
  const notes: string[] = [];
  const groups = [
    { name: 'capitals', chars: [...UPPER], line: `cap height ${Math.round(project.metrics.capHeight)}` },
    { name: 'small letters without ascenders', chars: [...XHEIGHT_LETTERS], line: `x-height ${Math.round(project.metrics.xHeight)}` },
  ];
  for (const g of groups) {
    const r = outliers(g.chars, shapes, (s) => s.box.maxY, (ratio) => Math.abs(ratio - 1) > L.height);
    if (!r?.found.length) continue;
    all.push(...r.found);
    notes.push(`Among the ${g.name} (typically ${Math.round(r.med)} units tall, ${g.line}): ${describe(r.found, 'taller', 'shorter')}.`);
  }
  if (!all.length) return [];
  return [{
    id: 'height-outliers', severity: all.some((o) => Math.abs(o.ratio - 1) > 2 * L.height) ? 'warn' : 'info', chars: all.map((o) => o.ch),
    title: `${plural(all.length, 'letter')} taller or shorter than the rest`,
    detail: `${notes.join(' ')} Letters of the same kind normally reach the same height; a line of text looks bumpy when one does not. Ignore this if the bounce is on purpose.`,
  }];
}

function checkWeights(shapes: Map<string, Shape>): Issue[] {
  const all: Outlier[] = [];
  const notes: string[] = [];
  for (const g of letterGroups()) {
    const r = outliers(g.chars, shapes, (s) => (s.perimeter > 0 ? (2 * s.area) / s.perimeter : 0), (ratio) => Math.abs(ratio - 1) > L.weight);
    if (!r?.found.length) continue;
    all.push(...r.found);
    notes.push(`Among the ${g.name}: ${describe(r.found, 'bolder', 'lighter')}.`);
  }
  if (!all.length) return [];
  return [{
    id: 'weight-outliers', severity: all.some((o) => Math.abs(o.ratio - 1) > 2 * L.weight) ? 'warn' : 'info', chars: all.map((o) => o.ch),
    title: `${plural(all.length, 'letter')} much bolder or lighter than the rest`,
    detail: `${notes.join(' ')} Measured as average stroke thickness against the typical letter of the same kind. Uneven weight makes text look blotchy; redraw or regenerate these if it is not intended.`,
  }];
}

function checkHeavy(shapes: Map<string, Shape>): Issue[] {
  const out: Issue[] = [];
  const heavy: string[] = [];
  let total = 0;
  for (const [ch, s] of shapes) { total += s.points; if (s.points > L.glyphPoints) heavy.push(ch); }
  if (heavy.length) {
    out.push({
      id: 'heavy-outlines', severity: 'warn', chars: heavy,
      title: `${plural(heavy.length, 'letter')} with very detailed outlines`,
      detail: `${list(heavy)} ${heavy.length === 1 ? 'has' : 'have'} more than ${L.glyphPoints.toLocaleString('en')} points. That makes the font file large and slow to draw. Lower rough or grainy effects, or simplify the drawing.`,
    });
  }
  if (total > L.fontPoints) {
    out.push({
      id: 'heavy-font', severity: 'warn', chars: [],
      title: 'The whole font is very detailed',
      detail: `All letters together have ${total.toLocaleString('en')} points (more than ${L.fontPoints.toLocaleString('en')}). Expect a large file, slow exports and sluggish text in some apps. Lower rough or grainy effects.`,
    });
  }
  return out;
}

function checkName(project: FontProject): Issue[] {
  const name = (project.name ?? '').trim();
  if (name && !/^untitled\b/i.test(name)) return [];
  return [{
    id: 'name', severity: 'warn', chars: [],
    title: name ? 'The font is still called “Untitled”' : 'The font has no name',
    detail: 'The name is what people see in their font menu, and two fonts with the same name replace each other when installed. Give it a name of its own before you export.',
    fix: { id: 'name-font', label: 'Name the font' },
  }];
}

function checkMetrics(project: FontProject): Issue[] {
  const m = project.metrics;
  const bad: string[] = [];
  if (!(m.xHeight < m.capHeight)) bad.push(`the x-height (${Math.round(m.xHeight)}) is not below the cap height (${Math.round(m.capHeight)})`);
  if (m.capHeight > m.ascender) bad.push(`the cap height (${Math.round(m.capHeight)}) is above the ascender (${Math.round(m.ascender)})`);
  if (!(m.descender < 0)) bad.push(`the descender (${Math.round(m.descender)}) is not below the baseline`);
  if (!(m.ascender > 0)) bad.push(`the ascender (${Math.round(m.ascender)}) is not above the baseline`);
  if (!bad.length) return [];
  return [{
    id: 'metrics', severity: 'error', chars: [],
    title: 'The font’s guide lines are in the wrong order',
    detail: `${bad.join('; ')}. From bottom to top the lines should go: descender, baseline, x-height, cap height, ascender. Apps use them to place lines of text, so fix them in the font settings.`.replace(/^t/, 'T'),
  }];
}

function checkKerning(kerning: Record<string, number>): Issue[] {
  const out: Issue[] = [];
  const pairs = Object.keys(kerning);
  const extreme = pairs.filter((k) => kerning[k] < L.kernMin || kerning[k] > L.kernMax);
  if (extreme.length) {
    out.push({
      id: 'kerning-extreme', severity: 'warn', chars: extreme,
      title: `${plural(extreme.length, 'kerning pair')} with an extreme value`,
      detail: `${list(extreme.map((k) => `${k} (${Math.round(kerning[k])})`), 10)}. Kerning tighter than ${L.kernMin} or looser than +${L.kernMax} usually means the letters themselves are spaced wrong: letters may crash into each other or leave holes. Fix the spacing first, then kern.`,
    });
  }
  if (pairs.length > L.kernPairs) {
    out.push({
      id: 'kerning-count', severity: 'warn', chars: [],
      title: `Too many kerning pairs (${pairs.length.toLocaleString('en')})`,
      detail: `More than ${L.kernPairs.toLocaleString('en')} pairs make the font file big and can fail in older apps. Lower the kerning strength or improve the letter spacing so fewer pairs are needed.`,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ API */

function shapeMap(built: BuiltShapes): Map<string, Shape> {
  const m = new Map<string, Shape>();
  for (const ch of Object.keys(built ?? {})) { const s = measure(built[ch]); if (s) m.set(ch, s); }
  return m;
}

const ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

/**
 * Run every check. `built` is the built shapes keyed by character (`BuildResult.glyphs`);
 * `extra.kerning` the final kerning pairs keyed by the two characters (`{ AV: -80 }`).
 * Returns the issues, errors first. A clean font gives an empty list.
 */
export function runChecks(project: FontProject, built: BuiltShapes, extra?: { kerning?: Record<string, number> }): Issue[] {
  const shapes = shapeMap(built);
  const issues: Issue[] = [
    ...checkMetrics(project),
    ...checkName(project),
    ...checkClipping(project, shapes),
    ...checkOverflow(shapes),
    ...checkDuplicateCase(shapes),
    ...checkSpecks(project, shapes),
    ...checkHeavy(shapes),
    ...(extra?.kerning ? checkKerning(extra.kerning) : []),
    ...checkEmpty(project),
    ...checkHeights(project, shapes),
    ...checkWidths(shapes),
    ...checkWeights(shapes),
  ];
  return issues.map((issue, i) => ({ issue, i })).sort((a, b) => ORDER[a.issue.severity] - ORDER[b.issue.severity] || a.i - b.i).map((x) => x.issue);
}

/** Remove stray specks from one outline glyph (contours and the editable curves). */
function despeck(g: Glyph | undefined): boolean {
  if (!g || g.kind !== 'outline' || !g.contours) return false;
  if (g.curves?.length) {
    // `curves` is the source of truth: judge each curve by its own flattening, then re-flatten
    const flat = g.curves.map((c) => flattenCurves([c])[0]);
    const drop = new Set(speckIndexes(flat.map((c) => c ?? { points: [] })));
    if (!drop.size && !speckIndexes(g.contours).length) return false;
    g.curves = g.curves.filter((_, i) => !drop.has(i));
    g.contours = flattenCurves(g.curves);
    return true;
  }
  const drop = new Set(speckIndexes(g.contours));
  if (!drop.size) return false;
  g.contours = g.contours.filter((_, i) => !drop.has(i));
  return true;
}

/**
 * Apply an automatic fix. Mutates `project` (wrap the call in `store.update`) and returns the
 * characters whose glyphs changed plus a sentence for a toast. `name-font` and `auto-space`
 * belong to the app: they are reported back untouched.
 */
export function applyFix(project: FontProject, built: BuiltShapes, fix: FixId): { changed: string[]; message: string } {
  const shapes = shapeMap(built);
  switch (fix) {
    case 'fit-metrics': {
      const m = project.metrics;
      const done: string[] = [];
      if (shapes.size) {
        const { top, bottom } = inkExtent(shapes);
        if (top > m.ascender + L.clipSlack) { m.ascender = Math.ceil(top) + L.fitMargin; done.push(`ascender raised to ${m.ascender}`); }
        if (bottom < m.descender - L.clipSlack) { m.descender = Math.floor(bottom) - L.fitMargin; done.push(`descender lowered to ${m.descender}`); }
      }
      const text = done.join(', ');
      return { changed: [], message: text ? text[0].toUpperCase() + text.slice(1) + '.' : 'The metrics already fit the letters.' };
    }
    case 'remove-specks': {
      const changed = new Set<string>();
      for (const [ch, g] of Object.entries(project.glyphs)) if (despeck(g)) changed.add(ch);
      for (const [ch, alts] of Object.entries(project.alternates ?? {})) {
        if (Array.isArray(alts)) for (const g of alts) if (despeck(g)) changed.add(ch);
      }
      for (const g of project.seeds ?? []) if (g && g !== project.glyphs[g.char] && despeck(g)) changed.add(g.char);
      const cs = [...changed];
      return { changed: cs, message: cs.length ? `Removed specks from ${plural(cs.length, 'letter')}.` : 'No specks to remove in your drawings.' };
    }
    case 'clear-duplicate-lowercase': {
      const chars = duplicateLowercase(shapes).filter((ch) => project.glyphs[ch]);
      for (const ch of chars) delete project.glyphs[ch];
      if (chars.length && Array.isArray(project.seeds)) project.seeds = project.seeds.filter((g) => !chars.includes(g.char));
      return { changed: chars, message: chars.length ? `Cleared ${plural(chars.length, 'copied lowercase letter')}. Draw or generate new ones.` : 'No copied lowercase letters found.' };
    }
    case 'name-font':
      return { changed: [], message: 'Give the font a name.' };
    case 'auto-space':
      return { changed: [], message: 'Run automatic spacing.' };
  }
}
