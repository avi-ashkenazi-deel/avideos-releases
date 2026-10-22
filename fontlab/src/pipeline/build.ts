import type { FontProject, Contour, Glyph } from '../core/glyph';
import { applyDna, isIdentityDna, advanceAfterDna } from '../dna';
import { glyphToContours } from '../outline';
import { buildFont, fontToArrayBuffer, type OutlineGlyph } from '../export/otf';
import { hashString } from '../core/prng';

export interface BuiltGlyph { char: string; unicode: number; advance: number; contours: Contour[] }
export interface BuildResult { glyphs: Record<string, BuiltGlyph>; otf: ArrayBuffer | null; ms: number }

const cache = new Map<string, BuiltGlyph>();
const MAX_CACHE = 2000;

function keyFor(g: Glyph, p: FontProject): string {
  return hashString(JSON.stringify(g)) + ':' + hashString(JSON.stringify(p.dna) + JSON.stringify(p.metrics));
}

export function buildGlyph(g: Glyph, p: FontProject): BuiltGlyph {
  const k = keyFor(g, p);
  const hit = cache.get(k);
  if (hit) return hit;
  let contours: Contour[];
  let advance = g.advance;
  if (isIdentityDna(p.dna)) contours = glyphToContours(g);
  else { contours = applyDna(g, p.dna, p.metrics); advance = advanceAfterDna(g, p.dna); }
  const built: BuiltGlyph = { char: g.char, unicode: g.unicode, advance, contours };
  if (cache.size > MAX_CACHE) cache.clear();
  cache.set(k, built);
  return built;
}

export function buildAll(p: FontProject, opts: { otf?: boolean; chars?: string[] } = {}): BuildResult {
  const t0 = performance.now();
  const chars = opts.chars ?? Object.keys(p.glyphs);
  const glyphs: Record<string, BuiltGlyph> = {};
  for (const ch of chars) {
    const g = p.glyphs[ch];
    if (!g) continue;
    try { glyphs[ch] = buildGlyph(g, p); } catch (e) { console.warn('glyph build failed', ch, e); }
  }
  let otf: ArrayBuffer | null = null;
  if (opts.otf !== false) {
    const list: OutlineGlyph[] = Object.values(glyphs).filter((g) => g.contours.length);
    if (list.length) otf = fontToArrayBuffer(buildFont(list, { familyName: p.name || 'FontLab', metrics: p.metrics }));
  }
  return { glyphs, otf, ms: performance.now() - t0 };
}
