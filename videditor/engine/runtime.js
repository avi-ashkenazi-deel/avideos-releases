/* Videditor composition runtime.
 * Injected into a composition page by the server (?runtime=1). It makes the
 * page a deterministic, seekable video: given a time t, every clip's
 * visibility, every CSS/Web animation and every <video>/<audio> element is
 * set to exactly where it should be. The Studio player and the renderer both
 * drive the page through window.__videditor and postMessage.
 *
 * Composition format (plain HTML):
 *   <div id="stage" data-composition-id="launch" data-duration="6" data-width="1280" data-height="720" data-fps="30">
 *     <h1 id="title" class="clip" data-start="1" data-duration="4" data-track-index="2">Hello</h1>
 *   </div>
 * Clips: any element with data-start (seconds). data-duration (seconds, images default 3,
 * media default to source length). data-track-index = timeline lane. Media may set
 * data-media-start (offset into the file) and data-volume (0..1). Animations: CSS
 * keyframes / Web Animations on or inside a clip run on the clip's local time.
 * Optional hooks: window.__seek = (t, local) => {} for custom JS scenes,
 * window.__timelines[id] with .seek()/.pause() for GSAP-style timelines.
 */
(() => {
  if (window.__videditor) return;
  // The runtime itself runs on the real clock; the composition's clock (engine/clock.js) follows the playhead.
  const RT = window.__vdClock?.native || { now: () => performance.now(), raf: (f) => requestAnimationFrame(f), caf: (id) => cancelAnimationFrame(id), setTimeout: (f, d) => setTimeout(f, d) };
  const num = (v, d = null) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
  const root = document.querySelector('[data-composition-id]') || document.body;
  const inRender = /[?&]render=1/.test(location.search);
  // Transparent renders (WebM/ProRes with alpha): the page background goes away; the stage keeps whatever it declares.
  if (/[?&]alpha=1/.test(location.search)) { document.documentElement.style.background = 'transparent'; if (document.body) document.body.style.background = 'transparent'; else window.addEventListener('DOMContentLoaded', () => { document.body.style.background = 'transparent'; }); }
  const state = { t: 0, playing: false, clock0: 0, t0: 0, raf: null, selected: null, pending: 0 };

  const collectClips = () => Array.from(document.querySelectorAll('[data-start]')).filter((el) => el !== root).map((el) => {
    const start = num(el.dataset.start, 0);
    const isMedia = el.tagName === 'VIDEO' || el.tagName === 'AUDIO';
    let duration = num(el.dataset.duration, null);
    if (duration === null) duration = isMedia && Number.isFinite(el.duration) && el.duration > 0 ? el.duration - num(el.dataset.mediaStart, 0) : (el.tagName === 'IMG' ? 3 : null);
    return { el, id: el.id || null, tag: el.tagName.toLowerCase(), start, duration, track: num(el.dataset.trackIndex, 0), isMedia, mediaStart: num(el.dataset.mediaStart, 0), volume: num(el.dataset.volume, 1), text: /^(H[1-6]|P|SPAN|DIV|LI|BUTTON)$/.test(el.tagName) ? (el.textContent || '').trim().slice(0, 80) : '' };
  });
  // Nested compositions: a clip with data-composition-src hosts an iframe running this same runtime.
  const nested = new Map(); // el -> { iframe, ready, pendingSeek }
  const settleWaits = new Map(); // id -> resolve
  let nseq = 0;
  function ensureNested(c) {
    const src = c.el.dataset.compositionSrc; if (!src || nested.has(c.el)) return;
    const url = new URL(src, location.href); url.searchParams.set('runtime', '1'); if (inRender) url.searchParams.set('render', '1');
    const iframe = document.createElement('iframe');
    iframe.src = url.toString(); iframe.setAttribute('allowtransparency', 'true');
    Object.assign(iframe.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', border: '0', background: 'transparent', pointerEvents: inRender ? 'none' : 'auto' });
    iframe.setAttribute('data-vd-nested', ''); c.el.appendChild(iframe); nested.set(c.el, { iframe, ready: false });
  }
  const childSeek = (c, t) => new Promise((resolve) => { const nz = nested.get(c.el); if (!nz?.iframe.contentWindow) return resolve(); const id = 'n' + (++nseq); settleWaits.set(id, resolve); nz.iframe.contentWindow.postMessage({ __videditor: true, type: 'seek', t, id }, '*'); RT.setTimeout(() => { if (settleWaits.has(id)) { settleWaits.delete(id); resolve(); } }, 2000); });
  if (inRender) {
    const q = `vdrender=1&fps=${num(root.dataset.fps, 30)}&w=${num(root.dataset.width, 1920)}&h=${num(root.dataset.height, 1080)}`;
    for (const v of document.querySelectorAll('video')) { const s = v.getAttribute('src'); if (!s || /^(data|blob):/.test(s) || /vdrender=1/.test(s)) continue; v.setAttribute('src', s + (s.includes('?') ? '&' : '?') + q); v.preload = 'auto'; try { v.load(); } catch {} }
  }
  let clips = collectClips();
  for (const c of clips) { if (c.el.dataset.trackIndex !== undefined && !c.el.style.zIndex) c.el.style.zIndex = String(c.track); ensureNested(c); }
  const info = () => {
    clips = collectClips();
    const ends = clips.filter((c) => c.duration !== null).map((c) => c.start + c.duration);
    const duration = num(root.dataset.duration, null) ?? (ends.length ? Math.max(...ends) : 5);
    return { id: root.dataset.compositionId || 'composition', duration, width: num(root.dataset.width, root.clientWidth || 1280), height: num(root.dataset.height, root.clientHeight || 720), fps: num(root.dataset.fps, 30), clips: clips.map(({ el, ...c }) => c) };
  };
  const endOf = (c) => (c.duration === null ? Infinity : c.start + c.duration);
  const clipOf = (el) => { let n = el; while (n && n !== document.body) { if (n.dataset && n.dataset.start !== undefined && n !== root) return clips.find((c) => c.el === n) || null; n = n.parentElement; } return null; };

  // Deterministic seek: visibility, animations, media.
  // Register for the next presented video frame BEFORE moving the video (registered after, the new frame is
  // already out and the callback waits for one that never comes). settleWaits_ awaits it for visible clips.
  function armFrame(c) {
    c.framePending = true;
    c.framePromise = typeof c.el.requestVideoFrameCallback === 'function' ? new Promise((res) => { try { c.el.requestVideoFrameCallback(() => res(true)); } catch { res(false); } }) : null;
  }
  function seek(t) {
    state.t = t;
    window.__vdClock?.advance(t * 1000);
    for (const c of clips) {
      const on = t >= c.start - 1e-6 && t < endOf(c);
      if (c.el.style.visibility !== (on ? 'visible' : 'hidden')) c.el.style.visibility = on ? 'visible' : 'hidden';
      if (c.isMedia) {
        const want = on ? c.mediaStart + (t - c.start) : c.mediaStart;
        if (!state.playing) { if (Math.abs((c.el.currentTime || 0) - want) > 1 / 120) { armFrame(c); c.el.currentTime = want; } if (!c.el.paused) c.el.pause(); }
        else if (on && c.el.paused) { c.el.currentTime = want; c.el.volume = Math.min(1, c.volume); c.el.play().catch(() => {}); }
        else if (!on && !c.el.paused) c.el.pause();
      }
    }
    if (!state.playing) {
      for (const a of document.getAnimations()) {
        const target = a.effect && a.effect.target; const c = target ? clipOf(target) : null;
        const local = c ? t - c.start : t;
        a.pause(); a.currentTime = Math.max(0, local) * 1000;
      }
    }
    for (const [el, nz] of nested) {
      const c = clips.find((x) => x.el === el); if (!c || !nz.iframe.contentWindow) continue;
      const local = Math.max(0, t - c.start + num(el.dataset.playbackStart, 0));
      if (!state.playing) nz.iframe.contentWindow.postMessage({ __videditor: true, type: 'seek', t: local, id: 'x' }, '*');
      else { const on = t >= c.start - 1e-6 && t < endOf(c); if (on && !nz.playing) { nz.playing = true; nz.iframe.contentWindow.postMessage({ __videditor: true, type: 'play', t: local }, '*'); } else if (!on && nz.playing) { nz.playing = false; nz.iframe.contentWindow.postMessage({ __videditor: true, type: 'pause' }, '*'); } }
    }
    if (window.__timelines) for (const [id, tl] of Object.entries(window.__timelines)) { const c = clips.find((x) => x.id === id || (x.el.dataset.compositionId === id)); const local = c ? t - c.start : t; try { tl.pause?.(); tl.seek?.(Math.max(0, local)); } catch {} }
    if (typeof window.__seek === 'function') { try { window.__seek(t); } catch (e) { console.error(e); } }
  }
  // Resolves when the frame for t is actually painted (media seeked, fonts loaded, two frames).
  function seekAndSettle(t) {
    seek(t);
    const waits = [];
    for (const c of clips) if (c.isMedia && c.el.readyState >= 1 && c.el.seeking) waits.push(new Promise((r) => { const done = () => { c.el.removeEventListener('seeked', done); r(); }; c.el.addEventListener('seeked', done); RT.setTimeout(r, 1500); }));
    for (const c of clips) if (nested.has(c.el)) waits.push(childSeek(c, Math.max(0, t - c.start + num(c.el.dataset.playbackStart, 0))));
    if (document.fonts && document.fonts.status !== 'loaded') waits.push(document.fonts.ready.catch(() => {}));
    for (const img of document.images) if (!img.complete) waits.push(new Promise((r) => { img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true }); RT.setTimeout(r, 3000); }));
    return Promise.all(waits).then(() => new Promise((r) => RT.raf(() => RT.raf(() => r(t)))));
  }
  function settleWaits_(t) {
    const waits = [];
    // A visible video whose position changed: wait until the seek finished AND the new frame reached the
    // compositor (requestVideoFrameCallback), so the capture never shows the previous frame.
    for (const c of clips) {
      if (!c.isMedia) continue;
      const visible = c.tag === 'video' && t >= c.start - 1e-6 && t < endOf(c);
      if (visible && c.framePending && c.el.readyState >= 1) {
        const timeout = (ms) => new Promise((res) => RT.setTimeout(() => res(false), ms));
        waits.push((async () => {
          let ok = c.framePromise ? await Promise.race([c.framePromise, timeout(400)]) : (await new Promise((res) => RT.raf(() => RT.raf(res))), true);
          if (!ok) { // e.g. it was seeked while hidden: nudge it once so the current frame is presented again
            const want = c.el.currentTime; armFrame(c); c.el.currentTime = want + 1e-4;
            ok = c.framePromise ? await Promise.race([c.framePromise, timeout(1200)]) : true;
          }
          c.framePending = false;
        })());
      } else if (c.el.readyState >= 1 && c.el.seeking) waits.push(new Promise((r) => { const done = () => { c.el.removeEventListener('seeked', done); r(); }; c.el.addEventListener('seeked', done); RT.setTimeout(r, 3000); }));
    }
    for (const c of clips) if (nested.has(c.el)) waits.push(childSeek(c, Math.max(0, t - c.start + num(c.el.dataset.playbackStart, 0))));
    if (document.fonts && document.fonts.status !== 'loaded') waits.push(document.fonts.ready.catch(() => {}));
    for (const img of document.images) if (!img.complete) waits.push(new Promise((r) => { img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true }); RT.setTimeout(r, 3000); }));
    return Promise.all(waits);
  }
  // Static-frame detection for the renderer: a frame can reuse the previous capture when nothing that paints
  // changed since then: no DOM mutation, no animation in its active phase, no visible video or nested
  // composition, no frame callback or timer ran, and nothing was still loading.
  let domDirty = true; // set by the observer (changes are delivered to it, not left for takeRecords)
  const mo = new MutationObserver(() => { domDirty = true; }); mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  const lastProgress = new WeakMap(); // animation -> progress key at the previous call
  function frameIsStatic() {
    let changed = domDirty || mo.takeRecords().length > 0; domDirty = false;
    if (window.__vdClock && window.__vdClock.takeActivity() > 0) changed = true;
    // Compare every animation with where it was at the previous frame (always update, so the next call is right).
    for (const a of document.getAnimations()) {
      let key; try { const ct = a.effect ? a.effect.getComputedTiming() : null; key = ct ? `${ct.progress}|${ct.currentIteration}` : `${a.currentTime}`; } catch { key = Math.random(); }
      if (lastProgress.get(a) !== key) { changed = true; lastProgress.set(a, key); }
    }
    if (!changed) for (const c of clips) { if ((c.isMedia && c.tag === 'video' || nested.has(c.el)) && state.t >= c.start - 1e-6 && state.t < endOf(c)) { changed = true; break; } }
    if (!changed) for (const el of document.querySelectorAll('canvas, iframe:not([data-vd-nested])')) { if (el.getClientRects().length) { changed = true; break; } }
    return !changed;
  }
  /** Renderer path: seek, wait for media/fonts/images, report whether the frame can reuse the previous capture. */
  function seekForCapture(t) {
    seek(t);
    let loading = (document.fonts && document.fonts.status !== 'loaded') || [...document.images].some((i) => !i.complete);
    return settleWaits_(t).then(() => ({ t, same: !loading && frameIsStatic() }));
  }
  /** Render workers that start mid-film first walk the composition clock from 0, so stateful scripts match. */
  function warmup(t, fps) { if (window.__vdClock) window.__vdClock.warmup(t * 1000, fps || num(root.dataset.fps, 30)); seek(t); }
  function play(from) {
    if (state.playing) return;
    const dur = info().duration;
    if (from !== undefined) seek(from);
    if (state.t >= dur - 1e-3) seek(0); // play at the end starts over
    state.playing = true; state.clock0 = RT.now(); state.t0 = state.t;
    for (const a of document.getAnimations()) a.play();
    const tick = () => {
      if (!state.playing) return;
      const t = state.t0 + (RT.now() - state.clock0) / 1000;
      if (t >= dur) { pause(); seek(dur); post({ type: 'ended', t: dur }); return; }
      seek(t); post({ type: 'timeupdate', t });
      state.raf = RT.raf(tick);
    };
    state.raf = RT.raf(tick);
    post({ type: 'play', t: state.t });
  }
  function pause() {
    if (!state.playing) return;
    state.playing = false; RT.caf(state.raf);
    for (const c of clips) if (c.isMedia && !c.el.paused) c.el.pause();
    for (const nz of nested.values()) { nz.playing = false; nz.iframe.contentWindow?.postMessage({ __videditor: true, type: 'pause' }, '*'); }
    seek(state.t); post({ type: 'pause', t: state.t });
  }
  function select(id) {
    state.selected = id;
    for (const c of clips) c.el.classList.toggle('__vd-selected', !!id && c.id === id);
  }
  const post = (msg) => { try { window.parent !== window && window.parent.postMessage({ __videditor: true, ...msg }, '*'); } catch {} };

  // Styles for selection + baseline. Never ship these in a render.
  if (!inRender) {
    const st = document.createElement('style');
    st.textContent = '.__vd-selected{outline:2px solid #ffd166 !important;outline-offset:2px;} .__vd-hover{outline:1px dashed rgba(255,209,102,.7) !important;}';
    document.head.appendChild(st);
    document.addEventListener('click', (e) => { const c = clipOf(e.target); if (c && c.id) { e.preventDefault(); select(c.id); post({ type: 'select', id: c.id, clip: { id: c.id, tag: c.tag, start: c.start, duration: c.duration, track: c.track, text: c.text } }); } }, true);
    let hov = null;
    document.addEventListener('mousemove', (e) => { const c = clipOf(e.target); const el = c ? c.el : null; if (el !== hov) { hov?.classList.remove('__vd-hover'); hov = el; hov?.classList.add('__vd-hover'); } });
  }
  window.addEventListener('message', async (e) => {
    const m = e.data; if (!m || !m.__videditor) return;
    const fromChild = [...nested.values()].some((nz) => nz.iframe.contentWindow === e.source);
    if (fromChild) { if (m.type === 'seeked' && settleWaits.has(m.id)) { settleWaits.get(m.id)(); settleWaits.delete(m.id); } if (m.type === 'ready') { for (const nz of nested.values()) if (nz.iframe.contentWindow === e.source) nz.ready = true; if (!state.playing) seek(state.t); } return; }
    if (e.source !== window.parent) return;
    switch (m.type) {
      case 'info': post({ type: 'info', id: m.id, ...info() }); break;
      case 'seek': await seekAndSettle(m.t); post({ type: 'seeked', id: m.id, t: m.t }); break;
      case 'play': play(m.t); break;
      case 'pause': pause(); break;
      case 'select': select(m.id || null); break;
      case 'reload': location.reload(); break;
    }
  });
  window.__videditor = { info, seek, seekAndSettle, seekForCapture, warmup, play, pause, select, get time() { return state.t; }, get playing() { return state.playing; } };
  const ready = () => { clips = collectClips(); seek(0); post({ type: 'ready', ...info() }); };
  if (document.readyState === 'complete') ready(); else window.addEventListener('load', ready);
  // Media metadata can arrive after load: refresh durations.
  document.addEventListener('loadedmetadata', () => { clips = collectClips(); if (!state.playing) seek(state.t); }, true);
  // Expose clip rect lookup for the Studio (comments pinned to elements).
  window.__videditor.rectOf = (id) => { const c = clips.find((x) => x.id === id); if (!c) return null; const r = c.el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; };
})();
