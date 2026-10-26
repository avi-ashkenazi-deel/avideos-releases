/** Tiny DOM helpers so panels stay readable without a framework. */
import { icon, type IconName } from './icons';
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && k !== 'list') (el as any)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

export function slider(label: string, opts: { min: number; max: number; step: number; value: number; onInput: (v: number) => void; format?: (v: number) => string }): HTMLElement {
  const fmt = opts.format ?? ((v: number) => v.toFixed(2));
  const out = h('span', { class: 'val' }, fmt(opts.value));
  const input = h('input', { type: 'range', min: opts.min, max: opts.max, step: opts.step, value: opts.value, 'aria-label': label });
  input.addEventListener('input', () => { const v = parseFloat(input.value); out.textContent = fmt(v); opts.onInput(v); });
  const row = h('label', { class: 'slider' }, h('span', { class: 'name' }, label), input, out);
  (row as any).setValue = (v: number) => { input.value = String(v); out.textContent = fmt(v); };
  return row;
}

export function button(label: string, onClick: (e: MouseEvent) => void, cls = ''): HTMLButtonElement {
  return h('button', { type: 'button', class: cls, onClick }, label);
}

export function fileInput(accept: string, onFile: (f: File) => void, multiple = false): HTMLInputElement {
  const inp = h('input', { type: 'file', accept, multiple, style: { display: 'none' } });
  inp.addEventListener('change', () => { const f = inp.files?.[0]; if (f) onFile(f); inp.value = ''; });
  return inp;
}

export function toast(msg: string, ms = 2600): void {
  const el = h('div', { class: 'toast' }, msg);
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, ms);
}

/** Button with an icon and a text label. */
export function iconButton(name: IconName, label: string, onClick: (e: MouseEvent) => void, opts: { cls?: string; title?: string; iconOnly?: boolean; testid?: string } = {}): HTMLButtonElement {
  const b = h('button', { type: 'button', class: 'ib ' + (opts.cls ?? '') + (opts.iconOnly ? ' icon-only' : ''), title: opts.title ?? (opts.iconOnly ? label : undefined), 'aria-label': label, onClick }, icon(name));
  if (!opts.iconOnly) b.append(h('span', {}, label));
  if (opts.testid) b.dataset.testid = opts.testid;
  return b;
}

export interface MenuItem { label: string; icon?: IconName; onClick: () => void; hint?: string; danger?: boolean; testid?: string; separatorBefore?: boolean }

/** Dropdown menu: a trigger button that opens a list of actions. Closes on click, Escape, or outside click. */
export function menu(label: string, items: MenuItem[], opts: { icon?: IconName; cls?: string; testid?: string } = {}): HTMLElement {
  const list = h('div', { class: 'menu-list', role: 'menu' });
  const wrap = h('div', { class: 'menu ' + (opts.cls ?? '') });
  const trigger = h('button', { type: 'button', class: 'ib menu-trigger', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, ...(opts.icon ? [icon(opts.icon)] : []), h('span', {}, label), icon('chevronDown', 14));
  if (opts.testid) trigger.dataset.testid = opts.testid;
  const onDoc = (e: PointerEvent) => { if (!wrap.contains(e.target as Node)) close(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  const close = () => { wrap.classList.remove('open'); trigger.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', onDoc, true); document.removeEventListener('keydown', onKey, true); };
  const open = () => { wrap.classList.add('open'); trigger.setAttribute('aria-expanded', 'true'); document.addEventListener('pointerdown', onDoc, true); document.addEventListener('keydown', onKey, true); };
  trigger.addEventListener('click', () => (wrap.classList.contains('open') ? close() : open()));
  for (const it of items) {
    if (it.separatorBefore) list.append(h('div', { class: 'menu-sep' }));
    const b = h('button', { type: 'button', class: 'menu-item' + (it.danger ? ' danger' : ''), role: 'menuitem', title: it.hint, onClick: () => { close(); it.onClick(); } }, ...(it.icon ? [icon(it.icon)] : []), h('span', {}, it.label));
    if (it.testid) b.dataset.testid = it.testid;
    list.append(b);
  }
  wrap.append(trigger, list);
  return wrap;
}

/** Small info glyph with a tooltip explanation. */
export function help(text: string): HTMLElement {
  return h('span', { class: 'help', title: text, 'aria-label': text, tabindex: 0 }, icon('info', 13));
}

/** Floating context menu at a screen position (right-click). Closes on click, Escape, scroll or outside click. */
export function contextMenu(x: number, y: number, items: MenuItem[]): void {
  document.querySelector('.ctxmenu')?.remove();
  const list = h('div', { class: 'menu-list ctxmenu', role: 'menu', style: { left: `${x}px`, top: `${y}px` } });
  const close = () => { list.remove(); document.removeEventListener('pointerdown', onDoc, true); document.removeEventListener('keydown', onKey, true); window.removeEventListener('scroll', close, true); };
  const onDoc = (e: PointerEvent) => { if (!list.contains(e.target as Node)) close(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  for (const it of items) {
    if (it.separatorBefore) list.append(h('div', { class: 'menu-sep' }));
    const b = h('button', { type: 'button', class: 'menu-item' + (it.danger ? ' danger' : ''), role: 'menuitem', title: it.hint, onClick: () => { close(); it.onClick(); } }, ...(it.icon ? [icon(it.icon)] : []), h('span', {}, it.label));
    if (it.testid) b.dataset.testid = it.testid;
    list.append(b);
  }
  document.body.append(list);
  // keep it on screen
  const r = list.getBoundingClientRect();
  if (r.right > innerWidth) list.style.left = `${Math.max(4, innerWidth - r.width - 4)}px`;
  if (r.bottom > innerHeight) list.style.top = `${Math.max(4, innerHeight - r.height - 4)}px`;
  document.addEventListener('pointerdown', onDoc, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', close, true);
}
