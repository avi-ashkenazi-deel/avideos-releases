/* Multiplayer. The canvas document is split into records — the canvas name, one per frame, one per block, one per
   stored original (Looks) and one per shared image — each stamped with a version and its writer. Changes travel as
   records; the newest version of a record wins (last-writer-wins per block, so two people editing different blocks
   of one frame never overwrite each other). Undo is per person: it reverts only records you changed last.
   Two transports carry the same records: the claude.ai artifact (live room for cursors and fast edits, shared
   database for persistence, shared assets for images) and a self-hosted server (WebSocket rooms, saved to disk). */
const Sync = (() => {
  const LS = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } } };
  const COLORS = ['#7C5CFF', '#FF6B4A', '#16B88A', '#E8A400', '#2F8CFF', '#E0489E', '#00A6B5', '#8E6CF0'];
  const hashStr = s => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
  const me = { id: LS.get('lg.clientId', null) || ('c' + Math.random().toString(36).slice(2, 10)), name: LS.get('lg.name', ''), color: null };
  LS.set('lg.clientId', me.id); me.color = COLORS[hashStr(me.id) % COLORS.length];
  let ui = null, env = null, adapter = null, applying = false, clock = 0;
  const recs = new Map();    // key -> latest record known here (with _k, _v, _by, maybe _del)
  const synced = new Map();  // key -> canonical JSON of the shared value (what the local doc matched last time)
  let peers = []; const listeners = [];
  const status = { mode: 'local', connected: false, readOnly: false, room: null, label: '' };
  const now = () => { clock = Math.max(clock + 1, Date.now() * 1000); return clock; };
  const notify = () => listeners.forEach(fn => { try { fn(status, peers); } catch (e) { console.error(e); } });

  // ---- document <-> records ----------------------------------------------------------------------------------------
  const FRAME_KEYS = ['id', 'name', 'x', 'y', 'autoLayout', 'clip', 'hidden', 'locked', 'showGrid'];
  function toRecords(doc) {
    const out = new Map();
    out.set('meta', { name: doc.name || 'Untitled canvas' });
    for (const it of doc.library || []) if (it && it.id) out.set('L~' + it.id, it);
    doc.frames.forEach((f, i) => {
      const { blocks, meta, ...layoutRest } = f.layout; const { original, ...metaRest } = meta || {};
      const fr = {}; for (const k of FRAME_KEYS) if (f[k] !== undefined) fr[k] = f[k];
      fr.z = i; fr.layout = { ...layoutRest, meta: metaRest }; fr.order = blocks.map(b => b.id);
      out.set('f~' + f.id, fr);
      if (original) out.set('o~' + f.id, { original });
      // Positions and sizes that auto layout computes are left out: every viewer computes them, so they never echo.
      const I = Auto.needs(f) ? Auto.index(f) : null;
      for (const b of blocks) out.set(`b~${f.id}~${b.id}`, Auto.syncBlock(f, b, I));
    });
    return out;
  }
  const strip = r => { const { _k, _v, _by, _del, ...rest } = r; return rest; };
  const canon = r => JSON.stringify(r);
  function frameFrom(map, fid) {
    const fr = map.get('f~' + fid); if (!fr || fr._del) return null;
    const blocks = []; const prefix = `b~${fid}~`;
    const byId = new Map(); for (const [k, r] of map) if (k.startsWith(prefix) && !r._del) byId.set(k.slice(prefix.length), strip(r));
    for (const id of (fr.order || [])) if (byId.has(id)) { blocks.push(byId.get(id)); byId.delete(id); }
    for (const b of [...byId.values()].sort((a, c) => String(a.id).localeCompare(String(c.id)))) blocks.push(b);
    const o = map.get('o~' + fid);
    const layout = { ...Canvas.clone(fr.layout || {}), blocks: Canvas.clone(blocks) };
    layout.meta = { ...(layout.meta || {}) }; if (o && !o._del && o.original) layout.meta.original = Canvas.clone(o.original);
    if (!layout.format || !layout.palette || !layout.grid) return null; // incomplete record
    const f = { id: fid, layout }; for (const k of FRAME_KEYS) if (fr[k] !== undefined && k !== 'id') f[k] = Canvas.clone(fr[k]);
    Canvas.migrate(f);
    if (Auto.needs(f)) { Auto.fillDefaults(f); Auto.layout(f); }
    return f;
  }
  function docFrom(map, base) {
    const doc = { ...(base || Canvas.create()), frames: [] };
    const meta = map.get('meta'); if (meta && !meta._del && meta.name) doc.name = meta.name;
    doc.library = libraryFrom(map);
    const fids = [...map.entries()].filter(([k, r]) => k.startsWith('f~') && !r._del).sort((a, b) => (a[1].z ?? 0) - (b[1].z ?? 0) || a[0].localeCompare(b[0])).map(([k]) => k.slice(2));
    for (const fid of fids) { const f = frameFrom(map, fid); if (f) doc.frames.push(f); }
    return doc;
  }
  // Team library items, in the order they were made.
  function libraryFrom(map) { return [...map.entries()].filter(([k, r]) => k.startsWith('L~') && !r._del).map(([, r]) => strip(r)).sort((a, b) => (a.created || 0) - (b.created || 0)); }
  // After the local doc was rebuilt from records, remember its canonical JSON so we never echo it back.
  function markSynced(doc, keys) { const cur = toRecords(doc); for (const k of keys) { if (cur.has(k)) synced.set(k, canon(cur.get(k))); else synced.delete(k); } }

  // ---- outgoing ------------------------------------------------------------------------------------------------------
  function diff(doc, onlyFrames) {
    const cur = toRecords(doc); const out = [];
    for (const [k, r] of cur) {
      if (onlyFrames && k !== 'meta' && !onlyFrames.has(k.split('~')[1])) continue;
      const j = canon(r); if (synced.get(k) === j) continue;
      const rec = { ...Canvas.clone(r), _k: k, _v: now(), _by: me.id }; recs.set(k, rec); synced.set(k, j); out.push(rec);
    }
    if (!onlyFrames) for (const k of [...synced.keys()]) if (!cur.has(k) && !k.startsWith('a~')) { const rec = { _k: k, _del: 1, _v: now(), _by: me.id }; recs.set(k, rec); synced.delete(k); out.push(rec); }
    return out;
  }
  function onChange(doc) {
    if (!adapter || applying) return;
    const out = diff(doc); if (out.length) adapter.send(out, false);
    queueAssetShare(doc);
  }
  function onLive(frameIds) {
    if (!adapter || applying || !adapter.live) return;
    const out = diff(ui.doc, new Set(frameIds)); if (out.length) adapter.send(out, true);
  }

  // ---- incoming ------------------------------------------------------------------------------------------------------
  const newer = (a, b) => !b || a._v > b._v || (a._v === b._v && String(a._by) > String(b._by));
  function applyRemote(list, opts = {}) {
    const frames = new Set(); let structural = false, meta = false, lib = false; const assets = [];
    for (const rec of list) {
      if (!rec || typeof rec._k !== 'string' || typeof rec._v !== 'number') continue;
      const k = rec._k; if (!/^(meta|[fbo]~[A-Za-z0-9_.:-]+(~[A-Za-z0-9_.:-]+)?|a~[A-Za-z0-9_.-]+|L~[A-Za-z0-9_.:-]+)$/.test(k)) continue;
      if (!newer(rec, recs.get(k))) continue;
      recs.set(k, rec);
      if (k === 'meta') meta = true;
      else if (k.startsWith('L~')) lib = true;
      else if (k.startsWith('a~')) assets.push(rec);
      else { const fid = k.split('~')[1]; frames.add(fid); if (k.startsWith('f~')) structural = true; }
    }
    for (const a of assets) ensureAsset(a);
    if (lib) { applying = true; try { ui.doc.library = libraryFrom(recs); markSynced(ui.doc, [...recs.keys()].filter(k => k.startsWith('L~'))); if (env.onLibrary) env.onLibrary(); } finally { applying = false; } }
    if (!frames.size && !meta) return;
    applying = true;
    try {
      const doc = ui.doc;
      if (meta) { const m = recs.get('meta'); if (m && m.name) doc.name = m.name; }
      for (const fid of frames) {
        const f = frameFrom(recs, fid); const i = doc.frames.findIndex(x => x.id === fid);
        if (!f) { if (i >= 0) { doc.frames.splice(i, 1); structural = true; } }
        else if (i >= 0) doc.frames[i] = f; else { doc.frames.push(f); structural = true; }
      }
      if (structural) { const z = id => { const r = recs.get('f~' + id); return r && !r._del ? r.z ?? 0 : 0; }; doc.frames.sort((a, b) => z(a.id) - z(b.id)); }
      const keys = [...recs.keys()].filter(k => k === 'meta' || frames.has(k.split('~')[1]));
      markSynced(doc, keys);
      ui.remoteApplied([...frames], structural || opts.full);
    } finally { applying = false; }
  }
  // Load a whole shared canvas (first join): it replaces the local one; the local one is kept as a backup.
  function loadAll(list) {
    for (const rec of list) if (rec && rec._k && newer(rec, recs.get(rec._k))) recs.set(rec._k, rec);
    for (const r of recs.values()) if (r._k.startsWith('a~') && !r._del) ensureAsset(r);
    try { localStorage.setItem('lg.canvas.backup', Canvas.serialize(ui.doc)); } catch { }
    applying = true;
    try { const doc = docFrom(recs, ui.doc); ui.replaceDoc(doc, { silent: true }); synced.clear(); markSynced(ui.doc, [...toRecords(ui.doc).keys()]); for (const k of recs.keys()) if (k.startsWith('a~')) synced.set(k, 'asset'); } finally { applying = false; }
  }
  // Push everything (first person in an empty shared canvas).
  function pushAll() { synced.clear(); const out = diff(ui.doc); if (out.length && adapter) adapter.send(out, false); queueAssetShare(ui.doc); }

  // Per-person undo: records someone else changed after you keep their version.
  function undoMerge(cur, target) {
    if (!adapter) return target;
    const A = toRecords(cur), B = toRecords(target); const merged = new Map(A);
    for (const k of new Set([...A.keys(), ...B.keys()])) {
      const r = recs.get(k); if (r && r._by !== me.id) continue;
      if (B.has(k)) merged.set(k, B.get(k)); else merged.delete(k);
    }
    const doc = docFrom(merged, cur); doc.view = cur.view; return doc;
  }

  // ---- shared images -------------------------------------------------------------------------------------------------
  let sharing = false, shareAgain = false;
  async function sha(text) { const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text)); return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join(''); }
  function queueAssetShare(doc) { if (!adapter || (!adapter.uploadAsset && !env.knownAsset) || status.readOnly) return; if (sharing) { shareAgain = true; return; } sharing = true; shareAssets(doc).catch(e => console.warn('asset share', e)).finally(() => { sharing = false; if (shareAgain) { shareAgain = false; queueAssetShare(ui.doc); } }); }
  async function shareAssets(doc) {
    const assets = env.getAssets().images; const renames = new Map();
    const used = new Set(); for (const f of doc.frames) for (const b of f.layout.blocks) if (b.kind === 'image' && b.asset) used.add(b.asset);
    for (const it of doc.library || []) for (const b of it.blocks || []) if (b.kind === 'image' && b.asset) used.add(b.asset);
    for (const id of used) {
      if (/^a_[0-9a-f]{16}$/.test(id)) { const r = recs.get('a~' + id); if (r) continue; }
      // a shared library picture already has a home: point to it instead of uploading a copy
      const known = env.knownAsset ? env.knownAsset(id) : null;
      if (known && known.url && (!/^data:/.test(known.url) || known.url.length < 180000)) { const rec = { _k: 'a~' + id, _v: now(), _by: me.id, id, url: known.url, name: String(known.name || '').slice(0, 80), w: known.w, h: known.h }; recs.set(rec._k, rec); synced.set(rec._k, 'asset'); adapter.send([rec], false); continue; }
      if (!adapter.uploadAsset) continue; // people who may not upload still share library pictures (above)
      const a = assets.find(x => x.id === id); if (!a || !a.dataUrl) continue;
      const gid = /^a_[0-9a-f]{16}$/.test(id) ? id : 'a_' + (await sha(a.dataUrl)).slice(0, 16);
      if (!recs.get('a~' + gid)) {
        const blob = env.dataUrlToBlob(a.dataUrl);
        const up = await adapter.uploadAsset(blob, a.name).catch(e => { console.warn('upload failed', e); return null; });
        if (!up) continue;
        const rec = { _k: 'a~' + gid, _v: now(), _by: me.id, id: gid, url: up.url, name: String(a.name || '').slice(0, 80), w: a.w, h: a.h };
        recs.set(rec._k, rec); synced.set(rec._k, 'asset'); adapter.send([rec], false);
      }
      if (gid !== id) renames.set(id, gid);
    }
    if (!renames.size) return;
    // the shared id becomes an alias of the local image, so layouts elsewhere that use the local id keep working
    for (const [from, to] of renames) { const a = assets.find(x => x.id === from); if (a && !assets.some(x => x.id === to)) assets.push({ ...a, id: to }); }
    ui.mutate(d => { for (const f of d.frames) for (const b of f.layout.blocks) if (b.kind === 'image' && renames.has(b.asset)) b.asset = renames.get(b.asset); for (const it of d.library || []) for (const b of it.blocks || []) if (b.kind === 'image' && renames.has(b.asset)) b.asset = renames.get(b.asset); }, { history: false });
  }
  const loadingAssets = new Set();
  async function ensureAsset(rec) {
    if (!rec || rec._del || !rec.id || !rec.url) return;
    if (env.getAssets().images.some(a => a.id === rec.id) || loadingAssets.has(rec.id)) return;
    loadingAssets.add(rec.id);
    try {
      const url = adapter && adapter.assetUrl ? adapter.assetUrl(rec.url) : rec.url;
      const img = new Image(); img.crossOrigin = 'anonymous';
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('image load')); img.src = url; });
      let dataUrl = null; try { const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0); dataUrl = c.toDataURL(/\.jpe?g$|jpeg/i.test(rec.url + rec.name) ? 'image/jpeg' : 'image/png', 0.9); } catch { dataUrl = null; }
      await env.addAssetWithId(rec.id, dataUrl, url, rec.name || 'shared image');
      const fids = ui.doc.frames.filter(f => f.layout.blocks.some(b => b.asset === rec.id)).map(f => f.id);
      if (fids.length) ui.rerender(fids);
    } catch (e) { console.warn('shared image', rec.id, e.message); } finally { loadingAssets.delete(rec.id); }
  }

  // ---- presence ------------------------------------------------------------------------------------------------------
  let lastCursor = 0, pendingCursor;
  function cursor(p) { if (!adapter) return; pendingCursor = p; const t = performance.now(); if (t - lastCursor < 50) return; lastCursor = t; adapter.presence({ cursor: p ? { x: Math.round(p.x), y: Math.round(p.y) } : null }); }
  function selection(s) { if (adapter) adapter.presence({ sel: { frameIds: (s.frameIds || []).slice(0, 40), blockIds: (s.blockIds || []).slice(0, 40) } }); }
  function setPeers(list) { peers = list; ui.setPeers(list); notify(); }

  // ---- adapters ------------------------------------------------------------------------------------------------------
  // Self-hosted server: WebSocket at /sync?room=<id>, records and presence as JSON messages.
  function serverAdapter(roomId) {
    let ws = null, closed = false, retry = 0, outbox = [], peerMap = new Map(), firstSnapshot = true;
    const send = msg => { const s = JSON.stringify(msg); if (ws && ws.readyState === 1) ws.send(s); else outbox.push(s); };
    function connect() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}/sync?room=${encodeURIComponent(roomId)}`);
      ws.onopen = () => { retry = 0; status.connected = true; notify(); send({ t: 'hello', client: { id: me.id, name: me.name || '', color: me.color }, tools: env.toolList ? env.toolList() : [] }); for (const s of outbox.splice(0)) ws.send(s); };
      ws.onmessage = ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === 'snapshot') { const list = Array.isArray(m.recs) ? m.recs : []; if (firstSnapshot) { firstSnapshot = false; if (list.some(r => r._k && r._k.startsWith('f~') && !r._del)) loadAll(list); else pushAll(); } else applyRemote(list, { full: true }); }
        else if (m.t === 'recs') applyRemote(Array.isArray(m.recs) ? m.recs : []);
        else if (m.t === 'presence') { const p = peerMap.get(m.id) || { id: m.id }; Object.assign(p, sanitizePresence(m.p)); peerMap.set(m.id, p); setPeers([...peerMap.values()]); }
        else if (m.t === 'leave') { peerMap.delete(m.id); setPeers([...peerMap.values()]); }
        else if (m.t === 'peers') { peerMap = new Map((m.list || []).filter(p => p.id !== me.id).map(p => [p.id, { id: p.id, ...sanitizePresence(p.p) }])); setPeers([...peerMap.values()]); }
        else if (m.t === 'libs' && env.onLibs) env.onLibs();
        else if (m.t === 'rpc' && env.onRpc) { Promise.resolve().then(() => env.onRpc(m.name, m.args || {})).then(result => send({ t: 'rpc-result', id: m.id, result }), err => send({ t: 'rpc-result', id: m.id, error: String(err && err.message || err) })); }
      };
      ws.onclose = () => { status.connected = false; notify(); if (closed) return; setTimeout(connect, Math.min(8000, 500 * 2 ** retry++)); };
    }
    connect();
    return {
      kind: 'server', live: true,
      send: (list, live) => send({ t: 'recs', recs: list, live: !!live }),
      presence: p => send({ t: 'presence', p }),
      uploadAsset: async (blob, name) => { const r = await fetch(`/api/assets?room=${encodeURIComponent(roomId)}`, { method: 'POST', headers: { 'content-type': blob.type || 'application/octet-stream', 'x-name': encodeURIComponent(name || '') }, body: blob }); if (!r.ok) throw new Error('upload ' + r.status); return r.json(); },
      announceTools: list => send({ t: 'tools', tools: list }),
      close: () => { closed = true; try { ws.close(); } catch { } },
    };
  }
  // claude.ai artifact: room (presence, live edits) + db (persistence) + assets (images) + user (names).
  async function artifactAdapter() {
    if (!(window.claude && typeof window.claude.use === 'function')) return null;
    const [room, db, user, assets] = await Promise.all(['room', 'db', 'user', 'assets'].map(n => window.claude.use(n).catch(() => null)));
    if (!db && !room) return null;
    const writeQueue = new Map(); let firstSnap = true; const docVersions = new Map();
    // A frame and its blocks pack into one database document (or a few, past 200 KB), keyed by frame id.
    function framePacks(fid) {
      const pre = `b~${fid}~`; const blocks = {}; let size = 0; const chunks = [{}];
      for (const [k, r] of recs) if (k.startsWith(pre)) { const id = k.slice(pre.length); if (r._del && Date.now() * 1000 - r._v > 6e8) continue; const s = JSON.stringify(r).length; if (size + s > 190000 && Object.keys(chunks[chunks.length - 1]).length) { chunks.push({}); size = 0; } chunks[chunks.length - 1][id] = r; size += s; }
      return chunks;
    }
    async function writeFrame(fid) {
      const fr = recs.get('f~' + fid); if (!fr) return;
      const chunks = framePacks(fid); const o = recs.get('o~' + fid);
      const bodies = chunks.map((blocks, i) => i === 0 ? { rec: fr, orig: o || null, blocks, chunks: chunks.length } : { of: fid, i, blocks });
      try {
        for (let i = 0; i < bodies.length; i++) await db.doc(`frames/${i ? fid + '.c' + i : fid}`).set(bodies[i]);
        const had = docVersions.get(fid) || 1; for (let i = bodies.length; i < had; i++) await db.doc(`frames/${fid}.c${i}`).delete();
        docVersions.set(fid, bodies.length);
      } catch (e) { if (e && (e.code === 'invalid_argument' || e.code === 'not_granted')) { status.readOnly = true; notify(); } else throw e; }
    }
    function schedule(fid) {
      const q = writeQueue.get(fid) || { timer: 0, chain: Promise.resolve() };
      clearTimeout(q.timer);
      q.timer = setTimeout(() => { q.chain = q.chain.then(() => writeFrame(fid)).catch(e => console.warn('db write', e)); }, 450);
      writeQueue.set(fid, q);
    }
    let metaChain = Promise.resolve();
    function sendRecs(list, live) {
      if (!status.readOnly && db) {
        const fids = new Set(); for (const r of list) { if (r._k === 'meta') metaChain = metaChain.then(() => db.doc('canvas/meta').set({ rec: r })).catch(() => { }); else if (r._k.startsWith('a~')) db.doc(`assets/${r.id}`).set({ rec: r }).catch(() => { }); else if (r._k.startsWith('L~')) db.doc(`library/${r._k.slice(2)}`).set({ rec: r }).catch(() => { }); else fids.add(r._k.split('~')[1]); }
        for (const fid of fids) schedule(fid);
      }
      if (room) { for (const r of list) pendingLive.set(r._k, r); if (!liveTimer) liveTimer = setTimeout(flushLive, 120); }
    }
    // Fast path for small records, coalesced to about eight messages a second (the room's budget is shared with
    // cursors); the database carries everything regardless.
    const pendingLive = new Map(); let liveTimer = 0;
    function flushLive() {
      liveTimer = 0; const list = [...pendingLive.values()]; pendingLive.clear();
      let batch = [], size = 0; const flush = () => { if (batch.length) room.emit('live', { recs: batch }).catch(() => { }); batch = []; size = 0; };
      for (const r of list) { const s = JSON.stringify(r).length; if (s > 3200) continue; if (size + s > 3200) flush(); batch.push(r); size += s; }
      flush();
    }
    if (room) {
      room.on('live', msg => { if (msg.sameTab || !msg.data || !Array.isArray(msg.data.recs)) return; applyRemote(msg.data.recs); });
      const names = new Map();
      room.onPeers(async ch => {
        const list = ch.peers.filter(p => !p.isMe || !p.sameTab).filter(p => !(p.isMe && p.sameTab)).map(p => ({ id: p.peer, by: p.by, isMe: p.isMe, kind: p.kind, ...sanitizePresence(p.presence) }));
        const ids = list.map(p => p.by).filter(b => b && !names.has(b));
        if (ids.length && user && user.profiles) { try { const ps = await user.profiles(ids); for (const id of ids) names.set(id, (ps[id] && ps[id].name) || ''); } catch { } }
        for (const p of list) { const n = p.by && names.get(p.by); if (n) p.name = p.isMe ? n + ' (you, other tab)' : n; if (!p.name) p.name = p.kind === 'agent' ? 'Claude' : 'Someone'; if (!p.color) p.color = COLORS[hashStr(p.id) % COLORS.length]; }
        setPeers(list);
      });
      room.onConnection(c => { status.connected = c; notify(); });
    }
    if (db) {
      const unpack = d => { const out = []; if (d.rec) out.push(d.rec); if (d.orig) out.push(d.orig); for (const r of Object.values(d.blocks || {})) out.push(r); return out; };
      db.collection('frames').onSnapshot(snap => {
        const list = []; for (const d of snap.docs) { const data = d.data(); if (data) { list.push(...unpack(data)); if (!d.id.includes('.c')) docVersions.set(d.id, data.chunks || 1); } }
        if (firstSnap) {
          if (snap.metadata && snap.metadata.fromCache && !snap.size) return; // wait for the server's answer
          firstSnap = false;
          if (list.some(r => r._k && r._k.startsWith('f~') && !r._del)) loadAll(list); else pushAll();
          return;
        }
        const changed = []; for (const ch of snap.docChanges()) { const data = ch.doc.data(); if (data && ch.type !== 'removed') changed.push(...unpack(data)); }
        applyRemote(changed);
      }, e => console.warn('db frames', e && e.code));
      db.doc('canvas/meta').onSnapshot(s => { const d = s.data(); if (d && d.rec) applyRemote([d.rec]); }, () => { });
      db.collection('library').onSnapshot(s => { const list = []; for (const d of s.docs) { const v = d.data(); if (v && v.rec) list.push(v.rec); } if (list.length) applyRemote(list); }, () => { });
      db.collection('assets').onSnapshot(s => { for (const d of s.docs) { const v = d.data(); if (v && v.rec) { if (newer(v.rec, recs.get(v.rec._k))) recs.set(v.rec._k, v.rec); ensureAsset(v.rec); } } }, () => { });
      if (user && user.can) user.can('data.write').then(v => { if (v === false) { status.readOnly = true; notify(); } }).catch(() => { });
    }
    return {
      kind: 'artifact', live: !!room,
      send: sendRecs,
      presence: p => { if (room) room.presence(p).catch(() => { }); },
      uploadAsset: assets ? async blob => { const r = await assets.upload(blob); return { id: r.id, url: r.url }; } : null,
      close: () => { },
    };
  }
  function sanitizePresence(p) {
    p = p || {}; const out = {};
    if (p.cursor && Number.isFinite(p.cursor.x) && Number.isFinite(p.cursor.y)) out.cursor = { x: p.cursor.x, y: p.cursor.y }; else out.cursor = null;
    if (p.sel && Array.isArray(p.sel.frameIds)) out.sel = { frameIds: p.sel.frameIds.filter(x => typeof x === 'string').slice(0, 40), blockIds: Array.isArray(p.sel.blockIds) ? p.sel.blockIds.filter(x => typeof x === 'string').slice(0, 40) : [] };
    if (typeof p.name === 'string') out.name = p.name.replace(/[\u0000-\u001f<>]/g, '').slice(0, 40);
    if (typeof p.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(p.color)) out.color = p.color;
    return out;
  }

  // ---- lifecycle -----------------------------------------------------------------------------------------------------
  function init(canvasUI, e) {
    ui = canvasUI; env = e;
    ui.on('change', doc => onChange(doc));
    ui.on('live', ids => onLive(ids));
    ui.on('pointer', p => cursor(p));
    ui.on('select', s => selection(s));
    ui.setUndoMerge((cur, target) => undoMerge(cur, target));
  }
  function attach(a, info) {
    if (adapter && adapter.close) adapter.close();
    adapter = a; Object.assign(status, info, { connected: info.mode === 'artifact' ? status.connected : false });
    if (a) a.presence({ name: me.name || '', color: me.color, cursor: null, sel: { frameIds: [], blockIds: [] } });
    notify();
  }
  async function startArtifact() {
    const a = await artifactAdapter(); if (!a) return false;
    attach(a, { mode: 'artifact', room: 'artifact', label: 'Everyone with this page open edits the same canvas' });
    return true;
  }
  async function serverAvailable() {
    if (!/^https?:$/.test(location.protocol) || window.claude) return false; // file:// or inside claude.ai: no sync server there
    try { const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 1500); const r = await fetch('/api/ping', { cache: 'no-store', signal: ctl.signal }); clearTimeout(t); if (!r.ok) return false; const j = await r.json(); return !!(j && j.lg); } catch { return false; }
  }
  function roomFromUrl() { const m = /[?&#]room=([A-Za-z0-9_-]{4,64})/.exec(location.search + location.hash); return m ? m[1] : null; }
  function joinServer(roomId) {
    status.room = roomId;
    const url = new URL(location.href); url.searchParams.set('room', roomId); history.replaceState(null, '', url);
    attach(serverAdapter(roomId), { mode: 'server', room: roomId, label: 'Anyone with this link edits the same canvas' });
    return roomId;
  }
  function newRoomId() { const a = 'abcdefghijkmnpqrstuvwxyz23456789'; let s = ''; const r = crypto.getRandomValues(new Uint8Array(10)); for (const x of r) s += a[x % a.length]; return s; }
  function roomLink() { if (status.mode !== 'server' || !status.room) return null; const u = new URL(location.href); u.hash = ''; u.searchParams.set('room', status.room); return u.toString(); }
  function setName(n) { me.name = String(n || '').replace(/[\u0000-\u001f<>]/g, '').slice(0, 40); LS.set('lg.name', me.name); if (adapter) adapter.presence({ name: me.name }); notify(); }
  return {
    init, startArtifact, serverAvailable, roomFromUrl, joinServer, newRoomId, roomLink, setName,
    get me() { return me; }, get status() { return status; }, get peers() { return peers; },
    onStatus: fn => { listeners.push(fn); fn(status, peers); },
    announceTools: list => { if (adapter && adapter.announceTools) adapter.announceTools(list); },
    _debug: { recs, synced, toRecords, docFrom, undoMerge },
  };
})();
