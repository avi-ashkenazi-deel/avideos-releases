#!/usr/bin/env node
// Videditor server: static UI + JSON API + media. Zero dependencies.
//   node videditor/server.mjs            → http://localhost:8787
// Env: VIDEDITOR_PORT, VIDEDITOR_DATA (default videditor/data), VIDEDITOR_NO_DEMO=1
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './lib/store.mjs';
import { detectProject, parseProject, clipsAt, describeClip, listFiles, updateClip, updateRoot, createProject, safePath, resolveSrc, readBrand, writeBrand, insertClipHtml } from './lib/composition.mjs';
import { scanMedia, analyzeFile, writeManifest, loadManifest, analysisDirFor, kindOf, ANALYSIS_VERSION } from './lib/analyze.mjs';
import { hasFfmpeg, probe, poster, frameAt } from './lib/media.mjs';
import { buildPrompt } from './lib/prompt.mjs';
import { renderProject, loadPlaywright, captureFrame } from './lib/render.mjs';
import { runClaude, systemPrompt, diagnoseClaude } from './lib/agent.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.VIDEDITOR_PORT || process.env.PORT || 8787);
const DATA = path.resolve(process.env.VIDEDITOR_DATA || path.join(ROOT, 'data'));
const store = new Store(DATA);
const FFMPEG = hasFfmpeg();
const jobs = new Map(); // id -> { id, kind, lines: [], done, ok, listeners:Set, versionId }
const agents = new Map(); // projectId -> running agent handle
const waiters = new Set(); // long-poll feedback waiters
// Older data files used dir; the field is now dir.
for (const p of store.db.projects) if (p['hyperframesDir'] !== undefined) { p.dir = p.dir ?? p['hyperframesDir']; delete p['hyperframesDir']; }

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon' };

// ---------- helpers
const send = (res, code, body, headers = {}) => {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, { 'Content-Type': isObj ? 'application/json' : (headers['Content-Type'] || 'text/plain; charset=utf-8'), 'Access-Control-Allow-Origin': '*', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
};
const err = (res, code, message) => send(res, code, { error: message });
const readJson = (req, limit = 80 * 1024 * 1024) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('Invalid JSON')); } });
  req.on('error', reject);
});
const readToFile = (req, file) => new Promise((resolve, reject) => {
  const ws = fs.createWriteStream(file); let size = 0;
  req.on('data', (c) => { size += c.length; }); req.pipe(ws);
  ws.on('finish', () => resolve(size)); ws.on('error', reject); req.on('error', reject);
});
const safeName = (s) => String(s || 'file').replace(/[^\w.\-]+/g, '_').slice(0, 120);
const dataUrlToFile = (dataUrl, file) => {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl || '');
  if (!m) return null;
  fs.writeFileSync(file, m[2] ? Buffer.from(m[3], 'base64') : decodeURIComponent(m[3]));
  return m[1] || 'application/octet-stream';
};
const extFor = (mime) => ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'video/webm': '.webm', 'video/mp4': '.mp4' }[String(mime).split(';')[0]] || '');
const baseUrl = (req) => `http://${req.headers.host || `localhost:${PORT}`}`;

