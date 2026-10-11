/* Projects and folders: the Home screen's index. A project is one canvas (screens, blocks, its own live room);
   folders group projects (Brand, Product, Sales…). The index lives where the shared libraries live:
   - claude.ai: the page's database (projects/{id}, folders/{id}); the canvas itself under projects/{id}/frames
   - server: /api/projects (server/data/projects.json); the canvas is the room with the project's id
   - neither: this browser (lg.projects), one saved canvas per project
   Anyone who can edit may create projects; a project is removed by whoever made it or an admin. */
const Projects = (() => {
  const LS = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } } };
  const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
  let env = null, backend = null, started = null;
  const S = { mode: 'local', projects: new Map(), folders: new Map(), uid: null, owner: false, canEdit: null, canWrite: null, ready: false, current: LS.get('lg.project', null) };
  const listeners = new Set(); const emit = () => { for (const fn of listeners) { try { fn(); } catch (e) { console.error(e); } } };
  // The first answer from wherever projects live (or a timeout): opening "the last project" before the list arrives
  // would make a new one instead.
  function whenReady(ms = 5000) { if (S.ready) return Promise.resolve(true); return new Promise(res => { const t = setTimeout(() => { off(); res(false); }, ms); const fn = () => { if (S.ready) { clearTimeout(t); off(); res(true); } }; listeners.add(fn); const off = () => listeners.delete(fn); }); }
  const uid = () => 'p' + Math.random().toString(36).slice(2, 10);
  const clean = p => (p && typeof p === 'object' && ID.test(String(p.id || ''))) ? { id: String(p.id), name: String(p.name || 'Untitled').slice(0, 80), folder: ID.test(String(p.folder || '')) ? String(p.folder) : '', created: +p.created || 0, by: typeof p.by === 'string' ? p.by.slice(0, 80) : '', byName: typeof p.byName === 'string' ? p.byName.slice(0, 80) : '', updated: +p.updated || 0, updatedBy: typeof p.updatedBy === 'string' ? p.updatedBy.slice(0, 80) : '', frames: +p.frames || 0, cover: typeof p.cover === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(p.cover) && p.cover.length < 60000 ? p.cover : '', archived: !!p.archived, kind: p.kind === 'deck' ? 'deck' : 'canvas' } : null;
  const cleanFolder = f => (f && typeof f === 'object' && ID.test(String(f.id || ''))) ? { id: String(f.id), name: String(f.name || 'Folder').slice(0, 60), order: +f.order || 0, by: typeof f.by === 'string' ? f.by.slice(0, 80) : '' } : null;
  function setAll({ projects, folders }) {
    if (projects) { S.projects.clear(); for (const p of projects) { const c = clean(p); if (c) S.projects.set(c.id, c); } }
    if (folders) { S.folders.clear(); for (const f of folders) { const c = cleanFolder(f); if (c) S.folders.set(c.id, c); } }
    S.ready = true; emit();
  }

  // ---- backends -------------------------------------------------------------------------------------------------------
  async function artifactBackend() {
    if (!(window.claude && typeof window.claude.use === 'function')) return null;
    const [db, user] = await Promise.all(['db', 'user'].map(n => window.claude.use(n).catch(() => null)));
    if (!db) return null;
    try { S.uid = user && user.id ? await user.id() : null; } catch { S.uid = null; }
    try { S.owner = !!(user && await user.isOwner()); } catch { S.owner = false; }
    try { S.canEdit = user && user.canEdit ? await user.canEdit() : null; } catch { S.canEdit = null; }
    try { S.canWrite = user && user.can ? await user.can('data.write') : null; } catch { S.canWrite = null; }
    const why = e => (e && (e.code === 'invalid_argument' || e.code === 'not_granted')) ? new Error('This page does not let you change projects (you may be a viewer). Ask the owner for Contributor access.') : (e instanceof Error ? e : new Error((e && e.message) || String(e)));
    const write = async fn => { try { return await fn(); } catch (e) { throw why(e); } };
    const ready = { p: false, f: false }; const done = () => { if (ready.p && ready.f) { S.ready = true; emit(); } };
    db.collection('projects').onSnapshot(snap => { if (!ready.p && snap.metadata && snap.metadata.fromCache && !snap.size) return; ready.p = true; const list = []; for (const d of snap.docs) { const v = d.data(); if (v) list.push({ ...v, id: d.id }); } S.projects.clear(); for (const p of list) { const c = clean(p); if (c) S.projects.set(c.id, c); } done(); emit(); }, () => { });
    db.collection('folders').onSnapshot(snap => { if (!ready.f && snap.metadata && snap.metadata.fromCache && !snap.size) return; ready.f = true; const list = []; for (const d of snap.docs) { const v = d.data(); if (v) list.push({ ...v, id: d.id }); } S.folders.clear(); for (const f of list) { const c = cleanFolder(f); if (c) S.folders.set(c.id, c); } done(); emit(); }, () => { });
    return {
      kind: 'artifact',
      put: p => write(() => db.doc(`projects/${p.id}`).set(p)),
      patch: (id, patch) => write(() => db.doc(`projects/${id}`).update(patch)),
      del: id => write(() => db.doc(`projects/${id}`).delete()),
      putFolder: f => write(() => db.doc(`folders/${f.id}`).set(f)),
      delFolder: id => write(() => db.doc(`folders/${id}`).delete()),
    };
  }
  async function serverBackend() {
    if (window.claude || !/^https?:$/.test(location.protocol)) return null;
    let j; try { const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 1500); const r = await fetch('/api/projects', { cache: 'no-store', signal: ctl.signal }); clearTimeout(t); if (!r.ok) return null; j = await r.json(); } catch { return null; }
    if (!j || !j.lgProjects) return null;
    S.uid = (typeof Sync !== 'undefined' && Sync.me.id) || LS.get('lg.clientId', null);
    const apply = j => setAll({ projects: j.projects || [], folders: j.folders || [] });
    apply(j);
    async function op(body) {
      const r = await fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json', 'x-lg-admin': LS.get('lg.adminKey', '') || '' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.text()).slice(0, 200) || 'The server refused that change');
      const out = await r.json(); if (out && out.lgProjects) apply(out); return out;
    }
    return {
      kind: 'server',
      refresh: (() => { let t = 0; return () => { clearTimeout(t); t = setTimeout(async () => { try { const r = await fetch('/api/projects', { cache: 'no-store' }); if (r.ok) apply(await r.json()); } catch { } }, 250); }; })(),
      put: p => op({ op: 'put', project: p }), patch: (id, patch) => op({ op: 'patch', id, patch }), del: id => op({ op: 'del', id }),
      putFolder: f => op({ op: 'putFolder', folder: f }), delFolder: id => op({ op: 'delFolder', id }),
    };
  }
  function localBackend() {
    const KEY = 'lg.projects';
    const load = () => { const j = LS.get(KEY, null) || {}; setAll({ projects: j.projects || [], folders: j.folders || [] }); };
    const save = () => { if (!LS.set(KEY, { projects: [...S.projects.values()], folders: [...S.folders.values()] })) throw new Error('This browser\'s storage is full'); };
    load(); window.addEventListener('storage', e => { if (e.key === KEY) load(); });
    S.uid = LS.get('lg.clientId', null);
    const change = fn => { fn(); save(); emit(); };
    return {
      kind: 'local',
      put: p => change(() => S.projects.set(p.id, clean(p))), patch: (id, patch) => change(() => { const c = S.projects.get(id); if (c) S.projects.set(id, clean({ ...c, ...patch })); }), del: id => change(() => S.projects.delete(id)),
      putFolder: f => change(() => S.folders.set(f.id, cleanFolder(f))), delFolder: id => change(() => S.folders.delete(id)),
    };
  }

  // ---- public ---------------------------------------------------------------------------------------------------------
  function init(e) { env = e; }
  function start() {
    if (started) return started;
    started = (async () => { backend = (await artifactBackend()) || (await serverBackend()) || localBackend(); S.mode = backend.kind; emit(); return S.mode; })();
    return started;
  }
  const projects = (folder) => [...S.projects.values()].filter(p => !p.archived && (folder === undefined || (p.folder || '') === folder)).sort((a, b) => (b.updated || b.created) - (a.updated || a.created));
  const folders = () => [...S.folders.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  const get = id => S.projects.get(id) || null;
  const isAdmin = () => { try { return typeof LibStore !== 'undefined' && LibStore.role().admin; } catch { return false; } };
  function canChange(p) { return !!p && (S.owner || isAdmin() || (S.uid && p.by === S.uid) || (!S.uid && S.mode !== 'artifact')); }
  const must = () => { if (!backend) throw new Error('Projects are still loading'); if (S.canWrite === false) throw new Error('You can open projects but not change them here: ask the owner for Contributor access.'); };
  async function create({ name, folder = '', kind = 'canvas', id } = {}) {
    must(); const me = env && env.me ? env.me() : {};
    const p = clean({ id: id && ID.test(id) ? id : uid(), name: String(name || 'Untitled project').trim().slice(0, 80) || 'Untitled project', folder, created: Date.now(), by: S.uid || me.id || '', byName: me.name || '', updated: Date.now(), updatedBy: S.uid || me.id || '', frames: 0, kind });
    await backend.put(p); S.projects.set(p.id, p); emit(); return p;
  }
  async function update(id, patch) { must(); const cur = get(id); if (!cur) throw new Error('No such project'); if (('name' in patch || 'folder' in patch || 'archived' in patch) && !canChange(cur)) throw new Error('Only the person who made this project (or an admin) can change it'); const next = clean({ ...cur, ...patch, id }); await backend.patch(id, { ...patch, updated: next.updated }); S.projects.set(id, next); emit(); return next; }
  // Bookkeeping from the canvas (frames count, cover, last edit): quiet, at most every 20 s per project.
  const touchT = new Map();
  async function touch(id, info = {}) {
    const cur = get(id); if (!cur || !backend) return;
    const last = touchT.get(id) || 0; if (Date.now() - last < 20000 && !info.force) return; touchT.set(id, Date.now());
    const patch = { updated: Date.now(), updatedBy: S.uid || '' }; if (info.frames != null) patch.frames = info.frames; if (info.cover) patch.cover = info.cover;
    try { await backend.patch(id, patch); Object.assign(cur, patch); emit(); } catch { }
  }
  async function remove(id) { must(); const cur = get(id); if (!cur) return; if (!canChange(cur)) throw new Error('Only the person who made this project (or an admin) can remove it'); await backend.patch(id, { archived: true, updated: Date.now() }); cur.archived = true; emit(); }
  async function restore(id) { must(); const cur = S.projects.get(id); if (!cur) return; await backend.patch(id, { archived: false, updated: Date.now() }); cur.archived = false; emit(); }
  async function createFolder(name) { must(); const f = cleanFolder({ id: 'f' + Math.random().toString(36).slice(2, 10), name: String(name || 'Folder').trim().slice(0, 60) || 'Folder', order: folders().length + 1, by: S.uid || '' }); await backend.putFolder(f); S.folders.set(f.id, f); emit(); return f; }
  async function renameFolder(id, name) { must(); const f = S.folders.get(id); if (!f) return; const next = { ...f, name: String(name || f.name).trim().slice(0, 60) || f.name }; await backend.putFolder(next); S.folders.set(id, next); emit(); }
  async function removeFolder(id) { must(); const f = S.folders.get(id); if (!f) return; if (!(S.owner || isAdmin() || f.by === S.uid || S.mode !== 'artifact')) throw new Error('Only whoever made this folder (or an admin) can remove it'); for (const p of projects(id)) await update(p.id, { folder: '' }); await backend.delFolder(id); S.folders.delete(id); emit(); }
  function setCurrent(id) { S.current = id; LS.set('lg.project', id); emit(); }
  const archived = () => [...S.projects.values()].filter(p => p.archived).sort((a, b) => b.updated - a.updated);
  return {
    init, start, whenReady, projects, folders, get, create, update, touch, remove, restore, archived, createFolder, renameFolder, removeFolder, setCurrent, canChange,
    refresh: () => backend && backend.refresh ? backend.refresh() : null,
    on: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    get mode() { return S.mode; }, get ready() { return S.ready; }, get current() { return S.current; }, get me() { return S.uid; },
  };
})();
