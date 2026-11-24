/**
 * Automatic pair kerning from edge profiles.
 *
 * For an ordered pair (L, R) the gap at each height is
 *   gap(y) = (advance_L − right_L(y)) + left_R(y).
 * Two numbers are read off it:
 *   • the WHITE between the letters: the mean gap over the overlap of the two
 *     letters' zones, with the depth beyond the pair's closest point capped,
 *     exactly the quantity the auto spacer equalises per glyph. Two
 *     well-spaced flat stems measure `target`; AV, To, LT, "r." measure more.
 *   • the CLEARANCE: the closest approach of the two shapes in 2D (not only at
 *     equal heights), so a round can only slide under a T bar or a dot under
 *     an arm until it gets as close as two stems stand.
 * kern = max(target − white, −(clearance − limit)) · strength, i.e. a pair is
 * tightened until its white matches the font's rhythm or until the shapes
 * are as close as two stems, whichever comes first. Pairs that are already
 * that close (nn, HH, oo, no) come out 0. Positive kerns are only produced
 * to separate shapes that would otherwise (nearly) touch.
 */
import type { Contour, FontMetrics } from '../core/glyph';
import { depthLimit, edgeProfile, stemBearing, zoneBands, zoneFor, PROFILE_SAMPLES, type EdgeProfile } from './profile';

export interface KernGlyph { advance: number; contours: Contour[] }

/**
 * Profile cache keyed by the identity of a glyph's `contours` array (never
 * mutate those in place). Any WeakMap or Map works; the WeakMap from
 * `createProfileCache()` lets entries die with their glyphs.
 */
export interface ProfileCache {
  get(contours: Contour[]): { key: string; profile: EdgeProfile } | undefined;
  set(contours: Contour[], entry: { key: string; profile: EdgeProfile }): unknown;
}
export const createProfileCache = (): ProfileCache => new WeakMap<Contour[], { key: string; profile: EdgeProfile }>();
const sharedCache: ProfileCache = createProfileCache();

export const KERN = {
  /** closest allowed approach of two shapes when tightening, × target (1 = as close as two stems) */
  clearance: 1,
  /** … and how far that clearance reaches vertically, × xHeight: less than the room between the
   *  x-height and a T bar, so lowercase can slide under an overhang */
  reach: 0.16,
  /** share of the correction applied to a pair that only meets on a sliver of its height (T., P., L'):
   *  rises linearly to 1 for pairs that face each other over their whole height */
  partial: 0.55,
  /** depth cap for the white between a pair, × the spacer's per-side depth limit */
  depth: 2,
  /** most negative kern, × advance of the left glyph */
  maxTighten: 0.35,
  /** most positive kern, font units */
  maxLoosen: 60,
  /** shapes closer than this (font units, at equal heights) are pushed apart: clamp(minGap × target, lo, hi) */
  minGap: 0.2, minGapLo: 15, minGapHi: 30,
  /** values are rounded to multiples of this */
  step: 5,
  /** weight of a non-basic character (accents …) when ranking pairs for `maxPairs` */
  extendedWeight: 0.6,
};

export interface AutoKernOptions {
  metrics: FontMetrics;
  /** 0 = tight … 1 = loose: the same value the glyphs were auto-spaced with */
  tightness: number;
  /** 0..1 share of the measured correction that is applied (default 1) */
  strength?: number;
  /** candidate characters (default: every key of `glyphs`); a pair needs both */
  chars?: string[];
  /** pairs weaker than this many units are dropped (default 12) */
  threshold?: number;
  /** keep only the strongest pairs (default 3000) */
  maxPairs?: number;
  /** profile cache; a module-level one is used when omitted */
  profiles?: ProfileCache;
  /** white between two well-spaced stems, font units. Default: 2 × the auto spacer's stem bearing at
   *  `tightness`, or the font's own stem-to-stem white if the font is spaced looser than that. */
  target?: number;
}

// ---- which characters kern with which -------------------------------------------------------

