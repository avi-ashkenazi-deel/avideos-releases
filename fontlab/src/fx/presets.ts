import type { FxStack } from './types';
import { newStack, newLayer, newGroup } from './stack';

type Build = (seed: number) => FxStack;

const one = (...layers: [string, Record<string, number>?][]): Build => (seed) => {
  const s = newStack(seed);
  s.groups[0].layers = layers.map(([t, p]) => newLayer(t, p));
  return s;
};

export const PRESETS: Record<string, Build> = {
  Clean: (seed) => newStack(seed),
  Chonky: one(['weight', { amount: 0.8 }], ['inflate', { amount: 0.35 }]),
  Melted: one(['weight', { amount: 0.3 }], ['wobble', { amount: 0.15 }], ['melt', { amount: 0.75 }]),
  Rusty: one(['weight', { amount: 0.25 }], ['wobble', { amount: 0.2 }], ['erode', { amount: 0.6 }]),
  Glitchy: one(['slant', { amount: 0.2 }], ['glitch', { amount: 0.7 }]),
  Ransom: one(['weight', { amount: 0.2 }], ['jitter', { amount: 0.6 }], ['bounce', { amount: 0.7 }]),
  Nervous: one(['wobble', { amount: 0.8 }], ['jitter', { amount: 0.25 }]),
  Hollow: one(['weight', { amount: 0.5 }], ['hollow', { inset: 22 }]),
  Inline: one(['weight', { amount: 0.9 }], ['hollow', { inset: 18, inline: 16 }]),
  Blob: one(['blob', { blur: 10, threshold: 120 }]),
  Pixel: one(['pixel', { size: 12 }]),
  Crunch: one(['crunch', { resolution: 9, sharpen: 3 }]),
  Ink: one(['weight', { amount: 0.3 }], ['inkNoise', { softness: 8, noiseSize: 16, amount: 0.7 }]),
  Crystal: one(['weight', { amount: 0.2 }], ['lowpoly', { tolerance: 34 }]),
  Coral: one(['weight', { amount: 0.6 }], ['reactionDiffusion', {}]),
  Stipple: one(['weight', { amount: 0.4 }], ['stipple', { spacing: 34, dotSize: 11, gravity: 0 }]),
  Gravity: one(['weight', { amount: 0.5 }], ['stipple', { spacing: 30, dotSize: 10, gravity: 1 }]),
  /** two groups: fat version minus the original = a thick outline ring */
  Halo: (seed) => {
    const s = newStack(seed);
    s.groups[0].layers = [newLayer('inflate', { amount: 0.6 })];
    const g = newGroup('subtract');
    g.layers = [newLayer('weight', { amount: 0.1 })];
    s.groups.push(g);
    return s;
  },
  Twisted: one(['twist', { degrees: 40 }]),
  Keystone: one(['perspective', { amount: 0.6 }]),
  Windswept: one(['wind', { amount: 0.5, gust: 0.4 }]),
  Rippled: one(['ripple', { amount: 24, waves: 2.5 }]),
  'Swiss cheese': one(['crispWeight', { amount: 0.4 }], ['holes', { amount: 0.6, size: 46 }]),
  Echoes: one(['echo', { copies: 3, dx: 22, dy: -14 }]),
  Shredded: one(['slice', { strips: 8, shift: 36 }]),
  Spiky: one(['spikes', { amount: 0.45, length: 70 }]),
  Griddled: one(['gridSnap', { cell: 36 }]),
  Crushed: one(['crush', { amount: 0.6 }]),
  'Crisp bold': one(['crispWeight', { amount: 0.6 }]),
  Condensed: one(['stretch', { width: 0.8, height: 1 }], ['tracking', { amount: 10 }]),
  Extended: one(['stretch', { width: 1.3, height: 1 }], ['tracking', { amount: 30 }]),
  Chiselled: one(['chamfer', { size: 22, chance: 1 }]),
  Fractured: one(['chamfer', { size: 30, chance: 0.35, convexOnly: 0 }]),
  Softened: one(['roundVec', { radius: 18 }]),
  'Ink traps': one(['inkTrap', { depth: 20, width: 24 }]),
  'Stencil cut': one(['stencil', { gap: 14, spacing: 200, angle: 0, phase: 0.4 }]),
  'Tall x': one(['xHeight', { scale: 1.2 }]),
  Everything: one(['weight', { amount: 0.4 }], ['slant', { amount: 0.3 }], ['wobble', { amount: 0.4 }], ['jitter', { amount: 0.3 }], ['bounce', { amount: 0.4 }], ['inflate', { amount: 0.2 }], ['melt', { amount: 0.3 }], ['glitch', { amount: 0.3 }], ['erode', { amount: 0.3 }]),
};
