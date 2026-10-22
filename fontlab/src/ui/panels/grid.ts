import { h } from '../dom';
import { store } from '../state';
import { CHARSET } from '../../core/glyph';
import { renderThumb } from '../render';

const SOURCE_COLOR: Record<string, string> = { drawn: '#ffd166', traced: '#06d6a0', imported: '#8ecae6', generated: '#e0e0e0' };

/** 62-cell grid of thumbnails. Click selects a glyph for the editor. */
export function gridPanel(onSelect: (ch: string) => void): HTMLElement {
  const cells = new Map<string, { root: HTMLElement; canvas: HTMLCanvasElement; badge: HTMLElement }>();
  const grid = h('div', { class: 'grid' });
  for (const ch of CHARSET) {
    const canvas = h('canvas', { class: 'thumb' });
    const badge = h('span', { class: 'badge' });
    const root = h('button', { type: 'button', class: 'cell', 'data-char': ch, onClick: () => onSelect(ch), title: `Edit “${ch}”` }, canvas, h('span', { class: 'ch' }, ch), badge);
    cells.set(ch, { root, canvas, badge });
    grid.append(root);
  }
  const refresh = () => {
    for (const ch of CHARSET) {
      const c = cells.get(ch)!;
      const g = store.project.glyphs[ch];
      const b = store.built[ch];
      c.root.classList.toggle('selected', ch === store.selected);
      c.root.classList.toggle('empty', !g);
      c.badge.textContent = g ? (g.locked ? '🔒' : g.source === 'generated' ? '✦' : g.source === 'drawn' ? '✎' : g.source === 'traced' ? '📷' : '⬇') : '';
      c.badge.title = g ? g.source + (g.locked ? ' (locked)' : '') : 'empty';
      renderThumb(c.canvas, b?.contours ?? [], store.project.metrics, b?.advance ?? g?.advance ?? 500, g ? SOURCE_COLOR[g.source] : '#444');
    }
  };
  store.subscribe((ev) => { if (ev === 'built' || ev === 'select' || ev === 'project' || ev === 'project:loaded' || ev === 'glyph') refresh(); });
  requestAnimationFrame(refresh);
  return h('section', { class: 'panel gridpanel' }, h('h2', {}, 'Glyphs ', h('small', {}, '✎ drawn · 📷 traced · ⬇ imported · ✦ generated · 🔒 locked')), grid);
}
