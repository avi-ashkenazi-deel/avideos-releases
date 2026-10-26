import { h, toast, help, contextMenu, type MenuItem } from '../dom';
import { icon } from '../icons';
import { store } from '../state';
import { projectCharset, groupCharset, blockOf, BLOCK_BY_ID } from '../../core/charsets';
import { renderThumb } from '../render';
import { hasInk, recomposeDependents } from './seeds';
import { regenerateOne } from '../../generate/compose';
import { scheduleBuild } from '../buildClient';

const SOURCE_COLOR: Record<string, string> = { drawn: '#ffd166', traced: '#06d6a0', imported: '#8ecae6', generated: '#e0e0e0' };

/** 62-cell grid of thumbnails. Click selects a glyph for the editor. */
export function gridPanel(onSelect: (ch: string) => void): HTMLElement {
  const cells = new Map<string, { root: HTMLElement; canvas: HTMLCanvasElement; badge: HTMLElement }>();
  const grid = h('div', { class: 'grid' });
  let current: string[] = [];
  /** tiles picked with Shift/Cmd-click (the editor's letter is store.selected) */
  const multi = new Set<string>();
  let anchor: string | null = null;
  const isLower = (ch: string) => ch.toLowerCase() === ch && ch.toUpperCase() !== ch;
  const isUpper = (ch: string) => ch.toUpperCase() === ch && ch.toLowerCase() !== ch;
  const isDigit = (ch: string) => /^[0-9]$/.test(ch);
  const targets = (ch: string) => (multi.size && multi.has(ch) ? [...multi] : [ch]);
  const removeChars = (chars: string[], what: string) => {
    const hit = chars.filter((c) => store.project.glyphs[c]);
    if (!hit.length) { toast(`Nothing to remove: ${what} is already empty.`); return; }
    store.update((p) => { for (const c of hit) delete p.glyphs[c]; }, 'glyph');
    multi.clear(); scheduleBuild(0);
    toast(hit.length === 1 ? `“${hit[0]}” removed. Undo brings it back.` : `${hit.length} letters removed. Undo brings them back.`);
    refresh();
  };
  const setLocked = (chars: string[], locked: boolean) => { store.update((p) => { for (const c of chars) { const g = p.glyphs[c]; if (g) g.locked = locked; } }, 'glyph'); refresh(); };
  const reroll = (chars: string[]) => {
    const input = { seeds: store.project.seeds, stats: store.project.stats, mutation: store.project.mutation, glyphs: store.project.glyphs };
    const gen = chars.filter((c) => store.project.glyphs[c]?.source === 'generated' && !store.project.glyphs[c]?.locked);
    if (!gen.length) { toast('Re-roll works on generated letters'); return; }
    store.update((p) => { for (const c of gen) { const ng = regenerateOne(c, input, Math.floor(Math.random() * 1e9)); if (ng) p.glyphs[c] = ng; } }, 'glyph');
    for (const c of gen) recomposeDependents(c);
    scheduleBuild(0);
  };
  const pick = (ch: string, e: MouseEvent) => {
    if (e.shiftKey && anchor) {
      const a = current.indexOf(anchor), b = current.indexOf(ch);
      if (a >= 0 && b >= 0) { if (!(e.metaKey || e.ctrlKey)) multi.clear(); for (let i = Math.min(a, b); i <= Math.max(a, b); i++) multi.add(current[i]); }
      refresh(); return;
    }
    if (e.metaKey || e.ctrlKey) { if (multi.has(ch)) multi.delete(ch); else multi.add(ch); anchor = ch; refresh(); return; }
    multi.clear(); anchor = ch; onSelect(ch);
  };
  const openMenu = (ch: string, x: number, y: number) => {
    if (!multi.has(ch)) { multi.clear(); anchor = ch; refresh(); }
    const sel = targets(ch);
    const g = store.project.glyphs[ch];
    const block = blockOf(ch);
    const inBlock = current.filter((c) => blockOf(c) === block);
    const many = sel.length > 1;
    const items: MenuItem[] = [
      { label: many ? `Remove ${sel.length} selected` : `Remove “${ch}”`, icon: 'trash', danger: true, onClick: () => removeChars(sel, many ? 'the selection' : `“${ch}”`), hint: 'Delete key does the same. Undo brings letters back.', testid: 'ctx-remove' },
      { label: g?.locked ? (many ? 'Unlock selected' : 'Unlock') : (many ? 'Lock selected' : 'Lock'), icon: g?.locked ? 'unlock' : 'lock', onClick: () => setLocked(sel, !g?.locked), hint: 'Locked letters are never regenerated' },
      { label: many ? 'Re-roll selected' : 'Re-roll', icon: 'dice', onClick: () => reroll(sel), hint: 'Generate again with a new seed (generated letters only)' },
      { label: 'Edit this letter', icon: 'pen', onClick: () => { multi.clear(); onSelect(ch); } },
      { label: 'Remove all lowercase', icon: 'trash', danger: true, separatorBefore: true, onClick: () => removeChars(current.filter(isLower), 'lowercase'), testid: 'ctx-remove-lower' },
      { label: 'Remove all uppercase', icon: 'trash', danger: true, onClick: () => removeChars(current.filter(isUpper), 'uppercase') },
      { label: 'Remove all digits', icon: 'trash', danger: true, onClick: () => removeChars(current.filter(isDigit), 'digits') },
      { label: `Remove whole block (${BLOCK_BY_ID[block]?.name ?? 'Custom'})`, icon: 'trash', danger: true, onClick: () => removeChars(inBlock, 'this block') },
    ];
    contextMenu(x, y, items);
  };
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (document.querySelector('dialog[open]') || document.querySelector('canvas.editor.editing')) return;
    const sel = multi.size ? [...multi] : (t && t.closest && t.closest('.gridpanel') ? [store.selected] : []);
    if (!sel.length) return;
    e.preventDefault();
    removeChars(sel, sel.length === 1 ? `“${sel[0]}”` : 'the selection');
  });
  const cellFor = (ch: string, rtl: boolean) => {
    let c = cells.get(ch);
    if (c) return c;
    const canvas = h('canvas', { class: 'thumb' });
    const badge = h('span', { class: 'badge' });
    const del = h('span', { class: 'celldel', title: `Remove “${ch}” (it can be regenerated)`, role: 'button', tabindex: 0 }, icon('x', 12));
    del.addEventListener('click', (e) => { e.stopPropagation(); store.update((p) => { delete p.glyphs[ch]; }, 'glyph'); scheduleBuild(0); toast(`“${ch}” removed. Undo brings it back.`); });
    const root = h('button', { type: 'button', class: 'cell' + (rtl ? ' rtl' : ''), 'data-char': ch, onClick: (e: MouseEvent) => pick(ch, e), title: `Edit “${ch}”. Shift/Cmd-click selects several; right-click for more.` }, canvas, h('span', { class: 'ch' }, ch), badge, del);
    root.addEventListener('contextmenu', (e) => { e.preventDefault(); openMenu(ch, e.clientX, e.clientY); });
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
      c.root.classList.toggle('multi', multi.has(ch));
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
  return h('section', { class: 'panel gridpanel' }, h('h2', {}, 'Letters ', help('Click a tile to edit it. Shift-click or Cmd/Ctrl-click to select several. Delete removes the selection. Right-click a tile for Lock, Re-roll and "remove all lowercase / uppercase / digits".'), ' ', h('small', { class: 'legend' }, icon('pen', 11), ' drawn ', icon('image', 11), ' traced ', icon('upload', 11), ' from font ', icon('sparkle', 11), ' generated ', icon('lock', 11), ' locked')), grid);
}
