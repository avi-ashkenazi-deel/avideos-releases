import { h, slider, button } from '../dom';
import { store } from '../state';
import { scheduleBuild } from '../buildClient';
import type { DnaParams } from '../../core/glyph';
import { DEFAULT_DNA } from '../../core/glyph';

const AXES: { key: keyof DnaParams; label: string; min: number; max: number; hint: string }[] = [
  { key: 'weight', label: 'Weight', min: -1, max: 1, hint: 'thin ↔ chonky' },
  { key: 'slant', label: 'Slant', min: -1, max: 1, hint: 'backslant ↔ italic' },
  { key: 'wobble', label: 'Wobble', min: 0, max: 1, hint: 'nervous hand' },
  { key: 'melt', label: 'Melt', min: 0, max: 1, hint: 'ice cream in July' },
  { key: 'inflate', label: 'Inflate', min: 0, max: 1, hint: 'balloon letters' },
  { key: 'erode', label: 'Rust', min: 0, max: 1, hint: 'eaten by time' },
  { key: 'glitch', label: 'Glitch', min: 0, max: 1, hint: 'bad VHS' },
  { key: 'bounce', label: 'Bounce', min: 0, max: 1, hint: 'ransom-note baseline' },
  { key: 'jitter', label: 'Jitter', min: 0, max: 1, hint: 'every letter its own size' },
];

export const PRESETS: Record<string, Partial<DnaParams>> = {
  'Clean': {},
  'Chonky': { weight: 0.8, inflate: 0.35 },
  'Melted': { melt: 0.75, weight: 0.3, wobble: 0.15 },
  'Rusty': { erode: 0.6, wobble: 0.2, weight: 0.25 },
  'Glitchy': { glitch: 0.7, slant: 0.2 },
  'Ransom': { bounce: 0.7, jitter: 0.6, weight: 0.2 },
  'Nervous': { wobble: 0.8, jitter: 0.25 },
  'Everything': { weight: 0.4, slant: 0.3, wobble: 0.4, melt: 0.3, inflate: 0.2, erode: 0.3, glitch: 0.3, bounce: 0.4, jitter: 0.3 },
};

export function dnaPanel(): HTMLElement {
  const rows = new Map<string, HTMLElement>();
  const setDna = (patch: Partial<DnaParams>) => {
    store.update((p) => { Object.assign(p.dna, patch); }, 'dna');
    for (const [k, row] of rows) (row as any).setValue((store.project.dna as any)[k]);
    scheduleBuild();
  };
  const list = h('div', { class: 'sliders' });
  for (const ax of AXES) {
    const row = slider(ax.label, { min: ax.min, max: ax.max, step: 0.01, value: store.project.dna[ax.key] as number, onInput: (v) => { (store.project.dna as any)[ax.key] = v; store.emit('dna'); scheduleBuild(); } });
    row.title = ax.hint;
    rows.set(ax.key, row);
    list.append(row);
  }
  const seedInput = h('input', { type: 'number', value: store.project.dna.seed, min: 0, step: 1, class: 'seed' });
  seedInput.addEventListener('change', () => setDna({ seed: parseInt(seedInput.value) || 0 }));
  const presets = h('div', { class: 'chips' }, ...Object.entries(PRESETS).map(([name, patch]) => button(name, () => setDna({ ...DEFAULT_DNA, seed: store.project.dna.seed, ...patch }), 'chip')));

  const panel = h('section', { class: 'panel dna' },
    h('h2', {}, 'Style DNA ', h('small', {}, 'live-morphs every glyph')),
    presets,
    list,
    h('div', { class: 'row' },
      h('label', {}, 'Seed ', seedInput),
      button('🎲 Shuffle seed', () => { const s = Math.floor(Math.random() * 1e6); seedInput.value = String(s); setDna({ seed: s }); }),
      button('Mutate!', () => {
        const d = { ...store.project.dna };
        for (const ax of AXES) {
          const cur = d[ax.key] as number;
          const v = Math.max(ax.min, Math.min(ax.max, cur + (Math.random() - 0.5) * 0.5));
          (d as any)[ax.key] = Math.round(v * 100) / 100;
        }
        setDna(d);
      }, 'primary'),
      button('Reset', () => setDna({ ...DEFAULT_DNA, seed: store.project.dna.seed })),
    ),
  );
  store.subscribe((ev) => { if (ev === 'project:loaded') for (const [k, row] of rows) (row as any).setValue((store.project.dna as any)[k]); if (ev === 'project:loaded') seedInput.value = String(store.project.dna.seed); });
  return panel;
}
