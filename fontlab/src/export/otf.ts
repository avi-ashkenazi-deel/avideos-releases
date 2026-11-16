import { Font, Glyph as OTGlyph, Path as OTPath } from '../vendor/opentype';
import type { Contour, FontMetrics } from '../core/glyph';
import { contourToCubics, isLine } from '../outline/fitCurves';
import { bboxContours } from '../core/geometry';

export interface OutlineGlyph {
  char: string;
  unicode: number;
  advance: number;
  contours: Contour[];
}

export interface BuildOptions {
  familyName: string;
  styleName?: string;
  metrics: FontMetrics;
  /** curve-fit tolerance in font units */
  tolerance?: number;
  /** OpenType layout features (GSUB): alternates, tabular figures, ligatures */
  features?: FontFeatures;
}

/** An unencoded glyph reached only through GSUB (e.g. `a.ss01`, `zero.tnum`). */
export interface FeatureGlyph { name: string; advance: number; contours: Contour[] }

export interface FontFeatures {
  /** extra unencoded glyphs (alternates, tabular digits) appended after the cmap'd glyphs */
  extraGlyphs?: FeatureGlyph[];
  /** single substitutions per feature tag: { ss01: [['a','a.ss01']], tnum: [['zero','zero.tnum'], ...] } — by glyph NAME */
  singles?: Record<string, [string, string][]>;
  /** alternates for salt/aalt: base name → alternate names */
  alternates?: Record<string, string[]>;
  /** ligatures: component names → ligature name, under feature tag (default 'liga') */
  ligatures?: { feature?: string; sub: string[]; by: string }[];
}

function contoursToPath(contours: Contour[], tol: number): any {
  const path = new OTPath();
  for (const c of contours) {
    const cc = contourToCubics(c, tol);
    if (!cc.segments.length) continue;
    path.moveTo(r(cc.start[0]), r(cc.start[1]));
    for (const seg of cc.segments) {
      if (isLine(seg)) path.lineTo(r(seg[3][0]), r(seg[3][1]));
      else path.curveTo(r(seg[1][0]), r(seg[1][1]), r(seg[2][0]), r(seg[2][1]), r(seg[3][0]), r(seg[3][1]));
    }
    path.close();
  }
  return path;
}
const r = (v: number) => Math.round(v * 10) / 10;

/** Adobe Glyph List names for ASCII punctuation / symbols so font editors show familiar names. */
const AGL: Record<string, string> = {
  ' ': 'space', '!': 'exclam', '"': 'quotedbl', '#': 'numbersign', '$': 'dollar', '%': 'percent', '&': 'ampersand', "'": 'quotesingle',
  '(': 'parenleft', ')': 'parenright', '*': 'asterisk', '+': 'plus', ',': 'comma', '-': 'hyphen', '.': 'period', '/': 'slash',
  ':': 'colon', ';': 'semicolon', '<': 'less', '=': 'equal', '>': 'greater', '?': 'question', '@': 'at', '[': 'bracketleft',
  '\\': 'backslash', ']': 'bracketright', '^': 'asciicircum', '_': 'underscore', '`': 'grave', '{': 'braceleft', '|': 'bar',
  '}': 'braceright', '~': 'asciitilde', '¡': 'exclamdown', '¢': 'cent', '£': 'sterling', '¥': 'yen', '§': 'section', '©': 'copyright',
  '«': 'guillemotleft', '¬': 'logicalnot', '®': 'registered', '°': 'degree', '±': 'plusminus', '¶': 'paragraph', '·': 'periodcentered',
  '»': 'guillemotright', '¿': 'questiondown', '×': 'multiply', '÷': 'divide', '–': 'endash', '—': 'emdash', '‘': 'quoteleft',
  '’': 'quoteright', '“': 'quotedblleft', '”': 'quotedblright', '†': 'dagger', '‡': 'daggerdbl', '•': 'bullet', '…': 'ellipsis',
  '€': 'Euro', '™': 'trademark', 'µ': 'mu',
  '←': 'arrowleft', '↑': 'arrowup', '→': 'arrowright', '↓': 'arrowdown', '↔': 'arrowboth', '⇒': 'arrowdblright',
};

