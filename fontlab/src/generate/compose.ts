/**
 * Glyph set composition: seeds and locked glyphs are kept verbatim, related
 * letters are borrowed from drawn parents where possible, everything else is
 * built from the recipe library with a glyph-scoped deterministic rng.
 */
import { CHARSET, type Glyph, type Stroke, type StyleStats } from '../core/glyph';
import { glyphRng, type Rng } from '../core/prng';
import { affineShear, bboxStrokes, clamp } from '../core/geometry';
import { recipes, type RecipeCtx } from '../core/recipes';
import { mutateStrokes } from './mutate';
import { borrowStrokes } from './borrow';

export interface GenerateInput {
  seeds: Glyph[];
  stats: StyleStats;
  /** 0..1 */
  mutation: number;
  glyphs: Record<string, Glyph>;
}

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function seedMap(seeds: Glyph[]): Map<string, Glyph> {
  const m = new Map<string, Glyph>();
  for (const s of Array.isArray(seeds) ? seeds : []) {
    if (s && typeof s.char === 'string' && !m.has(s.char)) m.set(s.char, s);
  }
  return m;
}

/** compose-time parameter choices for a recipe */
export function chooseParams(rng: Rng, mutation: number): Record<string, number> {
  const m = clamp(fin(mutation) ? mutation : 0, 0, 1);
  return {
    width: clamp(1 + rng.gauss(0, 0.05) * m, 0.85, 1.15),
  };
}

/** assign deterministic stroke ids (uid() is time based, which would break reproducibility) */
function assignIds(strokes: Stroke[], char: string): Stroke[] {
  const code = char.codePointAt(0) ?? 0;
  return strokes.map((s, i) => ({ ...s, id: `g${code.toString(36)}_${i}` }));
}

/** mutate, slant, normalise sidebearings; returns strokes + advance */
function postProcess(strokes: Stroke[], stats: StyleStats, mutation: number, rng: Rng): { strokes: Stroke[]; advance: number } {
  let out = mutateStrokes(strokes, mutation, rng, {
    wobbleAmp: clamp(fin(stats.wobbleAmp) ? stats.wobbleAmp : 0, 0, 15),
    wobbleFreq: fin(stats.wobbleFreq) ? stats.wobbleFreq : 1,
  });
  const slant = fin(stats.slantDeg) ? clamp(stats.slantDeg, -30, 30) : 0;
  if (Math.abs(slant) > 0.05) {
    const m = affineShear(slant);
    out = out.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p, x: m[0] * p.x + m[2] * p.y + m[4] })) }));
  }
  const spacing = clamp(fin(stats.spacing) ? stats.spacing : 60, 0, 400);
  const valid = out.filter((s) => s.points.length > 0);
  if (!valid.length) return { strokes: [], advance: Math.round(spacing * 2 + (fin(stats.strokeWidth) ? stats.strokeWidth : 90)) };
  const bb = bboxStrokes(valid);
  const dx = spacing - bb.minX;
  for (const s of valid) for (const p of s.points) p.x += dx;
  return { strokes: valid, advance: Math.max(1, Math.round(bb.maxX - bb.minX + 2 * spacing)) };
}

/**
 * Build one glyph from its recipe (or a borrowed parent) with the given seed.
 * Pure and deterministic for the same inputs.
 */
export function buildGlyph(
  char: string,
  stats: StyleStats,
  mutation: number,
  seedNumber: number,
  seeds: ReadonlyMap<string, Glyph> = new Map(),
  paramOverrides?: Record<string, number>,
): Glyph {
  const rng = glyphRng(seedNumber >>> 0, char);
  const params = { ...chooseParams(rng, mutation), ...(paramOverrides ?? {}) };
  const unicode = char.codePointAt(0) ?? 0;

  const borrowed = borrowStrokes(char, seeds, stats);
  if (borrowed) {
    const pp = postProcess(borrowed.strokes, stats, mutation * 0.5, rng);
    return {
      char, unicode, advance: pp.advance, source: 'generated', kind: 'stroke',
      strokes: assignIds(pp.strokes, char),
      recipe: { id: `borrow:${borrowed.parent}>${char}`, seed: seedNumber, params: {} },
    };
  }

  const recipe = recipes[char];
  if (!recipe) {
    // no recipe: an empty, advance-only glyph so text still flows
    return { char, unicode, advance: Math.round((fin(stats.spacing) ? stats.spacing : 60) * 2 + 200), source: 'generated', kind: 'stroke', strokes: [], recipe: { id: 'none', seed: seedNumber, params } };
  }
  const ctx: RecipeCtx = { stats, rng, mutation: clamp(fin(mutation) ? mutation : 0, 0, 1), params };
  const built = recipe.build(ctx);
  const pp = postProcess(built.strokes, stats, ctx.mutation, rng);
  return {
    char, unicode, advance: pp.advance, source: 'generated', kind: 'stroke',
    strokes: assignIds(pp.strokes, char),
    recipe: { id: recipe.id, seed: seedNumber, params },
  };
}

/**
 * Generate the working glyph set. Seeds and locked glyphs are kept verbatim;
 * everything else is (re)generated from recipes with `glyphRng(seedNumber, char)`.
 */
export function generateGlyphs(project: GenerateInput, seedNumber: number, chars: string = CHARSET): Record<string, Glyph> {
  const seeds = seedMap(project.seeds);
  const existing = project.glyphs ?? {};
  const out: Record<string, Glyph> = {};
  for (const ch of [...chars]) {
    const cur = existing[ch];
    if (cur && cur.locked) { out[ch] = cur; continue; }
    const seed = seeds.get(ch);
    if (seed) { out[ch] = seed; continue; }
    out[ch] = buildGlyph(ch, project.stats, project.mutation, seedNumber, seeds);
  }
  return out;
}

/**
 * Re-roll a single glyph with a new seed. Locked glyphs and seeds are returned
 * unchanged (callers should unlock / remove the seed first to replace them).
 */
export function regenerateOne(char: string, project: GenerateInput, newSeed: number, paramOverrides?: Record<string, number>): Glyph {
  const cur = project.glyphs?.[char];
  if (cur && cur.locked) return cur;
  const seeds = seedMap(project.seeds);
  const seed = seeds.get(char);
  if (seed) return seed;
  return buildGlyph(char, project.stats, project.mutation, newSeed, seeds, paramOverrides);
}
