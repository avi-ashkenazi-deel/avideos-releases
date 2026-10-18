#!/usr/bin/env node
/* Dugma from the terminal, against a self-hosted server (node server/server.mjs): read a canvas as JSON, list its
   screens, check a file against the schema, and print the line that connects Claude Code (or Cursor, Codex) over MCP.

     node tools/dugma-cli.mjs rooms                       the canvases (projects) the server knows
     node tools/dugma-cli.mjs get <room> [out.json]       a canvas as a document (Save JSON shape)
     node tools/dugma-cli.mjs frames <room>               its screens: id, name, size, position, blocks
     node tools/dugma-cli.mjs validate <file.json>        check a canvas file against schema/canvas.schema.json
     node tools/dugma-cli.mjs mcp [room]                  the `claude mcp add` line for this server
     node tools/dugma-cli.mjs schema                      print the schema

   Server: --server http://host:8787 or DUGMA_SERVER (default http://localhost:8787). A server started with a token
   takes --token or DUGMA_TOKEN. Writes go through the MCP tools (write_layout, update_blocks…), never raw records. */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2); const opt = {}; const rest = [];
for (let i = 0; i < args.length; i++) { const a = args[i]; if (a.startsWith('--')) { opt[a.slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true; } else rest.push(a); }
const SERVER = String(opt.server || process.env.DUGMA_SERVER || 'http://localhost:8787').replace(/\/$/, '');
const TOKEN = opt.token || process.env.DUGMA_TOKEN || '';
const [cmd, ...pos] = rest;

const die = (m, code = 1) => { console.error(m); process.exit(code); };
async function api(p) {
  const r = await fetch(SERVER + p, { headers: TOKEN ? { authorization: 'Bearer ' + TOKEN, 'x-lg-token': TOKEN } : {} }).catch(e => die(`Cannot reach ${SERVER}: ${e.message}. Start the server with node server/server.mjs, or pass --server.`));
  if (!r.ok) die(`${p}: ${r.status} ${await r.text()}`);
  return r.json();
}

// Records (one per screen, block, library item, comment) back into one document, newest version of each.
function docFromRecords(recs, name) {
  const by = new Map(); for (const r of recs) { if (!r || !r._k || r._del) continue; const o = by.get(r._k); if (!o || (r._v || 0) > (o._v || 0)) by.set(r._k, r); }
  const strip = r => { const { _k, _v, _by, _del, ...rest } = r; return rest; };
  const doc = { v: 1, name: (by.get('meta') || {}).name || name || 'Canvas', frames: [], library: [], comments: [], view: { x: 0, y: 0, zoom: 0.5 }, grid: { unit: 8, snap: true } };
  const frames = [...by.entries()].filter(([k]) => k.startsWith('f~')).sort((a, b) => (a[1].z ?? 0) - (b[1].z ?? 0) || a[0].localeCompare(b[0]));
  for (const [k, fr] of frames) {
    const fid = k.slice(2); const f = strip(fr); const { z, order, ...frame } = f; frame.layout = { ...(frame.layout || {}), blocks: [] };
    const blocks = [...by.entries()].filter(([bk]) => bk.startsWith(`b~${fid}~`)).map(([, b]) => strip(b));
    const ord = Array.isArray(order) ? order : []; blocks.sort((a, b) => { const ia = ord.indexOf(a.id), ib = ord.indexOf(b.id); return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib); });
    frame.layout.blocks = blocks; const o = by.get(`o~${fid}`); if (o) { frame.layout.meta = frame.layout.meta || {}; frame.layout.meta.original = strip(o).original || strip(o); }
    doc.frames.push(frame);
  }
  for (const [k, r] of by) { if (k.startsWith('L~')) doc.library.push(strip(r)); else if (k.startsWith('C~')) doc.comments.push(strip(r)); }
  doc.library.sort((a, b) => (a.created || 0) - (b.created || 0)); doc.comments.sort((a, b) => (a.at || 0) - (b.at || 0));
  return doc;
}

