import type { Glyph } from '../core/glyph';
import type { OpCtx } from './types';
import { mapGlyph, glyphBBox, deg2rad } from './util';

/** Per-glyph vertical hop (±120·amount) plus a tilt (±8°·amount) about the bbox centre. */
export function bounce(glyph: Glyph, amount: number, ctx: OpCtx): Glyph {
  const dy = ctx.rng.range(-1, 1) * amount * 120;
  const rot = deg2rad(ctx.rng.range(-1, 1) * amount * 8);
  const b = glyphBBox(glyph);
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const c = Math.cos(rot), s = Math.sin(rot);
  return mapGlyph(glyph, ([x, y]) => {
    const px = x - cx, py = y - cy;
    return [cx + px * c - py * s, cy + px * s + py * c + dy];
  });
}
