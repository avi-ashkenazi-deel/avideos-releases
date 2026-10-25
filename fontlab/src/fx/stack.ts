import type { Contour, DnaParams, FontMetrics, Glyph } from '../core/glyph';
import { DEFAULT_DNA } from '../core/glyph';
import { glyphRng } from '../core/prng';
import { glyphToContours } from '../outline';
import { cleanContours } from '../outline/fitCurves';
import { booleanContours } from '../outline/union';
import { jitterSample } from '../dna/jitter';
import { FX, defaultParams } from './registry';
import { runRaster } from './raster';
import type { FxCtx, FxGroup, FxLayer, FxStack, GroupOp } from './types';

let counter = 0;
export const fxId = (prefix = 'l') => `${prefix}${(++counter).toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

export function newStack(seed = 1): FxStack {
  return { seed, time: 0, groups: [newGroup()] };
}
export function newGroup(op: GroupOp = 'union'): FxGroup {
  return { id: fxId('g'), enabled: true, op, layers: [] };
}
export function newLayer(type: string, params: Record<string, number> = {}): FxLayer {
  return { id: fxId('l'), type, enabled: true, params: { ...defaultParams(type), ...params } };
}

export function isIdentityStack(s: FxStack): boolean {
  return !s.groups.some((g) => g.enabled && g.layers.some((l) => l.enabled && FX[l.type]));
}

type Rep = { kind: 'skeleton'; glyph: Glyph } | { kind: 'contours'; contours: Contour[] };

function toContours(rep: Rep): Contour[] {
  return rep.kind === 'contours' ? rep.contours : glyphToContours(rep.glyph);
}

function runGroup(glyph: Glyph, group: FxGroup, stack: FxStack, metrics: FontMetrics): Contour[] {
  let rep: Rep = { kind: 'skeleton', glyph };
  const layers = group.layers.filter((l) => l.enabled && FX[l.type]);
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    const impl = FX[layer.type];
    const ctx: FxCtx = { rng: glyphRng(stack.seed, glyph.char, layer.id), metrics, glyph, time: stack.time };
    const params = { ...defaultParams(layer.type), ...layer.params };
    if (impl.def.stage === 'raster') {
      // batch consecutive raster layers into one bitmap round trip
      const steps: { op: NonNullable<typeof impl.raster>; params: Record<string, number>; ctx: FxCtx }[] = [];
      let j = i;
      while (j < layers.length && FX[layers[j].type]?.def.stage === 'raster') {
        const lj = layers[j];
        steps.push({ op: FX[lj.type].raster!, params: { ...defaultParams(lj.type), ...lj.params }, ctx: { rng: glyphRng(stack.seed, glyph.char, lj.id), metrics, glyph, time: stack.time } });
        j++;
      }
      rep = { kind: 'contours', contours: runRaster(toContours(rep), steps) };
      i = j - 1;
      continue;
    }
    if (rep.kind === 'skeleton' && impl.skeleton && rep.glyph.kind === 'stroke') {
      rep = { kind: 'skeleton', glyph: impl.skeleton(rep.glyph, params, ctx) };
      continue;
    }
    if (rep.kind === 'skeleton' && impl.skeleton && rep.glyph.kind === 'outline' && (layer.type === 'slant' || layer.type === 'bounce' || layer.type === 'jitter')) {
      rep = { kind: 'skeleton', glyph: impl.skeleton(rep.glyph, params, ctx) }; // affine ops work on outline glyphs directly
      continue;
    }
    const contours = toContours(rep);
    rep = { kind: 'contours', contours: impl.outline ? impl.outline(contours, params, ctx) : contours };
  }
  return toContours(rep);
}

/** Evaluate the whole stack for one glyph → clean contours. */
export function applyStack(glyph: Glyph, stack: FxStack, metrics: FontMetrics): Contour[] {
  if (isIdentityStack(stack)) return glyphToContours(glyph);
  let acc: Contour[] | null = null;
  for (const g of stack.groups) {
    if (!g.enabled) continue;
    const res = runGroup(glyph, g, stack, metrics);
    acc = acc === null ? res : booleanContours(acc, res, g.op);
  }
  return cleanContours(acc ?? glyphToContours(glyph));
}

/** Advance after effects: group 0's weight/inflate/jitter contributions, as before. */
export function advanceAfterStack(glyph: Glyph, stack: FxStack): number {
  let adv = glyph.advance;
  const g0 = stack.groups.find((g) => g.enabled);
  if (!g0) return adv;
  for (const l of g0.layers) {
    if (!l.enabled) continue;
    const a = l.params.amount ?? 0;
    if (l.type === 'weight') adv += Math.max(0, a) * 60;
    if (l.type === 'inflate') adv += a * 80;
    if (l.type === 'jitter') adv *= jitterSample(glyphRng(stack.seed, glyph.char, l.id), a).sx;
  }
  return Math.max(1, Math.round(adv));
}

/** Old nine-slider DNA → stack (one layer per non-zero slider, in the old fixed order). */
export function migrateDna(dna: Partial<DnaParams> | undefined): FxStack {
  const d = { ...DEFAULT_DNA, ...(dna ?? {}) };
  const stack = newStack(d.seed ?? 1);
  const order: (keyof DnaParams)[] = ['weight', 'wobble', 'slant', 'jitter', 'bounce', 'inflate', 'melt', 'glitch', 'erode'];
  for (const k of order) {
    const v = d[k];
    if (typeof v === 'number' && v !== 0) stack.groups[0].layers.push(newLayer(k, { amount: v }));
  }
  return stack;
}

/** Stack → classic DNA params (first layer of each variable-capable type in group 0). Used by variable export. */
export function stackToDna(stack: FxStack): DnaParams {
  const out: DnaParams = { ...DEFAULT_DNA, seed: stack.seed };
  const g0 = stack.groups.find((g) => g.enabled);
  if (!g0) return out;
  for (const l of g0.layers) {
    if (!l.enabled) continue;
    if (l.type in out && typeof l.params.amount === 'number' && (out as any)[l.type] === 0) (out as any)[l.type] = l.params.amount;
  }
  return out;
}

/** Find (or create) the first layer of a type in group 0: used by presets, animation sweeps and tests. */
export function ensureLayer(stack: FxStack, type: string): FxLayer {
  const g0 = stack.groups[0] ?? (stack.groups[0] = newGroup());
  let l = g0.layers.find((x) => x.type === type);
  if (!l) { l = newLayer(type); g0.layers.push(l); }
  return l;
}

/** Randomly nudge every enabled layer's params within their ranges. */
export function mutateStack(stack: FxStack, strength = 0.25): void {
  for (const g of stack.groups) for (const l of g.layers) {
    const def = FX[l.type]?.def; if (!def) continue;
    for (const p of def.params) {
      if (p.step >= 1 && p.max - p.min <= 1) continue; // toggles stay
      const cur = l.params[p.key] ?? p.default;
      const span = (p.max - p.min) * strength;
      let v = cur + (Math.random() - 0.5) * span;
      v = Math.min(p.max, Math.max(p.min, v));
      l.params[p.key] = Math.round(v / p.step) * p.step;
    }
  }
}
