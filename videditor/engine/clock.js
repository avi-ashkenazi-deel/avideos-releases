/* Videditor virtual clock. Injected at the very top of <head>, before any composition script runs.
 * The composition's notion of time becomes the video's time: performance.now(), Date, requestAnimationFrame,
 * setTimeout and setInterval all follow the playhead instead of the wall clock. So JavaScript animation,
 * GSAP, Lottie, canvas loops and timers render frame-exact, in the Studio preview and in every render
 * worker alike. The runtime advances the clock on every seek and every playback tick.
 * Opt out per composition with data-real-time on the root element (the server then skips this file).
 */
(() => {
  if (window.__vdClock) return;
  const W = window;
  const native = {
    now: performance.now.bind(performance), Date: W.Date,
    raf: W.requestAnimationFrame.bind(W), caf: W.cancelAnimationFrame.bind(W),
    setTimeout: W.setTimeout.bind(W), clearTimeout: W.clearTimeout.bind(W),
    setInterval: W.setInterval.bind(W), clearInterval: W.clearInterval.bind(W),
  };
  // Wall-clock dates are pinned to midnight UTC of the load day, so every render worker agrees.
  const day = new native.Date(); const EPOCH = native.Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  let ms = 0;                       // video time in milliseconds
  const rafs = new Map(); let rafSeq = 0;
  const timers = new Map(); let timerSeq = 0; let flushQueued = false;

  Object.defineProperty(performance, 'now', { value: () => ms, configurable: true, writable: true });
  class VDate extends native.Date { constructor(...a) { if (a.length === 0) super(EPOCH + ms); else super(...a); } static now() { return EPOCH + ms; } }
  VDate.UTC = native.Date.UTC; VDate.parse = native.Date.parse;
  W.Date = VDate;

  W.requestAnimationFrame = (cb) => { const id = ++rafSeq; rafs.set(id, cb); return id; };
  W.cancelAnimationFrame = (id) => { rafs.delete(id); };

  // Timers run on video time. Ones that are already due (setTimeout(fn, 0) and friends) still fire right
  // away in real time, so libraries that defer work keep working while the video is paused.
  const queueFlush = () => { if (flushQueued) return; flushQueued = true; native.setTimeout(() => { flushQueued = false; fireTimers(ms); }, 0); };
  const addTimer = (fn, delay, args, every) => {
    const id = ++timerSeq; const d = Math.max(0, Number(delay) || 0);
    timers.set(id, { id, due: ms + d, fn, args, every: every ? Math.max(1, d) : 0 });
    if (d === 0) queueFlush();
    return id;
  };
  W.setTimeout = (fn, delay, ...args) => addTimer(fn, delay, args, false);
  W.setInterval = (fn, delay, ...args) => addTimer(fn, delay, args, true);
  W.clearTimeout = W.clearInterval = (id) => { timers.delete(id); };

  const call = (fn, args) => { try { typeof fn === 'function' ? fn(...(args || [])) : (0, eval)(String(fn)); } catch (e) { console.error(e); } };
  function fireTimers(until) {
    for (let guard = 0; guard < 10000; guard++) {
      let next = null; for (const t of timers.values()) if (t.due <= until && (!next || t.due < next.due || (t.due === next.due && t.id < next.id))) next = t;
      if (!next) break;
      const keep = ms; if (next.due > ms) ms = next.due;
      if (next.every) next.due += next.every; else timers.delete(next.id);
      ranCallbacks++; call(next.fn, next.args);
      ms = Math.max(ms, keep);
    }
  }
  let ranCallbacks = 0; // frame callbacks and timers run since the renderer last asked (anything that may have drawn)
  function runRafs() { if (!rafs.size) return; const due = [...rafs]; rafs.clear(); ranCallbacks += due.length; for (const [, cb] of due) { try { cb(ms); } catch (e) { console.error(e); } } }

  /** Move video time to `toMs` and run what is due: timers in order, then one animation frame. */
  function advance(toMs) {
    toMs = Math.max(0, Number(toMs) || 0);
    if (toMs >= ms) fireTimers(toMs);
    ms = toMs;
    runRafs();
  }
  /** Walk from 0 to `toMs` one video frame at a time without painting (for render workers that start mid-film). */
  function warmup(toMs, fps) { const step = 1000 / (fps || 30); for (let t = (toMs >= ms ? ms : 0) + step; t < toMs; t += step) advance(t); advance(toMs); }

  W.__vdClock = { advance, warmup, native, get ms() { return ms; }, takeActivity() { const n = ranCallbacks; ranCallbacks = 0; return n; } };
})();
