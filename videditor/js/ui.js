import { icon } from './icons.js';

/** h('div.cls#id', {attrs, on: {click}}, ...children) */
export function h(sel, attrs = {}, ...children) {
  const [tag, ...parts] = sel.split(/(?=[.#])/);
  const el = document.createElement(tag || 'div');
  for (const p of parts) { if (p[0] === '.') el.classList.add(p.slice(1)); else el.id = p.slice(1); }
  if (attrs instanceof Node || typeof attrs === 'string' || Array.isArray(attrs)) { children.unshift(attrs); attrs = {}; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'cls') el.className = [el.className, v].filter(Boolean).join(' ');
    else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const svg = (name) => { const s = document.createElement('span'); s.innerHTML = icon(name); const el = s.firstChild; el.classList.add('ic'); return el; };
export const btn = (label, { icon: ic, cls = '', title, onClick, disabled } = {}) => h('button.btn', { class: `btn ${cls}`, title: title || (typeof label === 'string' ? label : undefined), disabled, on: { click: onClick } }, ic ? svg(ic) : null, label);

export function fmtTime(s, { frames = false, fps = 30 } = {}) {
  if (s === null || s === undefined || !Number.isFinite(s)) return '–:––';
  const m = Math.floor(s / 60); const sec = Math.floor(s - m * 60);
  if (frames) { const f = Math.round((s - Math.floor(s)) * fps); return `${m}:${String(sec).padStart(2, '0')}.${String(f).padStart(2, '0')}`; }
  return `${m}:${String(sec).padStart(2, '0')}.${String(Math.floor((s % 1) * 10))}`;
}
export function relTime(iso) {
  if (!iso) return '';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return 'just now'; if (d < 3600) return `${Math.floor(d / 60)}m ago`; if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 7 * 86400) return `${Math.floor(d / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}
export const initials = (name) => (name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
export const avatar = (name, agent) => h('span.avatar', { class: `avatar ${agent ? 'agent' : ''}`, title: name }, agent ? svg('spark') : initials(name));

/** Small, safe Markdown → DOM: paragraphs, headings, lists, fenced code, `code`, **bold**, *em*, links. */
export function md(text) {
  const root = document.createDocumentFragment();
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  let i = 0; let para = [];
  const flush = () => { if (para.length) { root.append(h('p', inline(para.join('\n')))); para = []; } };
  const isItem = (l) => /^\s*([-*•]|\d+[.)])\s+/.test(l);
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*```/.test(l)) { flush(); const buf = []; i++; while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]); i++; root.append(h('pre.code', h('code', buf.join('\n')))); continue; }
    if (/^#{1,6}\s/.test(l)) { flush(); const lvl = l.match(/^#+/)[0].length; root.append(h(`h${Math.min(6, lvl + 2)}`, inline(l.replace(/^#+\s*/, '')))); i++; continue; }
    if (isItem(l)) { flush(); const list = h(/^\s*\d/.test(l) ? 'ol' : 'ul'); while (i < lines.length && isItem(lines[i])) { list.append(h('li', inline(lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, '')))); i++; } root.append(list); continue; }
    if (!l.trim()) { flush(); i++; continue; }
    para.push(l); i++;
  }
  flush();
  return root;
}
function inline(s) {
  const out = []; const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(https?:\/\/[^\s)<>]+)/g; let last = 0; let m;
  const br = (t) => t.split('\n').flatMap((part, k) => (k ? [h('br'), part] : [part]));
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(...br(s.slice(last, m.index)));
    if (m[1]) out.push(h('code', m[1].slice(1, -1))); else if (m[2]) out.push(h('strong', m[2].slice(2, -2))); else if (m[3]) out.push(h('em', m[3].slice(1, -1))); else out.push(h('a', { href: m[4], target: '_blank', rel: 'noopener' }, m[4]));
    last = re.lastIndex;
  }
  if (last < s.length) out.push(...br(s.slice(last)));
  return out;
}

/** Studio | Review switch. Same place in both top bars. */
export function modeToggle(project, active, navigate) {
  const b = (key, label, href, disabled, title) => h('button', { class: `seg-btn ${active === key ? 'on' : ''}`, disabled: !!disabled, title, on: { click: () => { if (active !== key && !disabled) navigate(href); } } }, label);
  return h('div.seg', { role: 'tablist', 'aria-label': 'Mode' },
    b('studio', 'Studio', `#/studio/${project.id}`, !project.dir, project.dir ? 'Edit the composition with the agent' : 'This project has no composition to edit'),
    b('review', 'Review', `#/p/${project.id}`, false, 'Watch renders and leave notes'));
}

