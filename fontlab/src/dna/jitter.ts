import type { Glyph } from '../core/glyph';
import type { Rng } from '../core/prng';
import type { OpCtx } from './types';
import { mapGlyph, glyphBBox } from './util';

export interface JitterSample { sx: number; sy: number; dx: number }

/** The random draws jitter makes, in order — shared with `advanceAfterDna`. */
export function jitterSample(rng: Rng, amount: number): JitterSample {
  const sx = 1 + rng.range(-1, 1) * amount * 0.15;
  const sy = 1 + rng.range(-1, 1) * amount * 0.15;
  const dx = rng.range(-1, 1) * amount * 25;
  return { sx, sy, dx };
}

/** Per-glyph random x/y scale (1 ± 0.15·amount) about bbox centre-bottom, plus an x nudge (±25·amount). */
export function jitter(glyph: Glyph, amount: number, ctx: OpCtx): Glyph {
  const { sx, sy, dx } = jitterSample(ctx.rng, amount);
  const b = glyphBBox(glyph);
  const ox = (b.minX + b.maxX) / 2, oy = b.minY;
  return mapGlyph(glyph, ([x, y]) => [ox + (x - ox) * sx + dx, oy + (y - oy) * sy]);
}
