import { h, button, toast } from '../dom';
import { store } from '../state';
import { BLOCKS, projectCharset } from '../../core/charsets';
import { scheduleBuild } from '../buildClient';

/** Checkbox per character block + "add any characters" box. */
export function charsetPanel(onChange: () => void): HTMLElement {
  const blocks = h('div', { class: 'blocks' });
  const boxes = new Map<string, HTMLInputElement>();
  for (const b of BLOCKS) {
    const cb = h('input', { type: 'checkbox', checked: b.always || store.project.blocks.includes(b.id), disabled: !!b.always });
    cb.addEventListener('change', () => {
      store.update((p) => {
        const set = new Set(p.blocks);
        cb.checked ? set.add(b.id) : set.delete(b.id);
        p.blocks = ['latin', ...BLOCKS.map((x) => x.id).filter((id) => id !== 'latin' && set.has(id))];
      }, 'charset');
      onChange();
    });
    boxes.set(b.id, cb);
    blocks.append(h('label', { title: b.sample }, cb, b.name, h('small', {}, `(${[...b.chars].length})`)));
  }
  const input = h('input', { type: 'text', placeholder: 'Add any characters, e.g. ★ ñ 日本 عربى', autocomplete: 'off', spellcheck: false });
  const chips = h('div', { class: 'custom-chips', style: { display: 'contents' } });
  const renderChips = () => {
    chips.replaceChildren(...[...store.project.customChars].map((ch) => h('span', { class: 'chipx' }, ch, button('×', () => {
      store.update((p) => { p.customChars = [...p.customChars].filter((c) => c !== ch).join(''); delete p.glyphs[ch]; }, 'charset');
      renderChips(); onChange();
    }))));
  };
  const add = () => {
    const existing = new Set(projectCharset(store.project));
    const fresh = [...input.value].filter((c) => !/\s/.test(c) && !existing.has(c));
    if (!fresh.length) { toast('Nothing new to add'); return; }
    store.update((p) => { p.customChars += fresh.join(''); }, 'charset');
    input.value = '';
    renderChips(); onChange();
    toast(`Added ${fresh.length} character${fresh.length === 1 ? '' : 's'}. Select one in the strip and draw it.`);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  renderChips();
  store.subscribe((ev) => { if (ev === 'project:loaded') { for (const [id, cb] of boxes) cb.checked = id === 'latin' || store.project.blocks.includes(id); renderChips(); } });
  return h('details', { class: 'charset', open: true },
    h('summary', {}, 'Character set'),
    blocks,
    h('div', { class: 'custom' }, input, button('Add', add), chips),
  );
}

export function rebuildAfterCharsetChange(): void { scheduleBuild(0); }
