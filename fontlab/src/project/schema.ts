import type { FontProject, Glyph } from '../core/glyph';
import { newProject, DEFAULT_STATS, DEFAULT_METRICS, DEFAULT_COLOR } from '../core/glyph';
import type { ColorMode, ReviewNote } from '../core/glyph';
import { migrateDna, newStack } from '../fx/stack';
import { FX, defaultParams } from '../fx/registry';

/** Validate + normalise an untrusted JSON object into a FontProject. Throws on garbage. */
export function parseProject(raw: unknown): FontProject {
  if (!raw || typeof raw !== 'object') throw new Error('Not a project file');
  const r = raw as Record<string, any>;
  if (r.version !== 1) throw new Error(`Unsupported project version ${r.version}`);
  const p = newProject(typeof r.name === 'string' ? r.name : 'Untitled');
  p.metrics = { ...DEFAULT_METRICS, ...(r.metrics ?? {}), upm: 1000 };
  p.stats = { ...DEFAULT_STATS, ...(r.stats ?? {}) };
  p.fx = parseStack(r.fx) ?? migrateDna(r.dna);
  p.mutation = typeof r.mutation === 'number' ? r.mutation : 0.3;
  p.previewText = typeof r.previewText === 'string' ? r.previewText : p.previewText;
  p.blocks = Array.isArray(r.blocks) ? ['latin', ...r.blocks.filter((b: unknown) => typeof b === 'string' && b !== 'latin')] : ['latin'];
  p.customChars = typeof r.customChars === 'string' ? r.customChars : '';
  p.seeds = Array.isArray(r.seeds) ? r.seeds.filter(isGlyph) : [];
  p.alternates = {};
  if (r.alternates && typeof r.alternates === 'object') {
    for (const [k, v] of Object.entries(r.alternates)) if (Array.isArray(v)) { const list = v.filter(isGlyph).slice(0, 3) as Glyph[]; if (list.length) p.alternates[k] = list; }
  }
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  p.spacing = { tightness: num(r.spacing?.tightness, 0, 1, 0.5) };
  p.kerning = { auto: !!r.kerning?.auto, strength: num(r.kerning?.strength, 0, 1, 1), pairs: {} };
  if (r.kerning?.pairs && typeof r.kerning.pairs === 'object') {
    for (const [k, v] of Object.entries(r.kerning.pairs)) if ([...k].length === 2 && typeof v === 'number' && Number.isFinite(v)) p.kerning.pairs[k] = Math.round(Math.min(1000, Math.max(-1000, v)));
  }
  const modes: ColorMode[] = ['strokes', 'stripes', 'shadow', 'outline'];
  const hex = (c: unknown): c is string => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
  const pal = Array.isArray(r.color?.palette) ? r.color.palette.filter(hex).slice(0, 8) : [];
  p.color = {
    enabled: !!r.color?.enabled,
    mode: modes.includes(r.color?.mode) ? r.color.mode : DEFAULT_COLOR.mode,
    palette: pal.length >= 2 ? pal : [...DEFAULT_COLOR.palette],
    amount: num(r.color?.amount, 0, 1, DEFAULT_COLOR.amount),
  };
  p.notes = Array.isArray(r.notes) ? r.notes.filter(isNote).slice(0, 500) : [];
  p.glyphs = {};
  if (r.glyphs && typeof r.glyphs === 'object') {
    for (const [k, v] of Object.entries(r.glyphs)) if (isGlyph(v)) p.glyphs[k] = v as Glyph;
  }
  return p;
}

export function isNote(n: unknown): n is ReviewNote {
  if (!n || typeof n !== 'object') return false;
  const o = n as Record<string, any>;
  return typeof o.id === 'string' && typeof o.ch === 'string' && o.ch.length > 0 && typeof o.x === 'number' && typeof o.y === 'number' && typeof o.text === 'string' && o.text.length <= 2000;
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