export function glyphName(char: string, unicode: number): string {
  if (/^[A-Za-z]$/.test(char)) return char;
  if (/^[0-9]$/.test(char)) return ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'][+char];
  if (AGL[char]) return AGL[char];
  return 'uni' + unicode.toString(16).toUpperCase().padStart(4, '0');
}

/** Build an opentype.js Font from finished outline glyphs. */
export function buildFont(glyphs: OutlineGlyph[], opts: BuildOptions): any {
  const tol = opts.tolerance ?? 1.5;
  const notdef = new OTGlyph({ name: '.notdef', unicode: 0, advanceWidth: 500, path: notdefPath() });
  const space = new OTGlyph({ name: 'space', unicode: 32, advanceWidth: Math.round(opts.metrics.upm * 0.28), path: new OTPath() });
  const list = [notdef, space];
  const seen = new Set<number>([0, 32]);
  for (const g of glyphs.slice().sort((a, b) => a.unicode - b.unicode)) {
    if (seen.has(g.unicode)) continue;
    seen.add(g.unicode);
    const path = contoursToPath(g.contours, tol);
    const bb = bboxContours(g.contours);
    list.push(new OTGlyph({
      name: glyphName(g.char, g.unicode),
      unicode: g.unicode,
      advanceWidth: Math.max(1, Math.round(g.advance)),
      leftSideBearing: Math.round(bb.minX),
      path,
    }));
  }
  const feats = opts.features;
  if (feats?.extraGlyphs?.length) {
    const names = new Set<string>(list.map((g: any) => g.name));
    for (const g of feats.extraGlyphs) {
      if (!g.name || names.has(g.name)) continue;
      names.add(g.name);
      const ink = g.contours.some((c) => c.points.length);
      list.push(new OTGlyph({
        name: g.name,
        advanceWidth: Math.max(1, Math.round(g.advance)),
        leftSideBearing: ink ? Math.round(bboxContours(g.contours).minX) : 0,
        path: ink ? contoursToPath(g.contours, tol) : new OTPath(),
      }));
    }
  }
  const font = new Font({
    familyName: opts.familyName,
    styleName: opts.styleName ?? 'Regular',
    unitsPerEm: opts.metrics.upm,
    ascender: opts.metrics.ascender,
    descender: opts.metrics.descender,
    glyphs: list,
  });
  if (feats) {
    try { addFeatures(font, list, feats); } catch (e) {
      // a broken feature set must never cost the user their font
      console.warn('GSUB features skipped', e);
      delete font.tables.gsub;
    }
  }
  return font;
}

/** Unicode values for glyph names that aren't derivable from the AGL table above (kept here so
 *  ligature targets resolve whichever name the table gives them). */
const NAME_UNICODES: Record<string, number> = {
  arrowleft: 0x2190, arrowup: 0x2191, arrowright: 0x2192, arrowdown: 0x2193, arrowboth: 0x2194, arrowdblright: 0x21d2,
};

function nameToUnicode(name: string): number | undefined {
  const m = /^uni([0-9A-F]{4,6})$/i.exec(name) ?? /^u([0-9A-F]{5,6})$/i.exec(name);
  if (m) return parseInt(m[1], 16);
  if (/^[A-Za-z]$/.test(name)) return name.charCodeAt(0);
  const digit = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'].indexOf(name);
  if (digit >= 0) return 48 + digit;
  for (const ch in AGL) if (AGL[ch] === name) return ch.codePointAt(0);
  return NAME_UNICODES[name];
}

/** Write GSUB rules (by glyph name) into `font`. Rules naming a glyph that isn't in the font are
 *  skipped, so partial builds and missing arrows/alternates just drop the rule. Every feature is
 *  registered under DFLT and latn (sharing the same feature records). */
