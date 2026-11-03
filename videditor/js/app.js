import { h, svg, avatar, getAuthor, setAuthor, modal, toast } from './ui.js';
import { renderLibrary } from './library.js';
import { renderReview } from './review.js';
import { renderCompare } from './compare.js';
import { renderStudio } from './studio.js';

const app = document.getElementById('app');
const bar = h('div.topbar');
const view = h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 } });
app.append(bar, view);

const navigate = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };
// Account: just the initials; the name and 'Change name' show when it opens.
function accountMenu(who) {
  const changeName = async () => { close(); const i = h('input.text', { value: who, maxlength: 60, placeholder: 'Your name' }); if (await modal('Your name', i, { actions: [{ label: 'Save', cls: 'primary' }] }) && i.value.trim()) { setAuthor(i.value.trim()); route(); } };
  const trigger = h('button.account', { title: who || 'Set your name', 'aria-label': 'Account', 'aria-haspopup': 'menu' }, avatar(who || '?'));
  const pop = h('div.menu.account-menu.hidden', { role: 'menu' },
    h('div.account-head', avatar(who || '?'), h('div', h('div.account-name', who || 'No name yet'), h('div.mi-hint', 'Shown on your notes and messages'))),
    h('div.menu-sep'),
    h('button.menu-item', { on: { click: changeName } }, svg('pen'), h('span.mi-text', h('span', who ? 'Change name' : 'Set your name'))));
  const wrap = h('div.menuwrap.accountwrap', trigger, pop);
  const onDoc = (e) => { if (!wrap.contains(e.target)) close(); };
  function close() { pop.classList.add('hidden'); document.removeEventListener('pointerdown', onDoc); window.removeEventListener('blur', close); }
  trigger.addEventListener('click', () => { if (pop.classList.contains('hidden')) { pop.classList.remove('hidden'); setTimeout(() => document.addEventListener('pointerdown', onDoc), 0); window.addEventListener('blur', close); } else close(); });
  pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); trigger.focus(); } });
  return wrap;
}
function topbar(items = []) {
  const who = getAuthor();
  bar.replaceChildren(...[
    h('a.brand', { href: '#/', title: 'Videditor' }, svg('logo'), 'Videditor'),
    items.length ? h('span.crumb', '/') : null,
    ...items,
    items.length ? null : h('span.spacer'),
    accountMenu(who),
  ].filter(Boolean));
}

async function route() {
  view._cleanup?.(); view._cleanup = null;
  const [path, qs] = (location.hash || '#/').slice(1).split('?');
  const q = new URLSearchParams(qs || '');
  try {
    let m;
    if ((m = /^\/studio\/([^/]+)$/.exec(path))) { topbar([h('span.muted', 'Loading…')]); await renderStudio(view, { projectId: m[1], prompt: q.get('prompt'), navigate, topbar }); }
    else if ((m = /^\/p\/([^/]+)\/compare$/.exec(path))) await renderCompare(view, { projectId: m[1], a: q.get('a'), b: q.get('b'), navigate, topbar });
    else if ((m = /^\/p\/([^/]+)$/.exec(path))) { topbar([h('span.muted', 'Loading…')]); await renderReview(view, { projectId: m[1], versionId: q.get('v'), navigate, topbar }); }
    else { topbar([]); await renderLibrary(view, { navigate }); }
  } catch (e) {
    console.error(e); topbar([]);
    view.replaceChildren(h('div.empty', h('h2', 'Something went wrong'), h('p.muted', e.message), h('a', { href: '#/' }, 'Back to projects')));
  }
}
window.addEventListener('hashchange', route);
route();
