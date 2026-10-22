import type { Stroke, StyleStats } from '../glyph';
import type { Rng } from '../prng';
import { bboxStrokes, clamp } from '../geometry';

export interface RecipeCtx {
  stats: StyleStats;
  rng: Rng;
  /** 0..1 randomness */
  mutation: number;
  /** named parameter overrides chosen at compose time (e.g. width multiplier) */
  params: Record<string, number>;
}

export interface RecipeResult {
  strokes: Stroke[];
  advance: number;
}

export interface Recipe {
  id: string;
  build(ctx: RecipeCtx): RecipeResult;
}

/** Vertical metrics & derived sizes, sanitised against garbage stats. */
export interface Frame {
  xh: number;
  cap: number;
  asc: number;
  desc: number;
  /** overshoot of round shapes */
  o: number;
  /** full stroke width */
  sw: number;
  /** half stroke width */
  hw: number;
  /** horizontal width multiplier (params.width, widened for heavy strokes) */
  k: number;
  spacing: number;
}

const fin = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function frame(ctx: RecipeCtx): Frame {
  const s = ctx.stats;
  const xh = clamp(fin(s.xHeight, 500), 150, 900);
  const cap = clamp(fin(s.capHeight, 700), xh + 50, 1000);
  const asc = clamp(fin(s.ascender, 740), cap - 40, 1050);
  const desc = clamp(fin(s.descender, -200), -500, -40);
  const sw = clamp(fin(s.strokeWidth, 90), 4, 400);
  const o = clamp(fin(s.overshoot, 12), 0, 40);
  const pw = fin(ctx.params?.width, 1);
  const k = clamp(pw, 0.7, 1.4) * (1 + (Math.max(0, sw - 90) / 90) * 0.3);
  const spacing = clamp(fin(s.spacing, 60), 0, 400);
  return { xh, cap, asc, desc, o, sw, hw: sw / 2, k, spacing };
}

/** read a named param with default */
export function param(ctx: RecipeCtx, name: string, dflt: number): number {
  return fin(ctx.params?.[name], dflt);
}

/**
 * Normalise a built skeleton: shift so the ink starts at the left sidebearing
 * and compute advance = ink width + 2 * spacing.
 */
export function finish(ctx: RecipeCtx, strokes: Stroke[]): RecipeResult {
  const f = frame(ctx);
  const valid = strokes.filter((s) => s.points.length > 0);
  if (valid.length === 0) return { strokes: [], advance: Math.max(1, f.spacing * 2 + f.sw) };
  const bb = bboxStrokes(valid);
  const dx = f.spacing - bb.minX;
  for (const s of valid) for (const p of s.points) p.x += dx;
  const ink = Math.max(1, bb.maxX - bb.minX);
  return { strokes: valid, advance: Math.round(ink + 2 * f.spacing) };
}

export function rec(id: string, build: (ctx: RecipeCtx) => Stroke[]): Recipe {
  return { id, build: (ctx) => finish(ctx, build(ctx)) };
}