function addFeatures(font: any, list: any[], feats: FontFeatures): void {
  const byName = new Map<string, number>();
  const byUni = new Map<number, number>();
  list.forEach((g, i) => {
    if (i === 0) return; // never substitute to/from .notdef
    if (!byName.has(g.name)) byName.set(g.name, i);
    if (typeof g.unicode === 'number' && !byUni.has(g.unicode)) byUni.set(g.unicode, i);
  });
  const idx = (name: string): number => {
    const i = byName.get(name);
    if (i !== undefined) return i;
    const u = nameToUnicode(name);
    return (u !== undefined && byUni.get(u)) || -1;
  };

  type Op = { kind: 'single'; sub: number; by: number } | { kind: 'alt'; sub: number; by: number[] } | { kind: 'lig'; sub: number[]; by: number };
  const ops = new Map<string, Op[]>();
  const push = (tag: string, op: Op) => { if (!ops.has(tag)) ops.set(tag, []); ops.get(tag)!.push(op); };

  for (const [tag, pairs] of Object.entries(feats.singles ?? {})) {
    for (const [a, b] of pairs) {
      const s = idx(a), t = idx(b);
      if (s > 0 && t > 0 && s !== t) push(tag, { kind: 'single', sub: s, by: t });
    }
  }
  for (const [base, alts] of Object.entries(feats.alternates ?? {})) {
    const s = idx(base);
    const by = alts.map(idx).filter((t) => t > 0 && t !== s);
    if (s <= 0 || !by.length) continue;
    push('aalt', { kind: 'alt', sub: s, by });
    push('salt', { kind: 'alt', sub: s, by });
  }
  // longest first, so `<->` wins over `<-` (first match in a ligature set is taken)
  const ligs = (feats.ligatures ?? []).map((l, i) => ({ l, i })).sort((a, b) => b.l.sub.length - a.l.sub.length || a.i - b.i);
  for (const { l } of ligs) {
    if (l.sub.length < 2) continue;
    const sub = l.sub.map(idx), by = idx(l.by);
    if (by > 0 && sub.every((s) => s > 0)) push(l.feature ?? 'liga', { kind: 'lig', sub, by });
  }
  if (!ops.size) return;

  const gsub = font.substitution;
  // opentype.js requires features to be created in alphabetical tag order
  for (const tag of [...ops.keys()].sort()) {
    for (const op of ops.get(tag)!) {
      if (op.kind === 'single') gsub.addSingle(tag, { sub: op.sub, by: op.by }, 'DFLT');
      else if (op.kind === 'alt') gsub.addAlternate(tag, { sub: op.sub, by: op.by }, 'DFLT');
      else gsub.addLigature(tag, { sub: op.sub, by: op.by }, 'DFLT');
    }
  }
  // Mirror DFLT under latn: shapers pick the text's script table first; sharing the feature
  // indexes keeps one set of lookups.
  const dflt = gsub.getScriptTable('DFLT');
  const latn = gsub.getScriptTable('latn', true);
  latn.defaultLangSys.featureIndexes = dflt.defaultLangSys.featureIndexes.slice();
}

/** Programming-style arrow ligatures. Components/targets resolve by name or unicode, and rules
 *  whose glyphs are missing are skipped by buildFont. */
export function defaultLigatures(): { feature: 'liga'; sub: string[]; by: string }[] {
  const n = (c: string) => glyphName(c, c.codePointAt(0)!);
  return [
    { feature: 'liga', sub: [n('<'), n('-'), n('>')], by: n('↔') },
    { feature: 'liga', sub: [n('-'), n('>')], by: n('→') },
    { feature: 'liga', sub: [n('<'), n('-')], by: n('←') },
    { feature: 'liga', sub: [n('='), n('>')], by: n('⇒') },
  ];
}

export function fontToArrayBuffer(font: any): ArrayBuffer {
  return font.toArrayBuffer();
}

function notdefPath(): any {
  const p = new OTPath();
  p.moveTo(50, 0); p.lineTo(450, 0); p.lineTo(450, 700); p.lineTo(50, 700); p.close();
  p.moveTo(100, 50); p.lineTo(100, 650); p.lineTo(400, 650); p.lineTo(400, 50); p.close();
  return p;
}
