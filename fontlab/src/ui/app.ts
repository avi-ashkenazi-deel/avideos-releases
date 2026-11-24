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
import { moveVersions, SCRATCH } from '../project/versions';
import { openJoinDialog } from './panels/shareDialog';
import { loadConfig } from './config';
import { resumeSession } from './collab';
import { hasInk } from './panels/seeds';

export async function mountApp(root: HTMLElement): Promise<void> {
  void loadConfig(); // optional fontlab.config.json next to index.html
  (window as unknown as { __fontlab: typeof store }).__fontlab = store; // debugging / e2e handle
  // one-time: move the old single autosave into the library
  try {
    const legacy = await migrateLegacyAutosave();
    if (legacy && !getCurrentId()) setCurrentId(legacy.id);
    // the unsaved font just became a library font: its versions follow it
    if (legacy) await moveVersions(SCRATCH, legacy.id).catch(() => undefined);
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
  const params = new URLSearchParams(location.search);
  const room = params.get('join');
  if (room && /^[A-Za-z0-9_-]{4,40}$/.test(room)) { setTimeout(() => openJoinDialog(room, params.get('via') === 'local' ? 'local' : 'peer'), 500); return; }
  // a reload keeps the session of this tab going (the host keeps the same link)
  const resumed = await loadConfig().then(() => resumeSession()).catch(() => null);
  if (resumed) return;
  setTimeout(() => { if (!Object.values(store.project.glyphs).some(hasInk)) showWelcome(); }, 400);
}
