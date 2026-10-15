#!/usr/bin/env node
// Layout Engine server: serves the app, hosts live canvas rooms over WebSocket, stores shared images, and exposes the
// canvas to outside agents (Claude Code, Cursor, Codex) as an MCP server, the way Paper does. No dependencies.
//
//   node server/server.mjs            → http://127.0.0.1:8787
//   PORT=9000 HOST=0.0.0.0 LG_TOKEN=secret node server/server.mjs
//
// Rooms live in memory and are saved to server/data/rooms/<id>.json. Images go to server/data/assets/.
// Shared libraries (the same for every room) are saved to server/data/libraries.json; LG_ADMIN_KEY=… limits editing
// them to people who have the key.
// MCP: claude mcp add layout --transport http http://127.0.0.1:8787/mcp
// Tool calls are carried out by a browser tab that has the room open (the canvas engine runs there), so keep one open.
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, appendFile, mkdir, stat, rename } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(process.env.LG_DATA || path.join(ROOT, 'server', 'data'));
const PORT = +(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.LG_TOKEN || '';
const ADMIN_KEY = process.env.LG_ADMIN_KEY || '';
// Behind a sign-in proxy (oauth2-proxy, an ingress with SSO…): the header it sets with the person's email or user name.
// Folder sharing then knows people for sure; without it the server goes by the id each browser makes up.
const USER_HEADER = String(process.env.LG_USER_HEADER || '').toLowerCase();
const NAME_HEADER = String(process.env.LG_NAME_HEADER || '').toLowerCase();
const LOCAL = /^(127\.0\.0\.1|localhost|::1)$/.test(HOST);
const VERSION = '1.0.0';
const MAX_MSG = 64 * 1024 * 1024;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8', '.woff2': 'font/woff2' };
const EXT_BY_TYPE = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg' };

// ---- Tool definitions, shared with the browser (js/tool-defs.js) ------------------------------------------------------
function loadToolDefs() {
  try { const ctx = {}; vm.createContext(ctx); vm.runInContext(readFileSync(path.join(ROOT, 'js', 'tool-defs.js'), 'utf8') + ';this.__defs = TOOL_DEFS;', ctx); return ctx.__defs || []; }
  catch { return []; }
}

// ---- Rooms -----------------------------------------------------------------------------------------------------------
const rooms = new Map();
const validRoom = id => typeof id === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(id);
async function getRoom(id) {
  let r = rooms.get(id); if (r) return r;
  r = { id, recs: new Map(), clients: new Set(), saveTimer: null, saveDue: 0, loaded: false, dirtyPresence: new Set(), presenceTimer: null };
  rooms.set(id, r);
  try { const j = JSON.parse(await readFile(path.join(DATA, 'rooms', id + '.json'), 'utf8')); for (const rec of j.recs || []) if (rec && rec._k) r.recs.set(rec._k, rec); } catch { }
  r.loaded = true; return r;
}
function scheduleSave(r) {
  clearTimeout(r.saveTimer);
  const now = Date.now(); if (!r.saveDue) r.saveDue = now + 5000;
  r.saveTimer = setTimeout(async () => {
    r.saveDue = 0;
    try {
      await mkdir(path.join(DATA, 'rooms'), { recursive: true });
      const cutoff = (Date.now() - 86400e3) * 1000; // drop tombstones older than a day
      const recs = [...r.recs.values()].filter(x => !(x._del && x._v < cutoff));
      const file = path.join(DATA, 'rooms', r.id + '.json'); const tmp = file + '.tmp'; const t0 = Date.now();
      await writeFile(tmp, JSON.stringify({ v: 1, id: r.id, saved: new Date().toISOString(), recs })); await rename(tmp, file);
      stats.saves++; stats.saveMsMax = Math.max(stats.saveMsMax, Date.now() - t0);
    } catch (e) { log('save failed', r.id, e.message); }
  }, Math.max(50, Math.min(1500, r.saveDue - now)));
}
const newer = (a, b) => !b || a._v > b._v || (a._v === b._v && String(a._by) > String(b._by));
function cleanPresence(p) {
  p = p && typeof p === 'object' ? p : {}; const out = {};
  if (p.cursor && Number.isFinite(p.cursor.x) && Number.isFinite(p.cursor.y)) out.cursor = { x: +p.cursor.x, y: +p.cursor.y }; else if (p.cursor === null) out.cursor = null;
  if (p.sel && Array.isArray(p.sel.frameIds)) out.sel = { frameIds: p.sel.frameIds.filter(x => typeof x === 'string').slice(0, 40), blockIds: Array.isArray(p.sel.blockIds) ? p.sel.blockIds.filter(x => typeof x === 'string').slice(0, 40) : [] };
  if (typeof p.name === 'string') out.name = p.name.replace(/[\u0000-\u001f<>]/g, '').slice(0, 40);
  if (typeof p.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(p.color)) out.color = p.color;
  return out;
}

// ---- WebSocket (RFC 6455, text frames) -------------------------------------------------------------------------------
let connSeq = 0;
function wsAccept(req, socket) {
  const key = req.headers['sec-websocket-key']; if (!key) { socket.destroy(); return null; }
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  const conn = { id: 'p' + (++connSeq).toString(36), socket, buf: Buffer.alloc(0), chunks: [], chunkLen: 0, need: 2, frags: [], alive: true, client: {}, p: {}, tools: [], lastActive: Date.now(), room: null, onMessage: null, onClose: null, closed: false };
  // Big messages (a whole canvas) arrive in many chunks: collect them and join once there is enough for a frame.
  socket.on('data', chunk => { conn.chunks.push(chunk); conn.chunkLen += chunk.length; if (conn.chunkLen + conn.buf.length < conn.need) return; conn.buf = Buffer.concat([conn.buf, ...conn.chunks]); conn.chunks = []; conn.chunkLen = 0; parseFrames(conn); });
  socket.on('close', () => closeConn(conn)); socket.on('error', () => closeConn(conn)); socket.on('end', () => closeConn(conn));
  return conn;
}
function closeConn(conn) { if (conn.closed) return; conn.closed = true; try { conn.socket.destroy(); } catch { } if (conn.onClose) conn.onClose(); }
function parseFrames(conn) {
  for (;;) {
    const b = conn.buf; conn.need = 2; if (b.length < 2) return;
    const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0; let len = b[1] & 0x7f, off = 2;
    if (len === 126) { conn.need = 4; if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { conn.need = 10; if (b.length < 10) return; const hi = b.readUInt32BE(2), lo = b.readUInt32BE(6); len = hi * 2 ** 32 + lo; off = 10; }
    if (len > MAX_MSG) { closeConn(conn); return; }
    const mOff = off; if (masked) off += 4; conn.need = off + len; if (b.length < off + len) return;
    let payload = b.subarray(off, off + len);
    if (masked) { const m = b.subarray(mOff, mOff + 4); payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]; }
    conn.buf = b.subarray(off + len);
    if (op === 0x8) { sendFrame(conn, 0x8, Buffer.alloc(0)); closeConn(conn); return; }
    if (op === 0x9) { sendFrame(conn, 0xA, payload); continue; }
    if (op === 0xA) { conn.alive = true; continue; }
    if (op === 0x1 || op === 0x2 || op === 0x0) {
      conn.frags.push(payload);
      if (conn.frags.reduce((t, f) => t + f.length, 0) > MAX_MSG) { closeConn(conn); return; }
      if (fin) { const msg = Buffer.concat(conn.frags).toString('utf8'); conn.frags = []; stats.msgsIn++; stats.bytesIn += msg.length; if (conn.onMessage) { try { conn.onMessage(msg); } catch (e) { log('message error', e.message); } } }
    }
  }
}
function sendFrame(conn, op, payload) {
  if (conn.closed) return;
  const len = payload.length; let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeUInt32BE(Math.floor(len / 2 ** 32), 2); head.writeUInt32BE(len >>> 0, 6); }
  head[0] = 0x80 | op;
  stats.msgsOut++; stats.bytesOut += len;
  try { conn.socket.write(Buffer.concat([head, payload])); } catch { closeConn(conn); }
}
// Counters and event-loop lag for /api/stats (what tools/loadtest.mjs reads).
const stats = { msgsOut: 0, bytesOut: 0, msgsIn: 0, bytesIn: 0, dropped: 0, saves: 0, saveMsMax: 0, lag: [] };
let lagT = Date.now(); setInterval(() => { const n = Date.now(); const l = n - lagT - 250; lagT = n; stats.lag.push(Math.max(0, l)); if (stats.lag.length > 240) stats.lag.shift(); }, 250).unref();
const sendJSON = (conn, obj) => sendFrame(conn, 0x1, Buffer.from(JSON.stringify(obj)));
const SLOW = 4 * 1024 * 1024, HOPELESS = 64 * 1024 * 1024;
// One message to many people: encoded once. Presence is skipped for a reader whose socket is backed up (it is
// replaced by the next one anyway); a reader that cannot keep up with edits at all is dropped.
function broadcast(conns, obj, { skippable = false } = {}) {
  const payload = Buffer.from(JSON.stringify(obj));
  for (const c of conns) {
    const q = c.socket.writableLength || 0;
    if (q > HOPELESS) { stats.dropped++; closeConn(c); continue; }
    if (skippable && q > SLOW) { stats.dropped++; continue; }
    sendFrame(c, 0x1, payload);
  }
}
setInterval(() => { for (const r of rooms.values()) for (const c of r.clients) { if (!c.alive) { closeConn(c); continue; } c.alive = false; sendFrame(c, 0x9, Buffer.alloc(0)); } }, 30000).unref();

