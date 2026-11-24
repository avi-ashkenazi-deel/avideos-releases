/**
 * UFO 3 export (Unified Font Object): the open source format Glyphs, FontLab 8, RoboFont and
 * Fontra all open. Pure TypeScript — builds the text files of a `.ufo` folder and packs them
 * into an uncompressed zip. Spec: https://unifiedfontobject.org/versions/ufo3/
 *
 * Contour direction: our outlines are counter-clockwise for outer contours and clockwise for
 * holes (y up). That is the PostScript / cubic-outline convention UFO sources use, so contours
 * are written as they are, never reversed.
 */
import type { Contour, FontMetrics, Vec } from '../core/glyph';
import { dedupe } from '../core/geometry';
import { contourToCubics, flattenCubic, isLine, type Cubic } from '../outline/fitCurves';
import { defaultLigatures, glyphName } from './otf';
import { slug } from '../project/storage';
import { zipStore } from './zip';

export interface UfoGlyph { name: string; unicodes: number[]; advance: number; contours: Contour[] }

export interface UfoInput {
  familyName: string;
  styleName?: string;
  metrics: FontMetrics;
  /** already named; order = glyph order. `.notdef` and `space` are added in front when missing. */
  glyphs: UfoGlyph[];
  /** by glyph NAME: `{ A: { V: -85 } }`. Pairs naming a glyph that isn't in the font are dropped. */
  kerning?: Record<string, Record<string, number>>;
  /** contents of features.fea (OpenType feature file syntax) */
  features?: string;
  /** curve fitting tolerance in font units (default 1.5, as the OTF export) */
  tolerance?: number;
  note?: string;
}

const CREATOR = 'com.fontlab-funky.app';
const NOTDEF_ADVANCE = 500;

/* ------------------------------------------------------------------ file names */

const ILLEGAL = new Set<string>(['"', '*', '+', '/', ':', '<', '>', '?', '[', '\\', ']', '|', '\u007f']);
const RESERVED = new Set<string>(['con', 'prn', 'aux', 'clock$', 'nul', 'a:-z:', 'com1', 'com2', 'com3', 'com4', 'lpt1', 'lpt2', 'lpt3']);
const MAX_NAME = 255;

/**
 * UFO 3 "user name to file name" convention for a glyph: `A` → `A_.glif`, `a` → `a.glif`,
 * `A.alt` → `A_.alt.glif`, `.notdef` → `_notdef.glif`, `con` → `_con.glif`.
 * Uppercase letters get a trailing underscore so names that differ only in case don't collide on
 * case-insensitive disks; illegal characters become `_`; reserved DOS device names get a leading
 * `_`. `used` holds the lowercased file names already taken: a clash gets a 15-digit counter, and
 * the returned name is added to the set.
 */
export function glifFileName(glyphName: string, used?: Set<string>): string {
  const suffix = '.glif';
  let name = [...glyphName];
  if (name[0] === '.') name[0] = '_';
  let user = name.map((ch) => {
    if (ILLEGAL.has(ch) || ch.codePointAt(0)! < 32) return '_';
    return ch !== ch.toLowerCase() ? ch + '_' : ch;
  }).join('');
  user = [...user].slice(0, MAX_NAME - suffix.length).join('');
  user = user.split('.').map((part) => (RESERVED.has(part.toLowerCase()) ? '_' + part : part)).join('.');
  let full = user + suffix;
  if (used?.has(full.toLowerCase())) {
    name = [...user];
    if (name.length + suffix.length + 15 > MAX_NAME) name = name.slice(0, MAX_NAME - suffix.length - 15);
    const stem = name.join('');
    for (let n = 1; ; n++) {
      full = stem + String(n).padStart(15, '0') + suffix;
      if (!used.has(full.toLowerCase())) break;
    }
  }
  used?.add(full.toLowerCase());
  return full;
}

/* ------------------------------------------------------------------ XML / plist */

