import { h, toast } from '../dom';
import { icon } from '../icons';
import { store } from '../state';
import { projectCharset, groupCharset, BLOCK_BY_ID } from '../../core/charsets';
import { renderThumb } from '../render';
import { hasInk } from './seeds';
import { scheduleBuild } from '../buildClient';

const SOURCE_COLOR: Record<string, string> = { drawn: '#ffd166', traced: '#06d6a0', imported: '#8ecae6', generated: '#e0e0e0' };

/** 62-cell grid of thumbnails. Click selects a glyph for the editor. */
export function gridPanel(onSelect: (ch: string) => void): HTMLElement {
  const cells = new Map<string, { root: HTMLElement; canvas: HTMLCanvasElement; badge: HTMLElement }>();
  const grid = h('div', { class: 'grid' });
  let current: string[] = [];
  const cellFor = (ch: string, rtl: boolean) => {
    let c = cells.get(ch);
    if (c) return c;
    const canvas = h('canvas', { class: 'thumb' });
    const badge = h('span', { class: 'badge' });
    const del = h('span', { class: 'celldel', title: `Remove “${ch}” (it can be regenerated)`, role: 'button', tabindex: 0 }, icon('x', 12));
    del.addEventListener('click', (e) => { e.stopPropagation(); store.update((p) => { delete p.glyphs[ch]; }, 'glyph'); scheduleBuild(0); toast(`“${ch}” removed. Undo brings it back.`); });
    const root = h('button', { type: 'button', class: 'cell' + (rtl ? ' rtl' : ''), 'data-char': ch, onClick: () => onSelect(ch), title: `Edit “${ch}”` }, canvas, h('span', { class: 'ch' }, ch), badge, del);
    c = { root, canvas, badge };
    cells.set(ch, c);
    return c;
  };
  const layout = () => {
    current = projectCharset(store.project);
    grid.replaceChildren();
    for (const [block, chars] of groupCharset(current)) {
      grid.append(h('div', { class: 'grid-group' }, `${BLOCK_BY_ID[block]?.name ?? 'Custom'} · ${chars.length}`));
      for (const ch of chars) grid.append(cellFor(ch, !!BLOCK_BY_ID[block]?.rtl).root);
    }
  };
  layout();
  const refresh = () => {
    if (current.length !== projectCharset(store.project).length) layout();
    for (const ch of current) {
      const c = cells.get(ch)!;
      const g = store.project.glyphs[ch];
      const b = store.built[ch];
      c.root.classList.toggle('selected', ch === store.selected);
      c.root.classList.toggle('empty', !hasInk(g));
      const srcIcon = g ? (g.locked ? 'lock' : g.source === 'generated' ? 'sparkle' : g.source === 'drawn' ? 'pen' : g.source === 'traced' ? 'image' : 'upload') : null;
      c.badge.replaceChildren(...(srcIcon ? [icon(srcIcon as any, 11)] : []));
      c.badge.dataset.source = g ? (g.locked ? 'locked' : g.source) : '';
      c.badge.title = g ? ({ drawn: 'drawn by hand', traced: 'traced from a photo', imported: 'from a font file', generated: 'generated' } as const)[g.source] + (g.locked ? ' (locked)' : '') : 'empty';
      c.root.dataset.source = g ? g.source : '';
      renderThumb(c.canvas, b?.contours ?? [], store.project.metrics, b?.advance ?? g?.advance ?? 500, g ? SOURCE_COLOR[g.source] : '#444');
    }
  };
  store.subscribe((ev) => { if (ev === 'charset' || ev === 'project:loaded') layout(); if (ev === 'built' || ev === 'select' || ev === 'project' || ev === 'project:loaded' || ev === 'glyph' || ev === 'charset') refresh(); });
  requestAnimationFrame(refresh);
  return h('section', { class: 'panel gridpanel' }, h('h2', {}, 'Letters ', h('small', { class: 'legend' }, icon('pen', 11), ' drawn ', icon('image', 11), ' traced ', icon('upload', 11), ' from font ', icon('sparkle', 11), ' generated ', icon('lock', 11), ' locked')), grid);
}
