import type { Glyph } from '../core/glyph';
import type { OpCtx } from './types';
import { mapGlyph, deg2rad } from './util';

/** Shear about the baseline: x += tan(amount·30°)·y. */
export function slant(glyph: Glyph, amount: number, _ctx: OpCtx): Glyph {
  const k = Math.tan(deg2rad(amount * 30));
  return mapGlyph(glyph, ([x, y]) => [x + k * y, y]);
}
