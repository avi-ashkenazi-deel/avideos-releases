#!/usr/bin/env node
// Videditor MCP server (stdio). Lets Claude Code / Cursor / Codex read review
// feedback, fetch annotated frames, post replies, and register new versions.
// Zero dependencies: speaks MCP JSON-RPC over newline-delimited stdio.
//   claude mcp add videditor -- node /path/to/videditor/mcp.mjs
// Env: VIDEDITOR_URL (default http://localhost:8787)
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.env.VIDEDITOR_URL || 'http://localhost:8787').replace(/\/$/, '');
const AGENT = process.env.VIDEDITOR_AGENT_NAME || 'Agent';

async function api(method, p, body, raw = false) {
  const r = await fetch(BASE + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) { let msg = r.statusText; try { msg = (await r.json()).error || msg; } catch {} throw new Error(`${method} ${p}: ${msg}`); }
  return raw ? r : r.json();
}
const text = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] });
const fmt = (s) => (s === null || s === undefined ? '–' : `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`);

async function imageFromUrl(url) {
  const r = await fetch(url); if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
  const mimeType = (r.headers.get('content-type') || 'image/png').split(';')[0];
  return { type: 'image', data: Buffer.from(await r.arrayBuffer()).toString('base64'), mimeType };
}

const TOOLS = [
  { name: 'get_guide', description: 'Read the Videditor playbook first: how to read feedback, change the video, register a version, and close the loop.', inputSchema: { type: 'object', properties: {} } },
  { name: 'projects_list', description: 'List review projects with their versions and open-feedback counts.', inputSchema: { type: 'object', properties: {} } },
  { name: 'project_get', description: 'Get one project: versions, composition folder, stats.', inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] } },
  { name: 'feedback_list', description: 'List feedback on a project or version. Each item has time (seconds), body, transcript, pointing phrases, drawing summary, annotated frame URLs, status and which clips were on screen.', inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, version_id: { type: 'string', description: 'Defaults to the latest version' }, status: { type: 'string', enum: ['open', 'done'] }, include_replies: { type: 'boolean' } }, required: ['project_id'] } },
  { name: 'feedback_get', description: 'Get one feedback item with its full reply thread.', inputSchema: { type: 'object', properties: { feedback_id: { type: 'string' } }, required: ['feedback_id'] } },
  { name: 'get_annotated_frame', description: 'Return the frames the reviewer captured for a feedback item (with their drawing burned in, and one per pointing phrase).', inputSchema: { type: 'object', properties: { feedback_id: { type: 'string' } }, required: ['feedback_id'] } },
  { name: 'get_frame', description: 'Return the video frame of a version at a given time in seconds.', inputSchema: { type: 'object', properties: { version_id: { type: 'string' }, time: { type: 'number' } }, required: ['version_id', 'time'] } },
  { name: 'feedback_post', description: 'Post a comment (Markdown) on a version, optionally anchored to a time, or reply in a thread with reply_to.', inputSchema: { type: 'object', properties: { version_id: { type: 'string' }, body: { type: 'string' }, time: { type: 'number' }, reply_to: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['body'] } },
  { name: 'feedback_update', description: 'Change a feedback item: status (open/done), tags, body.', inputSchema: { type: 'object', properties: { feedback_id: { type: 'string' }, status: { type: 'string', enum: ['open', 'done'] }, tags: { type: 'array', items: { type: 'string' } }, body: { type: 'string' } }, required: ['feedback_id'] } },
  { name: 'version_add', description: 'Register a rendered video file as the next version of a project, with Markdown release notes (what changed and which feedback it addresses).', inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, file: { type: 'string', description: 'Path to the MP4; relative paths resolve against the project folder' }, notes: { type: 'string' }, label: { type: 'string' } }, required: ['project_id', 'file'] } },
  { name: 'render_version', description: 'Render the project composition (index.html) to MP4 with Videditor and register it as the next version with Markdown notes. Blocks until the render finishes.', inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, notes: { type: 'string' }, quality: { type: 'string', enum: ['draft', 'looks', 'high'] } }, required: ['project_id'] } },
  { name: 'version_notes_update', description: 'Edit the notes of a version.', inputSchema: { type: 'object', properties: { version_id: { type: 'string' }, notes: { type: 'string' } }, required: ['version_id', 'notes'] } },
  { name: 'wait_for_feedback', description: 'Block up to 45 seconds until a human posts new feedback on the project, then return it.', inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, since: { type: 'string', description: 'ISO time; defaults to now' }, timeout_seconds: { type: 'number' } }, required: ['project_id'] } },
  { name: 'composition_at', description: 'List the clips on screen at a time, or the whole parsed composition when time is omitted.', inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, time: { type: 'number' } }, required: ['project_id'] } },
  { name: 'get_prompt', description: 'Get the full review brief for a version (the same text as the Copy Prompt button).', inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, version_id: { type: 'string' } }, required: ['project_id'] } },
];

