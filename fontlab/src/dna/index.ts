import type { Glyph, Contour, DnaParams, FontMetrics } from '../core/glyph';
import { glyphRng } from '../core/prng';
import { glyphToContours } from '../outline';
import { cleanContours } from '../outline/fitCurves';
import type { OpCtx } from './types';
import { weight, outlineWeightOffset } from './weight';
import { slant } from './slant';
import { bounce } from './bounce';
import { jitter, jitterSample } from './jitter';
import { wobbleSkeleton, wobbleOutline } from './wobble';
import { inflate, INFLATE_UNITS } from './inflate';
import { melt } from './melt';
import { glitch } from './glitch';
import { erode } from './erode';

export type { OpCtx } from './types';
export { weight, outlineWeightOffset } from './weight';
export { slant } from './slant';
export { bounce } from './bounce';
export { jitter, jitterSample } from './jitter';
export { wobbleSkeleton, wobbleOutline } from './wobble';
export { inflate } from './inflate';
export { offsetContours } from './offset';
export { melt } from './melt';
export { glitch } from './glitch';
export { erode } from './erode';
export { intersectRect, normalizeContours } from './clip';

/** Ops that only move existing points (no topology change): safe for variable-font masters. */
export const POINT_PRESERVING_OPS = ['weight', 'slant', 'wobble', 'melt', 'bounce', 'jitter'] as const;
export type DnaOpName = keyof Omit<DnaParams, 'seed'>;

export function isIdentityDna(dna: DnaParams): boolean {
  return dna.weight === 0 && dna.slant === 0 && dna.wobble === 0 && dna.melt === 0 && dna.inflate === 0 &&
    dna.erode === 0 && dna.glitch === 0 && dna.bounce === 0 && dna.jitter === 0;
}

const ctxFor = (glyph: Glyph, dna: DnaParams, metrics: FontMetrics, op: DnaOpName): OpCtx => ({
  rng: glyphRng(dna.seed, glyph.char, op),
  metrics,
  glyph,
});

/** Stage A: skeleton-level ops on the Glyph (strokes or raw contours). */
export function applySkeletonDna(glyph: Glyph, dna: DnaParams, metrics: FontMetrics): Glyph {
  let g = glyph;
  const isStroke = glyph.kind === 'stroke';
  if (dna.weight !== 0 && isStroke) g = weight(g, dna.weight, ctxFor(glyph, dna, metrics, 'weight'));
  if (dna.wobble !== 0 && isStroke) g = wobbleSkeleton(g, dna.wobble, ctxFor(glyph, dna, metrics, 'wobble'));
  if (dna.slant !== 0) g = slant(g, dna.slant, ctxFor(glyph, dna, metrics, 'slant'));
  if (dna.jitter !== 0) g = jitter(g, dna.jitter, ctxFor(glyph, dna, metrics, 'jitter'));
  if (dna.bounce !== 0) g = bounce(g, dna.bounce, ctxFor(glyph, dna, metrics, 'bounce'));
  return g;
}

/** Stage B: outline-level ops on clean contours. Order: inflate → wobble(outline) → melt → glitch → erode. */
export function applyOutlineDna(glyph: Glyph, contours: Contour[], dna: DnaParams, metrics: FontMetrics): Contour[] {
  let c = contours;
  const isOutline = glyph.kind === 'outline';
  const offset = dna.inflate * INFLATE_UNITS + (isOutline ? outlineWeightOffset(dna.weight) : 0);
  if (offset !== 0) c = inflate(c, offset / INFLATE_UNITS, ctxFor(glyph, dna, metrics, 'inflate'));
  if (dna.wobble !== 0 && isOutline) c = wobbleOutline(c, dna.wobble, ctxFor(glyph, dna, metrics, 'wobble'));
  if (dna.melt !== 0) c = melt(c, dna.melt, ctxFor(glyph, dna, metrics, 'melt'));
  if (dna.glitch !== 0) c = glitch(c, dna.glitch, ctxFor(glyph, dna, metrics, 'glitch'));
  if (dna.erode !== 0) c = erode(c, dna.erode, ctxFor(glyph, dna, metrics, 'erode'));
  return c;
}

/** Full pipeline: skeleton stage → stroke expansion/union → outline stage → cleanup. */
export function applyDna(glyph: Glyph, dna: DnaParams, metrics: FontMetrics): Contour[] {
  if (isIdentityDna(dna)) return glyphToContours(glyph);
  const g = applySkeletonDna(glyph, dna, metrics);
  const base = glyphToContours(g);
  return cleanContours(applyOutlineDna(g, base, dna, metrics));
}

/** Advance width after DNA: grows with inflate and positive weight, scales with jitter's x-scale. */
export function advanceAfterDna(glyph: Glyph, dna: DnaParams): number {
  let adv = glyph.advance;
  if (dna.jitter !== 0) adv *= jitterSample(glyphRng(dna.seed, glyph.char, 'jitter'), dna.jitter).sx;
  adv += dna.inflate * 80 + Math.max(0, dna.weight) * 60;
  return Math.round(adv);
}
