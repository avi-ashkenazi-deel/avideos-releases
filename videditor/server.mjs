#!/usr/bin/env node
// Videditor server: static UI + JSON API + media. Zero dependencies.
//   node videditor/server.mjs            → http://localhost:8787
// Env: VIDEDITOR_PORT, VIDEDITOR_DATA (default videditor/data), VIDEDITOR_NO_DEMO=1
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './lib/store.mjs';
import { detectProject, parseProject, clipsAt, describeClip, listFiles, runHyperframes } from './lib/hyperframes.mjs';
import { hasFfmpeg, probe, poster, frameAt, makeDemoVideo } from './lib/media.mjs';
import { buildPrompt } from './lib/prompt.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.VIDEDITOR_PORT || process.env.PORT || 8787);
const DATA = path.resolve(process.env.VIDEDITOR_DATA || path.join(ROOT, 'data'));
const store = new Store(DATA);
const FFMPEG = hasFfmpeg();
const jobs = new Map(); // id -> { id, lines: [], done, ok, listeners:Set, versionId }
const waiters = new Set(); // long-poll feedback waiters

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
  return { ...p, versions, latest, stats: store.stats(p.id), lastActivity: last ? { at: last.createdAt, author: last.author, body: (last.body || last.transcript || '').slice(0, 80) } : null, hyperframes: p.hyperframesDir ? detectProject(p.hyperframesDir) : null };
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
  const composition = project.hyperframesDir ? summarizeComposition(parseProject(project.hyperframesDir)) : null;
  return store.addVersion(project.id, { id, fileName, filePath: dest, originalName: originalName || path.basename(srcFile), mediaUrl: `/media/media/${fileName}`, posterUrl, notes, source, postedByAgent, ...info, composition, ...(label ? { label } : {}) });
}
const summarizeComposition = (c) => (c ? { id: c.id, width: c.width, height: c.height, duration: c.duration, fps: c.fps, clipCount: c.clips.length } : null);

function notifyWaiters() { for (const w of [...waiters]) w(); }

function seedDemo() {
  if (process.env.VIDEDITOR_NO_DEMO || store.db.projects.length || !FFMPEG) return;
  const dir = path.join(ROOT, 'examples', 'launch');
  const project = store.addProject({ name: 'Launch day (demo)', hyperframesDir: dir, tags: ['demo'] });
  const tmp1 = path.join(DATA, 'demo-v1.mp4'); const tmp2 = path.join(DATA, 'demo-v2.mp4');
  if (makeDemoVideo(tmp1, { title: 'Launch day', seconds: 6, hue: 200, titleAt: 2.2, label: 'v1 · demo render' })) {
    const v1 = registerVersion(project, tmp1, { notes: 'First render from the HyperFrames project in videditor/examples/launch.', source: 'render', move: true, originalName: 'v1.mp4' });
    const f1 = store.addFeedback({ projectId: project.id, versionId: v1.id, author: 'Avi', kind: 'voice', time: 2.4, timeEnd: 4.1, body: 'Title comes in too late and feels small. Bring it in by second one and make it bigger.', transcript: "so the title here comes in way too late, I'd bring this in around one second and make this bigger, it feels tiny on the frame", visualReferences: [{ phrase: 'here', time: 2.6 }, { phrase: 'this', time: 3.3 }, { phrase: 'this', time: 3.9 }], drawing: { color: '#ff4d4d', strokes: [{ tool: 'ellipse', color: '#ff4d4d', width: 4, points: [[0.3, 0.38, 0], [0.7, 0.62, 0.6]] }] }, tags: ['timing', 'type'] });
    store.addFeedback({ projectId: project.id, versionId: v1.id, author: 'Dana', kind: 'text', time: 0.2, body: 'Background gradient is nice but the blue reads cold for a launch. Try warmer.', tags: ['color'] });
    store.addFeedback({ projectId: project.id, versionId: v1.id, author: 'Claude Code', kind: 'text', time: null, body: 'Read 2 notes. Moving the title to data-start="1", font-size 96→128px, and warming the gradient hue. Rendering v2 now.', postedByAgent: true, replyTo: f1.id });
    if (makeDemoVideo(tmp2, { title: 'Launch day', seconds: 6, hue: 20, titleAt: 1.0, label: 'v2 · demo render' })) {
      const v2 = registerVersion(project, tmp2, { notes: '## Changes\n- Title now enters at 1.0s (was 2.2s) and is 128px\n- Gradient hue warmed from blue to orange\n\nAddresses: title timing/size, cold background.', source: 'agent', postedByAgent: true, move: true, originalName: 'v2.mp4' });
      store.updateFeedback(f1.id, { status: 'done' });
      store.addFeedback({ projectId: project.id, versionId: v2.id, author: 'Avi', kind: 'drawing', time: 4.3, body: 'Much better. Now give the call to action a beat longer on screen and nudge it up so it is not kissing the bottom edge.', drawing: { color: '#ffd166', strokes: [{ tool: 'arrow', color: '#ffd166', width: 4, points: [[0.5, 0.9, 4.3], [0.5, 0.74, 4.3]] }] }, tags: ['timing', 'layout'] });
    }
    console.log('[videditor] seeded demo project');
  } else { store.removeProject(project.id); console.log('[videditor] demo seed skipped (ffmpeg could not make the sample video)'); }
}

