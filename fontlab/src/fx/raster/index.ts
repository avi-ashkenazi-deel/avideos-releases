/**
 * Raster stage: contours → bitmap → texture ops → traced contours.
 */
import type { Contour } from '../../core/glyph';
import type { FxCtx, RasterOp } from '../types';
import { cleanContours } from '../../outline/fitCurves';
import { unionContours } from '../../outline/union';
import { rasterize } from './bitmap';
import { traceBitmap } from './trace';
import { blob, crunch, inkNoise, morph, num, pixel, round } from './ops';
import { reactionDiffusion } from './reactionDiffusion';

export { traceBitmap } from './trace';
export { blob, crunch, inkNoise, morph, pixel, round } from './ops';
export { reactionDiffusion } from './reactionDiffusion';
export * from './bitmap';

export const RASTER_OPS: Record<string, RasterOp> = {
  blob, round, pixel, crunch, inkNoise, morph, reactionDiffusion,
};

export interface RasterStep {
  op: RasterOp;
  params: Record<string, number>;
  /** each effect layer has its own seeded rng, so the ctx is per step */
  ctx: FxCtx;
}

/** Extra padding (px) an op needs so its growth is not clipped by the bitmap edge. */
const PAD_PX = new Map<RasterOp, (p: Record<string, number>) => number>([
  [blob, (p) => num(p, 'blur', 8, 0, 40) * 2],
  [round, (p) => num(p, 'radius', 4, 1, 20)],
  [pixel, (p) => num(p, 'size', 10, 2, 60)],
  [crunch, (p) => num(p, 'resolution', 8, 2, 40) * 2],
  [inkNoise, (p) => num(p, 'softness', 8, 0, 30) * 2 + 4],
  [morph, (p) => Math.max(0, num(p, 'amount', 6, -30, 30)) + 1],
  [reactionDiffusion, () => 12],
]);

/**
 * Rasterize once (80 font units of padding plus room for the largest blur /
 * dilate in the chain), run the ops in order, trace back and normalise with a
 * union (which sorts out winding and holes).
 */
export function runRaster(contours: Contour[], steps: RasterStep[], pxPerEm = 160): Contour[] {
  if (!contours.length) return [];
  const ppe = Number.isFinite(pxPerEm) && pxPerEm > 0 ? pxPerEm : 160;
  const scale = ppe / 1000;
  let extraPx = 0;
  for (const s of steps) {
    const f = PAD_PX.get(s.op);
    if (f) extraPx = Math.max(extraPx, f(s.params));
  }
  const pad = 80 + extraPx / scale;
  let bmp = rasterize(contours, { pxPerEm: ppe, pad });
  for (const s of steps) bmp = s.op(bmp, s.params ?? {}, s.ctx);
  const traced = traceBitmap(bmp);
  if (!traced.length) return [];
  return cleanContours(unionContours(traced));
}
