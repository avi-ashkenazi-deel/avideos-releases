import Alea from 'alea';
import { createNoise2D, createNoise3D } from 'simplex-noise';

export interface Rng {
  /** uniform [0,1) */
  (): number;
  range(lo: number, hi: number): number;
  int(lo: number, hi: number): number;
  pick<T>(arr: readonly T[]): T;
  gauss(mean?: number, sd?: number): number;
  noise2(x: number, y: number): number;
  noise3(x: number, y: number, z: number): number;
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic PRNG + noise bound to a seed. Same seed => same sequence. */
export function makeRng(seed: number | string): Rng {
  const a = Alea(typeof seed === 'string' ? hashString(seed) : seed);
  const n2 = createNoise2D(Alea(a.uint32()));
  const n3 = createNoise3D(Alea(a.uint32()));
  const rng = (() => a()) as Rng;
  rng.range = (lo, hi) => lo + (hi - lo) * a();
  rng.int = (lo, hi) => lo + Math.floor(a() * (hi - lo + 1));
  rng.pick = (arr) => arr[Math.floor(a() * arr.length)];
  rng.gauss = (mean = 0, sd = 1) => {
    const u = 1 - a(), v = a();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  rng.noise2 = n2;
  rng.noise3 = n3;
  return rng;
}

/** Glyph-scoped rng: independent of processing order. */
export function glyphRng(seed: number, char: string, salt = ''): Rng {
  return makeRng((seed ^ hashString(char + salt)) >>> 0);
}