/** Escape text for XML content and attributes; characters XML 1.0 cannot carry are dropped. */
export function xmlEscape(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

type Plist = string | number | boolean | Plist[] | { [key: string]: Plist };

function plistValue(v: Plist, indent: string): string {
  if (typeof v === 'string') return `${indent}<string>${xmlEscape(v)}</string>\n`;
  if (typeof v === 'number') return Number.isInteger(v) ? `${indent}<integer>${v}</integer>\n` : `${indent}<real>${v}</real>\n`;
  if (typeof v === 'boolean') return `${indent}<${v ? 'true' : 'false'}/>\n`;
  if (Array.isArray(v)) {
    if (!v.length) return `${indent}<array/>\n`;
    return `${indent}<array>\n${v.map((x) => plistValue(x, indent + '  ')).join('')}${indent}</array>\n`;
  }
  const keys = Object.keys(v);
  if (!keys.length) return `${indent}<dict/>\n`;
  return `${indent}<dict>\n${keys.map((k) => `${indent}  <key>${xmlEscape(k)}</key>\n${plistValue(v[k], indent + '  ')}`).join('')}${indent}</dict>\n`;
}

function plist(v: Plist): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + `<plist version="1.0">\n${plistValue(v, '  ')}</plist>\n`;
}

/* ------------------------------------------------------------------ outlines */

export interface OutPoint { x: number; y: number; type?: 'line' | 'curve'; smooth?: boolean }
interface Seg { curve: boolean; c1: Vec; c2: Vec; to: Vec; /** unit-less directions leaving the start / arriving at the end */ out: Vec; in: Vec }

const rint = (v: number) => { const n = Math.round(v); return n === 0 ? 0 : n; };
const rvec = (p: Vec): Vec => [rint(p[0]), rint(p[1])];
const same = (a: Vec, b: Vec) => a[0] === b[0] && a[1] === b[1];
const dir = (a: Vec, b: Vec): Vec => [b[0] - a[0], b[1] - a[1]];
const tiny = (v: Vec) => Math.hypot(v[0], v[1]) < 1e-6;

function tangents(c: Cubic, line: boolean): { out: Vec; in: Vec } {
  const chord = dir(c[0], c[3]);
  if (line) return { out: chord, in: chord };
  let out = dir(c[0], c[1]); if (tiny(out)) out = dir(c[0], c[2]); if (tiny(out)) out = chord;
  let inn = dir(c[2], c[3]); if (tiny(inn)) inn = dir(c[1], c[3]); if (tiny(inn)) inn = chord;
  return { out, in: inn };
}

/** Two directions continue each other within ~4°. */
function continues(a: Vec, b: Vec): boolean {
  const la = Math.hypot(a[0], a[1]), lb = Math.hypot(b[0], b[1]);
  if (la < 1e-6 || lb < 1e-6) return false;
  const dot = a[0] * b[0] + a[1] * b[1], cross = a[0] * b[1] - a[1] * b[0];
  return dot > 0 && Math.abs(cross) <= 0.07 * la * lb;
}

function distToPolyline(p: Vec, run: Vec[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < run.length; i++) {
    const a = run[i], b = run[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]));
  }
  return best;
}

/**
 * Fitted cubics for one polygon, checked against the polygon. The fitter only measures how far
 * the polygon's points are from the curve, so on nearly straight, slightly wobbly runs it can
 * return a curve that passes the points but swings thousands of units away in between. Here every
 * curve is sampled and compared with the stretch of polygon it replaces; a curve that strays
 * (by more than three times the tolerance) is swapped for that stretch as straight lines.
 */