/** A button that opens a small menu. items: [{ label, icon, hint, onClick, primary }] (null entries are skipped). */
export function menuButton(label, { icon: ic, cls = '', title } = {}, items = []) {
  const wrap = h('div.menuwrap');
  const trigger = h('button', { class: `btn ${cls}`, title, 'aria-haspopup': 'menu' }, ic ? svg(ic) : null, label, svg('chevron'));
  const pop = h('div.menu.hidden', { role: 'menu' }, items.filter(Boolean).map((it) => h('button', { class: `menu-item ${it.primary ? 'primary' : ''}`, role: 'menuitem', on: { click: async () => { close(); await it.onClick?.(); } } }, it.icon ? svg(it.icon) : null, h('span.mi-text', h('span', it.label), it.hint ? h('span.mi-hint', it.hint) : null))));
  const onDoc = (e) => { if (!wrap.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); trigger.focus(); } };
  function open() { pop.classList.remove('hidden'); trigger.classList.add('active'); setTimeout(() => document.addEventListener('pointerdown', onDoc), 0); document.addEventListener('keydown', onKey, true); pop.querySelector('.menu-item')?.focus(); }
  function close() { pop.classList.add('hidden'); trigger.classList.remove('active'); document.removeEventListener('pointerdown', onDoc); document.removeEventListener('keydown', onKey, true); }
  trigger.addEventListener('click', () => (pop.classList.contains('hidden') ? open() : close()));
  wrap.append(trigger, pop);
  return wrap;
}

export function toast(msg, kind = '') {
  const t = h('div.toast', { class: `toast ${kind}` }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, 2600);
}

export function modal(title, body, { actions = [], wide = false } = {}) {
  return new Promise((resolve) => {
    const close = (v) => { bg.remove(); document.removeEventListener('keydown', esc); resolve(v); };
    // Esc closes. Enter in a text field (or ⌘/Ctrl+Enter in a textarea) runs the primary action, else the last one.
    const esc = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); return close(null); }
      if (e.key !== 'Enter' || !actions.length) return;
      const t = e.target; const inText = t instanceof HTMLInputElement && !['checkbox', 'radio', 'file', 'color'].includes(t.type); const inArea = t instanceof HTMLTextAreaElement;
      if (!(inText || (inArea && (e.metaKey || e.ctrlKey)) || (!inArea && !inText && !(t instanceof HTMLSelectElement) && !(t instanceof HTMLButtonElement)))) return;
      if (!bg.contains(t) && t !== document.body) return;
      e.preventDefault();
      const btns = [...bg.querySelectorAll('.actions .btn')]; const primary = btns.find((b) => b.classList.contains('primary')) || btns[btns.length - 1];
      primary?.click();
    };
    const bg = h('div.modal-bg', { on: { click: (e) => { if (e.target === bg) close(null); } } },
      h('div.modal', { style: wide ? { width: 'min(960px,100%)' } : {} },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, h('h2', { style: { flex: 1 } }, title), btn('', { icon: 'close', cls: 'ghost icon', title: 'Close', onClick: () => close(null) })),
        body,
        actions.length ? h('div.actions', actions.map((a) => btn(a.label, { cls: a.cls || '', icon: a.icon, onClick: async () => { const r = a.onClick ? await a.onClick() : a.value; if (r !== false) close(r ?? a.value ?? true); } }))) : null,
      ));
    document.body.append(bg);
    document.addEventListener('keydown', esc);
    const first = bg.querySelector('input, textarea'); if (first) first.focus();
  });
}

export const getAuthor = () => localStorage.getItem('videditor.author') || '';
export const setAuthor = (n) => localStorage.setItem('videditor.author', n);
export async function ensureAuthor() {
  if (getAuthor()) return getAuthor();
  const input = h('input.text', { placeholder: 'Your name', maxlength: 60 });
  const r = await modal('Who is reviewing?', h('div', h('p.muted', 'Your name is shown on comments and in the brief your agent reads.'), input), { actions: [{ label: 'Continue', cls: 'primary', onClick: () => { if (!input.value.trim()) { input.focus(); return false; } setAuthor(input.value.trim()); return true; } }] });
  if (!r && !getAuthor()) setAuthor('Reviewer');
  return getAuthor();
}

export const copyText = async (text) => { try { await navigator.clipboard.writeText(text); return true; } catch { const ta = h('textarea', { value: text, style: { position: 'fixed', opacity: 0 } }); document.body.append(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok; } };
export const fileToDataUrl = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/** Shared confirm dialog for deleting a project. Returns true when deleted. */
export async function confirmDeleteProject(api, p) {
  const own = p.dir && /\/videditor\/projects\//.test(p.dir);
  const cb = h('input', { type: 'checkbox', checked: !!own });
  const r = await modal(`Delete “${p.name}”?`, h('div',
    h('p.muted', `${p.versions?.length || 0} version(s) and all notes are removed. This cannot be undone.`),
    p.dir ? h('label', { style: { display: own ? 'flex' : 'none', gap: '8px', alignItems: 'center', marginTop: '8px' } }, cb, h('span', 'Also delete the composition folder ', h('code.mono.small', p.dir))) : null,
    p.dir && !own ? h('p.small.muted', { style: { marginTop: '8px' } }, `The composition folder ${p.dir} is yours and is left untouched.`) : null,
  ), { actions: [{ label: 'Delete', cls: 'danger', value: true }] });
  if (!r) return false;
  try { await api.deleteProject(p.id, own && cb.checked); toast('Project deleted', 'ok'); return true; } catch (e) { toast(e.message, 'err'); return false; }
}

/** Keyboard shortcut sheet (press ? in Studio or Review). rows: [[key, what], …] */
export function shortcutsSheet(title, rows) {
  return modal(title, h('div', { style: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', fontSize: '13px' } }, rows.flatMap(([k, what]) => [h('span', k.split(' ').map((kk, i) => [i ? ' ' : null, h('span.kbd', kk)])), h('span.muted', what)])), { actions: [{ label: 'Close', value: true }] });
}
