#!/usr/bin/env node
// Layout Engine server: serves the app, hosts live canvas rooms over WebSocket, stores shared images, and exposes the
// canvas to outside agents (Claude Code, Cursor, Codex) as an MCP server, the way Paper does. No dependencies.
//
//   node server/server.mjs            → http://127.0.0.1:8787
//   PORT=9000 HOST=0.0.0.0 LG_TOKEN=secret node server/server.mjs
//
// Rooms live in memory and are saved to server/data/rooms/<id>.json. Images go to server/data/assets/.
// MCP: claude mcp add layout --transport http http://127.0.0.1:8787/mcp
// Tool calls are carried out by a browser tab that has the room open (the canvas engine runs there), so keep one open.
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, stat, rename } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(process.env.LG_DATA || path.join(ROOT, 'server', 'data'));
const PORT = +(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.LG_TOKEN || '';
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
  r = { id, recs: new Map(), clients: new Set(), saveTimer: null, loaded: false };
  rooms.set(id, r);
  try { const j = JSON.parse(await readFile(path.join(DATA, 'rooms', id + '.json'), 'utf8')); for (const rec of j.recs || []) if (rec && rec._k) r.recs.set(rec._k, rec); } catch { }
  r.loaded = true; return r;
}
function scheduleSave(r) {
  clearTimeout(r.saveTimer);
  r.saveTimer = setTimeout(async () => {
    try {
      await mkdir(path.join(DATA, 'rooms'), { recursive: true });
      const cutoff = (Date.now() - 86400e3) * 1000; // drop tombstones older than a day
      const recs = [...r.recs.values()].filter(x => !(x._del && x._v < cutoff));
      const file = path.join(DATA, 'rooms', r.id + '.json'); const tmp = file + '.tmp';
      await writeFile(tmp, JSON.stringify({ v: 1, id: r.id, saved: new Date().toISOString(), recs })); await rename(tmp, file);
    } catch (e) { log('save failed', r.id, e.message); }
  }, 1500);
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
  const conn = { id: 'p' + (++connSeq).toString(36), socket, buf: Buffer.alloc(0), frags: [], alive: true, client: {}, p: {}, tools: [], lastActive: Date.now(), room: null, onMessage: null, onClose: null, closed: false };
  socket.on('data', chunk => { conn.buf = Buffer.concat([conn.buf, chunk]); parseFrames(conn); });
  socket.on('close', () => closeConn(conn)); socket.on('error', () => closeConn(conn)); socket.on('end', () => closeConn(conn));
  return conn;
}
function closeConn(conn) { if (conn.closed) return; conn.closed = true; try { conn.socket.destroy(); } catch { } if (conn.onClose) conn.onClose(); }
function parseFrames(conn) {
  for (;;) {
    const b = conn.buf; if (b.length < 2) return;
    const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0; let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; const hi = b.readUInt32BE(2), lo = b.readUInt32BE(6); len = hi * 2 ** 32 + lo; off = 10; }
    if (len > MAX_MSG) { closeConn(conn); return; }
    const mOff = off; if (masked) off += 4; if (b.length < off + len) return;
    let payload = b.subarray(off, off + len);
    if (masked) { const m = b.subarray(mOff, mOff + 4); payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]; }
    conn.buf = b.subarray(off + len);
    if (op === 0x8) { sendFrame(conn, 0x8, Buffer.alloc(0)); closeConn(conn); return; }
    if (op === 0x9) { sendFrame(conn, 0xA, payload); continue; }
    if (op === 0xA) { conn.alive = true; continue; }
    if (op === 0x1 || op === 0x2 || op === 0x0) {
      conn.frags.push(payload);
      if (conn.frags.reduce((t, f) => t + f.length, 0) > MAX_MSG) { closeConn(conn); return; }
      if (fin) { const msg = Buffer.concat(conn.frags).toString('utf8'); conn.frags = []; if (conn.onMessage) { try { conn.onMessage(msg); } catch (e) { log('message error', e.message); } } }
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
  try { conn.socket.write(Buffer.concat([head, payload])); } catch { closeConn(conn); }
}
const sendJSON = (conn, obj) => sendFrame(conn, 0x1, Buffer.from(JSON.stringify(obj)));
setInterval(() => { for (const r of rooms.values()) for (const c of r.clients) { if (!c.alive) { closeConn(c); continue; } c.alive = false; sendFrame(c, 0x9, Buffer.alloc(0)); } }, 30000).unref();

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
      if (Array.isArray(m.tools)) conn.tools = m.tools.slice(0, 100);
      sendJSON(conn, { t: 'snapshot', recs: [...room.recs.values()] });
      sendJSON(conn, { t: 'peers', list: others().map(c => ({ id: c.id, p: c.p })) });
      for (const c of others()) sendJSON(c, { t: 'presence', id: conn.id, p: conn.p });
      log(`join ${room.id} ${conn.id} ${conn.client.name || ''} (${room.clients.size} here)`);
    } else if (m.t === 'recs' && Array.isArray(m.recs)) {
      const ok = [];
      for (const rec of m.recs) { if (!rec || typeof rec._k !== 'string' || typeof rec._v !== 'number' || rec._k.length > 200) continue; if (newer(rec, room.recs.get(rec._k))) { room.recs.set(rec._k, rec); ok.push(rec); } }
      if (ok.length) { for (const c of others()) sendJSON(c, { t: 'recs', recs: ok }); scheduleSave(room); }
    } else if (m.t === 'presence') {
      conn.p = { ...conn.p, ...cleanPresence(m.p) };
      for (const c of others()) sendJSON(c, { t: 'presence', id: conn.id, p: conn.p });
    } else if (m.t === 'tools' && Array.isArray(m.tools)) conn.tools = m.tools.slice(0, 100);
    else if (m.t === 'rpc-result' && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error)) : p.resolve(m.result); }
  };
  conn.onClose = () => { room.clients.delete(conn); for (const c of room.clients) sendJSON(c, { t: 'leave', id: conn.id }); log(`leave ${room.id} ${conn.id} (${room.clients.size} here)`); };
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
  const conn = wsAccept(req, socket); if (conn) await joinRoom(conn, roomId);
});
server.listen(PORT, HOST, () => {
  log(`Layout Engine on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  log(`MCP endpoint: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/mcp${TOKEN ? ' (token required)' : ''}`);
  if (!LOCAL && !TOKEN) log('Warning: listening beyond localhost without LG_TOKEN. Anyone who can reach this port can use the MCP endpoint.');
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { for (const r of rooms.values()) { clearTimeout(r.saveTimer); try { await mkdir(path.join(DATA, 'rooms'), { recursive: true }); await writeFile(path.join(DATA, 'rooms', r.id + '.json'), JSON.stringify({ v: 1, id: r.id, recs: [...r.recs.values()] })); } catch { } } process.exit(0); });
