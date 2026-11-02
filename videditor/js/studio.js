// Studio: chat with the agent on the left, live composition preview in the
// middle, timeline below, layers/files on the right. The preview is the real
// composition running in an iframe with the seekable runtime.
import { api } from './api.js';
import { h, btn, svg, modal, toast, fmtTime, relTime, avatar, getAuthor, ensureAuthor, copyText } from './ui.js';
import { Stage } from './stage.js';

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
  const src = () => `/project-files/${project.id}/index.html?runtime=1&_=${Date.now()}`;
  const timeEl = h('span.time');
  const playBtn = btn('', { icon: 'play', cls: 'icon', title: 'Play / pause (space)', onClick: () => stage.toggle() });
  const renderBtn = btn('Render', { icon: 'render', cls: 'primary', title: 'Render to MP4 and add it as a version for review', onClick: renderNow });
  const transport = h('div.transport', playBtn, btn('', { icon: 'stepBack', cls: 'icon ghost', title: 'Back one frame (←)', onClick: () => step(-1) }), btn('', { icon: 'stepFwd', cls: 'icon ghost', title: 'Forward one frame (→)', onClick: () => step(1) }), timeEl, h('span.spacer'), h('span.hint', 'Click an element in the preview to select it · drag clips on the timeline'), btn('Reload', { cls: 'ghost sm', title: 'Reload the composition from disk', onClick: () => reloadComp() }), renderBtn);
  const step = (n) => { stage.pause(); stage.seek(Math.max(0, Math.min(stage.duration, stage.time + n / stage.fps))); };
  function updateTime() { timeEl.innerHTML = `<b>${fmtTime(stage.time, { frames: true, fps: stage.fps })}</b> / ${fmtTime(stage.duration, { frames: true, fps: stage.fps })}`; playBtn.replaceChildren(svg(stage.playing ? 'pause' : 'play')); drawPlayhead(); for (const el of tracksEl.querySelectorAll('.tclip')) el.classList.toggle('on', stage.time >= Number(el.dataset.start) && stage.time < Number(el.dataset.end)); }
  stage.on('time', updateTime); stage.on('play', updateTime); stage.on('pause', updateTime);
  stage.on('ready', () => { overlayMsg.remove(); updateTime(); renderTimeline(); renderLayers(); });
  stage.on('select', (m) => selectClip(m.id, { fromStage: true }));
  async function reloadComp() { composition = await api.composition(project.id).catch(() => composition); await stage.reload(true); renderTimeline(); renderLayers(); }

  // ---------- timeline
  const ruler = h('div.ruler'); const tracksEl = h('div.tracks'); const phead = h('div.phead');
  const tl = h('div.tl', ruler, tracksEl, phead, h('span.hint-tl', 'drag = move · drag edge = trim'));
  const PAD = 70;
  const pxPerSec = () => (tracksEl.clientWidth - PAD - 16) / Math.max(0.5, stage.duration || composition?.duration || 5);
  function drawPlayhead() { if (!stage.duration) return; phead.style.left = `${PAD + stage.time * pxPerSec()}px`; }
  ruler.addEventListener('pointerdown', (e) => { const seekAt = (ev) => { const r = ruler.getBoundingClientRect(); stage.pause(); stage.seek(Math.max(0, Math.min(stage.duration, (ev.clientX - r.left) / pxPerSec()))); }; seekAt(e); const mv = (ev) => seekAt(ev); const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); }; window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); });
  function renderTimeline() {
    const dur = stage.duration || composition?.duration || 5; const pps = pxPerSec();
    ruler.replaceChildren(); const stepS = dur > 30 ? 5 : dur > 12 ? 2 : dur > 6 ? 1 : 0.5;
    for (let t = 0; t <= dur + 1e-6; t += stepS) ruler.append(h('div.tick', { style: { left: `${t * pps}px` } }, t % 1 === 0 ? `${t}s` : ''));
    const clips = (composition?.clips || []).filter((c) => c.start !== null && c.depth === 0);
    const tracks = new Map(); for (const c of clips) { const k = c.track ?? 0; if (!tracks.has(k)) tracks.set(k, []); tracks.get(k).push(c); }
    const keys = [...tracks.keys()].sort((a, b) => b - a); if (!keys.length) keys.push(0);
    tracksEl.replaceChildren(...keys.map((k) => {
      const area = h('div.tarea');
      for (const c of tracks.get(k) || []) {
        const d = c.duration ?? (dur - c.start);
        const el = h('div.tclip', { class: `tclip ${c.tag === 'video' || c.tag === 'img' ? 'media' : c.tag === 'audio' ? 'audio' : ''} ${c.id && c.id === selected ? 'sel' : ''}`, 'data-id': c.id || '', 'data-start': c.start, 'data-end': c.start + d, style: { left: `${c.start * pps}px`, width: `${Math.max(14, d * pps)}px` }, title: `${c.id ? '#' + c.id : c.tag} ${fmtTime(c.start)}–${fmtTime(c.start + d)}${c.text ? ` “${c.text}”` : ''}` }, h('span.lh'), c.id ? `#${c.id}` : c.tag, c.text ? ` “${c.text}”` : '', h('span.rh'));
        attachDrag(el, c, d);
        area.append(el);
      }
      return h('div.trow', h('div.tname', `T${k}`), area);
    }));
    drawPlayhead();
  }
  function attachDrag(el, c, d) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; e.preventDefault(); e.stopPropagation();
      const mode = e.target.classList.contains('rh') ? 'end' : e.target.classList.contains('lh') ? 'start' : 'move';
      const pps = pxPerSec(); const x0 = e.clientX; const s0 = c.start, d0 = d; let moved = false;
      el.setPointerCapture(e.pointerId); el.classList.add('dragging');
      const snap = (v) => Math.round(v * stage.fps) / stage.fps;
      const mv = (ev) => {
        const dx = (ev.clientX - x0) / pps; if (Math.abs(ev.clientX - x0) > 2) moved = true;
        let s = s0, dd = d0;
        if (mode === 'move') s = Math.max(0, snap(s0 + dx)); else if (mode === 'end') dd = Math.max(1 / stage.fps, snap(d0 + dx)); else { s = Math.max(0, Math.min(s0 + d0 - 1 / stage.fps, snap(s0 + dx))); dd = s0 + d0 - s; }
        el.style.left = `${s * pps}px`; el.style.width = `${Math.max(14, dd * pps)}px`; el._live = { s, dd };
        stage.seek(mode === 'end' ? s + dd - 0.001 : s);
      };
      const up = async () => {
        el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.classList.remove('dragging');
        if (!moved) { selectClip(c.id); return; }
        if (!c.id) { toast('Give this element an id to edit it from the timeline', 'err'); renderTimeline(); return; }
        const { s, dd } = el._live || { s: s0, dd: d0 };
        try { const r = await api.updateClip(project.id, c.id, { start: s, ...(c.duration !== null || mode !== 'move' ? { duration: dd } : {}) }); composition = r.composition; await stage.reload(true); renderTimeline(); renderLayers(); selectClip(c.id); }
        catch (err) { toast(err.message, 'err'); renderTimeline(); }
      };
      el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
    });
  }

  // ---------- side panel: layers / files
  const layersEl = h('div.layers'); const filesHost = h('div');
  const inspector = h('div.inspector.hidden');
  let sideTab = 'layers';
  const sideTabs = h('div.tabs', [['layers', 'Layers'], ['files', 'Files']].map(([k, l]) => h('span.tab', { class: `tab ${k === sideTab ? 'active' : ''}`, on: { click: (e) => { sideTab = k; sideTabs.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === e.currentTarget)); sideBody.replaceChildren(...(k === 'layers' ? [inspector, layersEl] : [filesHost])); if (k === 'files') renderFiles(); } } }, l)), h('span', { style: { flex: 1 } }), project.versions.length ? h('a.tab', { href: `#/p/${project.id}` }, 'Review ↗') : null);
  const sideBody = h('div.body', inspector, layersEl);
  const side = h('div.side', sideTabs, sideBody);
  function renderLayers() {
    const clips = (composition?.clips || []).filter((c) => c.depth === 0).sort((a, b) => (b.track ?? 0) - (a.track ?? 0) || a.start - b.start);
    layersEl.replaceChildren(...(clips.length ? clips.map((c) => h('div.layer', { class: `layer ${c.id && c.id === selected ? 'sel' : ''}`, on: { click: () => { selectClip(c.id); if (c.start !== null) stage.seek(c.start + 0.01); } } }, h('span.lid', c.id ? `#${c.id}` : `<${c.tag}>`), c.text ? h('span.ltxt', `“${c.text}”`) : c.src ? h('span.ltxt', c.src) : null, h('span.lt', `${fmtTime(c.start)}${c.duration !== null ? `–${fmtTime(c.start + c.duration)}` : ''} · T${c.track ?? 0}`))) : [h('div.empty', h('p', 'No clips yet. Ask the agent to build the video, or edit index.html in Files.'))]));
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
      filesHost.replaceChildren(h('div.section', h('h3', 'Project files', h('span.spacer'), h('span.small.muted.mono', project.dir)), list, h('p.hint', { style: { marginTop: '8px' } }, 'Drop images, video or audio into the assets/ folder on disk; the agent and index.html can reference them as assets/…')));
    } catch (e) { filesHost.replaceChildren(h('div.section', h('div.muted', e.message))); }
  }
  async function openFile(p) {
    let text; try { text = await api.file(project.id, p); } catch (e) { return toast(e.message, 'err'); }
    const ta2 = h('textarea.text', { value: text, spellcheck: false, style: { minHeight: '60vh', fontFamily: 'var(--mono)', fontSize: '12px' } });
    ta2.addEventListener('keydown', (e) => { if (e.key === 'Tab') { e.preventDefault(); const s = ta2.selectionStart; ta2.setRangeText('  ', s, ta2.selectionEnd, 'end'); } });
    await modal(p, ta2, { wide: true, actions: [{ label: 'Save', cls: 'primary', icon: 'check', onClick: async () => { try { const r = await api.saveFile(project.id, p, ta2.value); if (r.composition) composition = r.composition; toast('Saved', 'ok'); await stage.reload(true); renderTimeline(); renderLayers(); return false; } catch (e) { toast(e.message, 'err'); return false; } } }] });
  }

  function selectClip(id, { fromStage = false } = {}) {
    selected = id || null;
    if (!fromStage) stage.select(selected);
    tracksEl.querySelectorAll('.tclip').forEach((el) => el.classList.toggle('sel', !!selected && el.dataset.id === selected));
    layersEl.querySelectorAll('.layer').forEach((el, i) => el.classList.toggle('sel', !!selected && el.querySelector('.lid')?.textContent === `#${selected}`));
    renderInspector();
    if (selected) ctxChip(selected);
  }

  // ---------- chat
  const msgs = h('div.msgs');
  const ta = h('textarea.text', { placeholder: 'Tell the agent what to make or change… (⌘/Ctrl+Enter to send)' });
  const ctx = h('span.ctx.hidden');
  const sendBtn = btn('Send', { cls: 'primary sm', icon: 'spark', onClick: send });
  const stopHint = h('span.hint.hidden', 'Working… this can take a minute.');
  const compose = h('div.compose', ctx, ta, h('div.row', btn('', { icon: 'more', cls: 'ghost icon sm', title: 'New conversation (forget context)', onClick: async () => { if (await modal('Start a new conversation?', h('p.muted', 'The agent forgets this chat. The composition files are kept.'), { actions: [{ label: 'New conversation', cls: 'primary', value: true }] })) { await api.agentReset(project.id); project.chat = []; renderChat([]); } } }), stopHint, h('span.spacer'), sendBtn));
  const chat = h('div.chat', msgs, compose);
  ta.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send(); e.stopPropagation(); });
  function ctxChip(id) { ctx.classList.remove('hidden'); ctx.replaceChildren('About ', h('code', `#${id}`), btn('', { icon: 'close', cls: 'ghost icon sm', title: 'Clear', onClick: () => { ctx.classList.add('hidden'); ctx._id = null; } })); ctx._id = id; }
  function msgEl(m) {
    const el = h('div.msg', { class: `msg ${m.role}` }, h('div.who', avatar(m.role === 'agent' ? 'Agent' : (m.author || getAuthor() || 'You'), m.role === 'agent'), m.role === 'agent' ? 'Agent' : (m.author || getAuthor() || 'You'), h('span.muted', relTime(m.at))));
    if (m.tools?.length) el.append(h('div.tools', m.tools.map((t) => h('span.t', { title: `${t.name} ${t.detail || ''}` }, h('b', t.name), t.detail ? ` ${t.detail}` : ''))));
    if (m.text) el.append(h('div.bubble', m.text));
    if (m.error) el.append(h('div.bubble.err', m.error));
    if (m.live) el.append(h('div.thinking', h('i'), h('i'), h('i'), ' ', m.status || 'thinking'));
    return el;
  }
  function renderChat(list) {
    msgs.replaceChildren(...(list.length ? list.map(msgEl) : [h('div.empty-chat', h('p', 'Describe the video you want. The agent (Claude Code, running on this computer) writes the composition, you watch it in the preview and adjust on the timeline.'), ['Make a 10-second product teaser: dark background, bold title, three feature lines, call to action at the end.', 'Change the title to "Hello world" and make it enter at 1s.', 'Add a warm gradient background and a logo sting at the start.'].map((s) => h('button.btn.ghost.sm.sug', { on: { click: () => { ta.value = s; ta.focus(); } } }, s)))]));
    msgs.scrollTop = msgs.scrollHeight;
  }
  async function send() {
    const text = ta.value.trim(); if (!text || agentJob) return;
    if (!caps.claude) { toast('Claude Code was not found on this computer', 'err'); return msgs.append(h('div.msg.agent', h('div.bubble.err', 'Claude Code is not installed or not on PATH. Install it with: npm install -g @anthropic-ai/claude-code  then restart the Videditor server.'))); }
    const author = await ensureAuthor();
    const message = ctx._id ? `About the clip #${ctx._id}: ${text}` : text;
    ta.value = ''; ctx.classList.add('hidden'); ctx._id = null;
    project.chat = project.chat || []; project.chat.push({ role: 'user', text: message, at: new Date().toISOString(), author });
    const live = { role: 'agent', text: '', tools: [], at: new Date().toISOString(), live: true, status: 'starting Claude Code' };
    renderChat([...project.chat, live]);
    sendBtn.disabled = true; stopHint.classList.remove('hidden');
    try {
      const { jobId } = await api.agent(project.id, message, { author });
      agentJob = jobId;
      const es = new EventSource(`/api/jobs/${jobId}/events`);
      const redraw = () => { renderChat([...project.chat, live]); };
      es.onmessage = (e) => {
        const ev = JSON.parse(e.data);
        if (ev.type === 'text') { live.text += (live.text ? '\n\n' : '') + ev.text; live.status = 'thinking'; }
        else if (ev.type === 'tool') { live.tools.push({ name: ev.name, detail: ev.detail }); live.status = `${ev.name} ${ev.detail || ''}`.trim(); if (/^(Edit|Write|MultiEdit)$/.test(ev.name) && /\.(html|css|js)$/.test(ev.detail || '')) reloadComp(); }
        else if (ev.type === 'status') live.status = ev.message;
        else if (ev.type === 'error') live.error = ev.message;
        redraw();
      };
      es.addEventListener('done', async (e) => {
        es.close(); agentJob = null; sendBtn.disabled = false; stopHint.classList.add('hidden');
        const d = JSON.parse(e.data); live.live = false; if (!live.text && d.result) live.text = d.result;
        project = await api.project(project.id); renderChat(project.chat || [...project.chat, live]);
        await reloadComp(); toast(d.ok ? 'Agent finished' : 'Agent stopped with an error', d.ok ? 'ok' : 'err');
      });
      es.onerror = () => { es.close(); agentJob = null; sendBtn.disabled = false; stopHint.classList.add('hidden'); live.live = false; redraw(); };
    } catch (e) { agentJob = null; sendBtn.disabled = false; stopHint.classList.add('hidden'); live.live = false; live.error = e.message; renderChat([...project.chat, live]); }
  }

  // ---------- render
  async function renderNow() {
    if (!caps.playwright) return modal('Renderer not set up', h('div', h('p', 'Rendering uses your installed Chrome through Playwright. Install it once:'), h('pre.log', 'cd videditor && npm install'), h('p.muted', 'Then restart the server.')));
    const quality = h('select.text', { style: { width: 'auto' } }, [['draft', 'Draft (fast)'], ['looks', 'Normal'], ['high', 'High (PNG frames, slow)']].map(([v, l]) => h('option', { value: v, selected: v === 'looks' }, l)));
    const notes = h('textarea.text', { rows: 2, placeholder: 'What changed in this version?' });
    const ok = await modal(`Render v${project.versions.length + 1}`, h('div', h('label.field', h('span', 'Quality'), quality), h('label.field', h('span', 'Version notes'), notes)), { actions: [{ label: 'Render', cls: 'primary', icon: 'render', value: true }] });
    if (!ok) return;
    const bar = h('div.progress', h('i')); const log = h('pre.log', { style: { maxHeight: '40vh' } }); const status = h('div.small.muted', 'Starting…');
    const bg = h('div.modal-bg', h('div.modal', h('h2', `Rendering v${project.versions.length + 1}`), bar, status, log));
    document.body.append(bg);
    try {
      const { jobId } = await api.render(project.id, { quality: quality.value, notes: notes.value.trim() });
      const es = new EventSource(`/api/jobs/${jobId}/events`);
      es.onmessage = (e) => { const d = JSON.parse(e.data); if (d.type === 'progress') { bar.firstChild.style.width = `${(d.frame / d.frames) * 100}%`; status.textContent = `Frame ${d.frame} / ${d.frames} · ${d.elapsed.toFixed(0)}s`; } else { log.textContent += (d.text || '') + '\n'; log.scrollTop = log.scrollHeight; } };
      es.addEventListener('done', async (e) => { es.close(); const d = JSON.parse(e.data); bg.remove(); if (d.ok) { project = await api.project(project.id); toast('Rendered', 'ok'); if (await modal('Render finished', h('p', `v${project.versions.length} is ready. Open it in Review to leave notes, or keep editing.`), { actions: [{ label: 'Keep editing', cls: 'ghost', value: 'stay' }, { label: 'Open in Review', cls: 'primary', value: 'review' }] }) === 'review') navigate(`#/p/${project.id}?v=${d.versionId}`); } else modal('Render failed', h('pre.log', log.textContent)); });
      es.onerror = () => { es.close(); bg.remove(); toast('Lost connection to the render', 'err'); };
    } catch (e) { bg.remove(); toast(e.message, 'err'); }
  }

  // ---------- top bar + layout
  topbar([
    btn('', { icon: 'back', cls: 'ghost icon', title: 'All videos', onClick: () => navigate('#/') }),
    h('span.title', project.name), h('span.pill', svg('spark'), 'Studio'),
    h('span.spacer'),
    project.versions.length ? btn('Review', { icon: 'chat', title: 'Review the latest render', onClick: () => navigate(`#/p/${project.id}`) }) : null,
    btn('Copy folder path', { icon: 'copy', cls: 'ghost', onClick: async () => { await copyText(project.dir); toast('Copied', 'ok'); } }),
  ]);
  root.replaceChildren(h('div.studio', chat, h('div.center', stageWrap, transport, tl), side));
  renderChat(project.chat || []);
  const key = (e) => { if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey) return; if (e.code === 'Space') { e.preventDefault(); stage.toggle(); } else if (e.key === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? stage.seek(Math.max(0, stage.time - 1)) : step(-1); } else if (e.key === 'ArrowRight') { e.preventDefault(); e.shiftKey ? stage.seek(Math.min(stage.duration, stage.time + 1)) : step(1); } else if (e.key === 'Home') stage.seek(0); else if (e.key === 'Escape') selectClip(null); };
  document.addEventListener('keydown', key);
  new ResizeObserver(() => { renderTimeline(); }).observe(tracksEl);
  await stage.load(src());
  if (!stage.info) overlayMsg.textContent = 'The composition did not load. Check index.html in Files.';
  // Resume a running agent job (page reload mid-run) or start with a prompt from the URL.
  const chatState = await api.chat(project.id).catch(() => null);
  if (chatState?.running) { agentJob = chatState.running; sendBtn.disabled = true; stopHint.classList.remove('hidden'); const es = new EventSource(`/api/jobs/${chatState.running}/events`); es.addEventListener('done', async () => { es.close(); agentJob = null; sendBtn.disabled = false; stopHint.classList.add('hidden'); project = await api.project(project.id); renderChat(project.chat); reloadComp(); }); }
  if (prompt && !chatState?.running) { ta.value = prompt; history.replaceState(null, '', `#/studio/${project.id}`); setTimeout(send, 400); }
  root._cleanup = () => { document.removeEventListener('keydown', key); stage.destroy(); };
}
