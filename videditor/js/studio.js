// Studio: chat with the agent on the left, live composition preview in the
// middle, timeline below, layers/files on the right. The preview is the real
// composition running in an iframe with the seekable runtime.
import { api } from './api.js';
import { h, btn, svg, modal, toast, fmtTime, relTime, md, getAuthor, ensureAuthor, copyText, confirmDeleteProject, shortcutsSheet } from './ui.js';
import { Stage } from './stage.js';
import { DrawLayer, COLORS } from './draw.js';
import { VoiceRecorder, highlightPointing } from './voice.js';

export async function renderStudio(root, { projectId, prompt, navigate, topbar }) {
  let project = await api.project(projectId);
  if (!project.dir) { root.replaceChildren(h('div.empty', h('h2', 'This project has no composition'), h('p.muted', 'It was created for review only. Make a new video to use Studio.'), btn('Back', { onClick: () => navigate(`#/p/${project.id}`) }))); return; }
  let composition = await api.composition(project.id).catch(() => null);
  let caps = await api.capabilities().catch(() => ({}));
  let selected = null; let agentJob = null;

  // ---------- stage
  const stageWrap = h('div.stage-wrap');
  const overlayMsg = h('div.overlay-msg', 'Loading composition…');
  stageWrap.append(overlayMsg);
  const stage = new Stage(stageWrap);
  // Talk & draw on the preview: a drawing canvas sits exactly over the composition; a voice note records while you
  // play, pause, scrub and draw; when you stop, the note (transcript, strokes, frames) goes straight to the agent.
  const noteCanvas = h('canvas.overlay.stage-overlay'); stageWrap.append(noteCanvas);
  const noteLayer = new DrawLayer(noteCanvas, () => stage.time);
  stage.on('fit', (r) => { Object.assign(noteCanvas.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` }); noteLayer.resize(); });
  const liveTranscript = h('div.live-transcript.hidden');
  stageWrap.append(liveTranscript);
  const N = { recording: null, anchor: null, tool: null, autoSend: localStorage.getItem('videditor.autoSend') !== '0' };
  const snapshotLive = async (strokes, opts = {}) => {
    const img = new Image(); img.src = `/api/projects/${project.id}/frame?t=${opts.t ?? stage.time}&_=${Date.now()}`;
    await new Promise((r) => { img.onload = r; img.onerror = r; });
    return DrawLayer.snapshot(img.naturalWidth ? img : { width: stage.info?.width || 1280, height: stage.info?.height || 720 }, strokes, opts);
  };
  const src = () => `/project-files/${project.id}/${project.composition || 'index.html'}?runtime=1&_=${Date.now()}`;
  const activeEntry = () => project.composition || 'index.html';
  const timeEl = h('span.time');
  const playBtn = btn('', { icon: 'play', cls: 'icon', title: 'Play / pause (space)', onClick: () => stage.toggle() });
  const renderBtn = btn('Render', { icon: 'render', cls: 'primary', title: 'Render now (choose format, size, range)', onClick: renderNow });
  const autoRenderCb = h('input', { type: 'checkbox', checked: project.autoRender !== false, on: { change: async (e) => { try { project = await api.updateProject(project.id, { autoRender: e.target.checked }); toast(e.target.checked ? 'Auto-render on: every agent edit renders in the background' : 'Auto-render off', 'ok'); } catch (err) { toast(err.message, 'err'); } } } });
  const autoRenderLbl = h('label.autosend', { title: 'After the agent changes the composition, render it in the background (render.json outputs if present, else your last render settings)' }, autoRenderCb, 'auto-render');
  // Background render status: a pill in the transport instead of a blocking dialog.
  const renderPill = h('button.btn.sm.renderpill.hidden', { title: 'Rendering in the background. Click for the log.' }, svg('render'), h('span.rp-text', 'Rendering…'), h('span.rp-bar', h('i')));
  let renderLog = ''; let renderLogEl = null;
  renderPill.addEventListener('click', () => { renderLogEl = h('pre.log', { style: { maxHeight: '50vh' } }, renderLog); modal('Render log', renderLogEl, { wide: true }).then(() => { renderLogEl = null; }); });
  const followingRenders = new Set();
  function followRender(jobId, { quiet = false } = {}) {
    if (!jobId || followingRenders.has(jobId)) return; followingRenders.add(jobId);
    renderPill.classList.remove('hidden'); renderLog = ''; let batchTag = '';
    const es = new EventSource(`/api/jobs/${jobId}/events`);
    const setText = (t) => { renderPill.querySelector('.rp-text').textContent = t; };
    es.onmessage = (e) => { const d = JSON.parse(e.data); if (d.type === 'batch') batchTag = `${d.index}/${d.total} `; else if (d.type === 'progress') { renderPill.querySelector('.rp-bar i').style.width = `${(d.frame / d.frames) * 100}%`; setText(`${batchTag}${Math.round((d.frame / d.frames) * 100)}%`); } else { renderLog += (d.text || '') + '\n'; if (renderLogEl) renderLogEl.textContent = renderLog; } };
    es.addEventListener('done', async (e) => {
      es.close(); followingRenders.delete(jobId); renderPill.classList.add('hidden'); renderPill.querySelector('.rp-bar i').style.width = '0';
      const d = JSON.parse(e.data); project = await api.project(project.id); if (!Array.isArray(project.chat)) project.chat = []; renderChat(project.chat); renderVariants();
      if (d.ok && d.folder) { toast('PNG sequence ready', 'ok'); if (!quiet) modal('PNG sequence ready', h('div', h('p', 'The frames are in:'), h('pre.log', d.folder))); }
      else if (d.ok) { const n = d.batch ? d.batch.length : 1; const t = h('div.toast.ok', { style: { cursor: 'pointer' } }, `${n > 1 ? `${n} files` : `v${project.versions.length}`} ready · click to review`); t.addEventListener('click', () => navigate(d.versionId ? `#/p/${project.id}?v=${d.versionId}` : `#/p/${project.id}`)); document.getElementById('toasts').append(t); setTimeout(() => t.remove(), 8000); }
      else { toast('Render failed', 'err'); modal('Render failed', h('pre.log', renderLog)); }
    });
    es.onerror = () => { es.close(); followingRenders.delete(jobId); renderPill.classList.add('hidden'); };
  }
  const toolBtns = {};
  const setNoteTool = (t) => { N.tool = t; noteLayer.tool = t || 'pen'; noteLayer.setEnabled(!!t); for (const [k, b] of Object.entries(toolBtns)) b.classList.toggle('active', k === t); };
  const toolBtn = (name, ic, title) => (toolBtns[name] = btn('', { icon: ic, cls: 'icon sm', title, onClick: () => setNoteTool(N.tool === name ? null : name) }));
  const colors = h('span.colors', COLORS.map((c) => h('span.swatch', { style: { background: c }, class: `swatch ${c === noteLayer.color ? 'active' : ''}`, on: { click: (e) => { noteLayer.color = c; colors.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('active', x === e.currentTarget)); } } })));
  const recBtn = btn('Talk', { icon: 'mic', cls: 'sm', title: 'Record a voice note on the preview (R). Pause, play, scrub and draw while you talk; when you stop it goes to the agent.', onClick: () => toggleNoteRecord() });
  const runBtn = btn('Run-through', { icon: 'film', cls: 'sm', title: 'Play the video from the start and just talk (and draw) as it runs. Every remark is pinned to the cut that was on screen; when the video ends it all goes to the agent. (Shift+R)', onClick: () => toggleRun() });
  const sendNoteBtn = btn('Send drawing', { icon: 'spark', cls: 'sm hidden', title: 'Send the drawing (and selected element) to the agent', onClick: () => finishNote() });
  const autoSend = h('label.autosend', { title: 'Send to the agent automatically when a voice note ends' }, h('input', { type: 'checkbox', checked: N.autoSend, on: { change: (e) => { N.autoSend = e.target.checked; localStorage.setItem('videditor.autoSend', N.autoSend ? '1' : '0'); } } }), 'auto-send');
  const zoomOutBtn = btn('', { icon: 'minus', cls: 'icon ghost sm', title: 'Zoom timeline out (−)', onClick: () => setZoom(zoom / 1.5) });
  const zoomInBtn = btn('', { icon: 'plus', cls: 'icon ghost sm', title: 'Zoom timeline in (+)', onClick: () => setZoom(zoom * 1.5) });
  const zoomFitBtn = btn('Fit', { cls: 'ghost sm', title: 'Fit the whole video (0)', onClick: () => setZoom(1) });
  const transport = h('div.transport', playBtn, btn('', { icon: 'stepBack', cls: 'icon ghost', title: 'Back one frame (←)', onClick: () => step(-1) }), btn('', { icon: 'stepFwd', cls: 'icon ghost', title: 'Forward one frame (→)', onClick: () => step(1) }), timeEl,
    h('span.sep'), toolBtn('pen', 'pen', 'Draw on the preview (D)'), colors, btn('', { icon: 'undo', cls: 'icon sm ghost', title: 'Undo stroke (Z)', onClick: () => noteLayer.undo() }), recBtn, runBtn, sendNoteBtn, autoSend,
    h('span.spacer'), zoomOutBtn, zoomFitBtn, zoomInBtn, btn('Reload', { cls: 'ghost sm', title: 'Reload the composition from disk', onClick: () => reloadComp() }), renderPill, autoRenderLbl, renderBtn);
  noteLayer.onChange = (strokes) => { if (strokes.length && N.anchor === null) N.anchor = strokes[0].points[0][2]; sendNoteBtn.classList.toggle('hidden', !strokes.length || !!N.recording); };

  let recorder = null;
  async function toggleNoteRecord() {
    if (N.recording) return finishNote();
    if (!VoiceRecorder.supported()) return toast('This browser cannot record audio. Use Chrome.', 'err');
    try {
      recorder = new VoiceRecorder({ getTime: () => stage.time, snapshot: () => snapshotLive(noteLayer.strokes, { maxWidth: 960, quality: 0.8 }) });
      await recorder.start((r) => { liveTranscript.classList.remove('hidden'); liveTranscript.innerHTML = (r.transcript ? highlightPointing(r.transcript.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))) : '') + (r.interim ? ` <span class="muted">${r.interim.replace(/[&<>]/g, '')}</span>` : '') || '<span class="muted">Listening… talk, point with “this” / “here”, draw, play or scrub.</span>'; });
      N.recording = recorder; if (N.anchor === null) N.anchor = stage.time;
      recBtn.replaceChildren(svg('stop'), 'Stop'); recBtn.classList.add('danger'); stageWrap.classList.add('rec');
      if (!N.tool) setNoteTool('pen');
    } catch (e) { toast(`Microphone: ${e.message}`, 'err'); recorder = null; }
  }
  async function finishNote() {
    let voice = null;
    if (N.recording) { recBtn.disabled = true; voice = await N.recording.stop(); N.recording = null; recorder = null; recBtn.disabled = false; recBtn.replaceChildren(svg('mic'), 'Talk'); recBtn.classList.remove('danger'); stageWrap.classList.remove('rec'); }
    const strokes = noteLayer.strokes.slice(); const t = N.anchor ?? stage.time;
    if (!voice?.transcript && !voice?.audio && !strokes.length) { liveTranscript.classList.add('hidden'); return; }
    liveTranscript.innerHTML = '<span class="muted">Saving note…</span>';
    const frames = [];
    if (Math.abs(stage.time - t) > 0.05) await stage.seek(t);
    frames.push({ time: t, label: strokes.length ? 'annotated frame' : 'frame', dataUrl: await snapshotLive(strokes) });
    if (voice) for (const f of voice.frames) if (f.label !== 'start of note') frames.push(f);
    const author = await ensureAuthor();
    const body = voice?.transcript || (strokes.length ? `Drawing on the frame${selected ? ` around #${selected}` : ''}` : '');
    try {
      const note = await api.postFeedback({ projectId: project.id, versionId: null, author, body, time: t, timeEnd: voice && voice.endTime > voice.startTime + 0.3 ? voice.endTime : null, kind: voice ? 'voice' : 'drawing', drawing: strokes.length ? { color: noteLayer.color, strokes } : null, frames, transcript: voice?.transcript || null, visualReferences: voice?.visualReferences || [], audio: voice?.audio || null, tags: ['studio'] });
      noteLayer.clear(); N.anchor = null; setNoteTool(null); sendNoteBtn.classList.add('hidden'); liveTranscript.classList.add('hidden');
      if (N.autoSend) { await sendNotesToAgent([note.id], body); } else { project.chat.push({ role: 'user', text: `[note saved] ${body}`, at: new Date().toISOString(), author }); renderChat(project.chat); toast('Note saved. Auto-send is off; send it from the chat.', 'ok'); }
    } catch (e) { toast(e.message, 'err'); liveTranscript.classList.add('hidden'); }
  }
  // Run-through: play the whole video and talk/draw as it runs. Each utterance becomes a note timed to the cut it was
  // said over (the brief also names the cut just before, for fast cuts); drawings attach to the remark they happened in.
  async function toggleRun() {
    if (N.run) return finishRun();
    if (N.recording) return toast('Stop the current voice note first', 'err');
    if (agentJob) return toast('The agent is still working. Wait for it to finish, then run through.', 'err');
    if (!VoiceRecorder.supported()) return toast('This browser cannot record audio. Use Chrome.', 'err');
    try {
      stage.pause(); noteLayer.clear(); N.anchor = null;
      await stage.seek(IO.in ?? 0);
      const rec = new VoiceRecorder({ getTime: () => stage.time, snapshot: () => null });
      await rec.start((r) => { liveTranscript.classList.remove('hidden'); liveTranscript.innerHTML = `<span class="runtag">● Run-through · ${r.segments.length} remark${r.segments.length === 1 ? '' : 's'}</span> ` + (r.interim ? `<span class="muted">${r.interim.replace(/[&<>]/g, '')}</span>` : (r.segments.length ? highlightPointing(r.segments[r.segments.length - 1].text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))) : '<span class="muted">Talk as it plays. Draw if you like. It stops by itself at the end.</span>')); });
      N.run = { rec, off: stage.on('ended', () => finishRun()) };
      runBtn.replaceChildren(svg('stop'), 'Stop run'); runBtn.classList.add('danger'); stageWrap.classList.add('rec'); recBtn.disabled = true;
      setNoteTool('pen');
      stage.play();
    } catch (e) { toast(`Microphone: ${e.message}`, 'err'); N.run = null; }
  }
  async function finishRun() {
    const run = N.run; if (!run) return; N.run = null; run.off();
    stage.pause();
    runBtn.replaceChildren(svg('film'), 'Run-through'); runBtn.classList.remove('danger'); stageWrap.classList.remove('rec'); recBtn.disabled = false; runBtn.disabled = true;
    liveTranscript.classList.remove('hidden'); liveTranscript.innerHTML = '<span class="muted">Building notes from your run…</span>';
    try {
      const voice = await run.rec.stop();
      const segs = (voice.segments || []).filter((s) => s.text.trim()).map((s) => ({ ...s, strokes: [] }));
      const strokes = noteLayer.strokes.slice(); const strokeT = (s) => s.points[0]?.[2] ?? 0;
      const loose = [];
      for (const st of strokes) { let best = null, bd = Infinity; for (const it of segs) { const t = strokeT(st); const d = t < it.start ? it.start - t : t > it.end ? t - it.end : 0; if (d < bd) { bd = d; best = it; } } if (best && bd <= 0.8) best.strokes.push(st); else loose.push(st); }
      for (const st of loose) segs.push({ text: '', start: strokeT(st), end: strokeT(st), strokes: [st] });
      segs.sort((a, b) => a.start - b.start);
      if (!segs.length) { toast('Nothing was said or drawn during the run.', 'err'); noteLayer.clear(); setNoteTool(null); liveTranscript.classList.add('hidden'); return; }
      const author = await ensureAuthor(); const ids = [];
      for (const [i, it] of segs.entries()) {
        liveTranscript.innerHTML = `<span class="muted">Building notes from your run… ${i + 1}/${segs.length}</span>`;
        const frames = [{ time: it.start, label: it.strokes.length ? 'annotated frame' : 'frame', dataUrl: await snapshotLive(it.strokes, { t: it.start, maxWidth: 960, quality: 0.8 }) }];
        const note = await api.postFeedback({ projectId: project.id, versionId: null, author, body: it.text || 'Drawing on the frame', time: it.start, timeEnd: it.end > it.start + 0.3 ? it.end : null, kind: it.text ? 'voice' : 'drawing', drawing: it.strokes.length ? { color: noteLayer.color, strokes: it.strokes } : null, frames, transcript: it.text || null, visualReferences: (voice.visualReferences || []).filter((r) => r.time >= it.start - 0.5 && r.time <= it.end + 0.5), audio: i === 0 ? voice.audio : null, tags: ['studio', 'run-through'] });
        ids.push(note.id);
      }
      noteLayer.clear(); setNoteTool(null); liveTranscript.classList.add('hidden');
      const summary = `Run-through: ${segs.length} remark${segs.length === 1 ? '' : 's'} at ${segs.map((s) => fmtTime(s.start)).join(', ')}`;
      if (N.autoSend) await sendNotesToAgent(ids, summary); else { project.chat.push({ role: 'user', text: `[notes saved] ${summary}`, at: new Date().toISOString(), author }); renderChat(project.chat); toast('Notes saved. Auto-send is off; send them from the chat.', 'ok'); }
    } catch (e) { toast(e.message, 'err'); liveTranscript.classList.add('hidden'); }
    finally { runBtn.disabled = false; }
  }
  async function sendNotesToAgent(ids, summary) {
    if (agentJob) { toast('The agent is still busy. The note is saved; send it when it finishes.', 'err'); return; }
    const live = { role: 'agent', text: '', tools: [], at: new Date().toISOString(), live: true, status: 'reading your note' };
    project.chat.push({ role: 'user', text: `🎙 ${summary || 'Voice note'}`, at: new Date().toISOString(), author: getAuthor() });
    renderChat([...project.chat, live]); setBusy(true);
    try {
      const { jobId } = await api.agent(project.id, '', { author: getAuthor(), fromNotes: ids, agent: project.agent || 'claude' });
      followJob(jobId, live);
    } catch (e) { setBusy(false); live.live = false; live.error = e.message; renderChat([...project.chat, live]); }
  }
  const step = (n) => { stage.pause(); stage.seek(Math.max(0, Math.min(stage.duration, stage.time + n / stage.fps))); };
  function updateTime() { timeEl.innerHTML = `<b>${fmtTime(stage.time, { frames: true, fps: stage.fps })}</b> / ${fmtTime(stage.duration, { frames: true, fps: stage.fps })}`; playBtn.replaceChildren(svg(stage.playing ? 'pause' : 'play')); drawPlayhead(); for (const el of tracksEl.querySelectorAll('.tclip')) el.classList.toggle('on', stage.time >= Number(el.dataset.start) && stage.time < Number(el.dataset.end)); if (sideTab === 'layers') renderLayers(false); }
  stage.on('time', updateTime); stage.on('play', updateTime); stage.on('pause', updateTime);
  stage.on('ready', () => { hideOverlay(); updateTime(); renderTimeline(); renderLayers(); });
  stage.on('select', (m) => selectClip(m.id, { fromStage: true }));
  let reloading = null;
  async function reloadComp() {
    if (reloading) return reloading; // agent edits can arrive faster than a reload; coalesce
    reloading = (async () => {
      composition = await api.composition(project.id).catch(() => composition);
      const t = stage.time; const wasPlaying = stage.playing;
      const info = await stage.load(src());
      if (!info) { showOverlay('The composition did not load. Check index.html in Files, or ask the agent to fix it.', true); return; }
      hideOverlay();
      await stage.seek(Math.min(t, stage.duration || t));
      renderTimeline(); renderLayers(); if (sideTab === 'history') renderHistory();
      if (wasPlaying) stage.play();
    })().finally(() => { reloading = null; });
    return reloading;
  }
  function showOverlay(text, withReload = false) { overlayMsg.replaceChildren(text, withReload ? btn('Reload', { cls: 'sm', icon: 'undo', onClick: () => reloadComp() }) : null); overlayMsg.style.pointerEvents = withReload ? 'auto' : ''; if (!overlayMsg.isConnected) stageWrap.append(overlayMsg); }
  function hideOverlay() { overlayMsg.remove(); }

  // ---------- timeline
  const ruler = h('div.ruler'); const tracksEl = h('div.tracks'); const phead = h('div.phead');
  // In / out points (I / O keys): a range for rendering, shown on the ruler.
  const IO = { in: null, out: null };
  const ioEl = h('div.iorange.hidden');
  const setIO = (k, v) => { IO[k] = v; if (IO.in !== null && IO.out !== null && IO.out <= IO.in) { if (k === 'in') IO.out = null; else IO.in = null; } drawIO(); };
  const clearIO = () => { IO.in = IO.out = null; drawIO(); toast('In/out points cleared', 'ok'); };
  function drawIO() { const dur = stage.duration || composition?.duration || 5; const pps = pxPerSec(); const a = IO.in ?? 0, b = IO.out ?? dur; const on = IO.in !== null || IO.out !== null; ioEl.classList.toggle('hidden', !on); if (on) { ioEl.style.left = `${a * pps}px`; ioEl.style.width = `${Math.max(2, (b - a) * pps)}px`; ioEl.title = `Render range ${fmtTime(a)} – ${fmtTime(b)} (I / O to set, Shift+I to clear)`; } }
  const tlInner = h('div.tlinner', ruler, tracksEl, phead);
  ruler.append(ioEl);
  const tlScroll = h('div.tlscroll', tlInner);
  const tlGrip = h('div.tlgrip', { title: 'Drag to resize the timeline' });
  const tl = h('div.tl', tlGrip, tlScroll, h('span.hint-tl', 'drag = move · drag edge = trim · ⌘/Ctrl + wheel = zoom'));
  tl.style.height = `${Math.min(Math.max(Number(localStorage.getItem('videditor.tlHeight')) || 240, 140), 700)}px`;
  tlGrip.addEventListener('pointerdown', (e) => { e.preventDefault(); const y0 = e.clientY, h0 = tl.offsetHeight; const mv = (ev) => { const hh = Math.min(Math.max(h0 - (ev.clientY - y0), 140), window.innerHeight * 0.75); tl.style.height = `${hh}px`; }; const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); localStorage.setItem('videditor.tlHeight', String(tl.offsetHeight)); renderTimeline(); }; window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); });
  const PAD = 70;
  let zoom = 1;
  const pxPerSec = () => ((tlScroll.clientWidth - PAD - 16) / Math.max(0.5, stage.duration || composition?.duration || 5)) * zoom;
  function setZoom(z, anchorX) {
    const old = pxPerSec(); zoom = Math.max(1, Math.min(60, z));
    renderTimeline();
    // keep the time under the cursor (or the playhead) where it was
    const now = pxPerSec(); const ax = anchorX ?? (PAD + stage.time * old - tlScroll.scrollLeft);
    const tAt = (ax + tlScroll.scrollLeft - PAD) / old; tlScroll.scrollLeft = Math.max(0, PAD + tAt * now - ax);
    zoomFitBtn.textContent = zoom === 1 ? 'Fit' : `${zoom.toFixed(1)}×`;
  }
  tlScroll.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); const r = tlScroll.getBoundingClientRect(); setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX - r.left); } else if (Math.abs(e.deltaX) < Math.abs(e.deltaY) && zoom > 1 && e.shiftKey) { e.preventDefault(); tlScroll.scrollLeft += e.deltaY; } }, { passive: false });
  function drawPlayhead() {
    if (!stage.duration) return; const x = PAD + stage.time * pxPerSec(); phead.style.left = `${x}px`;
    if (stage.playing && zoom > 1) { const vis = x - tlScroll.scrollLeft; if (vis > tlScroll.clientWidth - 40 || vis < PAD) tlScroll.scrollLeft = Math.max(0, x - PAD - 20); }
  }
  ruler.addEventListener('pointerdown', (e) => { const seekAt = (ev) => { const r = ruler.getBoundingClientRect(); stage.pause(); stage.seek(Math.max(0, Math.min(stage.duration, (ev.clientX - r.left) / pxPerSec()))); }; seekAt(e); const mv = (ev) => seekAt(ev); const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); }; window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); });
  function renderTimeline() {
    if (dragState) return;
    const dur = stage.duration || composition?.duration || 5; const pps = pxPerSec();
    tlInner.style.width = `${PAD + dur * pps + 16}px`;
    ruler.replaceChildren(ioEl); drawIO(); const secPx = pps; const stepS = secPx > 400 ? 0.1 : secPx > 160 ? 0.25 : secPx > 70 ? 0.5 : secPx > 30 ? 1 : secPx > 12 ? 2 : secPx > 6 ? 5 : 10;
    for (let i = 0, t = 0; t <= dur + 1e-6; i++, t = Math.round(i * stepS * 1000) / 1000) ruler.append(h('div.tick', { style: { left: `${t * pps}px` } }, Math.abs(t - Math.round(t)) < 1e-6 ? `${Math.round(t)}s` : (stepS < 1 && secPx > 160 ? `${t.toFixed(stepS < 0.25 ? 1 : 2).replace(/0+$/, '').replace(/\.$/, '')}` : '')));
    if (beatGrid) for (const bt of beatGrid.beats) { if (bt > dur) break; ruler.append(h('div.beat', { style: { left: `${bt * pps}px` }, title: `beat ${fmtTime(bt)} · ${beatGrid.bpm} BPM` })); }
    const clips = (composition?.clips || []).filter((c) => c.start !== null && c.depth === 0);
    const tracks = new Map(); for (const c of clips) { const k = c.track ?? 0; if (!tracks.has(k)) tracks.set(k, []); tracks.get(k).push(c); }
    const keys = [...tracks.keys()].sort((a, b) => b - a); if (!keys.length) keys.push(0);
    // Clips on one track that overlap in time get their own sub-row so none is hidden behind another.
    tracksEl.replaceChildren(...keys.flatMap((k) => {
      // Overlapping clips go to sub-rows, at most 3 per track; beyond that they share the last row (tooltips still name them).
      const rows = []; const MAX_ROWS = 3;
      for (const c of [...(tracks.get(k) || [])].sort((a, b) => a.start - b.start)) { const end = c.start + (c.duration ?? (dur - c.start)); let row = rows.find((r) => r.end <= c.start + 1e-6); if (!row) { if (rows.length < MAX_ROWS) { row = { end: 0, clips: [] }; rows.push(row); } else row = rows.reduce((a, b) => (a.end <= b.end ? a : b)); } row.end = Math.max(row.end, end); row.clips.push(c); }
      if (!rows.length) rows.push({ end: 0, clips: [] });
      return rows.map((row, ri) => {
        const area = h('div.tarea');
        for (const c of row.clips) {
          const d = c.duration ?? (dur - c.start);
          const el = h('div.tclip', { class: `tclip ${c.tag === 'video' || c.tag === 'img' ? 'media' : c.tag === 'audio' ? 'audio' : ''} ${c.id && c.id === selected ? 'sel' : ''}`, 'data-id': c.id || '', 'data-start': c.start, 'data-end': c.start + d, style: { left: `${c.start * pps}px`, width: `${Math.max(14, d * pps)}px` }, title: `${c.id ? '#' + c.id : c.tag} ${fmtTime(c.start)}–${fmtTime(c.start + d)}${c.text ? ` “${c.text}”` : ''}` }, h('span.lh'), c.id ? `#${c.id}` : c.tag, c.text ? ` “${c.text}”` : '', h('span.rh'));
          attachDrag(el, c, d);
          area.append(el);
        }
        return h('div.trow', { class: `trow ${ri ? 'sub' : ''}` }, h('div.tname', ri ? `T${k} ·` : `T${k}`), area);
      });
    }));
    drawPlayhead();
  }
  let dragState = null; // while set, renderTimeline() is paused so the dragged element survives
  function attachDrag(el, c, d) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; e.preventDefault(); e.stopPropagation();
      const mode = e.target.classList.contains('rh') ? 'end' : e.target.classList.contains('lh') ? 'start' : 'move';
      const pps = pxPerSec(); const x0 = e.clientX; const s0 = c.start, d0 = d; let moved = false;
      const snap = (v) => Math.round(v * stage.fps) / stage.fps;
      dragState = { id: c.id, s: s0, dd: d0 };
      el.classList.add('dragging');
      let lastSeek = 0;
      const mv = (ev) => {
        const dx = (ev.clientX - x0) / pps; if (Math.abs(ev.clientX - x0) > 2) moved = true;
        let s = s0, dd = d0;
        if (mode === 'move') s = Math.max(0, snap(s0 + dx));
        else if (mode === 'end') dd = Math.max(1 / stage.fps, snap(d0 + dx));
        else { s = Math.max(0, Math.min(s0 + d0 - 1 / stage.fps, snap(s0 + dx))); dd = s0 + d0 - s; }
        el.style.left = `${s * pps}px`; el.style.width = `${Math.max(14, dd * pps)}px`; dragState.s = s; dragState.dd = dd;
        const now = performance.now(); if (now - lastSeek > 40) { lastSeek = now; stage.seek(mode === 'end' ? s + dd - 0.001 : s); }
      };
      const up = async () => {
        window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
        el.classList.remove('dragging');
        const { s, dd } = dragState; dragState = null;
        if (!moved) { renderTimeline(); selectClip(c.id); return; }
        if (!c.id) { toast('Give this element an id to edit it from the timeline', 'err'); renderTimeline(); return; }
        try { const r = await api.updateClip(project.id, c.id, { start: s, ...(c.duration !== null || mode !== 'move' ? { duration: dd } : {}) }); composition = r.composition; await stage.reload(true); renderTimeline(); renderLayers(); selectClip(c.id); toast(`#${c.id}: ${fmtTime(s)} – ${fmtTime(s + dd)}`, 'ok'); }
        catch (err) { toast(err.message, 'err'); renderTimeline(); }
      };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    });
  }

  // ---------- side panel: layers / files
  const layersEl = h('div.layers'); const filesHost = h('div'); const assetsHost = h('div'); const brandHost = h('div'); const historyHost = h('div');
  const inspector = h('div.inspector.hidden');
  let sideTab = 'layers';
  const hosts = { layers: () => [inspector, layersEl], files: () => [filesHost], assets: () => [assetsHost], brand: () => [brandHost], history: () => [historyHost] };
  const sideTabs = h('div.tabs', [['layers', 'Layers'], ['assets', 'Assets'], ['history', 'History'], ['files', 'Files'], ['brand', 'Brand']].map(([k, l]) => h('span.tab', { class: `tab ${k === sideTab ? 'active' : ''}`, 'data-tab': k, on: { click: (e) => { sideTab = k; sideTabs.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === e.currentTarget)); sideBody.replaceChildren(...hosts[k]()); if (k === 'files') renderFiles(); if (k === 'assets') renderAssets(); if (k === 'brand') renderBrand(); if (k === 'history') renderHistory(); } } }, l)), h('span', { style: { flex: 1 } }), project.versions.length ? h('a.tab', { href: `#/p/${project.id}` }, 'Review ↗') : null);
  const sideBody = h('div.body', inspector, layersEl);
  const side = h('div.side', sideTabs, sideBody);
  // Layers = what is on screen at the playhead, front to back (like Figma's layers for the current frame).
  // The timeline owns the sequence; this panel owns the stacking. Everything else is folded away but findable.
  let layersKey = '';
  function renderLayers(force = true) {
    const all = (composition?.clips || []).filter((c) => c.depth === 0);
    const t = stage.time;
    const dur = stage.duration || composition?.duration || 5;
    const on = all.filter((c) => c.start !== null && t >= c.start - 1e-6 && t < c.start + (c.duration ?? (dur - c.start)) + 1e-6).sort((a, b) => (b.track ?? 0) - (a.track ?? 0) || b.start - a.start);
    const off = all.filter((c) => !on.includes(c)).sort((a, b) => a.start - b.start);
    const key = on.map((c) => c.id || c.tag).join('|') + '#' + selected + '#' + all.length + '#' + Math.round(t * 10);
    if (!force && key === layersKey) return; layersKey = key;
    const row = (c, dim) => h('div.layer', { class: `layer ${c.id && c.id === selected ? 'sel' : ''} ${dim ? 'dim' : ''}`, title: `${c.id ? '#' + c.id : c.tag} · ${fmtTime(c.start)}${c.duration !== null ? `–${fmtTime(c.start + c.duration)}` : ''} · track ${c.track ?? 0}`, on: { click: () => { selectClip(c.id); if (dim && c.start !== null) stage.seek(c.start + 0.01); } } },
      h('span.lz', c.tag === 'audio' ? '♪' : String(c.track ?? 0)), h('span.lid', c.id ? `#${c.id}` : `<${c.tag}>`), c.text ? h('span.ltxt', `“${c.text}”`) : c.src ? h('span.ltxt', c.src.split('/').pop()) : null, dim ? h('span.lt', fmtTime(c.start)) : null);
    const visible = on.filter((c) => c.tag !== 'audio'), audio = on.filter((c) => c.tag === 'audio');
    layersEl.replaceChildren(...[
      h('div.lhead', `On screen at ${fmtTime(t)}`, h('span.muted', ' · front to back')),
      ...(visible.length ? visible.map((c) => row(c, false)) : [h('div.small.muted', { style: { padding: '4px 8px' } }, all.length ? 'Nothing visible at this moment.' : 'No clips yet. Ask the agent to build the video, or edit index.html in Files.')]),
      audio.length ? h('div.lhead', 'Playing') : null, ...audio.map((c) => row(c, false)),
      off.length ? h('details.loff', { open: !visible.length }, h('summary', `Not on screen now (${off.length})`), ...off.map((c) => row(c, true))) : null,
    ].filter(Boolean));
    renderInspector();
  }
  function renderInspector() {
    const c = (composition?.clips || []).find((x) => x.id === selected);
    inspector.classList.toggle('hidden', !c); if (!c) return;
    const num = (v, key) => h('input.text', { type: 'number', step: '0.1', min: '0', value: v ?? '', on: { change: async (e) => { try { const r = await api.updateClip(project.id, c.id, { [key]: Number(e.target.value) }); composition = r.composition; await stage.reload(true); renderTimeline(); renderLayers(); } catch (err) { toast(err.message, 'err'); } } } });
    inspector.replaceChildren(h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } }, h('b.mono', `#${c.id}`), h('span.muted.small', `<${c.tag}>`), h('span', { style: { flex: 1 } }), btn('Ask to edit', { cls: 'sm ghost', icon: 'chat', onClick: () => { ctxChip(c.id); ta.focus(); } })), h('div.irow', h('span', 'Start (s)'), num(c.start, 'start')), h('div.irow', h('span', 'Duration (s)'), num(c.duration, 'duration')), h('div.irow', h('span', 'Track'), num(c.track ?? 0, 'track')), c.text ? h('div.small.muted', `“${c.text}”`) : null);
  }
  async function renderFiles() {
    filesHost.replaceChildren(h('div.section', h('div.muted.small', 'Loading…')));
    try {
      const { files } = await api.files(project.id);
      const list = h('div.files', ...files.map((f) => h('div.f', { class: `f ${f.text ? '' : 'dim'}`, on: { click: () => f.text && openFile(f.path) } }, h('span', f.path), h('span.muted', f.size > 1e6 ? `${(f.size / 1e6).toFixed(1)} MB` : f.size > 1e3 ? `${Math.round(f.size / 1e3)} KB` : `${f.size} B`))));
      filesHost.replaceChildren(h('div.section', h('h3', 'Project files', h('span.spacer'), h('span.small.muted.mono', { style: { cursor: 'pointer' }, title: 'Click to copy the folder path (open it in Finder or a terminal)', on: { click: async () => { await copyText(project.dir); toast('Folder path copied', 'ok'); } } }, project.dir)), list, h('p.hint', { style: { marginTop: '8px' } }, 'Drop images, video or audio into the assets/ folder on disk; the agent and index.html can reference them as assets/…')));
    } catch (e) { filesHost.replaceChildren(h('div.section', h('div.muted', e.message))); }
  }
  async function openFile(p) {
    let text; try { text = await api.file(project.id, p); } catch (e) { return toast(e.message, 'err'); }
    const ta2 = h('textarea.text', { value: text, spellcheck: false, style: { minHeight: '60vh', fontFamily: 'var(--mono)', fontSize: '12px' } });
    ta2.addEventListener('keydown', (e) => { if (e.key === 'Tab') { e.preventDefault(); const s = ta2.selectionStart; ta2.setRangeText('  ', s, ta2.selectionEnd, 'end'); } });
    await modal(p, ta2, { wide: true, actions: [{ label: 'Save', cls: 'primary', icon: 'check', onClick: async () => { try { const r = await api.saveFile(project.id, p, ta2.value); if (r.composition) composition = r.composition; toast('Saved', 'ok'); await stage.reload(true); renderTimeline(); renderLayers(); return false; } catch (e) { toast(e.message, 'err'); return false; } } }] });
  }

  // ---------- assets
  let assetsPoll = null;
  async function renderAssets() {
    clearInterval(assetsPoll);
    assetsHost.replaceChildren(h('div.section', h('div.muted.small', 'Loading…')));
    let data; try { data = await api.assets(project.id); } catch (e) { return assetsHost.replaceChildren(h('div.section', h('div.muted', e.message))); }
    const dirIn = h('input.text', { value: data.assetsDir || '', placeholder: '/Users/you/Movies/my-footage' });
    const link = h('div.section', h('h3', 'Asset folder'), h('p.small.muted', 'Point Videditor at a folder on this computer. New files dropped there are picked up and analyzed automatically (cuts, keyframes, tempo), and the agent can use them as library/<name>.'), dirIn, h('div', { style: { display: 'flex', gap: '6px', marginTop: '8px' } }, btn(data.assetsDir ? 'Update' : 'Link folder', { cls: 'sm primary', onClick: async () => { try { project = await api.updateProject(project.id, { assetsDir: dirIn.value.trim() || null }); toast(dirIn.value.trim() ? 'Folder linked, analyzing…' : 'Unlinked', 'ok'); renderAssets(); } catch (e) { toast(e.message, 'err'); } } }), data.assetsDir ? btn('Unlink', { cls: 'sm ghost', onClick: async () => { project = await api.updateProject(project.id, { assetsDir: null }); renderAssets(); } }) : null, h('span', { style: { flex: 1 } }), btn('Re-analyze all', { cls: 'sm ghost', onClick: async () => { await api.analyze(project.id, true); toast('Analyzing…'); renderAssets(); } })));
    const list = h('div', { style: { display: 'grid', gap: '8px', padding: '10px 12px' } });
    if (!data.items.length) list.append(h('div.empty', h('p', 'No media yet.'), h('p.small', 'Drop video, audio or images into the project\'s assets/ folder or link a folder above.')));
    for (const it of data.items) {
      const a = it.analysis; const src = it.rel;
      const thumb = a?.sheet || a?.frames?.[0]?.file;
      const beat = a?.audio && a.audio.confidence >= 0.15 ? a.audio : null;
      const meta = a ? [a.duration ? fmtTime(a.duration) : null, a.width && it.kind !== 'audio' ? `${a.width}×${a.height}` : null, a.scenes ? `${a.scenes} cuts` : null, beat ? `${beat.bpm} BPM` : (a.audio ? 'no clear beat' : null)].filter(Boolean).join(' · ') : (it.analyzed ? '' : 'analyzing…');
      list.append(h('div.version-row', { style: { cursor: 'default' } },
        thumb ? h('img', { src: `/project-files/${project.id}/${thumb}`, style: { width: '96px', cursor: 'zoom-in' }, on: { click: () => modal(src, h('img.zoom', { src: `/project-files/${project.id}/${thumb}` }), { wide: true }) } }) : h('div.noimg', { style: { width: '96px', display: 'grid', placeItems: 'center', color: 'var(--fg-2)', fontSize: '11px' } }, it.kind),
        h('div.vb', h('div.l', h('span.mono.small', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, src)), h('div.n', meta || ' '),
          h('div', { style: { display: 'flex', gap: '4px', marginTop: '6px', flexWrap: 'wrap' } },
            btn('Insert at playhead', { cls: 'sm', icon: 'plus', onClick: async () => { try { const r = await api.insertClip(project.id, { src, start: Math.round(stage.time * 100) / 100, duration: it.kind === 'image' ? 3 : (a?.duration ? Math.min(a.duration, Math.max(0.5, (stage.duration || 5) - stage.time)) : null), track: it.kind === 'audio' ? 9 : 1, muted: it.kind === 'video' }); composition = r.composition; await stage.reload(true); renderTimeline(); renderLayers(); selectClip(r.id); toast(`Added #${r.id}`, 'ok'); } catch (e) { toast(e.message, 'err'); } } }),
            btn('Mention in chat', { cls: 'sm ghost', icon: 'chat', onClick: () => { ta.value = (ta.value ? ta.value + ' ' : '') + `\`${src}\``; ta.focus(); } }),
            beat ? btn(`Beats ${beat.bpm}`, { cls: 'sm ghost', title: 'Show the beat grid on the timeline', onClick: () => { beatGrid = beatGrid?.src === src ? null : { src, beats: beat.beats, bpm: beat.bpm }; renderTimeline(); } }) : null))));
    }
    const job = data.analyzing ? h('div.section', h('div.small.muted', 'Analyzing media…'), h('div.progress', h('i'))) : null;
    assetsHost.replaceChildren(...[link, job, h('div.section', h('h3', `Media (${data.items.length})`), h('p.small.muted', 'Tell the agent what to do with them: "cut library/demo.mp4 to the music, UI-only shots, 15 seconds".')), list].filter(Boolean));
    if (data.analyzing || data.items.some((i) => !i.analyzed)) assetsPoll = setInterval(async () => { const d = await api.assets(project.id).catch(() => null); if (d && !d.analyzing && d.items.every((i) => i.analyzed)) { clearInterval(assetsPoll); if (sideTab === 'assets') renderAssets(); } }, 2500);
  }
  let beatGrid = null;

  // ---------- brand
  async function renderBrand() {
    brandHost.replaceChildren(h('div.section', h('div.muted.small', 'Loading…')));
    let b; try { b = await api.brand(project.id); } catch (e) { return brandHost.replaceChildren(h('div.section', h('div.muted', e.message))); }
    const color = (key, label) => { const inp = h('input', { type: 'color', value: b.colors[key] || '#000000', style: { width: '36px', height: '28px', padding: 0, border: 0, background: 'none' } }); const txt = h('input.text', { value: b.colors[key] || '', style: { fontFamily: 'var(--mono)' } }); inp.addEventListener('input', () => { txt.value = inp.value; }); txt.addEventListener('change', () => { if (/^#[0-9a-f]{6}$/i.test(txt.value)) inp.value = txt.value; }); return { row: h('div.irow', h('span', label), h('div', { style: { display: 'flex', gap: '6px' } }, inp, txt)), get: () => txt.value.trim() }; };
    const rows = { primary: color('primary', 'Primary'), background: color('background', 'Background'), text: color('text', 'Text'), muted: color('muted', 'Muted'), accent: color('accent', 'Accent') };
    const font = h('input.text', { value: b.font.family || '' }); const fontUrl = h('input.text', { value: b.font.url || '', placeholder: 'https://fonts.googleapis.com/css2?family=…' });
    const logo = h('input.text', { value: b.logo || '', placeholder: 'assets/logo.svg or library/logo.png' }); const name = h('input.text', { value: b.name || '', placeholder: 'Brand name' }); const notes = h('textarea.text', { rows: 3, value: b.notes || '', placeholder: 'Tone, do/don\'t, anything the agent should respect' });
    brandHost.replaceChildren(h('div.section', h('h3', 'Brand kit'), h('p.small.muted', 'Saved to brand.json and brand.css in the project. Templates and the agent use these as CSS variables (--brand-primary …), so you can rebrand a video without touching the composition.'),
      h('div.inspector', { style: { border: 0, padding: 0 } }, h('div.irow', h('span', 'Name'), name), ...Object.values(rows).map((r) => r.row), h('div.irow', h('span', 'Font'), font), h('div.irow', h('span', 'Font URL'), fontUrl), h('div.irow', h('span', 'Logo'), logo)), h('label.field', { style: { marginTop: '10px' } }, h('span', 'Notes for the agent'), notes),
      h('div', { style: { display: 'flex', gap: '6px' } }, btn('Save brand', { cls: 'primary sm', icon: 'check', onClick: async () => { try { await api.saveBrand(project.id, { name: name.value, colors: Object.fromEntries(Object.entries(rows).map(([k, r]) => [k, r.get()])), font: { family: font.value, url: fontUrl.value.trim() }, logo: logo.value.trim(), notes: notes.value }); toast('Brand saved', 'ok'); await stage.reload(true); } catch (e) { toast(e.message, 'err'); } } }), btn('Ask agent to apply', { cls: 'sm ghost', icon: 'spark', onClick: () => { ta.value = 'Apply brand.css variables everywhere in the composition (colors, font, logo) instead of hard-coded values.'; ta.focus(); } }))),
      motionSection());
  }
  function motionSection() {
    const ta2 = h('textarea.text', { rows: 14, spellcheck: false, style: { fontFamily: 'var(--mono)', fontSize: '12px' }, placeholder: 'Loading MOTION.md…' });
    api.file(project.id, 'MOTION.md').then((t) => { ta2.value = t; }).catch(() => { ta2.value = '# Motion guidelines\n\n## Principles\n- \n\n## Timing\n- \n\n## Easing\n- \n\n## Scale and zoom\n- \n\n## Transitions\n- \n'; });
    return h('div.section', h('h3', 'Motion guidelines'), h('p.small.muted', 'MOTION.md: how things are allowed to move (timing, easing, zoom limits, transitions). The agent reads it on every edit and must follow it. Paste your design system\'s motion principles here.'), ta2,
      h('div', { style: { display: 'flex', gap: '6px', marginTop: '8px' } }, btn('Save guidelines', { cls: 'primary sm', icon: 'check', onClick: async () => { try { await api.saveFile(project.id, 'MOTION.md', ta2.value); toast('MOTION.md saved', 'ok'); } catch (e) { toast(e.message, 'err'); } } }), btn('Ask agent to re-time to these rules', { cls: 'sm ghost', icon: 'spark', onClick: () => { ta.value = 'Re-time every animation and transition in the composition to follow MOTION.md exactly (durations, easing, zoom limits). List what you changed.'; ta.focus(); } })));
  }

  // ---------- history (snapshots of the active composition)
  async function renderHistory() {
    historyHost.replaceChildren(h('div.section', h('div.muted.small', 'Loading…')));
    let data; try { data = await api.history(project.id); } catch (e) { return historyHost.replaceChildren(h('div.section', h('div.muted', e.message))); }
    const rows = data.items.map((it, i) => h('div.version-row', { style: { cursor: 'default', alignItems: 'center' } },
      h('div.vb', h('div.l', h('span', { style: { color: it.by === 'agent' ? 'var(--agent)' : 'var(--fg)' } }, it.by === 'agent' ? 'Agent' : 'You'), h('span.small.muted', relTime(it.at)), h('span.spacer', { style: { flex: 1 } }), i === 0 ? h('span.pill', 'latest') : null), h('div.n', it.label || '(no label)')),
      i === 0 ? null : btn('Restore', { cls: 'sm', icon: 'undo', title: 'Make the composition exactly like this snapshot (the current state is snapshotted first)', onClick: async () => { try { const r = await api.restore(project.id, it.file); composition = r.composition; await reloadComp(); toast('Restored', 'ok'); renderHistory(); } catch (e) { toast(e.message, 'err'); } } })));
    historyHost.replaceChildren(h('div.section', h('h3', `History · ${data.entry}`), h('p.small.muted', 'A snapshot is taken before and after every change: timeline drags, Files edits, agent runs. Restore brings that state back; nothing is lost because the current state is snapshotted first.')), h('div', { style: { display: 'grid', gap: '6px', padding: '0 12px 12px' } }, ...(rows.length ? rows : [h('div.muted.small', 'No snapshots yet. They appear as soon as something changes.')])));
  }

  // ---------- variants (several compositions in one project)
  const variantSel = h('select.text', { style: { width: 'auto', maxWidth: '220px' }, title: 'Which composition you are looking at. A variant is a separate copy you can take in another direction.' });
  let renderVariants = async function () {
    let data; try { data = await api.variants(project.id); } catch { return; }
    variantSel.replaceChildren(...data.variants.map((v) => h('option', { value: v.entry, selected: v.entry === data.active }, v.entry === 'index.html' ? 'Main composition' : `Variant: ${v.title || v.name}`)), h('option', { value: '__new' }, '+ New variant from this one…'), data.active !== 'index.html' ? h('option', { value: '__delete' }, '✕ Delete this variant') : null);
  }
  variantSel.addEventListener('change', async () => {
    const v = variantSel.value;
    try {
      if (v === '__new') { const name = h('input.text', { placeholder: 'e.g. warm cut, vertical, shorter' }); if (await modal('New variant', h('div', h('p.muted', 'A copy of the current composition you can change independently. The original stays as it is. You can also just tell the agent: "make another version that is …".'), name), { actions: [{ label: 'Create', cls: 'primary', value: true }] })) { const r = await api.createVariant(project.id, name.value.trim() || 'variant', activeEntry()); project.composition = r.active; toast(`Variant created: ${r.active}`, 'ok'); } }
      else if (v === '__delete') { if (await modal('Delete this variant?', h('p.muted', `${activeEntry()} is removed. The main composition is kept.`), { actions: [{ label: 'Delete', cls: 'danger', value: true }] })) { const r = await api.deleteVariant(project.id, activeEntry()); project.composition = r.active === 'index.html' ? null : r.active; } }
      else { const r = await api.activateVariant(project.id, v); project.composition = r.active === 'index.html' ? null : r.active; }
    } catch (e) { toast(e.message, 'err'); }
    await renderVariants(); await reloadComp();
  });
  const variantDelBtn = btn('', { icon: 'trash', cls: 'ghost icon sm hidden', title: 'Delete this variant (the main composition is kept)', onClick: async () => { variantSel.value = '__delete'; variantSel.dispatchEvent(new Event('change')); } });
  const _rv = renderVariants; renderVariants = async () => { await _rv(); variantDelBtn.classList.toggle('hidden', activeEntry() === 'index.html'); };
  renderVariants();

  function selectClip(id, { fromStage = false } = {}) {
    selected = id || null;
    if (!fromStage) stage.select(selected);
    tracksEl.querySelectorAll('.tclip').forEach((el) => el.classList.toggle('sel', !!selected && el.dataset.id === selected));
    renderLayers(true);
    renderInspector();
    if (selected) ctxChip(selected);
  }

  // ---------- chat
  const msgs = h('div.msgs');
  const ta = h('textarea', { placeholder: 'Ask the agent to make or change something…', rows: 1 });
  const ctx = h('span.ctx.hidden');
  const grow = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`; };
  ta.addEventListener('input', grow);
  const sendBtn = h('button.roundbtn.btn.primary', { title: 'Send (Enter)', 'aria-label': 'Send', on: { click: () => send() } }, svg('send'));
  const stopBtn = h('button.roundbtn.stop.hidden', { title: 'Stop the agent', 'aria-label': 'Stop', on: { click: async () => { try { await api.agentCancel(project.id); toast('Stopping…'); } catch (e) { toast(e.message, 'err'); } } } }, svg('stop'));
  const setBusy = (on) => { sendBtn.classList.toggle('hidden', on); stopBtn.classList.toggle('hidden', !on); ta.placeholder = on ? 'Agent is working… (Stop to interrupt)' : 'Ask the agent to make or change something…'; };
  const agentSel = h('select.pick', { title: 'Which coding agent edits the composition (runs on this computer, on your own account)', on: { change: async () => { try { project = await api.updateProject(project.id, { agent: agentSel.value }); toast(`Using ${caps.agents?.[agentSel.value]?.label || agentSel.value}`, 'ok'); } catch (e) { toast(e.message, 'err'); } } } },
    Object.entries(caps.agents || { claude: { label: 'Claude Code', available: caps.claude } }).map(([k, v]) => h('option', { value: k, selected: (project.agent || 'claude') === k }, `${v.label}${v.available ? '' : ' (not installed)'}`)));
  const fitPick = () => { const cv = fitPick.cv || (fitPick.cv = document.createElement('canvas').getContext('2d')); cv.font = getComputedStyle(agentSel).font || '12px sans-serif'; agentSel.style.width = `${Math.ceil(cv.measureText(agentSel.selectedOptions[0]?.textContent || '').width) + 30}px`; };
  agentSel.addEventListener('change', fitPick); requestAnimationFrame(fitPick);
  const newChatBtn = h('button.pick.iconpick', { title: 'New conversation (the agent forgets this chat; files are kept)', 'aria-label': 'New conversation', on: { click: async () => { if (await modal('Start a new conversation?', h('p.muted', 'The agent forgets this chat. The composition files are kept.'), { actions: [{ label: 'New conversation', cls: 'primary', value: true }] })) { await api.agentReset(project.id); project.chat = []; renderChat([]); } } } }, svg('plus'));
  const compose = h('div.compose', h('div.box', ctx, ta, h('div.row', agentSel, newChatBtn, h('span.spacer'), h('span.hint', 'Enter ↵'), stopBtn, sendBtn)));
  const chat = h('div.chat', msgs, compose);
  // Enter sends, Shift+Enter makes a new line, ⌘/Ctrl+Enter also sends; Esc leaves the box.
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } else if (e.key === 'Escape') ta.blur(); e.stopPropagation(); });
  function ctxChip(id) { ctx.classList.remove('hidden'); ctx.replaceChildren('About ', h('code', `#${id}`), btn('', { icon: 'close', cls: 'ghost icon sm', title: 'Clear', onClick: () => { ctx.classList.add('hidden'); ctx._id = null; } })); ctx._id = id; }
  // Tool calls become compact step rows (Cursor-style): "Edited index.html", "Searched tagline", "Ran ffprobe …".
  const TOOL_VIEW = { Read: ['file', 'Read'], Edit: ['pen', 'Edited'], MultiEdit: ['pen', 'Edited'], Write: ['pen', 'Wrote'], NotebookEdit: ['pen', 'Edited'], Grep: ['search', 'Searched'], Glob: ['search', 'Listed'], LS: ['folder', 'Listed'], Bash: ['terminal', 'Ran'], WebFetch: ['link', 'Fetched'], WebSearch: ['search', 'Searched the web'], Task: ['sparkle', 'Delegated'], TodoWrite: ['check', 'Planned'] };
  function stepRow(t) {
    if (t.note) return h('div.step.note', t.note.replace(/\s+/g, ' ').trim());
    const name = String(t.name || ''); const mcp = name.match(/^mcp__\w+?__(.+)$/);
    const [ic, verb] = TOOL_VIEW[name] || (mcp ? ['sparkle', mcp[1].replace(/_/g, ' ')] : ['sparkle', name]);
    const what = (t.detail || '').replace(/\s+/g, ' ').trim();
    return h('div.step', { title: `${name} ${t.detail || ''}`.trim() }, svg(ic), h('span.verb', verb), what ? h('span.what', what) : null);
  }
  function stepsEl(m) {
    const n = m.tools.filter((t) => !t.note).length; const open = m.live || m._open === true || (m._open !== false && n <= 3 && !m.tools.some((t) => t.note));
    const box = h('div.steps', { class: `steps ${open ? 'open' : ''}` });
    const edited = new Set(m.tools.filter((t) => /^(Edit|MultiEdit|Write)$/.test(t.name) && t.detail).map((t) => t.detail.split('/').pop()));
    const summary = edited.size ? `Edited ${[...edited].slice(0, 2).join(', ')}${edited.size > 2 ? ` +${edited.size - 2}` : ''}` : `${n} step${n > 1 ? 's' : ''}`;
    const head = h('div.shead', { on: { click: () => { m._open = !box.classList.contains('open'); box.classList.toggle('open', m._open); } } }, svg('chevron'), h('span', m.live ? `${n} step${n > 1 ? 's' : ''}` : summary), !m.live && edited.size ? h('span.muted', ` · ${n} step${n > 1 ? 's' : ''}`) : null);
    box.append(head, h('div.slist', m.tools.filter((t, i) => !(t.note && t.note === m.text && i === m.tools.length - 1)).map(stepRow)));
    return box;
  }
  // Tight replies: show the summary (text before `Details:` or the first paragraph); the rest folds away.
  function splitReply(text) {
    const t = String(text || '').trim(); const k = t.search(/^\s*(details|more|notes):\s*$/im);
    if (k >= 0) return { head: t.slice(0, k).trim(), rest: t.slice(k).replace(/^\s*(details|more|notes):\s*/i, '').trim() };
    const paras = t.split(/\n\s*\n/); const headLen = (s) => s.split('\n').length;
    if (paras.length > 1) { let n = 0; const head = []; for (const p of paras) { if (head.length && n + headLen(p) > 4) break; head.push(p); n += headLen(p); } if (head.length < paras.length) return { head: head.join('\n\n'), rest: paras.slice(head.length).join('\n\n') }; }
    const lines = t.split('\n'); if (paras.length === 1 && lines.length > 5 && !lines.some((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l))) return { head: lines.slice(0, 3).join('\n'), rest: lines.slice(3).join('\n') };
    return { head: t, rest: '' };
  }
  function msgEl(m) {
    const el = h('div.msg', { class: `msg ${m.role}` });
    if (m.system) { el.classList.add('sys'); el.append(h('div.sysline', h('span', m.text), m.versionId ? h('a', { href: `#/p/${project.id}?v=${m.versionId}` }, 'Review ↗') : null)); return el; }
    if (m.role === 'user') { el.append(h('div.card', m.text), h('div.meta', [m.author || getAuthor() || 'You', relTime(m.at)].filter(Boolean).join(' · '))); return el; }
    if (m.tools?.length && (m.tools.some((t) => !t.note) || m.live)) el.append(stepsEl(m));
    if (m.text) {
      const { head, rest } = splitReply(m.text);
      const body = h('div.body', md(head));
      if (rest) { const det = h('div.details.hidden', md(rest)); const tg = h('button.more', { on: { click: () => { m._more = det.classList.toggle('hidden') === false; tg.classList.toggle('open', m._more); } } }, svg('chevron'), 'Details'); if (m._more) { det.classList.remove('hidden'); tg.classList.add('open'); } body.append(tg, det); }
      el.append(body);
    }
    if (m.error) el.append(h('div.errcard', m.error, h('div.actions', btn('Copy error', { cls: 'sm ghost', icon: 'copy', onClick: async () => { await copyText(m.error); toast('Copied', 'ok'); } }), btn('Run diagnostics', { cls: 'sm ghost', onClick: runDiagnostics }))));
    if (m.live) el.append(h('div.gen', h('span.shimmer', m.status && m.status !== 'thinking' ? m.status : 'Generating…')));
    if (!m.live && !m.error && m.text) el.append(h('div.meta', relTime(m.at)));
    return el;
  }
  function renderChat(list) {
    const atBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
    msgs.replaceChildren(...(list.length ? list.map(msgEl) : [h('div.empty-chat', h('div.ehead', svg('sparkle'), h('b', 'Make a video with the agent')), h('p', 'Describe what you want. The agent writes the composition on this computer; watch it in the preview, adjust on the timeline, talk and draw on the frame to change it.'), h('div.sugs', ['Make a 10-second product teaser: dark background, bold title, three feature lines, call to action at the end.', 'Change the title to "Hello world" and make it enter at 1s.', 'Add a warm gradient background and a logo sting at the start.'].map((s) => h('button.sug', { on: { click: () => { ta.value = s; grow(); ta.focus(); } } }, s))))]));
    if (atBottom || list.some((m) => m.live)) msgs.scrollTop = msgs.scrollHeight;
  }
  async function runDiagnostics() {
    const pre = h('pre', 'Running claude --version and a one-line prompt in the project folder… (up to 90s)');
    const close = modal('Claude Code diagnostics', h('div', h('p.small.muted', 'This is what the Videditor server sees when it runs Claude Code on this computer. Paste it to whoever is helping you.'), pre), { wide: true, actions: [{ label: 'Copy', icon: 'copy', onClick: async () => { await copyText(pre.textContent); toast('Copied', 'ok'); return false; } }] });
    try { const d = await api.diagnose(project.id); pre.textContent = JSON.stringify(d, null, 2); } catch (e) { pre.textContent = e.message; }
    return close;
  }
  async function send() {
    const text = ta.value.trim(); if (!text) return;
    if (agentJob) return toast('The agent is still working on the previous message. Press Stop to interrupt it.', 'err');
    const kind = agentSel.value || project.agent || 'claude'; const cap = caps.agents?.[kind] || { label: 'Claude Code', available: caps.claude, install: 'npm install -g @anthropic-ai/claude-code' };
    if (!cap.available) { toast(`${cap.label} was not found on this computer`, 'err'); return msgs.append(h('div.msg.agent', h('div.errcard', `${cap.label} is not installed or not on PATH. Install it with: ${cap.install}   sign in once, then restart the Videditor server.`))); }
    const author = await ensureAuthor();
    const message = ctx._id ? `About the clip #${ctx._id}: ${text}` : text;
    ta.value = ''; grow(); ctx.classList.add('hidden'); ctx._id = null;
    project.chat = project.chat || []; project.chat.push({ role: 'user', text: message, at: new Date().toISOString(), author });
    const live = { role: 'agent', text: '', tools: [], at: new Date().toISOString(), live: true, status: 'starting the agent' };
    renderChat([...project.chat, live]);
    setBusy(true);
    try {
      const { jobId } = await api.agent(project.id, message, { author, agent: kind });
      followJob(jobId, live);
    } catch (e) { agentJob = null; setBusy(false); live.live = false; live.error = e.message; renderChat([...project.chat, live]); }
  }
  function followJob(jobId, live) {
      agentJob = jobId;
      const es = new EventSource(`/api/jobs/${jobId}/events`);
      const redraw = () => { renderChat([...project.chat, live]); };
      es.onmessage = (e) => {
        const ev = JSON.parse(e.data);
        if (ev.type === 'text') { live.tools.push({ note: ev.text }); live.text = ev.text; live.status = 'thinking'; }
        else if (ev.type === 'tool') { live.tools.push({ name: ev.name, detail: ev.detail }); live.status = `${ev.name} ${ev.detail || ''}`.trim(); if (/^(Edit|Write|MultiEdit)$/.test(ev.name) && /\.(html|css|js)$/.test(ev.detail || '')) reloadComp(); }
        else if (ev.type === 'status') live.status = ev.message;
        else if (ev.type === 'error') live.error = ev.message;
        redraw();
      };
      es.addEventListener('done', async (e) => {
        es.close(); agentJob = null; setBusy(false);
        const d = JSON.parse(e.data); live.live = false; if (!live.text && d.result) live.text = d.result;
        project = await api.project(project.id); if (!Array.isArray(project.chat)) project.chat = []; renderChat(project.chat.length ? project.chat : [...project.chat, live]);
        await renderVariants(); await reloadComp();
        if (d.renderJobId) followRender(d.renderJobId, { quiet: true }); toast(d.ok ? 'Agent finished' : 'Agent stopped with an error', d.ok ? 'ok' : 'err');
      });
      es.onerror = () => { es.close(); agentJob = null; setBusy(false); live.live = false; redraw(); };
  }

  // ---------- render
  async function renderNow() {
    if (!caps.playwright) return modal('Renderer not set up', h('div', h('p', 'Rendering uses your installed Chrome through Playwright. Install it once:'), h('pre.log', 'cd videditor && npm install'), h('p.muted', 'Then restart the server.')));
    const fmts = caps.formats || {}; const keys = Object.keys(fmts);
    const saved = JSON.parse(localStorage.getItem('videditor.renderOpts') || '{}');
    const ch = stage.info?.height || 720;
    const PRESETS = [['1', `Composition size (${stage.info?.width || '?'}×${ch})`], [String(720 / ch), '720p'], [String(1080 / ch), '1080p'], [String(2160 / ch), '4K']].filter(([v]) => Number(v) >= 0.25 && Number(v) <= 4);
    const preset = h('select.text', { style: { width: 'auto' } }, PRESETS.map(([v, l]) => h('option', { value: v, selected: v === (saved.scale || '1') }, l)));
    const format = h('select.text', { style: { width: 'auto', maxWidth: '100%' } }, keys.map((k) => h('option', { value: k, selected: k === (saved.format || caps.defaultFormat || 'mp4-h264'), disabled: !fmts[k].available }, `${fmts[k].label}${fmts[k].available ? '' : ' (encoder missing)'}`)));
    const note = h('p.hint');
    const quality = h('select.text', { style: { width: 'auto' } }, [['draft', 'Draft (fast)'], ['looks', 'Normal'], ['high', 'High']].map(([v, l]) => h('option', { value: v, selected: v === (saved.quality || 'looks') }, l)));
    const crf = h('input.text', { type: 'number', min: 0, max: 63, placeholder: 'auto', value: saved.crf || '', style: { width: '90px' }, title: 'Constant rate factor: lower = better and bigger. Leave empty to use the quality preset.' });
    const maxBitrate = h('input.text', { type: 'number', min: 0.5, step: 0.5, placeholder: 'none', value: saved.maxBitrate || '', style: { width: '90px' }, title: 'Cap the bitrate (Mbps) for platforms with upload limits' });
    const fpsIn = h('input.text', { type: 'number', min: 1, max: 120, placeholder: String(stage.info?.fps || 30), value: saved.fps || '', style: { width: '90px' } });
    const audioCb = h('input', { type: 'checkbox', checked: saved.audio !== false });
    const alphaCb = h('input', { type: 'checkbox', checked: !!saved.alpha });
    const alphaRow = h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, alphaCb, h('span', 'Transparent background (drops the page background; the stage keeps its own)'));
    const crfRow = h('div.irow', h('span', 'CRF'), h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, crf, h('span.small.muted', 'auto from quality')));
    const notes = h('textarea.text', { rows: 2, placeholder: 'What changed in this version?' });
    let plan = { outputs: [], exists: false }; try { plan = await api.renderPlan(project.id); } catch {}
    let vlist = []; try { vlist = (await api.variants(project.id)).variants; } catch {}
    const hasIO = IO.in !== null || IO.out !== null; const dur = stage.duration || 0;
    const what = h('select.text', { style: { width: '100%' } },
      h('option', { value: 'current' }, `This composition (${activeEntry() === 'index.html' ? 'main' : activeEntry()}), whole`),
      hasIO ? h('option', { value: 'range', selected: true }, `In → out: ${fmtTime(IO.in ?? 0)} – ${fmtTime(IO.out ?? dur)}`) : null,
      vlist.length > 1 ? h('option', { value: 'variants' }, `All ${vlist.length} compositions (main + variants), one file each`) : null,
      plan.outputs.length ? h('option', { value: 'plan' }, `Outputs from render.json (${plan.outputs.length}): ${plan.outputs.map((o) => o.name).join(', ').slice(0, 80)}`) : null);
    const planNote = plan.outputs.length ? h('p.hint', 'render.json outputs carry their own entry, range and format; the choices below are ignored for them.') : h('p.hint', 'Tip: ask the agent "make me 4 one-minute videos" and it writes a render.json with one output each; or set I / O points on the timeline to render a part.');
    const sync = () => { const f = fmts[format.value] || {}; note.textContent = f.note || ''; alphaRow.style.display = f.alpha ? 'flex' : 'none'; crfRow.style.display = f.crf ? 'grid' : 'none'; const auto = f.crf ? f.crf[quality.value] : null; crfRow.querySelector('.small').textContent = auto !== null ? `auto ${auto} for ${quality.options[quality.selectedIndex].text.toLowerCase()}` : ''; };
    format.addEventListener('change', sync); quality.addEventListener('change', sync); sync();
    const adv = h('details', { open: !!(saved.crf || saved.maxBitrate || saved.fps || saved.audio === false || saved.alpha) }, h('summary', { style: { cursor: 'pointer', color: 'var(--fg-1)', fontSize: '12.5px' } }, 'Advanced'),
      h('div.inspector', { style: { border: 0, padding: '8px 0 0' } }, crfRow, h('div.irow', h('span', 'Max bitrate'), h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, maxBitrate, h('span.small.muted', 'Mbps'))), h('div.irow', h('span', 'Frame rate'), h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, fpsIn, h('span.small.muted', 'fps'))), h('div.irow', h('span', 'Audio'), h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, audioCb, h('span', 'include the composition\'s audio'))), h('div.irow', h('span', 'Alpha'), alphaRow)));
    const ok = await modal(`Render v${project.versions.length + 1}`, h('div', h('label.field', h('span', 'What'), what, planNote), h('label.field', h('span', 'Format'), format, note), h('div', { style: { display: 'flex', gap: '12px' } }, h('label.field', { style: { flex: 1 } }, h('span', 'Size'), preset), h('label.field', { style: { flex: 1 } }, h('span', 'Quality'), quality)), adv, h('label.field', { style: { marginTop: '10px' } }, h('span', 'Version notes'), notes)), { actions: [{ label: 'Render all sizes', cls: 'ghost', value: 'all' }, { label: 'Render', cls: 'primary', icon: 'render', value: true }] });
    if (!ok) return;
    const opts = { format: format.value, quality: quality.value, crf: crf.value ? Number(crf.value) : undefined, maxBitrate: maxBitrate.value ? Number(maxBitrate.value) : undefined, fps: fpsIn.value ? Number(fpsIn.value) : undefined, audio: audioCb.checked, alpha: alphaCb.checked && !!fmts[format.value]?.alpha, notes: notes.value.trim() };
    if (what.value === 'range') opts.range = { start: IO.in ?? 0, end: IO.out ?? dur };
    if (what.value === 'variants') opts.mode = 'variants';
    if (what.value === 'plan') opts.mode = 'plan';
    localStorage.setItem('videditor.renderOpts', JSON.stringify({ format: opts.format, quality: opts.quality, crf: crf.value, maxBitrate: maxBitrate.value, fps: fpsIn.value, audio: opts.audio, alpha: opts.alpha, scale: preset.value }));
    if (ok === 'all' && !opts.mode) { const items = PRESETS.filter(([v]) => v !== '1' || PRESETS.length === 1).map(([v, l]) => ({ ...opts, scale: Number(v), label: l.split(' ')[0] })); try { const { jobId } = await api.render(project.id, { items }); followRender(jobId); toast(`Rendering ${items.length} sizes in the background`, 'ok'); } catch (e) { toast(e.message, 'err'); } return; }
    await renderOne({ ...opts, scale: Number(preset.value), label: null, last: true });
  }
  async function renderOne({ quality, notes, scale, label, last, ...rest }) {
    try { const { jobId } = await api.render(project.id, { quality, notes, scale, label, ...rest }); followRender(jobId); toast('Rendering in the background. Keep working; you will get a toast when it is ready.', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  }

  // ---------- top bar + layout
  topbar([
    btn('', { icon: 'back', cls: 'ghost icon', title: 'All videos', onClick: () => navigate('#/') }),
    h('span.title', project.name), h('span.pill', svg('spark'), 'Studio'), variantSel, variantDelBtn,
    h('span.spacer'),
    project.versions.length ? btn('Review', { icon: 'chat', title: 'Review the latest render', onClick: () => navigate(`#/p/${project.id}`) }) : null,
    btn('', { icon: 'trash', cls: 'ghost icon', title: 'Delete project', onClick: async () => { if (await confirmDeleteProject(api, project)) navigate('#/'); } }),
  ]);
  root._cleanupExtra = () => clearInterval(assetsPoll);
  root.replaceChildren(h('div.studio', chat, h('div.center', stageWrap, transport, tl), side));
  if (!Array.isArray(project.chat)) project.chat = [];
  renderChat(project.chat);
  const key = (e) => { if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey) return; const k = e.key.toLowerCase();
    if (e.key === '?' || (e.key === '/' && e.shiftKey)) return shortcutsSheet('Studio shortcuts', [['Space', 'Play / pause'], ['← →', 'One frame back / forward'], ['Shift+← →', 'One second'], ['Home', 'Go to start'], ['D', 'Draw on the preview'], ['R', 'Talk: start / stop a voice note (goes to the agent)'], ['Shift+R', 'Run-through: play from the start, talk and draw as it runs; everything goes to the agent at the end'], ['Z', 'Undo last stroke'], ['Esc', 'Deselect / stop drawing'], ['I / O', 'Set in / out point (render range)'], ['Shift+I', 'Clear in / out'], ['+ −', 'Zoom timeline'], ['0', 'Fit timeline'], ['⌘ wheel', 'Zoom timeline around the cursor'], ['Enter', 'Send to the agent (in the chat box)'], ['Shift+Enter', 'New line in the chat box'], ['Enter', 'Confirm a dialog'], ['?', 'This sheet']]);
    if (k === 'c') { e.preventDefault(); ta.focus(); return; } if (k === 'd') return setNoteTool(N.tool === 'pen' ? null : 'pen'); if (k === 'r' && e.shiftKey) return toggleRun(); if (k === 'r') return toggleNoteRecord(); if (k === 'i' && e.shiftKey) return clearIO(); if (k === 'i') { setIO('in', Math.round(stage.time * 100) / 100); return toast(`In point ${fmtTime(IO.in)}`, 'ok'); } if (k === 'o') { setIO('out', Math.round(stage.time * 100) / 100); return toast(`Out point ${fmtTime(IO.out)}`, 'ok'); } if (k === 'z') return noteLayer.undo(); if (k === '+' || k === '=') return setZoom(zoom * 1.5); if (k === '-') return setZoom(zoom / 1.5); if (k === '0') return setZoom(1); if (e.code === 'Space') { e.preventDefault(); stage.toggle(); } else if (e.key === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? stage.seek(Math.max(0, stage.time - 1)) : step(-1); } else if (e.key === 'ArrowRight') { e.preventDefault(); e.shiftKey ? stage.seek(Math.min(stage.duration, stage.time + 1)) : step(1); } else if (e.key === 'Home') stage.seek(0); else if (e.key === 'Escape') selectClip(null); };
  document.addEventListener('keydown', key);
  new ResizeObserver(() => { renderTimeline(); }).observe(tlScroll);
  await stage.load(src());
  if (!stage.info) showOverlay('The composition did not load. Check index.html in Files, or ask the agent to fix it.', true);
  // Resume a running agent job (page reload mid-run) or start with a prompt from the URL.
  api.renderStatus(project.id).then((r) => { if (r.running) followRender(r.running, { quiet: true }); }).catch(() => {});
  const chatState = await api.chat(project.id).catch(() => null);
  if (Array.isArray(chatState?.chat)) { project.chat = chatState.chat; renderChat(project.chat); }
  if (chatState?.running) {
    agentJob = chatState.running; setBusy(true);
    const live = { role: 'agent', text: '', tools: [], at: new Date().toISOString(), live: true, status: 'still working on your earlier message (press Stop to interrupt)' };
    renderChat([...(project.chat || []), live]);
    const es = new EventSource(`/api/jobs/${chatState.running}/events`);
    es.onmessage = (e) => { const ev = JSON.parse(e.data); if (ev.type === 'text') { live.tools.push({ note: ev.text }); live.text = ev.text; } if (ev.type === 'tool') live.tools.push({ name: ev.name, detail: ev.detail }); if (ev.type === 'status') live.status = ev.message; if (ev.type === 'error') live.error = ev.message; renderChat([...(project.chat || []), live]); };
    const finish = async () => { es.close(); agentJob = null; setBusy(false); project = await api.project(project.id); renderChat(project.chat || []); reloadComp(); };
    es.addEventListener('done', finish); es.onerror = finish;
  }
  if (prompt && !chatState?.running) { ta.value = prompt; history.replaceState(null, '', `#/studio/${project.id}`); setTimeout(send, 400); }
  root._cleanup = () => { document.removeEventListener('keydown', key); stage.destroy(); root._cleanupExtra?.(); };
}