const PRESENCE_TICK = 50;
function flushPresence(room) {
  room.presenceTimer = null; const list = [...room.dirtyPresence].filter(c => !c.closed).map(c => ({ id: c.id, p: c.p })); room.dirtyPresence.clear();
  if (!list.length) return;
  if (list.length === 1) { const one = list[0]; broadcast([...room.clients].filter(c => c.id !== one.id), { t: 'presence', id: one.id, p: one.p }, { skippable: true }); return; }
  broadcast(room.clients, { t: 'presences', list }, { skippable: true });
}
// ---- Room protocol ---------------------------------------------------------------------------------------------------
const pending = new Map(); let rpcSeq = 0;
async function joinRoom(conn, roomId) {
  const room = await getRoom(roomId); conn.room = room; room.clients.add(conn);
  const others = () => [...room.clients].filter(c => c !== conn);
  conn.onMessage = raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    conn.lastActive = Date.now();
    if (m.t === 'hello') {
      conn.client = cleanPresence(m.client); conn.p = { ...conn.p, ...conn.client };
      if (conn.who) remember(conn.who, conn.client.name).catch(() => { });
      if (Array.isArray(m.tools)) conn.tools = m.tools.slice(0, 100);
      sendJSON(conn, { t: 'snapshot', recs: [...room.recs.values()] });
      sendJSON(conn, { t: 'peers', list: others().map(c => ({ id: c.id, p: c.p })) });
      broadcast(others(), { t: 'presence', id: conn.id, p: conn.p });
      log(`join ${room.id} ${conn.id} ${conn.client.name || ''} (${room.clients.size} here)`);
    } else if (m.t === 'recs' && Array.isArray(m.recs)) {
      const ok = [];
      for (const rec of m.recs) { if (!rec || typeof rec._k !== 'string' || typeof rec._v !== 'number' || rec._k.length > 200) continue; if (newer(rec, room.recs.get(rec._k))) { room.recs.set(rec._k, rec); ok.push(rec); } }
      if (ok.length) { broadcast(others(), { t: 'recs', recs: ok }); scheduleSave(room); }
    } else if (m.t === 'presence') {
      // cursors arrive 20-30 times a second from everyone: the room sends them on as one message per tick
      conn.p = { ...conn.p, ...cleanPresence(m.p) }; room.dirtyPresence.add(conn);
      if (!room.presenceTimer) room.presenceTimer = setTimeout(() => flushPresence(room), PRESENCE_TICK);
    } else if (m.t === 'tools' && Array.isArray(m.tools)) conn.tools = m.tools.slice(0, 100);
    else if (m.t === 'rpc-result' && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error)) : p.resolve(m.result); }
  };
  conn.onClose = () => { room.clients.delete(conn); room.dirtyPresence.delete(conn); broadcast(room.clients, { t: 'leave', id: conn.id }); log(`leave ${room.id} ${conn.id} (${room.clients.size} here)`); };
}
// ---- Shared libraries --------------------------------------------------------------------------------------------------
const LIB_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
let libs = null; let libSave = null;
async function getLibs() {
  if (libs) return libs;
  libs = { libraries: new Map(), items: new Map(), guides: new Map(), notes: new Map() };
  try { const j = JSON.parse(await readFile(path.join(DATA, 'libraries.json'), 'utf8')); for (const l of j.libraries || []) if (l && LIB_ID.test(l.id)) libs.libraries.set(l.id, l); for (const it of j.items || []) if (it && LIB_ID.test(it.id)) libs.items.set(it.id, it); for (const g of j.guides || []) if (g && typeof g.id === 'string') libs.guides.set(g.id, g); for (const n of j.notes || []) if (n && typeof n.id === 'string') libs.notes.set(n.id, n); } catch { }
  return libs;
}
function saveLibs() {
  clearTimeout(libSave);
  libSave = setTimeout(async () => {
    try { await mkdir(DATA, { recursive: true }); const file = path.join(DATA, 'libraries.json'); await writeFile(file + '.tmp', JSON.stringify({ v: 1, saved: new Date().toISOString(), libraries: [...libs.libraries.values()], items: [...libs.items.values()], guides: [...libs.guides.values()], notes: [...libs.notes.values()] })); await rename(file + '.tmp', file); } catch (e) { log('library save failed', e.message); }
  }, 300);
}
const libsBody = L => ({ lgLibraries: 1, keyRequired: !!ADMIN_KEY, libraries: [...L.libraries.values()], items: [...L.items.values()], guides: [...(L.guides || new Map()).values()], notes: [...(L.notes || new Map()).values()] });
function libOp(L, m) {
  if (m.op === 'check') return;
  if (m.op === 'putNote') { const n = m.note; if (!n || !LIB_ID.test(String(n.id || '')) || !/^(?:[a-z0-9_-]{1,40}\.)?(design|layout|animation|illustration|photography|content)$/.test(n.guide)) throw new Error('bad note'); L.notes.set(n.id, JSON.parse(JSON.stringify(n))); if (L.notes.size > 2000) L.notes.delete(L.notes.keys().next().value); return; }
  if (m.op === 'putGuide') { const g = m.guide; if (!g || !/^(?:[a-z0-9_-]{1,40}\.)?(design|layout|animation|illustration|photography|content)$/.test(g.id)) throw new Error('bad guide'); L.guides.set(g.id, { id: g.id, text: String(g.text || '').slice(0, 120000), updated: Date.now(), by: String(g.by || '').slice(0, 80) }); return; }
  if (m.op === 'putLib') { const l = m.lib; if (!l || !LIB_ID.test(l.id) || typeof l.name !== 'string') throw new Error('bad library'); L.libraries.set(l.id, { id: l.id, name: l.name.slice(0, 60), description: String(l.description || '').slice(0, 200), order: +l.order || 0, defaultOn: l.defaultOn !== false, updated: Date.now(), by: String(l.by || '').slice(0, 80) }); return; }
  if (m.op === 'delLib') { L.libraries.delete(m.id); for (const [k, it] of L.items) if (it.lib === m.id) L.items.delete(k); return; }
  if (m.op === 'putItem') { const it = m.item; if (!it || !LIB_ID.test(it.id) || !LIB_ID.test(it.lib) || !Array.isArray(it.blocks)) throw new Error('bad item'); if (!L.libraries.has(it.lib)) throw new Error('no such library'); if (JSON.stringify(it).length > 2 * 1024 * 1024) throw new Error('item over 2 MB'); L.items.set(it.id, it); return; }
  if (m.op === 'delItem') { L.items.delete(m.id); return; }
  throw new Error('unknown op');
}
let libPush = null;
function broadcastLibs() { clearTimeout(libPush); libPush = setTimeout(() => { for (const r of rooms.values()) broadcast(r.clients, { t: 'libs' }); }, 400); }