function checkedCubics(contour: Contour, tolerance: number): { start: Vec; segments: Cubic[] } {
  const cc = contourToCubics(contour, tolerance);
  if (!cc.segments.length) return cc;
  const pts = dedupe(contour.points, 0.05); // the same clean-up the fitter starts from
  const n = pts.length;
  const at = (p: Vec, from: number, wrap: boolean): number => {
    for (let k = 0; k < n; k++) {
      const i = from + k;
      if (!wrap && i >= n) break;
      const q = pts[i % n];
      if (Math.abs(q[0] - p[0]) < 1e-6 && Math.abs(q[1] - p[1]) < 1e-6) return i;
    }
    return -1;
  };
  const first = at(cc.start, 0, false);
  if (first < 0) return cc;
  const limit = Math.max(3 * tolerance, 4.5);
  const segments: Cubic[] = [];
  let cur = first; // index into pts, counted past n once we wrap
  cc.segments.forEach((seg, k) => {
    const last = k === cc.segments.length - 1;
    const end = last ? first + n : at(seg[3], cur + 1, true);
    if (end < 0 || end > first + n) { segments.push(seg); return; }
    if (!isLine(seg)) {
      const run: Vec[] = [];
      for (let i = cur; i <= end; i++) run.push(pts[i % n]);
      if (flattenCubic(seg, 16).some((p) => distToPolyline(p, run) > limit)) {
        for (let i = 1; i < run.length; i++) segments.push([run[i - 1], run[i - 1], run[i], run[i]]);
        cur = end;
        return;
      }
    }
    segments.push(seg);
    cur = end;
  });
  return { start: cc.start, segments };
}

/**
 * One flattened polygon → the point cycle of a closed UFO contour: curves are fitted with the
 * same fitter the OTF export uses, coordinates are rounded to whole units, the start point comes
 * first and is not repeated at the end (a UFO contour is closed by being a cycle), and each
 * `curve` point is preceded by its two off-curve handles.
 */
export function contourToUfoPoints(contour: Contour, tolerance = 1.5): OutPoint[] {
  const cc = checkedCubics(contour, tolerance);
  if (!cc.segments.length) return [];
  const start = rvec(cc.start);
  const segs: Seg[] = [];
  let cur = start;
  for (const raw of cc.segments) {
    const line = isLine(raw);
    const to = rvec(raw[3]);
    const c1 = rvec(raw[1]), c2 = rvec(raw[2]);
    // rounding can collapse a short segment onto a single point: drop it
    if (same(to, cur) && (line || (same(c1, cur) && same(c2, cur)))) continue;
    segs.push({ curve: !line, c1, c2, to, ...tangents(raw, line) });
    cur = to;
  }
  if (!segs.length) return [];
  if (!same(cur, start)) segs.push({ curve: false, c1: cur, c2: start, to: start, out: dir(cur, start), in: dir(cur, start) });
  if (segs.length < 3 && segs.every((s) => !s.curve)) return []; // a line there and back: no area

  const n = segs.length;
  const node = (i: number): OutPoint => {
    const a = segs[i], b = segs[(i + 1) % n];
    const p: OutPoint = { x: a.to[0], y: a.to[1], type: a.curve ? 'curve' : 'line' };
    if ((a.curve || b.curve) && continues(a.in, b.out)) p.smooth = true;
    return p;
  };
  const handles = (s: Seg): OutPoint[] => (s.curve ? [{ x: s.c1[0], y: s.c1[1] }, { x: s.c2[0], y: s.c2[1] }] : []);
  // the last segment ends on the start point: write that point first, its handles last
  const pts: OutPoint[] = [node(n - 1)];
  for (let i = 0; i < n - 1; i++) pts.push(...handles(segs[i]), node(i));
  pts.push(...handles(segs[n - 1]));
  return pts;
}

/** One glyph as GLIF format 2 XML. */
export function glifXml(g: UfoGlyph, tolerance = 1.5): string {
  let s = '<?xml version="1.0" encoding="UTF-8"?>\n';
  s += `<glyph name="${xmlEscape(g.name)}" format="2">\n`;
  s += `  <advance width="${Math.max(0, rint(g.advance))}"/>\n`;
  for (const u of g.unicodes) s += `  <unicode hex="${u.toString(16).toUpperCase().padStart(4, '0')}"/>\n`;
  const contours = g.contours.map((c) => contourToUfoPoints(c, tolerance)).filter((pts) => pts.length);
  if (contours.length) {
    s += '  <outline>\n';
    for (const pts of contours) {
      s += '    <contour>\n';
      for (const p of pts) s += `      <point x="${p.x}" y="${p.y}"${p.type ? ` type="${p.type}"` : ''}${p.smooth ? ' smooth="yes"' : ''}/>\n`;
      s += '    </contour>\n';
    }
    s += '  </outline>\n';
  }
  return s + '</glyph>\n';
}