const PUNCT = new Set([...`.,:;!?'"-–—‘’‚“”„«»‹›`]);
const RE_LETTER = /\p{L}/u;
const RE_LATIN = /\p{Script=Latin}/u;
const RE_CYRILLIC = /\p{Script=Cyrillic}/u;
const RE_GREEK = /\p{Script=Greek}/u;
const SKIP = 0, DIGIT = 1, PUNCTUATION = 2, LATIN = 3, CYRILLIC = 4, GREEK = 5;
const classMemo = new Map<string, number>();

/** 0 = not kerned (symbols, right-to-left scripts …), 1 digit, 2 punctuation, ≥ 3 a left-to-right script. */
export function kernClass(ch: string): number {
  let c = classMemo.get(ch);
  if (c !== undefined) return c;
  if (ch.length === 1 && ch >= '0' && ch <= '9') c = DIGIT;
  else if (PUNCT.has(ch)) c = PUNCTUATION;
  else if (!RE_LETTER.test(ch)) c = SKIP;
  else if (RE_LATIN.test(ch)) c = LATIN;
  else if (RE_CYRILLIC.test(ch)) c = CYRILLIC;
  else if (RE_GREEK.test(ch)) c = GREEK;
  else c = SKIP;
  if (classMemo.size > 5000) classMemo.clear();
  classMemo.set(ch, c);
  return c;
}

/** Letters kern within their script; digits with digits and any letter; punctuation with letters and digits. */
function kernable(a: number, b: number): boolean {
  if (a === SKIP || b === SKIP) return false;
  if (a >= LATIN && b >= LATIN) return a === b;
  return !(a === PUNCTUATION && b === PUNCTUATION);
}

const isBasic = (ch: string) => {
  const c = ch.codePointAt(0) ?? 0;
  return c < 0x80 || (c >= 0x410 && c <= 0x44f);
};

// ---- profiles -------------------------------------------------------------------------------

function profileOf(contours: Contour[], metrics: FontMetrics, cache: ProfileCache): EdgeProfile {
  const key = `${metrics.ascender}:${metrics.descender}:${PROFILE_SAMPLES}`;
  const hit = cache.get(contours);
  if (hit && hit.key === key) return hit.profile;
  const profile = edgeProfile(contours, metrics);
  cache.set(contours, { key, profile });
  return profile;
}

/** Grow a margin profile by an ellipse (band extremes make direct neighbours count almost fully). */
function dilateInto(src: Float64Array, dst: Float64Array, base: number, n: number, offsets: Float64Array): void {
  const J = (offsets.length - 1) >> 1;
  for (let i = 0; i < n; i++) {
    let best = Infinity;
    const lo = i - J < 0 ? 0 : i - J, hi = i + J > n - 1 ? n - 1 : i + J;
    for (let j = lo; j <= hi; j++) {
      const v = src[base + j] - offsets[j - i + J];
      if (v < best) best = v;
    }
    dst[base + i] = best;
  }
}

/** Horizontal growth per band offset for an ellipse with radii rx (across) and ry (up/down). */
function ellipseOffsets(rx: number, ry: number, h: number): Float64Array {
  const J = Math.max(0, Math.ceil(ry / h));
  const out = new Float64Array(2 * J + 1);
  for (let j = -J; j <= J; j++) {
    const dy = j === 0 ? 0 : Math.abs(j) * h - h / 2;
    out[j + J] = dy < ry ? rx * Math.sqrt(1 - (dy * dy) / (ry * ry)) : -Infinity; // −∞: out of reach, never the minimum
  }
  return out;
}

/**
 * Smallest horizontal gap between two glyphs set side by side (optionally
 * with a kern applied), over the heights where both have ink. Infinity when
 * they share no height. Use it to check that a kern does not make a pair touch.
 */