// ---- Projects and folders (the Home screen's index) -------------------------------------------------------------------
let projects = null; let projSave = null;
async function getProjects() {
  if (projects) return projects;
  projects = { projects: new Map(), folders: new Map() };
  try { const j = JSON.parse(await readFile(path.join(DATA, 'projects.json'), 'utf8')); for (const p of j.projects || []) if (p && LIB_ID.test(p.id)) projects.projects.set(p.id, p); for (const f of j.folders || []) if (f && LIB_ID.test(f.id)) projects.folders.set(f.id, f); } catch { }
  return projects;
}
function saveProjects() {
  clearTimeout(projSave);
  projSave = setTimeout(async () => { try { await mkdir(DATA, { recursive: true }); const file = path.join(DATA, 'projects.json'); await writeFile(file + '.tmp', JSON.stringify({ v: 1, saved: new Date().toISOString(), projects: [...projects.projects.values()], folders: [...projects.folders.values()] })); await rename(file + '.tmp', file); } catch (e) { log('projects save failed', e.message); } }, 300);
}
const str = (v, n) => String(v == null ? '' : v).slice(0, n);
// ---- Who is asking, and what they may see ------------------------------------------------------------------------------
function whoOf(req, url) {
  if (USER_HEADER) {
    const v = String(req.headers[USER_HEADER] || '').trim().toLowerCase().slice(0, 100);
    return v ? { id: 'sso:' + v, name: str(NAME_HEADER && req.headers[NAME_HEADER] ? req.headers[NAME_HEADER] : v.split('@')[0], 80), trusted: true } : { id: '', name: '', trusted: true };
  }
  const id = String(req.headers['x-lg-user'] || (url && url.searchParams.get('u')) || '').slice(0, 120);
  let name = ''; try { name = decodeURIComponent(String(req.headers['x-lg-name'] || '')).replace(/[\u0000-\u001f<>]/g, '').slice(0, 80); } catch { }
  return { id: /^[A-Za-z0-9_.:@+-]{1,120}$/.test(id) ? id : '', name, trusted: false };
}
const isAdminReq = req => !ADMIN_KEY || String(req.headers['x-lg-admin'] || '') === ADMIN_KEY;
const ACCESS = ['all', 'people', 'me'];
function canSeeFolder(f, who) { if (!f || !f.access || f.access === 'all') return true; if (!who.id) return false; return f.by === who.id || (f.access === 'people' && Array.isArray(f.people) && f.people.includes(who.id)); }
const canSeeProject = (P, p, who) => canSeeFolder(p.folder ? P.folders.get(p.folder) : null, who);
const projectsBody = (P, who) => ({ lgProjects: 1, me: { id: who.id, trusted: who.trusted }, projects: [...P.projects.values()].filter(p => canSeeProject(P, p, who)), folders: [...P.folders.values()].filter(f => canSeeFolder(f, who)) });
// People this server has seen (for the "share with" picker): id and the name they go by.
let people = null; let peopleSave = null;
async function getPeople() { if (people) return people; people = new Map(); try { for (const p of JSON.parse(await readFile(path.join(DATA, 'people.json'), 'utf8')).people || []) if (p && p.id) people.set(p.id, p); } catch { } return people; }
async function remember(who, name) {
  if (!who.id) return; const P = await getPeople(); const n = str(who.trusted ? who.name : (name || who.name), 80); const cur = P.get(who.id);
  if (cur && cur.name === (n || cur.name) && Date.now() - cur.seen < 3600e3) return;
  P.set(who.id, { id: who.id, name: n || (cur && cur.name) || '', seen: Date.now() });
  clearTimeout(peopleSave); peopleSave = setTimeout(async () => { try { await mkdir(DATA, { recursive: true }); const file = path.join(DATA, 'people.json'); await writeFile(file + '.tmp', JSON.stringify({ v: 1, people: [...P.values()] })); await rename(file + '.tmp', file); } catch (e) { log('people save failed', e.message); } }, 1000);
}
function projectOp(P, m, who, admin) {
  const mayChange = p => admin || !p.by || p.by === who.id;
  const folderOk = id => { if (!id) return true; const f = P.folders.get(id); if (!f || !canSeeFolder(f, who)) throw new Error('No such folder'); return f; };
  if (m.op === 'put') {
    const p = m.project; if (!p || !LIB_ID.test(p.id) || typeof p.name !== 'string') throw new Error('bad project');
    const cur = P.projects.get(p.id); if (cur && !canSeeProject(P, cur, who)) throw new Error('That project is not shared with you');
    const folder = LIB_ID.test(String(p.folder || '')) ? p.folder : ''; const f = folderOk(folder);
    const by = cur ? cur.by : (who.id || str(p.by, 120));
    if (f && f.access === 'me' && by !== who.id) throw new Error('Only your own projects go in an “Only me” folder');
    P.projects.set(p.id, { id: p.id, name: str(p.name, 80), folder, created: cur ? cur.created : (+p.created || Date.now()), by, byName: cur ? cur.byName : str(who.trusted ? who.name : p.byName, 80), updated: Date.now(), updatedBy: who.id || str(p.updatedBy, 120), frames: +p.frames || 0, cover: typeof p.cover === 'string' && p.cover.length < 60000 ? p.cover : '', archived: !!p.archived, kind: p.kind === 'deck' ? 'deck' : 'canvas' }); return;
  }
  if (m.op === 'patch') {
    const cur = P.projects.get(m.id); if (!cur || !canSeeProject(P, cur, who)) throw new Error('no such project'); const a = m.patch || {};
    if (('name' in a || 'folder' in a || 'archived' in a) && !mayChange(cur)) throw new Error('Only the person who made this project (or an admin) can change it');
    if ('folder' in a) { const f = folderOk(LIB_ID.test(String(a.folder || '')) ? a.folder : ''); if (f && f.access === 'me' && cur.by !== who.id) throw new Error('Only your own projects go in an “Only me” folder'); }
    for (const k of ['name', 'folder', 'frames', 'cover', 'archived', 'updated', 'updatedBy']) if (k in a) cur[k] = k === 'name' ? str(a[k], 80) : k === 'folder' ? (LIB_ID.test(String(a[k] || '')) ? a[k] : '') : k === 'frames' ? (+a[k] || 0) : k === 'cover' ? (typeof a[k] === 'string' && a[k].length < 60000 ? a[k] : '') : k === 'archived' ? !!a[k] : k === 'updated' ? (+a[k] || Date.now()) : str(a[k], 120); return;
  }
  if (m.op === 'del') { const cur = P.projects.get(m.id); if (!cur) return; if (!canSeeProject(P, cur, who) || !mayChange(cur)) throw new Error('Only the person who made this project (or an admin) can remove it'); P.projects.delete(m.id); return; }
  if (m.op === 'putFolder') {
    const f = m.folder; if (!f || !LIB_ID.test(f.id)) throw new Error('bad folder');
    const cur = P.folders.get(f.id); if (cur && !canSeeFolder(cur, who)) throw new Error('No such folder');
    const access = ACCESS.includes(f.access) ? f.access : 'all';
    const list = access === 'people' && Array.isArray(f.people) ? [...new Set(f.people.filter(x => typeof x === 'string' && x && x.length <= 120))].slice(0, 100) : [];
    const by = cur ? cur.by : (who.id || str(f.by, 120));
    const sharingChanged = !cur ? access !== 'all' : (access !== (cur.access || 'all') || JSON.stringify(list) !== JSON.stringify(cur.people || []));
    if (sharingChanged) {
      if (!who.id) throw new Error('Sharing needs to know who you are');
      if (cur && !(by === who.id || ((cur.access || 'all') === 'all' && admin && access !== 'me'))) throw new Error('Only whoever made this folder can change who sees it');
      if (access === 'me') { if (by !== who.id) throw new Error('Only the person who made this folder can make it “Only me”'); const others = [...P.projects.values()].filter(p => p.folder === f.id && p.by && p.by !== who.id); if (others.length) throw new Error(`${others.length} project(s) in this folder were made by someone else: move them out first`); }
    }
    P.folders.set(f.id, { id: f.id, name: str(f.name || 'Folder', 60), order: +f.order || 0, by, access, people: list.filter(x => x !== by) }); return;
  }
  if (m.op === 'delFolder') {
    const cur = P.folders.get(m.id); if (!cur) return; if (!canSeeFolder(cur, who) || !(admin || cur.by === who.id)) throw new Error('Only whoever made this folder (or an admin) can remove it');
    const inside = [...P.projects.values()].filter(p => p.folder === m.id); if ((cur.access || 'all') !== 'all' && inside.length) throw new Error('This folder still holds projects: move or remove them first');
    P.folders.delete(m.id); for (const p of inside) p.folder = ''; return;
  }
  throw new Error('unknown op');
}
// After a sharing change: whoever is in a project's room but may no longer see it is told so and let go.
function enforceRooms(P) {
  for (const r of rooms.values()) { const pr = P.projects.get(r.id); if (!pr) continue; for (const c of [...r.clients]) if (c.who && !canSeeProject(P, pr, c.who)) { sendJSON(c, { t: 'denied', reason: 'This project is no longer shared with you' }); setTimeout(() => closeConn(c), 50); } }
}
function broadcastProjects() { for (const r of rooms.values()) broadcast(r.clients, { t: 'projects' }); }

