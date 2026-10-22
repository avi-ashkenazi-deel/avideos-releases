import type { Contour, Vec } from '../core/glyph';
import { bboxContours, clamp } from '../core/geometry';
import type { OpCtx } from './types';
import { densifyClosed } from './util';
import { normalizeContours } from './clip';

/**
 * Gravity sag: vertices drop by melt·(60 + 80·noise(x)) scaled by (1-t)^1.5
 * where t is the height within the glyph bbox, so the bottom drips unevenly
 * and the top barely moves; the lower part also spreads outward a little.
 */
export function melt(contours: Contour[], amount: number, ctx: OpCtx): Contour[] {
  if (contours.length === 0) return contours;
  const { noise2 } = ctx.rng;
  const b = bboxContours(contours);
  const h = b.maxY - b.minY;
  const cx = (b.minX + b.maxX) / 2;
  const out = contours.map((c) => {
    const pts = densifyClosed(c.points, 8);
    return {
      points: pts.map(([x, y]) => {
        const t = clamp((y - b.minY) / (h + 1), 0, 1);
        const f = Math.pow(1 - t, 0.75); // f² = (1-t)^1.5
        const nz = noise2(x * 0.01, 7);
        // sparse, rounded runs: smoothstep over a low-frequency noise ridge
        const d0 = clamp((noise2(x * 0.018 + 50, 3) - 0.2) / 0.5, 0, 1);
        const drip = d0 * d0 * (3 - 2 * d0);
        const dy = -amount * (60 + 80 * nz + 220 * drip) * f * f;
        const dx = Math.sign(x - cx) * amount * 10 * (1 - t);
        return [x + dx, y + dy] as Vec;
      }),
    };
  });
  return normalizeContours(out);
}
