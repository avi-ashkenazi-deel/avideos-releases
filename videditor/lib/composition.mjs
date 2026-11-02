// Composition projects: a folder whose index.html is the video. This module
// detects a project, parses the composition into clips/tracks, tells which
// clips are on screen at a time, edits clip timing in place, and creates
// projects from templates. Regex-based on purpose: zero dependencies, and
// the format is plain data attributes on ordinary HTML tags.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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
  const settings = path.join(abs, 'videditor.json');
  const hasIndex = fs.existsSync(index);
  const hasSettings = fs.existsSync(settings);
  let isComposition = false;
  if (hasIndex) isComposition = /data-composition-id=/.test(fs.readFileSync(index, 'utf8'));
  const ok = hasSettings || isComposition;
  const renders = path.join(abs, 'renders');
  const renderFiles = fs.existsSync(renders) ? fs.readdirSync(renders).filter((f) => /\.(mp4|mov|webm)$/i.test(f)).map((f) => path.join('renders', f)) : [];
  return { ok, dir: abs, hasIndex, hasSettings, isComposition, renderFiles, reason: ok ? null : 'No index.html with a data-composition-id root found' };
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
      mediaStart: num(a['data-media-start'] ?? a['data-playback-start']) ?? 0, volume: num(a['data-volume']) ?? 1,
      muted: 'muted' in a, hasAudio: tag === 'audio' || (tag === 'video' && !('muted' in a)),
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
  const skip = new Set(['node_modules', '.git', 'renders', '.cache']);
  const walk = (d, rel) => {
    if (out.length >= max) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.')) continue;
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

/** Edit a clip's timing/track attributes in index.html by element id. Returns the new attrs or null. */
export function updateClip(dir, id, patch) {
  const file = path.join(dir, 'index.html');
  let html = fs.readFileSync(file, 'utf8');
  const re = new RegExp(`<([a-zA-Z][\\w-]*)\\b([^>]*?\\bid=["']${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*?)(/?)>`);
  const m = re.exec(html);
  if (!m) return null;
  let attrs = m[2];
  const set = (name, value) => {
    if (value === null || value === undefined) return;
    const v = typeof value === 'number' ? String(Math.round(value * 1000) / 1000) : String(value);
    const ar = new RegExp(`(\\s${name}=)(["'])[^"']*\\2`);
    attrs = ar.test(attrs) ? attrs.replace(ar, `$1"${v}"`) : `${attrs} ${name}="${v}"`;
  };
  if ('start' in patch) set('data-start', Math.max(0, patch.start));
  if ('duration' in patch) set('data-duration', Math.max(0.04, patch.duration));
  if ('track' in patch) set('data-track-index', patch.track);
  html = html.slice(0, m.index) + `<${m[1]}${attrs}${m[3]}>` + html.slice(m.index + m[0].length);
  fs.writeFileSync(file, html);
  return parseAttrs(attrs);
}

/** Set attributes on the root composition element (e.g. data-duration). */
export function updateRoot(dir, patch) {
  const file = path.join(dir, 'index.html');
  let html = fs.readFileSync(file, 'utf8');
  const m = /<([a-zA-Z][\w-]*)\b([^>]*?\bdata-composition-id=["'][^"']*["'][^>]*?)(\/?)>/.exec(html);
  if (!m) return null;
  let attrs = m[2];
  for (const [name, value] of Object.entries(patch)) {
    if (value === null || value === undefined) continue;
    const v = typeof value === 'number' ? String(Math.round(value * 1000) / 1000) : String(value);
    const ar = new RegExp(`(\\s${name}=)(["'])[^"']*\\2`);
    attrs = ar.test(attrs) ? attrs.replace(ar, `$1"${v}"`) : `${attrs} ${name}="${v}"`;
  }
  html = html.slice(0, m.index) + `<${m[1]}${attrs}${m[3]}>` + html.slice(m.index + m[0].length);
  fs.writeFileSync(file, html);
  return parseAttrs(attrs);
}

/** Create a new project folder from a template. Returns the absolute dir. */
export function createProject(name, { template = 'blank', base = path.join(ROOT, 'projects'), width = 1280, height = 720, fps = 30 } = {}) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'video';
  fs.mkdirSync(base, { recursive: true });
  let dir = path.join(base, slug); let n = 2;
  while (fs.existsSync(dir)) dir = path.join(base, `${slug}-${n++}`);
  const tpl = path.join(ROOT, 'templates', template);
  fs.cpSync(tpl, dir, { recursive: true });
  for (const sub of ['assets', 'renders']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  const index = path.join(dir, 'index.html');
  if (fs.existsSync(index)) {
    let html = fs.readFileSync(index, 'utf8');
    html = html.replace(/\{\{title\}\}/g, name).replace(/\{\{id\}\}/g, slug).replace(/\{\{width\}\}/g, String(width)).replace(/\{\{height\}\}/g, String(height)).replace(/\{\{fps\}\}/g, String(fps));
    fs.writeFileSync(index, html);
  }
  const brief = path.join(dir, 'BRIEF.md');
  if (fs.existsSync(brief)) fs.writeFileSync(brief, fs.readFileSync(brief, 'utf8').replace(/\{\{title\}\}/g, name));
  return dir;
}

/** Resolve a project-relative path safely. Returns null when it escapes the project. */
export function safePath(dir, rel) {
  const abs = path.resolve(dir, rel || '');
  return abs === dir || abs.startsWith(dir + path.sep) ? abs : null;
}
