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
      compositionId: a['data-composition-id'] || null, depth, file: path.relative(process.cwd(), file), fileAbs: file,
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

export function parseProject(dir, entry = 'index.html') {
  const d = detectProject(dir);
  if (!d.ok) return null;
  const file = safePath(d.dir, entry || 'index.html'); if (!file || !fs.existsSync(file)) return null;
  const comp = parseComposition(file);
  comp.dir = d.dir; comp.entry = path.relative(d.dir, file);
  return comp;
}

/** Compositions in a project: index.html plus variants/*.html (each a full composition). */
export function listVariants(dir) {
  const out = [{ entry: 'index.html', name: 'Main' }];
  const vd = path.join(dir, 'variants');
  if (fs.existsSync(vd)) for (const f of fs.readdirSync(vd).filter((f) => /\.html?$/i.test(f)).sort()) out.push({ entry: `variants/${f}`, name: f.replace(/\.html?$/i, '').replace(/[-_]+/g, ' ') });
  return out.map((v) => { let title = null; try { const m = /<title>([^<]*)<\/title>/i.exec(fs.readFileSync(path.join(dir, v.entry), 'utf8')); title = m ? m[1].trim() : null; } catch {} return { ...v, title }; });
}
export function createVariant(dir, name, from = 'index.html') {
  const src = safePath(dir, from); if (!src || !fs.existsSync(src)) return null;
  const slug = String(name || 'variant').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'variant';
  fs.mkdirSync(path.join(dir, 'variants'), { recursive: true });
  let file = path.join(dir, 'variants', `${slug}.html`); let n = 2; while (fs.existsSync(file)) file = path.join(dir, 'variants', `${slug}-${n++}.html`);
  let html = fs.readFileSync(src, 'utf8');
  // variants live one folder down: make root-relative references work from there
  if (path.dirname(src) === dir) html = html.replace(/(href|src)=(["'])(?!https?:|\/|data:|#|\.\.\/)([^"']+)\2/g, '$1=$2../$3$2');
  // the variant's display name lives in its <title>
  const title = String(name || slug).replace(/[<>&]/g, '');
  html = /<title>[^<]*<\/title>/i.test(html) ? html.replace(/<title>[^<]*<\/title>/i, `<title>${title}</title>`) : html.replace(/<head[^>]*>/i, (m) => `${m}\n<title>${title}</title>`);
  fs.writeFileSync(file, html);
  return path.relative(dir, file);
}

/** History: snapshots of a composition file under .history/, newest first. */
export function snapshot(dir, entry, label = '', by = 'you') {
  const src = safePath(dir, entry); if (!src || !fs.existsSync(src)) return null;
  const hd = path.join(dir, '.history'); fs.mkdirSync(hd, { recursive: true });
  const content = fs.readFileSync(src);
  const last = listHistory(dir, entry)[0];
  if (last && fs.existsSync(path.join(dir, last.file)) && fs.readFileSync(path.join(dir, last.file)).equals(content)) return last; // unchanged: no duplicate
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `${stamp}__${entry.replace(/[\/\\]/g, '~')}__${by}__${String(label).replace(/[^\w .#-]+/g, '').slice(0, 40)}.html`;
  fs.writeFileSync(path.join(hd, name), content);
  const all = listHistory(dir, entry); for (const h of all.slice(120)) { try { fs.unlinkSync(path.join(dir, h.file)); } catch {} }
  return { file: `.history/${name}`, at: new Date().toISOString(), entry, by, label };
}
export function listHistory(dir, entry = null) {
  const hd = path.join(dir, '.history'); if (!fs.existsSync(hd)) return [];
  return fs.readdirSync(hd).filter((f) => f.endsWith('.html')).map((f) => {
    const m = /^(.+?)__(.+?)__(.+?)__(.*)\.html$/.exec(f); if (!m) return null;
    const at = m[1].replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, '$1T$2:$3:$4.$5Z');
    return { file: `.history/${f}`, at, entry: m[2].replace(/~/g, '/'), by: m[3], label: m[4], size: fs.statSync(path.join(hd, f)).size };
  }).filter(Boolean).filter((h) => !entry || h.entry === entry).sort((a, b) => b.at.localeCompare(a.at));
}
export function restoreSnapshot(dir, file, entry) {
  const src = safePath(dir, file); const dest = safePath(dir, entry); if (!src || !dest || !fs.existsSync(src)) return false;
  snapshot(dir, entry, 'before restore', 'you');
  fs.copyFileSync(src, dest); return true;
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
  const skip = new Set(['node_modules', '.git', 'renders', '.cache', '.history', '.analysis']);
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
export function updateClip(dir, id, patch, entry = 'index.html') {
  const file = safePath(dir, entry); if (!file || !fs.existsSync(file)) return null;
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
export function updateRoot(dir, patch, entry = 'index.html') {
  const file = safePath(dir, entry); if (!file || !fs.existsSync(file)) return null;
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
export function createProject(name, { template = 'blank', base = path.join(ROOT, 'projects'), width = 1280, height = 720, fps = 30, brand = null } = {}) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'video';
  fs.mkdirSync(base, { recursive: true });
  let dir = path.join(base, slug); let n = 2;
  while (fs.existsSync(dir)) dir = path.join(base, `${slug}-${n++}`);
  const tpl = path.join(ROOT, 'templates', fs.existsSync(path.join(ROOT, 'templates', template)) ? template : 'blank');
  fs.cpSync(tpl, dir, { recursive: true });
  writeBrand(dir, brand || readBrand(dir) || {});
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

/** Resolve a media src used in a composition to an absolute path. `library/…` points into the linked asset folder. */
export function resolveSrc(projectDir, assetsDir, src, fromFile = null) {
  if (!src || /^(https?:|data:|blob:)/i.test(src)) return null;
  const clean = src.replace(/[?#].*$/, '');
  if (/^\/?library\//.test(clean)) return assetsDir ? path.resolve(assetsDir, clean.replace(/^\/?library\//, '')) : null;
  if (clean.startsWith('/')) return path.resolve(projectDir, '.' + clean);
  return path.resolve(fromFile ? path.dirname(fromFile) : projectDir, clean);
}

export const DEFAULT_BRAND = { name: '', colors: { primary: '#ffd166', background: '#101218', text: '#ffffff', muted: '#aeb4c2', accent: '#7cc4ff' }, font: { family: '-apple-system, Inter, Helvetica, Arial, sans-serif', url: '' }, logo: '', notes: '' };
export function brandCss(brand) {
  const b = { ...DEFAULT_BRAND, ...brand, colors: { ...DEFAULT_BRAND.colors, ...(brand?.colors || {}) }, font: { ...DEFAULT_BRAND.font, ...(brand?.font || {}) } };
  return `/* generated from brand.json; edit brand.json or the Brand panel, not this file */\n${b.font.url ? `@import url("${b.font.url}");\n` : ''}:root {\n  --brand-primary: ${b.colors.primary};\n  --brand-background: ${b.colors.background};\n  --brand-text: ${b.colors.text};\n  --brand-muted: ${b.colors.muted};\n  --brand-accent: ${b.colors.accent};\n  --brand-font: ${b.font.family};\n  --brand-logo: ${b.logo ? `url("${b.logo}")` : 'none'};\n}\n`;
}
export function writeBrand(dir, brand) {
  const b = { ...DEFAULT_BRAND, ...brand, colors: { ...DEFAULT_BRAND.colors, ...(brand?.colors || {}) }, font: { ...DEFAULT_BRAND.font, ...(brand?.font || {}) } };
  fs.writeFileSync(path.join(dir, 'brand.json'), JSON.stringify(b, null, 2));
  fs.writeFileSync(path.join(dir, 'brand.css'), brandCss(b));
  return b;
}
export function readBrand(dir) { try { return { ...DEFAULT_BRAND, ...JSON.parse(fs.readFileSync(path.join(dir, 'brand.json'), 'utf8')) }; } catch { return null; } }

/** Insert a clip element into index.html right after the root composition's opening tag. */
export function insertClipHtml(dir, html, entry = 'index.html') {
  const file = safePath(dir, entry); if (!file || !fs.existsSync(file)) return false;
  let src = fs.readFileSync(file, 'utf8');
  const m = /<([a-zA-Z][\w-]*)\b[^>]*?\bdata-composition-id=["'][^"']*["'][^>]*>/.exec(src);
  if (!m) return false;
  const at = m.index + m[0].length;
  src = src.slice(0, at) + '\n  ' + html.trim() + src.slice(at);
  fs.writeFileSync(file, src);
  return true;
}

/** Resolve a project-relative path safely. Returns null when it escapes the project. */
export function safePath(dir, rel) {
  const abs = path.resolve(dir, rel || '');
  return abs === dir || abs.startsWith(dir + path.sep) ? abs : null;
}