export function pairGap(left: KernGlyph, right: KernGlyph, metrics: FontMetrics, kern = 0, profiles: ProfileCache = sharedCache): number {
  const a = profileOf(left.contours, metrics, profiles), b = profileOf(right.contours, metrics, profiles);
  let min = Infinity;
  for (let i = 0; i < a.ys.length; i++) {
    const g = left.advance - a.right[i] + b.left[i];
    if (g < min) min = g; // NaN never compares below
  }
  return min + kern;
}

// ---- the kerner -----------------------------------------------------------------------------

/**
 * Automatic kerning for a built glyph set. Returns pairs keyed by the two
 * characters (`{ AV: -85 }`), strongest first, values in font units rounded
 * to multiples of 5; negative = tighter.
 */
export function autoKern(glyphs: Record<string, KernGlyph>, opts: AutoKernOptions): Record<string, number> {
  const { metrics } = opts;
  const strength = Math.max(0, Math.min(1, opts.strength ?? 1));
  const threshold = opts.threshold ?? 12;
  const maxPairs = Math.max(0, Math.floor(opts.maxPairs ?? 3000));
  if (!(strength > 0) || maxPairs === 0) return {};
  const cache = opts.profiles ?? sharedCache;

  // candidates: kernable characters that have ink
  const chars: string[] = [];
  const profiles: EdgeProfile[] = [];
  const seen = new Set<string>();
  for (const ch of opts.chars ?? Object.keys(glyphs)) {
    const g = glyphs[ch];
    if (!g || seen.has(ch) || !g.contours?.length || kernClass(ch) === SKIP) continue;
    seen.add(ch);
    const p = profileOf(g.contours, metrics, cache);
    if (!p.left.some((v) => v === v)) continue;
    chars.push(ch); profiles.push(p);
  }
  const G = chars.length;
  if (G === 0) return {};
  const n = profiles[0].ys.length;
  const h = profiles[0].ys[1] - profiles[0].ys[0];
  const depthSide = depthLimit(metrics);

  // per-glyph margins: white from the ink edge to the advance box, +∞ where there is no ink
  const RM = new Float64Array(G * n), LM = new Float64Array(G * n);
  const Z0 = new Int32Array(G), Z1 = new Int32Array(G);
  const CLS = new Int8Array(G), ADV = new Float64Array(G);
  const flat: number[] = [];
  let overhang = 0, sides = 0;
  for (let a = 0; a < G; a++) {
    const p = profiles[a], adv = glyphs[chars[a]].advance, base = a * n;
    for (let i = 0; i < n; i++) {
      const l = p.left[i];
      if (l !== l) { RM[base + i] = Infinity; LM[base + i] = Infinity; }
      else { RM[base + i] = adv - p.right[i]; LM[base + i] = l; }
    }
    const [i0, i1] = zoneBands(p.ys, zoneFor(chars[a], metrics, p));
    Z0[a] = i0; Z1[a] = i1; ADV[a] = adv;
    CLS[a] = kernClass(chars[a]);
    // flat sides (stems) tell how the font is actually spaced; overhangs tell whether touching is intended
    for (const M of [RM, LM]) {
      let minZone = Infinity, minAll = Infinity, white = 0;
      for (let i = 0; i < n; i++) if (M[base + i] < minAll) minAll = M[base + i];
      for (let i = i0; i < i1; i++) if (M[base + i] < minZone) minZone = M[base + i];
      if (CLS[a] >= LATIN) { sides++; if (minAll < 0) overhang++; }
      if (minZone === Infinity || CLS[a] < LATIN) continue;
      for (let i = i0; i < i1; i++) white += Math.min(M[base + i] - minZone, depthSide);
      if (white / (i1 - i0) <= 0.08 * depthSide) flat.push(minZone);
    }
  }

  let target = opts.target ?? 2 * stemBearing(metrics, opts.tightness);
  if (opts.target === undefined && flat.length >= 4) {
    flat.sort((x, y) => x - y);
    const rhythm = 2 * flat[flat.length >> 1];
    if (rhythm > target) target = rhythm; // never use kerning to re-space a loosely spaced font
  }
  const depthPair = KERN.depth * depthSide;
  const minGap = Math.max(KERN.minGapLo, Math.min(KERN.minGapHi, KERN.minGap * target));
  const separate = overhang <= sides * 0.25; // connected / overlapping designs keep their touching pairs

  // margins grown by half the clearance each: two grown shapes touch when the real ones are `clearance` apart
  const RMD = new Float64Array(G * n), LMD = new Float64Array(G * n);
  const rx = (KERN.clearance * target) / 2;
  const offsets = ellipseOffsets(rx, Math.min(rx, (KERN.reach * (metrics.xHeight > 0 ? metrics.xHeight : 500)) / 2), h);
  for (let a = 0; a < G; a++) { dilateInto(RM, RMD, a * n, n, offsets); dilateInto(LM, LMD, a * n, n, offsets); }

  const step = KERN.step;
  const found: { key: string; value: number; score: number }[] = [];
  for (let a = 0; a < G; a++) {
    const an = a * n, ca = CLS[a], za0 = Z0[a], za1 = Z1[a];
    const maxTighten = -KERN.maxTighten * ADV[a];
    for (let b = 0; b < G; b++) {
      if (!kernable(ca, CLS[b])) continue;
      const bn = b * n;
      let room = Infinity, gmin = Infinity;
      for (let i = 0; i < n; i++) {
        const g = RM[an + i] + LM[bn + i];
        if (g < gmin) gmin = g;
        const p = RMD[an + i] + LMD[bn + i];
        if (p < room) room = p;
      }
      if (gmin === Infinity) continue; // no height in common: nothing to measure
      let k = 0;
      if (room > 0) {
        const i0 = za0 > Z0[b] ? za0 : Z0[b], i1 = za1 < Z1[b] ? za1 : Z1[b];
        if (i1 > i0) {
          let gz = Infinity;
          for (let i = i0; i < i1; i++) { const g = RM[an + i] + LM[bn + i]; if (g < gz) gz = g; }
          if (gz !== Infinity) {
            const cap = gz + depthPair;
            let sum = 0, facing = 0;
            for (let i = i0; i < i1; i++) {
              const g = RM[an + i] + LM[bn + i];
              if (g < cap) { sum += g; facing++; } else { sum += cap; if (g !== Infinity) facing++; }
            }
            const tallest = za1 - za0 > Z1[b] - Z0[b] ? za1 - za0 : Z1[b] - Z0[b];
            const want = target - sum / (i1 - i0);
            if (want < 0) k = Math.max(want, -room, maxTighten) * (KERN.partial + (1 - KERN.partial) * (facing / tallest)) * strength;
          }
        }
      }
      if (separate && gmin + k < minGap) k = Math.min(KERN.maxLoosen, minGap - gmin);
      if (k === 0) continue;
      // tightening rounds to the nearest step, separating rounds up so the minimum gap really holds
      const value = (k < 0 ? Math.round(k / step) : Math.min(Math.ceil(k / step), Math.floor(KERN.maxLoosen / step))) * step;
      if (value === 0 || Math.abs(value) < threshold) continue;
      const score = Math.abs(value) * (isBasic(chars[a]) ? 1 : KERN.extendedWeight) * (isBasic(chars[b]) ? 1 : KERN.extendedWeight);
      found.push({ key: chars[a] + chars[b], value, score });
    }
  }
  found.sort((x, y) => y.score - x.score || Math.abs(y.value) - Math.abs(x.value) || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  const out: Record<string, number> = {};
  for (let i = 0; i < found.length && i < maxPairs; i++) out[found[i].key] = found[i].value;
  return out;
}

/**
 * Combine automatic and manual pairs: manual values always win, and a manual
 * 0 removes the automatic pair (the result never contains zeros).
 */
export function mergeKerning(auto: Record<string, number>, manual: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(auto ?? {})) if (Number.isFinite(v) && v !== 0 && !(manual && k in manual)) out[k] = v;
  for (const [k, v] of Object.entries(manual ?? {})) if (Number.isFinite(v) && v !== 0) out[k] = v;
  return out;
}
