import type { FontProject, Glyph } from '../core/glyph';
import { newProject, DEFAULT_STATS, DEFAULT_METRICS } from '../core/glyph';
import { migrateDna, newStack } from '../fx/stack';
import { FX, defaultParams } from '../fx/registry';

/** Validate + normalise an untrusted JSON object into a FontProject. Throws on garbage. */
export function parseProject(raw: unknown): FontProject {
  if (!raw || typeof raw !== 'object') throw new Error('Not a project file');
  const r = raw as Record<string, any>;
  if (r.version !== 1) throw new Error(`Unsupported project version ${r.version}`);
  const p = newProject(typeof r.name === 'string' ? r.name : 'Untitled Funk');
  p.metrics = { ...DEFAULT_METRICS, ...(r.metrics ?? {}), upm: 1000 };
  p.stats = { ...DEFAULT_STATS, ...(r.stats ?? {}) };
  p.fx = parseStack(r.fx) ?? migrateDna(r.dna);
  p.mutation = typeof r.mutation === 'number' ? r.mutation : 0.3;
  p.previewText = typeof r.previewText === 'string' ? r.previewText : p.previewText;
  p.blocks = Array.isArray(r.blocks) ? ['latin', ...r.blocks.filter((b: unknown) => typeof b === 'string' && b !== 'latin')] : ['latin'];
  p.customChars = typeof r.customChars === 'string' ? r.customChars : '';
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

function parseStack(raw: unknown) {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, any>;
  const s = newStack(typeof r.seed === 'number' ? r.seed : 1);
  s.time = typeof r.time === 'number' ? r.time : 0;
  if (Array.isArray(r.groups) && r.groups.length) {
    s.groups = r.groups.map((g: any, gi: number) => ({
      id: typeof g?.id === 'string' ? g.id : `g${gi}`,
      enabled: g?.enabled !== false,
      op: ['union', 'subtract', 'intersect', 'xor'].includes(g?.op) ? g.op : 'union',
      layers: (Array.isArray(g?.layers) ? g.layers : []).filter((l: any) => l && typeof l.type === 'string' && FX[l.type]).map((l: any, li: number) => ({
        id: typeof l.id === 'string' ? l.id : `g${gi}l${li}`,
        type: l.type,
        enabled: l.enabled !== false,
        params: { ...defaultParams(l.type), ...Object.fromEntries(Object.entries(l.params ?? {}).filter(([, v]) => typeof v === 'number' && Number.isFinite(v))) },
      })),
    }));
  }
  return s;
}
