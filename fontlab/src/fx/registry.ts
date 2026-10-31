/**
 * Effect registry: every effect type with its stage, parameters, and the
 * function that applies it. Legacy DNA ops are wrapped; new ops are added
 * by the fx/ops and fx/raster modules.
 */
import type { Contour, Glyph } from '../core/glyph';
import type { FxCtx, FxDef, OutlineOp, RasterOp, SkeletonOp } from './types';
import { weight, outlineWeightOffset } from '../dna/weight';
import { slant } from '../dna/slant';
import { bounce } from '../dna/bounce';
import { jitter } from '../dna/jitter';
import { wobbleSkeleton, wobbleOutline } from '../dna/wobble';
import { inflate } from '../dna/inflate';
import { melt } from '../dna/melt';
import { glitch } from '../dna/glitch';
import { erode } from '../dna/erode';
import { offsetContours } from '../dna/offset';
import { OUTLINE_OPS } from './ops';
import { RASTER_OPS } from './raster';
import { CRISP_OPS } from './ops/crisp';
import { WRECK_OPS, WRECK_DEFS } from './ops/wreck';
import { WARP_OPS, WARP_DEFS } from './ops/warp';

/** Build registry entries from a {defs, ops} pair (warp / wreck modules). */
function fromModule(defs: Record<string, { label: string; hint: string; params: FxDef['params'] }>, ops: Record<string, OutlineOp>, extra: Partial<FxDef>): Record<string, FxImpl> {
  const out: Record<string, FxImpl> = {};
  for (const type of Object.keys(defs)) {
    const d = defs[type];
    out[type] = { def: { type, label: d.label, hint: d.hint, params: d.params, stage: 'outline', ...extra }, outline: ops[type] };
  }
  return out;
}

const amount = (p: Record<string, number>, d = 0.5) => (Number.isFinite(p.amount) ? p.amount : d);

/** apply a skeleton-style op to contours by wrapping them in an outline glyph */
function viaOutlineGlyph(op: (g: Glyph, a: number, ctx: FxCtx) => Glyph): OutlineOp {
  return (contours, params, ctx) => op({ ...ctx.glyph, kind: 'outline', strokes: undefined, contours }, amount(params), ctx).contours ?? contours;
}

export interface FxImpl {
  def: FxDef;
  skeleton?: SkeletonOp;
  /** contour form (also used when a skeleton op comes after an outline op) */
  outline?: OutlineOp;
  raster?: RasterOp;
}

const A = (label: string, min: number, max: number, def: number, hint?: string) => ({ key: 'amount', label, min, max, step: 0.01, default: def, hint });

