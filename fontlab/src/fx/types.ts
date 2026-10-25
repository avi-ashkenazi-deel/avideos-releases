/**
 * Effect stack model. Effects ("layers") live in ordered groups; group 0 is
 * the base, later groups start again from the original glyph and are combined
 * with the running result using a boolean op (LivingPath-style).
 */
import type { Contour, FontMetrics, Glyph } from '../core/glyph';
import type { Rng } from '../core/prng';
import type { Bitmap } from './raster/bitmap';

export type Stage = 'skeleton' | 'outline' | 'raster';

export interface FxParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  hint?: string;
}

export interface FxDef {
  type: string;
  label: string;
  stage: Stage;
  params: FxParamDef[];
  hint: string;
  /** point-preserving: can drive a variable-font axis */
  variable?: boolean;
  /** heavy op: UI shows a "slow" tag */
  slow?: boolean;
}

export interface FxLayer {
  id: string;
  type: string;
  enabled: boolean;
  params: Record<string, number>;
}

export type GroupOp = 'union' | 'subtract' | 'intersect' | 'xor';

export interface FxGroup {
  id: string;
  enabled: boolean;
  op: GroupOp;
  layers: FxLayer[];
}

export interface FxStack {
  seed: number;
  /** animation time; noise-based ops use it as a third noise dimension */
  time: number;
  groups: FxGroup[];
}

/** Context handed to every op. `rng` is scoped to (seed, char, layer id). */
export interface FxCtx {
  rng: Rng;
  metrics: FontMetrics;
  glyph: Glyph;
  time: number;
}

export type SkeletonOp = (glyph: Glyph, params: Record<string, number>, ctx: FxCtx) => Glyph;
export type OutlineOp = (contours: Contour[], params: Record<string, number>, ctx: FxCtx) => Contour[];
export type RasterOp = (bmp: Bitmap, params: Record<string, number>, ctx: FxCtx) => Bitmap;
