// HyperFrames project awareness: detect a project folder, parse its
// composition HTML into clips/tracks, and tell which clips are on screen
// at a given time. Regex-based on purpose: zero dependencies, and the
// HyperFrames schema is plain data attributes on ordinary HTML tags.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const TAG_RE = /<([a-zA-Z][\w-]*)\b([^>]*?)\/?>/g;
const ATTR_RE = /([\w:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

export function parseAttrs(src) {
  const out = {};
  for (const m of src.matchAll(ATTR_RE)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}

export function detectProject(dir) {
  if (!dir) return { ok: false, reason: 'No folder given' };
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return { ok: false, reason: 'Folder does not exist', dir: abs };
  const index = path.join(abs, 'index.html');
  const settings = path.join(abs, 'hyperframes.json');
  const hasIndex = fs.existsSync(index);
  const hasSettings = fs.existsSync(settings);
  let isComposition = false;
  if (hasIndex) isComposition = /data-composition-id=/.test(fs.readFileSync(index, 'utf8'));
  const ok = hasSettings || isComposition;
  const renders = path.join(abs, 'renders');
  const renderFiles = fs.existsSync(renders) ? fs.readdirSync(renders).filter((f) => /\.(mp4|mov|webm)$/i.test(f)).map((f) => path.join('renders', f)) : [];
  return { ok, dir: abs, hasIndex, hasSettings, isComposition, renderFiles, reason: ok ? null : 'No index.html composition or hyperframes.json found' };
}

const num = (v) => (v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

function textAfter(html, idx) {
  // crude: the text between this tag's '>' and the next '<'
  const start = html.indexOf('>', idx) + 1;
  const end = html.indexOf('<', start);
  const t = html.slice(start, end > 0 ? end : start).replace(/\s+/g, ' ').trim();
  return t.length > 120 ? t.slice(0, 117) + '…' : t;
}

/** Parse one composition HTML file. Returns { id, width, height, duration, fps, clips[] }. */
export function parseComposition(file, { offset = 0, depth = 0, maxDepth = 3, hostTrack = null } = {}) {
  const html = fs.readFileSync(file, 'utf8');
  const dir = path.dirname(file);
  const comp = { file, id: null, width: null, height: null, duration: null, fps: null, clips: [] };
  for (const m of html.matchAll(TAG_RE)) {
    const tag = m[1].toLowerCase();
    if (tag === 'script' || tag === 'style') continue;
    const a = parseAttrs(m[2]);
    const isRoot = a['data-composition-id'] && !a['data-composition-src'];
    if (isRoot && comp.id === null) {
      comp.id = a['data-composition-id'];
      comp.width = num(a['data-width']); comp.height = num(a['data-height']);
      comp.duration = num(a['data-duration']); comp.fps = num(a['data-fps']);
      continue;
    }
    if (a['data-start'] === undefined) continue;
    const start = num(a['data-start']);
    const clip = {
      id: a.id || null, tag, start: start === null ? null : start + offset, startExpr: start === null ? a['data-start'] : null,
      duration: num(a['data-duration']), track: hostTrack ?? num(a['data-track-index']),
      src: a.src || a['data-composition-src'] || null, text: /^(h[1-6]|p|span|div|li|button)$/.test(tag) ? textAfter(html, m.index) : '',
      compositionId: a['data-composition-id'] || null, depth, file: path.relative(process.cwd(), file),
      mediaStart: num(a['data-media-start'] ?? a['data-playback-start']), volume: num(a['data-volume']),
    };
    if (clip.duration === null && (tag === 'img')) clip.duration = 3;
    comp.clips.push(clip);
    if (a['data-composition-src'] && depth < maxDepth && clip.start !== null) {
      const nested = path.resolve(dir, a['data-composition-src']);
      if (fs.existsSync(nested)) {
        try {
          const child = parseComposition(nested, { offset: clip.start, depth: depth + 1, maxDepth, hostTrack: clip.track });
          for (const c of child.clips) { c.parent = clip.compositionId; comp.clips.push(c); }
        } catch {}
      }
    }
  }
  if (comp.duration === null) {
    const ends = comp.clips.filter((c) => c.start !== null && c.duration !== null).map((c) => c.start + c.duration);
    if (ends.length) comp.duration = Math.max(...ends);
  }
  return comp;
}

export function parseProject(dir) {
  const d = detectProject(dir);
  if (!d.ok || !d.hasIndex) return null;
  const comp = parseComposition(path.join(d.dir, 'index.html'));
  comp.dir = d.dir;
  return comp;
}

/** Clips visible at time t (seconds), topmost track first. */
export function clipsAt(comp, t) {
  if (!comp) return [];
  return comp.clips
    .filter((c) => c.start !== null && t >= c.start - 1e-6 && (c.duration === null || t < c.start + c.duration + 1e-6))
    .sort((a, b) => (b.track ?? 0) - (a.track ?? 0) || a.depth - b.depth);
}

export function describeClip(c) {
  const name = c.id ? `#${c.id}` : c.compositionId ? `composition "${c.compositionId}"` : `<${c.tag}>`;
  const range = c.start === null ? `start ${c.startExpr}` : `${fmt(c.start)}–${c.duration === null ? '?' : fmt(c.start + c.duration)}`;
  const extra = [c.text ? `“${c.text}”` : null, c.src ? c.src : null, c.track !== null && c.track !== undefined ? `track ${c.track}` : null, c.depth ? `in ${c.parent}` : null].filter(Boolean).join(', ');
  return `${name} (${c.tag}, ${range}${extra ? '; ' + extra : ''})`;
}

export function fmt(s) {
  if (s === null || s === undefined || !Number.isFinite(s)) return '–';
  const m = Math.floor(s / 60); const sec = s - m * 60;
  return `${m}:${sec.toFixed(2).padStart(5, '0')}`;
}

/** List project files (text-ish, small) for the Context panel. */
export function listFiles(dir, { max = 400 } = {}) {
  const out = [];
  const skip = new Set(['node_modules', '.git', '.hyperframes', 'renders', '.cache']);
  const walk = (d, rel) => {
    if (out.length >= max) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') && e.name !== '.hyperframes') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(path.join(d, e.name), r); continue; }
      let size = 0; try { size = fs.statSync(path.join(d, e.name)).size; } catch {}
      out.push({ path: r, size, text: /\.(html?|css|js|mjs|ts|json|md|txt|svg|csv|yml|yaml)$/i.test(e.name) });
      if (out.length >= max) return;
    }
  };
  walk(dir, '');
  return out;
}

/** Run a HyperFrames CLI command inside the project dir. Streams lines to onLine. */
export function runHyperframes(dir, args, onLine) {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const child = spawn(cmd, ['--yes', 'hyperframes', ...args], { cwd: dir, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
    let buf = '';
    const feed = (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.search(/[\r\n]/)) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) onLine?.(line); }
    };
    child.stdout.on('data', feed); child.stderr.on('data', feed);
    child.on('error', (e) => { onLine?.(`error: ${e.message}`); resolve({ code: 1, error: e.message }); });
    child.on('close', (code) => { if (buf.trim()) onLine?.(buf.trim()); resolve({ code }); });
  });
}
