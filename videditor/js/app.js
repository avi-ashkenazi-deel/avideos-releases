import { h, svg, avatar, getAuthor, setAuthor, modal, toast } from './ui.js';
import { renderLibrary } from './library.js';
import { renderReview } from './review.js';
import { renderCompare } from './compare.js';

const app = document.getElementById('app');
const bar = h('div.topbar');
const view = h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 } });
app.append(bar, view);

const navigate = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };
function topbar(items = []) {
  const who = getAuthor();
  bar.replaceChildren(...[
    h('a.brand', { href: '#/', title: 'Videditor' }, svg('logo'), 'Videditor'),
    items.length ? h('span.crumb', '/') : null,
    ...items,
    items.length ? null : h('span.spacer'),
    h('span.author', { title: 'Change your name', on: { click: async () => { const i = h('input.text', { value: who, maxlength: 60 }); if (await modal('Your name', i, { actions: [{ label: 'Save', cls: 'primary' }] }) && i.value.trim()) { setAuthor(i.value.trim()); route(); } } } }, avatar(who || '?'), h('span.small', who || 'Set your name')),
  ].filter(Boolean));
}

async function route() {
  view._cleanup?.(); view._cleanup = null;
  const [path, qs] = (location.hash || '#/').slice(1).split('?');
  const q = new URLSearchParams(qs || '');
  try {
    let m;
    if ((m = /^\/p\/([^/]+)\/compare$/.exec(path))) await renderCompare(view, { projectId: m[1], a: q.get('a'), b: q.get('b'), navigate, topbar });
    else if ((m = /^\/p\/([^/]+)$/.exec(path))) { topbar([h('span.muted', 'Loading…')]); await renderReview(view, { projectId: m[1], versionId: q.get('v'), navigate, topbar }); }
    else { topbar([]); await renderLibrary(view, { navigate }); }
  } catch (e) {
    console.error(e); topbar([]);
    view.replaceChildren(h('div.empty', h('h2', 'Something went wrong'), h('p.muted', e.message), h('a', { href: '#/' }, 'Back to projects')));
  }
}
window.addEventListener('hashchange', route);
route();