function summarize(f, withContext = true) {
  const parts = [`[${f.id}] ${f.time === null ? 'whole video' : f.timeEnd ? `${fmt(f.time)}–${fmt(f.timeEnd)}` : fmt(f.time)} · ${f.author}${f.postedByAgent ? ' (agent)' : ''} · ${f.kind} · ${f.status}${f.tags?.length ? ' · ' + f.tags.join(',') : ''}`];
  if (f.body) parts.push(`  ${f.body.replace(/\n+/g, ' ')}`);
  if (f.transcript) parts.push(`  transcript: "${f.transcript}"`);
  if (f.visualReferences?.length) parts.push(`  pointing: ${f.visualReferences.map((r) => `"${r.phrase}"@${fmt(r.time)}`).join(', ')}`);
  if (f.drawing?.strokes?.length) parts.push(`  drawing: ${f.drawing.strokes.length} stroke(s), use get_annotated_frame`);
  if (f.frames?.length) parts.push(`  frames: ${f.frames.length}`);
  if (withContext && f.clipContext?.length) parts.push(`  on screen: ${f.clipContext.map((c) => c.label).join('; ')}`);
  return parts.join('\n');
}

async function call(name, a = {}) {
  switch (name) {
    case 'get_guide': return text(await (await api('GET', '/api/guide', null, true)).text());
    case 'projects_list': { const s = await api('GET', '/api/state'); return text(s.projects.map((p) => `${p.id}  ${p.name}  versions: ${p.versions.map((v) => `${v.label}(${v.id}, open ${v.openCount})`).join(', ') || 'none'}${p.dir ? `  folder: ${p.dir}` : ''}`).join('\n') || 'No projects yet.'); }
    case 'project_get': return text(await api('GET', `/api/projects/${a.project_id}`));
    case 'feedback_list': {
      const p = await api('GET', `/api/projects/${a.project_id}`);
      const vid = a.version_id || p.latest?.id; if (!vid) return text('Project has no versions yet.');
      let items = await api('GET', `/api/feedback?versionId=${vid}${a.status ? `&status=${a.status}` : ''}`);
      if (!a.include_replies) items = items.filter((f) => !f.replyTo);
      return text(`${p.name} ${p.versions.find((v) => v.id === vid)?.label || ''} (${vid}) — ${items.length} item(s)\n\n` + (items.map((f) => summarize(f)).join('\n\n') || 'No feedback.'));
    }
    case 'feedback_get': { const f = await api('GET', `/api/feedback/${a.feedback_id}`); return text(summarize(f) + (f.replies?.length ? '\n\nreplies:\n' + f.replies.map((r) => `  - ${r.author}${r.postedByAgent ? ' (agent)' : ''}: ${r.body}`).join('\n') : '') + '\n\n' + JSON.stringify({ frames: f.frames, refs: f.refs, audioUrl: f.audioUrl, drawing: f.drawing }, null, 2)); }
    case 'get_annotated_frame': {
      const f = await api('GET', `/api/feedback/${a.feedback_id}`);
      if (!f.frames?.length) { if (f.time !== null) { const img = await imageFromUrl(`${BASE}/api/versions/${f.versionId}/frame?t=${f.time}`); return { content: [{ type: 'text', text: `No annotated frame saved; plain frame at ${fmt(f.time)}.` }, img] }; } return text('This note has no frame and no timestamp.'); }
      const content = [];
      for (const fr of f.frames) { content.push({ type: 'text', text: `${fr.label || 'frame'} at ${fmt(fr.time)}` }); content.push(await imageFromUrl(BASE + fr.url)); }
      return { content };
    }
    case 'get_frame': return { content: [{ type: 'text', text: `Frame at ${fmt(a.time)}` }, await imageFromUrl(`${BASE}/api/versions/${a.version_id}/frame?t=${a.time}`)] };
    case 'feedback_post': {
      let versionId = a.version_id;
      if (a.reply_to) { const parent = await api('GET', `/api/feedback/${a.reply_to}`); versionId = parent.versionId; }
      if (!versionId) throw new Error('version_id or reply_to is required');
      const f = await api('POST', '/api/feedback', { versionId, body: a.body, time: a.time, replyTo: a.reply_to || null, tags: a.tags || [], author: AGENT, postedByAgent: true, kind: 'text' });
      return text(`Posted ${f.id}${a.reply_to ? ` as a reply to ${a.reply_to}` : ''}.`);
    }
    case 'feedback_update': { const f = await api('PATCH', `/api/feedback/${a.feedback_id}`, { status: a.status, tags: a.tags, body: a.body }); return text(`Updated ${f.id}: status ${f.status}${f.tags?.length ? ', tags ' + f.tags.join(',') : ''}.`); }
    case 'version_add': {
      const p = await api('GET', `/api/projects/${a.project_id}`);
      const abs = path.isAbsolute(a.file) ? a.file : path.resolve(p.dir || process.cwd(), a.file);
      if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
      const v = await api('POST', `/api/projects/${a.project_id}/versions`, { path: abs, notes: a.notes || '', label: a.label, postedByAgent: true, source: 'agent' });
      return text(`Registered ${v.label} (${v.id}) from ${abs}. Review it at ${BASE}/#/p/${a.project_id}?v=${v.id}`);
    }
    case 'render_version': {
      const { jobId } = await api('POST', `/api/projects/${a.project_id}/render`, { quality: a.quality || 'looks', notes: a.notes || '' });
      for (let i = 0; i < 900; i++) { await new Promise((r) => setTimeout(r, 1000)); const j = await api('GET', `/api/jobs/${jobId}`); if (j.done) { const last = j.lines.filter((l) => l.type === 'log').slice(-3).map((l) => l.text).join('\n'); if (!j.ok) throw new Error(`Render failed:\n${last}`); return text(`Rendered and registered version ${j.versionId}.\n${last}\nReview: ${BASE}/#/p/${a.project_id}?v=${j.versionId}`); } }
      throw new Error('Render timed out after 15 minutes');
    }
    case 'version_notes_update': { const v = await api('PATCH', `/api/versions/${a.version_id}`, { notes: a.notes }); return text(`Notes updated on ${v.label}.`); }
    case 'wait_for_feedback': { const r = await api('GET', `/api/feedback/wait?projectId=${a.project_id}&since=${encodeURIComponent(a.since || new Date().toISOString())}&timeout=${Math.min(45, a.timeout_seconds || 40) * 1000}&humanOnly=1`); return text(r.items.length ? `${r.items.length} new item(s):\n\n` + r.items.map((f) => summarize(f)).join('\n\n') : 'No new feedback yet. Call again to keep waiting.'); }
    case 'composition_at': { const c = await api('GET', `/api/projects/${a.project_id}/composition${a.time !== undefined ? `?t=${a.time}` : ''}`); if (!c) return text('Project has no composition folder.'); if (a.time !== undefined) return text(c.clips.length ? c.clips.map((x) => x.label).join('\n') : 'Nothing timed on screen at that moment.'); return text(c); }
    case 'get_prompt': return text(await (await api('GET', `/api/projects/${a.project_id}/prompt${a.version_id ? `?versionId=${a.version_id}` : ''}`, null, true)).text());
    default: throw new Error(`Unknown tool ${name}`);
  }
}

