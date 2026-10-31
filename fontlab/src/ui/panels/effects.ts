import { h, slider, toast, iconButton, help } from '../dom';
import { icon } from '../icons';
import { store } from '../state';
import { scheduleBuild } from '../buildClient';
import { FX, FX_ORDER } from '../../fx/registry';
import { newGroup, newLayer, mutateStack, newStack, randomStack } from '../../fx/stack';
import type { FxStack } from '../../fx/types';
import { PRESETS } from '../../fx/presets';
import type { FxGroup, FxLayer, GroupOp } from '../../fx/types';

const OPS: { op: GroupOp; label: string; hint: string }[] = [
  { op: 'union', label: 'add to', hint: 'merge this layer set with the result so far' },
  { op: 'subtract', label: 'cut from', hint: 'cut this layer set out of the result so far' },
  { op: 'intersect', label: 'keep only', hint: 'keep only where both overlap' },
  { op: 'xor', label: 'xor with', hint: 'keep where exactly one is inked' },
];
const STAGE_LABEL: Record<string, string> = { skeleton: 'strokes', outline: 'shape', raster: 'texture', warp: 'warp', wreck: 'destroyer' };
/** Menu categories: a playful name, then the plain one. */
const CATS: { id: string; label: string; match: (t: string) => boolean }[] = [
  { id: 'skeleton', label: 'Limber up · strokes', match: (t) => FX[t].def.stage === 'skeleton' },
  { id: 'crisp', label: 'Clean cuts · sharp edits', match: (t) => FX[t].def.stage === 'outline' && !!FX[t].def.crisp && !FX[t].def.category },
  { id: 'warp', label: 'Bend it · warps', match: (t) => FX[t].def.category === 'warp' },
  { id: 'shape', label: 'Mess it up · shape', match: (t) => FX[t].def.stage === 'outline' && !FX[t].def.crisp && !FX[t].def.category },
  { id: 'wreck', label: 'Wreck it · destroyers', match: (t) => FX[t].def.category === 'wreck' },
  { id: 'raster', label: 'Grind it · texture', match: (t) => FX[t].def.stage === 'raster' },
];

