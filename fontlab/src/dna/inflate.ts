import type { Contour } from '../core/glyph';
import type { OpCtx } from './types';
import { offsetContours } from './offset';

export const INFLATE_UNITS = 40;

/** Round-cornered outward offset by amount·40 units (negative amount erodes inward). */
export function inflate(contours: Contour[], amount: number, _ctx: OpCtx): Contour[] {
  return offsetContours(contours, amount * INFLATE_UNITS);
}
