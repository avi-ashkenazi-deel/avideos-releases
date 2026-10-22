/** Tiny DOM helpers so panels stay readable without a framework. */
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
