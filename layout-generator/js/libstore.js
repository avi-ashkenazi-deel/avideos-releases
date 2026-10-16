/* Shared libraries: named sets of approved pieces (Brand, Product design, Sales…) that live outside any one canvas,
   so everyone sees the same set. Admins (a named list the page owner keeps) create libraries and curate their items;
   everyone else browses them and turns each library on or off for themselves, like enabling a library in Figma.
   Libraries an admin marks "on by default" start on for everyone; a person's own choice wins after that.
   Three homes, picked at start:
   - claude.ai artifact: the page's shared database (collections libraries and libitems, the admin list in
     config/admins), pictures in the page's shared assets. The page's database rules let only Editors write
     libraries; the admin list picks which of them curate. Each person's on/off choices are private to them.
   - self-hosted server: /api/libraries, saved to server/data/libraries.json and pushed to every open tab; when the
     server sets LG_ADMIN_KEY, editing needs that key.
   - neither: this browser's storage; libraries move between people as JSON (Export / Import).
   Brand guidelines (design.md, layout.md, animation.md, illustration.md, photography.md, content.md, product.md) live in the same
   three homes (the guides collection, the server's file, this browser), readable by everyone, written by admins. */
const LibStore = (() => {
  const LS = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } } };
  const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
  const MAX_ITEM = 240 * 1024;
  let env = null, backend = null, started = null;
  const S = { mode: 'local', libs: new Map(), items: new Map(), guides: new Map(), notes: new Map(), iconsets: new Map(), canWrite: null, admins: [], uid: null, owner: false, canEdit: null, keyRequired: false, keyOk: false, ready: false, error: '' };
  let prefs = LS.get('lg.libsOn', {}) || {};
  const listeners = new Set();
  const emit = () => { for (const fn of listeners) { try { fn(); } catch (e) { console.error(e); } } };
  const uid = p => p + Math.random().toString(36).slice(2, 10);
  const clone = v => JSON.parse(JSON.stringify(v));

  // ---- incoming data --------------------------------------------------------------------------------------------------
  function cleanLib(l) {
    if (!l || typeof l !== 'object' || !ID.test(String(l.id || ''))) return null;
    return { id: String(l.id), name: String(l.name || 'Library').slice(0, 60), description: String(l.description || '').slice(0, 200), order: Number.isFinite(+l.order) ? +l.order : 0, defaultOn: l.defaultOn !== false, updated: +l.updated || 0, by: typeof l.by === 'string' ? l.by.slice(0, 80) : '' };
  }
  function cleanItem(it) {
    if (!it || typeof it !== 'object' || !ID.test(String(it.id || '')) || !ID.test(String(it.lib || '')) || !Array.isArray(it.blocks)) return null;
    const out = { ...it, id: String(it.id), lib: String(it.lib), name: String(it.name || 'Component').slice(0, 60), category: String(it.category || 'components').slice(0, 24), approved: !!it.approved, w: Math.max(1, +it.w || 100), h: Math.max(1, +it.h || 100), v: +it.v || 1 };
    if (it.assets && typeof it.assets === 'object') { out.assets = {}; for (const [k, a] of Object.entries(it.assets)) if (/^a_[0-9a-f]{16}$/.test(k) && a && (typeof a.url === 'string' || typeof a.dataUrl === 'string')) out.assets[k] = { url: typeof a.url === 'string' ? a.url : undefined, dataUrl: typeof a.dataUrl === 'string' && /^data:image\//.test(a.dataUrl) ? a.dataUrl : undefined, name: String(a.name || '').slice(0, 80), w: +a.w || 0, h: +a.h || 0 }; }
    return out;
  }
  const GUIDE = /^(?:[a-z0-9_-]{1,40}\.)?(design|layout|animation|illustration|photography|content|product)$/;
  // each brand kit has its own guides: Deel's under the plain names, any other kit's as <kit>.<name>
  const guideKey = (kit, name) => !kit || kit === 'deel' ? name : `${String(kit).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'custom'}.${name}`;
  const cleanGuide = g => g && typeof g === 'object' && GUIDE.test(String(g.id || '')) ? { id: g.id, text: String(g.text || '').slice(0, 120000), updated: +g.updated || 0, by: typeof g.by === 'string' ? g.by.slice(0, 80) : '' } : null;
  // Suggestions and comments on a guide, from people who are not admins; admins accept, decline or resolve them.
  const NOTE_STATUS = /^(open|accepted|declined|resolved|withdrawn)$/;
  const str = (v, n) => typeof v === 'string' ? v.slice(0, n) : '';
  const cleanNote = (n, doc) => n && typeof n === 'object' && ID.test(String(n.id || '')) && GUIDE.test(String(n.guide || '')) ? { id: n.id, guide: n.guide, kind: n.kind === 'edit' ? 'edit' : 'comment', by: str(n.by, 80), byName: str(n.byName, 80), at: +n.at || 0, quote: str(n.quote, 8000), replacement: n.kind === 'edit' ? str(n.replacement, 8000) : '', text: str(n.text, 2000), status: NOTE_STATUS.test(n.status) ? n.status : 'open', reply: str(n.reply, 1000), doneBy: str(n.doneBy, 80), doneAt: +n.doneAt || 0, _doc: doc || n._doc || '' } : null;
  function setNotes(list) { S.notes.clear(); for (const n of list || []) { const c = cleanNote(n); if (c) S.notes.set(c.id, c); } emit(); }
  // Icon sets (a design system's icons, imported once and shared): stored in parts under 200 KB, "<id>" then "<id>~2"…
  const SETID = /^[a-z0-9_-]{1,24}$/;
  function setIconSets(list) {
    const merged = new Map();
    for (const d of list || []) {
      if (!d || typeof d !== 'object') continue; const id = String(d.set || d.id || '').split('~')[0]; if (!SETID.test(id) || !d.icons || typeof d.icons !== 'object') continue;
      const cur = merged.get(id) || { id, name: '', viewBox: '0 0 24 24', icons: {}, meta: {}, source: '', updated: 0, by: '' };
      Object.assign(cur.icons, d.icons); if (d.meta && typeof d.meta === 'object') Object.assign(cur.meta, d.meta);
      if (!String(d.id || '').includes('~')) { cur.name = String(d.name || id).slice(0, 40); cur.viewBox = String(d.viewBox || '0 0 24 24'); cur.source = String(d.source || '').slice(0, 200); cur.updated = +d.updated || 0; cur.by = typeof d.by === 'string' ? d.by.slice(0, 80) : ''; cur.order = +d.order || 0; }
      merged.set(id, cur);
    }
    for (const id of S.iconsets.keys()) if (!merged.has(id) && typeof Icons !== 'undefined') Icons.removeSet(id);
    S.iconsets = merged; if (typeof Icons !== 'undefined') for (const st of merged.values()) Icons.addSet(st);
    emit();
  }
  // A set as documents: the first holds the name and the first icons, the rest only icons.
  function iconSetParts(st) {
    const parts = []; let cur = null, size = 0;
    for (const [k, v] of Object.entries(st.icons)) {
      const n = JSON.stringify(v).length + k.length + JSON.stringify((st.meta || {})[k] || '').length + 8;
      if (!cur || size + n > 190000) { cur = { id: parts.length ? `${st.id}~${parts.length + 1}` : st.id, set: st.id, icons: {}, meta: {} }; parts.push(cur); size = 0; }
      cur.icons[k] = v; if (st.meta && st.meta[k]) cur.meta[k] = st.meta[k]; size += n;
    }
    if (!parts.length) parts.push({ id: st.id, set: st.id, icons: {}, meta: {} });
    Object.assign(parts[0], { name: st.name, viewBox: st.viewBox, source: st.source || '', updated: Date.now(), by: S.uid || '', order: st.order || 0, parts: parts.length });
    return parts;
  }
  function setGuides(list) { S.guides.clear(); for (const g of list || []) { const c = cleanGuide(g); if (c) S.guides.set(c.id, c); } emit(); }
  function setAll({ libraries, items, admins }) {
    if (libraries) { S.libs.clear(); for (const l of libraries) { const c = cleanLib(l); if (c) S.libs.set(c.id, c); } }
    if (items) { S.items.clear(); for (const it of items) { const c = cleanItem(it); if (c) S.items.set(c.id, c); } }
    if (admins) S.admins = admins.filter(x => typeof x === 'string').slice(0, 100);
    S.ready = true; loadAssets(); emit();
  }
  function upsert(kind, list, removed = []) {
    const map = kind === 'lib' ? S.libs : S.items; const clean = kind === 'lib' ? cleanLib : cleanItem;
    for (const x of list) { const c = clean(x); if (c) map.set(c.id, c); }
    for (const id of removed) map.delete(id);
    S.ready = true; if (kind === 'item') loadAssets(); emit();
  }
  // Pictures inside shared items: each viewer loads them once, under the shared id the blocks use.
  const loaded = new Set();
  function loadAssets() {
    if (!env || !env.ensureImage) return;
    for (const it of S.items.values()) for (const [id, a] of Object.entries(it.assets || {})) {
      if (loaded.has(id)) continue; loaded.add(id);
      Promise.resolve(env.ensureImage({ id, url: a.url, dataUrl: a.dataUrl, name: a.name || it.name })).catch(() => loaded.delete(id));
    }
  }
  function assetInfo(id) { for (const it of S.items.values()) { const a = it.assets && it.assets[id]; if (a && a.url) return { id, ...a }; } return null; }

  // ---- backends -------------------------------------------------------------------------------------------------------
  async function artifactBackend() {
    if (!(window.claude && typeof window.claude.use === 'function')) return null;
    const [db, user, assets] = await Promise.all(['db', 'user', 'assets'].map(n => window.claude.use(n).catch(() => null)));
    if (!db) return null;
    try { S.uid = user && user.id ? await user.id() : null; } catch { S.uid = null; }
    try { S.owner = !!(user && await user.isOwner()); } catch { S.owner = false; }
    try { S.canEdit = user && user.canEdit ? await user.canEdit() : null; } catch { S.canEdit = null; }
    const denied = e => e && (e.code === 'invalid_argument' || e.code === 'not_granted' || e.code === 'permission_denied');
    const why = e => denied(e) ? new Error(S.owner ? 'The page refused the change. Republish it with its library rules, then try again.' : 'Only library admins with Editor access to this page can change shared libraries. Ask the page owner to add you as an admin and give you Editor in Share.') : (e instanceof Error ? e : new Error((e && e.message) || String(e)));
    const write = async fn => { try { return await fn(); } catch (e) { throw why(e); } };
    const ready = { libs: false, items: false };
    const done = () => { if (ready.libs && ready.items && !S.ready) { S.ready = true; loadAssets(); emit(); } };
    db.collection('libraries').onSnapshot(snap => {
      const list = []; for (const d of snap.docs) { const v = d.data(); if (v) list.push({ ...v, id: d.id }); }
      if (!ready.libs && snap.metadata && snap.metadata.fromCache && !snap.size) return;
      ready.libs = true; S.libs.clear(); upsert('lib', list); done();
    }, e => { S.error = (e && e.code) || 'db'; emit(); });
    db.collection('libitems').onSnapshot(snap => {
      const list = []; for (const d of snap.docs) { const v = d.data(); if (v) list.push({ ...v, id: d.id }); }
      if (!ready.items && snap.metadata && snap.metadata.fromCache && !snap.size) return;
      ready.items = true; S.items.clear(); upsert('item', list); done();
    }, e => { S.error = (e && e.code) || 'db'; emit(); });
    db.collection('iconsets').onSnapshot(snap => { const list = []; S.iconParts = new Map(); for (const d of snap.docs) { const v = d.data(); if (v) { list.push({ ...v, id: d.id }); S.iconParts.set(d.id, String(v.set || d.id).split('~')[0]); } } setIconSets(list); }, () => { });
    db.collection('guides').onSnapshot(snap => { const list = []; for (const d of snap.docs) { const v = d.data(); if (v) list.push({ ...v, id: d.id }); } setGuides(list); }, () => { });
    // one document per person (guidenotes/<their id>): each writes only their own, admins write all to resolve
    db.collection('guidenotes').onSnapshot(snap => { const list = []; for (const d of snap.docs) { const v = d.data(); if (v && Array.isArray(v.notes)) for (const n of v.notes) list.push({ ...n, _doc: d.id }); } setNotes(list); }, () => { });
    try { S.canWrite = user && user.can ? await user.can('data.write') : null; } catch { S.canWrite = null; }
    db.doc('config/admins').onSnapshot(s => { const d = s.data(); S.admins = d && Array.isArray(d.ids) ? d.ids.filter(x => typeof x === 'string') : []; emit(); }, () => { });
    // Each person's on/off choices: private to them, so they follow them across devices.
    if (S.uid) {
      const ref = db.doc(`data/users/${S.uid}/prefs`);
      ref.onSnapshot(s => { const d = s.data(); if (d && d.libsOn && typeof d.libsOn === 'object') { prefs = { ...d.libsOn }; LS.set('lg.libsOn', prefs); emit(); } }, () => { });
      backend_savePrefs = p => ref.set({ libsOn: p }).catch(() => { });
    }
    return {
      kind: 'artifact',
      putLib: lib => write(() => db.doc(`libraries/${lib.id}`).set(lib)),
      delLib: id => write(() => db.doc(`libraries/${id}`).delete()),
      putItem: it => write(() => db.doc(`libitems/${it.id}`).set(it)),
      delItem: id => write(() => db.doc(`libitems/${id}`).delete()),
      setAdmins: ids => write(() => db.doc('config/admins').set({ ids })),
      putGuide: g => write(() => db.doc(`guides/${g.id}`).set(g)),
      putIconSet: async st => { const parts = iconSetParts(st); const old = [...(S.iconParts || new Map()).entries()].filter(([, s]) => s === st.id).map(([k]) => k); await write(async () => { for (const p of parts) await db.doc(`iconsets/${p.id}`).set(p); for (const k of old) if (!parts.some(p => p.id === k)) await db.doc(`iconsets/${k}`).delete(); }); },
      delIconSet: async id => write(async () => { for (const k of [...(S.iconParts || new Map()).entries()].filter(([, s]) => s === id).map(([k]) => k)) await db.doc(`iconsets/${k}`).delete(); }),
      putNote: n => { const doc = n._doc || S.uid; if (!doc) throw new Error('Sign in to claude.ai to suggest changes'); const mine = [...S.notes.values()].filter(x => x._doc === doc && x.id !== n.id).concat([{ ...n, _doc: doc }]).map(({ _doc, ...x }) => x).slice(-200); return db.doc(`guidenotes/${doc}`).set({ notes: mine }).catch(e => { throw denied(e) ? new Error('You can view these guidelines but not suggest changes. Ask the page owner for Contributor access, or use Comment.') : e; }); },
      uploadImage: assets ? async blob => { const r = await assets.upload(blob); return { url: r.url }; } : null,
      profiles: user && user.profiles ? ids => user.profiles(ids) : null,
      search: user && user.search ? q => user.search(q) : null,
    };
  }
  let backend_savePrefs = null;
  async function serverBackend() {
    if (window.claude || !/^https?:$/.test(location.protocol)) return null;
    let j; try { const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 1500); const r = await fetch('/api/libraries', { cache: 'no-store', signal: ctl.signal }); clearTimeout(t); if (!r.ok) return null; j = await r.json(); } catch { return null; }
    if (!j || !j.lgLibraries) return null;
    S.keyRequired = !!j.keyRequired;
    const key = () => LS.get('lg.adminKey', '') || '';
    const apply = j => { S.keyRequired = !!j.keyRequired; setAll({ libraries: j.libraries || [], items: j.items || [] }); if (j.guides) setGuides(j.guides); if (j.notes) setNotes(j.notes); if (j.iconsets) setIconSets(j.iconsets); };
    apply(j);
    async function op(body) {
      const r = await fetch('/api/libraries', { method: 'POST', headers: { 'content-type': 'application/json', 'x-lg-admin': key() }, body: JSON.stringify(body) });
      if (r.status === 401) { S.keyOk = false; emit(); throw new Error('This server needs the library admin key to change libraries. Enter it under Libraries → Admins.'); }
      if (!r.ok) throw new Error((await r.text()).slice(0, 200) || 'The server refused that change');
      const out = await r.json(); if (out && out.lgLibraries) apply(out); return out;
    }
    if (S.keyRequired && key()) op({ op: 'check' }).then(() => { S.keyOk = true; emit(); }).catch(() => { });
    return {
      kind: 'server',
      refresh: (() => { let t = 0; return () => { clearTimeout(t); t = setTimeout(async () => { try { const r = await fetch('/api/libraries', { cache: 'no-store' }); if (r.ok) apply(await r.json()); } catch { } }, 250); }; })(),
      checkKey: async k => { LS.set('lg.adminKey', k); await op({ op: 'check' }); S.keyOk = true; emit(); },
      putLib: lib => op({ op: 'putLib', lib }),
      delLib: id => op({ op: 'delLib', id }),
      putItem: item => op({ op: 'putItem', item }),
      delItem: id => op({ op: 'delItem', id }),
      putGuide: guide => op({ op: 'putGuide', guide }),
      putIconSet: async st => { for (const part of iconSetParts(st)) await op({ op: 'putIconSet', part }); },
      delIconSet: id => op({ op: 'delIconSet', id }),
      putNote: note => op({ op: 'putNote', note }),
      uploadImage: async (blob, name) => { const r = await fetch('/api/assets?room=library', { method: 'POST', headers: { 'content-type': blob.type || 'image/png', 'x-name': encodeURIComponent(name || '') }, body: blob }); if (!r.ok) throw new Error('Image upload failed (' + r.status + ')'); const o = await r.json(); return { url: o.url }; },
    };
  }
  function localBackend() {
    const KEY = 'lg.libs.v1';
    const load = () => { const j = LS.get(KEY, null) || {}; setAll({ libraries: j.libraries || [], items: j.items || [] }); setGuides(LS.get('lg.guides.v1', []) || []); setNotes(LS.get('lg.guidenotes.v1', []) || []); setIconSets(LS.get('lg.iconsets.v1', []) || []); };
    const save = () => { if (!LS.set(KEY, { libraries: [...S.libs.values()], items: [...S.items.values()] })) throw new Error('This browser\'s storage is full. Export the libraries, remove some pictures, and try again.'); };
    load();
    window.addEventListener('storage', e => { if (e.key === KEY) load(); });
    const change = fn => { fn(); save(); emit(); };
    return {
      kind: 'local',
      putLib: lib => change(() => S.libs.set(lib.id, cleanLib(lib))),
      delLib: id => change(() => S.libs.delete(id)),
      putItem: it => change(() => S.items.set(it.id, cleanItem(it))),
      delItem: id => change(() => S.items.delete(id)),
      putNote: n => { S.notes.set(n.id, cleanNote(n)); LS.set('lg.guidenotes.v1', [...S.notes.values()]); emit(); },
      putGuide: g => { S.guides.set(g.id, g); if (!LS.set('lg.guides.v1', [...S.guides.values()])) throw new Error('This browser\'s storage is full.'); emit(); },
      putIconSet: st => { const all = [...S.iconsets.values()].filter(x => x.id !== st.id).concat([{ ...st, updated: Date.now() }]); if (!LS.set('lg.iconsets.v1', all)) throw new Error('This browser\'s storage is full.'); setIconSets(all); },
      delIconSet: id => { const all = [...S.iconsets.values()].filter(x => x.id !== id); LS.set('lg.iconsets.v1', all); setIconSets(all); },
      uploadImage: null, // pictures ride inside the item as data URLs
    };
  }

  // ---- public ---------------------------------------------------------------------------------------------------------
  function init(e) { env = e; }
  function start() {
    if (started) return started;
    started = (async () => {
      backend = (await artifactBackend()) || (await serverBackend()) || localBackend();
      S.mode = backend.kind; emit(); return S.mode;
    })();
    return started;
  }
  const libraries = () => [...S.libs.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  const items = libId => [...S.items.values()].filter(it => !libId || it.lib === libId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.created || 0) - (b.created || 0));
  function isOn(libId, defaultOn = true) { if (Object.prototype.hasOwnProperty.call(prefs, libId)) return !!prefs[libId]; const l = S.libs.get(libId); return l ? l.defaultOn !== false : defaultOn; }
  function setOn(libId, on) { prefs = { ...prefs, [libId]: !!on }; LS.set('lg.libsOn', prefs); if (backend_savePrefs) backend_savePrefs(prefs); emit(); }
  // Who may change shared libraries here.
  function role() {
    if (S.mode === 'artifact') {
      const listed = !!S.uid && S.admins.includes(S.uid);
      const admin = S.owner || (listed && S.canEdit !== false);
      return { admin, owner: S.owner, listed, needsEditor: listed && S.canEdit === false, mode: S.mode };
    }
    if (S.mode === 'server') return { admin: !S.keyRequired || S.keyOk, owner: false, listed: false, needsKey: S.keyRequired && !S.keyOk, mode: S.mode };
    return { admin: true, owner: true, listed: false, mode: S.mode };
  }
  const must = () => { if (!backend) throw new Error('Libraries are still loading'); if (!role().admin) throw new Error(role().needsEditor ? 'You are on the admin list, but this page gives you no Editor access yet. Ask the owner to make you an Editor in Share.' : 'Only library admins can change shared libraries.'); };
  async function createLibrary({ name, description = '', defaultOn = true }) {
    must(); const libs = libraries();
    const lib = { id: uid('l'), name: String(name || 'New library').trim().slice(0, 60) || 'New library', description: String(description).slice(0, 200), order: libs.length ? Math.max(...libs.map(l => l.order)) + 1 : 1, defaultOn: !!defaultOn, updated: Date.now(), by: S.uid || '' };
    await backend.putLib(lib); S.libs.set(lib.id, lib); emit(); return lib;
  }
  async function updateLibrary(id, patch) { must(); const cur = S.libs.get(id); if (!cur) throw new Error('No such library'); const lib = cleanLib({ ...cur, ...patch, id, updated: Date.now() }); await backend.putLib(lib); S.libs.set(id, lib); emit(); return lib; }
  async function deleteLibrary(id) { must(); for (const it of items(id)) await backend.delItem(it.id); await backend.delLib(id); S.libs.delete(id); for (const it of items(id)) S.items.delete(it.id); emit(); }
  // Pictures in an item become shared ones (uploaded once, keyed by content) before the item is saved.
  async function sha16(text) { const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text)); return [...new Uint8Array(buf)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join(''); }
  async function shareImages(item) {
    const imgs = env.getAssets().images; item.assets = { ...(item.assets || {}) };
    for (const b of item.blocks) {
      if (b.kind !== 'image' || !b.asset) continue;
      if (item.assets[b.asset]) continue;
      const known = assetInfo(b.asset); if (known) { item.assets[b.asset] = { url: known.url, name: known.name, w: known.w, h: known.h }; continue; }
      const a = imgs.find(x => x.id === b.asset); if (!a || !a.dataUrl) continue;
      const gid = /^a_[0-9a-f]{16}$/.test(b.asset) ? b.asset : 'a_' + await sha16(a.dataUrl);
      if (!item.assets[gid]) {
        if (backend.uploadImage) { if (!/^data:/.test(a.dataUrl)) item.assets[gid] = { url: a.dataUrl, name: a.name, w: a.w, h: a.h }; else { const up = await backend.uploadImage(env.dataUrlToBlob(a.dataUrl), a.name); item.assets[gid] = { url: up.url, name: String(a.name || '').slice(0, 80), w: a.w || 0, h: a.h || 0 }; } }
        else item.assets[gid] = { dataUrl: a.dataUrl, name: String(a.name || '').slice(0, 80), w: a.w || 0, h: a.h || 0 };
      }
      if (gid !== b.asset) { if (!imgs.some(x => x.id === gid)) imgs.push({ ...a, id: gid }); b.asset = gid; }
      loaded.add(gid);
    }
    if (!Object.keys(item.assets).length) delete item.assets;
    return item;
  }
  async function putItem(item, { images = true } = {}) {
    must(); if (!S.libs.has(item.lib)) throw new Error('Pick a library first');
    const it = clone({ ...item, id: item.id && ID.test(item.id) ? item.id : uid('i'), updated: Date.now(), v: (item.v || 0) + 1, by: S.uid || item.by || '' });
    if (images) await shareImages(it);
    const size = JSON.stringify(it).length; if (size > MAX_ITEM && backend.kind !== 'local') throw new Error(`“${it.name}” is ${Math.round(size / 1024)} KB, over the ${Math.round(MAX_ITEM / 1024)} KB a shared item can hold. Simplify its vectors or use a picture instead.`);
    await backend.putItem(it); S.items.set(it.id, cleanItem(it)); emit(); return it;
  }
  async function updateItem(id, patch) { const cur = S.items.get(id); if (!cur) throw new Error('No such item'); return putItem({ ...cur, ...patch, id }, { images: !!patch.blocks }); }
  async function deleteItem(id) { must(); await backend.delItem(id); S.items.delete(id); emit(); }
  async function setAdmins(ids) { if (S.mode !== 'artifact' || !backend.setAdmins) throw new Error('Admins are kept by the page owner in claude.ai'); if (!S.owner) throw new Error('Only the page owner changes the admin list'); const list = [...new Set(ids.filter(x => typeof x === 'string'))].slice(0, 100); await backend.setAdmins(list); S.admins = list; emit(); }
  // Libraries as JSON, with pictures inside, for moving them between homes (or backing them up).
  function exportJSON(libIds) {
    const libs = libraries().filter(l => !libIds || libIds.includes(l.id)); const ids = new Set(libs.map(l => l.id));
    return { lgLibrary: { v: 2, libraries: libs, items: [...S.items.values()].filter(it => ids.has(it.lib)) } };
  }
  async function importJSON(j, { into } = {}) {
    must(); const L = j && j.lgLibrary; if (!L) throw new Error('not a library file');
    const libs = Array.isArray(L.libraries) ? L.libraries : []; const list = Array.isArray(L.items) ? L.items : [];
    const map = new Map(); let nl = 0, ni = 0;
    for (const l of libs) { const c = cleanLib(l); if (!c) continue; if (into) { map.set(c.id, into); continue; } const ex = libraries().find(x => x.name.toLowerCase() === c.name.toLowerCase()); if (ex) map.set(c.id, ex.id); else { const made = await createLibrary(c); map.set(c.id, made.id); nl++; } }
    for (const it of list.slice(0, 500)) {
      const lib = map.get(it.lib) || into; if (!lib) continue;
      const c = cleanItem({ ...it, lib }); if (!c) continue;
      // pictures that came as data URLs become this home's own shared pictures
      if (c.assets) for (const [id, a] of Object.entries(c.assets)) if (a.dataUrl && !env.getAssets().images.some(x => x.id === id)) await env.ensureImage({ id, dataUrl: a.dataUrl, name: a.name });
      const fresh = S.items.has(c.id) && S.items.get(c.id).lib === lib ? c : { ...c, id: uid('i') };
      if (fresh.assets) for (const k of Object.keys(fresh.assets)) if (fresh.assets[k].dataUrl && backend.uploadImage) delete fresh.assets[k];
      await putItem(fresh); ni++;
    }
    return { libraries: nl, items: ni };
  }
  // Brand guidelines: everyone reads them (Claude gets them in its prompts); admins write them.
  const iconSets = () => [...S.iconsets.values()].sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name));
  async function putIconSet(st) {
    if (!backend) throw new Error('Still loading'); if (!role().admin) throw new Error('Only library admins can add shared icon sets');
    if (!SETID.test(String(st.id || '')) || !st.icons || !Object.keys(st.icons).length) throw new Error('No icons to add');
    await backend.putIconSet({ id: st.id, name: String(st.name || st.id).slice(0, 40), viewBox: st.viewBox || '0 0 24 24', icons: st.icons, meta: st.meta || {}, source: st.source || '', order: st.order || 0 });
    if (backend.kind !== 'local') { const merged = new Map(S.iconsets); merged.set(st.id, { ...st, updated: Date.now() }); setIconSets([...merged.values()]); }
  }
  async function delIconSet(id) { if (!backend) throw new Error('Still loading'); if (!role().admin) throw new Error('Only library admins can remove shared icon sets'); await backend.delIconSet(id); if (backend.kind !== 'local') { const m = new Map(S.iconsets); m.delete(id); setIconSets([...m.values()]); } }
  const guide = id => (S.guides.get(id) || {}).text || '';
  const guides = () => Object.fromEntries([...S.guides.values()].map(g => [g.id, g]));
  async function putGuide(id, text) {
    if (!GUIDE.test(id)) throw new Error('Unknown guide'); if (!backend) throw new Error('Still loading'); if (!role().admin) throw new Error('Only admins can change the brand guidelines: use Suggest edits or Comment instead.'); if (!backend.putGuide) throw new Error('Guides cannot be saved here');
    const g = cleanGuide({ id, text, updated: Date.now(), by: S.uid || '' }); await backend.putGuide(g); S.guides.set(id, g); emit(); return g;
  }
  const notes = id => [...S.notes.values()].filter(n => !id || n.guide === id).sort((a, b) => a.at - b.at);
  // who may suggest: anyone who can write shared data here (Contributors and up in claude.ai; everyone on a server or locally)
  const canSuggest = () => S.mode !== 'artifact' || (!!S.uid && S.canWrite !== false);
  async function addNote(n) {
    if (!backend || !backend.putNote) throw new Error('Suggestions cannot be saved here'); if (!canSuggest()) throw new Error('You can view these guidelines but not suggest changes here.');
    const c = cleanNote({ ...n, id: uid('n'), by: S.uid || n.by || '', at: Date.now(), status: 'open' }); await backend.putNote(c); S.notes.set(c.id, { ...c, _doc: c._doc || S.uid || '' }); emit(); return c;
  }
  // an admin resolves (accepted, declined, resolved); the author may withdraw their own
  async function setNote(id, patch) {
    const cur = S.notes.get(id); if (!cur) throw new Error('That suggestion is gone');
    if (patch.status !== 'withdrawn' && !role().admin) throw new Error('Only admins can accept, decline or resolve suggestions.'); const c = cleanNote({ ...cur, ...patch, doneBy: S.uid || '', doneAt: Date.now() }, cur._doc); await backend.putNote(c); S.notes.set(id, c); emit(); return c;
  }
  async function people(ids) { if (!backend || !backend.profiles || !ids.length) return {}; try { return await backend.profiles(ids); } catch { return {}; } }
  async function searchPeople(q) { if (!backend || !backend.search) return []; try { return await backend.search(q); } catch { return []; } }
  return {
    init, start, libraries, items, isOn, setOn, role, createLibrary, updateLibrary, deleteLibrary, putItem, updateItem, deleteItem, setAdmins,
    exportJSON, importJSON, people, searchPeople, assetInfo, iconSets, putIconSet, delIconSet, guide, guides, putGuide, notes, addNote, setNote, canSuggest, guideKey, GUIDES: ['design', 'layout', 'animation', 'illustration', 'photography', 'content', 'product'],
    refresh: () => backend && backend.refresh ? backend.refresh() : null,
    checkKey: k => backend && backend.checkKey ? backend.checkKey(k) : Promise.reject(new Error('No admin key here')),
    on: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    get mode() { return S.mode; }, get ready() { return S.ready; }, get admins() { return S.admins.slice(); }, get me() { return S.uid; }, get error() { return S.error; },
    _state: S,
  };
})();