// ---- Usage analytics: each person's page sends month summaries; admins read them summed up -----------------------------
const MONTH = /^\d{6}$/;
function mergeSummary(stored, mine) {
  if (!stored) return mine;
  const add = (a, b) => { for (const [k, v] of Object.entries(b || {})) a[k] = (a[k] || 0) + v; return a; };
  const out = { ...stored, name: mine.name || stored.name, last: Math.max(stored.last || 0, mine.last || 0), first: Math.min(stored.first || mine.first || 0, mine.first || stored.first || 0) };
  out.counts = add({ ...(stored.counts || {}) }, mine.counts);
  out.days = { ...(stored.days || {}) }; for (const [d, v] of Object.entries(mine.days || {})) { const s = out.days[d] || { actions: 0, minutes: 0, counts: {}, projects: {} }; out.days[d] = { actions: s.actions + (v.actions || 0), minutes: s.minutes + (v.minutes || 0), counts: add({ ...s.counts }, v.counts), projects: add({ ...s.projects }, v.projects) }; }
  out.projects = { ...(stored.projects || {}) }; for (const [p, v] of Object.entries(mine.projects || {})) { const s = out.projects[p] || { actions: 0, minutes: 0, counts: {}, first: v.first, last: v.last }; out.projects[p] = { actions: s.actions + (v.actions || 0), minutes: s.minutes + (v.minutes || 0), counts: add({ ...s.counts }, v.counts), first: Math.min(s.first || v.first, v.first || s.first), last: Math.max(s.last || 0, v.last || 0) }; }
  out.recent = [...(stored.recent || []), ...(mine.recent || [])].slice(-120);
  return out;
}
async function appendEvents(m) {
  const sm = m && m.summary; if (!sm || !MONTH.test(String(sm.month || '')) || !m.uid) throw new Error('bad summary');
  const line = JSON.stringify({ uid: str(m.uid, 80), name: str(m.name, 80), summary: { month: sm.month, days: sm.days || {}, projects: sm.projects || {}, counts: sm.counts || {}, recent: Array.isArray(sm.recent) ? sm.recent.slice(-120) : [], first: +sm.first || 0, last: +sm.last || 0 } });
  if (line.length > 512 * 1024) throw new Error('summary too large');
  await mkdir(path.join(DATA, 'stats'), { recursive: true });
  await appendFile(path.join(DATA, 'stats', sm.month + '.jsonl'), line + '\n');
}
async function analytics(months) {
  const out = new Map();
  for (const m of months) {
    if (!MONTH.test(m)) continue;
    let text = ''; try { text = await readFile(path.join(DATA, 'stats', m + '.jsonl'), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) { if (!line.trim()) continue; let j; try { j = JSON.parse(line); } catch { continue; } const key = j.uid + '~' + m; const s = { ...j.summary, uid: j.uid, name: j.name }; out.set(key, mergeSummary(out.get(key), s)); }
  }
  return [...out.values()];
}

// The browser tab that carries out agent calls: the most recently active one in the room (or anywhere).
function hostFor(roomId) {
  const all = roomId && rooms.get(roomId) ? [...rooms.get(roomId).clients] : [...rooms.values()].flatMap(r => [...r.clients]);
  return all.sort((a, b) => b.lastActive - a.lastActive)[0] || null;
}
function callBrowser(roomId, name, args) {
  const host = hostFor(roomId);
  if (!host) return Promise.reject(new Error('No canvas is open. Open the Layout Engine in a browser (from this server) and keep the tab open; the agent works through it.'));
  const id = 'r' + (++rpcSeq);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('The canvas tab did not answer within 90 s.')); }, 90000);
    pending.set(id, { resolve, reject, timer });
    sendJSON(host, { t: 'rpc', id, name, args });
  });
}

