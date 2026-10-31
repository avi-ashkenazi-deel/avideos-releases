import { h, toast, menu, iconButton, fileInput } from '../dom';
import { store } from '../state';
import { downloadProject, readProjectFile, saveLocal } from '../../project/storage';
import { newProject } from '../../core/glyph';
import { showWelcome } from './welcome';
import { scheduleBuild } from '../buildClient';
import { downloadOtf, downloadSvgSpecimen, downloadTesterHtml, openTester, openAnimateDialog, openVariableDialog, downloadTtf, downloadSvgGlyphs } from './exportMore';
import { openLibrary, saveCurrent } from './libraryDialog';
import { fingerprint, getCurrentId, setCurrentId, loadFont } from '../../project/library';

let savedPrint = '';
export function markSaved(): void { savedPrint = fingerprint(store.project); store.emit('dirty'); }
export function isDirty(): boolean { return fingerprint(store.project) !== savedPrint; }

/** Header: font name, Test, Export menu, Font menu. */
export function headerBar(): HTMLElement {
  const name = h('input', { type: 'text', class: 'fontname', value: store.project.name, placeholder: 'Font name', 'aria-label': 'Font name' });
  name.addEventListener('change', () => { store.project.name = name.value || 'Untitled'; store.emit('project'); scheduleBuild(0); });
  const dirtyDot = h('span', { class: 'dirty', title: 'Unsaved changes' });

  const save = async (asNew = false) => {
    try {
      if (asNew || !store.project.name || store.project.name === 'Untitled') {
        const n = prompt('Save font as', store.project.name === 'Untitled' ? '' : store.project.name);
        if (n === null) return null;
        store.project.name = n.trim() || 'Untitled'; name.value = store.project.name;
      }
      const meta = await saveCurrent(store, { asNew });
      markSaved();
      toast(`Saved “${meta.name}”`);
      return meta;
    } catch (e) { toast((e as Error).message); return null; }
  };
  const openProject = (p: typeof store.project) => {
    store.project = p; store.built = {}; store.otf = null; store.bypassFx = false;
    store.emit('project:loaded'); store.emit('bypass'); name.value = p.name; markSaved(); scheduleBuild(0);
  };
  const reset = async () => {
    if (isDirty()) {
      const choice = confirm('Save the current font before resetting? Press OK to save, Cancel to discard.');
      if (choice) { const m = await save(); if (!m) return; }
    }
    setCurrentId(null);
    openProject(newProject('Untitled'));
    toast('Reset. Your saved fonts are in Font → My fonts.');
  };
  const importJson = fileInput('.json,application/json', async (f) => {
    try { openProject(await readProjectFile(f)); toast('Font imported'); } catch (e) { toast('Not a FontLab file: ' + (e as Error).message); }
  });

  const fontMenu = menu('Font', [
    { label: 'Save', icon: 'save', onClick: () => void save(false), hint: 'Save to this browser (Ctrl/Cmd+S)', testid: 'menu-save' },
    { label: 'Save as new…', icon: 'copy', onClick: () => void save(true) },
    { label: 'My fonts…', icon: 'folder', onClick: () => openLibrary({ onOpen: (p) => openProject(p), onSaveCurrent: () => save(true) }), testid: 'menu-library' },
    { label: 'Export .json file', icon: 'download', onClick: () => downloadProject(store.project), hint: 'Move the font to another machine', separatorBefore: true, testid: 'menu-export-json' },
    { label: 'Import .json file', icon: 'upload', onClick: () => importJson.click(), testid: 'menu-import-json' },
    { label: 'Reset', icon: 'reset', onClick: () => void reset(), hint: 'Start a blank font (asks to save first)', danger: true, separatorBefore: true, testid: 'menu-reset' },
  ], { icon: 'type', testid: 'menu-font' });

  const exportMenu = menu('Export', [
    { label: 'Font file (.otf)', icon: 'download', onClick: downloadOtf, hint: 'Install it anywhere', testid: 'menu-otf' },
    { label: 'TrueType font (.ttf)', icon: 'download', onClick: () => void downloadTtf(), hint: 'For apps that reject CFF fonts. The first use downloads a 12 MB converter.', testid: 'menu-ttf' },
    { label: 'Variable font…', icon: 'sliders', onClick: openVariableDialog, hint: 'Real axes you can animate in CSS', testid: 'menu-variable' },
    { label: 'Animation (GIF / video)…', icon: 'film', onClick: openAnimateDialog, testid: 'menu-animate' },
    { label: 'SVG glyphs (one group per letter)', icon: 'image', onClick: downloadSvgGlyphs, hint: 'Every letter as a separate vector group, for Illustrator or Figma', separatorBefore: true, testid: 'menu-svg-glyphs' },
    { label: 'SVG specimen', icon: 'image', onClick: downloadSvgSpecimen, hint: 'A poster of your text as vector shapes', testid: 'menu-svg' },
    { label: 'Type tester web page (.html)', icon: 'code', onClick: downloadTesterHtml, hint: 'Standalone page with the font embedded', testid: 'menu-html' },
  ], { icon: 'download', testid: 'menu-export' });

  const bar = h('header', { class: 'topbar' },
    h('div', { class: 'namewrap' }, name, dirtyDot),
    h('div', { class: 'actions' },
      iconButton('info', 'Intro', () => showWelcome(true), { iconOnly: true, title: 'Show the four-step intro again', testid: 'btn-intro' }),
      iconButton('flask', 'Test', openTester, { title: 'Type with your font, waterfall, dark mode', testid: 'btn-test' }),
      exportMenu, fontMenu, importJson),
  );
  store.subscribe((ev) => {
    if ((ev === 'project:loaded' || ev === 'project') && name.value !== store.project.name && document.activeElement !== name) name.value = store.project.name;
    if (ev === 'dirty' || ev === 'project' || ev === 'glyph' || ev === 'fx' || ev === 'charset') dirtyDot.classList.toggle('on', isDirty());
  });
  // autosave into the library slot that is open (debounced), plus Ctrl/Cmd+S
  let t: number | null = null;
  store.subscribe((ev) => {
    if (!(ev === 'project' || ev === 'glyph' || ev === 'fx' || ev === 'charset')) return;
    if (t) clearTimeout(t);
    t = window.setTimeout(async () => {
      if (getCurrentId()) { try { await saveCurrent(store); markSaved(); } catch { /* quota: user will see it on explicit save */ } }
      else saveLocal(store.project); // scratch slot so an unsaved font survives a reload
    }, 700);
  });
  window.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(false); } });
  // reopen the last font at start
  const cur = getCurrentId();
  if (cur) loadFont(cur).then((p) => { if (p) openProject(p); }).catch(() => undefined);
  return bar;
}
