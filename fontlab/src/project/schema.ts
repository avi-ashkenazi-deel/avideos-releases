import type { FontProject, Glyph } from '../core/glyph';
import { newProject, DEFAULT_DNA, DEFAULT_STATS, DEFAULT_METRICS } from '../core/glyph';

/** Validate + normalise an untrusted JSON object into a FontProject. Throws on garbage. */
export function parseProject(raw: unknown): FontProject {
  if (!raw || typeof raw !== 'object') throw new Error('Not a project file');
  const r = raw as Record<string, any>;
  if (r.version !== 1) throw new Error(`Unsupported project version ${r.version}`);
  const p = newProject(typeof r.name === 'string' ? r.name : 'Untitled Funk');
  p.metrics = { ...DEFAULT_METRICS, ...(r.metrics ?? {}), upm: 1000 };
  p.stats = { ...DEFAULT_STATS, ...(r.stats ?? {}) };
  p.dna = { ...DEFAULT_DNA, ...(r.dna ?? {}) };
  p.mutation = typeof r.mutation === 'number' ? r.mutation : 0.3;
  p.previewText = typeof r.previewText === 'string' ? r.previewText : p.previewText;
  p.seeds = Array.isArray(r.seeds) ? r.seeds.filter(isGlyph) : [];
  p.glyphs = {};
  if (r.glyphs && typeof r.glyphs === 'object') {
    for (const [k, v] of Object.entries(r.glyphs)) if (isGlyph(v)) p.glyphs[k] = v as Glyph;
  }
  return p;
}

export function isGlyph(g: unknown): g is Glyph {
  if (!g || typeof g !== 'object') return false;
  const o = g as Record<string, any>;
  if (typeof o.char !== 'string' || typeof o.unicode !== 'number' || typeof o.advance !== 'number') return false;
  if (o.kind === 'stroke') return Array.isArray(o.strokes);
  if (o.kind === 'outline') return Array.isArray(o.contours);
  return false;
}

export function serializeProject(p: FontProject): string {
  return JSON.stringify(p);
}
