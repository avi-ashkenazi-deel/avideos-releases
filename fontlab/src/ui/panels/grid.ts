import { h } from '../dom';
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
    const del = h('span', { class: 'celldel', title: `Remove “${ch}” (it can be regenerated)`, role: 'button', tabindex: 0 }, '×');
    del.addEventListener('click', (e) => { e.stopPropagation(); store.update((p) => { delete p.glyphs[ch]; }, 'glyph'); scheduleBuild(0); });
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
      c.badge.textContent = g ? (g.locked ? '🔒' : g.source === 'generated' ? '✦' : g.source === 'drawn' ? '✎' : g.source === 'traced' ? '📷' : '⬇') : '';
      c.badge.title = g ? g.source + (g.locked ? ' (locked)' : '') : 'empty';
      renderThumb(c.canvas, b?.contours ?? [], store.project.metrics, b?.advance ?? g?.advance ?? 500, g ? SOURCE_COLOR[g.source] : '#444');
    }
  };
  store.subscribe((ev) => { if (ev === 'charset' || ev === 'project:loaded') layout(); if (ev === 'built' || ev === 'select' || ev === 'project' || ev === 'project:loaded' || ev === 'glyph' || ev === 'charset') refresh(); });
  requestAnimationFrame(refresh);
  return h('section', { class: 'panel gridpanel' }, h('h2', {}, 'Glyphs ', h('small', {}, '✎ drawn · 📷 traced · ⬇ imported · ✦ generated · 🔒 locked')), grid);
}
