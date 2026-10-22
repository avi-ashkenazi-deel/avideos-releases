import { h, button, fileInput, toast } from '../dom';
import { store } from '../state';
import { downloadBlob, downloadProject, readProjectFile, saveLocal, slug } from '../../project/storage';
import { newProject } from '../../core/glyph';
import { scheduleBuild } from '../buildClient';

export function headerBar(): HTMLElement {
  const name = h('input', { type: 'text', class: 'fontname', value: store.project.name, placeholder: 'Font name' });
  name.addEventListener('change', () => { store.project.name = name.value || 'Untitled Funk'; scheduleBuild(0); });
  const load = fileInput('.json,application/json', async (f) => {
    try {
      const p = await readProjectFile(f);
      store.project = p; store.built = {}; store.emit('project:loaded'); name.value = p.name; scheduleBuild(0);
      toast('Project loaded');
    } catch (e) { toast('Not a FontLab project: ' + (e as Error).message); }
  });
  const otfBtn = button('⬇ Download .otf', () => {
    if (!store.otf) { toast('Nothing built yet — draw or generate some glyphs'); return; }
    downloadBlob(store.otf.slice(0), `${slug(store.project.name)}.otf`, 'font/otf');
  }, 'primary');
  const extra = h('span', { class: 'export-extra' });
  const bar = h('header', { class: 'topbar' },
    h('div', { class: 'brand' }, h('span', { class: 'logo' }, 'Ff'), h('span', {}, 'FontLab'), h('small', {}, 'funky font maker')),
    name,
    h('div', { class: 'actions' },
      button('New', () => { if (confirm('Start a new project? Unsaved work is kept in this browser until you overwrite it.')) { store.project = newProject(); store.built = {}; store.otf = null; store.emit('project:loaded'); name.value = store.project.name; scheduleBuild(0); } }),
      button('Save .json', () => downloadProject(store.project)),
      button('Open .json', () => load.click()), load,
      otfBtn, extra,
    ),
  );
  store.subscribe((ev) => { if (ev === 'project:loaded') name.value = store.project.name; });
  // autosave
  let t: number | null = null;
  store.subscribe((ev) => { if (ev === 'project' || ev === 'glyph' || ev === 'dna' || ev === 'built') { if (t) clearTimeout(t); t = window.setTimeout(() => saveLocal(store.project), 800); } });
  return bar;
}

/** Hook for Phase 4 buttons (variable font, specimens). */
export function exportExtraSlot(): HTMLElement | null { return document.querySelector('.export-extra'); }