// ---- MCP (Streamable HTTP, JSON responses) ---------------------------------------------------------------------------
const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const sessions = new Map();
function toolsFor(roomId) {
  const host = hostFor(roomId);
  const list = host && host.tools && host.tools.length ? host.tools : loadToolDefs();
  return list.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema || { type: 'object', properties: {} } }));
}
async function mcpHandle(msg, roomId) {
  const { id, method, params } = msg || {};
  const reply = result => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (!method) return fail(-32600, 'Invalid request');
  if (method === 'initialize') {
    const v = params && MCP_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : MCP_VERSIONS[0];
    return reply({ protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'layout-engine', title: 'Layout Engine canvas', version: VERSION },
      instructions: 'Tools read and change the Layout Engine canvas open in a browser tab: frames (screens) made of blocks (text, images, shapes, vectors, buttons). Start with get_selection or get_canvas, use get_screenshot to look, and prefer update_blocks, replace_text and recolor_frames for edits. Each tool call is one undo step for the person at the canvas.' });
  }
  if (method.startsWith('notifications/')) return null;
  if (method === 'ping') return reply({});
  if (method === 'tools/list') return reply({ tools: toolsFor(roomId) });
  if (method === 'tools/call') {
    const name = params && params.name; const args = (params && params.arguments) || {};
    if (!toolsFor(roomId).some(t => t.name === name)) return fail(-32602, `Unknown tool: ${name}`);
    try {
      const out = await callBrowser(roomId, name, args);
      const content = [];
      if (out && typeof out === 'object' && typeof out.image === 'string' && /^data:image\/(png|jpeg);base64,/.test(out.image)) {
        const [, mime, data] = /^data:(image\/[a-z]+);base64,(.*)$/s.exec(out.image); content.push({ type: 'image', data, mimeType: mime });
        const { image, ...rest } = out; content.push({ type: 'text', text: JSON.stringify(rest, null, 2) });
      } else content.push({ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) });
      return reply({ content, isError: false });
    } catch (e) { return reply({ content: [{ type: 'text', text: e.message }], isError: true }); }
  }
  if (method === 'resources/list') return reply({ resources: [] });
  if (method === 'prompts/list') return reply({ prompts: [] });
  return fail(-32601, `Method not found: ${method}`);
}

