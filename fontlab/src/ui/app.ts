import { store } from './state';
import { loadLocal } from '../project/storage';
import { headerBar, markSaved } from './panels/exportPanel';
import { seedsPanel } from './panels/seeds';
import { gridPanel } from './panels/grid';
import { effectsPanel } from './panels/effects';
import { previewPanel } from './panels/preview';
import { scheduleBuild } from './buildClient';
import { h } from './dom';
import { migrateLegacyAutosave, getCurrentId, setCurrentId } from '../project/library';
import { showWelcome } from './panels/welcome';
import { hasInk } from './panels/seeds';

export async function mountApp(root: HTMLElement): Promise<void> {
  (window as unknown as { __fontlab: typeof store }).__fontlab = store; // debugging / e2e handle
  // one-time: move the old single autosave into the library
  try {
    const legacy = await migrateLegacyAutosave();
    if (legacy && !getCurrentId()) setCurrentId(legacy.id);
  } catch { /* ignore */ }
  if (!getCurrentId()) { const saved = loadLocal(); if (saved) store.project = saved; }
  root.replaceChildren(
    headerBar(),
    h('main', { class: 'layout' },
      seedsPanel(),
      gridPanel((ch) => { store.selected = ch; store.emit('select'); }),
      h('div', { class: 'right' }, effectsPanel(), previewPanel()),
    ),
  );
  store.emit('project:loaded');
  markSaved();
  scheduleBuild(0);
  // first run: a four-step intro when there is nothing in the font yet (the header may still be reopening the last font)
  setTimeout(() => { if (!Object.values(store.project.glyphs).some(hasInk)) showWelcome(); }, 400);
}
