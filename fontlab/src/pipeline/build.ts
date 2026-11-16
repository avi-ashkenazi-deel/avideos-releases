import type { FontProject, Contour, Glyph } from '../core/glyph';
import { applyStack, isIdentityStack, advanceAfterStack } from '../fx/stack';
import { glyphToContours } from '../outline';
import { buildFont, fontToArrayBuffer, glyphName, defaultLigatures, type OutlineGlyph, type FeatureGlyph, type FontFeatures } from '../export/otf';
import { hashString } from '../core/prng';

export interface BuiltGlyph { char: string; unicode: number; advance: number; contours: Contour[] }
export interface BuildResult {
  /** keyed by char only (consumers iterate this assuming char keys) */
  glyphs: Record<string, BuiltGlyph>;
  /** built stylistic alternates, keyed `${char}#ss01` … `#ss03` (also written into the OTF as GSUB) */
  alternates: Record<string, BuiltGlyph>;
  otf: ArrayBuffer | null;
  ms: number;
}

const cache = new Map<string, BuiltGlyph>();
const MAX_CACHE = 2000;

function keyFor(g: Glyph, p: FontProject): string {
  return hashString(JSON.stringify(g)) + ':' + hashString(JSON.stringify(p.fx) + JSON.stringify(p.metrics));
}

/** Build one glyph through the fx stack. `variant` (e.g. `a#ss01`) keeps alternates' cache
 *  entries apart from the base glyph's. */
export function buildGlyph(g: Glyph, p: FontProject, variant = ''): BuiltGlyph {
  const k = keyFor(g, p) + (variant ? '|' + variant : '');
  const hit = cache.get(k);
  if (hit) return hit;
  let contours: Contour[];
  let advance = g.advance;
  if (isIdentityStack(p.fx)) contours = glyphToContours(g);
  else { contours = applyStack(g, p.fx, p.metrics); advance = advanceAfterStack(g, p.fx); }
  const built: BuiltGlyph = { char: g.char, unicode: g.unicode, advance, contours };
  if (cache.size > MAX_CACHE) cache.clear();
  cache.set(k, built);
  return built;
}

const nameOf = (b: { char: string; unicode: number }) => glyphName(b.char, b.unicode);

/** Collect GSUB features for the built set: ss01–ss03 + salt from project alternates, tnum from
 *  the digits, and the default arrow ligatures. */
function collectFeatures(glyphs: Record<string, BuiltGlyph>, alternates: Record<string, BuiltGlyph>): FontFeatures {
  const extraGlyphs: FeatureGlyph[] = [];
  const singles: Record<string, [string, string][]> = {};
  const alts: Record<string, string[]> = {};
  const addSingle = (tag: string, a: string, b: string) => (singles[tag] ??= []).push([a, b]);

  for (const [key, alt] of Object.entries(alternates)) {
    const [ch, tag] = key.split('#');
    const base = glyphs[ch];
    if (!base || !base.contours.length || !alt.contours.length) continue;
    const baseName = nameOf(base);
    const altName = `${baseName}.${tag}`;
    extraGlyphs.push({ name: altName, advance: alt.advance, contours: alt.contours });
    addSingle(tag, baseName, altName);
    (alts[baseName] ??= []).push(altName);
  }

  const digits = '0123456789'.split('').map((d) => glyphs[d]).filter((b) => b && b.contours.length);
  if (digits.length) {
    const W = Math.max(...digits.map((b) => b.advance));
    for (const b of digits) {
      const dx = (W - b.advance) / 2;
      const name = nameOf(b);
      extraGlyphs.push({
        name: `${name}.tnum`,
        advance: W,
        contours: dx ? b.contours.map((c) => ({ ...c, points: c.points.map(([x, y]) => [x + dx, y] as [number, number]) })) : b.contours,
      });
      addSingle('tnum', name, `${name}.tnum`);
    }
  }
  return { extraGlyphs, singles, alternates: alts, ligatures: defaultLigatures() };
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
  const alternates: Record<string, BuiltGlyph> = {};
  for (const [ch, list] of Object.entries(p.alternates ?? {})) {
    if (!glyphs[ch] || !Array.isArray(list)) continue;
    list.slice(0, 3).forEach((g, i) => {
      if (!g) return;
      const key = `${ch}#ss0${i + 1}`;
      try { alternates[key] = buildGlyph(g, p, key); } catch (e) { console.warn('alternate build failed', key, e); }
    });
  }
  let otf: ArrayBuffer | null = null;
  if (opts.otf !== false) {
    const list: OutlineGlyph[] = Object.values(glyphs).filter((g) => g.contours.length);
    if (list.length) {
      const features = collectFeatures(glyphs, alternates);
      otf = fontToArrayBuffer(buildFont(list, { familyName: p.name || 'FontLab', metrics: p.metrics, features }));
    }
  }
  return { glyphs, alternates, otf, ms: performance.now() - t0 };
}