/* ------------------------------------------------------------------ the UFO */

function notdefGlyph(): UfoGlyph {
  // same box as the OTF export: outer counter-clockwise, inner clockwise
  return {
    name: '.notdef', unicodes: [], advance: NOTDEF_ADVANCE,
    contours: [
      { points: [[50, 0], [450, 0], [450, 700], [50, 700]] },
      { points: [[100, 50], [100, 650], [400, 650], [400, 50]] },
    ],
  };
}

/** `.notdef` first, then `space`, then the caller's glyphs; names unique, one glyph per code point. */
function glyphList(input: UfoInput): UfoGlyph[] {
  const given = input.glyphs.filter((g) => g && typeof g.name === 'string' && g.name.length > 0);
  const list: UfoGlyph[] = [];
  if (!given.some((g) => g.name === '.notdef')) list.push(notdefGlyph());
  if (!given.some((g) => g.name === 'space' || g.unicodes?.includes(32))) {
    list.push({ name: 'space', unicodes: [32], advance: Math.round(input.metrics.upm * 0.28), contours: [] });
  }
  list.push(...given);
  const names = new Set<string>(), codes = new Set<number>();
  const out: UfoGlyph[] = [];
  for (const g of list) {
    if (names.has(g.name)) continue;
    names.add(g.name);
    const unicodes: number[] = [];
    for (const u of g.unicodes ?? []) {
      if (!Number.isInteger(u) || u < 0 || u > 0x10ffff || codes.has(u)) continue;
      codes.add(u); unicodes.push(u);
    }
    out.push({ name: g.name, unicodes, advance: Number.isFinite(g.advance) ? g.advance : 0, contours: g.contours ?? [] });
  }
  return out;
}

function fontInfo(input: UfoInput, glyphs: UfoGlyph[]): Plist {
  const m = input.metrics;
  const family = input.familyName.trim() || 'FontLab';
  const style = (input.styleName ?? 'Regular').trim() || 'Regular';
  const asc = Math.round(m.ascender), desc = Math.round(m.descender);
  let yMax = asc, yMin = desc;
  for (const g of glyphs) for (const c of g.contours) for (const p of c.points) {
    if (p[1] > yMax) yMax = p[1];
    if (p[1] < yMin) yMin = p[1];
  }
  const info: { [key: string]: Plist } = {
    familyName: family,
    styleName: style,
    unitsPerEm: m.upm,
    ascender: asc,
    descender: desc,
    xHeight: Math.round(m.xHeight),
    capHeight: Math.round(m.capHeight),
    versionMajor: 1,
    versionMinor: 0,
    postscriptFontName: psName(family, style),
    openTypeOS2TypoAscender: asc,
    openTypeOS2TypoDescender: desc,
    openTypeOS2TypoLineGap: 0,
    openTypeHheaAscender: asc,
    openTypeHheaDescender: desc,
    openTypeHheaLineGap: 0,
    // the "win" values are a clipping box on Windows: make them cover the ink
    openTypeOS2WinAscent: Math.max(0, Math.ceil(yMax)),
    openTypeOS2WinDescent: Math.max(0, Math.ceil(-yMin)),
  };
  const map = ({ regular: 'regular', italic: 'italic', bold: 'bold', 'bold italic': 'bold italic' } as Record<string, string>)[style.toLowerCase()];
  if (map) { info.styleMapFamilyName = family; info.styleMapStyleName = map; }
  if (input.note) info.note = input.note;
  return info;
}

/** PostScript font name: letters and digits only, `Family-Style`, at most 63 characters. */
function psName(family: string, style: string): string {
  const clean = (s: string) => s.normalize('NFKD').replace(/[^A-Za-z0-9]/g, '');
  return `${clean(family).slice(0, 40) || 'Font'}-${clean(style).slice(0, 22) || 'Regular'}`;
}

