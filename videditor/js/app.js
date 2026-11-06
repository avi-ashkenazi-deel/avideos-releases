import { h, svg, avatar, getAuthor, setAuthor, modal, toast, md } from './ui.js';
import { renderLibrary } from './library.js';
import { renderReview } from './review.js';
import { renderCompare } from './compare.js';
import { renderStudio } from './studio.js';

const app = document.getElementById('app');
const bar = h('div.topbar');
const view = h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 } });
app.append(bar, view);

const navigate = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };
// ---- the Mac app (window.videditorDesktop from desktop/preload.cjs): version, updates, videos folder.
// In a plain browser (developer copy) none of this shows.
const desk = window.videditorDesktop || null;
let appInfo = null; let upd = null;
const updateBtn = h('button.btn.sm.update-pill.hidden', { title: 'A new version of Videditor' }, svg('download'), h('span.up-text', 'Update'));
updateBtn.addEventListener('click', () => showUpdate());
function paintUpdate(s) {
  upd = s; if (!s) return;
  const show = ['ready', 'downloading', 'available'].includes(s.status);
  updateBtn.classList.toggle('hidden', !show);
  updateBtn.classList.toggle('busy', s.status === 'downloading');
  updateBtn.querySelector('.up-text').textContent = s.status === 'ready' ? `Restart to update to ${s.ready?.version || s.version}` : s.status === 'downloading' ? `Downloading ${s.version} · ${Math.round((s.progress || 0) * 100)}%` : `Update to ${s.version}`;
}
if (desk) {
  desk.info().then((i) => { appInfo = i; }).catch(() => {});
  desk.update.get().then(paintUpdate).catch(() => {});
  desk.update.onState(paintUpdate);
} else fetch('/api/state').then((r) => r.json()).then((s) => { appInfo = { version: s.version, packaged: false }; }).catch(() => {});

async function showUpdate() {
  if (!desk) return;
  const s = upd || await desk.update.get();
  if (s.status === 'downloading') return toast(`Downloading ${s.version}… it will be ready in a moment`, 'ok');
  const notes = s.notes ? h('div.update-notes', md(String(s.notes).replace(/^•\s*/gm, '- '))) : null;
  if (s.status === 'ready') {
    if (await modal("What's new", h('div', h('p', `${s.current} → `, h('b', s.ready?.version || s.version)), notes, h('p.small.muted', 'Videditor quits, updates and opens again. Your videos are not touched. If you keep working, it updates the next time you quit.')), { actions: [{ label: 'Later', value: false }, { label: 'Restart now', cls: 'primary', value: true }] })) desk.update.install();
    return;
  }
  if (s.status === 'available') {
    if (await modal(`Videditor ${s.version} is available`, h('div', notes, h('p.small.muted', 'It downloads in the background; you can keep working.')), { actions: [{ label: 'Download', cls: 'primary', value: true }] })) { await desk.update.check(); toast('Downloading the update…', 'ok'); }
    return;
  }
  const r = await desk.update.check();
  if (!['available', 'downloading', 'ready'].includes(r.status)) toast(r.error ? `Could not check: ${r.error}` : `Videditor ${r.current} is the newest version`, r.error ? 'err' : 'ok');
}

// Account: just the initials; the name and 'Change name' show when it opens.
function accountMenu(who) {
  const changeName = async () => { close(); const i = h('input.text', { value: who, maxlength: 60, placeholder: 'Your name' }); if (await modal('Your name', i, { actions: [{ label: 'Save', cls: 'primary' }] }) && i.value.trim()) { setAuthor(i.value.trim()); route(); } };
  const trigger = h('button.account', { title: who || 'Set your name', 'aria-label': 'Account', 'aria-haspopup': 'menu' }, avatar(who || '?'));
  const pop = h('div.menu.account-menu.hidden', { role: 'menu' });
  // Built on every open, so the version and update state are current.
  const fill = () => pop.replaceChildren(...[
    h('div.account-head', avatar(who || '?'), h('div', h('div.account-name', who || 'No name yet'), h('div.mi-hint', 'Shown on your notes and messages'))),
    h('div.menu-sep'),
    h('button.menu-item', { on: { click: changeName } }, svg('pen'), h('span.mi-text', h('span', who ? 'Change name' : 'Set your name'))),
    h('div.menu-sep'),
    h('button.menu-item', { on: { click: () => { close(); desk ? showUpdate() : null; } } }, svg('download'), h('span.mi-text', h('span', !desk ? 'Updates' : upd?.status === 'ready' ? `Restart to update to ${upd.ready?.version}` : 'Check for updates'), h('span.mi-hint', `Videditor ${appInfo?.version ? 'v' + appInfo.version : ''}${desk ? '' : ' · developer copy (git pull to update)'}`))),
    desk ? h('label.menu-item.check', h('input', { type: 'checkbox', checked: upd?.auto !== false, on: { change: async (e) => { try { paintUpdate(await desk.update.setAuto(e.target.checked)); toast(e.target.checked ? 'Updates download by themselves and install when you restart' : 'Auto-update off: you will see a notice instead', 'ok'); } catch (err) { toast(err.message, 'err'); } } } }), h('span.mi-text', h('span', 'Update automatically'), h('span.mi-hint', 'Downloads in the background'))) : null,
    desk ? h('button.menu-item', { on: { click: () => { close(); desk.openHome(); } } }, svg('folder'), h('span.mi-text', h('span', 'Open videos folder'), h('span.mi-hint', appInfo?.home || '~/Videditor'))) : null,
  ].flat().filter(Boolean));
  const wrap = h('div.menuwrap.accountwrap', trigger, pop);
  const onDoc = (e) => { if (!wrap.contains(e.target)) close(); };
  function close() { pop.classList.add('hidden'); document.removeEventListener('pointerdown', onDoc); window.removeEventListener('blur', close); }
  trigger.addEventListener('click', () => { if (pop.classList.contains('hidden')) { fill(); pop.classList.remove('hidden'); setTimeout(() => document.addEventListener('pointerdown', onDoc), 0); window.addEventListener('blur', close); } else close(); });
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
    updateBtn, accountMenu(who),
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
