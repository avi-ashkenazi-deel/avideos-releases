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
  const font = new Font({
    familyName: opts.familyName,
    styleName: opts.styleName ?? 'Regular',
    unitsPerEm: opts.metrics.upm,
    ascender: opts.metrics.ascender,
    descender: opts.metrics.descender,
    glyphs: list,
  });
  return font;
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
