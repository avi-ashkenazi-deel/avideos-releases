import type { Glyph } from '../core/glyph';
import type { OpCtx } from './types';

/** Stage A: stroke glyphs get fatter/thinner strokes. Outline glyphs are left alone (see stage B). */
export function weight(glyph: Glyph, amount: number, _ctx: OpCtx): Glyph {
  if (glyph.kind !== 'stroke' || !glyph.strokes) return glyph;
  const k = 1 + amount * 0.9;
  return {
    ...glyph,
    strokes: glyph.strokes.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p, w: Math.max(2, p.w * k) })) })),
  };
}

/** Outline glyphs: the stage-B offset distance (font units) that stands in for a stroke-weight change. */
export function outlineWeightOffset(amount: number): number {
  return amount * 35;
}
