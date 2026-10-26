import type { Glyph, Contour } from '../core/glyph';
import { expandStroke, type Ring } from './strokeExpand';
import { unionRings, unionContours } from './union';
import { cleanContours } from './fitCurves';

export function glyphRings(g: Glyph): Ring[] {
  if (!g.strokes) return [];
  const rings: Ring[] = [];
  for (const s of g.strokes) rings.push(...expandStroke(s));
  return rings;
}

/** Any glyph -> clean, filled, non-overlapping contours. */
export function glyphToContours(g: Glyph): Contour[] {
  if (g.kind === 'outline') {
    // imported/traced outline plus anything drawn on top of it
    const extra = glyphRings(g).filter((r) => r.length >= 3).map((points) => ({ points }));
    const all = [...(g.contours ?? []), ...extra];
    return all.length ? cleanContours(unionContours(all)) : [];
  }
  return cleanContours(unionRings(glyphRings(g)));
}
