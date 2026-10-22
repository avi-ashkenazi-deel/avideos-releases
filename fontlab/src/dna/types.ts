import type { Glyph, FontMetrics } from '../core/glyph';
import type { Rng } from '../core/prng';

/** Context handed to every DNA operator. `rng` is scoped to (seed, char, opName). */
export interface OpCtx {
  rng: Rng;
  metrics: FontMetrics;
  /** the glyph being processed (pre-DNA for stage A, post-skeleton for stage B) */
  glyph: Glyph;
}

export type SkeletonOp = (glyph: Glyph, amount: number, ctx: OpCtx) => Glyph;