function serveFile(req, res, file, { download = false } = {}) {
  let st; try { st = fs.statSync(file); } catch { return err(res, 404, 'Not found'); }
  if (!st.isFile()) return err(res, 404, 'Not found');
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': file.startsWith(DATA) ? 'public, max-age=31536000, immutable' : 'no-cache', 'Access-Control-Allow-Origin': '*' };
  if (download) headers['Content-Disposition'] = `attachment; filename="${path.basename(file)}"`;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && st.size > 0) {
    let start = range[1] ? Number(range[1]) : 0; let end = range[2] ? Number(range[2]) : st.size - 1;
    if (!range[1]) { start = Math.max(0, st.size - Number(range[2])); end = st.size - 1; }
    if (start >= st.size || end >= st.size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

function versionView(v) {
  const fb = store.feedback({ versionId: v.id });
  return { ...v, feedbackCount: fb.filter((f) => !f.replyTo).length, openCount: fb.filter((f) => !f.replyTo && f.status === 'open').length };
}
function projectView(p) {
  const versions = store.versions(p.id).map(versionView);
  const latest = versions[versions.length - 1] || null;
  const last = store.feedback({ projectId: p.id }).slice(-1)[0] || null;
  return { ...p, versions, latest, stats: store.stats(p.id), lastActivity: last ? { at: last.createdAt, author: last.author, body: (last.body || last.transcript || '').slice(0, 80) } : null, project: p.dir ? detectProject(p.dir) : null, chat: (p.chat || []).slice(-1)[0] || null, agentRunning: agents.has(p.id) };
}

function registerVersion(project, srcFile, { notes = '', source = 'upload', postedByAgent = false, originalName = null, move = false, label = null } = {}) {
  const id = store.id('ver');
  const ext = path.extname(originalName || srcFile).toLowerCase() || '.mp4';
  const fileName = `${id}${ext}`;
  const dest = path.join(DATA, 'media', fileName);
  if (move) fs.renameSync(srcFile, dest); else fs.copyFileSync(srcFile, dest);
  const info = FFMPEG ? probe(dest) : {};
  let posterUrl = null;
  if (FFMPEG && poster(dest, path.join(DATA, 'media', `${id}.jpg`), Math.min(0.5, (info.duration || 1) / 2))) posterUrl = `/media/media/${id}.jpg`;
  const composition = project.dir ? summarizeComposition(parseProject(project.dir)) : null;
  return store.addVersion(project.id, { id, fileName, filePath: dest, originalName: originalName || path.basename(srcFile), mediaUrl: `/media/media/${fileName}`, posterUrl, notes, source, postedByAgent, ...info, composition, ...(label ? { label } : {}) });
}
const summarizeComposition = (c) => (c ? { id: c.id, width: c.width, height: c.height, duration: c.duration, fps: c.fps, clipCount: c.clips.length } : null);

function notifyWaiters() { for (const w of [...waiters]) w(); }

// Jobs: long-running work (renders, agent runs) streamed to the UI as JSON events over SSE.
function newJob(kind) {
  const job = { id: store.id('job'), kind, lines: [], done: false, ok: null, listeners: new Set(), versionId: null, startedAt: Date.now(), result: null, cost: null };
  jobs.set(job.id, job);
  job.push = (ev) => { const e = typeof ev === 'string' ? { type: 'log', text: ev } : ev; job.lines.push(e); for (const l of job.listeners) l(e); };
  job.finish = (ok, extra = {}) => { job.ok = ok; Object.assign(job, extra); job.done = true; for (const l of job.listeners) l(null); setTimeout(() => jobs.delete(job.id), 30 * 60 * 1000).unref(); };
  return job;
}
const pageUrlFor = (projectId) => `http://127.0.0.1:${PORT}/project-files/${projectId}/index.html?runtime=1&render=1`;
function startRender(prj, { quality = 'looks', fps, notes, scale = 1, label = null } = {}) {
  const n = store.versions(prj.id).length + 1;
  const rel = `renders/v${n}${label ? '-' + String(label).replace(/[^\w-]+/g, '') : ''}.mp4`; const out = path.join(prj.dir, rel);
  const job = newJob('render');
  (async () => {
    try {
      const r = await renderProject({ pageUrl: pageUrlFor(prj.id), dir: prj.dir, assetsDir: prj.assetsDir || null, out, quality, scale, fps: fps ? Number(fps) : undefined, onLog: (text) => job.push({ type: 'log', text }), onProgress: (p) => job.push({ type: 'progress', ...p }) });
      const v = registerVersion(prj, out, { notes: notes || `Rendered from Studio (${r.width}×${r.height}, ${r.frames} frames @ ${r.fps} fps)`, source: 'render', originalName: `v${n}${label ? '-' + label : ''}.mp4`, label: label ? `v${n} ${label}` : null });
      job.push({ type: 'log', text: `registered ${v.label}` }); notifyWaiters(); job.finish(true, { versionId: v.id });
    } catch (e) { job.push({ type: 'log', text: `failed: ${e.message}` }); job.finish(false); }
  })();
  return { job, out: rel };
}
// ---------- asset library: scan project assets/ + linked folder, analyze new files, watch for drops
function listAssets(prj) {
  const items = [...scanMedia(path.join(prj.dir, 'assets'), { prefix: 'assets' }), ...(prj.assetsDir && fs.existsSync(prj.assetsDir) ? scanMedia(prj.assetsDir, { prefix: 'library' }) : [])];
  const manifest = loadManifest(prj.dir);
  return items.map((it) => { const a = manifest.find((m) => m.rel === it.rel); const fresh = a && a.size === it.size && Math.abs(a.mtime - it.mtime) < 1 && a.version === ANALYSIS_VERSION; return { ...it, analyzed: !!fresh, analysis: fresh ? { duration: a.duration, width: a.width, height: a.height, fps: a.fps, hasAudio: a.hasAudio, scenes: a.scenes?.length || 0, sheet: a.sheet, frames: a.frames, audio: a.audio ? { bpm: a.audio.bpm, offset: a.audio.offset, confidence: a.audio.confidence, beats: a.audio.beats.slice(0, 64), peaks: a.audio.peaks } : null } : null }; });
}
const analyzing = new Map(); // projectId -> job
function startAnalyze(prj, { force = false } = {}) {
  if (analyzing.has(prj.id)) return analyzing.get(prj.id);
  const job = newJob('analyze'); analyzing.set(prj.id, job);
  (async () => {
    try {
      const items = listAssets(prj); const todo = items.filter((it) => force || !it.analyzed);
      const manifest = loadManifest(prj.dir).filter((m) => items.some((it) => it.rel === m.rel));
      job.push({ type: 'log', text: `${todo.length} file(s) to analyze` });
      for (const [i, it] of todo.entries()) {
        job.push({ type: 'progress', frame: i + 1, frames: todo.length, name: it.name });
        const rec = await new Promise((r) => setTimeout(() => r(analyzeFile(it, analysisDirFor(prj.dir, it), { onLog: (t) => job.push({ type: 'log', text: t }) })), 0));
        const idx = manifest.findIndex((m) => m.rel === rec.rel); if (idx >= 0) manifest[idx] = rec; else manifest.push(rec);
        writeManifest(prj.dir, manifest, { libraryDir: prj.assetsDir });
      }
      writeManifest(prj.dir, manifest, { libraryDir: prj.assetsDir });
      job.push({ type: 'log', text: 'MEDIA.md updated' }); job.finish(true);
    } catch (e) { job.push({ type: 'log', text: `failed: ${e.message}` }); job.finish(false); }
    finally { analyzing.delete(prj.id); }
  })();
  return job;
}
const watchers = new Map(); // projectId -> fs.FSWatcher[]
function watchAssets(prj) {
  for (const w of watchers.get(prj.id) || []) w.close();
  const list = [];
  for (const d of [path.join(prj.dir, 'assets'), prj.assetsDir].filter((d) => d && fs.existsSync(d))) {
    let timer = null;
    try { const w = fs.watch(d, { recursive: true }, (ev, name) => { if (!name || !kindOf(String(name))) return; clearTimeout(timer); timer = setTimeout(() => { const p = store.project(prj.id); if (p) startAnalyze(p); }, 1500); }); list.push(w); } catch {}
  }
  watchers.set(prj.id, list);
}

// Paths pasted from Finder or a shell often carry quotes, a trailing slash or escaped spaces.
const cleanDir = (v) => path.resolve(String(v).trim().replace(/^['"]|['"]$/g, '').replace(/\\ /g, ' ').replace(/^~(?=$|\/)/, process.env.HOME || '~').replace(/\/+$/, ''));
function findBin(name) { if (name.includes('/')) return fs.existsSync(name); return (process.env.PATH || '').split(path.delimiter).some((d) => fs.existsSync(path.join(d, name)) || fs.existsSync(path.join(d, name + '.cmd'))); }
const CLAUDE_BIN = process.env.VIDEDITOR_CLAUDE_BIN || 'claude';

function seedDemo() {
  if (process.env.VIDEDITOR_NO_DEMO || store.db.projects.length) return;
  const dir = path.join(ROOT, 'projects', 'launch-demo');
  if (!fs.existsSync(dir)) fs.cpSync(path.join(ROOT, 'examples', 'launch'), dir, { recursive: true });
  const project = store.addProject({ name: 'Launch day (demo)', dir, tags: ['demo'], chat: [{ role: 'agent', text: 'This is the demo project. Ask me to change the video ("make the title warmer and bring it in at 1s"), drag clips on the timeline, or press Render.', at: new Date().toISOString() }] });
  console.log('[videditor] seeded demo project');
  if (loadPlaywright() && FFMPEG && !process.env.VIDEDITOR_NO_DEMO_RENDER) {
    const { job } = startRender(project, { quality: 'draft', notes: 'First render of the demo composition.' });
    const l = (e) => {
      if (e !== null) return; job.listeners.delete(l);
      if (!job.ok) return console.log('[videditor] demo render failed; open Studio and press Render once Chrome is available');
      const v = store.version(job.versionId);
      store.addFeedback({ projectId: project.id, versionId: v.id, author: 'Avi', kind: 'voice', time: 2.4, timeEnd: 4.1, body: 'Title comes in too late and feels small. Bring it in by second one and make it bigger.', transcript: "so the title here comes in way too late, I'd bring this in around one second and make this bigger, it feels tiny on the frame", visualReferences: [{ phrase: 'here', time: 2.6 }, { phrase: 'this', time: 3.3 }], drawing: { color: '#ff4d4d', strokes: [{ tool: 'ellipse', color: '#ff4d4d', width: 4, points: [[0.3, 0.38, 2.4], [0.7, 0.62, 2.4]] }] }, tags: ['timing', 'type'] });
      store.addFeedback({ projectId: project.id, versionId: v.id, author: 'Dana', kind: 'text', time: 0.2, body: 'Background gradient is nice but the blue reads cold for a launch. Try warmer.', tags: ['color'] });
      console.log('[videditor] demo v1 rendered');
    };
    job.listeners.add(l);
  } else console.log('[videditor] demo not rendered yet: open Studio and press Render');
}

// ---------- API router
async function api(req, res, url) {
  const p = url.pathname.replace(/\/+$/, '');
  const q = Object.fromEntries(url.searchParams);
  const m = (re) => re.exec(p);
  let x;

  if (p === '/api/detect' || p === '/api/projects/detect' || p === '/api/hyperframes/detect') return send(res, 200, detectProject(q.path ? cleanDir(q.path) : q.path));
  if (p === '/api/state' && req.method === 'GET') {
    return send(res, 200, { projects: store.projects().map(projectView), ffmpeg: FFMPEG, dataDir: DATA, port: PORT });
  }
  if (p === '/api/projects' && req.method === 'POST') {
    const b = await readJson(req);
    if (b.create) {
      b.dir = createProject(b.name || 'Untitled', { template: String(b.template || 'blank').replace(/[^\w-]/g, ''), width: Number(b.width) || 1280, height: Number(b.height) || 720, fps: Number(b.fps) || 30, brand: b.brand || null });
      if (b.brief) fs.writeFileSync(path.join(b.dir, 'BRIEF.md'), `# ${b.name || 'Untitled'}\n\n${String(b.brief).trim()}\n`);
    } else if (b.dir) { const d = detectProject(cleanDir(b.dir)); if (!d.ok) return err(res, 400, `Not a composition folder: ${d.reason}`); b.dir = d.dir; }
    if (b.assetsDir) { const a = cleanDir(b.assetsDir); if (!fs.existsSync(a) || !fs.statSync(a).isDirectory()) return err(res, 400, `Asset folder does not exist: ${a}`); b.assetsDir = a; }
    const prj = store.addProject({ name: (b.name || 'Untitled').slice(0, 120), dir: b.dir || null, assetsDir: b.assetsDir || null, tags: b.tags || [], chat: [] });
    if (prj.dir) { watchAssets(prj); startAnalyze(prj); }
    // Adopt existing renders as versions when linking a folder.
    if (prj.dir && b.importRenders !== false) {
      const d = detectProject(prj.dir);
      for (const rel of d.renderFiles.sort()) registerVersion(prj, path.join(d.dir, rel), { notes: `Imported from ${rel}`, source: 'render', originalName: path.basename(rel) });
    }
    return send(res, 201, projectView(store.project(prj.id)));
  }
  if ((x = m(/^\/api\/projects\/([^/]+)$/))) {
    const prj = store.project(x[1]); if (!prj) return err(res, 404, 'Project not found');
    if (req.method === 'GET') return send(res, 200, projectView(prj));
    if (req.method === 'PATCH') {
      const b = await readJson(req); const patch = {};
      if (b.name) patch.name = String(b.name).slice(0, 120);
      if (b.tags) patch.tags = b.tags;
      if ('dir' in b) { if (b.dir) { const d = detectProject(b.dir); if (!d.ok) return err(res, 400, d.reason); patch.dir = d.dir; } else patch.dir = null; }
      if ('assetsDir' in b) { if (b.assetsDir) { const a = cleanDir(b.assetsDir); if (!fs.existsSync(a) || !fs.statSync(a).isDirectory()) return err(res, 400, `Folder does not exist: ${a}`); patch.assetsDir = a; } else patch.assetsDir = null; }
      const out = store.updateProject(prj.id, patch);
      if (('assetsDir' in b || 'dir' in b) && out.dir) { watchAssets(out); startAnalyze(out); }
      return send(res, 200, projectView(out));
    }
    if (req.method === 'DELETE') { for (const v of store.versions(prj.id)) { try { fs.unlinkSync(v.filePath); } catch {} } store.removeProject(prj.id); return send(res, 200, { ok: true }); }
  }
  if ((x = m(/^\/api\/projects\/([^/]+)\/versions$/)) && req.method === 'POST') {
    const prj = store.project(x[1]); if (!prj) return err(res, 404, 'Project not found');
    const ct = req.headers['content-type'] || '';
    if (ct.includes('application/json')) {
      // {path, notes, label, postedByAgent} — a file on disk (e.g. renders/v3.mp4), relative to the project folder.
      const b = await readJson(req);
      if (!b.path) return err(res, 400, 'path is required');
      const abs = path.isAbsolute(b.path) ? b.path : path.resolve(prj.dir || process.cwd(), b.path);
      if (!fs.existsSync(abs)) return err(res, 400, `File not found: ${abs}`);
      const v = registerVersion(prj, abs, { notes: b.notes || '', source: b.source || 'agent', postedByAgent: b.postedByAgent !== false, originalName: path.basename(abs), label: b.label });
      notifyWaiters();
      return send(res, 201, versionView(v));
    }
    // raw upload: body is the file; metadata in headers
    const name = safeName(decodeURIComponent(req.headers['x-filename'] || 'upload.mp4'));
    const tmp = path.join(DATA, `upload-${Date.now()}-${name}`);
    await readToFile(req, tmp);
    const v = registerVersion(prj, tmp, { notes: decodeURIComponent(req.headers['x-notes'] || ''), source: 'upload', originalName: name, move: true });
    notifyWaiters();
    return send(res, 201, versionView(v));
  }
  if ((x = m(/^\/api\/projects\/([^/]+)\/render$/)) && req.method === 'POST') {
    const prj = store.project(x[1]); if (!prj) return err(res, 404, 'Project not found');
    if (!prj.dir) return err(res, 400, 'Project has no composition folder');
    if (!loadPlaywright()) return err(res, 501, 'Rendering needs Playwright: run `npm install` inside the videditor folder (it uses your installed Chrome).');
    if (!FFMPEG) return err(res, 501, 'Rendering needs ffmpeg on PATH');
    const b = await readJson(req);
    const { job, out } = startRender(prj, b);
    return send(res, 202, { jobId: job.id, output: out });
  }
  if ((x = m(/^\/api\/projects\/([^/]+)\/clips\/([^/]+)$/)) && req.method === 'PATCH') {
    const prj = store.project(x[1]); if (!prj?.dir) return err(res, 404, 'Project not found');
    const b = await readJson(req);
    const patch = {}; for (const k of ['start', 'duration', 'track']) if (k in b) patch[k] = Number(b[k]);
    const attrs = updateClip(prj.dir, decodeURIComponent(x[2]), patch);
    if (!attrs) return err(res, 404, `No clip with id ${x[2]} in index.html`);
    // A clip dragged past the end extends the composition so it stays visible.
    let comp = parseProject(prj.dir);
    const end = Number(attrs['data-start']) + Number(attrs['data-duration'] || 0);
    if (comp && Number.isFinite(end) && comp.duration !== null && end > comp.duration + 1e-6) { updateRoot(prj.dir, { 'data-duration': end }); comp = parseProject(prj.dir); }
    store.touch(prj.id); store.save();
    return send(res, 200, { ok: true, attrs, composition: comp });
  }
  if ((x = m(/^\/api\/projects\/([^/]+)\/assets$/)) && req.method === 'GET') {
    const prj = store.project(x[1]); if (!prj?.dir) return err(res, 404, 'Project not found');
    return send(res, 200, { assetsDir: prj.assetsDir || null, items: listAssets(prj), analyzing: analyzing.get(prj.id)?.id || null });
  }
  if ((x = m(/^\/api\/projects\/([^/]+)\/assets\/analyze$/)) && req.method === 'POST') {
    const prj = store.project(x[1]); if (!prj?.dir) return err(res, 404, 'Project not found');
    if (!FFMPEG) return err(res, 501, 'Media analysis needs ffmpeg on PATH');
    const b = await readJson(req);
    const job = startAnalyze(prj, { force: !!b.force });
    return send(res, 202, { jobId: job.id });
  }
  if ((x = m(/^\/api\/projects\/([^/]+)\/clips$/)) && req.method === 'POST') {
    // Insert a media clip from the asset library (or a text/box element) into index.html.
    const prj = store.project(x[1]); if (!prj?.dir) return err(res, 404, 'Project not found');
    const b = await readJson(req);
    const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const start = Math.max(0, Number(b.start) || 0); const track = Number.isFinite(Number(b.track)) ? Number(b.track) : 1;
    const comp = parseProject(prj.dir); const ids = new Set((comp?.clips || []).map((c) => c.id).filter(Boolean));
    let base = String(b.id || (b.src ? path.basename(b.src).replace(/\.[^.]+$/, '') : b.kind || 'clip')).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$|^(\d)/g, (mm, d) => (d ? 'c' + d : '')) || 'clip';
    let id = base, n = 2; while (ids.has(id)) id = `${base}-${n++}`;
    const dur = b.duration !== undefined && b.duration !== null ? ` data-duration="${Math.max(0.04, Number(b.duration))}"` : '';
    let html;
    if (b.src && kindOf(b.src) === 'video') html = `<video id="${id}" class="clip" src="${esc(b.src)}" data-start="${start}"${dur} data-track-index="${track}"${b.mediaStart ? ` data-media-start="${Number(b.mediaStart)}"` : ''}${b.muted ? ' muted' : ''} style="inset:0;width:100%;height:100%;object-fit:cover" playsinline></video>`;
    else if (b.src && kindOf(b.src) === 'audio') html = `<audio id="${id}" src="${esc(b.src)}" data-start="${start}"${dur} data-track-index="${track}" data-volume="${Number(b.volume ?? 0.8)}"${b.mediaStart ? ` data-media-start="${Number(b.mediaStart)}"` : ''}></audio>`;
    else if (b.src && kindOf(b.src) === 'image') html = `<img id="${id}" class="clip" src="${esc(b.src)}" data-start="${start}"${dur || ' data-duration="3"'} data-track-index="${track}" style="inset:0;width:100%;height:100%;object-fit:cover">`;
    else if (b.kind === 'text') html = `<p id="${id}" class="clip" data-start="${start}"${dur || ' data-duration="3"'} data-track-index="${track}" style="left:8%;right:8%;top:40%;margin:0;font-size:64px;font-weight:800;color:var(--brand-text,#fff)">${esc(b.text || 'Text')}</p>`;
    else return err(res, 400, 'Need a media src or kind "text"');
    if (!insertClipHtml(prj.dir, html)) return err(res, 400, 'No composition root in index.html');
    const after = parseProject(prj.dir); const end = start + (Number(b.duration) || 3);
    if (after && after.duration !== null && end > after.duration + 1e-6) updateRoot(prj.dir, { 'data-duration': end });
    store.touch(prj.id); store.save();
    return send(res, 201, { ok: true, id, composition: parseProject(prj.dir) });
  }
  if ((x = m(/^\/api\/projects\/([^/]+)\/frame$/))) {
    // A frame of the live composition (not a rendered version), for Live review notes and agents.
    const prj = store.project(x[1]); if (!prj?.dir) return err(res, 404, 'Project not found');
    try { const { buf } = await captureFrame({ pageUrl: pageUrlFor(prj.id), t: Number(q.t || 0), width: Number(q.w || 1280) }); return send(res, 200, buf, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }); }
    catch (e) { return err(res, 501, e.message); }
  }
  if ((x = m(/^\/api\/projects\/([^/]+)\/brand$/))) {
    const prj = store.project(x[1]); if (!prj?.dir) return err(res, 404, 'Project not found');
    if (req.method === 'GET') return send(res, 200, readBrand(prj.dir) || writeBrand(prj.dir, {}));
    if (req.method === 'PUT') { const b = await readJson(req); const out = writeBrand(prj.dir, b); store.touch(prj.id); store.save(); return send(res, 200, out); }
  }
  if ((x = m(/^\/api\/projects\/([^/]+)\/chat$/)) && req.method === 'GET') {
    const prj = store.project(x[1]); if (!prj) return err(res, 404, 'Project not found');
    return send(res, 200, { chat: prj.chat || [], running: agents.get(prj.id)?.jobId || null, sessionId: prj.agentSessionId || null, claude: findBin(CLAUDE_BIN) });
  }
  if ((x = m(/^\/api\/projects\/([^/]+)\/agent$/)) && req.method === 'POST') {
    // The Studio chat: hands the message to Claude Code running in the project folder.
    const prj = store.project(x[1]); if (!prj) return err(res, 404, 'Project not found');
    if (!prj.dir) return err(res, 400, 'Project has no composition folder');
    if (agents.has(prj.id)) return err(res, 409, 'The agent is already working on this project');
    if (!findBin(CLAUDE_BIN)) return err(res, 501, `Claude Code was not found on PATH (looked for "${CLAUDE_BIN}"). Install it with: npm install -g @anthropic-ai/claude-code`);
    const b = await readJson(req);
    const message = String(b.message || '').trim().slice(0, 20000); if (!message) return err(res, 400, 'message is required');
    const job = newJob('agent');
    prj.chat = prj.chat || []; prj.chat.push({ role: 'user', text: message, at: new Date().toISOString(), author: b.author || null }); store.save();
    const entry = { role: 'agent', text: '', tools: [], at: new Date().toISOString() };
    const system = systemPrompt({ dir: prj.dir, composition: parseProject(prj.dir), files: listFiles(prj.dir), assetsDir: prj.assetsDir || null });
    const handle = { jobId: job.id, kill: null };
    agents.set(prj.id, handle);
    const onEvent = (ev) => {
      if (ev.type === 'text') entry.text += (entry.text ? '\n\n' : '') + ev.text;
      if (ev.type === 'tool') entry.tools.push({ name: ev.name, detail: ev.detail });
      if (ev.type === 'done') return; // emitted below, once
      job.push(ev);
    };
    (async () => {
      const resumeId = b.fresh ? null : prj.agentSessionId || null;
      let out = await runClaude({ dir: prj.dir, prompt: message, system, sessionId: resumeId, onEvent });
      if (out.error && resumeId) {
        // The stored conversation could not be resumed (or died): start a fresh one instead of failing forever.
        job.push({ type: 'status', message: 'Previous conversation could not be resumed; starting a fresh one' });
        entry.text = ''; entry.tools = [];
        out = await runClaude({ dir: prj.dir, prompt: message, system, sessionId: null, onEvent });
      }
      const p = store.project(prj.id);
      if (p) {
        if (!entry.text && out.result) entry.text = out.result;
        if (out.error) entry.error = out.error;
        p.chat.push(entry);
        // Keep the session only when the run succeeded, so a broken session never blocks the chat.
        p.agentSessionId = out.error ? null : (out.sessionId || p.agentSessionId || null);
        store.save();
      }
      if (out.error) console.error(`[agent] ${prj.name}: ${out.error}`);
      agents.delete(prj.id);
      job.push({ type: 'done', result: out.result, cost: out.cost, sessionId: out.sessionId });
      job.finish(!out.error, { result: out.result, cost: out.cost });
    })().catch((e) => { agents.delete(prj.id); job.push({ type: 'error', message: e.message }); job.finish(false); });
    return send(res, 202, { jobId: job.id });
  }
  if ((x = m(/^\/api\/projects\/([^/]+)\/agent\/reset$/)) && req.method === 'POST') { const prj = store.project(x[1]); if (!prj) return err(res, 404, 'Project not found'); store.updateProject(prj.id, { agentSessionId: null, chat: [] }); return send(res, 200, { ok: true }); }
  if ((x = m(/^\/api\/jobs\/([^/]+)\/events$/))) {
    const job = jobs.get(x[1]); if (!job) return err(res, 404, 'Job not found');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    const write = (line) => { if (line === null) { res.write(`event: done\ndata: ${JSON.stringify({ ok: job.ok, versionId: job.versionId, result: job.result, cost: job.cost })}\n\n`); res.end(); } else res.write(`data: ${JSON.stringify(line)}\n\n`); };
    for (const l of job.lines) write(l);
    if (job.done) return write(null);
    job.listeners.add(write); req.on('close', () => job.listeners.delete(write));
    return;
  }
  if ((x = m(/^\/api\/jobs\/([^/]+)$/))) { const job = jobs.get(x[1]); if (!job) return err(res, 404, 'Job not found'); return send(res, 200, { id: job.id, done: job.done, ok: job.ok, versionId: job.versionId, lines: job.lines }); }

  if ((x = m(/^\/api\/projects\/([^/]+)\/prompt$/))) {
    const prj = store.project(x[1]); if (!prj) return err(res, 404, 'Project not found');
    const version = q.versionId ? store.version(q.versionId) : store.latestVersion(prj.id);
    if (!version) return err(res, 404, 'No version to review');
    const composition = prj.dir ? parseProject(prj.dir) : null;
    const text = buildPrompt({ project: prj, version, feedback: store.feedback({ versionId: version.id }), composition, baseUrl: baseUrl(req), dataDir: q.paths === 'local' ? path.join(DATA) : null });
    return send(res, 200, text, { 'Content-Type': 'text/markdown; charset=utf-8' });
  }
  if ((x = m(/^\/api\/projects\/([^/]+)\/composition$/))) {
    const prj = store.project(x[1]); if (!prj) return err(res, 404, 'Project not found');
    if (!prj.dir) return send(res, 200, null);
    const comp = parseProject(prj.dir);
    if (comp && q.t !== undefined) return send(res, 200, { at: Number(q.t), clips: clipsAt(comp, Number(q.t)).map((c) => ({ ...c, label: describeClip(c) })) });
    return send(res, 200, comp);
  }
  if ((x = m(/^\/api\/projects\/([^/]+)\/files$/))) {
    const prj = store.project(x[1]); if (!prj) return err(res, 404, 'Project not found');
    if (!prj.dir) return send(res, 200, { dir: null, files: [] });
    if (q.path !== undefined && req.method === 'PUT') {
      // Save a text file from the Studio editor (index.html, BRIEF.md, css…).
      const abs = safePath(prj.dir, q.path); if (!abs) return err(res, 403, 'Outside project');
      if (!/\.(html?|css|js|mjs|json|md|txt|svg|csv)$/i.test(abs)) return err(res, 400, 'Only text files can be saved here');
      const chunks = []; let size = 0; for await (const c of req) { size += c.length; if (size > 5 * 1024 * 1024) return err(res, 413, 'File too large'); chunks.push(c); }
      fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, Buffer.concat(chunks)); store.touch(prj.id); store.save();
      return send(res, 200, { ok: true, composition: /index\.html$/.test(abs) ? parseProject(prj.dir) : undefined });
    }
    if (q.path !== undefined) {
      const abs = safePath(prj.dir, q.path); if (!abs) return err(res, 403, 'Outside project');
      let st; try { st = fs.statSync(abs); } catch { return err(res, 404, 'File not found'); }
      if (st.size > 2 * 1024 * 1024) return err(res, 413, 'File too large to show');
      return send(res, 200, fs.readFileSync(abs, 'utf8'), { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    return send(res, 200, { dir: prj.dir, files: listFiles(prj.dir) });
  }
  if ((x = m(/^\/api\/versions\/([^/]+)$/))) {
    const v = store.version(x[1]); if (!v) return err(res, 404, 'Version not found');
    if (req.method === 'GET') return send(res, 200, versionView(v));
    if (req.method === 'PATCH') { const b = await readJson(req); const patch = {}; if ('notes' in b) patch.notes = String(b.notes); if (b.label) patch.label = String(b.label).slice(0, 40); return send(res, 200, versionView(store.updateVersion(v.id, patch))); }
    if (req.method === 'DELETE') { try { fs.unlinkSync(v.filePath); } catch {} try { if (v.posterUrl) fs.unlinkSync(path.join(DATA, v.posterUrl.replace(/^\/media\//, ''))); } catch {} store.removeVersion(v.id); return send(res, 200, { ok: true }); }
  }
  if ((x = m(/^\/api\/versions\/([^/]+)\/frame$/))) {
    const v = store.version(x[1]); if (!v) return err(res, 404, 'Version not found');
    if (!FFMPEG) return err(res, 501, 'ffmpeg not available');
    const buf = frameAt(v.filePath, Number(q.t || 0), { width: Number(q.w || 1280) });
    if (!buf) return err(res, 500, 'Could not extract frame');
    return send(res, 200, buf, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' });
  }
  if ((x = m(/^\/api\/versions\/([^/]+)\/download$/))) { const v = store.version(x[1]); if (!v) return err(res, 404, 'Version not found'); return serveFile(req, res, v.filePath, { download: true }); }

  if (p === '/api/feedback' && req.method === 'GET') return send(res, 200, store.feedback({ projectId: q.projectId, versionId: q.versionId, since: q.since, status: q.status }));
  if (p === '/api/feedback/wait' && req.method === 'GET') {
    const since = q.since || new Date().toISOString();
    const timeout = Math.min(45000, Math.max(1000, Number(q.timeout || 30000)));
    const check = () => store.feedback({ projectId: q.projectId, versionId: q.versionId, since }).filter((f) => !q.humanOnly || !f.postedByAgent);
    const now = check(); if (now.length) return send(res, 200, { items: now, timedOut: false });
    await new Promise((resolve) => {
      const timer = setTimeout(() => { waiters.delete(w); resolve(); }, timeout);
      const w = () => { if (check().length) { clearTimeout(timer); waiters.delete(w); resolve(); } };
      waiters.add(w); req.on('close', () => { clearTimeout(timer); waiters.delete(w); resolve(); });
    });
    const items = check();
    return send(res, 200, { items, timedOut: !items.length });
  }
  if (p === '/api/feedback' && req.method === 'POST') {
    const b = await readJson(req);
    const version = store.version(b.versionId); if (!version) return err(res, 400, 'versionId is required');
    const prj = store.project(version.projectId);
    const id = store.id('fb');
    const frames = [];
    for (const [i, fr] of (b.frames || []).entries()) {
      const file = path.join(DATA, 'frames', `${id}-${i}`); const mime = dataUrlToFile(fr.dataUrl, file); if (!mime) continue;
      const ext = extFor(mime) || '.png'; fs.renameSync(file, file + ext); frames.push({ time: fr.time ?? null, label: fr.label || null, url: `/media/frames/${id}-${i}${ext}` });
    }
    let audioUrl = null;
    if (b.audio) { const file = path.join(DATA, 'audio', id); const mime = dataUrlToFile(b.audio, file); if (mime) { const ext = extFor(mime) || '.webm'; fs.renameSync(file, file + ext); audioUrl = `/media/audio/${id}${ext}`; } }
    const refs = [];
    for (const [i, r] of (b.refs || []).entries()) { const file = path.join(DATA, 'refs', `${id}-${i}`); const mime = dataUrlToFile(r, file); if (!mime) continue; const ext = extFor(mime) || '.png'; fs.renameSync(file, file + ext); refs.push(`/media/refs/${id}-${i}${ext}`); }
    let clipContext = [];
    if (prj?.dir && typeof b.time === 'number') { const comp = parseProject(prj.dir); clipContext = clipsAt(comp, b.time).map((c) => ({ id: c.id, tag: c.tag, start: c.start, duration: c.duration, track: c.track, label: describeClip(c) })); }
    const f = store.addFeedback({ id, projectId: version.projectId, versionId: version.id, author: String(b.author || 'Anonymous').slice(0, 60), body: String(b.body || '').slice(0, 20000), time: typeof b.time === 'number' ? b.time : null, timeEnd: typeof b.timeEnd === 'number' ? b.timeEnd : null, kind: ['text', 'voice', 'drawing'].includes(b.kind) ? b.kind : 'text', tags: Array.isArray(b.tags) ? b.tags.slice(0, 10) : [], replyTo: typeof b.replyTo === 'string' && store.feedbackItem(b.replyTo) ? b.replyTo : null, postedByAgent: !!b.postedByAgent, transcript: b.transcript || null, visualReferences: Array.isArray(b.visualReferences) ? b.visualReferences : [], drawing: b.drawing || null, frames, audioUrl, refs, clipContext });
    notifyWaiters();
    return send(res, 201, f);
  }
  if ((x = m(/^\/api\/feedback\/([^/]+)$/))) {
    const f = store.feedbackItem(x[1]); if (!f) return err(res, 404, 'Feedback not found');
    if (req.method === 'GET') return send(res, 200, { ...f, replies: store.feedback({}).filter((r) => r.replyTo === f.id) });
    if (req.method === 'PATCH') { const b = await readJson(req); const patch = {}; if ('body' in b) patch.body = String(b.body).slice(0, 20000); if ('status' in b) patch.status = b.status === 'done' ? 'done' : 'open'; if ('tags' in b) patch.tags = Array.isArray(b.tags) ? b.tags.slice(0, 10) : []; if ('time' in b) patch.time = typeof b.time === 'number' ? b.time : null; if ('timeEnd' in b) patch.timeEnd = typeof b.timeEnd === 'number' ? b.timeEnd : null; const out = store.updateFeedback(f.id, patch); notifyWaiters(); return send(res, 200, out); }
    if (req.method === 'DELETE') { store.removeFeedback(f.id); return send(res, 200, { ok: true }); }
  }
  if (p === '/api/projects/detect' || p === '/api/hyperframes/detect') return send(res, 200, detectProject(q.path));
  if (p === '/api/agent/diagnose') { const prj = q.projectId ? store.project(q.projectId) : null; return send(res, 200, diagnoseClaude(prj?.dir || ROOT)); }
  if (p === '/api/capabilities') return send(res, 200, { ffmpeg: FFMPEG, playwright: !!loadPlaywright(), claude: findBin(CLAUDE_BIN) });
  if (p === '/api/guide') return send(res, 200, GUIDE, { 'Content-Type': 'text/markdown; charset=utf-8' });
  return err(res, 404, `No route ${req.method} ${p}`);
}

export const GUIDE = `# Videditor agent playbook
Videditor is a video studio and review workspace. A video is a project folder whose index.html is the composition (see videditor/skills/videditor/SKILL.md for the format). Humans leave timestamped notes (text, voice with pointing phrases, drawings over frames) on a rendered version. You read them, change the composition, render, and reply.

Loop:
1. feedback_list(project_id, status="open") → read every item. Use get_annotated_frame / get_frame when a note points at something ("this", "here") or has a drawing.
2. Timing lives in data-start / data-duration attributes in index.html. Each note lists which clips are on screen at its timestamp (composition_at gives the full list for any time).
3. Edit index.html in the project folder. Then render_version(project_id, notes="## Changes ...") renders it and registers the next version. (version_add is for an MP4 you produced some other way.)
5. For each note: feedback_post(reply_to=<id>, body="what changed") then feedback_update(id, status="done"). If you did not change it, reply why and leave it open.
6. wait_for_feedback(project_id) blocks until a human posts again, so you can keep iterating.
Never mark a note done without replying. Keep replies short and concrete (what, where, by how much).`;

// ---------- server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') return send(res, 204, '', { 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': '*' });
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname.startsWith('/media/')) {
      const rel = decodeURIComponent(url.pathname.slice('/media/'.length));
      const abs = path.resolve(DATA, rel); if (!abs.startsWith(DATA)) return err(res, 403, 'Forbidden');
      return serveFile(req, res, abs);
    }
    const pf = /^\/project-files\/([^/]+)\/(.*)$/.exec(url.pathname);
    if (pf) {
      const prj = store.project(pf[1]); if (!prj?.dir) return err(res, 404, 'Not found');
      const relPath = decodeURIComponent(pf[2] || 'index.html');
      if (/^library\//.test(relPath)) { if (!prj.assetsDir) return err(res, 404, 'No asset folder linked'); const la = safePath(prj.assetsDir, relPath.slice('library/'.length)); if (!la) return err(res, 403, 'Forbidden'); return serveFile(req, res, la); }
      const abs = safePath(prj.dir, relPath); if (!abs) return err(res, 403, 'Forbidden');
      if (url.searchParams.get('runtime') === '1' && /\.html?$/i.test(abs)) {
        // Serve the composition with the seekable runtime injected (Studio preview and renderer).
        let html; try { html = fs.readFileSync(abs, 'utf8'); } catch { return err(res, 404, 'Not found'); }
        const tag = '<script src="/engine/runtime.js"></script>';
        html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, tag + '</body>') : html + tag;
        return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      }
      return serveFile(req, res, abs);
    }
    let rel = decodeURIComponent(url.pathname); if (rel === '/' || rel === '') rel = '/index.html';
    const abs = path.resolve(ROOT, '.' + rel);
    if (!abs.startsWith(ROOT) || abs.startsWith(DATA) || /\/(server|mcp|cli)\.mjs$|\/lib\/|\/tests\/|\/projects\/|\/node_modules\//.test(abs)) return err(res, 404, 'Not found');
    return serveFile(req, res, abs);
  } catch (e) {
    console.error(e); return err(res, 500, e.message || 'Server error');
  }
});

seedDemo();
for (const p of store.db.projects) if (p.dir && fs.existsSync(p.dir)) { watchAssets(p); if (FFMPEG) startAnalyze(p); }
server.listen(PORT, () => {
  console.log(`[videditor] http://localhost:${PORT}  data: ${DATA}`);
  console.log(`[videditor] ffmpeg: ${FFMPEG ? 'yes' : 'NO (install ffmpeg)'}  renderer: ${loadPlaywright() ? 'yes' : 'NO (run npm install in videditor/)'}  claude code: ${findBin(CLAUDE_BIN) ? 'yes' : 'NO (install Claude Code for the Studio chat)'}`);
});
