/**
 * Automatic side bearings, HT Letterspacer style: each side bearing is chosen
 * so that the white between the ink edge and the glyph boundary, measured
 * inside the letter's zone and with the depth of open shapes capped, has the
 * same area per unit height for every letter. A straight stem therefore gets
 * the full target as its bearing, a round gets less (its curve already
 * carries white), and open diagonals / arms (v, A, T, L, r, c) get close to
 * the minimum.
 */
import type { Contour, CurveContour, FontMetrics, FontProject, Glyph, Vec } from '../core/glyph';
import { glyphToContours } from '../outline';
import {
  SPACING, depthLimit, edgeProfile, stemBearing, zoneBands, zoneFor,
  type EdgeProfile, type Zone,
} from './profile';

export interface SpacingOptions {
  metrics: FontMetrics;
  /** 0 = tight … 1 = loose */
  tightness: number;
  /** where a glyph's filled contours come from (default `glyphToContours`); pass a cached lookup to skip
   *  the stroke expansion / union, which is nearly all of the cost */
  contoursOf?: (g: Glyph) => Contour[];
}

export interface Sidebearings { lsb: number; rsb: number }

/**
 * Side bearings (whole font units, measured from the glyph's outermost ink)
 * for a profile spaced in `zone`.
 */
export function sidebearings(profile: EdgeProfile, zone: Zone, opts: SpacingOptions): Sidebearings {
  const target = stemBearing(opts.metrics, opts.tightness);
  const depth = depthLimit(opts.metrics);
  const floor = Math.max(SPACING.minBearing, SPACING.floor * target);
  const { ys, left, right } = profile;
  const n = ys.length;

  let fullL = Infinity, fullR = -Infinity;
  for (let i = 0; i < n; i++) {
    const l = left[i];
    if (l !== l) continue;
    if (l < fullL) fullL = l;
    if (right[i] > fullR) fullR = right[i];
  }
  if (fullL === Infinity) { const b = Math.round(target); return { lsb: b, rsb: b }; }

  let [i0, i1] = zoneBands(ys, zone);
  let zoneL = Infinity, zoneR = -Infinity;
  for (let i = i0; i < i1; i++) {
    const l = left[i];
    if (l !== l) continue;
    if (l < zoneL) zoneL = l;
    if (right[i] > zoneR) zoneR = right[i];
  }
  if (zoneL === Infinity) { i0 = 0; i1 = n; zoneL = fullL; zoneR = fullR; }

  // mean white already inside the glyph's zone box, depth capped; bands without ink are fully open
  let whiteL = 0, whiteR = 0;
  for (let i = i0; i < i1; i++) {
    const l = left[i];
    if (l !== l) { whiteL += depth; whiteR += depth; continue; }
    whiteL += Math.min(l - zoneL, depth);
    whiteR += Math.min(zoneR - right[i], depth);
  }
  const bands = i1 - i0;
  whiteL /= bands; whiteR /= bands;

  // bearing from the zone extreme, then re-expressed from the outermost ink (hooks, tails, accents
  // that stick out of the zone eat into the bearing, but never below the floor)
  const lsb = Math.max(floor, Math.max(floor, target - whiteL) - (zoneL - fullL));
  const rsb = Math.max(floor, Math.max(floor, target - whiteR) - (fullR - zoneR));
  return { lsb: Math.round(lsb), rsb: Math.round(rsb) };
}

const r1 = (v: number) => Math.round(v * 10) / 10 + 0; // "+ 0" normalises -0

/** A copy of the glyph moved horizontally: strokes, contours and curves, x rounded to 0.1. */
export function shiftGlyph(g: Glyph, dx: number): Glyph {
  const out: Glyph = { ...g };
  if (g.strokes) {
    out.strokes = g.strokes.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p, x: r1(p.x + dx) })) }));
  }
  if (g.contours) {
    out.contours = g.contours.map((c) => ({ ...c, points: c.points.map(([x, y]) => [r1(x + dx), y] as Vec) }));
  }
  if (g.curves) {
    const mv = (p: Vec): Vec => [r1(p[0] + dx), p[1]];
    out.curves = g.curves.map((c): CurveContour => ({
      ...c,
      start: mv(c.start),
      segments: c.segments.map((s) => [mv(s[0]), mv(s[1]), mv(s[2]), mv(s[3])] as [Vec, Vec, Vec, Vec]),
    }));
  }
  if (g.recipe) out.recipe = { ...g.recipe, params: { ...g.recipe.params } };
  return out;
}

/**
 * Auto-space one glyph: returns a copy shifted so its ink starts at the new
 * left bearing, with `advance = lsb + ink width + rsb`. Returns the SAME
 * object when there is nothing to do: no ink, `spacingLocked`, or the glyph
 * is already spaced exactly like this.
 */
export function autoSpaceGlyph(g: Glyph, opts: SpacingOptions): Glyph {
  if (!g || g.spacingLocked) return g;
  const contours = (opts.contoursOf ?? glyphToContours)(g);
  if (!contours.length) return g;
  const profile = edgeProfile(contours, opts.metrics);
  let minX = Infinity, maxX = -Infinity;
  for (const c of contours) for (const p of c.points) { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; }
  if (!(maxX >= minX)) return g;
  const { lsb, rsb } = sidebearings(profile, zoneFor(g.char, opts.metrics, profile), opts);
  const dx = r1(lsb - minX);
  const width = lsb + (maxX - minX) + rsb;
  // Already there. The tolerance (1.5 units per bearing) makes a second pass a no-op: moving the points
  // on the 0.1 grid re-runs the outline union, which can move the re-measured bearings by a unit.
  if (Math.abs(lsb - minX) <= 1.5 && Math.abs(width - g.advance) <= 3) return g;
  const out = dx === 0 ? { ...g } : shiftGlyph(g, dx);
  out.advance = Math.max(1, Math.round(width));
  return out;
}

export interface AutoSpaceResult {
  /** full glyph record: untouched glyphs keep their identity */
  glyphs: Record<string, Glyph>;
  /** characters whose glyph was replaced */
  changed: string[];
  /** stylistic alternates of the processed characters, spaced the same way (same arrays when unchanged) */
  alternates: Record<string, Glyph[]>;
}

/**
 * Auto-space a project's glyphs (all, or `chars`). Does not mutate the
 * project; glyphs with `spacingLocked` and empty glyphs are passed through.
 */
export function autoSpaceProject(
  project: Pick<FontProject, 'glyphs' | 'metrics'> & Partial<Pick<FontProject, 'spacing' | 'alternates'>>,
  chars?: string[],
): AutoSpaceResult {
  const t = project.spacing?.tightness;
  const opts: SpacingOptions = { metrics: project.metrics, tightness: typeof t === 'number' && Number.isFinite(t) ? t : 0.5 };
  const glyphs: Record<string, Glyph> = { ...project.glyphs };
  const alternates: Record<string, Glyph[]> = { ...(project.alternates ?? {}) };
  const changed: string[] = [];
  for (const ch of chars ?? Object.keys(project.glyphs)) {
    const g = project.glyphs[ch];
    if (g) {
      const spaced = autoSpaceGlyph(g, opts);
      if (spaced !== g) { glyphs[ch] = spaced; changed.push(ch); }
    }
    const alts = project.alternates?.[ch];
    if (Array.isArray(alts)) {
      const spacedAlts = alts.map((a) => (a ? autoSpaceGlyph(a, opts) : a));
      if (spacedAlts.some((a, i) => a !== alts[i])) alternates[ch] = spacedAlts;
    }
  }
  return { glyphs, changed, alternates };
}
