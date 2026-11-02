// Frame-accurate wrapper around a <video>.
export class Player {
  constructor(video, { fps = 30 } = {}) {
    this.video = video; this.fps = fps; this.listeners = new Set();
    this._raf = null;
    const tick = () => { this.emit(); this._raf = requestAnimationFrame(tick); };
    video.addEventListener('play', () => { if (!this._raf) tick(); });
    video.addEventListener('pause', () => { cancelAnimationFrame(this._raf); this._raf = null; this.emit(); });
    video.addEventListener('seeked', () => this.emit());
    video.addEventListener('loadedmetadata', () => this.emit());
    video.addEventListener('ended', () => this.emit());
  }
  get time() { return this.video.currentTime || 0; }
  get duration() { return Number.isFinite(this.video.duration) ? this.video.duration : 0; }
  get paused() { return this.video.paused; }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this); }
  seek(t) { const d = this.duration || Infinity; this.video.currentTime = Math.max(0, Math.min(d - 0.001, t)); }
  step(frames) { if (!this.video.paused) this.video.pause(); this.seek(this.time + frames / this.fps); }
  toggle() { if (this.video.paused) this.video.play().catch(() => {}); else this.video.pause(); }
  play() { return this.video.play().catch(() => {}); }
  pause() { this.video.pause(); }
  setRate(r) { this.video.playbackRate = r; }
}
