#!/usr/bin/env node
// Tiny CLI for agents and scripts that don't use MCP. Talks to the running server.
//   node videditor/cli.mjs projects
//   node videditor/cli.mjs feedback <projectId> [--version <id>] [--all]
//   node videditor/cli.mjs prompt <projectId> [--version <id>]
//   node videditor/cli.mjs add-version <projectId> <file.mp4> [--notes "..."] [--label v3]
//   node videditor/cli.mjs reply <feedbackId> "text" [--done]
//   node videditor/cli.mjs done <feedbackId>
//   node videditor/cli.mjs wait <projectId>
// Env: VIDEDITOR_URL (default http://localhost:8787)
import fs from 'node:fs';
import path from 'node:path';
const BASE = (process.env.VIDEDITOR_URL || 'http://localhost:8787').replace(/\/$/, '');
const [cmd, ...rest] = process.argv.slice(2);
const flags = {}; const args = [];
for (let i = 0; i < rest.length; i++) { if (rest[i].startsWith('--')) { const k = rest[i].slice(2); const v = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true; flags[k] = v; } else args.push(rest[i]); }
async function api(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); if (!r.ok) { console.error(`Error: ${t}`); process.exit(1); }
  try { return JSON.parse(t); } catch { return t; }
}
const fmt = (s) => (s === null || s === undefined ? '–' : `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`);
try {
  switch (cmd) {
    case 'projects': { const s = await api('GET', '/api/state'); for (const p of s.projects) console.log(`${p.id}\t${p.name}\t${p.versions.map((v) => `${v.label}:${v.id}`).join(' ')}${p.hyperframesDir ? `\t${p.hyperframesDir}` : ''}`); break; }
    case 'feedback': { const p = await api('GET', `/api/projects/${args[0]}`); const vid = flags.version || p.latest?.id; const items = await api('GET', `/api/feedback?versionId=${vid}${flags.all ? '' : '&status=open'}`); for (const f of items.filter((f) => !f.replyTo)) console.log(`${f.id}\t${fmt(f.time)}\t${f.status}\t${f.author}\t${(f.body || f.transcript || '').replace(/\n/g, ' ')}${f.clipContext?.length ? `\n\t on screen: ${f.clipContext.map((c) => c.label).join('; ')}` : ''}`); break; }
    case 'prompt': console.log(await api('GET', `/api/projects/${args[0]}/prompt${flags.version ? `?versionId=${flags.version}` : ''}`)); break;
    case 'add-version': { const p = await api('GET', `/api/projects/${args[0]}`); const abs = path.isAbsolute(args[1]) ? args[1] : path.resolve(p.hyperframesDir || process.cwd(), args[1]); if (!fs.existsSync(abs)) { console.error(`File not found: ${abs}`); process.exit(1); } const v = await api('POST', `/api/projects/${args[0]}/versions`, { path: abs, notes: flags.notes || '', label: flags.label, postedByAgent: true }); console.log(`Registered ${v.label} (${v.id}) → ${BASE}/#/p/${args[0]}?v=${v.id}`); break; }
    case 'reply': { const parent = await api('GET', `/api/feedback/${args[0]}`); const f = await api('POST', '/api/feedback', { versionId: parent.versionId, replyTo: parent.id, body: args[1] || '', author: process.env.VIDEDITOR_AGENT_NAME || 'Agent', postedByAgent: true }); if (flags.done) await api('PATCH', `/api/feedback/${parent.id}`, { status: 'done' }); console.log(`Replied ${f.id}${flags.done ? ', marked done' : ''}`); break; }
    case 'done': await api('PATCH', `/api/feedback/${args[0]}`, { status: 'done' }); console.log('Marked done'); break;
    case 'wait': { const r = await api('GET', `/api/feedback/wait?projectId=${args[0]}&timeout=45000&humanOnly=1`); console.log(r.items.length ? JSON.stringify(r.items, null, 2) : 'No new feedback (timed out).'); break; }
    default: console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  }
} catch (e) { console.error(`Error: ${e.message}${/fetch failed/.test(e.message) ? ` (is the server running at ${BASE}?)` : ''}`); process.exit(1); }
