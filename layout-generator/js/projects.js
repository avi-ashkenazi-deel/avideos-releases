/* Projects and folders: the Home screen's index. A project is one canvas (screens, blocks, its own live room);
   folders group projects (Brand, Product, Sales…). The index lives where the shared libraries live:
   - claude.ai: the page's database (projects/{id}, folders/{id}); the canvas itself under projects/{id}/frames
   - server: /api/projects (server/data/projects.json); the canvas is the room with the project's id
   - neither: this browser (lg.projects), one saved canvas per project
   Anyone who can edit may create projects; a project is removed by whoever made it or an admin.
   Sharing is per folder: Everyone (the default), Specific people (its maker plus the people listed) or Only me.
   Unfiled projects are everyone's.
   - claude.ai: an "Only me" folder and its projects (index, screens, pictures) live in the maker's private part of
     the database (private/<id>/…), which nobody else can read, the page's owner included, and its canvas has no
     live room. "Specific people" hides the folder from everyone else in the app, but its data sits in the shared
     database: it is not a lock against someone who reads the page's data directly.
   - server: the server filters what it sends and refuses rooms and changes, by the person's id: trusted when the
     server sits behind a sign-in proxy (LG_USER_HEADER), otherwise the id this browser made up. */
const Projects = (() => {
  const LS = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } } };
  const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
  const ACCESS = ['all', 'people', 'me'];
  let env = null, backend = null, started = null;
  // projects/folders: the shared index; pprojects/pfolders: this person's private ones (claude.ai "Only me")
  const S = { mode: 'local', projects: new Map(), folders: new Map(), pprojects: new Map(), pfolders: new Map(), uid: null, trusted: false, owner: false, canEdit: null, canWrite: null, ready: false, pageLink: '', current: LS.get('lg.project', null) };
  const listeners = new Set(); const emit = () => { for (const fn of listeners) { try { fn(); } catch (e) { console.error(e); } } };
  // The first answer from wherever projects live (or a timeout): opening "the last project" before the list arrives
  // would make a new one instead.
  function whenReady(ms = 5000) { if (S.ready) return Promise.resolve(true); return new Promise(res => { const t = setTimeout(() => { off(); res(false); }, ms); const fn = () => { if (S.ready) { clearTimeout(t); off(); res(true); } }; listeners.add(fn); const off = () => listeners.delete(fn); }); }
  const uid = () => 'p' + Math.random().toString(36).slice(2, 10);
  const clean = p => (p && typeof p === 'object' && ID.test(String(p.id || ''))) ? { id: String(p.id), name: String(p.name || 'Untitled').slice(0, 80), folder: ID.test(String(p.folder || '')) ? String(p.folder) : '', created: +p.created || 0, by: typeof p.by === 'string' ? p.by.slice(0, 120) : '', byName: typeof p.byName === 'string' ? p.byName.slice(0, 80) : '', updated: +p.updated || 0, updatedBy: typeof p.updatedBy === 'string' ? p.updatedBy.slice(0, 120) : '', frames: +p.frames || 0, cover: typeof p.cover === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(p.cover) && p.cover.length < 60000 ? p.cover : '', archived: !!p.archived, kind: p.kind === 'deck' ? 'deck' : 'canvas' } : null;
  const cleanPeople = a => Array.isArray(a) ? [...new Set(a.filter(x => typeof x === 'string' && x && x.length <= 120))].slice(0, 100) : [];
  const cleanFolder = f => (f && typeof f === 'object' && ID.test(String(f.id || ''))) ? { id: String(f.id), name: String(f.name || 'Folder').slice(0, 60), order: +f.order || 0, by: typeof f.by === 'string' ? f.by.slice(0, 120) : '', access: ACCESS.includes(f.access) ? f.access : 'all', people: f.access === 'people' ? cleanPeople(f.people) : [] } : null;
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
    S.trusted = !!S.uid;
    const why = e => (e && (e.code === 'invalid_argument' || e.code === 'not_granted')) ? new Error('This page does not let you change projects (you may be a viewer). Ask the owner for Contributor access.') : (e instanceof Error ? e : new Error((e && e.message) || String(e)));
    const write = async fn => { try { return await fn(); } catch (e) { throw why(e); } };
    // The shared index, plus (with an id) this person's private one; ready once every part has answered.
    const mine = S.uid ? `private/${S.uid}/` : null;
    const ready = { p: false, f: false, pp: !mine, pf: !mine }; const done = () => { if (Object.values(ready).every(Boolean) && !S.ready) { S.ready = true; emit(); } };
    const watch = (path, key, map, fn) => db.collection(path).onSnapshot(snap => {
      if (!ready[key] && snap.metadata && snap.metadata.fromCache && !snap.size) return;
      ready[key] = true; map.clear(); for (const d of snap.docs) { const v = d.data(); const c = v && fn({ ...v, id: d.id }); if (c) map.set(c.id, c); } done(); emit();
    }, () => { ready[key] = true; done(); });
    watch('projects', 'p', S.projects, clean); watch('folders', 'f', S.folders, cleanFolder);
    if (mine) { watch(mine + 'projects', 'pp', S.pprojects, clean); watch(mine + 'folders', 'pf', S.pfolders, cleanFolder); }
    // The page's own address (the owner sets it once), for project links.
    db.doc('config/page').onSnapshot(s => { const d = s.data(); S.pageLink = d && typeof d.link === 'string' && /^https:\/\/[^\s#]+$/.test(d.link) ? d.link : ''; emit(); }, () => { });
    const at = priv => priv ? mine : '';
    // Where a canvas keeps its screens, settings and pictures. Shared projects keep pictures in the page-wide assets
    // collection; private ones keep their own.
    const parts = base => [['frames', base + 'frames'], ['canvas', base + 'canvas'], ['assets', base.startsWith('private/') ? base + 'assets' : 'assets']];
    async function readAll(path) { try { const snap = await db.collection(path).limit(1000).get(); return snap.docs.map(d => [d.id, d.data()]).filter(([, v]) => v); } catch { return []; } }
    return {
      kind: 'artifact',
      put: (p, priv) => write(() => db.doc(`${at(priv)}projects/${p.id}`).set(p)),
      patch: (id, patch, priv) => write(() => db.doc(`${at(priv)}projects/${id}`).update(patch)),
      del: (id, priv) => write(() => db.doc(`${at(priv)}projects/${id}`).delete()),
      putFolder: (f, priv) => write(() => db.doc(`${at(priv)}folders/${f.id}`).set(f)),
      delFolder: (id, priv) => write(() => db.doc(`${at(priv)}folders/${id}`).delete()),
      // A canvas copied between the shared database and the private part. Going private, only the pictures its
      // screens use are copied (the page-wide ones stay where they are, others may use them too).
      async copyCanvas(from, to) {
        const src = parts(from), dst = parts(to); let used = null;
        for (let i = 0; i < src.length; i++) {
          if (src[i][1] === dst[i][1]) continue;
          let docs = await readAll(src[i][1]);
          if (src[i][0] === 'frames') used = JSON.stringify(docs);
          if (src[i][0] === 'assets' && !from.startsWith('private/')) docs = docs.filter(([id]) => used && used.includes(id));
          for (const [id, v] of docs) await write(() => db.doc(`${dst[i][1]}/${id}`).set(v));
        }
      },
      async clearCanvas(from) { for (const [name, path] of parts(from)) { if (name === 'assets' && !from.startsWith('private/')) continue; for (const [id] of await readAll(path)) { try { await db.doc(`${path}/${id}`).delete(); } catch { } } } },
      people: {
        search: async q => { if (!user || !user.search) return []; try { return (await user.search(String(q || ''))).map(p => ({ id: p.id, name: p.name || '', avatar: p.avatarUrl || '', me: !!p.isMe })); } catch { return []; } },
        names: async ids => { const out = {}; for (const id of ids) out[id] = { id, name: '', avatar: '' }; if (!ids.length || !user || !user.profiles) return out; try { const ps = await user.profiles(ids); for (const id of ids) { const p = ps[id] || {}; out[id] = { id, name: p.name || '', avatar: p.avatarUrl || '', me: !!p.isMe }; } } catch { } return out; },
      },
    };
  }
  // Who is asking, for the server: this browser's id and the name it goes by (the server prefers its sign-in header).
  function who() { const me = env && env.me ? env.me() : {}; const id = me.id || LS.get('lg.clientId', '') || ''; return { 'x-lg-user': String(id), 'x-lg-name': encodeURIComponent(String(me.name || '').slice(0, 80)) }; }
  async function serverBackend() {
    if (window.claude || !/^https?:$/.test(location.protocol)) return null;
    let j; try { const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 1500); const r = await fetch('/api/projects', { cache: 'no-store', signal: ctl.signal, headers: who() }); clearTimeout(t); if (!r.ok) return null; j = await r.json(); } catch { return null; }
    if (!j || !j.lgProjects) return null;
    // The server answers with what this person may see, and who it takes them to be.
    S.uid = (env && env.me && env.me().id) || LS.get('lg.clientId', null);
    const apply = j => { if (j.me && typeof j.me.id === 'string' && j.me.id) { S.uid = j.me.id; S.trusted = !!j.me.trusted; } setAll({ projects: j.projects || [], folders: j.folders || [] }); };
    apply(j);
    async function op(body) {
      const r = await fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json', 'x-lg-admin': LS.get('lg.adminKey', '') || '', ...who() }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.text()).slice(0, 200) || 'The server refused that change');
      const out = await r.json(); if (out && out.lgProjects) apply(out); return out;
    }
    const people = async (q, ids) => { try { const r = await fetch(`/api/people?q=${encodeURIComponent(q || '')}&ids=${encodeURIComponent((ids || []).join(','))}`, { cache: 'no-store', headers: who() }); return r.ok ? ((await r.json()).people || []) : []; } catch { return []; } };
    return {
      kind: 'server',
      refresh: (() => { let t = 0; return () => { clearTimeout(t); t = setTimeout(async () => { try { const r = await fetch('/api/projects', { cache: 'no-store', headers: who() }); if (r.ok) apply(await r.json()); } catch { } }, 250); }; })(),
      put: p => op({ op: 'put', project: p }), patch: (id, patch) => op({ op: 'patch', id, patch }), del: id => op({ op: 'del', id }),
      putFolder: f => op({ op: 'putFolder', folder: f }), delFolder: id => op({ op: 'delFolder', id }),
      people: {
        search: async q => (await people(q, [])).map(p => ({ id: p.id, name: p.name || '', avatar: '', me: p.id === S.uid })),
        names: async ids => { const out = {}; for (const id of ids) out[id] = { id, name: '', avatar: '' }; if (ids.length) for (const p of await people('', ids)) if (out[p.id]) out[p.id] = { id: p.id, name: p.name || '', avatar: '', me: p.id === S.uid }; return out; },
      },
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

  // ---- who sees what ----------------------------------------------------------------------------------------------------
  const anyFolder = id => (id && (S.folders.get(id) || S.pfolders.get(id))) || null;
  const anyProject = id => S.projects.get(id) || S.pprojects.get(id) || null;
  const isPriv = id => S.pprojects.has(id);
  // A folder is seen by everyone, or by its maker and the people listed, or by its maker alone. In this browser
  // alone (no claude.ai, no server) there is nobody else.
  function seesFolder(f) {
    if (!f || f.access === 'all' || S.mode === 'local') return true;
    if (!S.uid) return false;
    return f.by === S.uid || (f.access === 'people' && f.people.includes(S.uid));
  }
  const sees = p => seesFolder(anyFolder(p.folder));
  const accessOf = p => { const f = p && anyFolder(p.folder); return f ? f.access : 'all'; };
  const allProjects = () => [...S.projects.values(), ...S.pprojects.values()];
  const isAdmin = () => { try { return typeof LibStore !== 'undefined' && LibStore.role().admin; } catch { return false; } };

  // ---- public ---------------------------------------------------------------------------------------------------------
  function init(e) { env = e; }
  function start() {
    if (started) return started;
    started = (async () => { backend = (await artifactBackend()) || (await serverBackend()) || localBackend(); S.mode = backend.kind; emit(); return S.mode; })();
    return started;
  }
  const projects = (folder) => allProjects().filter(p => !p.archived && sees(p) && (folder === undefined || (p.folder || '') === folder)).sort((a, b) => (b.updated || b.created) - (a.updated || a.created));
  const folders = () => [...S.folders.values(), ...S.pfolders.values()].filter(seesFolder).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  const get = id => { const p = anyProject(id); return p && sees(p) ? p : null; };
  // Projects in folders someone else shared with this person by name.
  const sharedWithMe = () => projects().filter(p => { const f = anyFolder(p.folder); return f && f.access === 'people' && f.by !== S.uid; });
  function canChange(p) { return !!p && (S.owner || isAdmin() || (S.uid && p.by === S.uid) || (!S.uid && S.mode !== 'artifact')); }
  // Who may change a folder's sharing: whoever made it, or an admin for an everyone-folder (nobody else sees the rest).
  function canShare(f) { f = typeof f === 'string' ? anyFolder(f) : f; if (!f || S.mode === 'local') return false; return (!!S.uid && f.by === S.uid) || (f.access === 'all' && (S.owner || isAdmin())); }
  const must = () => { if (!backend) throw new Error('Projects are still loading'); if (S.canWrite === false) throw new Error('You can open projects but not change them here: ask the owner for Contributor access.'); };
  const privateFolder = id => S.mode === 'artifact' && S.pfolders.has(id || '');
  async function create({ name, folder = '', kind = 'canvas', id } = {}) {
    must(); const me = env && env.me ? env.me() : {};
    if (folder && !seesFolder(anyFolder(folder))) folder = '';
    const p = clean({ id: id && ID.test(id) ? id : uid(), name: String(name || 'Untitled project').trim().slice(0, 80) || 'Untitled project', folder, created: Date.now(), by: S.uid || me.id || '', byName: me.name || '', updated: Date.now(), updatedBy: S.uid || me.id || '', frames: 0, kind });
    const priv = privateFolder(folder);
    await backend.put(p, priv); (priv ? S.pprojects : S.projects).set(p.id, p); emit(); return p;
  }
  // claude.ai: a project moved into or out of an "Only me" folder moves its canvas to or from the private part.
  // The open canvas is let go first (its last edits saved) and opened again where it now lives.
  let moving = null;
  async function relocate(id, next, toPriv) {
    const fromPriv = isPriv(id); const from = baseOf(id);
    moving = id; const wasOpen = env && env.release ? await env.release(id) : false;
    try {
      const to = toPriv ? `private/${S.uid}/projects/${id}/` : `projects/${id}/`;
      await backend.put(next, toPriv); (toPriv ? S.pprojects : S.projects).set(id, next);
      await backend.copyCanvas(from, to);
      await backend.del(id, fromPriv); (fromPriv ? S.pprojects : S.projects).delete(id);
      await backend.clearCanvas(from);
      // someone else who had it open may still save a last edit to the shared place: sweep once more
      // (not if it has moved back meanwhile: then that place is its home again)
      if (toPriv && !fromPriv) setTimeout(() => { if (isPriv(id) && moving !== id) backend.clearCanvas(from).catch(() => { }); }, 5000);
    } finally { moving = null; emit(); if (wasOpen && env.reopen) await env.reopen(id); }
  }
  async function update(id, patch) {
    must(); const cur = get(id); if (!cur) throw new Error('No such project');
    if (('name' in patch || 'folder' in patch || 'archived' in patch) && !canChange(cur)) throw new Error('Only the person who made this project (or an admin) can change it');
    if ('folder' in patch && patch.folder && !seesFolder(anyFolder(patch.folder))) throw new Error('No such folder');
    const next = clean({ ...cur, ...patch, id });
    if ('folder' in patch && S.mode === 'artifact') {
      const toPriv = privateFolder(patch.folder);
      if (toPriv && cur.by !== S.uid) throw new Error('Only your own projects go in an “Only me” folder');
      if (toPriv !== isPriv(id)) { next.updated = Date.now(); await relocate(id, next, toPriv); return next; }
    }
    await backend.patch(id, { ...patch, updated: next.updated }, isPriv(id)); (isPriv(id) ? S.pprojects : S.projects).set(id, next); emit(); return next;
  }
  // Bookkeeping from the canvas (frames count, cover, last edit): quiet, at most every 20 s per project.
  const touchT = new Map();
  async function touch(id, info = {}) {
    const cur = get(id); if (!cur || !backend || moving === id) return;
    const last = touchT.get(id) || 0; if (Date.now() - last < 20000 && !info.force) return; touchT.set(id, Date.now());
    const patch = { updated: Date.now(), updatedBy: S.uid || '' }; if (info.frames != null) patch.frames = info.frames; if (info.cover) patch.cover = info.cover;
    try { await backend.patch(id, patch, isPriv(id)); Object.assign(cur, patch); emit(); } catch { }
  }
  async function remove(id) { must(); const cur = get(id); if (!cur) return; if (!canChange(cur)) throw new Error('Only the person who made this project (or an admin) can remove it'); await backend.patch(id, { archived: true, updated: Date.now() }, isPriv(id)); cur.archived = true; emit(); }
  async function restore(id) { must(); const cur = anyProject(id); if (!cur || !sees(cur)) return; await backend.patch(id, { archived: false, updated: Date.now() }, isPriv(id)); cur.archived = false; emit(); }
  async function createFolder(name, opts = {}) {
    must();
    const f = cleanFolder({ id: 'f' + Math.random().toString(36).slice(2, 10), name: String(name || 'Folder').trim().slice(0, 60) || 'Folder', order: folders().length + 1, by: S.uid || '', access: S.mode === 'local' ? 'all' : opts.access, people: opts.people });
    const priv = S.mode === 'artifact' && f.access === 'me';
    if (f.access !== 'all' && !S.uid) throw new Error('Sharing needs to know who you are: sign in to claude.ai, or open the page from the server');
    await backend.putFolder(f, priv); (priv ? S.pfolders : S.folders).set(f.id, f); emit(); return f;
  }
  async function renameFolder(id, name) { must(); const f = anyFolder(id); if (!f || !seesFolder(f)) return; const next = { ...f, name: String(name || f.name).trim().slice(0, 60) || f.name }; const priv = S.pfolders.has(id); await backend.putFolder(next, priv); (priv ? S.pfolders : S.folders).set(id, next); emit(); }
  // Change who sees a folder. Going "Only me" needs every project in it to be yours (nobody else's work disappears
  // from under them); in claude.ai the folder and its projects then move to your private part, and back again.
  async function setSharing(id, { access, people } = {}) {
    must(); const f = anyFolder(id); if (!f || !seesFolder(f)) throw new Error('No such folder');
    if (!canShare(f)) throw new Error('Only whoever made this folder can change who sees it');
    access = ACCESS.includes(access) ? access : 'all';
    if (access !== 'all' && !S.uid) throw new Error('Sharing needs to know who you are: sign in to claude.ai, or open the page from the server');
    const inside = allProjects().filter(p => p.folder === id);
    if (access === 'me') {
      if (f.by !== S.uid) throw new Error('Only the person who made this folder can make it “Only me”');
      const others = inside.filter(p => p.by && p.by !== S.uid);
      if (others.length) throw new Error(`${others.length === 1 ? 'One project' : others.length + ' projects'} in this folder ${others.length === 1 ? 'was' : 'were'} made by someone else. Move ${others.length === 1 ? 'it' : 'them'} out first, or share the folder with specific people.`);
    }
    const next = cleanFolder({ ...f, access, people: access === 'people' ? cleanPeople(people).filter(x => x !== f.by) : [] });
    const wasPriv = S.pfolders.has(id); const toPriv = S.mode === 'artifact' && access === 'me';
    if (wasPriv === toPriv) { await backend.putFolder(next, wasPriv); (wasPriv ? S.pfolders : S.folders).set(id, next); emit(); return next; }
    await backend.putFolder(next, toPriv); (toPriv ? S.pfolders : S.folders).set(id, next);
    for (const p of inside) await relocate(p.id, { ...p }, toPriv);
    await backend.delFolder(id, wasPriv); (wasPriv ? S.pfolders : S.folders).delete(id); emit(); return next;
  }
  // A folder that is not everyone's goes only once it is empty: its projects would otherwise land in Unfiled, which
  // everyone sees.
  async function removeFolder(id) {
    must(); const f = anyFolder(id); if (!f || !seesFolder(f)) return;
    if (!(S.owner || isAdmin() || f.by === S.uid || S.mode === 'local')) throw new Error('Only whoever made this folder (or an admin) can remove it');
    const inside = allProjects().filter(p => p.folder === id);
    if (f.access !== 'all' && inside.length) throw new Error(`This folder still holds ${inside.length} project${inside.length === 1 ? '' : 's'}${inside.some(p => p.archived) ? ' (archived ones included)' : ''}. Move or remove them first, so they do not become visible to everyone.`);
    for (const p of inside) if (!p.archived) await update(p.id, { folder: '' });
    const priv = S.pfolders.has(id); await backend.delFolder(id, priv); (priv ? S.pfolders : S.folders).delete(id); emit();
  }
  function setCurrent(id) { S.current = id; LS.set('lg.project', id); emit(); }
  const archived = () => allProjects().filter(p => p.archived && sees(p)).sort((a, b) => b.updated - a.updated);
  // Where a project's canvas lives in claude.ai's database, and the live room it uses (none for a private one).
  function baseOf(id) { return id === '_root' ? '' : isPriv(id) ? `private/${S.uid}/projects/${id}/` : `projects/${id}/`; }
  function roomOf(id) { return id === '_root' || isPriv(id) ? null : ('p-' + String(id).toLowerCase().replace(/[^a-z0-9_.-]/g, '-')).slice(0, 48); }
  // A link that opens a project: the room link on a server; in claude.ai the page's address plus #project=<id>
  // (only the address part when the owner has not set it: then the code alone, pasted into Home's “Open a link”).
  function linkFor(id) {
    if (S.mode === 'server') { const u = new URL(location.href); u.hash = ''; u.search = ''; u.searchParams.set('room', id); return u.toString(); }
    if (S.mode === 'artifact') return (S.pageLink || '') + '#project=' + id;
    return null;
  }
  function idFromLink(text) {
    const t = String(text || '').trim(); const m = /[#?&](?:project|room)=([A-Za-z0-9_.:-]{1,64})/.exec(t);
    if (m) return m[1]; return ID.test(t) ? t : null;
  }
  async function setPageLink(link) {
    if (S.mode !== 'artifact' || !S.owner) throw new Error('Only the page’s owner sets its link');
    link = String(link || '').trim().replace(/#.*$/, ''); if (link && !/^https:\/\/[^\s#]+$/.test(link)) throw new Error('That is not a page link (https://…)');
    const db = await window.claude.use('db'); await db.doc('config/page').set({ link }); S.pageLink = link; emit();
  }
  const searchPeople = q => backend && backend.people ? backend.people.search(q) : Promise.resolve([]);
  const names = ids => backend && backend.people ? backend.people.names([...new Set(ids)].filter(Boolean)) : Promise.resolve({});
  return {
    init, start, whenReady, projects, folders, get, create, update, touch, remove, restore, archived, createFolder, renameFolder, removeFolder, setSharing, setCurrent, canChange, canShare,
    sharedWithMe, accessOf, folderAccess: id => { const f = anyFolder(id); return f ? f.access : 'all'; }, folder: id => { const f = anyFolder(id); return f && seesFolder(f) ? f : null; },
    baseOf, roomOf, isPrivate: isPriv, linkFor, idFromLink, setPageLink, searchPeople, names,
    refresh: () => backend && backend.refresh ? backend.refresh() : null,
    on: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    get mode() { return S.mode; }, get ready() { return S.ready; }, get current() { return S.current; }, get me() { return S.uid; },
    get trusted() { return S.trusted; }, get owner() { return S.owner; }, get pageLink() { return S.pageLink; }, get moving() { return moving; },
  };
})();