// ---- HTTP ------------------------------------------------------------------------------------------------------------
function hostOk(req) {
  if (!LOCAL) return true; // a public deployment sits behind its own proxy and LG_TOKEN
  const h = String(req.headers.host || '').replace(/:\d+$/, '');
  return /^(127\.0\.0\.1|localhost|\[::1\])$/.test(h);
}
function tokenOk(req, url) {
  if (!TOKEN) return true;
  const auth = String(req.headers.authorization || ''); return auth === 'Bearer ' + TOKEN || url.searchParams.get('token') === TOKEN;
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => { const parts = []; let n = 0; req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('too large')); req.destroy(); } else parts.push(c); }); req.on('end', () => resolve(Buffer.concat(parts))); req.on('error', reject); });
}
function send(res, code, body, headers = {}) { res.writeHead(code, { 'cache-control': 'no-store', ...headers }); res.end(body); }
const json = (res, code, obj, headers = {}) => send(res, code, JSON.stringify(obj), { 'content-type': 'application/json', ...headers });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!hostOk(req)) return send(res, 403, 'Forbidden host');
  try {
    if (url.pathname === '/api/ping') return json(res, 200, { lg: true, version: VERSION, rooms: rooms.size });
    if (url.pathname === '/api/stats') {
      const cu = process.cpuUsage(), mu = process.memoryUsage(); const lag = stats.lag.slice().sort((a, b) => a - b);
      return json(res, 200, { version: VERSION, uptimeS: Math.round(process.uptime()), rooms: rooms.size, clients: [...rooms.values()].reduce((t, r) => t + r.clients.size, 0), records: [...rooms.values()].reduce((t, r) => t + r.recs.size, 0),
        cpuMs: Math.round((cu.user + cu.system) / 1000), rssMB: +(mu.rss / 1048576).toFixed(1), heapMB: +(mu.heapUsed / 1048576).toFixed(1), msgsOut: stats.msgsOut, bytesOut: stats.bytesOut, msgsIn: stats.msgsIn, bytesIn: stats.bytesIn, dropped: stats.dropped, saves: stats.saves, saveMsMax: stats.saveMsMax,
        loopLagP95Ms: lag.length ? lag[Math.floor(lag.length * 0.95)] : 0, loopLagMaxMs: lag.length ? lag[lag.length - 1] : 0 });
    }
    if (url.pathname === '/mcp') {
      if (!tokenOk(req, url)) return json(res, 401, { error: 'token required' });
      if (req.method === 'GET') return send(res, 405, '', { allow: 'POST, DELETE' });
      if (req.method === 'DELETE') { sessions.delete(req.headers['mcp-session-id']); return send(res, 200, ''); }
      if (req.method !== 'POST') return send(res, 405, '', { allow: 'POST' });
      const body = JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString('utf8') || 'null');
      const sess = sessions.get(req.headers['mcp-session-id']);
      const roomId = validRoom(url.searchParams.get('room')) ? url.searchParams.get('room') : (sess && sess.roomId) || null;
      const msgs = Array.isArray(body) ? body : [body];
      const headers = {};
      if (msgs.some(m => m && m.method === 'initialize')) { const sid = randomBytes(12).toString('hex'); sessions.set(sid, { roomId, at: Date.now() }); headers['mcp-session-id'] = sid; }
      const out = (await Promise.all(msgs.map(m => mcpHandle(m, roomId)))).filter(Boolean);
      if (!out.length) return send(res, 202, '');
      return json(res, 200, Array.isArray(body) ? out : out[0], headers);
    }
    // A Google Slides deck shared "anyone with the link", exported as .pptx (the browser cannot fetch it itself).
    if (url.pathname === '/api/gslides') {
      const id = url.searchParams.get('id') || '';
      if (!/^[A-Za-z0-9_-]{20,100}$/.test(id)) return send(res, 400, 'Not a Google Slides id');
      let r;
      try { r = await fetch(`https://docs.google.com/presentation/d/${id}/export/pptx`, { redirect: 'follow' }); } catch (e) { return send(res, 502, 'Could not reach Google: ' + e.message); }
      const type = String(r.headers.get('content-type') || '');
      if (!r.ok || /text\/html/.test(type)) return send(res, 403, 'Google did not share that deck. Set it to "Anyone with the link can view", or download it as .pptx and drop it on the canvas.');
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 150 * 1024 * 1024) return send(res, 413, 'That deck is over 150 MB');
      return send(res, 200, buf, { 'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
    }
    if (url.pathname === '/api/projects') {
      const P = await getProjects(); const who = whoOf(req, url); remember(who).catch(() => { });
      if (req.method === 'GET') return json(res, 200, projectsBody(P, who));
      if (req.method !== 'POST') return send(res, 405, '', { allow: 'GET, POST' });
      const m = JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString('utf8') || 'null') || {};
      try { projectOp(P, m, who, isAdminReq(req)); } catch (e) { return send(res, 400, e.message); }
      saveProjects(); broadcastProjects(); if (m.op === 'putFolder' || m.op === 'patch' || m.op === 'put') enforceRooms(P);
      return json(res, 200, projectsBody(P, who));
    }
    // The "share with" picker: people this server has seen, by name (8 at most), or the names for some ids.
    if (url.pathname === '/api/people') {
      const P = await getPeople(); const q = String(url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 80);
      const ids = String(url.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 200);
      let list = ids.length ? ids.map(id => P.get(id)).filter(Boolean) : [...P.values()].filter(p => p.name && (!q || p.name.toLowerCase().includes(q) || (p.id.startsWith('sso:') && p.id.includes(q)))).sort((a, b) => b.seen - a.seen).slice(0, 8);
      return json(res, 200, { people: list.map(p => ({ id: p.id, name: p.name })) });
    }
    if (url.pathname === '/api/events' && req.method === 'POST') {
      const m = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8') || 'null');
      try { await appendEvents(m); } catch (e) { return send(res, 400, e.message); }
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/analytics') {
      if (ADMIN_KEY && String(req.headers['x-lg-admin'] || '') !== ADMIN_KEY) return send(res, 401, 'admin key required');
      const months = String(url.searchParams.get('months') || '').split(',').filter(Boolean).slice(0, 12);
      return json(res, 200, { summaries: await analytics(months) });
    }
    if (url.pathname === '/api/libraries') {
      const L = await getLibs();
      if (req.method === 'GET') return json(res, 200, libsBody(L));
      if (req.method !== 'POST') return send(res, 405, '', { allow: 'GET, POST' });
      const m = JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString('utf8') || 'null') || {};
      const open = m.op === 'putNote' && m.note && (m.note.status === 'open' || m.note.status === 'withdrawn');
      if (ADMIN_KEY && !open && String(req.headers['x-lg-admin'] || '') !== ADMIN_KEY) return send(res, 401, 'admin key required');
      try { libOp(L, m); } catch (e) { return send(res, 400, e.message); }
      if (m.op !== 'check') { saveLibs(); broadcastLibs(); }
      // item writes answer small (a big import is hundreds of them); library changes send everything back
      return json(res, 200, m.op === 'putItem' || m.op === 'delItem' ? { ok: true } : libsBody(L));
    }
    if (url.pathname === '/api/assets' && req.method === 'POST') {
      const type = String(req.headers['content-type'] || '').split(';')[0];
      const ext = EXT_BY_TYPE[type]; if (!ext) return json(res, 415, { error: 'images only' });
      const data = await readBody(req, 25 * 1024 * 1024);
      const hash = createHash('sha1').update(data).digest('hex');
      await mkdir(path.join(DATA, 'assets'), { recursive: true });
      const file = hash + ext; const full = path.join(DATA, 'assets', file);
      if (!existsSync(full)) await writeFile(full, data);
      return json(res, 200, { id: 'a_' + hash.slice(0, 16), url: '/assets/' + file });
    }
    if (url.pathname.startsWith('/assets/')) {
      const name = path.basename(url.pathname); if (!/^[0-9a-f]{40}\.(png|jpg|gif|webp|svg)$/.test(name)) return send(res, 404, 'not found');
      const full = path.join(DATA, 'assets', name);
      try { const data = await readFile(full); return send(res, 200, data, { 'content-type': TYPES[path.extname(name)] || 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable' }); } catch { return send(res, 404, 'not found'); }
    }
    if (url.pathname.startsWith('/api/rooms/')) {
      const id = url.pathname.slice('/api/rooms/'.length); if (!validRoom(id)) return send(res, 404, 'not found');
      const P = await getProjects(); const pr = P.projects.get(id); if (pr && !canSeeProject(P, pr, whoOf(req, url))) return send(res, 404, 'not found');
      const r = await getRoom(id); return json(res, 200, { id, clients: r.clients.size, recs: [...r.recs.values()] });
    }
    // static files from the app folder
    let p = decodeURIComponent(url.pathname); if (p === '/' || p === '') p = '/index.html';
    const full = path.resolve(ROOT, '.' + p);
    if (!full.startsWith(ROOT + path.sep) || /[\\/](server[\\/]data|\.git)([\\/]|$)/.test(full)) return send(res, 404, 'not found');
    const st = await stat(full).catch(() => null); if (!st || !st.isFile()) return send(res, 404, 'not found');
    return send(res, 200, await readFile(full), { 'content-type': TYPES[path.extname(full)] || 'application/octet-stream' });
  } catch (e) { log('error', req.method, url.pathname, e.message); if (!res.headersSent) json(res, 500, { error: e.message }); }
});
server.on('upgrade', async (req, socket) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/sync' || !hostOk(req) || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const roomId = url.searchParams.get('room'); if (!validRoom(roomId)) { socket.destroy(); return; }
  // A project's room is open to whoever may see the project.
  const who = whoOf(req, url); const P = await getProjects(); const pr = P.projects.get(roomId);
  const conn = wsAccept(req, socket); if (!conn) return; conn.who = who;
  if (pr && !canSeeProject(P, pr, who)) { sendJSON(conn, { t: 'denied', reason: 'This project is not shared with you' }); setTimeout(() => closeConn(conn), 50); return; }
  await joinRoom(conn, roomId);
});
server.listen(PORT, HOST, () => {
  log(`Layout Engine on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  log(`MCP endpoint: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/mcp${TOKEN ? ' (token required)' : ''}`);
  if (!LOCAL && !TOKEN) log('Warning: listening beyond localhost without LG_TOKEN. Anyone who can reach this port can use the MCP endpoint.');
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { for (const r of rooms.values()) { clearTimeout(r.saveTimer); try { await mkdir(path.join(DATA, 'rooms'), { recursive: true }); await writeFile(path.join(DATA, 'rooms', r.id + '.json'), JSON.stringify({ v: 1, id: r.id, recs: [...r.recs.values()] })); } catch { } } process.exit(0); });