function kerningPlist(kerning: Record<string, Record<string, number>>, names: Set<string>): Plist | null {
  const out: { [key: string]: Plist } = {};
  for (const first of Object.keys(kerning).sort()) {
    if (!names.has(first)) continue;
    const row: { [key: string]: Plist } = {};
    for (const second of Object.keys(kerning[first] ?? {}).sort()) {
      const v = Math.round(kerning[first][second]);
      if (names.has(second) && Number.isFinite(v) && v !== 0) row[second] = v;
    }
    if (Object.keys(row).length) out[first] = row;
  }
  return Object.keys(out).length ? out : null;
}

/** The files of the UFO, paths relative to the `<Family>-<Style>.ufo/` folder. */
export function ufoFiles(input: UfoInput): { path: string; data: string }[] {
  const tol = input.tolerance ?? 1.5;
  const glyphs = glyphList(input);
  const files: { path: string; data: string }[] = [];
  files.push({ path: 'metainfo.plist', data: plist({ creator: CREATOR, formatVersion: 3 }) });
  files.push({ path: 'fontinfo.plist', data: plist(fontInfo(input, glyphs)) });
  files.push({ path: 'layercontents.plist', data: plist([['public.default', 'glyphs']]) });
  files.push({ path: 'lib.plist', data: plist({ 'public.glyphOrder': glyphs.map((g) => g.name) }) });
  if (input.kerning) {
    const k = kerningPlist(input.kerning, new Set(glyphs.map((g) => g.name)));
    if (k) files.push({ path: 'kerning.plist', data: plist(k) });
  }
  if (input.features && input.features.trim()) files.push({ path: 'features.fea', data: input.features.endsWith('\n') ? input.features : input.features + '\n' });
  const used = new Set<string>();
  const contents: { [key: string]: Plist } = {};
  const glifs: { path: string; data: string }[] = [];
  for (const g of glyphs) {
    const file = glifFileName(g.name, used);
    contents[g.name] = file;
    glifs.push({ path: `glyphs/${file}`, data: glifXml(g, tol) });
  }
  files.push({ path: 'glyphs/contents.plist', data: plist(contents) });
  files.push(...glifs);
  return files;
}

/** Folder name of the UFO: `<Family>-<Style>.ufo`, letters, digits, `_` and `-` only (any script). */
export function ufoFolderName(familyName: string, styleName = 'Regular'): string {
  const clean = (s: string) => s.replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 80);
  return `${clean(familyName) || 'Font'}-${clean(styleName) || 'Regular'}.ufo`;
}

/** The whole UFO as a zip: `<slug>.ufo.zip` holding one `<Family>-<Style>.ufo` folder. */
export function ufoZip(input: UfoInput, date?: Date): { name: string; bytes: Uint8Array } {
  const style = (input.styleName ?? 'Regular').trim() || 'Regular';
  const folder = ufoFolderName(input.familyName, style);
  const files = ufoFiles(input).map((f) => ({ path: `${folder}/${f.path}`, data: f.data }));
  const base = slug(input.familyName) + (style.toLowerCase() === 'regular' ? '' : '-' + slug(style));
  return { name: `${base}.ufo.zip`, bytes: zipStore(files, date) };
}

/* ------------------------------------------------------------------ from a build */

interface Built { char: string; unicode: number; advance: number; contours: Contour[] }

/**
 * Convenience for the app: turn what `buildAll` returns into a `UfoInput`, mirroring what the OTF
 * export puts in the font — glyph names from `glyphName`, glyphs in code point order, stylistic
 * alternates (`a#ss01` → `a.ss01`, with `ss01`–`ss03`, `salt` and `aalt` features), tabular figures
 * (`zero.tnum` …, feature `tnum`) and the arrow ligatures (`liga`). `kerning` is keyed by the two
 * characters of a pair (`{ AV: -80 }`), like `project.kerning.pairs`.
 */
