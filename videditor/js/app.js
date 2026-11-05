import { h, svg, avatar, getAuthor, setAuthor, modal, toast, md } from './ui.js';
import { api } from './api.js';
import { renderLibrary } from './library.js';
import { renderReview } from './review.js';
import { renderCompare } from './compare.js';
import { renderStudio } from './studio.js';

const app = document.getElementById('app');
const bar = h('div.topbar');
const view = h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 } });
app.append(bar, view);

const navigate = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };
// ---- updates: one check per page load (the server caches it); a notice in the top bar when one is ready.
let updateInfo = null;
const updateBtn = h('button.btn.sm.update-pill.hidden', { title: 'A new version of Videditor is ready' }, svg('download'), h('span.up-text', 'Update'));
updateBtn.addEventListener('click', () => showUpdate());
async function refreshUpdate(force = false) {
  try { updateInfo = await api.updateStatus(force); } catch { return null; }
  updateBtn.classList.toggle('hidden', !updateInfo.available);
  if (updateInfo.available) updateBtn.querySelector('.up-text').textContent = `Update to ${updateInfo.version}`;
  return updateInfo;
}
async function showUpdate() {
  const u = updateInfo || await refreshUpdate(true);
  if (!u) return toast('Could not check for updates', 'err');
  if (u.mode === 'dev') return modal('Updates', h('div', h('p', `You are running a developer copy (v${u.current}).`), h('p.muted', 'Installed copies update themselves. This one updates with git pull.')));
  if (!u.available) return modal('Videditor is up to date', h('div', h('p', `You have the newest version, v${u.current}.`), u.error ? h('p.small.muted', `Last check could not reach GitHub: ${u.error}`) : null));
  const body = h('div', h('p', `v${u.current} → `, h('b', `v${u.version}`)), u.notes ? h('div.update-notes', md(u.notes.replace(/^•\s*/gm, '- '))) : null, h('p.small.muted', 'Videditor restarts; this page reloads by itself. Your videos are not touched.'));
  if (!(await modal("What's new", body, { actions: [{ label: 'Restart to update', cls: 'primary', value: true }] }))) return;
  const wait = h('p', 'Updating… this takes a few seconds.');
  const close = modal('Updating Videditor', wait, { actions: [] });
  try {
    const r = await api.applyUpdate();
    for (let i = 0; i < 120; i++) {
      await new Promise((res) => setTimeout(res, 1000));
      try { const st = await fetch('/api/state').then((x) => x.json()); if (st.version === r.version) { location.reload(); return; } } catch {}
    }
    wait.textContent = 'Videditor did not come back. Open it again from the Videditor app.';
  } catch (e) { wait.textContent = `Update failed: ${e.message}`; }
  void close;
}
refreshUpdate();

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
    h('button.menu-item', { on: { click: () => { close(); showUpdate(); } } }, svg('download'), h('span.mi-text', h('span', updateInfo?.available ? `Update to v${updateInfo.version}` : 'Check for updates'), h('span.mi-hint', `Videditor v${updateInfo?.current || '…'}${updateInfo?.mode === 'dev' ? ' · developer copy' : ''}`))),
    updateInfo?.mode === 'installed' ? h('label.menu-item.check', h('input', { type: 'checkbox', checked: updateInfo.settings?.autoUpdate !== false, on: { change: async (e) => { try { await api.saveSettings({ autoUpdate: e.target.checked }); updateInfo.settings = { autoUpdate: e.target.checked }; toast(e.target.checked ? 'Updates install when you open Videditor' : 'Auto-update off: you will see a notice instead', 'ok'); } catch (err) { toast(err.message, 'err'); } } } }), h('span.mi-text', h('span', 'Update automatically'), h('span.mi-hint', 'When you open Videditor'))) : null
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
