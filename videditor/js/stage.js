// Studio-side controller for a composition iframe running engine/runtime.js.
import { h } from './ui.js';

export class Stage {
  constructor(container) {
    this.container = container; this.info = null; this.time = 0; this.playing = false; this.listeners = new Map(); this._seq = 0; this._pending = new Map();
    this.iframe = h('iframe', { class: 'stage-frame', sandbox: 'allow-scripts allow-same-origin', title: 'Composition preview' });
    this.container.append(this.iframe);
    window.addEventListener('message', this._onMsg = (e) => { const m = e.data; if (!m || !m.__videditor || e.source !== this.iframe.contentWindow) return; this._handle(m); });
    this.ro = new ResizeObserver(() => this.fit()); this.ro.observe(container);
  }
  on(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); return () => this.listeners.get(type).delete(fn); }
  emit(type, data) { for (const fn of this.listeners.get(type) || []) fn(data); }
  load(src) {
    return new Promise((resolve) => {
      this._onReady = (info) => { this._onReady = null; resolve(info); };
      this.iframe.src = src;
      setTimeout(() => { if (this._onReady) { this._onReady = null; resolve(null); } }, 10000);
    });
  }
  reload(keepTime = true) { const t = this.time; return this.load(this.iframe.src.replace(/([?&])_=\d+/, '$1_=' + Date.now()) + (/[?&]_=/.test(this.iframe.src) ? '' : '&_=' + Date.now())).then((info) => { if (keepTime) this.seek(Math.min(t, info?.duration ?? t)); return info; }); }
  post(msg) { this.iframe.contentWindow?.postMessage({ __videditor: true, ...msg }, '*'); }
  _handle(m) {
    switch (m.type) {
      case 'ready': this.info = m; this.fit(); this.time = 0; this.emit('ready', m); this._onReady?.(m); break;
      case 'info': this.info = m; if (this._pending.has(m.id)) { this._pending.get(m.id)(m); this._pending.delete(m.id); } break;
      case 'seeked': this.time = m.t; if (this._pending.has(m.id)) { this._pending.get(m.id)(m.t); this._pending.delete(m.id); } this.emit('time', m.t); break;
      case 'timeupdate': this.time = m.t; this.emit('time', m.t); break;
      case 'play': this.playing = true; this.emit('play'); break;
      case 'pause': this.playing = false; this.time = m.t; this.emit('pause'); this.emit('time', m.t); break;
      case 'ended': this.playing = false; this.time = m.t; this.emit('pause'); this.emit('ended'); break;
      case 'select': this.emit('select', m); break;
    }
  }
  seek(t) { const id = ++this._seq; this.time = t; this.emit('time', t); return new Promise((resolve) => { this._pending.set(id, resolve); this.post({ type: 'seek', t, id }); setTimeout(() => { if (this._pending.has(id)) { this._pending.delete(id); resolve(t); } }, 3000); }); }
  refreshInfo() { const id = ++this._seq; return new Promise((resolve) => { this._pending.set(id, resolve); this.post({ type: 'info', id }); setTimeout(() => resolve(this.info), 2000); }); }
  play() { this.post({ type: 'play', t: this.time }); }
  pause() { this.post({ type: 'pause' }); }
  toggle() { this.playing ? this.pause() : this.play(); }
  select(id) { this.post({ type: 'select', id }); }
  get duration() { return this.info?.duration || 0; }
  get fps() { return this.info?.fps || 30; }
  fit() {
    if (!this.info) return;
    const r = this.container.getBoundingClientRect();
    const { width, height } = this.info;
    const scale = Math.min((r.width - 24) / width, (r.height - 24) / height, 1.5);
    Object.assign(this.iframe.style, { width: `${width}px`, height: `${height}px`, transform: `scale(${scale})`, left: `${(r.width - width * scale) / 2}px`, top: `${(r.height - height * scale) / 2}px` });
    this.scale = scale;
  }
  destroy() { window.removeEventListener('message', this._onMsg); this.ro.disconnect(); this.iframe.remove(); }
}