async function validate(doc) {
  const schema = JSON.parse(await readFile(path.join(here, '..', 'schema', 'canvas.schema.json'), 'utf8'));
  let Ajv; try { Ajv = (await import('ajv/dist/2020.js')).default; } catch { return { ok: null, note: 'npm i ajv for a full check; shape check only', errors: shapeCheck(doc) }; }
  const ajv = new Ajv({ allErrors: true, strict: false }); const ok = ajv.validate(schema, doc);
  return { ok, errors: ok ? [] : ajv.errors.map(e => `${e.instancePath || '/'} ${e.message}`) };
}
// Without ajv: the few rules that matter most.
function shapeCheck(doc) {
  const errs = []; if (!Array.isArray(doc.frames)) return ['frames must be an array'];
  doc.frames.forEach((f, i) => {
    if (!f.id) errs.push(`/frames/${i}: id missing`); if (!f.layout || !f.layout.format) errs.push(`/frames/${i}: layout.format missing`);
    const ids = new Set(); for (const b of (f.layout && f.layout.blocks) || []) { if (!b.id || !b.kind) errs.push(`/frames/${i}: a block has no id or kind`); if (ids.has(b.id)) errs.push(`/frames/${i}: block id ${b.id} twice`); ids.add(b.id); if (b.parent && !ids.has(b.parent) && !((f.layout.blocks || []).some(x => x.id === b.parent))) errs.push(`/frames/${i}: block ${b.id} has an unknown parent`); }
  });
  return errs;
}

(async () => {
  if (!cmd || cmd === 'help' || opt.help) { console.log((await readFile(fileURLToPath(import.meta.url), 'utf8')).split('*/')[0].replace(/^\/\*\s?/, '')); return; }
  if (cmd === 'schema') { process.stdout.write(await readFile(path.join(here, '..', 'schema', 'canvas.schema.json'), 'utf8')); return; }
  if (cmd === 'mcp') { const room = pos[0] || opt.room; console.log(`claude mcp add dugma --transport http ${SERVER}/mcp${room ? '?room=' + encodeURIComponent(room) : ''}${TOKEN ? ' --header "Authorization: Bearer ' + TOKEN + '"' : ''}`); return; }
  if (cmd === 'validate') { const file = pos[0]; if (!file) die('validate <file.json>'); const doc = JSON.parse(await readFile(file, 'utf8')); const r = await validate(doc); if (r.note) console.error(r.note); if (r.errors.length) { console.log(r.errors.slice(0, 40).join('\n')); die(`${r.errors.length} problem${r.errors.length > 1 ? 's' : ''}`); } console.log(`ok: ${doc.frames.length} screen${doc.frames.length === 1 ? '' : 's'}, ${doc.frames.reduce((n, f) => n + ((f.layout && f.layout.blocks) || []).length, 0)} blocks`); return; }
  if (cmd === 'rooms') { const p = await api('/api/projects'); const list = p.projects || p.list || p; for (const x of Array.isArray(list) ? list : Object.values(list)) console.log(`${x.id}\t${x.kind || 'canvas'}\t${x.name || ''}${x.frames != null ? `\t${x.frames} screens` : ''}`); return; }
  if (cmd === 'get' || cmd === 'frames') {
    const room = pos[0] || opt.room; if (!room) die(`${cmd} <room>`);
    const r = await api(`/api/rooms/${encodeURIComponent(room)}`); const doc = docFromRecords(r.recs || [], room);
    if (cmd === 'frames') { for (const f of doc.frames) console.log(`${f.id}\t${f.name || ''}\t${f.layout.format.w}×${f.layout.format.h}\t@${Math.round(f.x)},${Math.round(f.y)}\t${f.layout.blocks.length} blocks${f.theme ? '\t' + f.theme : ''}`); console.error(`${doc.frames.length} screens, ${doc.comments.length} comments, ${r.clients} here now`); return; }
    const out = JSON.stringify(doc, null, 1); if (pos[1]) { await writeFile(pos[1], out); console.error(`wrote ${pos[1]} (${doc.frames.length} screens)`); } else process.stdout.write(out); return;
  }
  die(`Unknown command "${cmd}". Try: rooms, get, frames, validate, mcp, schema.`);
})().catch(e => die(e.message));
