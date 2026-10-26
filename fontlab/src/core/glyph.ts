/**
 * Core data model. All coordinates are font units: 1000 units per em,
 * baseline at y = 0, y grows UPWARD (OpenType convention). UI code converts.
 */
import type { FxStack } from '../fx/types';

export type Vec = [number, number];

export interface StrokePoint {
  x: number;
  y: number;
  /** half stroke width in font units */
  w: number;
  /** raw pointer pressure 0..1 if known */
  p?: number;
}

export type CapStyle = 'round' | 'flat' | 'taper';

export interface Stroke {
  id: string;
  points: StrokePoint[];
  cap: CapStyle;
}

/** Flattened closed polygon. Outer contours CCW (positive area), holes CW. */
export interface Contour {
  points: Vec[];
}

/**
 * Editable curve contour: closed loop of cubic Béziers [p0, c1, c2, p3].
 * segments[i][3] === segments[i+1][0] and the last segment ends at `start`.
 * A straight segment has c1 = p0 and c2 = p3 (collinear controls also count).
 */
export interface CurveContour {
  start: Vec;
  segments: [Vec, Vec, Vec, Vec][];
}

export type GlyphSource = 'drawn' | 'traced' | 'imported' | 'generated';

export interface RecipeInstance {
  /** recipe id in src/core/recipes */
  id: string;
  /** per-glyph mutation seed */
  seed: number;
  /** named parameter overrides chosen at compose time */
  params: Record<string, number>;
}

export interface Glyph {
  char: string;
  unicode: number;
  /** advance width in font units */
  advance: number;
  source: GlyphSource;
  kind: 'stroke' | 'outline';
  strokes?: Stroke[];
  contours?: Contour[];
  /**
   * Outline glyphs only: editable source of truth when present; `contours`
   * is then its flattening (see inputs/draw/curves.ts flattenCurves).
   * Whoever edits `curves` must re-flatten `contours`.
   */
  curves?: CurveContour[];
  recipe?: RecipeInstance;
  /** user-edited: generator must not overwrite */
  locked?: boolean;
}

export interface StyleStats {
  strokeWidth: number;       // mean full stroke width
  widthVariance: number;     // 0..1 relative variance of width along strokes
  xHeight: number;
  capHeight: number;
  ascender: number;
  descender: number;
  overshoot: number;
  contrast: number;          // 0..1 thick/thin ratio (0 = monoline)
  slantDeg: number;
  cornerRadius: number;      // 0..1 how rounded corners are
  terminal: CapStyle;
  wobbleAmp: number;         // units of deviation from fitted smooth path
  wobbleFreq: number;
  spacing: number;           // mean sidebearing in font units
}

export interface DnaParams {
  weight: number;   // -1..1 (thinner..bolder)
  slant: number;    // -1..1 (deg = slant*30)
  wobble: number;   // 0..1
  melt: number;     // 0..1
  inflate: number;  // 0..1
  erode: number;    // 0..1
  glitch: number;   // 0..1
  bounce: number;   // 0..1
  jitter: number;   // 0..1
  seed: number;
}

export interface FontMetrics {
  upm: 1000;
  ascender: number;
  descender: number;
  xHeight: number;
  capHeight: number;
}

export interface FontProject {
  version: 1;
  name: string;
  metrics: FontMetrics;
  /** user-provided glyphs (drawn / traced / imported) */
  seeds: Glyph[];
  /** full working set keyed by char; includes seeds + generated */
  glyphs: Record<string, Glyph>;
  stats: StyleStats;
  /** effect stack (see fx/types.ts) */
  fx: FxStack;
  /** 0..1 randomness when generating */
  mutation: number;
  previewText: string;
  /** enabled character blocks (see core/charsets.ts); 'latin' is implicit */
  blocks: string[];
  /** extra hand-drawn characters, any script */
  customChars: string;
}

export const DEFAULT_METRICS: FontMetrics = {
  upm: 1000,
  ascender: 800,
  descender: -200,
  xHeight: 500,
  capHeight: 700,
};

export const DEFAULT_STATS: StyleStats = {
  strokeWidth: 90,
  widthVariance: 0.1,
  xHeight: 500,
  capHeight: 700,
  ascender: 740,
  descender: -200,
  overshoot: 12,
  contrast: 0,
  slantDeg: 0,
  cornerRadius: 0.6,
  terminal: 'round',
  wobbleAmp: 0,
  wobbleFreq: 1,
  spacing: 60,
};

export const DEFAULT_DNA: DnaParams = {
  weight: 0, slant: 0, wobble: 0, melt: 0, inflate: 0,
  erode: 0, glitch: 0, bounce: 0, jitter: 0, seed: 1,
};

export const CHARSET: string =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function newProject(name = 'Untitled'): FontProject {
  return {
    version: 1,
    name,
    metrics: { ...DEFAULT_METRICS },
    seeds: [],
    glyphs: {},
    stats: { ...DEFAULT_STATS },
    fx: { seed: 1, time: 0, groups: [{ id: 'g0', enabled: true, op: 'union', layers: [] }] },
    mutation: 0.3,
    previewText: 'The quick brown fox jumps over the lazy dog 0123456789',
    blocks: ['latin'],
    customChars: '',
  };
}

let idCounter = 0;
export function uid(prefix = 's'): string {
  idCounter = (idCounter + 1) % 1e9;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export function cloneGlyph(g: Glyph): Glyph {
  return JSON.parse(JSON.stringify(g));
}
