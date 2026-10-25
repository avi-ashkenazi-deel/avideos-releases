import { h, slider, button, toast } from '../dom';
import { store } from '../state';
import { scheduleBuild } from '../buildClient';
import { FX, FX_ORDER } from '../../fx/registry';
import { newGroup, newLayer, mutateStack, newStack } from '../../fx/stack';
import { PRESETS } from '../../fx/presets';
import type { FxGroup, FxLayer, GroupOp } from '../../fx/types';

const OPS: { op: GroupOp; label: string; hint: string }[] = [
  { op: 'union', label: '∪ add', hint: 'merge with the result so far' },
  { op: 'subtract', label: '− cut', hint: 'cut this group out of the result so far' },
  { op: 'intersect', label: '∩ keep', hint: 'keep only where both overlap' },
  { op: 'xor', label: '⊕ xor', hint: 'keep where exactly one is inked' },
];
const STAGE_LABEL = { skeleton: 'Strokes', outline: 'Shape', raster: 'Texture' } as const;

/**
 * Effects panel: ordered groups of effect layers. Group 0 is the base; later
 * groups start from the original glyph and combine with a boolean op.
 */
export function effectsPanel(): HTMLElement {
  const list = h('div', { class: 'fxgroups' });
  const changed = (delay = 60) => { store.emit('fx'); scheduleBuild(delay); };
  let dragging: { gi: number; li: number } | null = null;

  const render = () => {
    const fx = store.project.fx;
    list.replaceChildren(...fx.groups.map((g, gi) => groupCard(g, gi)));
  };

  const groupCard = (g: FxGroup, gi: number): HTMLElement => {
    const fx = store.project.fx;
    const enable = h('input', { type: 'checkbox', checked: g.enabled, title: 'enable group' });
    enable.addEventListener('change', () => { g.enabled = enable.checked; changed(0); });
    const opSel = h('select', { class: 'opsel', title: 'how this group combines with the result so far' }, ...OPS.map((o) => h('option', { value: o.op, selected: o.op === g.op, title: o.hint }, o.label)));
    opSel.addEventListener('change', () => { g.op = opSel.value as GroupOp; changed(0); });
    const addSel = h('select', { class: 'addsel' }, h('option', { value: '' }, '+ Effect…'),
      ...(['skeleton', 'outline', 'raster'] as const).map((st) => h('optgroup', { label: STAGE_LABEL[st] }, ...FX_ORDER.filter((t) => FX[t].def.stage === st).map((t) => h('option', { value: t, title: FX[t].def.hint }, FX[t].def.label + (FX[t].def.slow ? ' (slow)' : ''))))));
    addSel.addEventListener('change', () => { if (!addSel.value) return; g.layers.push(newLayer(addSel.value)); addSel.value = ''; render(); changed(0); });
    const del = gi === 0 ? null : button('×', () => { fx.groups.splice(gi, 1); render(); changed(0); }, 'icon');
    const head = h('div', { class: 'fxhead' }, enable, h('strong', {}, gi === 0 ? 'Base' : `Group ${gi + 1}`), gi === 0 ? h('small', {}, 'applied in order') : opSel, h('span', { class: 'spacer' }), addSel, del);
    const rows = h('div', { class: 'fxlayers' }, ...g.layers.map((l, li) => layerRow(g, gi, l, li)));
    if (!g.layers.length) rows.append(h('div', { class: 'fxempty' }, gi === 0 ? 'No effects yet — add one, or pick a preset.' : 'Empty group = the original glyph.'));
    const card = h('div', { class: 'fxgroup' + (g.enabled ? '' : ' off'), 'data-gi': gi }, head, rows);
    card.addEventListener('dragover', (e) => { e.preventDefault(); });
    card.addEventListener('drop', (e) => { e.preventDefault(); if (!dragging) return; moveLayer(dragging, { gi, li: g.layers.length }); });
    return card;
  };

  const moveLayer = (from: { gi: number; li: number }, to: { gi: number; li: number }) => {
    const fx = store.project.fx;
    const [l] = fx.groups[from.gi].layers.splice(from.li, 1);
    if (!l) return;
    let li = to.li;
    if (from.gi === to.gi && from.li < li) li--;
    fx.groups[to.gi].layers.splice(Math.max(0, Math.min(li, fx.groups[to.gi].layers.length)), 0, l);
    dragging = null;
    render(); changed(0);
  };

  const layerRow = (g: FxGroup, gi: number, l: FxLayer, li: number): HTMLElement => {
    const impl = FX[l.type];
    const enable = h('input', { type: 'checkbox', checked: l.enabled, title: 'enable' });
    enable.addEventListener('change', () => { l.enabled = enable.checked; row.classList.toggle('off', !l.enabled); changed(0); });
    const up = button('▲', () => { if (li > 0) moveLayer({ gi, li }, { gi, li: li - 1 }); }, 'icon');
    const down = button('▼', () => { if (li < g.layers.length - 1) moveLayer({ gi, li }, { gi, li: li + 2 }); }, 'icon');
    const del = button('×', () => { g.layers.splice(li, 1); render(); changed(0); }, 'icon');
    const handle = h('span', { class: 'handle', draggable: true, title: 'drag to reorder' }, '⋮⋮');
    handle.addEventListener('dragstart', (e) => { dragging = { gi, li }; (e as DragEvent).dataTransfer?.setData('text/plain', l.id); });
    const params = h('div', { class: 'fxparams' }, ...impl.def.params.map((p) => {
      const isToggle = p.step >= 1 && p.max - p.min <= 1 && p.min === 0;
      if (isToggle) {
        const cb = h('input', { type: 'checkbox', checked: !!l.params[p.key] });
        cb.addEventListener('change', () => { l.params[p.key] = cb.checked ? 1 : 0; changed(0); });
        return h('label', { class: 'toggle' }, cb, ' ', p.label);
      }
      const row = slider(p.label, { min: p.min, max: p.max, step: p.step, value: l.params[p.key] ?? p.default, onInput: (v) => { l.params[p.key] = v; changed(impl.def.slow ? 250 : 60); }, format: (v) => (p.step < 0.01 ? v.toFixed(3) : p.step < 1 ? v.toFixed(2) : v.toFixed(0)) });
      if (p.hint) row.title = p.hint;
      return row;
    }));
    const row = h('div', { class: 'fxlayer' + (l.enabled ? '' : ' off') + ' stage-' + impl.def.stage, 'data-type': l.type, 'data-layer': l.id },
      h('div', { class: 'fxrow' }, handle, enable, h('span', { class: 'fxname', title: impl.def.hint }, impl.def.label), h('span', { class: 'stage' }, STAGE_LABEL[impl.def.stage]), impl.def.slow ? h('span', { class: 'tag' }, 'slow') : null, impl.def.variable ? h('span', { class: 'tag var', title: 'can be a variable-font axis' }, 'VF') : null, h('span', { class: 'spacer' }), up, down, del),
      params);
    row.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); row.classList.add('over'); });
    row.addEventListener('dragleave', () => row.classList.remove('over'));
    row.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); row.classList.remove('over'); if (dragging) moveLayer(dragging, { gi, li }); });
    return row;
  };

  const seedInput = h('input', { type: 'number', value: store.project.fx.seed, min: 0, step: 1, class: 'seed' });
  seedInput.addEventListener('change', () => { store.project.fx.seed = parseInt(seedInput.value) || 0; changed(0); });
  const presets = h('div', { class: 'chips' }, ...Object.entries(PRESETS).map(([name, build]) => button(name, () => {
    store.project.fx = build(store.project.fx.seed);
    render(); changed(0);
  }, 'chip')));

  const panel = h('section', { class: 'panel effects' },
    h('h2', {}, 'Effects ', h('small', {}, 'stack them, reorder them, cut groups out of each other')),
    presets,
    list,
    h('div', { class: 'row' },
      button('+ Group', () => { store.project.fx.groups.push(newGroup('subtract')); render(); changed(0); toast('New group: starts from the original glyph and is cut from the result. Change “− cut” to combine differently.'); }),
      h('label', {}, 'Seed ', seedInput),
      button('🎲 Shuffle seed', () => { const s = Math.floor(Math.random() * 1e6); seedInput.value = String(s); store.project.fx.seed = s; changed(0); }),
      button('Mutate!', () => { mutateStack(store.project.fx); render(); changed(0); }, 'primary'),
      button('Reset', () => { store.project.fx = newStack(store.project.fx.seed); render(); changed(0); }),
    ),
  );
  store.subscribe((ev) => { if (ev === 'project:loaded' || ev === 'fx:external') { seedInput.value = String(store.project.fx.seed); render(); } });
  render();
  return panel;
}