export function ufoInputFromBuild(opts: {
  familyName: string; styleName?: string; metrics: FontMetrics;
  glyphs: Record<string, Built>;
  alternates?: Record<string, Built>;
  kerning?: Record<string, number>;
  tolerance?: number; note?: string;
}): UfoInput {
  const hasInk = (b: Built | undefined): b is Built => !!b && b.contours.some((c) => c.points.length >= 3);
  const base = Object.values(opts.glyphs).filter(hasInk).sort((a, b) => a.unicode - b.unicode);
  const nameOf = (b: Built) => glyphName(b.char, b.unicode);
  const glyphs: UfoGlyph[] = [];
  const names = new Set<string>(['.notdef', 'space']);
  const byChar = new Map<string, string>([[' ', 'space']]);
  for (const b of base) {
    const name = nameOf(b);
    if (names.has(name) || b.unicode === 32) continue;
    names.add(name); byChar.set(b.char, name);
    glyphs.push({ name, unicodes: [b.unicode], advance: Math.max(1, Math.round(b.advance)), contours: b.contours });
  }

  const fea: string[] = [];
  const block = (tag: string, rules: string[]) => { if (rules.length) fea.push(`feature ${tag} {\n${rules.map((r) => `  ${r}\n`).join('')}} ${tag};\n`); };

  // arrow ligatures, longest first (as the OTF export orders them)
  const liga: string[] = [];
  for (const l of defaultLigatures().slice().sort((a, b) => b.sub.length - a.sub.length)) {
    if (names.has(l.by) && l.sub.every((n) => names.has(n))) liga.push(`sub ${l.sub.join(' ')} by ${l.by};`);
  }

  // stylistic alternates
  const sets: Record<string, string[]> = {};
  const salt = new Map<string, string[]>();
  for (const key of Object.keys(opts.alternates ?? {}).sort()) {
    const alt = opts.alternates![key];
    const [ch, tag] = key.split('#');
    const baseName = byChar.get(ch);
    if (!baseName || !/^ss\d\d$/.test(tag ?? '') || !hasInk(alt)) continue;
    const name = `${baseName}.${tag}`;
    if (names.has(name)) continue;
    names.add(name);
    glyphs.push({ name, unicodes: [], advance: Math.max(1, Math.round(alt.advance)), contours: alt.contours });
    (sets[tag] ??= []).push(`sub ${baseName} by ${name};`);
    salt.set(baseName, [...(salt.get(baseName) ?? []), name]);
  }

  // tabular figures: every digit on the widest digit's advance, ink centred
  const digits = [...'0123456789'].map((d) => opts.glyphs[d]).filter(hasInk);
  const tnum: string[] = [];
  if (digits.length) {
    const width = Math.max(...digits.map((b) => Math.max(1, Math.round(b.advance))));
    for (const b of digits) {
      const baseName = byChar.get(b.char);
      if (!baseName || names.has(`${baseName}.tnum`)) continue;
      const dx = (width - b.advance) / 2;
      names.add(`${baseName}.tnum`);
      glyphs.push({
        name: `${baseName}.tnum`, unicodes: [], advance: width,
        contours: dx ? b.contours.map((c) => ({ points: c.points.map(([x, y]) => [x + dx, y] as Vec) })) : b.contours,
      });
      tnum.push(`sub ${baseName} by ${baseName}.tnum;`);
    }
  }

  // feature blocks in alphabetical tag order
  const anyAlt = [...salt].map(([b, alts]) => `sub ${b} from [${alts.join(' ')}];`);
  block('aalt', anyAlt);
  block('liga', liga);
  block('salt', anyAlt);
  for (const tag of Object.keys(sets).sort()) block(tag, sets[tag]);
  block('tnum', tnum);
  const features = fea.length ? `languagesystem DFLT dflt;\nlanguagesystem latn dflt;\n\n${fea.join('\n')}` : undefined;

  let kerning: Record<string, Record<string, number>> | undefined;
  for (const [pair, value] of Object.entries(opts.kerning ?? {})) {
    const chars = [...pair];
    if (chars.length !== 2 || !Number.isFinite(value) || !Math.round(value)) continue;
    const a = byChar.get(chars[0]), b = byChar.get(chars[1]);
    if (!a || !b) continue;
    ((kerning ??= {})[a] ??= {})[b] = Math.round(value);
  }

  return { familyName: opts.familyName, styleName: opts.styleName, metrics: opts.metrics, glyphs, kerning, features, tolerance: opts.tolerance, note: opts.note };
}
