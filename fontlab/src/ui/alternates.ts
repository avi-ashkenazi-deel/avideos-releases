import { store } from './state';
import { toast } from './dom';
import { cloneGlyph } from '../core/glyph';
import { scheduleBuild } from './buildClient';

export const MAX_ALTERNATES = 3;
export const FEATURE_TAGS = ['ss01', 'ss02', 'ss03', 'tnum'] as const;

/** Keep a copy of the current letter as the next stylistic set (ss01..ss03). */
export function keepAlternate(ch: string): void {
  const g = store.project.glyphs[ch];
  if (!g) { toast('Nothing to keep yet.'); return; }
  const list = store.project.alternates?.[ch] ?? [];
  if (list.length >= MAX_ALTERNATES) { toast(`“${ch}” already has ${MAX_ALTERNATES} alternates. Remove some first.`); return; }
  store.update((p) => { (p.alternates ??= {})[ch] = [...list, cloneGlyph(g)]; }, 'glyph');
  scheduleBuild(0);
  toast(`Saved as ss0${list.length + 1}. Re-roll or redraw “${ch}” to make a different main version.`);
}

/** Swap alternate i with the main letter. */
export function useAlternate(ch: string, i: number): void {
  const list = store.project.alternates?.[ch];
  const g = store.project.glyphs[ch];
  if (!list?.[i]) return;
  store.update((p) => {
    const alts = [...(p.alternates[ch] ?? [])];
    const alt = alts[i];
    if (g) alts[i] = cloneGlyph(g); else alts.splice(i, 1);
    p.alternates[ch] = alts;
    p.glyphs[ch] = cloneGlyph(alt);
  }, 'glyph');
  scheduleBuild(0);
  toast(`ss0${i + 1} is now the main “${ch}”.`);
}

export function clearAlternates(ch: string): void {
  if (!store.project.alternates?.[ch]?.length) return;
  store.update((p) => { delete p.alternates[ch]; }, 'glyph');
  scheduleBuild(0);
  toast(`Alternates of “${ch}” removed. Undo brings them back.`);
}

/** CSS font-feature-settings for the toggled features. */
export function featureCss(): string {
  return store.features.length ? store.features.map((f) => `"${f}" 1`).join(', ') : 'normal';
}

/** Which feature chips make sense right now (sets in use, digits for tnum). */
export function availableFeatures(): string[] {
  const alts = store.project.alternates ?? {};
  const maxSet = Math.max(0, ...Object.values(alts).map((l) => l.length));
  const out: string[] = [];
  for (let i = 1; i <= maxSet; i++) out.push(`ss0${i}`);
  if ('0123456789'.split('').some((d) => store.project.glyphs[d])) out.push('tnum');
  return out;
}
