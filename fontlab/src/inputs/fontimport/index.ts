import { parse } from '../../vendor/opentype';
import type { Glyph, Contour, Vec, FontMetrics } from '../../core/glyph';
import { CHARSET } from '../../core/glyph';
import { flattenCubic } from '../../outline/fitCurves';
import { cleanContours } from '../../outline/fitCurves';

export interface ImportedFont {
  glyphs: Glyph[];
  metrics: Partial<FontMetrics>;
  familyName: string;
}

/** Parse a TTF/OTF ArrayBuffer and extract CHARSET glyphs as outline glyphs at 1000 upm. */
export function importFont(buf: ArrayBuffer, chars: string | string[] = CHARSET): ImportedFont {
  const font = parse(buf);
  const upm: number = font.unitsPerEm || 1000;
  const k = 1000 / upm;
  const glyphs: Glyph[] = [];
  for (const ch of chars) {
    const g = font.charToGlyph(ch);
    if (!g || g.index === 0) continue;
    const path = g.getPath(0, 0, upm); // path in font units at fontSize=upm → 1:1, y-up? no: opentype flips y for rendering
    const contours = pathToContours(path.commands, k, true);
    if (!contours.length) continue;
    glyphs.push({
      char: ch,
      unicode: ch.codePointAt(0)!,
      advance: Math.round((g.advanceWidth ?? upm * 0.5) * k),
      source: 'imported',
      kind: 'outline',
      contours,
    });
  }
  const os2 = font.tables?.os2 ?? {};
  const metrics: Partial<FontMetrics> = {
    ascender: Math.round((font.ascender ?? 800) * k),
    descender: Math.round((font.descender ?? -200) * k),
  };
  if (os2.sxHeight) metrics.xHeight = Math.round(os2.sxHeight * k);
  if (os2.sCapHeight) metrics.capHeight = Math.round(os2.sCapHeight * k);
  const family = font.names?.fontFamily?.en ?? font.names?.fullName?.en ?? 'Imported';
  return { glyphs, metrics, familyName: family };
}

/** opentype path commands (y-down when produced by getPath) → y-up flattened contours. */
export function pathToContours(commands: any[], scale = 1, flipY = true): Contour[] {
  const out: Contour[] = [];
  let cur: Vec[] = [];
  let last: Vec = [0, 0];
  const P = (x: number, y: number): Vec => [x * scale, (flipY ? -y : y) * scale];
  const flush = () => { if (cur.length >= 3) out.push({ points: cur }); cur = []; };
  for (const c of commands) {
    switch (c.type) {
      case 'M': flush(); last = P(c.x, c.y); cur.push(last); break;
      case 'L': last = P(c.x, c.y); cur.push(last); break;
      case 'C': { const pts = flattenCubic([last, P(c.x1, c.y1), P(c.x2, c.y2), P(c.x, c.y)], 10); cur.push(...pts); last = pts[pts.length - 1]; break; }
      case 'Q': { const c1 = P(c.x1, c.y1), e = P(c.x, c.y); const cp1: Vec = [last[0] + (2 / 3) * (c1[0] - last[0]), last[1] + (2 / 3) * (c1[1] - last[1])]; const cp2: Vec = [e[0] + (2 / 3) * (c1[0] - e[0]), e[1] + (2 / 3) * (c1[1] - e[1])]; const pts = flattenCubic([last, cp1, cp2, e], 8); cur.push(...pts); last = e; break; }
      case 'Z': flush(); break;
    }
  }
  flush();
  return cleanContours(out, 20, 0.3);
}
