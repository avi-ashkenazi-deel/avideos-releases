import { api } from './api.js';
import { h, btn, svg, modal, toast, fmtTime, relTime, avatar, getAuthor, ensureAuthor, copyText, fileToDataUrl, confirmDeleteProject } from './ui.js';
import { Player } from './player.js';
import { DrawLayer, COLORS, drawStroke } from './draw.js';
import { VoiceRecorder, highlightPointing } from './voice.js';
import { Stage } from './stage.js';

// Player-compatible wrapper around the live composition Stage.
class StagePlayer {
  constructor(stage, fps) { this.stage = stage; this.fps = fps; this.listeners = new Set(); for (const ev of ['time', 'play', 'pause', 'ready', 'ended']) stage.on(ev, () => this.emit()); }
  get time() { return this.stage.time; } get duration() { return this.stage.duration; } get paused() { return !this.stage.playing; }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); } emit() { for (const fn of this.listeners) fn(this); }
  seek(t) { return this.stage.seek(Math.max(0, Math.min(this.duration || t, t))); } step(n) { this.pause(); return this.seek(this.time + n / this.fps); }
  toggle() { this.stage.toggle(); } play() { this.stage.play(); } pause() { this.stage.pause(); } setRate() {}
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export async function renderReview(root, { projectId, versionId, navigate, topbar }) {
  let project = await api.project(projectId);
  if (!project.versions.length) return renderNoVersions(root, project, { navigate, topbar });
  let version = project.versions.find((v) => v.id === versionId) || project.versions[project.versions.length - 1];
  let feedback = await api.feedback({ versionId: version.id });
  let composition = project.dir ? await api.composition(project.id).catch(() => null) : null;
  const fps = composition?.fps || version.fps || 30;
  let selectedId = null, filter = 'all', tab = 'feedback';
  const S = { anchor: null, anchorEnd: null, refs: [], voice: null, tool: null };

  // ---------- stage
  const video = h('video', { src: version.playable === false ? undefined : version.mediaUrl, poster: version.posterUrl || undefined, preload: 'auto', playsinline: true, crossorigin: 'anonymous' });
  if (version.playable === false) setTimeout(() => toast(`${version.formatLabel || version.originalName} does not play in a browser. Download it from Versions, or switch to Live to review the composition.`, 'err'), 300);
  const canvas = h('canvas.overlay');
  const recBadge = h('div.badge-rec.hidden', h('i'), 'Recording');
  const frame = h('div.frame', { style: { '--ar': version.width && version.height ? `${version.width}/${version.height}` : '16/9' } }, video, canvas, recBadge);
  const viewport = h('div.viewport', frame);
  let player = new Player(video, { fps });
  const playerSubs = []; const onPlayer = (fn) => { playerSubs.push(fn); player.on(fn); };
  const layer = new DrawLayer(canvas, () => player.time);
  // Live mode: show the composition itself (runtime iframe) instead of the rendered MP4.
  let live = false, stage = null;
  const seekAndWait = async (t) => { if (live) { await player.seek(t); return; } if (Math.abs(player.time - t) <= 0.02) return; player.seek(t); await new Promise((r) => { const done = () => { video.removeEventListener('seeked', done); r(); }; video.addEventListener('seeked', done); setTimeout(r, 800); }); };
  const snapshotAt = async (strokes, opts) => {
    if (!live) return DrawLayer.snapshot(video, strokes, opts);
    const img = new Image(); img.src = `/api/projects/${project.id}/frame?t=${player.time}&_=${Date.now()}`;
    await new Promise((r) => { img.onload = r; img.onerror = r; });
    return img.naturalWidth ? DrawLayer.snapshot(img, strokes, opts) : DrawLayer.snapshot({ width: 1280, height: 720 }, strokes, opts);
  };
  async function setLive(on) {
    if (on === live) return; live = on;
    player.pause();
    if (on) {
      video.classList.add('hidden'); stage = new Stage(frame); stage.iframe.style.zIndex = '1';
      player = new StagePlayer(stage, fps); for (const fn of playerSubs) player.on(fn);
      await stage.load(`/project-files/${project.id}/${project.composition || 'index.html'}?runtime=1&_=${Date.now()}`);
      stage.on('select', (m) => { toast(`Selected #${m.id}`, 'ok'); if (!ta.value.trim()) { ta.value = `#${m.id}: `; } if (S.anchor === null) S.anchor = player.time; updateComposer(); ta.focus(); });
      renderMarkers(); renderLanes(); player.emit();
    } else {
      stage?.destroy(); stage = null; video.classList.remove('hidden');
      player = new Player(video, { fps }); for (const fn of playerSubs) player.on(fn); player.emit();
    }
    liveBtn?.classList.toggle('active', live); liveBtn && (liveBtn.title = live ? 'Showing the live composition. Click to show the rendered version.' : 'Show the live composition instead of the render');
  }
  let liveBtn = null;
  fitFrame(); new ResizeObserver(fitFrame).observe(viewport);
  function fitFrame() { const r = viewport.getBoundingClientRect(); const ar = (version.width && version.height) ? version.width / version.height : 16 / 9; const w = Math.min(r.width - 32, (r.height - 24) * ar); frame.style.width = `${Math.max(200, w)}px`; frame.style.height = `${Math.max(112, w / ar)}px`; }

  const timeEl = h('span.time'); const playBtn = btn('', { icon: 'play', cls: 'icon', title: 'Play / pause (space)', onClick: () => player.toggle() });
  const rate = h('select.text', { style: { width: 'auto', padding: '4px 6px' }, title: 'Speed', on: { change: (e) => player.setRate(Number(e.target.value)) } }, [0.5, 1, 1.5, 2].map((r) => h('option', { value: r, selected: r === 1 }, `${r}×`)));
  const muteBtn = btn('', { icon: 'volume', cls: 'icon ghost', title: 'Mute (m)', onClick: () => { video.muted = !video.muted; muteBtn.replaceChildren(svg(video.muted ? 'mute' : 'volume')); } });
  const controls = h('div.controls', playBtn, btn('', { icon: 'stepBack', cls: 'icon ghost', title: 'Back one frame (←)', onClick: () => player.step(-1) }), btn('', { icon: 'stepFwd', cls: 'icon ghost', title: 'Forward one frame (→)', onClick: () => player.step(1) }), timeEl, h('span.spacer'), h('span.hint', 'Space play · ← → frame · J K L · C comment · D draw · R record'), rate, muteBtn);

  // timeline
  const played = h('div.played'); const head = h('div.head'); const rangeEl = h('div.range.hidden'); const markers = h('div');
  const scrub = h('div.scrub', h('div.track'), played, rangeEl, markers, head);
  const lanes = h('div.lanes'); const lanesTitle = h('div.lanes-title.hidden');
  const timeline = h('div.timeline', scrub, lanesTitle, lanes);
  let scrubbing = false;
  const scrubTo = (e) => { const r = scrub.getBoundingClientRect(); player.seek(((e.clientX - r.left) / r.width) * player.duration); };
  scrub.addEventListener('pointerdown', (e) => { if (e.target.classList.contains('marker')) return; scrubbing = true; scrub.setPointerCapture(e.pointerId); scrubTo(e); });
  scrub.addEventListener('pointermove', (e) => { if (scrubbing) scrubTo(e); });
  scrub.addEventListener('pointerup', () => { scrubbing = false; });

  // composer
  const ta = h('textarea', { placeholder: 'Leave a note at the playhead… (C)', rows: 2 });
  const anchorPill = h('span.pill.time', { title: 'Click to pin to the playhead', on: { click: () => { S.anchor = player.time; S.anchorEnd = null; updateComposer(); } } });
  const unpin = btn('', { icon: 'unpin', cls: 'ghost icon sm', title: 'Comment on the whole video', onClick: () => { S.anchor = null; S.anchorEnd = null; updateComposer(); } });
  const rangeBtn = btn('to here', { cls: 'ghost sm', title: 'Extend the note to the playhead (O)', onClick: () => { if (S.anchor === null) S.anchor = player.time; S.anchorEnd = Math.max(S.anchor + 0.1, player.time); updateComposer(); } });
  const transcriptEl = h('div.transcript.hidden');
  const attach = h('div.attach');
  const refInput = h('input', { type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' }, on: { change: async () => { for (const f of refInput.files) S.refs.push(await fileToDataUrl(f)); refInput.value = ''; updateComposer(); } } });
  const colors = h('span.colors', COLORS.map((c) => h('span.swatch', { style: { background: c }, class: `swatch ${c === layer.color ? 'active' : ''}`, on: { click: () => { layer.color = c; colors.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('active', s.style.backgroundColor === colorToRgb(c))); } } })));
  const toolBtns = {};
  const toolBtn = (name, ic, title) => (toolBtns[name] = btn('', { icon: ic, cls: 'icon sm', title, onClick: () => setTool(S.tool === name ? null : name) }));
  const undoBtn = btn('', { icon: 'undo', cls: 'icon sm ghost', title: 'Undo stroke', onClick: () => layer.undo() });
  const clearBtn = btn('', { icon: 'trash', cls: 'icon sm ghost', title: 'Clear drawing', onClick: () => layer.clear() });
  const recBtn = btn('Record', { icon: 'mic', cls: 'sm', title: 'Record a voice note (R). Talk, point, draw and scrub while it records.', onClick: toggleRecord });
  const postBtn = btn('Post', { cls: 'primary sm', title: 'Post (⌘/Ctrl+Enter)', onClick: () => post() });
  const composer = h('div.composer',
    h('div.tools', toolBtn('pen', 'pen', 'Draw (D)'), toolBtn('arrow', 'arrow', 'Arrow'), toolBtn('rect', 'rect', 'Rectangle'), toolBtn('ellipse', 'ellipse', 'Circle'), colors, undoBtn, clearBtn, h('span.sep'), recBtn, btn('', { icon: 'image', cls: 'icon sm ghost', title: 'Attach a reference image', onClick: () => refInput.click() }), refInput, h('span.spacer', { style: { flex: 1 } }), h('span.hint', VoiceRecorder.speechSupported() ? 'Voice notes are transcribed live' : 'No live transcription in this browser; audio is still saved')),
    ta, transcriptEl, attach,
    h('div.foot', h('span.anchor', svg('pin'), anchorPill, unpin, rangeBtn), h('span', { style: { flex: 1 } }), postBtn));
  ta.addEventListener('focus', () => { if (S.anchor === null && !S.touched) { S.anchor = player.time; updateComposer(); } });
  ta.addEventListener('input', () => { S.touched = true; });
  layer.onChange = (strokes) => { if (strokes.length && S.anchor === null) S.anchor = strokes[0].points[0][2]; updateComposer(); };
  function setTool(t) { S.tool = t; layer.tool = t || 'pen'; layer.setEnabled(!!t); for (const [n, b] of Object.entries(toolBtns)) b.classList.toggle('active', n === t); if (t && player.paused === false) { /* drawing while playing is allowed; strokes get video times */ } }
  function updateComposer() {
    anchorPill.textContent = S.anchor === null ? 'whole video' : S.anchorEnd !== null ? `${fmtTime(S.anchor, { frames: true, fps })} – ${fmtTime(S.anchorEnd, { frames: true, fps })}` : fmtTime(S.anchor, { frames: true, fps });
    unpin.classList.toggle('hidden', S.anchor === null);
    attach.replaceChildren(...S.refs.map((r, i) => h('img', { src: r, title: 'Click to remove', on: { click: () => { S.refs.splice(i, 1); updateComposer(); } } })));
    const has = ta.value.trim() || layer.strokes.length || S.voice || S.refs.length;
    postBtn.disabled = !has;
    rangeEl.classList.toggle('hidden', S.anchor === null || S.anchorEnd === null);
    if (S.anchor !== null && S.anchorEnd !== null && player.duration) { rangeEl.style.left = `${(S.anchor / player.duration) * 100}%`; rangeEl.style.width = `${((S.anchorEnd - S.anchor) / player.duration) * 100}%`; }
  }
  ta.addEventListener('input', updateComposer);
  ta.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') post(); if (e.key === 'Escape') ta.blur(); });

  // voice
  let recorder = null;
  async function toggleRecord() {
    if (recorder?.recording) { return stopRecord(); }
    if (!VoiceRecorder.supported()) return toast('This browser cannot record audio', 'err');
    try {
      recorder = new VoiceRecorder({ getTime: () => player.time, snapshot: () => snapshotAt(layer.strokes, { maxWidth: 960, quality: 0.8 }) });
      await recorder.start((r) => { transcriptEl.classList.remove('hidden'); transcriptEl.innerHTML = highlightPointing(esc(r.transcript)) + (r.interim ? ` <span class="muted">${esc(r.interim)}</span>` : '') || '<span class="muted">Listening… say what should change, point with “this” / “here” while the video plays.</span>'; });
      if (S.anchor === null) S.anchor = player.time;
      recBadge.classList.remove('hidden'); composer.classList.add('rec'); recBtn.replaceChildren(svg('stop'), 'Stop'); recBtn.classList.add('danger');
      if (!S.tool) setTool('pen');
      updateComposer();
    } catch (e) { toast(`Microphone: ${e.message}`, 'err'); recorder = null; }
  }
  async function stopRecord() {
    const r = await recorder.stop(); recorder = null;
    recBadge.classList.add('hidden'); composer.classList.remove('rec'); recBtn.replaceChildren(svg('mic'), 'Record'); recBtn.classList.remove('danger');
    S.voice = r; S.anchorEnd = r.endTime > r.startTime + 0.3 ? r.endTime : null;
    if (!ta.value.trim() && r.transcript) ta.value = r.transcript;
    transcriptEl.innerHTML = r.transcript ? highlightPointing(esc(r.transcript)) : '<span class="muted">Voice note recorded (no transcript available).</span>';
    updateComposer(); ta.focus();
  }

  async function post(replyTo = null, body = null) {
    if (typeof replyTo !== 'string') replyTo = null;
    const author = await ensureAuthor();
    if (replyTo) { try { await api.postFeedback({ versionId: version.id, replyTo, body, author }); await refreshFeedback(); } catch (e) { toast(e.message, 'err'); } return; }
    const text = ta.value.trim(); if (!text && !layer.strokes.length && !S.voice && !S.refs.length) return;
    postBtn.disabled = true;
    const frames = [];
    if (layer.strokes.length || S.anchor !== null) {
      const t = S.anchor ?? player.time;
      await seekAndWait(t);
      frames.push({ time: t, label: layer.strokes.length ? 'annotated frame' : 'frame', dataUrl: await snapshotAt(layer.strokes) });
    }
    if (S.voice) for (const f of S.voice.frames) if (!(frames.length && Math.abs(f.time - frames[0].time) < 0.05 && f.label === 'start of note')) frames.push(f);
    const body0 = { versionId: version.id, author, body: text, time: S.anchor, timeEnd: S.anchorEnd, tags: live ? ['live'] : [], kind: S.voice ? 'voice' : layer.strokes.length && !text ? 'drawing' : 'text', drawing: layer.strokes.length ? { color: layer.color, strokes: layer.strokes } : null, frames, refs: S.refs, transcript: S.voice?.transcript || null, visualReferences: S.voice?.visualReferences || [], audio: S.voice?.audio || null };
    try {
      const f = await api.postFeedback(body0);
      ta.value = ''; layer.clear(); S.voice = null; S.refs = []; S.anchor = null; S.anchorEnd = null; S.touched = false; transcriptEl.classList.add('hidden'); setTool(null); updateComposer();
      await refreshFeedback(); select(f.id, false); toast('Posted', 'ok');
    } catch (e) { toast(e.message, 'err'); postBtn.disabled = false; }
  }

  // ---------- side panel
  const fbList = h('div.fb-list'); const ctxBody = h('div'); const verBody = h('div');
  const counts = { feedback: h('span.count'), versions: h('span.count') };
  const tabs = h('div.tabs', ['feedback', 'context', 'versions'].map((t) => h('span.tab', { class: `tab ${t === tab ? 'active' : ''}`, 'data-tab': t, on: { click: () => setTab(t) } }, t[0].toUpperCase() + t.slice(1), counts[t] || null)));
  const filters = h('div.filters', ['all', 'open', 'done'].map((f) => btn(f[0].toUpperCase() + f.slice(1), { cls: `sm ${filter === f ? 'active' : 'ghost'}`, onClick: () => { filter = f; filters.querySelectorAll('.btn').forEach((b) => { b.classList.toggle('active', b.textContent.toLowerCase() === f); b.classList.toggle('ghost', b.textContent.toLowerCase() !== f); }); renderFeedback(); } })), h('span.spacer'), btn('Copy prompt', { icon: 'copy', cls: 'sm', title: 'Copy a brief with all open feedback for your agent', onClick: copyPrompt }));
  const panelBody = h('div.body', filters, fbList);
  const panel = h('div.panel', tabs, panelBody);
  function setTab(t) { tab = t; tabs.querySelectorAll('.tab').forEach((el) => el.classList.toggle('active', el.dataset.tab === t)); panelBody.replaceChildren(...(t === 'feedback' ? [filters, fbList] : t === 'context' ? [ctxBody] : [verBody])); if (t === 'context') renderContext(); if (t === 'versions') renderVersions(); }

  const top = (f) => !f.replyTo;
  function renderFeedback() {
    const items = feedback.filter(top).filter((f) => filter === 'all' || f.status === filter).sort((a, b) => (a.time ?? -1) - (b.time ?? -1) || a.createdAt.localeCompare(b.createdAt));
    counts.feedback.textContent = feedback.filter(top).filter((f) => f.status === 'open').length || '';
    fbList.replaceChildren(...(items.length ? items.map(card) : [h('div.empty', filter === 'all' ? h('div', h('p', 'No notes on this version yet.'), h('p.small', 'Press ', h('span.kbd', 'C'), ' to comment at the playhead, ', h('span.kbd', 'D'), ' to draw on the frame, ', h('span.kbd', 'R'), ' to record a voice note.')) : `Nothing ${filter}.`)]));
    renderMarkers();
  }
  function card(f) {
    const replies = feedback.filter((r) => r.replyTo === f.id);
    const replyInput = h('input.text', { placeholder: 'Reply…', on: { keydown: (e) => { if (e.key === 'Enter' && replyInput.value.trim()) { post(f.id, replyInput.value.trim()); replyInput.value = ''; } e.stopPropagation(); } } });
    const el = h('div.fb', { class: `fb ${f.status} ${selectedId === f.id ? 'selected' : ''}`, 'data-id': f.id, on: { click: (e) => { if (e.target.closest('button, input, a, audio, img, mark')) return; select(f.id); } } },
      h('div.head', avatar(f.author, f.postedByAgent), h('span.who', f.author), f.postedByAgent ? h('span.pill.agent', 'agent') : null, f.time !== null ? h('span.pill.time', { on: { click: () => { player.seek(f.time); select(f.id, false); } } }, f.timeEnd ? `${fmtTime(f.time)}–${fmtTime(f.timeEnd)}` : fmtTime(f.time)) : h('span.pill', 'whole video'), h('span.when', relTime(f.createdAt))),
      h('div.text', f.body),
      f.transcript && f.transcript !== f.body ? h('div.transcript', { html: transcriptHtml(f) }) : null,
      f.frames?.length || f.refs?.length ? h('div.media', (f.frames || []).map((fr) => h('img', { src: fr.url, title: `${fr.label || 'frame'} at ${fmtTime(fr.time)}`, on: { click: () => zoom(fr.url, `${fr.label || 'frame'} at ${fmtTime(fr.time)}`) } })), (f.refs || []).map((r) => h('img', { src: r, title: 'Reference image', style: { borderColor: 'var(--accent-2)' }, on: { click: () => zoom(r, 'Reference image') } }))) : null,
      f.audioUrl ? h('audio', { src: f.audioUrl, controls: true, preload: 'none' }) : null,
      f.clipContext?.length ? h('div.ctx', 'On screen: ', f.clipContext.slice(0, 4).map((c, i) => [i ? ', ' : '', h('code', c.id ? `#${c.id}` : c.tag)]), f.clipContext.length > 4 ? ` +${f.clipContext.length - 4}` : '') : null,
      h('div.foot', (f.tags || []).map((t) => h('span.pill.tag', t)), h('span.spacer'),
        btn(f.status === 'done' ? 'Reopen' : 'Done', { icon: 'check', cls: `sm ${f.status === 'done' ? 'ghost' : ''}`, onClick: async () => { await api.updateFeedback(f.id, { status: f.status === 'done' ? 'open' : 'done' }); refreshFeedback(); } }),
        btn('', { icon: 'trash', cls: 'icon sm ghost', title: 'Delete', onClick: async () => { if (await modal('Delete this note?', h('p.muted', 'Replies go with it. This cannot be undone.'), { actions: [{ label: 'Delete', cls: 'danger', value: true }] })) { await api.deleteFeedback(f.id); refreshFeedback(); } } })),
      replies.length ? h('div.replies', replies.map((r) => h('div.reply', avatar(r.author, r.postedByAgent), h('div.rb', h('span.rw', r.author), r.body)))) : null,
      selectedId === f.id ? h('div.replybox', replyInput, btn('', { icon: 'reply', cls: 'icon sm', title: 'Reply', onClick: () => { if (replyInput.value.trim()) { post(f.id, replyInput.value.trim()); replyInput.value = ''; } } })) : null,
    );
    return el;
  }
  function transcriptHtml(f) {
    let html = esc(f.transcript);
    for (const r of f.visualReferences || []) { html = html.replace(new RegExp(`(?<!<mark[^>]*>)\\b(${esc(r.phrase)})\\b`, 'i'), `<mark data-t="${r.time}" title="Jump to ${fmtTime(r.time)}">$1</mark>`); }
    return html;
  }
  fbList.addEventListener('click', (e) => { const m = e.target.closest('mark[data-t]'); if (m) player.seek(Number(m.dataset.t)); });
  function renderMarkers() {
    const d = player.duration; if (!d) return;
    markers.replaceChildren(...feedback.filter(top).filter((f) => f.time !== null).map((f) => h('div.marker', { class: `marker ${f.status} ${f.postedByAgent ? 'agent' : ''} ${selectedId === f.id ? 'selected' : ''}`, style: { left: `${(f.time / d) * 100}%` }, title: `${f.author}: ${(f.body || f.transcript || '').slice(0, 80)}`, on: { click: (e) => { e.stopPropagation(); player.seek(f.time); select(f.id); } } })));
  }
  function select(id, scroll = true) {
    selectedId = id; renderFeedback();
    const f = feedback.find((x) => x.id === id);
    if (f && f.time !== null && Math.abs(player.time - f.time) > 0.15) { player.pause(); player.seek(f.time); }
    if (scroll) fbList.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    updateGhost();
  }
  function updateGhost() {
    const t = player.time; const ghost = [];
    for (const f of feedback) {
      if (!f.drawing?.strokes?.length || f.time === null) continue;
      const end = Math.max(f.timeEnd ?? f.time, f.drawing.strokes.reduce((m, s) => Math.max(m, s.points[s.points.length - 1][2]), f.time)) + 2.5;
      const show = f.id === selectedId ? (t >= f.time - 0.2 && t <= end) : (!player.paused || Math.abs(t - f.time) < 0.05) && t >= f.time - 0.02 && t <= end;
      if (!show) continue;
      for (const s of f.drawing.strokes) if (player.paused && f.id === selectedId) ghost.push(s); else { const pts = s.points.filter((p) => p[2] <= t + 0.02); if (pts.length) ghost.push({ ...s, points: pts.length === 1 && s.tool !== 'pen' ? [pts[0], pts[0]] : pts }); }
    }
    layer.setGhost(ghost);
  }

  // context tab
  async function renderContext() {
    ctxBody.replaceChildren(h('div.section', h('h3', 'Loading…')));
    const sections = [];
    const notesTa = h('textarea.text', { value: version.notes || '', rows: 4, placeholder: 'What changed in this version? Which notes does it address?' });
    sections.push(h('div.section', h('h3', `${version.label} notes`, version.postedByAgent ? h('span.pill.agent', 'agent') : null, h('span.spacer'), btn('Save', { cls: 'sm ghost', onClick: async () => { version = await api.updateVersion(version.id, { notes: notesTa.value }); toast('Saved', 'ok'); } })), notesTa, h('div.small.muted', { style: { marginTop: '6px' } }, `${version.originalName || ''} · ${version.width || '?'}×${version.height || '?'} · ${fmtTime(version.duration)} · ${version.source} · ${relTime(version.createdAt)}`)));
    if (!project.dir) {
      const dirIn = h('input.text', { placeholder: '/path/to/composition/folder' });
      sections.push(h('div.section', h('h3', 'Composition folder'), h('p.small.muted', 'Link the folder this video was rendered from (a Videditor composition with index.html). You then get the clip lanes, the agent is told which clips are under each note, and you can render new versions.'), dirIn, h('div', { style: { marginTop: '8px' } }, btn('Link folder', { cls: 'sm', onClick: async () => { try { project = await api.updateProject(project.id, { dir: dirIn.value.trim() }); composition = await api.composition(project.id); toast('Linked', 'ok'); renderContext(); renderLanes(); } catch (e) { toast(e.message, 'err'); } } }))));
    } else {
      const comp = composition;
      sections.push(h('div.section', h('h3', 'Composition', h('span.spacer'), btn('Open in Studio', { cls: 'sm', icon: 'spark', onClick: () => navigate(`#/studio/${project.id}`) }), btn('Unlink', { cls: 'sm ghost', onClick: async () => { project = await api.updateProject(project.id, { dir: null }); composition = null; renderContext(); renderLanes(); } })),
        h('dl.kv', h('dt', 'Folder'), h('dd.mono.small', project.dir), comp ? [h('dt', 'Composition'), h('dd', `${comp.id || '?'} · ${comp.width || '?'}×${comp.height || '?'} · ${fmtTime(comp.duration)} · ${comp.fps || 30} fps · ${comp.clips.length} clips`)] : [h('dt', 'Composition'), h('dd.muted', 'index.html not parsed')])));
      if (comp?.clips?.length) {
        const list = h('div.cliplist');
        for (const c of comp.clips.filter((c) => c.start !== null)) list.append(h('div.c', { 'data-start': c.start, 'data-end': c.duration === null ? 1e9 : c.start + c.duration, title: c.file, on: { click: () => player.seek(c.start + 0.01) } }, h('span.t', `${fmtTime(c.start)}${c.duration !== null ? `–${fmtTime(c.start + c.duration)}` : ''}`), h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, c.id ? `#${c.id}` : c.compositionId ? `⟨${c.compositionId}⟩` : `<${c.tag}>`, c.text ? h('span.muted', ` “${c.text}”`) : c.src ? h('span.muted', ` ${c.src}`) : null), c.track !== null && c.track !== undefined ? h('span.muted', `T${c.track}`) : null));
        sections.push(h('div.section', h('h3', 'Clips (click to seek)'), list));
        ctxBody._clipList = list;
      }
      const filesEl = h('div.files', h('div.muted.small', 'Loading files…'));
      sections.push(h('div.section', h('h3', 'Files'), filesEl));
      api.files(project.id).then(({ files }) => { filesEl.replaceChildren(...files.slice(0, 200).map((f) => h('div.f', { class: `f ${f.text ? '' : 'dim'}`, on: { click: async () => { if (!f.text) return; try { const txt = await api.file(project.id, f.path); modal(f.path, h('pre', txt), { wide: true }); } catch (e) { toast(e.message, 'err'); } } } }, h('span', f.path), h('span.muted', fmtSize(f.size))))); if (!files.length) filesEl.replaceChildren(h('div.muted.small', 'No files found.')); }).catch((e) => filesEl.replaceChildren(h('div.muted.small', e.message)));
    }
    sections.push(h('div.section', h('h3', 'For your agent'), h('p.small.muted', 'Copy the brief, or connect the MCP server so the agent can read notes and post versions itself:'), h('pre.log', `claude mcp add videditor -- node ${location.pathname.replace(/\/$/, '')}/videditor/mcp.mjs`.replace('//', '/')), h('div', { style: { display: 'flex', gap: '6px', marginTop: '8px' } }, btn('Copy prompt', { icon: 'copy', cls: 'sm', onClick: copyPrompt }), btn('Copy project id', { cls: 'sm ghost', onClick: async () => { await copyText(project.id); toast('Copied', 'ok'); } }))));
    ctxBody.replaceChildren(...sections);
  }
  const fmtSize = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n > 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);

  // versions tab
  function renderVersions() {
    const upload = h('input', { type: 'file', accept: 'video/*', style: { display: 'none' } });
    const drop = h('div.drop', { on: { click: () => upload.click(), dragover: (e) => { e.preventDefault(); drop.classList.add('over'); }, dragleave: () => drop.classList.remove('over'), drop: (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) doUpload(e.dataTransfer.files[0]); } } }, svg('upload'), ` Upload v${project.versions.length + 1} (drop a video here)`);
    upload.addEventListener('change', () => { if (upload.files[0]) doUpload(upload.files[0]); });
    async function doUpload(file) { const notes = prompt('Notes for this version (what changed?)', '') ?? ''; const prog = h('div.small.muted', 'Uploading 0%'); drop.replaceWith(prog); try { const v = await api.upload(project.id, file, notes, (p) => { prog.textContent = `Uploading ${Math.round(p * 100)}%`; }); toast(`${v.label} added`, 'ok'); navigate(`#/p/${project.id}?v=${v.id}`); } catch (e) { toast(e.message, 'err'); renderVersions(); } }
    const log = h('pre.log.hidden');
    const renderBtn = project.dir ? btn(`Render v${project.versions.length + 1} from the composition`, { icon: 'render', cls: 'sm', onClick: async () => {
      renderBtn.disabled = true; log.classList.remove('hidden'); log.textContent = 'Starting render…\n';
      try {
        const { jobId } = await api.render(project.id, {});
        const es = new EventSource(`/api/jobs/${jobId}/events`);
        es.onmessage = (e) => { const d = JSON.parse(e.data); if (d.type === 'progress') { const l = log.textContent.split('\n'); if (/^frame /.test(l[l.length - 2] || '')) l.splice(l.length - 2, 1); log.textContent = l.join('\n').replace(/\n?$/, '\n') + `frame ${d.frame}/${d.frames}\n`; } else log.textContent += (d.text || d.message || '') + '\n'; log.scrollTop = log.scrollHeight; };
        es.addEventListener('done', async (e) => { es.close(); const d = JSON.parse(e.data); renderBtn.disabled = false; if (d.ok) { toast('Rendered', 'ok'); navigate(`#/p/${project.id}?v=${d.versionId}`); } else toast('Render failed, see log', 'err'); });
      } catch (e) { toast(e.message, 'err'); renderBtn.disabled = false; }
    } }) : null;
    verBody.replaceChildren(
      h('div.section', drop, upload, renderBtn ? h('div', { style: { marginTop: '8px' } }, renderBtn) : h('p.hint', { style: { marginTop: '8px' } }, 'Link a composition folder in Context to render new versions from here.'), log),
      h('div.section', { style: { display: 'grid', gap: '8px' } }, [...project.versions].reverse().map((v) => h('div.version-row', { class: `version-row ${v.id === version.id ? 'current' : ''}`, on: { click: () => navigate(`#/p/${project.id}?v=${v.id}`) } }, v.posterUrl ? h('img', { src: v.posterUrl }) : h('div.noimg'), h('div.vb', h('div.l', v.label, v.formatLabel ? h('span.pill', v.formatLabel) : null, v.postedByAgent ? h('span.pill.agent', 'agent') : null, h('span.small.muted', relTime(v.createdAt)), h('span.spacer', { style: { flex: 1 } }), v.openCount ? h('span.pill.open', `${v.openCount} open`) : h('span.small.muted', `${v.feedbackCount} notes`)), h('div.n', v.notes || h('span.muted', 'No notes'))), h('div', { style: { display: 'grid', gap: '4px' } }, btn('', { icon: 'compare', cls: 'icon sm ghost', title: 'Compare with current', onClick: (e) => { e.stopPropagation(); navigate(`#/p/${project.id}/compare?a=${v.id}&b=${version.id}`); } }), h('a.btn.icon.sm.ghost', { href: `/api/versions/${v.id}/download`, title: 'Download', on: { click: (e) => e.stopPropagation() } }, svg('download')))))),
    );
    counts.versions.textContent = project.versions.length;
  }

  // lanes from composition
  function renderLanes() {
    lanes.replaceChildren(); lanesTitle.classList.add('hidden');
    const d = player.duration || composition?.duration; if (!composition?.clips?.length || !d) return;
    const tracks = new Map();
    for (const c of composition.clips.filter((c) => c.start !== null && c.depth === 0)) { const k = c.track ?? 0; if (!tracks.has(k)) tracks.set(k, []); tracks.get(k).push(c); }
    lanesTitle.classList.remove('hidden'); lanesTitle.replaceChildren(svg('spark'), `Composition ${composition.id || ''}`, h('span.muted', `· ${tracks.size} track${tracks.size > 1 ? 's' : ''}, click a clip to seek`));
    for (const k of [...tracks.keys()].sort((a, b) => b - a)) {
      // Clips on one track that overlap in time get their own sub-row so none is hidden.
      const rows = [];
      for (const c of [...tracks.get(k)].sort((a, b) => a.start - b.start)) { const end = c.start + (c.duration ?? (d - c.start)); let row = rows.find((r) => r.end <= c.start + 1e-6); if (!row) { row = { end: 0, clips: [] }; rows.push(row); } row.end = end; row.clips.push(c); }
      for (const row of rows) {
      const lane = h('div.lane');
      for (const c of row.clips) { const dur = c.duration ?? (d - c.start); lane.append(h('div.clip', { class: `clip ${c.tag === 'video' || c.tag === 'img' ? 'video' : c.tag === 'audio' ? 'audio' : c.compositionId ? 'comp' : ''}`, 'data-start': c.start, 'data-end': c.start + dur, style: { left: `${(c.start / d) * 100}%`, width: `${Math.max(0.5, (dur / d) * 100)}%` }, title: `${c.id ? '#' + c.id : c.tag} ${fmtTime(c.start)}–${fmtTime(c.start + dur)}${c.text ? ` “${c.text}”` : ''}`, on: { click: () => player.seek(c.start + 0.01) } }, c.id ? `#${c.id}` : c.compositionId ? c.compositionId : c.tag, c.text ? ` “${c.text}”` : '')); }
      lanes.append(lane);
      }
    }
  }

  // ---------- top bar
  const verSel = h('select.text', { style: { width: 'auto' }, title: 'Version', on: { change: (e) => navigate(`#/p/${project.id}?v=${e.target.value}`) } }, project.versions.map((v) => h('option', { value: v.id, selected: v.id === version.id }, `${v.label}${v.postedByAgent ? ' · agent' : ''}`)));
  topbar([
    btn('', { icon: 'back', cls: 'ghost icon', title: 'All projects', onClick: () => navigate('#/') }),
    h('span.title', { title: 'Rename', style: { cursor: 'text' }, on: { click: async () => { const i = h('input.text', { value: project.name }); if (await modal('Rename project', i, { actions: [{ label: 'Save', cls: 'primary' }] })) { project = await api.updateProject(project.id, { name: i.value }); renderReview(root, { projectId, versionId: version.id, navigate, topbar }); } } } }, project.name),
    verSel,
    project.dir ? (liveBtn = btn('Live', { icon: 'film', title: 'Show the live composition instead of the render', onClick: () => setLive(!live) })) : null,
    project.dir ? btn('Studio', { icon: 'spark', title: 'Edit the composition and chat with the agent', onClick: () => navigate(`#/studio/${project.id}`) }) : null,
    h('span.spacer'),
    project.versions.length > 1 ? btn('Compare', { icon: 'compare', onClick: () => navigate(`#/p/${project.id}/compare?a=${project.versions[Math.max(0, project.versions.findIndex((v) => v.id === version.id) - 1)].id}&b=${version.id}`) }) : null,
    btn('Copy link', { icon: 'link', onClick: async () => { await copyText(location.href); toast('Link copied', 'ok'); } }),
    btn('Copy prompt', { icon: 'copy', cls: project.dir ? '' : 'primary', title: 'Brief for any agent with all open feedback', onClick: copyPrompt }),
    project.dir ? btn('Send to agent', { icon: 'spark', cls: 'primary', title: 'Hand all open notes on this version to the Studio agent and watch it edit', onClick: sendToAgent }) : null,
    btn('', { icon: 'trash', cls: 'ghost icon', title: 'Delete project', onClick: async () => { if (await confirmDeleteProject(api, project)) navigate('#/'); } }),
  ]);

  async function sendToAgent() {
    const open = feedback.filter((f) => !f.replyTo && f.status !== 'done');
    if (!open.length) return toast('No open notes on this version. Leave a note first (C to type, D to draw, R to talk).', 'err');
    const extra = h('textarea.text', { rows: 2, placeholder: 'Anything to add for the agent? (optional)' });
    const ok = await modal(`Send ${open.length} open note${open.length > 1 ? 's' : ''} to the agent?`, h('div', h('p.muted', `The agent (in Studio) gets every open note on ${version.label} with its timestamps, transcripts, drawings and frames, edits the composition, and reports back. You then press Render for the next version.`), extra), { actions: [{ label: 'Send and open Studio', cls: 'primary', icon: 'spark', value: true }] });
    if (!ok) return;
    try { await api.agent(project.id, extra.value.trim(), { author: getAuthor(), fromFeedback: version.id }); toast('Sent. The agent is working…', 'ok'); navigate(`#/studio/${project.id}`); }
    catch (e) { toast(e.message, 'err'); }
  }
  async function copyPrompt() {
    try { const text = await api.prompt(project.id, version.id); await copyText(text); toast('Prompt copied to clipboard', 'ok'); modal('Agent brief (copied)', h('div', h('p.small.muted', 'Paste this into Claude Code, Cursor or Codex. If the MCP server is connected the agent can also pull it with get_prompt.'), h('pre', text)), { wide: true, actions: [{ label: 'Copy again', icon: 'copy', onClick: async () => { await copyText(text); toast('Copied', 'ok'); return false; } }] }); }
    catch (e) { toast(e.message, 'err'); }
  }

  // ---------- player updates
  onPlayer(() => {
    const t = player.time, d = player.duration;
    timeEl.innerHTML = `<b>${fmtTime(t, { frames: true, fps })}</b> / ${fmtTime(d, { frames: true, fps })}`;
    playBtn.replaceChildren(svg(player.paused ? 'play' : 'pause'));
    if (d) { played.style.width = `${(t / d) * 100}%`; head.style.left = `${(t / d) * 100}%`; }
    updateGhost();
    for (const el of [...lanes.querySelectorAll('.clip'), ...(ctxBody._clipList?.querySelectorAll('.c') || [])]) el.classList.toggle('on', t >= Number(el.dataset.start) && t < Number(el.dataset.end));
  });
  video.addEventListener('loadedmetadata', () => { renderMarkers(); renderLanes(); fitFrame(); });

  // ---------- keyboard
  const key = (e) => {
    if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey) return;
    const k = e.key.toLowerCase();
    if (e.code === 'Space' || k === 'k') { e.preventDefault(); player.toggle(); }
    else if (k === 'arrowleft') { e.preventDefault(); e.shiftKey ? player.seek(player.time - 1) : player.step(-1); }
    else if (k === 'arrowright') { e.preventDefault(); e.shiftKey ? player.seek(player.time + 1) : player.step(1); }
    else if (k === 'j') player.seek(player.time - 5); else if (k === 'l') player.seek(player.time + 5);
    else if (k === 'c') { e.preventDefault(); if (S.anchor === null) S.anchor = player.time; updateComposer(); ta.focus(); }
    else if (k === 'd') setTool(S.tool === 'pen' ? null : 'pen'); else if (k === 'a') setTool('arrow'); else if (k === 'r') toggleRecord();
    else if (k === 'i') { S.anchor = player.time; S.anchorEnd = null; updateComposer(); } else if (k === 'o') rangeBtn.click();
    else if (k === 'm') muteBtn.click(); else if (k === 'z') layer.undo();
    else if (k === 'escape') { setTool(null); selectedId = null; renderFeedback(); updateGhost(); }
    else if (k === 'home') player.seek(0); else if (k === 'end') player.seek(player.duration - 0.05);
  };
  document.addEventListener('keydown', key);

  // ---------- polling for agent activity
  let lastSeen = feedback.reduce((m, f) => (f.createdAt > m ? f.createdAt : m), '');
  async function refreshFeedback() { feedback = await api.feedback({ versionId: version.id }); lastSeen = feedback.reduce((m, f) => (f.createdAt > m ? f.createdAt : m), lastSeen); renderFeedback(); updateGhost(); }
  const poll = setInterval(async () => {
    try {
      const fresh = await api.feedback({ versionId: version.id, since: lastSeen });
      if (fresh.length) { const agent = fresh.filter((f) => f.postedByAgent).length; await refreshFeedback(); if (agent) toast(`${agent} new repl${agent > 1 ? 'ies' : 'y'} from your agent`, 'ok'); }
      const p = await api.project(project.id);
      if (p.versions.length !== project.versions.length) { const nv = p.versions[p.versions.length - 1]; project = p; toast(`${nv.label} arrived${nv.postedByAgent ? ' from your agent' : ''}. Click to open.`, 'ok'); document.querySelector('.toast:last-child')?.addEventListener('click', () => navigate(`#/p/${project.id}?v=${nv.id}`)); if (tab === 'versions') renderVersions(); }
    } catch {}
  }, 4000);

  root._cleanup = () => { clearInterval(poll); document.removeEventListener('keydown', key); player.pause(); stage?.destroy(); if (recorder?.recording) recorder.stop(); };
  root.replaceChildren(h('div.review', h('div.stage', viewport, controls, timeline, composer), panel));
  renderFeedback(); updateComposer(); counts.versions.textContent = project.versions.length;
  fitFrame();
  const qs = new URLSearchParams(location.hash.split('?')[1] || ''); const sel = qs.get('fb'); if (sel) setTimeout(() => select(sel), 300); if (qs.get('live') === '1' && project.dir) setLive(true);
}

function renderNoVersions(root, project, { navigate, topbar }) {
  topbar([btn('', { icon: 'back', cls: 'ghost icon', onClick: () => navigate('#/') }), h('span.title', project.name)]);
  const upload = h('input', { type: 'file', accept: 'video/*', style: { display: 'none' } });
  upload.addEventListener('change', async () => { if (!upload.files[0]) return; toast('Uploading…'); try { const v = await api.upload(project.id, upload.files[0], 'First version'); navigate(`#/p/${project.id}?v=${v.id}`); } catch (e) { toast(e.message, 'err'); } });
  root.replaceChildren(h('div.empty', h('h2', 'No render yet'), h('p', 'Upload the first video to start reviewing.'), btn('Upload v1', { icon: 'upload', cls: 'primary', onClick: () => upload.click() }), upload,
    project.dir ? h('div', { style: { marginTop: '16px' } }, btn('Open in Studio and render', { icon: 'spark', onClick: () => navigate(`#/studio/${project.id}`) })) : null));
}
function zoom(url, title) { modal(title, h('img.zoom', { src: url }), { wide: true }); }
function colorToRgb(hex) { const n = parseInt(hex.slice(1), 16); return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`; }
