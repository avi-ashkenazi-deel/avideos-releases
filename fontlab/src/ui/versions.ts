import { store } from './state';
import type { FontProject, Contour } from '../core/glyph';
import { layoutText } from '../export/specimen/svg';
import { getCurrentId } from '../project/library';
import { saveVersion, SCRATCH, type VersionMeta } from '../project/versions';

/** Which version list the open font uses. */
export const currentFontKey = (): string => getCurrentId() ?? SCRATCH;

/** Small SVG of the first words of the preview text, from built shapes (integer coordinates, kept short). */
export function previewSvg(project: FontProject, built: Record<string, { advance: number; contours: Contour[] }>, maxChars = 14): string {
  const text = (project.previewText.split('\n')[0] || 'Aa').slice(0, maxChars);
  const lay = layoutText(text, (ch) => { const b = built[ch]; return b && b.contours.length ? { advance: b.advance, contours: b.contours } : undefined; }, project.metrics);
  if (!lay.items.length) return '';
  const m = project.metrics, pad = 40;
  let d = '';
  for (const it of lay.items) for (const c of it.g.contours) {
    if (c.points.length < 3) continue;
    // every other point is plenty for a thumbnail
    const step = c.points.length > 60 ? 2 : 1;
    for (let i = 0; i < c.points.length; i += step) d += `${i ? 'L' : 'M'}${Math.round(c.points[i][0] + it.x + pad)} ${Math.round(m.ascender + pad - c.points[i][1])}`;
    d += 'Z';
  }
  const w = Math.round(lay.width + pad * 2), hgt = Math.round(m.ascender - m.descender + pad * 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${hgt}"><path d="${d}" fill="currentColor"/></svg>`;
}

/** Snapshot the open font before something risky. Never throws; resolves to null on failure. */
export async function autoVersion(reason: string): Promise<VersionMeta | null> {
  try {
    if (!Object.keys(store.project.glyphs).length) return null;
    return await saveVersion(currentFontKey(), store.project, { name: reason, auto: true, preview: previewSvg(store.project, store.built) });
  } catch { return null; }
}