// ---------- API router
async function api(req, res, url) {
  const p = url.pathname.replace(/\/+$/, '');
  const q = Object.fromEntries(url.searchParams);
  const m = (re) => re.exec(p);
  let x;

  if (p === '/api/state' && req.method === 'GET') {
    return send(res, 200, { projects: store.projects().map(projectView), ffmpeg: FFMPEG, dataDir: DATA, port: PORT });
  }
  if (p === '/api/projects' && req.method === 'POST') {
    const b = await readJson(req);
    if (b.hyperframesDir) { const d = detectProject(b.hyperframesDir); if (!d.ok) return err(res, 400, `Not a HyperFrames project: ${d.reason}`); b.hyperframesDir = d.dir; }
    const prj = store.addProject({ name: (b.name || 'Untitled').slice(0, 120), hyperframesDir: b.hyperframesDir || null, tags: b.tags || [] });
    // Adopt existing renders as versions when linking a HyperFrames folder.
    if (prj.hyperframesDir && b.importRenders !== false) {
      const d = detectProject(prj.hyperframesDir);
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
      if ('hyperframesDir' in b) { if (b.hyperframesDir) { const d = detectProject(b.hyperframesDir); if (!d.ok) return err(res, 400, d.reason); patch.hyperframesDir = d.dir; } else patch.hyperframesDir = null; }
      return send(res, 200, projectView(store.updateProject(prj.id, patch)));
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
      const abs = path.isAbsolute(b.path) ? b.path : path.resolve(prj.hyperframesDir || process.cwd(), b.path);
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
    if (!prj.hyperframesDir) return err(res, 400, 'Project is not linked to a HyperFrames folder');
    const b = await readJson(req);
    const n = store.versions(prj.id).length + 1;
    const out = `renders/v${n}.mp4`;
    const job = { id: store.id('job'), lines: [], done: false, ok: null, listeners: new Set(), versionId: null, startedAt: Date.now() };
    jobs.set(job.id, job);
    const push = (line) => { job.lines.push(line); for (const l of job.listeners) l(line); };
    fs.mkdirSync(path.join(prj.hyperframesDir, 'renders'), { recursive: true });
    (async () => {
      push(`$ npx hyperframes render --output ${out}${b.quality ? ` --quality ${b.quality}` : ''}`);
      const r = await runHyperframes(prj.hyperframesDir, ['render', '--output', out, ...(b.quality ? ['--quality', b.quality] : [])], push);
      const abs = path.join(prj.hyperframesDir, out);
      if (r.code === 0 && fs.existsSync(abs)) {
        const v = registerVersion(prj, abs, { notes: b.notes || `Rendered from Videditor`, source: 'render', originalName: `v${n}.mp4` });
        job.versionId = v.id; job.ok = true; push(`done: registered ${v.label}`); notifyWaiters();
      } else { job.ok = false; push(`failed (exit ${r.code}). Is Node 22+, FFmpeg and the hyperframes CLI available in ${prj.hyperframesDir}?`); }
      job.done = true; for (const l of job.listeners) l(null);
    })();
    return send(res, 202, { jobId: job.id, output: out });
  }
  if ((x = m(/^\/api\/jobs\/([^/]+)\/events$/))) {
    const job = jobs.get(x[1]); if (!job) return err(res, 404, 'Job not found');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    const write = (line) => { if (line === null) { res.write(`event: done\ndata: ${JSON.stringify({ ok: job.ok, versionId: job.versionId })}\n\n`); res.end(); } else res.write(`data: ${JSON.stringify(line)}\n\n`); };
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
    const composition = prj.hyperframesDir ? parseProject(prj.hyperframesDir) : null;
    const text = buildPrompt({ project: prj, version, feedback: store.feedback({ versionId: version.id }), composition, baseUrl: baseUrl(req), dataDir: q.paths === 'local' ? path.join(DATA) : null });
    return send(res, 200, text, { 'Content-Type': 'text/markdown; charset=utf-8' });
  }
  if ((x = m(/^\/api\/projects\/([^/]+)\/composition$/))) {
    const prj = store.project(x[1]); if (!prj) return err(res, 404, 'Project not found');
    if (!prj.hyperframesDir) return send(res, 200, null);
    const comp = parseProject(prj.hyperframesDir);
    if (comp && q.t !== undefined) return send(res, 200, { at: Number(q.t), clips: clipsAt(comp, Number(q.t)).map((c) => ({ ...c, label: describeClip(c) })) });
    return send(res, 200, comp);
  }
  if ((x = m(/^\/api\/projects\/([^/]+)\/files$/))) {
    const prj = store.project(x[1]); if (!prj) return err(res, 404, 'Project not found');
    if (!prj.hyperframesDir) return send(res, 200, { dir: null, files: [] });
    if (q.path !== undefined) {
      const abs = path.resolve(prj.hyperframesDir, q.path);
      if (!abs.startsWith(prj.hyperframesDir)) return err(res, 403, 'Outside project');
      let st; try { st = fs.statSync(abs); } catch { return err(res, 404, 'File not found'); }
      if (st.size > 2 * 1024 * 1024) return err(res, 413, 'File too large to show');
      return send(res, 200, fs.readFileSync(abs, 'utf8'), { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    return send(res, 200, { dir: prj.hyperframesDir, files: listFiles(prj.hyperframesDir) });
  }
  if ((x = m(/^\/api\/versions\/([^/]+)$/))) {
    const v = store.version(x[1]); if (!v) return err(res, 404, 'Version not found');
    if (req.method === 'GET') return send(res, 200, versionView(v));
    if (req.method === 'PATCH') { const b = await readJson(req); const patch = {}; if ('notes' in b) patch.notes = String(b.notes); if (b.label) patch.label = String(b.label).slice(0, 40); return send(res, 200, versionView(store.updateVersion(v.id, patch))); }
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
    if (prj?.hyperframesDir && typeof b.time === 'number') { const comp = parseProject(prj.hyperframesDir); clipContext = clipsAt(comp, b.time).map((c) => ({ id: c.id, tag: c.tag, start: c.start, duration: c.duration, track: c.track, label: describeClip(c) })); }
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
  if (p === '/api/hyperframes/detect') return send(res, 200, detectProject(q.path));
  if (p === '/api/guide') return send(res, 200, GUIDE, { 'Content-Type': 'text/markdown; charset=utf-8' });
  return err(res, 404, `No route ${req.method} ${p}`);
}

export const GUIDE = `# Videditor agent playbook
Videditor is a video review workspace. Humans leave timestamped notes (text, voice with pointing phrases, drawings over frames) on a version of a video. You read them, change the video, and post a new version.

Loop:
1. feedback_list(project_id, status="open") → read every item. Use get_annotated_frame / get_frame when a note points at something ("this", "here") or has a drawing.
2. If the project is linked to a HyperFrames folder, timing is in data-start / data-duration attributes in index.html and compositions/*.html. Each note lists which clips are on screen at its timestamp.
3. Make the change. Render: npx hyperframes lint && npx hyperframes render --output renders/vN.mp4
4. version_add(project_id, file="renders/vN.mp4", notes="## Changes ...") registers the new version.
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
      const prj = store.project(pf[1]); if (!prj?.hyperframesDir) return err(res, 404, 'Not found');
      const abs = path.resolve(prj.hyperframesDir, decodeURIComponent(pf[2] || 'index.html')); if (!abs.startsWith(prj.hyperframesDir)) return err(res, 403, 'Forbidden');
      return serveFile(req, res, abs);
    }
    let rel = decodeURIComponent(url.pathname); if (rel === '/' || rel === '') rel = '/index.html';
    const abs = path.resolve(ROOT, '.' + rel);
    if (!abs.startsWith(ROOT) || abs.startsWith(DATA) || /\/(server|mcp|cli)\.mjs$|\/lib\/|\/tests\//.test(abs)) return err(res, 404, 'Not found');
    return serveFile(req, res, abs);
  } catch (e) {
    console.error(e); return err(res, 500, e.message || 'Server error');
  }
});

seedDemo();
server.listen(PORT, () => {
  console.log(`[videditor] http://localhost:${PORT}  data: ${DATA}  ffmpeg: ${FFMPEG ? 'yes' : 'NO (uploads work, no thumbnails/frames)'}`);
});
