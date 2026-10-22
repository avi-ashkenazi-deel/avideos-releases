import { store } from './state';
import { loadLocal } from '../project/storage';
import { headerBar } from './panels/exportPanel';
import { seedsPanel } from './panels/seeds';
import { gridPanel } from './panels/grid';
import { dnaPanel } from './panels/dna';
import { previewPanel } from './panels/preview';
import { scheduleBuild } from './buildClient';
import { h } from './dom';

export function mountApp(root: HTMLElement): void {
  const saved = loadLocal();
  if (saved) store.project = saved;
  root.replaceChildren(
    headerBar(),
    h('main', { class: 'layout' },
      seedsPanel(),
      gridPanel((ch) => { store.selected = ch; store.emit('select'); }),
      h('div', { class: 'right' }, dnaPanel(), previewPanel()),
    ),
  );
  store.emit('project:loaded');
  scheduleBuild(0);
}
