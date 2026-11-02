// Studio: chat with the agent on the left, live composition preview in the
// middle, timeline below, layers/files on the right. The preview is the real
// composition running in an iframe with the seekable runtime.
import { api } from './api.js';
import { h, btn, svg, modal, toast, fmtTime, relTime, avatar, getAuthor, ensureAuthor, copyText, confirmDeleteProject } from './ui.js';
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
  function updateTime() { timeEl.innerHTML = `<b>${fmtTime(stage.time, { frames: true, fps: stage.fps })}</b> / ${fmtTime(stage.duration, { frames: true, fps: stage.fps })}`; playBtn.replaceChildren(svg(stage.playing ? 'pause' : 'play')); drawPlayhead(); for (const el of tracksEl.querySelectorAll('.tclip')) el.classList.toggle('on', stage.time >= Number(el.dataset.start) && stage.time < Number(el.dataset.end)); if (sideTab === 'layers') renderLayers(false); }
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
    if (dragState) return;
    const dur = stage.duration || composition?.duration || 5; const pps = pxPerSec();
    ruler.replaceChildren(); const stepS = dur > 30 ? 5 : dur > 12 ? 2 : dur > 6 ? 1 : 0.5;
    for (let t = 0; t <= dur + 1e-6; t += stepS) ruler.append(h('div.tick', { style: { left: `${t * pps}px` } }, t % 1 === 0 ? `${t}s` : ''));
    if (beatGrid) for (const bt of beatGrid.beats) { if (bt > dur) break; ruler.append(h('div.beat', { style: { left: `${bt * pps}px` }, title: `beat ${fmtTime(bt)} · ${beatGrid.bpm} BPM` })); }
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
  const layersEl = h('div.layers'); const filesHost = h('div'); const assetsHost = h('div'); const brandHost = h('div');
  const inspector = h('div.inspector.hidden');
  let sideTab = 'layers';
  const hosts = { layers: () => [inspector, layersEl], files: () => [filesHost], assets: () => [assetsHost], brand: () => [brandHost] };
  const sideTabs = h('div.tabs', [['layers', 'Layers'], ['assets', 'Assets'], ['files', 'Files'], ['brand', 'Brand']].map(([k, l]) => h('span.tab', { class: `tab ${k === sideTab ? 'active' : ''}`, 'data-tab': k, on: { click: (e) => { sideTab = k; sideTabs.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === e.currentTarget)); sideBody.replaceChildren(...hosts[k]()); if (k === 'files') renderFiles(); if (k === 'assets') renderAssets(); if (k === 'brand') renderBrand(); } } }, l)), h('span', { style: { flex: 1 } }), project.versions.length ? h('a.tab', { href: `#/p/${project.id}` }, 'Review ↗') : null);
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
    const key = on.map((c) => c.id || c.tag).join('|') + '#' + selected + '#' + all.length;
    if (!force && key === layersKey) return; layersKey = key;
    const row = (c, dim) => h('div.layer', { class: `layer ${c.id && c.id === selected ? 'sel' : ''} ${dim ? 'dim' : ''}`, title: `${c.id ? '#' + c.id : c.tag} · ${fmtTime(c.start)}${c.duration !== null ? `–${fmtTime(c.start + c.duration)}` : ''} · track ${c.track ?? 0}`, on: { click: () => { selectClip(c.id); if (dim && c.start !== null) stage.seek(c.start + 0.01); } } },
      h('span.lz', c.tag === 'audio' ? '♪' : (c.track ?? 0)), h('span.lid', c.id ? `#${c.id}` : `<${c.tag}>`), c.text ? h('span.ltxt', `“${c.text}”`) : c.src ? h('span.ltxt', c.src.split('/').pop()) : null, dim ? h('span.lt', fmtTime(c.start)) : null);
    const visible = on.filter((c) => c.tag !== 'audio'), audio = on.filter((c) => c.tag === 'audio');
    layersEl.replaceChildren(
      h('div.lhead', `On screen at ${fmtTime(t)}`, h('span.muted', ' · front to back')),
      ...(visible.length ? visible.map((c) => row(c, false)) : [h('div.small.muted', { style: { padding: '4px 8px' } }, all.length ? 'Nothing visible at this moment.' : 'No clips yet. Ask the agent to build the video, or edit index.html in Files.')]),
      audio.length ? h('div.lhead', 'Playing') : null, ...audio.map((c) => row(c, false)),
      off.length ? h('details.loff', { open: !visible.length }, h('summary', `Not on screen now (${off.length})`), ...off.map((c) => row(c, true))) : null,
    );
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
      const meta = a ? [a.duration ? fmtTime(a.duration) : null, a.width ? `${a.width}×${a.height}` : null, a.scenes ? `${a.scenes} cuts` : null, beat ? `${beat.bpm} BPM` : (a.audio ? 'no clear beat' : null)].filter(Boolean).join(' · ') : (it.analyzed ? '' : 'analyzing…');
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
  const ta = h('textarea.text', { placeholder: 'Tell the agent what to make or change… (⌘/Ctrl+Enter to send)' });
  const ctx = h('span.ctx.hidden');
  const sendBtn = btn('Send', { cls: 'primary sm', icon: 'spark', onClick: send });
  const stopBtn = btn('Stop', { cls: 'sm danger hidden', icon: 'stop', title: 'Stop the agent', onClick: async () => { try { await api.agentCancel(project.id); toast('Stopping…'); } catch (e) { toast(e.message, 'err'); } } });
  const stopHint = h('span.hint.hidden', 'Working… this can take a minute.');
  const setBusy = (on) => { sendBtn.disabled = on; stopHint.classList.toggle('hidden', !on); stopBtn.classList.toggle('hidden', !on); };
  const agentSel = h('select.text', { style: { width: 'auto', padding: '4px 6px', fontSize: '12px' }, title: 'Which coding agent edits the composition (runs on this computer, on your own account)', on: { change: async () => { try { project = await api.updateProject(project.id, { agent: agentSel.value }); toast(`Using ${caps.agents?.[agentSel.value]?.label || agentSel.value}`, 'ok'); } catch (e) { toast(e.message, 'err'); } } } },
    Object.entries(caps.agents || { claude: { label: 'Claude Code', available: caps.claude } }).map(([k, v]) => h('option', { value: k, selected: (project.agent || 'claude') === k }, `${v.label}${v.available ? '' : ' (not installed)'}`)));
  const compose = h('div.compose', ctx, ta, h('div.row', agentSel, stopBtn, btn('', { icon: 'more', cls: 'ghost icon sm', title: 'New conversation (forget context)', onClick: async () => { if (await modal('Start a new conversation?', h('p.muted', 'The agent forgets this chat. The composition files are kept.'), { actions: [{ label: 'New conversation', cls: 'primary', value: true }] })) { await api.agentReset(project.id); project.chat = []; renderChat([]); } } }), stopHint, h('span.spacer'), sendBtn));
  const chat = h('div.chat', msgs, compose);
  ta.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send(); e.stopPropagation(); });
  function ctxChip(id) { ctx.classList.remove('hidden'); ctx.replaceChildren('About ', h('code', `#${id}`), btn('', { icon: 'close', cls: 'ghost icon sm', title: 'Clear', onClick: () => { ctx.classList.add('hidden'); ctx._id = null; } })); ctx._id = id; }
  function msgEl(m) {
    const el = h('div.msg', { class: `msg ${m.role}` }, h('div.who', avatar(m.role === 'agent' ? 'Agent' : (m.author || getAuthor() || 'You'), m.role === 'agent'), m.role === 'agent' ? 'Agent' : (m.author || getAuthor() || 'You'), h('span.muted', relTime(m.at))));
    if (m.tools?.length) el.append(h('div.tools', m.tools.map((t) => h('span.t', { title: `${t.name} ${t.detail || ''}` }, h('b', t.name), t.detail ? ` ${t.detail}` : ''))));
    if (m.text) el.append(h('div.bubble', m.text));
    if (m.error) el.append(h('div.bubble.err', { style: { fontFamily: 'var(--mono)', fontSize: '12px' } }, m.error, h('div', { style: { marginTop: '6px', display: 'flex', gap: '4px', flexWrap: 'wrap' } }, btn('Copy error', { cls: 'sm ghost', icon: 'copy', onClick: async () => { await copyText(m.error); toast('Copied', 'ok'); } }), btn('Run diagnostics', { cls: 'sm ghost', onClick: runDiagnostics }))));
    if (m.live) el.append(h('div.thinking', h('i'), h('i'), h('i'), ' ', m.status || 'thinking'));
    return el;
  }
  function renderChat(list) {
    msgs.replaceChildren(...(list.length ? list.map(msgEl) : [h('div.empty-chat', h('p', 'Describe the video you want. The agent (Claude Code, running on this computer) writes the composition, you watch it in the preview and adjust on the timeline.'), ['Make a 10-second product teaser: dark background, bold title, three feature lines, call to action at the end.', 'Change the title to "Hello world" and make it enter at 1s.', 'Add a warm gradient background and a logo sting at the start.'].map((s) => h('button.btn.ghost.sm.sug', { on: { click: () => { ta.value = s; ta.focus(); } } }, s)))]));
    msgs.scrollTop = msgs.scrollHeight;
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
    if (!cap.available) { toast(`${cap.label} was not found on this computer`, 'err'); return msgs.append(h('div.msg.agent', h('div.bubble.err', `${cap.label} is not installed or not on PATH. Install it with: ${cap.install}   sign in once, then restart the Videditor server.`))); }
    const author = await ensureAuthor();
    const message = ctx._id ? `About the clip #${ctx._id}: ${text}` : text;
    ta.value = ''; ctx.classList.add('hidden'); ctx._id = null;
    project.chat = project.chat || []; project.chat.push({ role: 'user', text: message, at: new Date().toISOString(), author });
    const live = { role: 'agent', text: '', tools: [], at: new Date().toISOString(), live: true, status: 'starting the agent' };
    renderChat([...project.chat, live]);
    setBusy(true);
    try {
      const { jobId } = await api.agent(project.id, message, { author, agent: kind });
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
        es.close(); agentJob = null; setBusy(false);
        const d = JSON.parse(e.data); live.live = false; if (!live.text && d.result) live.text = d.result;
        project = await api.project(project.id); if (!Array.isArray(project.chat)) project.chat = []; renderChat(project.chat.length ? project.chat : [...project.chat, live]);
        await reloadComp(); toast(d.ok ? 'Agent finished' : 'Agent stopped with an error', d.ok ? 'ok' : 'err');
      });
      es.onerror = () => { es.close(); agentJob = null; setBusy(false); live.live = false; redraw(); };
    } catch (e) { agentJob = null; setBusy(false); live.live = false; live.error = e.message; renderChat([...project.chat, live]); }
  }

  // ---------- render
  async function renderNow() {
    if (!caps.playwright) return modal('Renderer not set up', h('div', h('p', 'Rendering uses your installed Chrome through Playwright. Install it once:'), h('pre.log', 'cd videditor && npm install'), h('p.muted', 'Then restart the server.')));
    const quality = h('select.text', { style: { width: 'auto' } }, [['draft', 'Draft (fast)'], ['looks', 'Normal'], ['high', 'High (PNG frames, slow)']].map(([v, l]) => h('option', { value: v, selected: v === 'looks' }, l)));
    const ch = stage.info?.height || 720;
    const PRESETS = [['1', `Composition size (${stage.info?.width || '?'}×${ch})`], [String(720 / ch), '720p · Slack, quick share'], [String(1080 / ch), '1080p · LinkedIn, YouTube'], [String(2160 / ch), '4K']].filter(([v]) => Number(v) >= 0.25 && Number(v) <= 4);
    const preset = h('select.text', { style: { width: 'auto' } }, PRESETS.map(([v, l]) => h('option', { value: v, selected: v === '1' }, l)));
    const notes = h('textarea.text', { rows: 2, placeholder: 'What changed in this version?' });
    const ok = await modal(`Render v${project.versions.length + 1}`, h('div', h('label.field', h('span', 'Size'), preset), h('label.field', h('span', 'Quality'), quality), h('label.field', h('span', 'Version notes'), notes), h('p.hint', 'Different aspect ratios (vertical, square) are separate compositions: ask the agent for "a vertical version" and it will add one.')), { actions: [{ label: 'Render all sizes', cls: 'ghost', value: 'all' }, { label: 'Render', cls: 'primary', icon: 'render', value: true }] });
    if (!ok) return;
    const scales = ok === 'all' ? PRESETS.filter(([v]) => v !== '1' || PRESETS.length === 1).map(([v, l]) => ({ scale: Number(v), label: l.split(' ')[0] })) : [{ scale: Number(preset.value), label: null }];
    for (const [i, sc] of scales.entries()) await renderOne({ quality: quality.value, notes: notes.value.trim(), scale: sc.scale, label: scales.length > 1 ? sc.label : null, last: i === scales.length - 1 });
  }
  async function renderOne({ quality, notes, scale, label, last }) {
    const bar = h('div.progress', h('i')); const log = h('pre.log', { style: { maxHeight: '40vh' } }); const status = h('div.small.muted', 'Starting…');
    const bg = h('div.modal-bg', h('div.modal', h('h2', `Rendering v${project.versions.length + 1}${label ? ` · ${label}` : ''}`), bar, status, log));
    document.body.append(bg);
    await new Promise((resolve) => {
      (async () => {
        try {
          const { jobId } = await api.render(project.id, { quality, notes, scale, label });
          const es = new EventSource(`/api/jobs/${jobId}/events`);
          es.onmessage = (e) => { const d = JSON.parse(e.data); if (d.type === 'progress') { bar.firstChild.style.width = `${(d.frame / d.frames) * 100}%`; status.textContent = `Frame ${d.frame} / ${d.frames} · ${d.elapsed.toFixed(0)}s`; } else { log.textContent += (d.text || '') + '\n'; log.scrollTop = log.scrollHeight; } };
          es.addEventListener('done', async (e) => { es.close(); const d = JSON.parse(e.data); bg.remove(); if (d.ok) { project = await api.project(project.id); toast(`Rendered v${project.versions.length}`, 'ok'); if (last && await modal('Render finished', h('p', `v${project.versions.length} is ready. Open it in Review to leave notes, or keep editing.`), { actions: [{ label: 'Keep editing', cls: 'ghost', value: 'stay' }, { label: 'Open in Review', cls: 'primary', value: 'review' }] }) === 'review') navigate(`#/p/${project.id}?v=${d.versionId}`); } else await modal('Render failed', h('pre.log', log.textContent)); resolve(); });
          es.onerror = () => { es.close(); bg.remove(); toast('Lost connection to the render', 'err'); resolve(); };
        } catch (e) { bg.remove(); toast(e.message, 'err'); resolve(); }
      })();
    });
  }

  // ---------- top bar + layout
  topbar([
    btn('', { icon: 'back', cls: 'ghost icon', title: 'All videos', onClick: () => navigate('#/') }),
    h('span.title', project.name), h('span.pill', svg('spark'), 'Studio'),
    h('span.spacer'),
    project.versions.length ? btn('Review', { icon: 'chat', title: 'Review the latest render', onClick: () => navigate(`#/p/${project.id}`) }) : null,
    btn('Copy folder path', { icon: 'copy', cls: 'ghost', title: project.dir, onClick: async () => { await copyText(project.dir); toast('Copied', 'ok'); } }),
    btn('', { icon: 'trash', cls: 'ghost icon', title: 'Delete project', onClick: async () => { if (await confirmDeleteProject(api, project)) navigate('#/'); } }),
  ]);
  root._cleanupExtra = () => clearInterval(assetsPoll);
  root.replaceChildren(h('div.studio', chat, h('div.center', stageWrap, transport, tl), side));
  if (!Array.isArray(project.chat)) project.chat = [];
  renderChat(project.chat);
  const key = (e) => { if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey) return; if (e.code === 'Space') { e.preventDefault(); stage.toggle(); } else if (e.key === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? stage.seek(Math.max(0, stage.time - 1)) : step(-1); } else if (e.key === 'ArrowRight') { e.preventDefault(); e.shiftKey ? stage.seek(Math.min(stage.duration, stage.time + 1)) : step(1); } else if (e.key === 'Home') stage.seek(0); else if (e.key === 'Escape') selectClip(null); };
  document.addEventListener('keydown', key);
  new ResizeObserver(() => { renderTimeline(); }).observe(tracksEl);
  await stage.load(src());
  if (!stage.info) overlayMsg.textContent = 'The composition did not load. Check index.html in Files.';
  // Resume a running agent job (page reload mid-run) or start with a prompt from the URL.
  const chatState = await api.chat(project.id).catch(() => null);
  if (Array.isArray(chatState?.chat)) { project.chat = chatState.chat; renderChat(project.chat); }
  if (chatState?.running) {
    agentJob = chatState.running; setBusy(true);
    const live = { role: 'agent', text: '', tools: [], at: new Date().toISOString(), live: true, status: 'still working on your earlier message (press Stop to interrupt)' };
    renderChat([...(project.chat || []), live]);
    const es = new EventSource(`/api/jobs/${chatState.running}/events`);
    es.onmessage = (e) => { const ev = JSON.parse(e.data); if (ev.type === 'text') live.text += (live.text ? '\n\n' : '') + ev.text; if (ev.type === 'tool') live.tools.push({ name: ev.name, detail: ev.detail }); if (ev.type === 'status') live.status = ev.message; if (ev.type === 'error') live.error = ev.message; renderChat([...(project.chat || []), live]); };
    const finish = async () => { es.close(); agentJob = null; setBusy(false); project = await api.project(project.id); renderChat(project.chat || []); reloadComp(); };
    es.addEventListener('done', finish); es.onerror = finish;
  }
  if (prompt && !chatState?.running) { ta.value = prompt; history.replaceState(null, '', `#/studio/${project.id}`); setTimeout(send, 400); }
  root._cleanup = () => { document.removeEventListener('keydown', key); stage.destroy(); root._cleanupExtra?.(); };
}
