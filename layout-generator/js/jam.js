/* DeelJam: the board for everyone. One big board, stickies, shapes with words, connectors, sections, stamps, votes, a
   timer, follow a colleague, templates, and buttons that ask Claude to summarize or sort the board. It sits on the same
   canvas as the design editor (Jam is an editing mode next to Simple and Advanced); Design mode is one click away. */
const Jam = (() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const COLORS = [['#FFE066', 'Yellow'], ['#FFB4A2', 'Coral'], ['#B5EAD7', 'Mint'], ['#C7CEEA', 'Periwinkle'], ['#FDE2FF', 'Pink'], ['#FFDAC1', 'Peach'], ['#E2F0CB', 'Lime'], ['#F0EFEA', 'Grey']];
  const STAMPS = ['👍', '❤️', '🔥', '✅', '❓', '💡', '👀', '🎉', '⭐', '🚀', '⚠️', '➕'];
  const SHAPES = [['rect', 'Rectangle', 12], ['square', 'Square', 0], ['pill', 'Pill', 999], ['ellipse', 'Ellipse', -1], ['diamond', 'Diamond', -2]];
  let env = {}, following = null, followTimer = 0, timerTick = 0, stampPick = '👍', shapePick = 'rect', stickyColor = '#FFE066', aiBusy = false;
  const isJam = () => typeof CanvasUI !== 'undefined' && CanvasUI.editMode === 'jam';
  const board = () => CanvasUI.jamBoard();
  const me = () => CanvasUI.who();

  // ---- chrome -----------------------------------------------------------------------------------------------------
  function init(e) {
    env = e || {};
    if (!$('jamBar')) {
      const bar = document.createElement('div'); bar.id = 'jamBar'; bar.className = 'jam-bar'; bar.hidden = true; $('stage').parentElement.appendChild(bar);
      const ctx = document.createElement('div'); ctx.id = 'jamCtx'; ctx.className = 'jam-ctx'; ctx.hidden = true; $('stage').appendChild(ctx);
      const top = document.createElement('div'); top.id = 'jamTop'; top.className = 'jam-top'; top.hidden = true; $('stage').appendChild(top);
      const pop = document.createElement('div'); pop.id = 'jamPop'; pop.className = 'jam-pop'; pop.hidden = true; $('stage').parentElement.appendChild(pop);
    }
    renderBar();
    if (window.LG_APP === 'jam') { const seg = $('cvMode'); if (seg) seg.innerHTML = `<button type="button" data-edit="jam" data-tip="Jam: a board for everyone, stickies and arrows">Jam</button><button type="button" data-edit="advanced" data-tip="Design: the full editor, layers, auto layout and code">Design</button>`; }
    for (const id of ['jamCtx', 'jamTop']) { const el = $(id); el.addEventListener('pointerdown', e => e.stopPropagation()); el.addEventListener('pointerup', e => e.stopPropagation()); el.addEventListener('dblclick', e => e.stopPropagation()); el.addEventListener('wheel', e => e.stopPropagation(), { passive: true }); }
    $('jamBar').addEventListener('click', onBar); $('jamCtx').addEventListener('click', onCtx); $('jamCtx').addEventListener('input', onCtxInput); $('jamTop').addEventListener('click', onTop); $('jamPop').addEventListener('click', onPop);
    document.addEventListener('pointerdown', e => { if (!e.target.closest('#jamPop') && !e.target.closest('[data-jt][data-pop]')) hidePop(); if (following && e.target.closest('#stage') && !e.target.closest('#jamTop')) stopFollow(); }, true);
    $('stage').addEventListener('wheel', () => { if (following) stopFollow(); }, { passive: true, capture: true });
    CanvasUI.on('select', renderCtx); CanvasUI.on('action', k => { if (String(k).startsWith('editmode.')) applyMode(); if (String(k) === 'tool') renderBar(); });
    CanvasUI.on('view', v => { if (env.shareView) env.shareView(v); renderCtx(); });
    document.addEventListener('keydown', onKeys);
    timerTick = setInterval(renderTop, 500);
    applyMode();
  }
  function onOpen() { if (isJam()) { board(); } applyMode(); }
  function applyMode() {
    const on = isJam() && CanvasUI.active; $('jamBar').hidden = !on; $('jamTop').hidden = !on; if (!on) { $('jamCtx').hidden = true; hidePop(); } else { renderBar(); renderTop(); renderCtx(); }
    document.body.classList.toggle('jam-on', on);
  }
  const TOOLS = [['select', '↖', 'Select · V'], ['hand', '✋', 'Hand · H or hold space'], ['sticky', '▣', 'Sticky · S', 'sticky'], ['text', 'T', 'Text · T'], ['shape', '◻', 'Shape', 'shape'], ['connector', '↗', 'Connector · drag from one thing to another'], ['section', '⬚', 'Section: a titled area that carries what is in it'], ['stamp', '👍', 'Stamp or reaction', 'stamp'], ['pen', '✒', 'Pen · P'], ['image', '🖼', 'Picture or video']];
  function renderBar() {
    const bar = $('jamBar'); if (!bar) return; const t = CanvasUI.tool;
    bar.innerHTML = `<div class="jam-tools">${TOOLS.map(([k, g, tip, pop]) => `<button type="button" data-jt="${k}" ${pop ? `data-pop="${pop}"` : ''} class="${t === k ? 'on' : ''}" data-tip="${esc(tip)}" aria-label="${esc(tip)}">${k === 'sticky' ? `<span class="jam-stk" style="background:${stickyColor}"></span>` : k === 'stamp' ? stampPick : g}</button>`).join('')}</div>
      <div class="jam-sep"></div>
      <div class="jam-tools"><button type="button" data-jt="templates" data-tip="Templates: retro, brainstorm, flowchart…">Templates</button><button type="button" data-jt="ai" data-pop="ai" class="jam-ai" data-tip="Ask Claude about this board">✦ Claude</button></div>`;
  }
  function onBar(e) {
    const b = e.target.closest('[data-jt]'); if (!b) return; const k = b.dataset.jt;
    if (b.dataset.pop) { if (!$('jamPop').hidden && $('jamPop').dataset.kind === b.dataset.pop) { hidePop(); } else showPop(b.dataset.pop, b); if (k === 'sticky' || k === 'shape' || k === 'stamp') CanvasUI.setTool(k); renderBar(); return; }
    if (k === 'templates') { openTemplates(); return; }
    if (k === 'image') { const inp = document.getElementById('cvLoad') || null; const fi = document.createElement('input'); fi.type = 'file'; fi.accept = 'image/*,video/*'; fi.hidden = true; document.body.appendChild(fi); fi.addEventListener('change', async () => { const f = fi.files[0]; fi.remove(); if (!f) return; const c = CanvasUI.viewCenter(); if (/^video\//.test(f.type) && env.addVideo) { const a = await env.addVideo(f, f.name); CanvasUI.placeVideo(a, f.name, { x: c.cx, y: c.cy }); } else if (env.addImage) { const a = await env.addImage(f); CanvasUI.placePicture(a, { x: c.cx, y: c.cy }); } }); fi.click(); return; }
    CanvasUI.setTool(k); renderBar();
  }
  // ---- popovers: sticky colors, shapes, stamps, Claude ----------------------------------------------------------------
  function showPop(kind, anchor) {
    const pop = $('jamPop'); pop.dataset.kind = kind; pop.hidden = false;
    if (kind === 'sticky') pop.innerHTML = `<div class="jam-row">${COLORS.map(([c, nme]) => `<button type="button" class="jam-sw ${c === stickyColor ? 'on' : ''}" data-color="${c}" title="${nme}" style="background:${c}"></button>`).join('')}</div><p class="hint">Click the board to place a sticky, or press S.</p>`;
    else if (kind === 'shape') pop.innerHTML = `<div class="jam-row">${SHAPES.map(([k, nme]) => `<button type="button" class="jam-shape ${k === shapePick ? 'on' : ''}" data-shape="${k}" title="${nme}">${{ rect: '▭', square: '◻', pill: '⬭', ellipse: '◯', diamond: '◇' }[k]}</button>`).join('')}</div><p class="hint">Shapes hold words: double-click one to write in it.</p>`;
    else if (kind === 'stamp') pop.innerHTML = `<div class="jam-row">${STAMPS.map(sm => `<button type="button" class="jam-stamp ${sm === stampPick ? 'on' : ''}" data-stamp="${sm}">${sm}</button>`).join('')}</div>`;
    else if (kind === 'ai') pop.innerHTML = `<div class="jam-ai-list">
        <button type="button" data-ai="summarize"><b>Summarize the board</b><span>What the group said, decisions, open questions, as a note on the board</span></button>
        <button type="button" data-ai="cluster"><b>Cluster stickies into themes</b><span>Sorts the stickies into titled sections</span></button>
        <button type="button" data-ai="actions"><b>Turn into action items</b><span>One sticky per task, with owners where named</span></button>
        <button type="button" data-ai="flow"><b>Draw a flowchart from text</b><span>Paste steps or a process; shapes and arrows appear</span></button>
        <button type="button" data-ai="tidy"><b>Tidy up</b><span>Grids inside sections, even spacing</span></button>
        <button type="button" data-ai="ask"><b>Ask anything…</b><span>Open the agent and type</span></button></div>`;
    const r = anchor.getBoundingClientRect(); const pr = pop.parentElement.getBoundingClientRect(); pop.style.left = Math.max(8, r.left - pr.left + r.width / 2 - 140) + 'px'; pop.style.bottom = (pr.bottom - r.top + 10) + 'px';
  }
  function hidePop() { const pop = $('jamPop'); if (pop) { pop.hidden = true; pop.dataset.kind = ''; } }
  function onPop(e) {
    const sw = e.target.closest('[data-color]'); if (sw) { stickyColor = sw.dataset.color; CanvasUI.setStickyColor(stickyColor); const bs = selBlocks().filter(b => b.kind === 'sticky'); if (bs.length) { CanvasUI.mutate(() => { for (const b of bs) b.fill = stickyColor; }, { frames: [CanvasUI.selection().frameId] }); } else CanvasUI.setTool('sticky'); renderBar(); showPop('sticky', $('jamBar').querySelector('[data-jt="sticky"]')); return; }
    const sh = e.target.closest('[data-shape]'); if (sh) { shapePick = sh.dataset.shape; CanvasUI.setTool('shape'); hidePop(); renderBar(); return; }
    const st = e.target.closest('[data-stamp]'); if (st) { stampPick = st.dataset.stamp; CanvasUI.setTool('stamp'); hidePop(); renderBar(); return; }
    const ai = e.target.closest('[data-ai]'); if (ai) { hidePop(); runAI(ai.dataset.ai); return; }
  }
  // the tools read the picks when they place
  function pickFor(kind) {
    if (kind === 'sticky') return { color: stickyColor };
    if (kind === 'stamp') return { emoji: stampPick };
    if (kind === 'shape') { const sp = SHAPES.find(x => x[0] === shapePick) || SHAPES[0]; return { radius: sp[2] >= 0 ? sp[2] : 0, shape: sp[0] }; }
    return {};
  }

  // ---- contextual bar above the selection -------------------------------------------------------------------------
  const selBlocks = () => { const s = CanvasUI.selection(); const f = s.frameId && Canvas.frameById(CanvasUI.doc, s.frameId); return f ? s.blockIds.map(id => Canvas.blockById(f, id)).filter(Boolean) : []; };
  function renderCtx() {
    const el = $('jamCtx'); if (!el || !isJam() || !CanvasUI.active) { if (el) el.hidden = true; return; }
    const s = CanvasUI.selection(); const f = s.frameId && Canvas.frameById(CanvasUI.doc, s.frameId); const bs = selBlocks();
    if (!f || !bs.length) { el.hidden = true; return; }
    const kinds = new Set(bs.map(b => b.kind)); const one = bs.length === 1 ? bs[0] : null;
    const my = me().id; const myVotes = bs.reduce((t, b) => t + ((b.votes || {})[my] || 0), 0);
    const colorable = bs.every(b => b.kind === 'sticky' || b.kind === 'field' || b.kind === 'shape' || (b.kind === 'box' && b.section));
    const wordy = bs.every(b => b.kind === 'sticky' || b.kind === 'text' || ((b.kind === 'field' || b.kind === 'shape') && b.text != null));
    const parts = [];
    if (colorable) parts.push(`<div class="jam-row">${COLORS.map(([c, nme]) => `<button type="button" class="jam-sw ${bs.every(b => String(b.fill).toUpperCase() === c) ? 'on' : ''}" data-cx="color" data-color="${c}" title="${nme}" style="background:${c}"></button>`).join('')}</div>`);
    if (wordy) parts.push(`<button type="button" data-cx="smaller" title="Smaller text">A−</button><button type="button" data-cx="bigger" title="Bigger text">A+</button><button type="button" data-cx="bold" class="${bs.every(b => b.font && b.font.weight >= 600) ? 'on' : ''}" title="Bold"><b>B</b></button>`);
    if (one && one.kind === 'box' && one.section) parts.push(`<input type="text" data-cx="title" value="${esc(one.section.title || '')}" placeholder="Section title" aria-label="Section title">`);
    if (one && one.kind === 'connector') parts.push(`<select data-cx="arrow" aria-label="Arrows"><option value="none" ${one.arrow === 'none' ? 'selected' : ''}>No arrow</option><option value="end" ${!one.arrow || one.arrow === 'end' ? 'selected' : ''}>Arrow →</option><option value="both" ${one.arrow === 'both' ? 'selected' : ''}>Both ↔</option></select><select data-cx="route" aria-label="Route"><option value="elbow" ${one.route !== 'straight' ? 'selected' : ''}>Elbow</option><option value="straight" ${one.route === 'straight' ? 'selected' : ''}>Straight</option></select><button type="button" data-cx="dash" class="${one.dash ? 'on' : ''}" title="Dashed">┈</button><button type="button" data-cx="label" title="Label">Label</button>`);
    if (kinds.has('sticky') || kinds.has('field') || kinds.has('shape') || kinds.has('stamp') || kinds.has('text')) parts.push(`<button type="button" data-cx="vote" title="Vote (up to 3 each)">▲ Vote${myVotes ? ` <b>${myVotes}</b>` : ''}</button>`);
    if (kinds.has('sticky')) parts.push(`<button type="button" data-cx="veil" class="${bs.every(b => b.veil) ? 'on' : ''}" title="Hide the words from others until reveal">${bs.every(b => b.veil) ? 'Hidden' : 'Hide'}</button>`);
    parts.push(`<button type="button" data-cx="dup" title="Duplicate ⌘D">⧉</button><button type="button" data-cx="del" title="Delete">🗑</button>`);
    el.innerHTML = parts.join('<span class="jam-sep-v"></span>');
    // above the selection
    const xs = bs.map(b => f.x + b.x), ys = bs.map(b => f.y + b.y); const x0 = Math.min(...xs), y0 = Math.min(...ys), x1 = Math.max(...bs.map(b => f.x + b.x + b.w));
    const v = CanvasUI.doc.view; const sx = v.x + ((x0 + x1) / 2) * v.zoom, sy = v.y + y0 * v.zoom;
    el.hidden = false; const w = el.offsetWidth || 320; const stage = $('stage').getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(stage.width - w - 8, sx - w / 2)) + 'px'; el.style.top = Math.max(8, sy - 52) + 'px';
  }
  function onCtx(e) {
    const b = e.target.closest('[data-cx]'); if (!b || b.tagName === 'INPUT' || b.tagName === 'SELECT') return; const k = b.dataset.cx; const s = CanvasUI.selection(); const f = s.frameId && Canvas.frameById(CanvasUI.doc, s.frameId); const bs = selBlocks(); if (!f || !bs.length) return;
    const M = fn => CanvasUI.mutate(() => { for (const x of bs) fn(x); }, { frames: [f.id] });
    if (k === 'color') { stickyColor = b.dataset.color; CanvasUI.setStickyColor(stickyColor); M(x => { x.fill = b.dataset.color; }); }
    else if (k === 'smaller' || k === 'bigger') M(x => { if (!x.font) return; const base = x.kind === 'sticky' || x.text != null ? (x.fontSizeMax || x.font.size) : x.font.size; const nz = Math.max(10, Math.min(96, Math.round(base * (k === 'bigger' ? 1.2 : 1 / 1.2)))); if (x.kind === 'sticky' || ((x.kind === 'field' || x.kind === 'shape') && x.text != null)) x.fontSizeMax = nz; x.font.size = nz; Canvas.refit(x); });
    else if (k === 'bold') { const on = bs.every(x => x.font && x.font.weight >= 600); M(x => { if (x.font) { x.font.weight = on ? 400 : 700; Canvas.refit(x); } }); }
    else if (k === 'dash') M(x => { x.dash = !x.dash; });
    else if (k === 'label') { CanvasUI.startEdit(f.id, bs[0].id); return; }
    else if (k === 'vote') { const my = me().id; M(x => { x.votes = x.votes || {}; const n = x.votes[my] || 0; if (n >= 3) { delete x.votes[my]; } else x.votes[my] = n + 1; }); }
    else if (k === 'veil') { const on = bs.every(x => x.veil); M(x => { if (x.kind === 'sticky') { if (on) delete x.veil; else x.veil = true; } }); }
    else if (k === 'dup') { CanvasUI.copySelection(); CanvasUI.pasteClipboard(); return; }
    else if (k === 'del') { CanvasUI.mutate(() => Canvas.removeBlocks(f, bs.map(x => x.id)), { frames: [f.id] }); CanvasUI.select(f.id, []); return; }
    renderCtx();
  }
  function onCtxInput(e) {
    const t = e.target; const k = t.dataset.cx; const s = CanvasUI.selection(); const f = s.frameId && Canvas.frameById(CanvasUI.doc, s.frameId); const bs = selBlocks(); if (!f || !bs.length) return;
    if (k === 'title') { const b = bs[0]; if (b.section) { b.section.title = t.value.slice(0, 80); CanvasUI.rerender([f.id]); CanvasUI.markDirty([f.id]); } }
    if (k === 'arrow' || k === 'route') CanvasUI.mutate(() => { for (const x of bs) if (x.kind === 'connector') x[k] = t.value; }, { frames: [f.id] });
  }
  function onKeys(e) {
    if (!isJam() || !CanvasUI.active) return; const tag = (e.target.tagName || '').toLowerCase(); if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 's') { CanvasUI.setTool('sticky'); renderBar(); e.preventDefault(); } else if (k === 'x') { CanvasUI.setTool('connector'); renderBar(); e.preventDefault(); } else if (k === 'n') { CanvasUI.setTool('section'); renderBar(); e.preventDefault(); }
  }

  // ---- top strip: people, follow, timer, reveal, mode -----------------------------------------------------------------
  let timerMenu = false;
  function renderTop() {
    const el = $('jamTop'); if (!el || el.hidden) return;
    const d = CanvasUI.doc; const peers = CanvasUI.peers || []; const t = d && d.jam && d.jam.timer; const now = Date.now();
    const left = t && t.endsAt ? Math.max(0, Math.ceil((t.endsAt - now) / 1000)) : 0; const mm = Math.floor(left / 60), ss = String(left % 60).padStart(2, '0');
    const hidden = d ? d.frames.reduce((n, f) => n + f.layout.blocks.filter(b => b.kind === 'sticky' && b.veil).length, 0) : 0;
    el.innerHTML = `<div class="jam-people">${peers.slice(0, 8).map(p => `<button type="button" class="jam-peer ${following === p.id ? 'on' : ''}" data-follow="${esc(p.id)}" style="--c:${esc(p.color || '#888')}" title="${following === p.id ? 'Following ' : 'Follow '}${esc(p.name || 'Someone')}">${esc((p.name || '?').trim()[0] || '?')}</button>`).join('')}${peers.length ? `<span class="hint">${peers.length} here</span>` : '<span class="hint">Only you here</span>'}${following ? `<button type="button" class="btn small" data-top="unfollow">Stop following</button>` : ''}</div>
      <div class="jam-right">${hidden ? `<button type="button" class="btn small" data-top="reveal" title="Show every hidden sticky">Reveal ${hidden}</button>` : ''}
        <button type="button" class="btn small ${t && t.endsAt && left > 0 ? 'jam-timer-on' : ''}" data-top="timer">${t && t.endsAt && left > 0 ? `⏱ ${mm}:${ss}` : '⏱ Timer'}</button>${timerMenu ? `<span class="jam-timer-menu">${[1, 2, 5, 10, 15].map(m => `<button type="button" class="btn small" data-timer="${m}">${m} min</button>`).join('')}${t && t.endsAt ? '<button type="button" class="btn small" data-timer="0">Stop</button>' : ''}</span>` : ''}
        <button type="button" class="btn small" data-top="clearvotes" title="Clear every vote on the board">Clear votes</button>
        <button type="button" class="btn small primary" data-top="design" title="Open the full design editor on this board">Design mode</button></div>`;
    if (t && t.endsAt && left === 0 && !t.rang) { t.rang = true; if (env.toast) env.toast('⏱ Time is up'); }
  }
  function onTop(e) {
    const fo = e.target.closest('[data-follow]'); if (fo) { if (following === fo.dataset.follow) stopFollow(); else startFollow(fo.dataset.follow); renderTop(); return; }
    const tm = e.target.closest('[data-timer]'); if (tm) { const m = +tm.dataset.timer; const d = CanvasUI.doc; d.jam = d.jam || {}; d.jam.timer = m > 0 ? { endsAt: Date.now() + m * 60000, minutes: m, by: me().id } : null; timerMenu = false; CanvasUI.mutate(() => {}, { history: false, frames: [] }); renderTop(); return; }
    const b = e.target.closest('[data-top]'); if (!b) return; const k = b.dataset.top;
    if (k === 'timer') { timerMenu = !timerMenu; renderTop(); }
    else if (k === 'unfollow') { stopFollow(); renderTop(); }
    else if (k === 'reveal') { const d = CanvasUI.doc; CanvasUI.mutate(() => { for (const f of d.frames) for (const x of f.layout.blocks) if (x.veil) delete x.veil; }, { frames: d.frames.map(f => f.id) }); renderTop(); }
    else if (k === 'clearvotes') { const d = CanvasUI.doc; CanvasUI.mutate(() => { for (const f of d.frames) for (const x of f.layout.blocks) if (x.votes) delete x.votes; }, { frames: d.frames.map(f => f.id) }); renderCtx(); }
    else if (k === 'design') { CanvasUI.setEditMode('advanced'); if (env.toast) env.toast('Design mode: the full editor. Jam at the top left brings the board tools back.'); }
  }
  function startFollow(id) { following = id; clearInterval(followTimer); followTimer = setInterval(() => { const p = (CanvasUI.peers || []).find(x => x.id === following); if (!p) { stopFollow(); return; } if (p.view && Number.isFinite(p.view.cx)) CanvasUI.setView(p.view); }, 200); }
  function stopFollow() { following = null; clearInterval(followTimer); followTimer = 0; renderTop(); }

  // ---- templates ----------------------------------------------------------------------------------------------------
  const sticky = (text, color, x, y) => ({ kind: 'sticky', x, y, w: 200, h: 200, text, fill: color });
  const section = (title, x, y, w, h, color) => ({ kind: 'section', x, y, w, h, title, color });
  const shape = (text, x, y, w = 220, h = 120, fill = '#FFFFFF', radius = 12) => ({ kind: 'shape', x, y, w, h, text, fill, radius });
  const TEMPLATES = [
    { id: 'retro', name: 'Retro', hint: 'Went well · To improve · Actions', make: () => [section('Went well 🟢', 0, 0, 520, 760, '#E2F0CB'), section('To improve 🟠', 560, 0, 520, 760, '#FFDAC1'), section('Actions ✅', 1120, 0, 520, 760, '#C7CEEA'), sticky('One thing that went well', '#FFE066', 40, 80), sticky('One thing to improve', '#FFE066', 600, 80), sticky('Owner · action', '#FFE066', 1160, 80)] },
    { id: 'brainstorm', name: 'Brainstorm', hint: 'A question, a wall of ideas, a parking lot', make: () => [shape('How might we…?', 0, 0, 720, 120, '#1E1C1A', 16), section('Ideas', 0, 170, 1400, 700, '#FDE2FF'), section('Parking lot', 1440, 170, 420, 700, '#F0EFEA'), sticky('Idea', '#FFE066', 40, 250), sticky('Idea', '#B5EAD7', 280, 250), sticky('Idea', '#FFB4A2', 520, 250)] },
    { id: 'prio', name: 'Prioritize 2×2', hint: 'Impact against effort', make: () => [section('Big impact · low effort → do first', 0, 0, 700, 500, '#E2F0CB'), section('Big impact · high effort → plan', 740, 0, 700, 500, '#C7CEEA'), section('Small impact · low effort → quick wins', 0, 540, 700, 500, '#FFE8A3'), section('Small impact · high effort → drop', 740, 540, 700, 500, '#F0EFEA'), sticky('Thing to prioritize', '#FFE066', 40, 80)] },
    { id: 'journey', name: 'User journey', hint: 'Stages across, what happens below', make: () => { const st = ['Discover', 'Sign up', 'Set up', 'First value', 'Habit']; const rows = ['Doing', 'Thinking', 'Feeling', 'Pain points', 'Opportunities']; const out = []; st.forEach((s, i) => out.push(shape(s, 200 + i * 300, 0, 280, 80, '#1E1C1A', 10))); rows.forEach((r, j) => { out.push(shape(r, 0, 120 + j * 240, 180, 200, '#F0EFEA', 10)); st.forEach((s, i) => out.push(sticky('', ['#FFE066', '#B5EAD7', '#FDE2FF', '#FFB4A2', '#C7CEEA'][j], 240 + i * 300, 120 + j * 240))); }); return out; } },
    { id: 'flow', name: 'Flowchart', hint: 'Start, steps, a decision, two ends', make: () => { const a = shape('Start', 0, 0, 200, 90, '#B5EAD7', 999), b = shape('Do the thing', 320, 0, 240, 90), c = shape('Worked?', 680, -15, 220, 120, '#FFE8A3', 12), d = shape('Done ✅', 1020, -120, 200, 90, '#B5EAD7', 999), e2 = shape('Fix and retry', 1020, 120, 220, 90, '#FFB4A2'); a.id = 'fa'; b.id = 'fb'; c.id = 'fc'; d.id = 'fd'; e2.id = 'fe'; return [a, b, c, d, e2, { kind: 'connector', from: 'fa', to: 'fb' }, { kind: 'connector', from: 'fb', to: 'fc' }, { kind: 'connector', from: 'fc', to: 'fd', text: 'yes' }, { kind: 'connector', from: 'fc', to: 'fe', text: 'no' }, { kind: 'connector', from: 'fe', to: 'fb', route: 'elbow' }]; } },
    { id: 'sync', name: 'Team sync', hint: 'Updates, blockers, decisions, next week', make: () => [section('Updates', 0, 0, 520, 560, '#E2F0CB'), section('Blockers 🚧', 560, 0, 520, 560, '#FFDAC1'), section('Decisions', 0, 600, 520, 400, '#C7CEEA'), section('Next week', 560, 600, 520, 400, '#FDE2FF')] },
    { id: 'okr', name: 'OKR tree', hint: 'One objective, three key results, initiatives', make: () => { const o = shape('Objective', 450, 0, 300, 100, '#1E1C1A', 14); o.id = 'o'; const krs = [0, 1, 2].map(i => { const k = shape(`Key result ${i + 1}`, i * 420, 220, 300, 100, '#C7CEEA', 12); k.id = 'k' + i; return k; }); const out = [o, ...krs]; krs.forEach(k => out.push({ kind: 'connector', from: 'o', to: k.id })); krs.forEach((k, i) => { out.push(sticky('Initiative', '#FFE066', i * 420, 400)); out.push(sticky('Initiative', '#FFE066', i * 420 + 220, 400)); }); return out; } },
    { id: 'decision', name: 'Decision log', hint: 'Options, pros, cons, decision', make: () => [section('Option A', 0, 0, 440, 640, '#F0EFEA'), section('Option B', 480, 0, 440, 640, '#F0EFEA'), section('Option C', 960, 0, 440, 640, '#F0EFEA'), sticky('Pro', '#B5EAD7', 40, 80), sticky('Con', '#FFB4A2', 40, 320), sticky('Pro', '#B5EAD7', 520, 80), sticky('Con', '#FFB4A2', 520, 320), sticky('Pro', '#B5EAD7', 1000, 80), sticky('Con', '#FFB4A2', 1000, 320), shape('Decision: …', 0, 700, 1400, 100, '#1E1C1A', 16)] },
  ];
  function openTemplates() {
    const pop = $('jamPop'); pop.dataset.kind = 'templates'; pop.hidden = false;
    pop.innerHTML = `<div class="jam-tpl">${TEMPLATES.map(t => `<button type="button" data-tpl="${t.id}"><b>${esc(t.name)}</b><span>${esc(t.hint)}</span></button>`).join('')}</div>`;
    const r = $('jamBar').querySelector('[data-jt="templates"]').getBoundingClientRect(); const pr = pop.parentElement.getBoundingClientRect(); pop.style.left = Math.max(8, r.left - pr.left + r.width / 2 - 220) + 'px'; pop.style.bottom = (pr.bottom - r.top + 10) + 'px';
    pop.onclick = e => { const b = e.target.closest('[data-tpl]'); if (!b) return; const t = TEMPLATES.find(x => x.id === b.dataset.tpl); hidePop(); pop.onclick = null; if (t) insertTemplate(t); };
  }
  // Specs (relative to 0,0) become real blocks on the board around the middle of the view; connectors by spec id.
  function insertTemplate(t) {
    const f = board(); const kit = env.getKit ? env.getKit() : { fonts: {} }; const specs = t.make(); const c = CanvasUI.viewCenter();
    const xs = specs.filter(s => s.kind !== 'connector').map(s => s.x), ys = specs.filter(s => s.kind !== 'connector').map(s => s.y); const x1 = Math.max(...specs.filter(s => s.kind !== 'connector').map(s => s.x + s.w)), y1 = Math.max(...specs.filter(s => s.kind !== 'connector').map(s => s.y + s.h));
    const ox = Math.round(c.cx - f.x - (Math.min(...xs) + x1) / 2), oy = Math.round(c.cy - f.y - (Math.min(...ys) + y1) / 2);
    const made = new Map(); const blocks = [];
    for (const sp of specs) {
      if (sp.kind === 'connector') continue;
      const b = Canvas.newBlock(sp.kind, f, kit, { x: sp.x + ox, y: sp.y + oy, color: sp.fill || sp.color, title: sp.title, radius: sp.radius });
      if (!b) continue; b.w = sp.w; b.h = sp.h; if (sp.text != null) b.text = sp.text; if (sp.fill) b.fill = sp.fill; if (sp.kind === 'shape' && sp.radius === 999) b.radius = Math.min(sp.w, sp.h) / 2; if (sp.kind === 'shape' && sp.fill === '#1E1C1A') b.color = '#FFFFFF';
      if (b.kind === 'sticky') { const m = me(); b.author = m.id; b.authorName = m.name; }
      if (sp.id) made.set(sp.id, b.id); blocks.push(b);
    }
    for (const sp of specs) { if (sp.kind !== 'connector') continue; const b = Canvas.newBlock('connector', f, kit, { x: 0, y: 0, from: { id: made.get(sp.from) }, to: { id: made.get(sp.to) } }); if (!made.get(sp.from) || !made.get(sp.to)) continue; if (sp.text) b.text = sp.text; if (sp.route) b.route = sp.route; blocks.push(b); }
    CanvasUI.mutate(() => { for (const b of blocks) { f.layout.blocks.push(b); if (b.kind !== 'box' && b.kind !== 'connector') { const sec = Canvas.sectionAt(f, b); if (sec && blocks.includes(sec)) b.parent = sec.id; } if (b.kind === 'sticky' || b.kind === 'field') Canvas.refit(b); } Canvas.syncConnectors(f); CanvasUI.growBoard(f, { x: Math.min(...xs) + ox, y: Math.min(...ys) + oy, w: x1 - Math.min(...xs), h: y1 - Math.min(...ys) }); }, { frames: [f.id] });
    CanvasUI.select(f.id, blocks.filter(b => b.kind !== 'connector').map(b => b.id)); if (env.toast) env.toast(`${t.name} added`);
  }

  // ---- Claude on the board -----------------------------------------------------------------------------------------
  const AI = {
    summarize: 'Read every sticky, shape and text on this board (get_frame on the board screen). Then add ONE text block (kind body, 520 wide, 18px) to the right of everything, titled "Summary", with 3–6 short bullets of what the group said, then "Decisions:" and "Open questions:" lines if there are any. Do not move or change anything that is already there.',
    cluster: 'Group the stickies on this board into 3–6 themes by meaning. For each theme add a section (kind section, title = the theme in 2–4 words, a soft color) and move its stickies inside it with update_blocks x/y in a grid: stickies are 200×200, 24px apart, 40px inside the section edge, below the title. Put the sections side by side, 80px apart, starting where the stickies are now. Keep every sticky\'s words exactly as they are; set each moved sticky\'s parent to its section with move_into if available, else leave parent as is.',
    actions: 'Turn this board into action items. Add a section titled "Action items" (kind section) to the right of everything, and inside it one sticky (kind sticky, color #C7CEEA) per item in a grid (200×200, 24px apart). An item reads "<verb phrase> — <owner>" when an owner is named, else just the action. Pull items from stickies and shapes that read like tasks, decisions or next steps. Do not change the existing stickies.',
    tidy: 'Tidy this board without changing any words: inside each section, lay the stickies out in a grid (200×200, 24px apart, 40px from the section edges, below the title) and grow the section if they do not fit; line sections up left to right with 80px between them; put loose stickies in a grid to the right. Use update_blocks x/y (and w/h for sections). Keep connectors attached.',
  };
  async function runAI(kind) {
    if (typeof Agent === 'undefined') return;
    if (kind === 'ask') { Agent.show(); return; }
    if (kind === 'flow') { const text = prompt('Paste the steps or describe the process (one step per line, decisions as questions):'); if (!text || !text.trim()) return; Agent.send(`Draw this as a flowchart on the board: shapes (kind shape, 220×120, rounded 12; decisions are questions and get fill #FFE8A3; start and end get fill #B5EAD7 with radius 45) connected with connectors (kind connector, from_id/to_id, labels "yes"/"no" on decision branches), laid out left to right, 100px between shapes, rows 60px apart, placed in empty space to the right of what is on the board. Keep each step\'s words short.\n\n${text.trim().slice(0, 3000)}`); return; }
    const f = board(); CanvasUI.select(f.id, []); Agent.send(AI[kind]);
  }

  return { init, onOpen, applyMode, renderCtx, pickFor, TEMPLATES, insertTemplate, get stickyColor() { return stickyColor; }, isJam };
})();
