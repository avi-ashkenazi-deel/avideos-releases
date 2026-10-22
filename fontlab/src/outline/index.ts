import type { Glyph, Contour } from '../core/glyph';
import { expandStroke, type Ring } from './strokeExpand';
import { unionRings, unionContours } from './union';
import { cleanContours } from './fitCurves';

export function glyphRings(g: Glyph): Ring[] {
  if (g.kind !== 'stroke' || !g.strokes) return [];
  const rings: Ring[] = [];
  for (const s of g.strokes) rings.push(...expandStroke(s));
  return rings;
}

/** Any glyph -> clean, filled, non-overlapping contours. */
export function glyphToContours(g: Glyph): Contour[] {
  if (g.kind === 'outline') return g.contours ? cleanContours(unionContours(g.contours)) : [];
  return cleanContours(unionRings(glyphRings(g)));
}