export const FX: Record<string, FxImpl> = {
  weight: {
    def: { type: 'weight', label: 'Weight', stage: 'skeleton', params: [A('Amount', -1, 1, 0.4, 'thin ↔ chonky')], hint: 'Thicker or thinner strokes', variable: true },
    skeleton: (g, p, ctx) => weight(g, amount(p), ctx),
    outline: (c, p) => offsetContours(c, outlineWeightOffset(amount(p))),
  },
  slant: {
    def: { type: 'slant', label: 'Slant', stage: 'skeleton', params: [A('Amount', -1, 1, 0.4, 'backslant ↔ italic')], hint: 'Shear about the baseline', variable: true },
    skeleton: (g, p, ctx) => slant(g, amount(p), ctx),
    outline: viaOutlineGlyph(slant),
  },
  wobble: {
    def: { type: 'wobble', label: 'Wobble', stage: 'skeleton', params: [A('Amount', 0, 1, 0.5)], hint: 'Nervous-hand noise along the strokes', variable: true },
    skeleton: (g, p, ctx) => wobbleSkeleton(g, amount(p), ctx),
    outline: (c, p, ctx) => wobbleOutline(c, amount(p), ctx),
  },
  bounce: {
    def: { type: 'bounce', label: 'Bounce', stage: 'skeleton', params: [A('Amount', 0, 1, 0.5)], hint: 'Ransom-note baseline hops and tilts', variable: true },
    skeleton: (g, p, ctx) => bounce(g, amount(p), ctx),
    outline: viaOutlineGlyph(bounce),
  },
  jitter: {
    def: { type: 'jitter', label: 'Jitter', stage: 'skeleton', params: [A('Amount', 0, 1, 0.5)], hint: 'Every letter its own size', variable: true },
    skeleton: (g, p, ctx) => jitter(g, amount(p), ctx),
    outline: viaOutlineGlyph(jitter),
  },
  inflate: {
    def: { type: 'inflate', label: 'Inflate', stage: 'outline', params: [A('Amount', 0, 1, 0.4)], hint: 'Balloon letters' },
    outline: (c, p, ctx) => inflate(c, amount(p), ctx),
  },
  melt: {
    def: { type: 'melt', label: 'Melt', stage: 'outline', params: [A('Amount', 0, 1, 0.6)], hint: 'Ice cream in July', variable: true },
    outline: (c, p, ctx) => melt(c, amount(p), ctx),
  },
  glitch: {
    def: { type: 'glitch', label: 'Glitch', stage: 'outline', params: [A('Amount', 0, 1, 0.6)], hint: 'Bad VHS slices' },
    outline: (c, p, ctx) => glitch(c, amount(p), ctx),
  },
  erode: {
    def: { type: 'erode', label: 'Rust', stage: 'outline', params: [A('Amount', 0, 1, 0.5)], hint: 'Eaten by time' },
    outline: (c, p, ctx) => erode(c, amount(p), ctx),
  },
  crispWeight: {
    def: { type: 'crispWeight', label: 'Weight (crisp)', stage: 'outline', params: [A('Amount', -1, 1, 0.3, 'thin ↔ bold, corners stay sharp')], hint: 'Bold or thin with mitred corners — for imported fonts that must stay sharp', crisp: true },
    outline: (c, p, ctx) => CRISP_OPS.crispWeight(c, p, ctx),
  },
  stretch: {
    def: { type: 'stretch', label: 'Stretch', stage: 'outline', params: [
      { key: 'width', label: 'Width', min: 0.4, max: 2.2, step: 0.01, default: 1.15 },
      { key: 'height', label: 'Height', min: 0.4, max: 2.2, step: 0.01, default: 1 }], hint: 'Condensed, extended, tall or squat', crisp: true },
    outline: (c, p, ctx) => CRISP_OPS.stretch(c, p, ctx),
  },
  tracking: {
    def: { type: 'tracking', label: 'Tracking', stage: 'outline', params: [{ key: 'amount', label: 'Units', min: -150, max: 400, step: 1, default: 40 }], hint: 'Letter-spacing baked into the font', crisp: true },
    outline: (c, p, ctx) => CRISP_OPS.tracking(c, p, ctx),
  },
  xHeight: {
    def: { type: 'xHeight', label: 'x-height', stage: 'outline', params: [{ key: 'scale', label: 'Lowercase scale', min: 0.6, max: 1.6, step: 0.01, default: 1.15 }], hint: 'Scale only the lowercase letters', crisp: true },
    outline: (c, p, ctx) => CRISP_OPS.xHeight(c, p, ctx),
  },
  chamfer: {
    def: { type: 'chamfer', label: 'Chamfer', stage: 'outline', params: [
      { key: 'size', label: 'Size', min: 2, max: 120, step: 1, default: 24 },
      { key: 'chance', label: 'Chance', min: 0, max: 1, step: 0.01, default: 1, hint: 'below 1: only some corners, seeded (fracture)' },
      { key: 'convexOnly', label: 'Outer corners only', min: 0, max: 1, step: 1, default: 1 }], hint: 'Bevelled corners, or a seeded fracture of some of them', crisp: true },
    outline: (c, p, ctx) => CRISP_OPS.chamfer(c, p, ctx),
  },
  roundVec: {
    def: { type: 'roundVec', label: 'Round corners (vector)', stage: 'outline', params: [{ key: 'radius', label: 'Radius', min: 2, max: 120, step: 1, default: 20 }], hint: 'Exact rounded corners, edges untouched', crisp: true },
    outline: (c, p, ctx) => CRISP_OPS.roundVec(c, p, ctx),
  },
  inkTrap: {
    def: { type: 'inkTrap', label: 'Ink traps', stage: 'outline', params: [
      { key: 'depth', label: 'Depth', min: 2, max: 80, step: 1, default: 18 },
      { key: 'width', label: 'Width', min: 2, max: 120, step: 1, default: 22 }], hint: 'Notches where strokes meet', crisp: true },
    outline: (c, p, ctx) => CRISP_OPS.inkTrap(c, p, ctx),
  },
  stencil: {
    def: { type: 'stencil', label: 'Stencil', stage: 'outline', params: [
      { key: 'gap', label: 'Gap', min: 2, max: 60, step: 1, default: 14 },
      { key: 'spacing', label: 'Spacing', min: 40, max: 600, step: 1, default: 180 },
      { key: 'angle', label: 'Angle', min: -90, max: 90, step: 1, default: 0 },
      { key: 'phase', label: 'Offset', min: 0, max: 1, step: 0.01, default: 0.35 },
      { key: 'jitter', label: 'Jitter', min: 0, max: 1, step: 0.01, default: 0 }], hint: 'Stencil bridges cut across the letters', crisp: true },
    outline: (c, p, ctx) => CRISP_OPS.stencil(c, p, ctx),
  },
  hollow: {
    def: { type: 'hollow', label: 'Hollow', stage: 'outline', params: [
      { key: 'inset', label: 'Inset', min: 4, max: 80, step: 1, default: 24 },
      { key: 'inline', label: 'Inline', min: 0, max: 60, step: 1, default: 0, hint: 'stripe inside the outline' }], hint: 'Outlined or inline letters' },
    outline: (c, p, ctx) => OUTLINE_OPS.hollow(c, p, ctx),
  },
  lowpoly: {
    def: { type: 'lowpoly', label: 'Low poly', stage: 'outline', params: [
      { key: 'tolerance', label: 'Facet size', min: 4, max: 120, step: 1, default: 30 },
      { key: 'minSegments', label: 'Min sides', min: 3, max: 12, step: 1, default: 4 }], hint: 'Faceted, crystal letters' },
    outline: (c, p, ctx) => OUTLINE_OPS.lowpoly(c, p, ctx),
  },
  stipple: {
    def: { type: 'stipple', label: 'Stipple', stage: 'outline', params: [
      { key: 'spacing', label: 'Spacing', min: 10, max: 120, step: 1, default: 36 },
      { key: 'dotSize', label: 'Dot size', min: 3, max: 60, step: 1, default: 12 },
      { key: 'jitter', label: 'Jitter', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'gravity', label: 'Gravity', min: 0, max: 1, step: 0.01, default: 0, hint: 'dots settle to the bottom' },
      { key: 'keepOutline', label: 'Keep outline', min: 0, max: 1, step: 1, default: 0 }], hint: 'Letters made of dots', slow: true },
    outline: (c, p, ctx) => OUTLINE_OPS.stipple(c, p, ctx),
  },
  blob: {
    def: { type: 'blob', label: 'Blob', stage: 'raster', params: [
      { key: 'blur', label: 'Blur', min: 0, max: 40, step: 1, default: 8 },
      { key: 'threshold', label: 'Threshold', min: 0, max: 255, step: 1, default: 128 }], hint: 'Soft, merged shapes' },
    raster: (b, p, ctx) => RASTER_OPS.blob(b, p, ctx),
  },
  round: {
    def: { type: 'round', label: 'Round corners', stage: 'raster', params: [{ key: 'radius', label: 'Radius', min: 1, max: 20, step: 1, default: 4 }], hint: 'Softens corners only' },
    raster: (b, p, ctx) => RASTER_OPS.round(b, p, ctx),
  },
  pixel: {
    def: { type: 'pixel', label: 'Pixelate', stage: 'raster', params: [
      { key: 'size', label: 'Block', min: 2, max: 60, step: 1, default: 10 },
      { key: 'offsetX', label: 'Offset X', min: 0, max: 1, step: 0.01, default: 0 },
      { key: 'offsetY', label: 'Offset Y', min: 0, max: 1, step: 0.01, default: 0 }], hint: '1-bit mosaic' },
    raster: (b, p, ctx) => RASTER_OPS.pixel(b, p, ctx),
  },
  crunch: {
    def: { type: 'crunch', label: 'Crunch', stage: 'raster', params: [
      { key: 'resolution', label: 'Cell', min: 2, max: 40, step: 1, default: 8 },
      { key: 'sharpen', label: 'Sharpen', min: 0, max: 6, step: 1, default: 2 },
      { key: 'threshold', label: 'Threshold', min: 0, max: 255, step: 1, default: 128 }], hint: 'Chunky stencil' },
    raster: (b, p, ctx) => RASTER_OPS.crunch(b, p, ctx),
  },
  inkNoise: {
    def: { type: 'inkNoise', label: 'Ink noise', stage: 'raster', params: [
      { key: 'softness', label: 'Softness', min: 0, max: 30, step: 1, default: 8 },
      { key: 'noiseSize', label: 'Grain', min: 2, max: 60, step: 1, default: 14 },
      { key: 'amount', label: 'Amount', min: 0, max: 0.85, step: 0.01, default: 0.6 },
      { key: 'threshold', label: 'Threshold', min: 0, max: 255, step: 1, default: 128 }], hint: 'Ragged ink-blot edges (drifts in Living mode)' },
    raster: (b, p, ctx) => RASTER_OPS.inkNoise(b, p, ctx),
  },
  morph: {
    def: { type: 'morph', label: 'Dilate / erode', stage: 'raster', params: [{ key: 'amount', label: 'Amount', min: -30, max: 30, step: 1, default: 6, hint: 'px: + fatter, − thinner' }], hint: 'True morphology with a round kernel' },
    raster: (b, p, ctx) => RASTER_OPS.morph(b, p, ctx),
  },
  reactionDiffusion: {
    def: { type: 'reactionDiffusion', label: 'Reaction-diffusion', stage: 'raster', params: [
      { key: 'resolution', label: 'Resolution', min: 48, max: 200, step: 1, default: 96 },
      { key: 'steps', label: 'Time', min: 50, max: 1200, step: 10, default: 300 },
      { key: 'feedInk', label: 'Feed (ink)', min: 0.02, max: 0.08, step: 0.001, default: 0.03 },
      { key: 'feedPaper', label: 'Feed (paper)', min: 0.02, max: 0.08, step: 0.001, default: 0.055 },
      { key: 'killInk', label: 'Kill (ink)', min: 0.02, max: 0.08, step: 0.001, default: 0.06 },
      { key: 'killPaper', label: 'Kill (paper)', min: 0.02, max: 0.08, step: 0.001, default: 0.062 },
      { key: 'threshold', label: 'Threshold', min: 0, max: 255, step: 1, default: 90 },
      { key: 'invert', label: 'Invert', min: 0, max: 1, step: 1, default: 0 }], hint: 'Coral, stripes and spots that grow along the letter', slow: true },
    raster: (b, p, ctx) => RASTER_OPS.reactionDiffusion(b, p, ctx),
  },
  ...fromModule(WARP_DEFS, WARP_OPS, { category: 'warp', crisp: true }),
  ...fromModule(WRECK_DEFS, WRECK_OPS, { category: 'wreck' }),
};

export const FX_ORDER = Object.keys(FX);
export const FX_DEFS: FxDef[] = FX_ORDER.map((k) => FX[k].def);
export function defaultParams(type: string): Record<string, number> {
  return Object.fromEntries((FX[type]?.def.params ?? []).map((p) => [p.key, p.default]));
}
export function applyOutlineForm(type: string, contours: Contour[], params: Record<string, number>, ctx: FxCtx): Contour[] {
  const f = FX[type]?.outline;
  return f ? f(contours, params, ctx) : contours;
}