/** Effects: preset dropdown + an ordered list of effects; mask groups behind Advanced. */
export function effectsPanel(): HTMLElement {
  const list = h('div', { class: 'fxgroups' });
  const changed = (delay = 60) => { store.emit('fx'); scheduleBuild(delay); };
  let dragging: { gi: number; li: number } | null = null;
  let advanced = store.project.fx.groups.length > 1;

  const render = () => {
    const fx = store.project.fx;
    if (fx.groups.length > 1) advanced = true;
    advToggle.checked = advanced;
    list.replaceChildren(...fx.groups.map((g, gi) => groupCard(g, gi)));
    addGroupBtn.style.display = advanced ? '' : 'none';
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

  const addSelect = (g: FxGroup) => {
    const sel = h('select', { class: 'addsel', 'aria-label': 'Add effect' }, h('option', { value: '' }, 'Add effect…'),
      ...CATS.map((c) => h('optgroup', { label: c.label }, ...FX_ORDER.filter(c.match).map((t) => h('option', { value: t, title: FX[t].def.hint }, FX[t].def.label + (FX[t].def.slow ? ' (slow)' : ''))))).filter((og) => og.childElementCount > 0));
    sel.addEventListener('change', () => { if (!sel.value) return; g.layers.push(newLayer(sel.value)); sel.value = ''; render(); changed(0); });
    return sel;
  };

  const groupCard = (g: FxGroup, gi: number): HTMLElement => {
    const fx = store.project.fx;
    const rows = h('div', { class: 'fxlayers' }, ...g.layers.map((l, li) => layerRow(g, gi, l, li)));
    if (!g.layers.length) rows.append(h('div', { class: 'fxempty' }, gi === 0 ? 'No effects yet. Pick a preset above or add one below.' : 'Empty: this set is the original letter.'));
    const head = h('div', { class: 'fxhead' });
    if (advanced) {
      const enable = h('input', { type: 'checkbox', checked: g.enabled, title: 'enable this set' });
      enable.addEventListener('change', () => { g.enabled = enable.checked; changed(0); });
      head.append(enable, h('strong', {}, gi === 0 ? 'Base' : `Set ${gi + 1}`));
      if (gi > 0) {
        const opSel = h('select', { class: 'opsel', 'aria-label': 'how this set combines' }, ...OPS.map((o) => h('option', { value: o.op, selected: o.op === g.op, title: o.hint }, o.label)));
        opSel.addEventListener('change', () => { g.op = opSel.value as GroupOp; changed(0); });
        head.append(opSel, h('small', { class: 'muted' }, 'the result so far'), help('A set starts again from the original letter, runs its own effects, then combines with everything above it. Example: Inflate in the base, an empty set that “cuts from” = a hollow halo.'));
        head.append(h('span', { class: 'spacer' }), iconButton('x', 'Remove set', () => { fx.groups.splice(gi, 1); render(); changed(0); }, { iconOnly: true }));
      } else head.append(h('span', { class: 'spacer' }));
    }
    const card = h('div', { class: 'fxgroup' + (g.enabled ? '' : ' off') + (advanced ? ' adv' : ''), 'data-gi': gi }, head, rows, h('div', { class: 'row' }, addSelect(g)));
    card.addEventListener('dragover', (e) => e.preventDefault());
    card.addEventListener('drop', (e) => { e.preventDefault(); if (dragging) moveLayer(dragging, { gi, li: g.layers.length }); });
    return card;
  };

  const layerRow = (g: FxGroup, gi: number, l: FxLayer, li: number): HTMLElement => {
    const impl = FX[l.type];
    const enable = h('input', { type: 'checkbox', checked: l.enabled, title: 'enable' });
    enable.addEventListener('change', () => { l.enabled = enable.checked; row.classList.toggle('off', !l.enabled); changed(0); });
    const up = iconButton('up', 'Move up', () => { if (li > 0) moveLayer({ gi, li }, { gi, li: li - 1 }); }, { iconOnly: true, cls: 'icon' });
    const down = iconButton('down', 'Move down', () => { if (li < g.layers.length - 1) moveLayer({ gi, li }, { gi, li: li + 2 }); }, { iconOnly: true, cls: 'icon' });
    const del = iconButton('x', 'Remove effect', () => { g.layers.splice(li, 1); render(); changed(0); }, { iconOnly: true, cls: 'icon' });
    const handle = h('span', { class: 'handle', draggable: true, title: 'drag to reorder' }, icon('grip', 14));
    handle.addEventListener('dragstart', (e) => { dragging = { gi, li }; (e as DragEvent).dataTransfer?.setData('text/plain', l.id); });
    const params = h('div', { class: 'fxparams' }, ...impl.def.params.map((p) => {
      const isToggle = p.step >= 1 && p.max - p.min <= 1 && p.min === 0;
      if (isToggle) {
        const cb = h('input', { type: 'checkbox', checked: !!l.params[p.key] });
        cb.addEventListener('change', () => { l.params[p.key] = cb.checked ? 1 : 0; changed(0); });
        return h('label', { class: 'toggle' }, cb, ' ', p.label);
      }
      const r = slider(p.label, { min: p.min, max: p.max, step: p.step, value: l.params[p.key] ?? p.default, onInput: (v) => { l.params[p.key] = v; changed(impl.def.slow ? 250 : 60); }, format: (v) => (p.step < 0.01 ? v.toFixed(3) : p.step < 1 ? v.toFixed(2) : v.toFixed(0)) });
      if (p.hint) r.title = p.hint;
      return r;
    }));
    const row = h('div', { class: 'fxlayer' + (l.enabled ? '' : ' off') + ' stage-' + impl.def.stage, 'data-type': l.type, 'data-layer': l.id },
      h('div', { class: 'fxrow' }, handle, enable, h('span', { class: 'fxname', title: impl.def.hint }, impl.def.label), h('span', { class: 'stage' }, STAGE_LABEL[impl.def.category ?? impl.def.stage]),
        impl.def.crisp ? h('span', { class: 'tag crisp', title: 'keeps corners sharp' }, 'crisp') : null,
        impl.def.slow ? h('span', { class: 'tag' }, 'slow') : null,
        impl.def.variable ? h('span', { class: 'tag var', title: 'can be a variable-font axis' }, 'VF') : null,
        h('span', { class: 'spacer' }), up, down, del),
      params);
    row.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); row.classList.add('over'); });
    row.addEventListener('dragleave', () => row.classList.remove('over'));
    row.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); row.classList.remove('over'); if (dragging) moveLayer(dragging, { gi, li }); });
    return row;
  };

  // preset dropdown
  const presetSel = h('select', { id: 'preset', 'aria-label': 'Preset' }, h('option', { value: '' }, 'Preset…'), ...Object.keys(PRESETS).map((n) => h('option', { value: n }, n)));
  presetSel.addEventListener('change', () => { if (!presetSel.value) return; store.project.fx = PRESETS[presetSel.value](store.project.fx.seed); render(); changed(0); });
  store.subscribe((ev) => { if (ev === 'fx') presetSel.value = ''; });

  const seedInput = h('input', { type: 'number', value: store.project.fx.seed, min: 0, step: 1, class: 'seed', 'aria-label': 'Seed' });
  seedInput.addEventListener('change', () => { store.project.fx.seed = parseInt(seedInput.value) || 0; changed(0); });
  const bypass = h('input', { type: 'checkbox', checked: store.bypassFx, id: 'bypassfx' });
  bypass.addEventListener('change', () => { store.bypassFx = bypass.checked; store.emit('fx'); scheduleBuild(0); });
  store.subscribe((ev) => { if (ev === 'bypass') bypass.checked = store.bypassFx; });
  const advToggle = h('input', { type: 'checkbox', checked: advanced, id: 'fxadv' });
  advToggle.addEventListener('change', () => { advanced = advToggle.checked; if (!advanced && store.project.fx.groups.length > 1) { if (!confirm('Turning Advanced off removes the extra sets. Continue?')) { advToggle.checked = true; return; } store.project.fx.groups = store.project.fx.groups.slice(0, 1); changed(0); } render(); });
  let lastStack: FxStack | null = null;
  const backBtn = iconButton('undo', 'Back', () => { if (!lastStack) return; store.project.fx = lastStack; lastStack = null; backBtn.style.display = 'none'; seedInput.value = String(store.project.fx.seed); render(); changed(0); }, { iconOnly: true, title: 'Back to the effects you had before Randomize', testid: 'btn-fx-back' });
  backBtn.style.display = 'none';
  const randomBtn = iconButton('sparkle', 'Randomize', () => {
    lastStack = store.project.fx;
    const s = Math.floor(Math.random() * 1e6);
    const probeGlyph = store.project.glyphs[store.selected] ?? Object.values(store.project.glyphs)[0];
    store.project.fx = randomStack(s, undefined, Math.random, probeGlyph ? { glyph: probeGlyph, metrics: store.project.metrics } : undefined);
    seedInput.value = String(s);
    backBtn.style.display = '';
    render(); changed(0);
  }, { title: 'Throw the dice: 2 to 4 random effects with random settings. Back undoes it.', testid: 'btn-randomize' });
  const addGroupBtn = iconButton('layers', 'Add a set', () => { store.project.fx.groups.push(newGroup('subtract')); render(); changed(0); toast('New set: starts from the original letter and is cut from the result. Change “cut from” to combine differently.'); }, { testid: 'btn-add-group' });

  const panel = h('section', { class: 'panel effects' },
    h('h2', {}, 'Effects', help('Effects run top to bottom on every letter. Reorder by dragging. Crisp effects keep corners sharp; textures go through a bitmap.')),
    h('div', { class: 'row' }, presetSel, h('label', { class: 'toggle', for: 'bypassfx' }, bypass, ' Show original', help('Preview and export the letters exactly as drawn or imported, ignoring every effect. Turns on by itself after a font import.'))),
    list,
    h('div', { class: 'row' },
      h('label', {}, 'Seed ', seedInput),
      iconButton('shuffle', 'Shuffle seed', () => { const s = Math.floor(Math.random() * 1e6); seedInput.value = String(s); store.project.fx.seed = s; changed(0); }, { title: 'Random effects get a new roll; same seed = same result' }),
      iconButton('dice', 'Mutate', () => { mutateStack(store.project.fx); render(); changed(0); }, { cls: 'primary', title: 'Nudge every slider a little' }),
      randomBtn, backBtn,
      iconButton('reset', 'Clear effects', () => { store.project.fx = newStack(store.project.fx.seed); render(); changed(0); }),
    ),
    h('div', { class: 'row advrow' }, h('label', { class: 'toggle', for: 'fxadv' }, advToggle, ' Advanced: sets', help('Sets let one stack of effects be cut from, added to, or intersected with another. Most looks do not need them.')), addGroupBtn),
  );
  store.subscribe((ev) => { if (ev === 'project:loaded' || ev === 'fx:external') { seedInput.value = String(store.project.fx.seed); render(); } });
  render();
  return panel;
}