// ---- JSON-RPC over stdio
const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const rl = readline.createInterface({ input: process.stdin });
let pending = 0; let closed = false;
const maybeExit = () => { if (closed && pending === 0) process.exit(0); };
rl.on('line', async (line) => {
  line = line.trim(); if (!line) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  const reply = (result) => { if (id !== undefined) out({ jsonrpc: '2.0', id, result }); };
  const fail = (code, message) => { if (id !== undefined) out({ jsonrpc: '2.0', id, error: { code, message } }); };
  try {
    switch (method) {
      case 'initialize': return reply({ protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'videditor', version: '0.1.0' }, instructions: 'Video review feedback for agents. Call get_guide first, then feedback_list for the project you are working on.' });
      case 'notifications/initialized': case 'notifications/cancelled': return;
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: TOOLS });
      case 'tools/call': {
        pending++;
        try { return reply(await call(params.name, params.arguments || {})); }
        catch (e) { return reply({ content: [{ type: 'text', text: `Error: ${e.message}${/ECONNREFUSED|fetch failed/.test(e.message) ? ` — is the Videditor server running at ${BASE}? Start it with: node videditor/server.mjs` : ''}` }], isError: true }); }
        finally { pending--; maybeExit(); }
      }
      case 'resources/list': return reply({ resources: [] });
      case 'prompts/list': return reply({ prompts: [] });
      default: return fail(-32601, `Method not found: ${method}`);
    }
  } catch (e) { fail(-32603, e.message); }
});
rl.on('close', () => { closed = true; maybeExit(); });
