/* Canvas editor UI: infinite stage, selection of blocks or whole screens, smart guides, on-canvas text editing, groups,
   layers, properties, code view, export. Everything the panels change is a field in a frame's layout JSON; the stage
   re-renders from it. Hooks (change, live, select, pointer) let multiplayer and the agent plug in from outside. */
const CanvasUI = (() => {
  const $ = id => document.getElementById(id);
  let env = null, doc = null, hist = null, active = false;
  // frameIds holds every selected screen; blockIds are blocks inside the one frame in frameId.
  const sel = { frameId: null, blockIds: [], frameIds: [] };
  let tool = 'select', hover = null, drag = null, spaceDown = false, clipboard = null, lastPointer = null, dropTarget = null;
  let guides = [], editing = null, groupFocus = null, peers = [], undoMerge = null;
  const hooks = { change: [], live: [], select: [], pointer: [] };
  const HANDLE = 7;
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const emit = (k, ...a) => { for (const fn of hooks[k]) { try { fn(...a); } catch (e) { console.error(e); } } };
  const toHex = v => { try { return Color.normalize(v); } catch { return '#000000'; } };

  // ---- Setup ------------------------------------------------------------------------------------
  function init(e) {
    env = e;
    try { const saved = localStorage.getItem('lg.canvas'); doc = saved ? Canvas.deserialize(saved) : Canvas.create(); } catch { doc = Canvas.create(); }
    hist = Canvas.history();
    bindStage(); bindToolbar(); bindKeys(); bindLayers(); bindProps();
    Canvas.fromHash(location.hash).then(d => { if (d) { doc = d; env.toast('Canvas loaded from link'); if (active) renderAll(); } }).catch(() => { });
  }
  function count() { return doc ? doc.frames.length : 0; }
  function open() { active = true; renderAll(); if (doc.frames.length && !sel.frameId) fit(); }
  function close() { endEdit(); active = false; }
  function persist(opts = {}) { try { const s = Canvas.serialize(doc); if (s.length < 3_000_000) localStorage.setItem('lg.canvas', s); } catch { } if (!opts.silent) emit('change', doc, opts); }
  function updateUndo() { $('cvUndo').disabled = !hist.canUndo; $('cvRedo').disabled = !hist.canRedo; }
  // One undoable step for changes made from outside the editor (agent, sync, batch tools).
  function mutate(fn, opts = {}) {
    if (opts.history !== false) hist.push(doc);
    const out = fn(doc);
    validateSelection();
    if (active) { if (opts.frames) opts.frames.forEach(id => { const f = Canvas.frameById(doc, id); if (f) rerenderFrame(f); }); else renderFrames(); renderLayers(); if (!propsFocused()) renderProps(); drawOverlay(); }
    persist(); updateUndo();
    return out;
  }
  // Remote changes: the document object was patched in place by the sync layer.
  function remoteApplied(frameIds, structural) {
    validateSelection();
    if (editing && !Canvas.frameById(doc, editing.frameId)) endEdit(true);
    if (!active) { persist({ silent: true }); return; }
    if (structural || !frameIds) renderFrames(); else frameIds.forEach(id => { const f = Canvas.frameById(doc, id); if (f && !(editing && editing.frameId === id)) rerenderFrame(f); });
    renderLayers(); if (!propsFocused()) renderProps(); drawOverlay(); updateCount();
    persist({ silent: true });
  }
  function replaceDoc(d, opts = {}) { const view = doc && doc.view; doc = d; if (opts.keepView !== false && view) doc.view = view; validateSelection(); if (active) renderAll(); persist(opts); }
  const propsFocused = () => { const a = document.activeElement; return !!(a && $('cvProps').contains(a) && a !== document.body); };
  function validateSelection() {
    sel.frameIds = sel.frameIds.filter(id => Canvas.frameById(doc, id));
    if (!Canvas.frameById(doc, sel.frameId)) { sel.frameId = sel.frameIds[0] || null; sel.blockIds = []; }
    const f = selFrame(); sel.blockIds = f ? sel.blockIds.filter(id => Canvas.blockById(f, id)) : [];
    if (sel.frameId && !sel.frameIds.includes(sel.frameId)) sel.frameIds = [sel.frameId];
  }

  function addLayouts(layouts, opts = {}) {
    hist.push(doc);
    const start = doc.frames.length ? Math.max(...doc.frames.map(f => f.y + f.layout.format.h)) + 240 : 0;
    let x = opts.x ?? 0; const added = [];
    for (const L of layouts) { const f = Canvas.addFrame(doc, L, { x, y: opts.y ?? start, name: opts.name }); x += L.format.w + 160; added.push(f); }
    sel.frameId = added.length ? added[0].id : null; sel.blockIds = []; sel.frameIds = added.map(f => f.id);
    persist(); updateUndo();
    if (active) { renderAll(); fitTo(added); }
    return added;
  }

  // ---- Geometry ------------------------------------------------------------------------------------
  const stage = () => $('stage');
  function toWorld(cx, cy) { const r = stage().getBoundingClientRect(); const v = doc.view; return { x: (cx - r.left - v.x) / v.zoom, y: (cy - r.top - v.y) / v.zoom }; }
  function toScreen(wx, wy) { const v = doc.view; return { x: wx * v.zoom + v.x, y: wy * v.zoom + v.y }; }
  const FW = f => f.layout.format.w, FH = f => f.layout.format.h;
  function frameAt(p) { for (let i = doc.frames.length - 1; i >= 0; i--) { const f = doc.frames[i]; if (f.hidden) continue; if (p.x >= f.x && p.y >= f.y && p.x <= f.x + FW(f) && p.y <= f.y + FH(f)) return f; } return null; }
  function labelAt(p) { const off = Math.max(16, 18 / doc.view.zoom) + 2; for (let i = doc.frames.length - 1; i >= 0; i--) { const f = doc.frames[i]; if (f.hidden) continue; if (p.x >= f.x && p.x <= f.x + FW(f) && p.y >= f.y - off && p.y < f.y) return f; } return null; }
  function blockAt(f, p) { const lx = p.x - f.x, ly = p.y - f.y; const bs = f.layout.blocks; for (let i = bs.length - 1; i >= 0; i--) { const b = bs[i]; if (b.hidden) continue; const w = (b.kind === 'text' && b.align !== 'center' && b.align !== 'right') ? Math.max(b.inkW || b.w, 24) : b.w; if (lx >= b.x && ly >= b.y && lx <= b.x + w && ly <= b.y + b.h) return b; } return null; }
  function selFrame() { return Canvas.frameById(doc, sel.frameId); }
  function selFrames() { return (sel.frameIds.length ? sel.frameIds : sel.frameId ? [sel.frameId] : []).map(id => Canvas.frameById(doc, id)).filter(Boolean); }
  function selBlocks() { const f = selFrame(); return f ? sel.blockIds.map(id => Canvas.blockById(f, id)).filter(Boolean) : []; }

  function fit() { if (!doc.frames.length) { doc.view = { x: 60, y: 60, zoom: 0.5 }; applyView(); return; } fitTo(doc.frames.filter(f => !f.hidden).length ? doc.frames.filter(f => !f.hidden) : doc.frames); }
  function fitTo(frames) {
    const r = stage().getBoundingClientRect(); if (!r.width || !frames.length) return;
    const b = Canvas.framesBounds(frames);
    const zoom = Math.min(2, Math.max(0.03, Math.min((r.width - 80) / b.w, (r.height - 120) / b.h)));
    doc.view = { zoom, x: (r.width - b.w * zoom) / 2 - b.x * zoom, y: (r.height - b.h * zoom) / 2 - b.y * zoom + 10 };
    applyView();
  }
  function zoomBy(factor, cx, cy) {
    const r = stage().getBoundingClientRect(); const px = cx != null ? cx - r.left : r.width / 2, py = cy != null ? cy - r.top : r.height / 2;
    const v = doc.view; const z = Math.min(4, Math.max(0.03, v.zoom * factor));
    v.x = px - (px - v.x) * (z / v.zoom); v.y = py - (py - v.y) * (z / v.zoom); v.zoom = z; applyView();
  }
  function applyView() {
    const v = doc.view; $('world').style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`; $('cvZoom').textContent = Math.round(v.zoom * 100) + '%';
    stage().style.backgroundSize = `${24 * v.zoom}px ${24 * v.zoom}px`; stage().style.backgroundPosition = `${v.x}px ${v.y}px`;
    const fs = Math.max(11, 12 / v.zoom) + 'px', off = Math.max(16, 18 / v.zoom);
    $('world').querySelectorAll('.cv-frame-label').forEach(lb => { lb.style.fontSize = fs; const f = Canvas.frameById(doc, lb.dataset.label); if (f) lb.style.top = (f.y - off) + 'px'; });
    positionEditor(); drawOverlay();
  }

  // ---- Rendering ----------------------------------------------------------------------------------------
  function updateCount() { const n = doc.frames.length; const s = selFrames().length; $('cvCount').textContent = n ? `${n} frame${n > 1 ? 's' : ''}${s > 1 ? ` · ${s} selected` : ''}` : 'Empty canvas'; $('cvEmpty').hidden = n > 0; }
  function renderAll() { renderFrames(); renderLayers(); renderProps(); applyView(); updateUndo(); updateCount(); }
  function labelHTML(f) { return `<div class="cv-frame-label${sel.frameIds.includes(f.id) ? ' on' : ''}" data-label="${esc(f.id)}" style="left:${f.x}px;top:${f.y - Math.max(16, 18 / doc.view.zoom)}px;max-width:${FW(f)}px;font-size:${Math.max(11, 12 / doc.view.zoom)}px;${f.hidden ? 'display:none;' : ''}">${esc(f.name)}</div>`; }
  function renderFrames() {
    $('world').innerHTML = doc.frames.map(f => `${labelHTML(f)}<div class="cv-frame" data-id="${esc(f.id)}" style="left:${f.x}px;top:${f.y}px;width:${FW(f)}px;height:${FH(f)}px;${f.hidden ? 'display:none;' : ''}${f.clip === false ? 'overflow:visible;' : ''}">${frameSVG(f)}</div>`).join('');
  }
  function frameSVG(f) {
    const L = editing && editing.frameId === f.id && editing.hide ? { ...f.layout, blocks: f.layout.blocks.filter(b => b.id !== editing.blockId) } : f.layout;
    return env.renderSVG(L, { showGrid: !!f.showGrid });
  }
  function positionFrame(f) {
    const el = $('world').querySelector(`.cv-frame[data-id="${CSS.escape(f.id)}"]`); if (el) { el.style.left = f.x + 'px'; el.style.top = f.y + 'px'; }
    const lb = $('world').querySelector(`.cv-frame-label[data-label="${CSS.escape(f.id)}"]`); if (lb) { lb.style.left = f.x + 'px'; lb.style.top = (f.y - Math.max(16, 18 / doc.view.zoom)) + 'px'; }
  }
  function rerenderFrame(f) {
    const el = $('world').querySelector(`.cv-frame[data-id="${CSS.escape(f.id)}"]`); if (!el) return renderFrames();
    const svg = el.querySelector('svg'); if (svg) svg.outerHTML = frameSVG(f); else el.insertAdjacentHTML('beforeend', frameSVG(f));
    el.style.left = f.x + 'px'; el.style.top = f.y + 'px'; el.style.width = FW(f) + 'px'; el.style.height = FH(f) + 'px'; el.style.display = f.hidden ? 'none' : ''; el.style.overflow = f.clip === false ? 'visible' : '';
    const lb = $('world').querySelector(`.cv-frame-label[data-label="${CSS.escape(f.id)}"]`); if (lb) { lb.style.left = f.x + 'px'; lb.style.top = (f.y - Math.max(16, 18 / doc.view.zoom)) + 'px'; lb.style.maxWidth = FW(f) + 'px'; lb.textContent = f.name; lb.style.display = f.hidden ? 'none' : ''; lb.classList.toggle('on', sel.frameIds.includes(f.id)); }
  }
  function markLabels() { $('world').querySelectorAll('.cv-frame-label').forEach(lb => lb.classList.toggle('on', sel.frameIds.includes(lb.dataset.label))); }

  // ---- Overlay: selection, handles, guides, peers --------------------------------------------------------
  const PEER_COLOR = c => Render.col(c, '#7C5CFF');
  function drawOverlay() {
    const ov = $('overlay'); const r = stage().getBoundingClientRect(); ov.setAttribute('width', r.width); ov.setAttribute('height', r.height);
    if (!doc) return;
    const Z = doc.view.zoom; const parts = [];
    const rect = (x, y, w, h, attrs) => { const p = toScreen(x, y); return `<rect x="${p.x}" y="${p.y}" width="${Math.max(0, w * Z)}" height="${Math.max(0, h * Z)}" ${attrs}/>`; };
    // other people's selections
    for (const pr of peers) {
      const s = pr.sel; if (!s || !Array.isArray(s.frameIds)) continue; const c = PEER_COLOR(pr.color);
      for (const fid of s.frameIds.slice(0, 50)) {
        const f = Canvas.frameById(doc, fid); if (!f || f.hidden) continue;
        if (s.frameIds.length === 1 && Array.isArray(s.blockIds) && s.blockIds.length) { for (const bid of s.blockIds.slice(0, 50)) { const b = Canvas.blockById(f, bid); if (b) parts.push(rect(f.x + b.x, f.y + b.y, b.w, b.h, `fill="none" stroke="${c}" stroke-width="1.5"`)); } }
        else parts.push(rect(f.x, f.y, FW(f), FH(f), `fill="none" stroke="${c}" stroke-width="2"`));
      }
    }
    if (hover && hover.frame && !(drag && drag.type)) {
      const hf = hover.frame; const b = hover.block;
      parts.push(b ? rect(hf.x + b.x, hf.y + b.y, b.w, b.h, 'fill="none" stroke="var(--accent)" stroke-opacity=".6" stroke-width="1"') : rect(hf.x, hf.y, FW(hf), FH(hf), 'fill="none" stroke="var(--accent)" stroke-opacity=".6" stroke-width="1"'));
    }
    const frames = selFrames(); const blocks = selBlocks();
    for (const f of frames) parts.push(rect(f.x, f.y, FW(f), FH(f), `fill="none" stroke="var(--accent)" stroke-width="${blocks.length ? 1 : 2}" stroke-opacity="${blocks.length ? .45 : 1}"`));
    const f = selFrame();
    if (f && frames.length === 1) {
      if (blocks.length) {
        const gb = blocks.length > 1 ? Canvas.bounds(blocks) : null;
        for (const b of blocks) {
          const q = toScreen(f.x + b.x, f.y + b.y); const w = b.w * Z, h = b.h * Z;
          parts.push(`<rect x="${q.x}" y="${q.y}" width="${w}" height="${h}" fill="none" stroke="${b.overflow ? 'var(--danger)' : 'var(--accent)'}" stroke-width="1.5"/>`);
          if (blocks.length === 1) {
            if (!b.locked && !(editing && editing.blockId === b.id)) for (const hnd of handles(q.x, q.y, w, h)) parts.push(`<rect class="cv-handle" x="${hnd.x - HANDLE / 2}" y="${hnd.y - HANDLE / 2}" width="${HANDLE}" height="${HANDLE}" fill="#fff" stroke="var(--accent)" stroke-width="1.5"/>`);
            parts.push(`<text x="${q.x}" y="${q.y - 6}" fill="var(--accent)" font-size="11" font-family="var(--font-mono)">${esc(b.group ? 'group · ' : '')}${esc(b.role || b.kind)} ${Math.round(b.w)}×${Math.round(b.h)}</text>`);
          }
        }
        if (gb) { const q = toScreen(f.x + gb.x, f.y + gb.y); parts.push(`<rect x="${q.x - 3}" y="${q.y - 3}" width="${gb.w * Z + 6}" height="${gb.h * Z + 6}" fill="none" stroke="var(--accent)" stroke-dasharray="4 3" stroke-width="1"/><text x="${q.x}" y="${q.y - 8}" fill="var(--accent)" font-size="11" font-family="var(--font-mono)">${blocks[0].group && blocks.every(b => b.group === blocks[0].group) ? 'group' : blocks.length + ' blocks'} ${Math.round(gb.w)}×${Math.round(gb.h)}</text>`); }
      } else {
        const p = toScreen(f.x, f.y); const W = FW(f) * Z, H = FH(f) * Z;
        if (!f.locked) for (const hnd of handles(p.x, p.y, W, H)) parts.push(`<rect class="cv-handle" x="${hnd.x - HANDLE / 2}" y="${hnd.y - HANDLE / 2}" width="${HANDLE}" height="${HANDLE}" fill="#fff" stroke="var(--accent)" stroke-width="1.5"/>`);
        parts.push(`<text x="${p.x}" y="${p.y + H + 16}" fill="var(--fg-3)" font-size="11" font-family="var(--font-mono)">${FW(f)}×${FH(f)}</text>`);
      }
    }
    if (frames.length > 1) { const b = Canvas.framesBounds(frames); const p = toScreen(b.x, b.y); parts.push(`<rect x="${p.x - 6}" y="${p.y - 6}" width="${b.w * Z + 12}" height="${b.h * Z + 12}" fill="none" stroke="var(--accent)" stroke-dasharray="5 4" stroke-width="1"/><text x="${p.x - 6}" y="${p.y + b.h * Z + 22}" fill="var(--accent)" font-size="11" font-family="var(--font-mono)">${frames.length} screens</text>`); }
    for (const g of guides) {
      if (g.axis === 'x') { const a = toScreen(g.v, g.from), b = toScreen(g.v, g.to); parts.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#FF3B8D" stroke-width="1"/>`); }
      else { const a = toScreen(g.from, g.v), b = toScreen(g.to, g.v); parts.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#FF3B8D" stroke-width="1"/>`); }
    }
    if (drag && drag.type === 'draw-frame' && drag.moved) { const a = toScreen(Math.min(drag.start.x, drag.cur.x), Math.min(drag.start.y, drag.cur.y)); const w = Math.abs(drag.cur.x - drag.start.x), h = Math.abs(drag.cur.y - drag.start.y); parts.push(`<rect x="${a.x}" y="${a.y}" width="${w * Z}" height="${h * Z}" fill="rgba(216,201,163,.06)" stroke="var(--accent)" stroke-dasharray="6 4" stroke-width="1.5"/><text x="${a.x}" y="${a.y - 6}" fill="var(--accent)" font-size="11" font-family="var(--font-mono)">${Math.round(w / 8) * 8}×${Math.round(h / 8) * 8}</text>`); }
    if (dropTarget) { const a = toScreen(dropTarget.x, dropTarget.y); parts.push(`<rect x="${a.x}" y="${a.y}" width="${FW(dropTarget) * Z}" height="${FH(dropTarget) * Z}" fill="rgba(216,201,163,.1)" stroke="var(--accent)" stroke-dasharray="6 4" stroke-width="2"/><text x="${a.x + 8}" y="${a.y + 18}" fill="var(--accent)" font-size="12" font-weight="600" font-family="var(--font-mono)">Move into ${esc(dropTarget.name)}</text>`); }
    if (drag && drag.type === 'marquee') { const a = toScreen(Math.min(drag.start.x, drag.cur.x), Math.min(drag.start.y, drag.cur.y)); parts.push(`<rect x="${a.x}" y="${a.y}" width="${Math.abs(drag.cur.x - drag.start.x) * Z}" height="${Math.abs(drag.cur.y - drag.start.y) * Z}" fill="rgba(216,201,163,.08)" stroke="var(--accent)" stroke-dasharray="4 3"/>`); }
    // other people's cursors, last so they sit on top
    for (const pr of peers) {
      if (!pr.cursor || !Number.isFinite(pr.cursor.x) || !Number.isFinite(pr.cursor.y)) continue;
      const c = PEER_COLOR(pr.color); const p = toScreen(pr.cursor.x, pr.cursor.y); const name = String(pr.name || 'Someone').slice(0, 28);
      parts.push(`<g transform="translate(${p.x},${p.y})" class="cv-peer"><path d="M0 0 L0 17 L4.6 12.6 L7.6 19.4 L10.3 18.2 L7.4 11.6 L13.4 11.6 Z" fill="${c}" stroke="#fff" stroke-width="1.2"/><rect x="14" y="16" rx="5" height="19" width="${name.length * 6.6 + 14}" fill="${c}"/><text x="21" y="29.5" fill="#fff" font-size="11.5" font-weight="600" font-family="var(--font-ui, system-ui)">${esc(name)}</text></g>`);
    }
    ov.innerHTML = parts.join('');
  }
  function handles(x, y, w, h) {
    return [{ id: 'nw', x, y, cursor: 'nwse-resize' }, { id: 'n', x: x + w / 2, y, cursor: 'ns-resize' }, { id: 'ne', x: x + w, y, cursor: 'nesw-resize' }, { id: 'e', x: x + w, y: y + h / 2, cursor: 'ew-resize' }, { id: 'se', x: x + w, y: y + h, cursor: 'nwse-resize' }, { id: 's', x: x + w / 2, y: y + h, cursor: 'ns-resize' }, { id: 'sw', x, y: y + h, cursor: 'nesw-resize' }, { id: 'w', x, y: y + h / 2, cursor: 'ew-resize' }];
  }
  // Which handle is under the pointer: a single selected block's, or a single selected frame's.
  function handleAt(cx, cy) {
    const f = selFrame(); if (!f || selFrames().length !== 1) return null;
    const bs = selBlocks(); const r = stage().getBoundingClientRect(); const px = cx - r.left, py = cy - r.top; const Z = doc.view.zoom;
    let box, target;
    if (bs.length === 1) { if (bs[0].locked || (editing && editing.blockId === bs[0].id)) return null; const b = bs[0]; const q = toScreen(f.x + b.x, f.y + b.y); box = [q.x, q.y, b.w * Z, b.h * Z]; target = 'block'; }
    else if (!bs.length && !f.locked) { const q = toScreen(f.x, f.y); box = [q.x, q.y, FW(f) * Z, FH(f) * Z]; target = 'frame'; }
    else return null;
    for (const h of handles(...box)) if (Math.abs(px - h.x) <= HANDLE && Math.abs(py - h.y) <= HANDLE) return { id: h.id, cursor: h.cursor, target };
    return null;
  }

  // ---- Smart guides ----------------------------------------------------------------------------------------
  function nearest(edges, cands, th) { let out = null; for (const e of edges) for (const c of cands) { const d = c - e; if (Math.abs(d) <= th && (!out || Math.abs(d) < Math.abs(out.delta))) out = { delta: d, v: c }; } return out; }
  // Blocks inside one frame snap to the frame's edges, centre and margins, and to other blocks' edges and centres.
  function snapBlocks(f, moving, orig, dx, dy, u, free) {
    const x0 = Math.min(...moving.map((b, i) => orig[i].x)), y0 = Math.min(...moving.map((b, i) => orig[i].y));
    const x1 = Math.max(...moving.map((b, i) => orig[i].x + b.w)), y1 = Math.max(...moving.map((b, i) => orig[i].y + b.h));
    if (free) return { dx, dy, guides: [] };
    const th = 6 / doc.view.zoom; const W = FW(f), H = FH(f), g = f.layout.grid || {};
    const others = f.layout.blocks.filter(b => !moving.includes(b) && !b.hidden && !Canvas.isBackground(f, b));
    const xs = [0, W / 2, W], ys = [0, H / 2, H]; if (g.mx) xs.push(g.mx, W - g.mx); if (g.my) ys.push(g.my, H - g.my);
    for (const o of others) { xs.push(o.x, o.x + o.w / 2, o.x + o.w); ys.push(o.y, o.y + o.h / 2, o.y + o.h); }
    const gl = []; let ndx, ndy;
    const bx = nearest([x0 + dx, (x0 + x1) / 2 + dx, x1 + dx], xs, th);
    if (bx) { ndx = dx + bx.delta; gl.push({ axis: 'x', v: f.x + bx.v, from: f.y, to: f.y + H }); } else ndx = u > 1 ? Canvas.snap(x0 + dx, u) - x0 : dx;
    const by = nearest([y0 + dy, (y0 + y1) / 2 + dy, y1 + dy], ys, th);
    if (by) { ndy = dy + by.delta; gl.push({ axis: 'y', v: f.y + by.v, from: f.x, to: f.x + W }); } else ndy = u > 1 ? Canvas.snap(y0 + dy, u) - y0 : dy;
    return { dx: ndx, dy: ndy, guides: gl };
  }
  // Screens snap to other screens' edges and centres.
  function snapFrames(moving, orig, dx, dy, free) {
    if (free) return { dx, dy, guides: [] };
    const th = 8 / doc.view.zoom;
    const b = Canvas.framesBounds(moving.map((f, i) => ({ x: orig[i].x, y: orig[i].y, layout: f.layout })));
    const others = doc.frames.filter(f => !moving.includes(f) && !f.hidden);
    const xs = [], ys = []; for (const o of others) { xs.push(o.x, o.x + FW(o) / 2, o.x + FW(o)); ys.push(o.y, o.y + FH(o) / 2, o.y + FH(o)); }
    const gl = []; let ndx, ndy;
    const bx = nearest([b.x + dx, b.x + b.w / 2 + dx, b.x + b.w + dx], xs, th);
    if (bx) { ndx = dx + bx.delta; const ys2 = others.filter(o => [o.x, o.x + FW(o) / 2, o.x + FW(o)].includes(bx.v)); const lo = Math.min(b.y + dy, ...ys2.map(o => o.y)), hi = Math.max(b.y + b.h + dy, ...ys2.map(o => o.y + FH(o))); gl.push({ axis: 'x', v: bx.v, from: lo, to: hi }); } else ndx = Canvas.snap(b.x + dx, 8) - b.x;
    const by = nearest([b.y + dy, b.y + b.h / 2 + dy, b.y + b.h + dy], ys, th);
    if (by) { ndy = dy + by.delta; const xs2 = others.filter(o => [o.y, o.y + FH(o) / 2, o.y + FH(o)].includes(by.v)); const lo = Math.min(b.x + ndx, ...xs2.map(o => o.x)), hi = Math.max(b.x + b.w + ndx, ...xs2.map(o => o.x + FW(o))); gl.push({ axis: 'y', v: by.v, from: lo, to: hi }); } else ndy = Canvas.snap(b.y + dy, 8) - b.y;
    return { dx: ndx, dy: ndy, guides: gl };
  }

  // ---- Pointer interaction ----------------------------------------------------------------------------------
  function bindStage() {
    const st = stage();
    st.addEventListener('pointerdown', onDown); st.addEventListener('pointermove', onMove); st.addEventListener('pointerup', onUp); st.addEventListener('pointercancel', onUp);
    st.addEventListener('pointerleave', () => { emit('pointer', null); });
    st.addEventListener('dblclick', onDblClick);
    st.addEventListener('wheel', e => { if (e.target.closest && e.target.closest('.cv-editor')) return; e.preventDefault(); if (e.ctrlKey || e.metaKey) zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY); else { doc.view.x -= e.deltaX; doc.view.y -= e.deltaY; applyView(); } }, { passive: false });
    st.addEventListener('contextmenu', e => e.preventDefault());
    new ResizeObserver(() => active && drawOverlay()).observe(st);
    st.addEventListener('dragover', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); st.classList.add('drop'); } });
    st.addEventListener('dragleave', () => st.classList.remove('drop'));
    st.addEventListener('drop', async e => { st.classList.remove('drop'); const files = e.dataTransfer && [...e.dataTransfer.files]; if (!files || !files.length) return; e.preventDefault(); lastPointer = toWorld(e.clientX, e.clientY); for (const file of files) { try { if (env.importFile && await env.importFile(file)) continue; if (/^image\//.test(file.type)) await dropImage(file); else env.toast(`Can't open ${file.name}`); } catch (err) { env.toast(err.message); } } });
  }
  function onDblClick(e) {
    if (e.target.closest && e.target.closest('.cv-editor')) return;
    const p = toWorld(e.clientX, e.clientY);
    const lf = labelAt(p); if (lf) { select(lf.id, []); const inp = $('cvProps').querySelector('[data-f="name"]'); if (inp) { inp.focus(); inp.select(); } return; }
    const f = frameAt(p); if (!f) return;
    const b = blockAt(f, p);
    if (b && b.group && groupFocus !== b.group) { groupFocus = b.group; select(f.id, [b.id], { keepGroupFocus: true }); return; }
    if (b && (b.kind === 'text' || b.kind === 'list' || b.kind === 'button')) { startEdit(f, b); return; }
    if (!b) fitTo([f]);
  }
  function onDown(e) {
    if (e.target.closest && e.target.closest('.cv-editor')) return;
    if (editing) endEdit();
    if (e.button === 1 || tool === 'hand' || spaceDown || e.button === 2) { drag = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: doc.view.x, vy: doc.view.y }; stage().setPointerCapture(e.pointerId); stage().style.cursor = 'grabbing'; return; }
    const p = toWorld(e.clientX, e.clientY);
    if (tool === 'frame') { drag = { type: 'draw-frame', start: p, cur: p, moved: false }; stage().setPointerCapture(e.pointerId); return; }
    if (tool !== 'select') { placeTool(frameAt(p), p); return; }
    const h = handleAt(e.clientX, e.clientY);
    if (h) {
      const f = selFrame();
      if (h.target === 'frame') drag = { type: 'resize-frame', h: h.id, f, start: p, orig: { x: f.x, y: f.y, w: FW(f), h: FH(f) }, moved: false };
      else { const b = selBlocks()[0]; drag = { type: 'resize', h: h.id, b, f, start: p, orig: { x: b.x, y: b.y, w: b.w, h: b.h }, moved: false }; }
      stage().setPointerCapture(e.pointerId); return;
    }
    const lf = labelAt(p); if (lf) { frameClick(lf, e, p); return; }
    const f = frameAt(p);
    if (!f) { if (!e.shiftKey) select(null, []); drag = { type: 'marquee', start: p, cur: p, add: e.shiftKey }; stage().setPointerCapture(e.pointerId); return; }
    if (sel.frameIds.length > 1 && sel.frameIds.includes(f.id) && !e.shiftKey) { startFrameDrag(selFrames().filter(x => !x.locked), p, e, f); return; }
    const b = blockAt(f, p);
    if (!b) { frameClick(f, e, p); return; }
    if (e.altKey && !b.locked) {
      hist.push(doc);
      const src = (sel.frameId === f.id && sel.blockIds.includes(b.id)) ? selBlocks() : Canvas.groupMembers(f, b);
      const copies = src.map(x => { const c = Canvas.duplicateBlock(f, x, 0); c.x = x.x; c.y = x.y; return c; });
      const g = copies.length > 1 && src.every(x => x.group && x.group === src[0].group) ? 'g' + Canvas.uid() : null; if (g) copies.forEach(c => { c.group = g; });
      sel.frameId = f.id; sel.frameIds = [f.id]; sel.blockIds = copies.map(c => c.id); afterSelect();
      drag = { type: 'move', f, blocks: copies, start: p, orig: copies.map(c => ({ x: c.x, y: c.y })), moved: true }; rerenderFrame(f);
    } else {
      if (e.shiftKey && sel.frameId === f.id && sel.frameIds.length <= 1) { const ids = Canvas.groupMembers(f, b).map(x => x.id); const has = sel.blockIds.includes(b.id); select(f.id, has ? sel.blockIds.filter(i => !ids.includes(i)) : [...sel.blockIds, ...ids], { keepGroupFocus: true }); }
      else if (!(sel.frameId === f.id && sel.blockIds.includes(b.id))) select(f.id, [b.id]);
      const blocks = selBlocks().filter(x => !x.locked); if (!blocks.length) return;
      drag = { type: 'move', f, blocks, start: p, orig: blocks.map(x => ({ x: x.x, y: x.y })), moved: false };
    }
    stage().setPointerCapture(e.pointerId);
  }
  function frameClick(f, e, p) {
    if (e.shiftKey) { const ids = selFrames().map(x => x.id); selectFrames(ids.includes(f.id) ? ids.filter(i => i !== f.id) : [...ids, f.id]); return; }
    if (!(sel.frameIds.includes(f.id) && !sel.blockIds.length)) select(f.id, []);
    const frames = selFrames().filter(x => !x.locked);
    if (frames.includes(f)) startFrameDrag(frames, p, e, frames.length > 1 ? f : null);
  }
  // clickTo: a click (no drag) on one screen of a multi-selection narrows the selection to it, like Figma.
  function startFrameDrag(frames, p, e, clickTo) {
    if (!frames.length) return;
    let moved = false;
    if (e.altKey) {
      hist.push(doc); const b = Canvas.framesBounds(frames);
      frames = Canvas.pasteFrames(doc, frames, { x: b.x, y: b.y }); moved = true;
      sel.frameIds = frames.map(f => f.id); sel.frameId = frames[0].id; sel.blockIds = []; renderFrames(); afterSelect();
    }
    drag = { type: 'move-frames', frames, start: p, orig: frames.map(f => ({ x: f.x, y: f.y })), moved, clickTo: e.altKey ? null : clickTo };
    stage().setPointerCapture(e.pointerId);
  }
  let liveT = 0;
  function emitLive(ids) { const now = performance.now(); if (now - liveT < 40) return; liveT = now; emit('live', ids); }
  function onMove(e) {
    lastPointer = toWorld(e.clientX, e.clientY); emit('pointer', lastPointer);
    if (!drag) {
      const p = lastPointer; const lf = tool === 'select' ? labelAt(p) : null; const f = lf || (tool === 'select' ? frameAt(p) : null); const b = !lf && f && blockAt(f, p);
      const next = f ? { frame: f, block: b } : null;
      if ((next && next.frame) !== (hover && hover.frame) || (next && next.block) !== (hover && hover.block)) { hover = next; drawOverlay(); }
      else if (peers.length) drawOverlay();
      const h = handleAt(e.clientX, e.clientY);
      stage().style.cursor = tool === 'hand' || spaceDown ? 'grab' : h ? h.cursor : (b || lf) ? 'move' : tool === 'select' ? 'default' : 'crosshair';
      return;
    }
    const p = lastPointer;
    if (drag.type === 'pan') { doc.view.x = drag.vx + (e.clientX - drag.sx); doc.view.y = drag.vy + (e.clientY - drag.sy); applyView(); return; }
    if (drag.type === 'marquee') { drag.cur = p; drawOverlay(); return; }
    if (drag.type === 'draw-frame') { drag.cur = p; if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) * doc.view.zoom > 6) drag.moved = true; drawOverlay(); return; }
    const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) * doc.view.zoom < 3) return;
    if (!drag.moved) { drag.moved = true; hist.push(doc); }
    const free = e.shiftKey || !doc.grid.snap;
    const u = !free ? (drag.f ? drag.f.layout.grid.unit : 8) : 1;
    if (drag.type === 'move') {
      const s = snapBlocks(drag.f, drag.blocks, drag.orig, dx, dy, u, e.shiftKey);
      drag.blocks.forEach((b, i) => { b.x = Math.round(drag.orig[i].x + s.dx); b.y = Math.round(drag.orig[i].y + s.dy); });
      guides = s.guides;
      const over = frameAt(p); dropTarget = over && over !== drag.f && !over.locked ? over : null; if (dropTarget) guides = [];
      rerenderFrame(drag.f); drawOverlay(); liveProps(); emitLive([drag.f.id]);
    } else if (drag.type === 'move-frames') {
      const s = snapFrames(drag.frames, drag.orig, dx, dy, e.shiftKey);
      drag.frames.forEach((f, i) => { f.x = Math.round(drag.orig[i].x + s.dx); f.y = Math.round(drag.orig[i].y + s.dy); positionFrame(f); });
      guides = s.guides; drawOverlay(); liveProps(); emitLive(drag.frames.map(f => f.id));
    } else if (drag.type === 'resize') {
      const o = drag.orig; let x = o.x, y = o.y, w = o.w, h = o.h; const hd = drag.h;
      if (hd.includes('e')) w = o.w + dx; if (hd.includes('s')) h = o.h + dy; if (hd.includes('w')) { x = o.x + dx; w = o.w - dx; } if (hd.includes('n')) { y = o.y + dy; h = o.h - dy; }
      Canvas.resizeBlock(drag.f, drag.b, { x, y, w: Math.max(4, w), h: Math.max(4, h) }, u);
      rerenderFrame(drag.f); drawOverlay(); liveProps(); emitLive([drag.f.id]);
    } else if (drag.type === 'resize-frame') {
      const o = drag.orig; const f = drag.f; let x = o.x, y = o.y, w = o.w, h = o.h; const hd = drag.h; const s8 = v => free ? Math.round(v) : Canvas.snap(v, 8);
      if (hd.includes('e')) w = s8(o.w + dx); if (hd.includes('s')) h = s8(o.h + dy); if (hd.includes('w')) { w = s8(o.w - dx); x = o.x + o.w - w; } if (hd.includes('n')) { h = s8(o.h - dy); y = o.y + o.h - h; }
      w = Math.max(64, w); h = Math.max(64, h);
      f.x = x; f.y = y; f.layout.format = { ...f.layout.format, id: 'custom', name: 'Custom', w, h };
      rerenderFrame(f); drawOverlay(); liveProps(); emitLive([f.id]);
    }
  }
  function onUp(e) {
    if (!drag) return;
    const d = drag; drag = null; stage().style.cursor = tool === 'hand' ? 'grab' : 'default';
    const hadGuides = guides.length; guides = [];
    if (d.type === 'pan') { persist({ silent: true }); return; }
    if (d.type === 'marquee') {
      const x0 = Math.min(d.start.x, d.cur.x), y0 = Math.min(d.start.y, d.cur.y), x1 = Math.max(d.start.x, d.cur.x), y1 = Math.max(d.start.y, d.cur.y);
      if (x1 - x0 > 4 && y1 - y0 > 4) {
        const inside = doc.frames.filter(f => !f.hidden && f.x >= x0 && f.y >= y0 && f.x + FW(f) <= x1 && f.y + FH(f) <= y1).map(f => f.id);
        if (inside.length) { const base = d.add ? selFrames().map(f => f.id) : []; selectFrames([...new Set([...base, ...inside])]); }
        else {
          const f = frameAt({ x: x0, y: y0 }) || frameAt({ x: x1, y: y1 }) || doc.frames.find(fr => !fr.hidden && !(x1 < fr.x || x0 > fr.x + FW(fr) || y1 < fr.y || y0 > fr.y + FH(fr)));
          if (f) { const ids = f.layout.blocks.filter(b => !b.hidden && !b.locked && f.x + b.x >= x0 && f.y + b.y >= y0 && f.x + b.x + b.w <= x1 && f.y + b.y + b.h <= y1).map(b => b.id); if (ids.length) select(f.id, ids); }
        }
      }
      drawOverlay(); return;
    }
    if (d.type === 'draw-frame') {
      const w = Math.abs(d.cur.x - d.start.x), h = Math.abs(d.cur.y - d.start.y);
      if (d.moved && w * doc.view.zoom > 12 && h * doc.view.zoom > 12) createFrame({ x: Math.min(d.start.x, d.cur.x), y: Math.min(d.start.y, d.cur.y), format: Canvas.customFormat(w, h) });
      else createFrame({ x: d.start.x, y: d.start.y });
      setTool('select'); return;
    }
    if (d.type === 'move' && d.moved && dropTarget) {
      const dst = dropTarget; dropTarget = null;
      const ids = Canvas.transferBlocks(d.f, dst, d.blocks, dst.layout.grid.unit).map(b => b.id);
      if (d.f.autoLayout.mode !== 'none') Canvas.applyAutoLayout(d.f); if (dst.autoLayout.mode !== 'none') Canvas.applyAutoLayout(dst);
      rerenderFrame(d.f); rerenderFrame(dst); select(dst.id, ids, { keepGroupFocus: true }); persist(); updateUndo(); env.toast(`Moved into ${dst.name}`); return;
    }
    dropTarget = null;
    if (d.type === 'move-frames' && !d.moved && d.clickTo) { select(d.clickTo.id, []); return; }
    if (d.type === 'resize-frame' && d.moved) { regrid(d.f); if (d.f.autoLayout.mode !== 'none') Canvas.applyAutoLayout(d.f); rerenderFrame(d.f); }
    if (d.moved) {
      if (d.f && d.f.autoLayout && d.f.autoLayout.mode !== 'none' && d.type === 'move') { Canvas.applyAutoLayout(d.f); rerenderFrame(d.f); }
      persist(); updateUndo(); renderLayers(); renderProps(); drawOverlay();
    } else if (hadGuides) drawOverlay();
  }
  // An image dropped on a frame becomes an image block there; on empty canvas it becomes a frame of its own size.
  async function dropImage(file) {
    const asset = await env.addImage(file); const p = lastPointer || { x: 0, y: 0 }; const f = frameAt(p);
    const w = asset.w || 800, h = asset.h || 600;
    if (f) { hist.push(doc); const s = Math.min(1, (FW(f) * 0.6) / w, (FH(f) * 0.6) / h); const b = { id: Canvas.uid(), kind: 'image', x: Math.round(p.x - f.x - w * s / 2), y: Math.round(p.y - f.y - h * s / 2), w: Math.round(w * s), h: Math.round(h * s), asset: asset.id, focal: 'xMidYMid', radius: 0, decorative: false, path: 'image_' + Canvas.uid() }; f.layout.blocks.push(b); select(f.id, [b.id]); rerenderFrame(f); persist(); updateUndo(); return; }
    const nf = createFrame({ x: p.x - w / 2, y: p.y - h / 2, format: Canvas.customFormat(w, h), name: file.name.replace(/\.[^.]+$/, '') });
    mutate(() => { nf.layout.blocks.push({ id: Canvas.uid(), kind: 'image', x: 0, y: 0, w: FW(nf), h: FH(nf), asset: asset.id, focal: 'xMidYMid', radius: 0, decorative: false, path: 'image_1' }); }, { history: false, frames: [nf.id] });
  }
  function placeTool(f, p) {
    if (!f) { env.toast('Click inside a frame to add it there'); return; }
    hist.push(doc);
    const kindMap = { text: 'text', body: 'body', rect: 'rect', ellipse: 'ellipse', button: 'button', image: 'image', icon: 'icon', logo: 'logo' };
    const b = Canvas.newBlock(kindMap[tool] || 'text', f, env.getKit(), { x: p.x - f.x, y: p.y - f.y });
    if (!b) return;
    f.layout.blocks.push(b);
    if (f.autoLayout.mode !== 'none') Canvas.applyAutoLayout(f);
    const wasText = tool === 'text';
    select(f.id, [b.id]); setTool('select'); rerenderFrame(f); renderLayers(); renderProps(); drawOverlay(); persist(); updateUndo();
    if (b.kind === 'image') { const inp = $('cvProps').querySelector('[data-file="image"]'); if (inp) inp.click(); }
    if (wasText) startEdit(f, b, { noHistory: true });
  }
  // A blank frame of the toolbar's format (or a drawn custom size). With center, it lands in view on a free spot.
  function createFrame({ x, y, format, center, name, bg } = {}) {
    const kit = env.getKit(); const fmt = format || Grid.byId[$('cvFrameFormat').value] || Grid.byId.slide;
    const bgs = kit.colors.filter(c => c.role === 'background').map(c => c.hex).sort((a, b) => Color.luminance(b) - Color.luminance(a));
    let fx = x ?? 0, fy = y ?? 0;
    if (center) {
      const r = stage().getBoundingClientRect(); const c = r.width ? toWorld(r.left + r.width / 2, r.top + r.height / 2) : { x: 0, y: 0 }; fx = c.x - fmt.w / 2; fy = c.y - fmt.h / 2;
      const spot = freeSpot(fx, fy, fmt.w, fmt.h); fx = spot.x; fy = spot.y;
    }
    hist.push(doc);
    const nf = Canvas.blankFrame(doc, fmt, kit, { x: Canvas.snap(fx, 8), y: Canvas.snap(fy, 8), bg: bg || bgs[0] || '#FFFFFF', name });
    select(nf.id, []); if (active) renderAll(); persist(); updateUndo();
    if (center && active) { const r = stage().getBoundingClientRect(); const a = toScreen(nf.x, nf.y), b = toScreen(nf.x + fmt.w, nf.y + fmt.h); if (a.x < 0 || a.y < 0 || b.x > r.width || b.y > r.height) fitTo([nf]); }
    return nf;
  }
  // First spot to the right of (x, y) where a w×h frame overlaps nothing.
  function freeSpot(x, y, w, h, gap = 160) {
    const hits = (fx, fy) => doc.frames.filter(f => !f.hidden && !(fx + w + gap / 2 <= f.x || fx >= f.x + FW(f) + gap / 2 || fy + h + gap / 2 <= f.y || fy >= f.y + FH(f) + gap / 2));
    let guard = 0; let hs;
    while ((hs = hits(x, y)).length && guard++ < 200) x = Math.max(...hs.map(f => f.x + FW(f))) + gap;
    return { x, y };
  }
  // A row of new frames below a source frame (or at a free spot), used by variations and imports.
  function placeRow(layouts, anchor, opts = {}) {
    if (!layouts.length) return [];
    hist.push(doc);
    const W = layouts.reduce((t, L) => t + L.format.w, 0) + 160 * (layouts.length - 1); const H = Math.max(...layouts.map(L => L.format.h));
    let x = anchor ? anchor.x : 0, y = anchor ? anchor.y + FH(anchor) + 200 : (doc.frames.length ? Math.max(...doc.frames.map(f => f.y + FH(f))) + 240 : 0);
    let guard = 0; while (doc.frames.some(f => !f.hidden && !(x + W <= f.x || x >= f.x + FW(f) || y + H <= f.y || y >= f.y + FH(f))) && guard++ < 100) y += 160;
    const added = [];
    for (const [i, L] of layouts.entries()) { const f = Canvas.addFrame(doc, L, { x, y, name: opts.names ? opts.names[i] : opts.name }); x += L.format.w + 160; added.push(f); }
    selectFrames(added.map(f => f.id)); if (active) { renderAll(); fitTo(anchor ? [anchor, ...added] : added); } persist(); updateUndo();
    return added;
  }

  // Imported screens keep their relative positions and land below everything already on the canvas.
  function placeFrames(items, opts = {}) {
    if (!items.length) return [];
    hist.push(doc);
    const bx = Math.min(...items.map(i => i.x)), by = Math.min(...items.map(i => i.y));
    const ox = doc.frames.length ? Math.min(...doc.frames.map(f => f.x)) : 0;
    const oy = doc.frames.length ? Math.max(...doc.frames.map(f => f.y + FH(f))) + 320 : 0;
    const added = items.map(it => { const f = Canvas.addFrame(doc, it.layout, { x: Canvas.snap(ox + (it.x - bx), 8), y: Canvas.snap(oy + (it.y - by), 8), name: it.name }); f.clip = it.clip !== false; return f; });
    selectFrames(added.map(f => f.id)); if (active) { renderAll(); fitTo(added); } persist(); updateUndo();
    return added;
  }
  // Loose layers (no frame of their own) go into a frame, centred, keeping their arrangement.
  function insertBlocks(frameId, blocks) {
    const f = Canvas.frameById(doc, frameId); if (!f || !blocks.length) return [];
    hist.push(doc);
    const bb = Canvas.bounds(blocks); const dx = Math.round(Math.max(0, (FW(f) - bb.w) / 2) - bb.x), dy = Math.round(Math.max(0, (FH(f) - bb.h) / 2) - bb.y);
    const ids = blocks.map(b => { const c = Canvas.clone(b); c.id = Canvas.uid(); c.x += dx; c.y += dy; if (c.kind === 'text' || c.kind === 'list') Canvas.refit(c); f.layout.blocks.push(c); return c.id; });
    select(f.id, ids); rerenderFrame(f); renderLayers(); persist(); updateUndo();
    return ids;
  }

  // ---- Selection --------------------------------------------------------------------------------------------
  function expandGroups(f, ids) {
    const out = new Set();
    for (const id of ids) { const b = Canvas.blockById(f, id); if (!b) continue; if (b.group && b.group !== groupFocus) Canvas.groupMembers(f, b).forEach(x => out.add(x.id)); else out.add(id); }
    return [...out];
  }
  function select(frameId, blockIds, opts = {}) {
    if (editing && !opts.keepEditing) endEdit();
    const f = Canvas.frameById(doc, frameId);
    if (!opts.keepGroupFocus) groupFocus = null;
    if (groupFocus && f && !(blockIds || []).some(id => { const b = Canvas.blockById(f, id); return b && b.group === groupFocus; })) groupFocus = null;
    sel.frameId = f ? f.id : null; sel.blockIds = f ? expandGroups(f, blockIds || []) : []; sel.frameIds = f ? [f.id] : [];
    afterSelect();
  }
  function selectFrames(ids) {
    if (editing) endEdit();
    ids = [...new Set(ids)].filter(id => Canvas.frameById(doc, id));
    sel.frameIds = ids; sel.frameId = ids[0] || null; sel.blockIds = []; groupFocus = null;
    afterSelect();
  }
  function afterSelect() { if (!active) { emit('select', selection()); return; } renderLayers(); renderProps(); drawOverlay(); markLabels(); updateCount(); emit('select', selection()); }
  function selection() { return { frameIds: selFrames().map(f => f.id), frameId: sel.frameId, blockIds: sel.blockIds.slice() }; }

  // ---- On-canvas text editing -------------------------------------------------------------------------------
  function startEdit(f, b, opts = {}) {
    if (!f || !b || b.locked || !(b.kind === 'text' || b.kind === 'button' || b.kind === 'list')) return false;
    if (editing) endEdit();
    if (!opts.noHistory) { hist.push(doc); updateUndo(); }
    select(f.id, [b.id], { keepGroupFocus: true });
    const ed = document.createElement('div'); ed.className = 'cv-editor';
    ed.contentEditable = 'plaintext-only'; if (ed.contentEditable !== 'plaintext-only') ed.contentEditable = 'true';
    ed.spellcheck = true; ed.setAttribute('role', 'textbox'); ed.setAttribute('aria-label', 'Edit text');
    ed.textContent = b.kind === 'list' ? (b.items || []).join('\n') : b.kind === 'button' ? String(b.text || '') : Canvas.sourceText(b);
    editing = { frameId: f.id, blockId: b.id, el: ed, hide: b.kind !== 'button' };
    stage().appendChild(ed); positionEditor(); rerenderFrame(f); drawOverlay();
    ed.focus();
    try { const range = document.createRange(); range.selectNodeContents(ed); const s = getSelection(); s.removeAllRanges(); s.addRange(range); } catch { }
    ed.addEventListener('input', () => {
      const fr = Canvas.frameById(doc, f.id); const bl = fr && Canvas.blockById(fr, b.id); if (!bl) return;
      const t = ed.innerText.replace(/ /g, ' ');
      if (bl.kind === 'list') bl.items = t.split('\n').map(x => x.trim()).filter(Boolean); else if (bl.kind === 'button') bl.text = t.replace(/\s*\n+\s*/g, ' '); else bl.text = t.replace(/\n{3,}/g, '\n\n');
      Canvas.refit(bl); positionEditor(); if (!editing.hide) rerenderFrame(fr); drawOverlay(); emitLive([fr.id]);
    });
    ed.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (b.kind !== 'list' || e.metaKey || e.ctrlKey) && !e.shiftKey)) { e.preventDefault(); endEdit(); }
    });
    ed.addEventListener('blur', () => setTimeout(() => { if (editing && editing.el === ed) endEdit(); }, 0));
    ed.addEventListener('pointerdown', e => e.stopPropagation());
    return true;
  }
  function positionEditor() {
    if (!editing) return;
    const f = Canvas.frameById(doc, editing.frameId); const b = f && Canvas.blockById(f, editing.blockId); if (!b) { endEdit(true); return; }
    const Z = doc.view.zoom; const p = toScreen(f.x + b.x, f.y + b.y); const font = b.font || {}; const ed = editing.el;
    Object.assign(ed.style, {
      left: p.x + 'px', top: p.y + 'px', width: Math.max(24, b.w * Z) + 'px', minHeight: b.h * Z + 'px', fontFamily: font.family || 'inherit', fontSize: (font.size || 16) * Z + 'px', fontWeight: String(font.weight || 400),
      lineHeight: String(font.lineHeight || 1.2), letterSpacing: (font.letterSpacing || 0) + 'em', color: Render.col(b.kind === 'button' ? b.color : b.fill), textAlign: b.kind === 'button' ? 'center' : (b.align || 'left'),
      textTransform: font.transform === 'upper' ? 'uppercase' : font.transform === 'lower' ? 'lowercase' : 'none', fontStyle: font.style === 'italic' ? 'italic' : 'normal',
      paddingLeft: b.kind === 'list' ? (b.indent || 0) * Z + 'px' : '0',
    });
    if (b.kind === 'button') Object.assign(ed.style, { height: b.h * Z + 'px', minHeight: '0', display: 'flex', alignItems: 'center', justifyContent: 'center', background: Render.col(b.fill), borderRadius: (b.radius || 0) * Z + 'px' });
  }
  function endEdit(cancel) {
    if (!editing) return;
    const ed = editing; editing = null; ed.el.remove();
    const f = Canvas.frameById(doc, ed.frameId);
    if (f) {
      const b = Canvas.blockById(f, ed.blockId);
      if (b && b.kind === 'text' && !Canvas.sourceText(b).trim() && !cancel) { Canvas.removeBlocks(f, [b.id]); sel.blockIds = sel.blockIds.filter(i => i !== b.id); }
      if (f.autoLayout.mode !== 'none') Canvas.applyAutoLayout(f);
      rerenderFrame(f);
    }
    persist(); updateUndo(); renderLayers(); renderProps(); drawOverlay();
  }

  // ---- Keyboard --------------------------------------------------------------------------------------------
  function bindKeys() {
    document.addEventListener('keydown', e => {
      if (!active || editing) return;
      const tag = (e.target.tagName || '').toLowerCase(); const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
      if (e.target.closest && e.target.closest('.modal:not([hidden]), .agent-panel')) return;
      if (e.key === ' ' && !typing) { spaceDown = true; stage().style.cursor = 'grab'; e.preventDefault(); return; }
      const meta = e.metaKey || e.ctrlKey; const k = e.key.toLowerCase();
      if (meta && k === 'z' && !typing) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (meta && k === 'y' && !typing) { e.preventDefault(); redo(); return; }
      if (meta && k === 'l') { e.preventDefault(); copyLink(); return; }
      if (typing) return;
      if (meta && k === 'd') { e.preventDefault(); duplicateSelection(); return; }
      if (meta && k === 'c') { if (copySelection()) e.preventDefault(); return; }
      if (meta && k === 'x') { if (copySelection()) { e.preventDefault(); deleteSelection(); } return; }
      if (meta && k === 'v') { if (clipboard) { e.preventDefault(); pasteClipboard(); } return; }
      if (meta && k === 'g') { e.preventDefault(); if (e.shiftKey) ungroupSelection(); else groupSelection(); return; }
      if (meta && k === 'a') { e.preventDefault(); const f = selFrame(); if (f && selFrames().length === 1) select(f.id, f.layout.blocks.filter(b => !b.hidden && !b.locked).map(b => b.id)); else selectFrames(doc.frames.filter(x => !x.hidden).map(x => x.id)); return; }
      if (e.shiftKey && !meta && k === 'n') { e.preventDefault(); createFrame({ center: true }); return; }
      if (e.shiftKey && !meta && k === 'g') { e.preventDefault(); const fs = selFrames(); const on = !fs.every(f => f.showGrid); fs.forEach(f => { f.showGrid = on; rerenderFrame(f); }); persist(); return; }
      if (e.shiftKey && !meta && k === 'r') { e.preventDefault(); const fs = selFrames(); if (fs.length) { mutate(() => Canvas.tidy(fs, fs.length > 3 ? 'grid' : 'row')); env.toast('Tidied'); } return; }
      if (k === 'enter') {
        e.preventDefault(); const f = selFrame(); const bs = selBlocks();
        if (f && bs.length === 1 && (bs[0].kind === 'text' || bs[0].kind === 'button' || bs[0].kind === 'list')) startEdit(f, bs[0]);
        else if (f && bs.length && bs[0].group && bs.every(b => b.group === bs[0].group)) { groupFocus = bs[0].group; select(f.id, [bs[0].id], { keepGroupFocus: true }); }
        else if (f && !bs.length && selFrames().length === 1) select(f.id, f.layout.blocks.filter(b => !b.hidden && !Canvas.isBackground(f, b)).map(b => b.id));
        return;
      }
      if (!meta && !e.altKey) {
        if (k === 'v') return setTool('select'); if (k === 'h') return setTool('hand'); if (k === 't') return setTool('text'); if (k === 'r') return setTool('rect'); if (k === 'o') return setTool('ellipse'); if (k === 'f') return setTool('frame'); if (k === 'i') return setTool('image');
      }
      if (k === 'escape') {
        const f = selFrame();
        if (tool !== 'select') setTool('select');
        else if (groupFocus && f) { const g = groupFocus; groupFocus = null; select(f.id, f.layout.blocks.filter(b => b.group === g).map(b => b.id)); }
        else if (sel.blockIds.length) select(sel.frameId, []); else select(null, []);
        return;
      }
      if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSelection(); return; }
      if (k === '0' && !meta) { fit(); return; } if (k === '=' || k === '+') { zoomBy(1.2); return; } if (k === '-') { zoomBy(1 / 1.2); return; }
      if (k === '1' && e.shiftKey) { fit(); return; } if (k === '2' && e.shiftKey) { const fs = selFrames(); if (fs.length) fitTo(fs); return; }
      if (k.startsWith('arrow')) {
        const fs = selFrames(); const f = selFrame(); const bs = selBlocks().filter(b => !b.locked); if (!fs.length) return; e.preventDefault();
        const step = e.shiftKey ? (f ? f.layout.grid.unit : 8) : 1; const dx = k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0, dy = k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0;
        hist.push(doc);
        if (bs.length && fs.length === 1) { bs.forEach(b => { b.x += dx; b.y += dy; }); rerenderFrame(f); } else fs.filter(x => !x.locked).forEach(x => { x.x += dx; x.y += dy; positionFrame(x); });
        drawOverlay(); liveProps(); persist(); updateUndo(); return;
      }
      if (k === '[' || k === ']') { const f = selFrame(); const bs = selBlocks(); if (!f || !bs.length) return; hist.push(doc); bs.forEach(b => Canvas.reorder(f, b, k === '[' ? (e.shiftKey ? 'back' : -1) : (e.shiftKey ? 'front' : 1))); rerenderFrame(f); renderLayers(); persist(); updateUndo(); }
    });
    document.addEventListener('keyup', e => { if (e.key === ' ') { spaceDown = false; if (active) stage().style.cursor = tool === 'hand' ? 'grab' : 'default'; } });
    // JSON copied from another tab or session pastes as blocks or frames.
    document.addEventListener('paste', e => {
      if (!active || editing) return; const tag = (e.target.tagName || '').toLowerCase(); if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
      if (env.onPaste && env.onPaste(e)) return; // Figma and captured pages
      const text = e.clipboardData && e.clipboardData.getData('text/plain'); if (!text || text[0] !== '{') return;
      try { const j = JSON.parse(text); if (j && j.lgClip && /^(blocks|frame|frames)$/.test(j.lgClip.type)) { e.preventDefault(); pasteClipboard(j.lgClip); } } catch { }
    });
  }
  function setTool(t) { tool = t; document.querySelectorAll('#cvTools [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t)); stage().style.cursor = t === 'hand' ? 'grab' : t === 'select' ? 'default' : 'crosshair'; }
  function undo() { if (editing) endEdit(); const d = hist.undo(doc); if (d) { doc = undoMerge ? undoMerge(doc, d) : d; validateSelection(); persist(); renderAll(); } }
  function redo() { if (editing) endEdit(); const d = hist.redo(doc); if (d) { doc = undoMerge ? undoMerge(doc, d) : d; validateSelection(); persist(); renderAll(); } }
  function deleteSelection() {
    const fs = selFrames(); if (!fs.length) return; hist.push(doc);
    const f = selFrame();
    if (sel.blockIds.length && f) { Canvas.removeBlocks(f, sel.blockIds); if (f.autoLayout.mode !== 'none') Canvas.applyAutoLayout(f); select(f.id, []); rerenderFrame(f); }
    else { const ids = new Set(fs.map(x => x.id)); doc.frames = doc.frames.filter(x => !ids.has(x.id)); select(null, []); renderAll(); }
    persist(); updateUndo(); renderLayers();
  }
  function duplicateSelection() {
    const fs = selFrames(); if (!fs.length) return; hist.push(doc);
    const f = selFrame();
    if (sel.blockIds.length && f) {
      const src = selBlocks(); const g = src.length > 1 && src.every(b => b.group && b.group === src[0].group) ? 'g' + Canvas.uid() : null;
      const ids = src.map(b => { const c = Canvas.duplicateBlock(f, b, f.layout.grid.unit); if (g) c.group = g; return c.id; });
      select(f.id, ids, { keepGroupFocus: true }); rerenderFrame(f);
    } else { const b = Canvas.framesBounds(fs); const out = Canvas.pasteFrames(doc, fs, { x: b.x + b.w + 160, y: b.y }); selectFrames(out.map(x => x.id)); renderAll(); }
    persist(); updateUndo(); renderLayers(); renderProps();
  }
  function groupSelection() {
    const f = selFrame(); const bs = selBlocks(); if (!f || bs.length < 2) { env.toast('Select two or more blocks to group'); return; }
    hist.push(doc); const g = Canvas.group(f, bs); groupFocus = null; select(f.id, bs.map(b => b.id)); persist(); updateUndo(); env.toast(`Grouped ${bs.length} blocks`); return g;
  }
  function ungroupSelection() {
    const f = selFrame(); const bs = selBlocks(); if (!f || !bs.some(b => b.group)) return;
    hist.push(doc); const n = Canvas.ungroup(f, bs); groupFocus = null; select(f.id, bs.map(b => b.id)); persist(); updateUndo(); env.toast(n > 1 ? `Ungrouped ${n} groups` : 'Ungrouped');
  }

  // ---- Clipboard: blocks or screens, inside the app and as JSON on the system clipboard -------------------------
  function copySelection() {
    const fs = selFrames(); if (!fs.length) return false;
    const bs = selBlocks();
    clipboard = bs.length && fs.length === 1 ? { type: 'blocks', frameId: fs[0].id, blocks: bs.map(b => Canvas.clone(b)) } : { type: 'frames', frames: fs.map(f => Canvas.clone(f)) };
    try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(JSON.stringify({ lgClip: clipboard })).catch(() => { }); } catch { }
    env.toast(clipboard.type === 'blocks' ? `Copied ${bs.length} block${bs.length > 1 ? 's' : ''}` : fs.length > 1 ? `Copied ${fs.length} screens` : `Copied frame ${fs[0].name}`);
    if (active && !propsFocused()) renderProps();
    return true;
  }
  function pasteClipboard(clip = clipboard) {
    if (!clip) { env.toast('Nothing to paste yet. Select blocks or screens and press ⌘C.'); return; }
    if (clip.type === 'frame') clip = { type: 'frames', frames: [clip.frame] };
    hist.push(doc);
    if (clip.type === 'frames') {
      const srcs = clip.frames.filter(f => f && f.layout && Array.isArray(f.layout.blocks)); if (!srcs.length) return;
      const b = Canvas.framesBounds(srcs); const spot = freeSpot(b.x + b.w + 160, b.y, b.w, b.h);
      const out = Canvas.pasteFrames(doc, srcs, spot); selectFrames(out.map(f => f.id)); renderAll(); persist(); updateUndo();
      if (active) { const r = stage().getBoundingClientRect(); const a = toScreen(spot.x, spot.y); if (a.x > r.width || a.y > r.height || a.x < 0 || a.y < 0) fitTo(out); }
      return;
    }
    const f = (selFrames().length === 1 && selFrame()) || (lastPointer && frameAt(lastPointer)) || doc.frames[doc.frames.length - 1];
    if (!f) { env.toast('Add a frame to paste into'); return; }
    const same = f.id === clip.frameId; const u = f.layout.grid.unit;
    const out = Canvas.pasteBlocks(f, clip.blocks, { dx: same ? 2 * u : 0, dy: same ? 2 * u : 0 });
    const groups = new Map(); for (const c of out) if (c.group) { if (!groups.has(c.group)) groups.set(c.group, 'g' + Canvas.uid()); c.group = groups.get(c.group); }
    if (same) clip.blocks.forEach(b => { b.x += 2 * u; b.y += 2 * u; });
    if (f.autoLayout.mode !== 'none') Canvas.applyAutoLayout(f);
    select(f.id, out.map(b => b.id)); rerenderFrame(f); renderLayers(); persist(); updateUndo();
  }

  // ---- Toolbar ------------------------------------------------------------------------------------------------
  function bindToolbar() {
    $('cvTools').addEventListener('click', e => { const b = e.target.closest('[data-tool]'); if (b) setTool(b.dataset.tool); });
    $('cvNewFrame').addEventListener('click', () => createFrame({ center: true }));
    $('cvZoomIn').addEventListener('click', () => zoomBy(1.25)); $('cvZoomOut').addEventListener('click', () => zoomBy(1 / 1.25)); $('cvFit').addEventListener('click', fit);
    $('cvUndo').addEventListener('click', undo); $('cvRedo').addEventListener('click', redo);
    $('cvSnap').addEventListener('change', e => { doc.grid.snap = e.target.checked; persist(); });
    $('cvLink').addEventListener('click', copyLink);
    $('cvSave').addEventListener('click', async () => { const blob = new Blob([Canvas.serialize(doc)], { type: 'application/json' }); if (await env.download(blob, `${slug(doc.name)}-canvas.json`)) env.toast('Canvas saved as JSON'); });
    $('cvLoad').addEventListener('change', async e => { const f = e.target.files[0]; if (!f) return; try { if (env.importFile && await env.importFile(f)) { e.target.value = ''; return; } hist.push(doc); doc = Canvas.deserialize(await f.text()); select(null, []); renderAll(); fit(); persist(); env.toast('Canvas loaded'); } catch (err) { env.toast('Could not load: ' + err.message); } e.target.value = ''; });
    $('cvClear').addEventListener('click', () => { if (!doc.frames.length) return; hist.push(doc); doc.frames = []; select(null, []); renderAll(); persist(); updateUndo(); });
    $('cvExport').addEventListener('click', async e => {
      const b = e.target.closest('[data-export]'); if (!b) return; const what = b.dataset.export;
      const t = b.textContent; b.disabled = true; b.textContent = '…';
      try { await exportAction(what); } catch (err) { console.error(err); env.toast('Export failed: ' + err.message); } finally { b.disabled = false; b.textContent = t; $('cvExport').removeAttribute('open'); }
    });
  }
  const slug = s => String(s || 'canvas').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'canvas';
  async function copyText(text) { try { await navigator.clipboard.writeText(text); } catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } finally { ta.remove(); } } }
  // Every export works on the selected screens; with nothing selected, on every visible frame.
  async function exportAction(what, framesArg) {
    const chosen = framesArg || selFrames(); const all = doc.frames.filter(x => !x.hidden);
    const frames = chosen.length ? chosen : all;
    const needOne = ['react', 'html'];
    if (!frames.length) { env.toast('Nothing to export'); return; }
    if (needOne.includes(what)) {
      const f = frames[0]; const code = what === 'react' ? Canvas.toReact(f, { assets: env.getAssets(), kit: env.getKit() }) : Canvas.toHTML(f, { assets: env.getAssets(), kit: env.getKit() });
      await copyText(code); env.toast(`${what === 'react' ? 'React + Tailwind' : 'HTML/CSS'} for ${f.name} copied`); return;
    }
    if (what === 'png' || what === 'png2' || what === 'svg') {
      let n = 0; const scale = what === 'png2' ? 2 : 1;
      for (const fr of frames) {
        const blob = what === 'svg' ? new Blob([await env.exportSVG(fr.layout)], { type: 'image/svg+xml' }) : await env.exportPNG(fr.layout, scale);
        if (!(await env.download(blob, `${slug(fr.name)}${scale > 1 ? '@2x' : ''}.${what === 'svg' ? 'svg' : 'png'}`))) break; n++;
        if (frames.length > 1) await new Promise(r => setTimeout(r, 350));
      }
      if (n) env.toast(`${n} ${what === 'svg' ? 'SVG' : 'PNG'}${n > 1 ? 's' : ''} saved${scale > 1 ? ' at 2×' : ''}`); return;
    }
    if (what === 'pdf') { env.toast(`Building a ${frames.length}-page PDF…`); const blob = await env.exportPDF(frames.map(f => f.layout)); if (blob && await env.download(blob, `${slug(frames.length === 1 ? frames[0].name : doc.name)}.pdf`)) env.toast(`PDF saved: ${frames.length} page${frames.length > 1 ? 's' : ''}`); return; }
    if (what === 'pptx') {
      const groups = new Map(); for (const f of frames) { const k = `${FW(f)}x${FH(f)}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(f); }
      let n = 0; for (const [k, list] of groups) { const blob = await env.buildPptx(list.map(x => x.layout)); if (!(await env.download(blob, `${slug(doc.name)}-${k}.pptx`))) break; n += list.length; }
      if (n) env.toast(`PPTX saved: ${n} slide${n > 1 ? 's' : ''}${groups.size > 1 ? `, one file per size` : ''}`); return;
    }
    if (what === 'canvas') { const blob = await exportCanvasPNG(); if (blob && await env.download(blob, `${slug(doc.name)}-canvas.png`)) env.toast('Canvas PNG saved'); return; }
    if (what === 'all') return exportAction('png', all);
    if (what === 'allpdf') return exportAction('pdf', all);
  }
  async function copyLink() {
    try {
      if (env.shareLink) { const s = await env.shareLink(); if (s) return; }
      const link = await Canvas.toLink(doc);
      await copyText(link);
      const hasImages = doc.frames.some(f => f.layout.blocks.some(b => b.kind === 'image'));
      env.toast(link.length > 60000 ? 'Link copied (very long; a hosted room keeps it short)' : hasImages ? 'Link copied: layout and copy travel, images do not' : 'Link copied');
    } catch (err) { env.toast('Could not build a link: ' + err.message); }
  }
  async function exportCanvasPNG() {
    const frames = doc.frames.filter(f => !f.hidden); if (!frames.length) { env.toast('Nothing on the canvas'); return null; }
    const margin = 120; const bb = Canvas.framesBounds(frames); const x0 = bb.x - margin, y0 = bb.y - margin, x1 = bb.x + bb.w + margin, y1 = bb.y + bb.h + margin;
    const scale = Math.min(1, 7000 / Math.max(x1 - x0, y1 - y0));
    const c = document.createElement('canvas'); c.width = Math.round((x1 - x0) * scale); c.height = Math.round((y1 - y0) * scale);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#1b1b22'; ctx.fillRect(0, 0, c.width, c.height);
    for (const f of frames) { const blob = await env.exportPNG(f.layout); const url = URL.createObjectURL(blob); try { const img = new Image(); await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; }); ctx.drawImage(img, (f.x - x0) * scale, (f.y - y0) * scale, FW(f) * scale, FH(f) * scale); } finally { URL.revokeObjectURL(url); } }
    return new Promise(res => c.toBlob(res, 'image/png'));
  }

  // ---- Layers panel ----------------------------------------------------------------------------------------------
  function label(b) { if (b.label) return b.label; if (b.kind === 'text') return `${b.role || 'text'} · ${Canvas.sourceText(b).slice(0, 28)}`; if (b.kind === 'list') return `${b.role || 'list'} · ${(b.items || []).length} items`; if (b.kind === 'button') return `button · ${b.text}`; if (b.kind === 'image') return 'image'; if (b.kind === 'field') return b.container ? 'card' : 'rectangle'; if (b.kind === 'shape') return b.shape; if (b.kind === 'icon') return `icon · ${b.name}`; if (b.kind === 'vector') return 'vector'; return b.kind; }
  const KIND_GLYPH = { text: 'T', list: '≡', button: '▭', image: '▣', field: '■', shape: '●', icon: '✦', logo: 'L', scrim: '▒', rule: '—', line: '—', badge: '①', vector: '✎' };
  function renderLayers() {
    if (!active) return;
    const q = ($('cvSearch').value || '').toLowerCase();
    const multi = sel.frameIds.length > 1;
    $('cvLayers').innerHTML = doc.frames.slice().reverse().map(f => {
      const blocks = f.layout.blocks.slice().reverse().filter(b => !q || label(b).toLowerCase().includes(q));
      if (q && !blocks.length && !String(f.name).toLowerCase().includes(q)) return '';
      const fon = sel.frameIds.includes(f.id) && (!sel.blockIds.length || multi);
      const open = !multi && sel.frameId === f.id || q;
      return `<div class="cv-layer-frame ${fon ? 'on' : ''}" data-frame="${esc(f.id)}">
        <div class="cv-layer-row frame"><button class="eye ${f.hidden ? 'off' : ''}" data-eye-frame="${esc(f.id)}" title="Toggle visibility">${f.hidden ? '◌' : '◉'}</button><span class="nm" title="${esc(f.name)}">${esc(f.name)}</span><span class="dim">${FW(f)}×${FH(f)}</span></div>
        ${open ? `<div class="cv-layer-children">${blocks.map(b => `<div class="cv-layer-row block ${sel.frameId === f.id && sel.blockIds.includes(b.id) ? 'on' : ''} ${b.hidden ? 'hidden-layer' : ''} ${b.group ? 'grouped' : ''}" data-frame="${esc(f.id)}" data-block="${esc(b.id)}"><span class="glyph">${KIND_GLYPH[b.kind] || '·'}</span><span class="nm">${esc(label(b))}</span>${b.group ? '<span class="tag" title="In a group">G</span>' : ''}${b.locked ? '<span class="dim">🔒</span>' : ''}<button class="eye ${b.hidden ? 'off' : ''}" data-eye="${esc(b.id)}" title="Toggle visibility">${b.hidden ? '◌' : '◉'}</button></div>`).join('')}</div>` : ''}
      </div>`;
    }).join('') || '<div class="hint" style="padding:10px">No frames yet. Send layouts here from Single or Deck mode, add a frame with ＋ Frame, or paste from Figma.</div>';
  }
  function bindLayers() {
    $('cvLayers').addEventListener('click', e => {
      const eyeF = e.target.closest('[data-eye-frame]'); if (eyeF) { const f = Canvas.frameById(doc, eyeF.dataset.eyeFrame); hist.push(doc); f.hidden = !f.hidden; rerenderFrame(f); renderLayers(); persist(); updateUndo(); return; }
      const eye = e.target.closest('[data-eye]'); if (eye) { const f = Canvas.frameById(doc, eye.closest('[data-frame]').dataset.frame); const b = Canvas.blockById(f, eye.dataset.eye); hist.push(doc); b.hidden = !b.hidden; rerenderFrame(f); renderLayers(); persist(); updateUndo(); return; }
      const row = e.target.closest('.cv-layer-row'); if (!row) return;
      const fid = row.closest('[data-frame]').dataset.frame;
      if (row.dataset.block) { if (e.shiftKey && sel.frameId === fid) select(fid, sel.blockIds.includes(row.dataset.block) ? sel.blockIds.filter(i => i !== row.dataset.block) : [...sel.blockIds, row.dataset.block], { keepGroupFocus: true }); else { const f = Canvas.frameById(doc, fid); const b = Canvas.blockById(f, row.dataset.block); if (b && b.group) groupFocus = b.group; select(fid, [row.dataset.block], { keepGroupFocus: true }); } }
      else if (e.shiftKey || e.metaKey || e.ctrlKey) { const ids = selFrames().map(f => f.id); selectFrames(ids.includes(fid) ? ids.filter(i => i !== fid) : [...ids, fid]); }
      else select(fid, []);
    });
    $('cvLayers').addEventListener('dblclick', e => { const row = e.target.closest('.cv-layer-row.frame'); if (!row) return; const f = Canvas.frameById(doc, row.closest('[data-frame]').dataset.frame); if (f) fitTo([f]); });
    $('cvSearch').addEventListener('input', renderLayers);
  }

  // ---- Properties panel ------------------------------------------------------------------------------------------
  const num = (k, label, v, step = 1, extra = '') => `<label class="cv-f"><span>${label}</span><input type="number" data-p="${k}" value="${Math.round((Number(v) || 0) * 100) / 100}" step="${step}" ${extra}></label>`;
  const swatches = (k, v, token) => `<div class="cv-swatches">${env.getKit().colors.map(c => `<button type="button" class="sw ${v && toHex(c.hex) === toHex(v) ? 'on' : ''}" data-sw="${toHex(c.hex)}" data-sw-name="${esc(c.name || '')}" data-for="${k}" title="${esc(c.name || '')} ${toHex(c.hex)}" style="background:${toHex(c.hex)}"></button>`).join('')}<button type="button" class="sw edit" data-act="edit-palette" title="Edit the brand palette">✎</button>${token ? `<span class="cv-token" title="Bound to the palette color ${esc(token)}: it follows palette edits">${esc(token)}</span>` : ''}</div>`;
  const color = (k, label, v, token) => `<label class="cv-f"><span>${label}</span><span class="cv-color"><input type="color" data-p="${k}" value="${toHex(v)}"><input type="text" data-p="${k}" value="${esc(v)}" class="hex"></span></label>${swatches(k, v, token)}`;
  const selectF = (k, label, v, opts) => `<label class="cv-f"><span>${label}</span><select data-p="${k}">${opts.map(o => `<option value="${esc(o[0])}" ${String(o[0]) === String(v) ? 'selected' : ''}>${esc(o[1])}</option>`).join('')}</select></label>`;
  const btn = (act, text, extra = '') => `<button type="button" class="btn small" data-act="${act}" ${extra}>${text}</button>`;
  const ROLES = ['core', 'accent', 'background', 'neutral'];
  function paletteEditor() {
    const kit = env.getKit();
    return `<div class="cv-section" data-palette><h3>Brand palette</h3>
      ${kit.colors.map((c, i) => `<div class="cv-pal-row"><input type="color" data-pal="hex" data-i="${i}" value="${toHex(c.hex)}" title="${toHex(c.hex)}"><input type="text" data-pal="name" data-i="${i}" value="${esc(c.name || '')}" placeholder="Name"><select data-pal="role" data-i="${i}" title="Role">${ROLES.map(r => `<option value="${r}" ${c.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select><button type="button" class="btn small ghost" data-pal="rm" data-i="${i}" title="Remove">✕</button></div>`).join('')}
      <div class="cv-row"><button type="button" class="btn small" data-act="add-color">＋ Add color</button><button type="button" class="btn small ghost" data-act="reset-palette">Reset to preset</button></div>
      <p class="hint">These are the swatches in every color field, and the colors the generator may use. Colors picked from a swatch stay bound to it: change a color here and every block using it follows.</p>
    </div>`;
  }
  function pairChips() {
    const pairs = Brand.pairs(env.getKit()).slice(0, 12);
    return `<div class="cv-pairs">${pairs.map((p, i) => `<button type="button" class="pair" data-pair="${i}" title="${esc(p.bgName)}: background ${p.bg}, text ${p.fgs[0]}, accent ${p.accents[0]}" style="background:${toHex(p.bg)};color:${toHex(p.fgs[0] || '#000')}"><b>Aa</b><i style="background:${toHex(p.accents[0] || p.fgs[0])}"></i></button>`).join('')}</div>`;
  }
  function genSection(f, b) {
    const s = ImageGen.settings.get(); const P = ImageGen.PROVIDERS[s.provider]; const ready = ImageGen.ready();
    const prompt = b.genPrompt || ImageGen.promptFor(f, env.getKit());
    const model = P ? (P.models.find(m => m[0] === s.model) || P.models[0])[1] : '';
    return `<div class="cv-section"><h3>Generate image</h3>
      <textarea class="cv-text" data-gen="prompt" rows="5" spellcheck="true">${esc(prompt)}</textarea>
      <div class="cv-row"><button type="button" class="btn small primary" data-act="gen-image" ${ready ? '' : 'disabled'}>Generate</button><button type="button" class="btn small" data-act="gen-reset" title="Rewrite the prompt from the frame's copy">↻ From frame</button></div>
      <p class="hint">${ready ? `${esc(P.name)} · ${esc(model)} · ${ImageGen.aspectOf(b.w, b.h)} · <a href="#" data-act="open-settings">change</a>` : 'Pick a provider (Gemini or OpenAI) and add a key in <a href="#" data-act="open-settings">Settings</a>. Runs locally or from your own host; published copies cannot call out.'}</p>
      ${b.genMeta ? `<p class="hint">Last: ${esc(b.genMeta.provider)} · ${esc(b.genMeta.model)} · ${Math.round(b.genMeta.ms / 100) / 10}s</p>` : ''}
    </div>`;
  }
  function renderProps() {
    if (!active || editing) return;
    const el = $('cvProps'); const frames = selFrames(); const f = selFrame(); const bs = selBlocks();
    if (!frames.length) { el.innerHTML = canvasProps(); return; }
    if (frames.length > 1) { el.innerHTML = screensProps(frames); return; }
    if (!bs.length) { el.innerHTML = frameProps(f); return; }
    if (bs.length > 1) { el.innerHTML = blocksProps(f, bs); return; }
    el.innerHTML = blockProps(f, bs[0]);
  }
  function canvasProps() {
    return `<div class="cv-section"><h3>Canvas</h3><label class="cv-f"><span>Name</span><input type="text" data-doc="name" value="${esc(doc.name)}"></label>
      <div class="cv-row wrap">${btn('new-frame', '＋ New frame')}${btn('paste', 'Paste', clipboard ? '' : 'disabled')}${btn('select-all', 'Select all screens', doc.frames.length ? '' : 'disabled')}${env.openImport ? btn('import', 'Import…') : ''}</div>
      <p class="hint">${doc.frames.length} frames. Click a screen's name to select it; shift-click or drag a box around screens to select several and change them together. Drag a block onto another frame to move it there; ⌥ drag copies. Double-click text to edit it in place.</p>
      <details class="cv-keys"><summary>Shortcuts</summary><p class="hint">V select · H hand · F frame (drag to draw) · ⇧N new frame · T text · R rectangle · O ellipse · I image · Enter edit text or enter a group · ⌘G group · ⇧⌘G ungroup · ⌘C ⌘X ⌘V copy cut paste · ⌘D duplicate · ⌘A select all · ⇧R tidy screens · ⇧G grid · ⇧1 fit all · ⇧2 fit selection · ⌘Z undo · ⌘L copy link · [ ] reorder · hold ⇧ while dragging to skip snapping.</p></details>
    </div>${paletteEditor()}`;
  }
  function exportSection(n) {
    return `<div class="cv-section"><h3>Export${n > 1 ? ` ${n} screens` : ''}</h3><div class="cv-row wrap">${btn('exp-png', 'PNG')}${btn('exp-png2', 'PNG 2×')}${btn('exp-svg', 'SVG')}${btn('exp-pdf', 'PDF')}${btn('exp-pptx', 'PPTX')}</div>${n === 1 ? `<div class="cv-row wrap">${btn('exp-react', 'Copy React + Tailwind')}${btn('exp-html', 'Copy HTML')}</div>` : ''}</div>`;
  }
  function lookSection(frames) {
    const cur = frames.length === 1 ? ((frames[0].layout.meta || {}).look || 'original') : null;
    return `<div class="cv-section"><h3>Look</h3><div class="cv-seg">${Looks.LOOKS.map(([k, l]) => `<button type="button" class="${cur === k ? 'on' : ''}" data-act="look-${k}">${l}</button>`).join('')}</div><p class="hint">Wireframe strips to grey boxes and one typeface; Rebrand moves colors and type onto the brand kit. Both rebuild from the original, so switching back is safe; edits made inside a look are replaced when you switch.</p></div>`;
  }
  function variationsSection() {
    return `<div class="cv-section"><h3>Variations</h3><div class="cv-row wrap"><select data-var="count" class="cv-mini" aria-label="How many">${[2, 3, 4, 6].map(n => `<option value="${n}" ${n === 3 ? 'selected' : ''}>${n}</option>`).join('')}</select><select data-var="mode" class="cv-mini" aria-label="Kind">${[['similar', 'Similar layout'], ['explore', 'Explore layouts'], ['palette', 'Palette swaps']].map(o => `<option value="${o[0]}">${o[1]}</option>`).join('')}</select>${btn('variations', 'Make')}</div><p class="hint">New screens land below, with the same copy. Imported and hand-built frames get palette swaps.</p></div>`;
  }
  function screensProps(frames) {
    const kit = env.getKit(); const fonts = Brand.allFontNames();
    return `<div class="cv-section"><h3>${frames.length} screens</h3>
      <div class="cv-row wrap">${btn('copy', 'Copy')}${btn('dup', 'Duplicate')}${btn('del', 'Delete')}${env.openAgent ? btn('agent', '✦ Ask agent') : ''}</div>
      <div class="cv-row wrap">${btn('tidy-row', 'Tidy row')}${btn('tidy-grid', 'Tidy grid')}${btn('align-tops', 'Align tops')}${btn('align-lefts', 'Align lefts')}</div>
      <p class="hint">Everything below changes every selected screen at once; ⌘Z undoes it as one step.</p></div>
      <div class="cv-section"><h3>Palette</h3>${pairChips()}<p class="hint">Or set just the background:</p>${swatches('batch-bg', '')}</div>
      <div class="cv-section"><h3>Type</h3>${selectF('batch-display', 'Display', kit.fonts.display, fonts.map(n => [n, n]))}${selectF('batch-body', 'Body', kit.fonts.body, fonts.map(n => [n, n]))}<div class="cv-row">${btn('batch-fonts', 'Apply fonts')}</div></div>
      <div class="cv-section"><h3>Find and replace</h3><label class="cv-f"><span>Find</span><input type="text" data-fr="find" placeholder="payroll"></label><label class="cv-f"><span>Replace</span><input type="text" data-fr="repl" placeholder="Akai"></label><div class="cv-row">${btn('replace', 'Replace in all')}</div></div>
      <div class="cv-section"><h3>Resize</h3>${selectF('batch-format', 'Format', '', [['', 'Pick a format…']].concat(Grid.FORMATS.map(x => [x.id, `${x.name} ${x.w}×${x.h}`])))}<div class="cv-row">${btn('batch-resize', 'Resize screens')}</div><p class="hint">Generated layouts are laid out again for the new size; other frames scale.</p></div>
      ${lookSection(frames)}
      ${variationsSection()}
      ${exportSection(frames.length)}`;
  }
  function alignBar() { return `<div class="cv-row cv-align">${[['left', '⇤'], ['hcenter', '⇔'], ['right', '⇥'], ['top', '⤒'], ['vcenter', '⇕'], ['bottom', '⤓']].map(([m, g]) => `<button class="btn small" data-align="${m}" title="Align ${m}">${g}</button>`).join('')}</div>`; }
  function frameFill(L) {
    const g = L.palette.bgGradient; const type = g ? (g.type || 'linear') : 'solid';
    return `<div class="cv-section"><h3>Fill</h3>${selectF('bgType', 'Type', type, [['solid', 'Solid'], ['linear', 'Linear gradient'], ['radial', 'Radial gradient']])}${type === 'solid' ? color('bg', 'Background', L.palette.bg, L.palette.bgToken) : `${color('bgGrad.0', 'Start', g.stops[0].c)}${color('bgGrad.1', 'End', g.stops[g.stops.length - 1].c)}${type === 'linear' ? num('bgGrad.angle', 'Angle', g.angle || 0, 15) : ''}`}</div>`;
  }
  function frameProps(f) {
    const L = f.layout, al = f.autoLayout;
    return `<div class="cv-section"><h3>Frame</h3>
      <label class="cv-f"><span>Name</span><input type="text" data-f="name" value="${esc(f.name)}"></label>
      <div class="cv-grid2">${num('x', 'X', f.x, 8)}${num('y', 'Y', f.y, 8)}${num('w', 'W', L.format.w, 8)}${num('h', 'H', L.format.h, 8)}</div>
      ${selectF('format', 'Format', L.format.id, Grid.FORMATS.map(x => [x.id, `${x.name} ${x.w}×${x.h}`]).concat([['custom', 'Custom']]))}
      <label class="cv-check"><input type="checkbox" data-f="clip" ${f.clip !== false ? 'checked' : ''}> Clip content</label>
      <label class="cv-check"><input type="checkbox" data-f="showGrid" ${f.showGrid ? 'checked' : ''}> Show grid (⇧G)</label>
      <label class="cv-check"><input type="checkbox" data-f="locked" ${f.locked ? 'checked' : ''}> Lock position</label>
      <div class="cv-row wrap">${btn('copy', 'Copy')}${btn('paste', 'Paste', clipboard ? '' : 'disabled')}${btn('dup', 'Duplicate')}${btn('del', 'Delete')}${env.openAgent ? btn('agent', '✦ Ask agent') : ''}</div>
    </div>
    ${frameFill(L)}
    ${lookSection([f])}
    <div class="cv-section"><h3>Palette</h3>${pairChips()}</div>
    <div class="cv-section"><h3>Layout</h3>
      ${selectF('al.mode', 'Flex', al.mode, [['none', 'Off (free)'], ['vertical', 'Vertical stack'], ['horizontal', 'Horizontal row']])}
      <div class="cv-grid2">${num('al.gap', 'Gap', al.gap, 4)}${num('al.padding', 'Padding', al.padding, 4)}</div>
      ${selectF('al.align', 'Align', al.align, [['start', 'Start'], ['center', 'Center'], ['end', 'End']])}
      ${selectF('al.justify', 'Justify', al.justify, [['start', 'Start'], ['center', 'Center'], ['end', 'End'], ['space-between', 'Space between']])}
      <label class="cv-check"><input type="checkbox" data-f="al.fill" ${al.fill ? 'checked' : ''}> Stretch text to inner width</label>
      <p class="hint">Flex stacks the frame's content blocks in reading order with gap and padding. Backgrounds stay put.</p>
    </div>
    <div class="cv-section"><h3>Add</h3><div class="cv-row wrap">${[['text', 'Headline'], ['body', 'Body'], ['button', 'Button'], ['rect', 'Rectangle'], ['ellipse', 'Ellipse'], ['image', 'Image'], ['icon', 'Icon'], ['logo', 'Logo']].map(([k, l]) => `<button class="btn small" data-add="${k}">${l}</button>`).join('')}</div></div>
    ${variationsSection()}
    ${exportSection(1)}
    <div class="cv-section"><h3>Code</h3><p class="hint">The frame is this JSON. Edit and apply.</p><textarea class="cv-code" data-code="frame" spellcheck="false">${esc(JSON.stringify(stripLayout(L), null, 1))}</textarea><div class="cv-row">${btn('apply-code', 'Apply JSON')}${btn('copy-code', 'Copy')}</div></div>`;
  }
  function blocksProps(f, bs) {
    const grouped = bs[0].group && bs.every(b => b.group === bs[0].group);
    return `<div class="cv-section"><h3>${grouped ? 'Group' : bs.length + ' blocks'}</h3>${alignBar()}
      <div class="cv-row wrap">${btn('dist-h', 'Distribute ↔')}${btn('dist-v', 'Distribute ↕')}</div>
      <div class="cv-row wrap">${grouped ? btn('ungroup', 'Ungroup ⇧⌘G') : btn('group', 'Group ⌘G')}${btn('copy', 'Copy')}${btn('dup', 'Duplicate')}${btn('del', 'Delete')}</div></div>
      <div class="cv-section"><h3>Fill</h3>${swatches('fill', '')}<p class="hint">Sets the fill (or text color) of every selected block.</p></div>
      <div class="cv-section"><h3>Effects</h3>${num('opacity', 'Opacity', 1, 0.05, 'min="0" max="1"')}<label class="cv-check"><input type="checkbox" data-p="shadow.on"> Drop shadow</label></div>`;
  }
  function fillSection(b) {
    const isText = b.kind === 'text' || b.kind === 'list';
    const g = b.gradient; const type = g ? (g.type || 'linear') : 'solid';
    return `<div class="cv-section"><h3>${isText ? 'Text color' : 'Fill'}</h3>
      ${b.kind !== 'icon' && b.kind !== 'logo' ? selectF('fillType', 'Type', type, [['solid', 'Solid'], ['linear', 'Linear gradient'], ['radial', 'Radial gradient']]) : ''}
      ${type === 'solid' ? color('fill', 'Color', b.fill || '#000000', b.fillToken) : `${color('grad.0', 'Start', g.stops[0].c)}${color('grad.1', 'End', g.stops[g.stops.length - 1].c)}${type === 'linear' ? num('grad.angle', 'Angle', g.angle || 0, 15) : ''}`}
      ${(b.kind === 'field' || b.kind === 'button' || b.kind === 'image') ? num('radius', 'Radius', b.radius || 0, 4) : ''}${b.kind === 'field' ? num('alpha', 'Fill alpha', b.alpha ?? 1, 0.05, 'min="0" max="1"') : ''}
    </div>`;
  }
  function strokeSection(b) {
    if (!['field', 'shape', 'vector', 'image', 'button'].includes(b.kind)) return '';
    const s = b.stroke || {};
    return `<div class="cv-section"><h3>Stroke</h3><div class="cv-grid2">${num('stroke.width', 'W', s.width || 0, 1, 'min="0"')}</div>${color('stroke.color', 'Color', s.color || '#000000')}</div>`;
  }
  function effectsSection(b) {
    const s = b.shadow || {};
    return `<div class="cv-section"><h3>Effects</h3>
      <div class="cv-grid2">${num('opacity', 'Op', b.opacity ?? 1, 0.05, 'min="0" max="1"')}${num('rotation', '↻', b.rotation || 0, 1)}</div>
      <label class="cv-check"><input type="checkbox" data-p="shadow.on" ${s.on && (s.blur || s.x || s.y) ? 'checked' : ''}> Drop shadow</label>
      ${s.on ? `<div class="cv-grid2">${num('shadow.x', 'X', s.x || 0, 1)}${num('shadow.y', 'Y', s.y ?? 8, 1)}${num('shadow.blur', 'Blur', s.blur ?? 24, 1, 'min="0"')}${num('shadow.alpha', 'α', s.alpha ?? 0.25, 0.05, 'min="0" max="1"')}</div>${color('shadow.color', 'Color', s.color || '#000000')}` : ''}
    </div>`;
  }
  function blockProps(f, b) {
    const isText = b.kind === 'text' || b.kind === 'list' || b.kind === 'button';
    const fontNames = Brand.allFontNames();
    const famName = isText && b.font ? String(b.font.family).split(',')[0].replace(/["']/g, '').trim() : '';
    return `<div class="cv-section"><h3>${esc(b.role || b.kind)}${b.group ? ' <span class="cv-token">in group</span>' : ''}</h3>
      <label class="cv-f"><span>Name</span><input type="text" data-p="label" value="${esc(b.label || '')}" placeholder="${esc(label({ ...b, label: '' }))}"></label>
      <div class="cv-grid2">${num('x', 'X', b.x, 8)}${num('y', 'Y', b.y, 8)}${num('w', 'W', b.w, 8)}${num('h', 'H', b.h, 8)}</div>
      ${alignBar()}
      <div class="cv-row wrap">${btn('back', '↓ Back', 'title="Send backward ([)"')}${btn('front', '↑ Front', 'title="Bring forward (])"')}${btn('copy', 'Copy', 'title="Copy (⌘C)"')}${btn('paste', 'Paste', `title="Paste (⌘V)" ${clipboard ? '' : 'disabled'}`)}${btn('dup', 'Duplicate', 'title="Duplicate (⌘D)"')}${btn('del', 'Delete', 'title="Delete (⌫)"')}${b.group ? btn('ungroup', 'Ungroup') : ''}</div>
      <label class="cv-check"><input type="checkbox" data-b="locked" ${b.locked ? 'checked' : ''}> Lock</label>
      <label class="cv-check"><input type="checkbox" data-b="decorative" ${b.decorative ? 'checked' : ''}> Decorative (not content)</label>
    </div>
    ${b.kind === 'text' ? `<div class="cv-section"><h3>Text</h3><textarea class="cv-text" data-p="text" rows="3" spellcheck="true">${esc(Canvas.sourceText(b))}</textarea><p class="hint">Or double-click the text on the canvas.</p>${b.overflow ? '<p class="hint" style="color:var(--danger)">Text is wider than its box. Widen the box or lower the size.</p>' : ''}</div>` : ''}
    ${b.kind === 'list' ? `<div class="cv-section"><h3>Items</h3><textarea class="cv-text" data-p="items" rows="4" spellcheck="true">${esc((b.items || []).join('\n'))}</textarea>${selectF('marker', 'Marker', b.marker || 'bullet', [['bullet', 'Bullet'], ['number', 'Number'], ['none', 'None']])}</div>` : ''}
    ${b.kind === 'button' ? `<div class="cv-section"><h3>Label</h3><input type="text" class="cv-text" data-p="text" value="${esc(b.text)}">${color('color', 'Text color', b.color, b.colorToken)}</div>` : ''}
    ${isText && b.font ? `<div class="cv-section"><h3>Typography</h3>
      ${selectF('font.familyName', 'Font', famName, fontNames.map(n => [n, n]).concat(fontNames.includes(famName) ? [] : [[famName, famName]]))}
      <div class="cv-grid2">${num('font.size', 'Size', b.font.size, 2)}${selectF('font.weight', 'Weight', b.font.weight, Brand.fontWeights(famName).map(w => [w, w]).concat(Brand.fontWeights(famName).includes(b.font.weight) ? [] : [[b.font.weight, b.font.weight]]))}</div>
      <div class="cv-grid2">${num('font.lineHeight', 'LH', b.font.lineHeight || 1.2, 0.05)}${num('font.letterSpacing', 'Tr', b.font.letterSpacing || 0, 0.01)}</div>
      ${b.kind === 'text' ? selectF('align', 'Align', b.align || 'left', [['left', 'Left'], ['center', 'Center'], ['right', 'Right']]) : ''}
      ${b.kind === 'text' ? selectF('font.transform', 'Case', b.font.transform || 'none', [['none', 'As written'], ['upper', 'UPPERCASE'], ['lower', 'lowercase']]) : ''}
      ${b.kind === 'text' ? selectF('font.style', 'Style', b.font.style || 'normal', [['normal', 'Normal'], ['italic', 'Italic']]) : ''}
      ${btn('fit-text', 'Fit size to box')}
    </div>` : ''}
    ${b.kind === 'image' ? `<div class="cv-section"><h3>Image</h3>${selectF('focal', 'Crop focus', b.focal || 'xMidYMid', [['xMinYMin', 'Top left'], ['xMidYMin', 'Top'], ['xMaxYMin', 'Top right'], ['xMinYMid', 'Left'], ['xMidYMid', 'Center'], ['xMaxYMid', 'Right'], ['xMinYMax', 'Bottom left'], ['xMidYMax', 'Bottom'], ['xMaxYMax', 'Bottom right']])}${selectF('fit', 'Fit', b.fit || 'cover', [['cover', 'Fill (crop)'], ['contain', 'Fit (letterbox)']])}<label class="btn small file">Replace image<input type="file" accept="image/*" data-file="image" hidden></label>${selectF('asset', 'Asset', b.asset || '', env.getAssets().images.map(a => [a.id, a.name]).concat([['', 'None']]))}</div>` : ''}
    ${b.kind === 'image' ? genSection(f, b) : ''}
    ${b.kind === 'icon' ? `<div class="cv-section"><h3>Icon</h3>${selectF('name', 'Icon', b.name, Icons.names.map(n => [n, n]))}</div>` : ''}
    ${b.kind === 'shape' ? `<div class="cv-section"><h3>Shape</h3>${selectF('shape', 'Shape', b.shape, [['circle', 'Circle'], ['ellipse', 'Ellipse'], ['pill', 'Pill'], ['quarter', 'Quarter circle']])}</div>` : ''}
    ${b.kind !== 'image' ? fillSection(b) : ''}
    ${strokeSection(b)}
    ${effectsSection(b)}
    <div class="cv-section"><h3>Code</h3><textarea class="cv-code" data-code="block" spellcheck="false">${esc(JSON.stringify(stripBlock(b), null, 1))}</textarea><div class="cv-row">${btn('apply-code', 'Apply JSON')}${btn('copy-code', 'Copy')}</div></div>`;
  }
  function stripBlock(b) { const c = Canvas.clone(b); delete c.lines; delete c.inkW; delete c.capacity; delete c.gap; delete c.maxLines; delete c.minSize; delete c.overflow; delete c.genPrompt; delete c.genMeta; return c; }
  function stripLayout(L) { const c = Canvas.clone(L); delete c.signature; c.blocks = c.blocks.map(stripBlock); return c; }
  function liveProps() {
    if (!active) return;
    const f = selFrame(); const bs = selBlocks(); const el = $('cvProps');
    const set = (k, v) => { const inp = el.querySelector(`input[data-p="${k}"]`); if (inp && document.activeElement !== inp) inp.value = Math.round(v * 100) / 100; };
    if (f && bs.length === 1) { set('x', bs[0].x); set('y', bs[0].y); set('w', bs[0].w); set('h', bs[0].h); } else if (f && !bs.length) { set('x', f.x); set('y', f.y); set('w', FW(f)); set('h', FH(f)); }
  }
  function secondColor(hex) { const kit = env.getKit(); const c = kit.colors.map(x => toHex(x.hex)).filter(x => x !== toHex(hex)).sort((a, b) => Color.contrast(hex, b) - Color.contrast(hex, a))[0]; return c || '#FFFFFF'; }
  function setBlockProp(b, k, v) {
    if (k === 'text') { b.text = v; Canvas.refit(b); }
    else if (k === 'items') { b.items = String(v).split('\n').map(x => x.trim()).filter(Boolean); Canvas.refit(b); }
    else if (k === 'label') { if (v) b.label = String(v).slice(0, 80); else delete b.label; }
    else if (k === 'font.familyName') { b.font.family = Brand.fontCss(v); const ws = Brand.fontWeights(v); if (!ws.includes(b.font.weight)) b.font.weight = ws.reduce((p, c) => Math.abs(c - b.font.weight) < Math.abs(p - b.font.weight) ? c : p, ws[0]); Canvas.refit(b); }
    else if (k.startsWith('font.')) { const kk = k.slice(5); b.font[kk] = (kk === 'transform' || kk === 'style') ? v : +v; Canvas.refit(b); }
    else if (k === 'x' || k === 'y') b[k] = +v;
    else if (k === 'w' || k === 'h') { b[k] = Math.max(4, +v); Canvas.refit(b); }
    else if (k === 'fill' || k === 'color') { b[k] = toHex(v); delete b[k + 'Token']; }
    else if (k === 'fillType') { if (v === 'solid') { if (b.gradient) b.fill = b.gradient.stops[0].c; delete b.gradient; } else { const c0 = b.gradient ? b.gradient.stops[0].c : toHex(b.fill || '#000000'); const c1 = b.gradient ? b.gradient.stops[b.gradient.stops.length - 1].c : secondColor(c0); b.gradient = { type: v, angle: b.gradient ? b.gradient.angle || 180 : 180, stops: [{ c: c0, p: 0 }, { c: c1, p: 1 }] }; } }
    else if (k.startsWith('grad.')) { if (!b.gradient) return; const kk = k.slice(5); if (kk === 'angle') b.gradient.angle = +v; else if (kk === '0') b.gradient.stops[0].c = toHex(v); else b.gradient.stops[b.gradient.stops.length - 1].c = toHex(v); }
    else if (k.startsWith('stroke.')) { b.stroke = b.stroke || { color: '#000000', width: 0 }; const kk = k.slice(7); b.stroke[kk] = kk === 'color' ? toHex(v) : Math.max(0, +v); if (kk === 'color' && !b.stroke.width) b.stroke.width = 2; }
    else if (k.startsWith('shadow.')) { b.shadow = b.shadow || { on: false, x: 0, y: 8, blur: 24, color: '#000000', alpha: 0.25 }; const kk = k.slice(7); if (kk === 'on') { b.shadow.on = !!v; if (v && !(b.shadow.blur || b.shadow.x || b.shadow.y)) Object.assign(b.shadow, { x: 0, y: 8, blur: 24 }); } else b.shadow[kk] = kk === 'color' ? toHex(v) : +v; }
    else if (k === 'opacity') b.opacity = Math.max(0, Math.min(1, +v));
    else if (k === 'rotation') { let r = (((+v || 0) % 360) + 360) % 360; if (r > 180) r -= 360; b.rotation = r; }
    else if (k === 'radius' || k === 'alpha') b[k] = +v;
    else if (k === 'asset') b.asset = v || null;
    else b[k] = v;
  }
  function setFrameProp(f, k, v) {
    const P = f.layout.palette;
    if (k === 'x') f.x = +v; else if (k === 'y') f.y = +v;
    else if (k === 'w' || k === 'h') { f.layout.format = { ...f.layout.format, [k]: Math.max(64, +v), id: 'custom', name: 'Custom' }; regrid(f); }
    else if (k === 'format') { const fm = Grid.byId[v]; if (fm) { f.layout.format = { id: fm.id, name: fm.name, w: fm.w, h: fm.h }; regrid(f); } }
    else if (k === 'bg') { P.bg = toHex(v); delete P.bgToken; }
    else if (k === 'bgType') { if (v === 'solid') { if (P.bgGradient) P.bg = P.bgGradient.stops[0].c; delete P.bgGradient; } else P.bgGradient = { type: v, angle: P.bgGradient ? P.bgGradient.angle : 180, stops: P.bgGradient ? P.bgGradient.stops : [{ c: toHex(P.bg), p: 0 }, { c: secondColor(P.bg), p: 1 }] }; }
    else if (k.startsWith('bgGrad.')) { if (!P.bgGradient) return; const kk = k.slice(7); if (kk === 'angle') P.bgGradient.angle = +v; else if (kk === '0') P.bgGradient.stops[0].c = toHex(v); else P.bgGradient.stops[P.bgGradient.stops.length - 1].c = toHex(v); }
    else if (k.startsWith('al.')) f.autoLayout[k.slice(3)] = typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? +v : v;
    if (f.autoLayout.mode !== 'none') Canvas.applyAutoLayout(f);
  }
  // Recolor a screen around a new background: text and accent are picked from the palette for contrast.
  function recolorBg(f, hex, name) {
    const kit = env.getKit(); const cols = kit.colors.map(c => toHex(c.hex));
    const fg = Color.bestForeground(hex, cols, 4.5)[0];
    const acc = (kit.colors.find(c => (c.role === 'accent' || c.role === 'core') && toHex(c.hex) !== hex && Color.contrast(hex, c.hex) >= 3) || { hex: fg }).hex;
    Canvas.recolor(f, { bg: hex, fg, accent: toHex(acc), bgName: name || f.layout.palette.bgName });
    if (name) f.layout.palette.bgToken = name;
  }
  function applySwatch(k, hex, name) {
    const fs = selFrames(); const f = selFrame(); const bs = selBlocks(); if (!fs.length) return;
    hist.push(doc);
    if (k === 'batch-bg') fs.forEach(fr => recolorBg(fr, hex, name));
    else if (!bs.length && f) { if (k === 'bg') { f.layout.palette.bg = hex; f.layout.palette.bgToken = name || undefined; if (name) f.layout.palette.bgName = name; } else if (k.startsWith('bgGrad.')) setFrameProp(f, k, hex); }
    else for (const b of bs) {
      if (k === 'fill' || k === 'color') { if (k === 'fill' && b.gradient) delete b.gradient; b[k] = hex; if (name) b[k + 'Token'] = name; else delete b[k + 'Token']; }
      else setBlockProp(b, k, hex);
    }
    fs.forEach(rerenderFrame); persist(); updateUndo(); renderProps(); drawOverlay();
  }
  async function makeVariations(frames, count, mode) {
    if (!env.variations) return;
    let made = 0;
    for (const f of frames) {
      const layouts = await env.variations({ frame: f, count, mode });
      if (layouts && layouts.length) { placeRow(layouts, f, { names: layouts.map((L, i) => `${f.name.replace(/ · v\d+$/, '')} · v${i + 1}`) }); made += layouts.length; }
    }
    env.toast(made ? `${made} variation${made > 1 ? 's' : ''} below` : 'No variations fit these rules');
  }
  async function resizeScreens(frames, fmtId) {
    const fm = Grid.byId[fmtId]; if (!fm) { env.toast('Pick a format first'); return; }
    hist.push(doc); let relaid = 0;
    for (const f of frames) {
      const L = env.relayout ? env.relayout(f, fm) : null;
      if (L) { const keep = { bgToken: f.layout.palette.bgToken }; f.layout = Canvas.clone(L); for (const b of f.layout.blocks) if (!b.id) b.id = Canvas.uid(); if (keep.bgToken) f.layout.palette.bgToken = keep.bgToken; relaid++; }
      else { Canvas.scaleFrame(f, fm); }
      regrid(f);
    }
    Canvas.tidy(frames, frames.length > 3 ? 'grid' : 'row');
    renderAll(); persist(); updateUndo(); env.toast(`${frames.length} screen${frames.length > 1 ? 's' : ''} resized to ${fm.name}${relaid ? ` · ${relaid} laid out again` : ''}`);
  }
  function bindProps() {
    const el = $('cvProps');
    const apply = (e, live) => {
      const t = e.target; const fs = selFrames(); const f = selFrame();
      if (t.dataset.doc === 'name') { doc.name = t.value; persist(); return; }
      if (!f || t.dataset.var || t.dataset.fr || (t.dataset.p && t.dataset.p.startsWith('batch-'))) return;
      const bs = selBlocks();
      const val = t.type === 'checkbox' ? t.checked : t.value;
      if (t.dataset.f) {
        if (!live) hist.push(doc);
        const k = t.dataset.f; if (k.startsWith('al.')) setFrameProp(f, k, t.type === 'checkbox' ? t.checked : t.value); else f[k] = val;
        if (k === 'clip' || k === 'showGrid' || k === 'name') rerenderFrame(f); else rerenderFrame(f);
        renderLayers(); drawOverlay(); persist(); updateUndo(); return;
      }
      if (t.dataset.b && bs.length) { hist.push(doc); for (const b of bs) b[t.dataset.b] = t.checked; renderLayers(); drawOverlay(); persist(); updateUndo(); return; }
      const k = t.dataset.p; if (!k) return;
      if (!live) hist.push(doc);
      if (!bs.length) { setFrameProp(f, k, val); rerenderFrame(f); drawOverlay(); if (!live) renderProps(); persist(); updateUndo(); return; }
      for (const b of bs) setBlockProp(b, k, val);
      if (f.autoLayout.mode !== 'none' && !live) Canvas.applyAutoLayout(f);
      rerenderFrame(f); drawOverlay(); renderLayers(); persist(); updateUndo(); if (!live) renderProps();
    };
    // Live fields (color, textarea, text) snapshot history on their FIRST input event, so undo returns to the value before the edit.
    let liveField = null;
    el.addEventListener('change', e => {
      if (e.target.dataset.pal || e.target.dataset.gen) return;
      if (liveField === e.target) { liveField = null; apply(e, true); renderProps(); } else apply(e, false);
    });
    // Brand palette rows edit the kit itself; the generator, every swatch row and every bound color follow.
    el.addEventListener('change', e => {
      const t = e.target; const key = t.dataset.pal; if (!key || key === 'rm') return;
      const colors = env.getKit().colors.map(c => ({ ...c })); const c = colors[+t.dataset.i]; if (!c) return;
      const oldName = c.name;
      if (key === 'hex') c.hex = toHex(t.value); else if (key === 'name') c.name = t.value.trim(); else if (key === 'role') c.role = t.value;
      if (key === 'name' && oldName && c.name) renameToken(oldName, c.name);
      env.updateColors(colors); followTokens(); renderProps();
    });
    el.addEventListener('input', e => {
      const t = e.target;
      if (t.dataset.gen) { const b = selBlocks()[0]; if (b) { b.genPrompt = t.value; persist(); } return; }
      if (t.dataset.pal || t.dataset.fr || t.dataset.var) return;
      if (t.type === 'color' || t.type === 'range' || (t.tagName === 'TEXTAREA' && t.dataset.p) || (t.type === 'text' && (t.dataset.p === 'text' || t.dataset.f === 'name' || t.dataset.p === 'label'))) {
        if (liveField !== t) { hist.push(doc); liveField = t; updateUndo(); }
        if (t.type === 'color') { const hex = t.parentElement.querySelector('.hex'); if (hex) hex.value = t.value; }
        apply(e, true);
      }
    });
    el.addEventListener('click', async e => {
      const f = selFrame(); const bs = selBlocks(); const fs = selFrames();
      const sw = e.target.closest('[data-sw]'); if (sw) { applySwatch(sw.dataset.for, sw.dataset.sw, sw.dataset.swName); return; }
      const pr = e.target.closest('[data-pair]'); if (pr) { const p = Brand.pairs(env.getKit())[+pr.dataset.pair]; if (p && fs.length) { mutate(() => fs.forEach(fr => { Canvas.recolor(fr, { bg: p.bg, fg: p.fgs[0], accent: p.accents[0], bgName: p.bgName }); fr.layout.palette.bgToken = p.bgName; }), { frames: fs.map(x => x.id) }); env.toast(`${fs.length > 1 ? fs.length + ' screens' : 'Screen'} on ${p.bgName}`); } return; }
      const palRm = e.target.closest('[data-pal="rm"]'); if (palRm) { const colors = env.getKit().colors.filter((_, i) => i !== +palRm.dataset.i); env.updateColors(colors); followTokens(); renderProps(); return; }
      const al = e.target.closest('[data-align]'); if (al && f) { hist.push(doc); Canvas.align(f, bs.length ? bs : [], al.dataset.align); rerenderFrame(f); drawOverlay(); liveProps(); persist(); updateUndo(); return; }
      const add = e.target.closest('[data-add]'); if (add && f) { hist.push(doc); const b = Canvas.newBlock(add.dataset.add, f, env.getKit(), null); if (b) { f.layout.blocks.push(b); if (f.autoLayout.mode !== 'none') Canvas.applyAutoLayout(f); select(f.id, [b.id]); rerenderFrame(f); persist(); updateUndo(); if (b.kind === 'image') { const inp = $('cvProps').querySelector('[data-file="image"]'); if (inp) inp.click(); } } return; }
      const act = e.target.closest('[data-act]'); if (!act) return;
      const a = act.dataset.act;
      if (a === 'edit-palette') { select(null, []); const sec = el.querySelector('[data-palette]'); if (sec) sec.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
      if (a === 'add-color') { const colors = env.getKit().colors.map(c => ({ ...c })); colors.push({ name: 'Color ' + (colors.length + 1), hex: '#888888', role: 'accent' }); env.updateColors(colors); renderProps(); const rows = el.querySelectorAll('.cv-pal-row'); const last = rows.length ? rows[rows.length - 1].querySelector('input[type="text"]') : null; if (last) { last.focus(); last.select(); } return; }
      if (a === 'reset-palette') { if (env.resetColors()) { followTokens(); renderProps(); env.toast('Palette reset to the preset'); } else env.toast('This kit has no preset to reset to'); return; }
      if (a === 'new-frame') { createFrame({ center: true }); return; }
      if (a === 'select-all') { selectFrames(doc.frames.filter(x => !x.hidden).map(x => x.id)); return; }
      if (a === 'import') { env.openImport(); return; }
      if (a === 'copy') { copySelection(); renderProps(); return; }
      if (a === 'paste') { pasteClipboard(); return; }
      if (a === 'open-settings') { e.preventDefault(); env.openSettings(); return; }
      if (a === 'agent') { env.openAgent && env.openAgent(selection()); return; }
      if (a.startsWith('exp-')) { act.disabled = true; try { await exportAction(a.slice(4)); } catch (err) { console.error(err); env.toast('Export failed: ' + err.message); } finally { act.disabled = false; } return; }
      if (a === 'variations') { const n = +el.querySelector('[data-var="count"]').value; const mode = el.querySelector('[data-var="mode"]').value; act.disabled = true; act.textContent = '…'; try { await makeVariations(fs, n, mode); } finally { act.disabled = false; act.textContent = 'Make'; } return; }
      if (a.startsWith('look-')) { const look = a.slice(5); const n = mutate(() => fs.filter(x => Looks.apply(x, look, env.getKit())).length, { frames: fs.map(x => x.id) }); renderProps(); env.toast(n ? `${n > 1 ? n + ' screens' : 'Screen'}: ${look}` : `Already ${look}`); return; }
      if (a === 'tidy-row' || a === 'tidy-grid') { mutate(() => Canvas.tidy(fs, a === 'tidy-row' ? 'row' : 'grid')); return; }
      if (a === 'align-tops') { const y = Math.min(...fs.map(x => x.y)); mutate(() => fs.forEach(x => { x.y = y; })); return; }
      if (a === 'align-lefts') { const x = Math.min(...fs.map(v => v.x)); mutate(() => fs.forEach(v => { v.x = x; })); return; }
      if (a === 'batch-fonts') { const display = el.querySelector('[data-p="batch-display"]').value, body = el.querySelector('[data-p="batch-body"]').value; mutate(() => Canvas.setFonts(fs, { display, body, kit: env.getKit() }), { frames: fs.map(x => x.id) }); env.toast(`Fonts set on ${fs.length} screens`); return; }
      if (a === 'replace') { const find = el.querySelector('[data-fr="find"]').value, repl = el.querySelector('[data-fr="repl"]').value; if (!find) { env.toast('Type what to find'); return; } const n = mutate(() => Canvas.replaceText(fs, find, repl), { frames: fs.map(x => x.id) }); env.toast(n ? `Replaced ${n} time${n > 1 ? 's' : ''} in ${fs.length} screens` : `“${find}” not found`); return; }
      if (a === 'batch-resize') { await resizeScreens(fs, el.querySelector('[data-p="batch-format"]').value); return; }
      if (!f) return;
      if (a === 'del') deleteSelection(); else if (a === 'dup') duplicateSelection();
      else if (a === 'group') groupSelection(); else if (a === 'ungroup') ungroupSelection();
      else if (a === 'front' || a === 'back') { hist.push(doc); bs.forEach(b => Canvas.reorder(f, b, a === 'front' ? 1 : -1)); rerenderFrame(f); renderLayers(); persist(); updateUndo(); }
      else if (a === 'dist-h' || a === 'dist-v') { hist.push(doc); Canvas.distribute(bs, a === 'dist-h' ? 'h' : 'v'); rerenderFrame(f); drawOverlay(); persist(); updateUndo(); }
      else if (a === 'fit-text') { hist.push(doc); for (const b of bs) { const fit = Text.fit(Text.transform(Canvas.sourceText(b), b.font.transform), b.font, b.w, b.h, { minSize: 10, step: 2, maxLines: 40 }); if (fit) { b.font.size = fit.size; Canvas.refit(b); } } rerenderFrame(f); drawOverlay(); renderProps(); persist(); updateUndo(); }
      else if (a === 'copy-code') { const ta = el.querySelector('[data-code]'); await copyText(ta.value); env.toast('JSON copied'); }
      else if (a === 'apply-code') {
        const ta = el.querySelector('[data-code]');
        try {
          const parsed = JSON.parse(ta.value); hist.push(doc);
          if (ta.dataset.code === 'frame') { if (!parsed.format || !Array.isArray(parsed.blocks)) throw new Error('needs format and blocks'); parsed.blocks = parsed.blocks.map(b => { if (!b.id) b.id = Canvas.uid(); return (b.kind === 'text' || b.kind === 'list') ? Canvas.refit(b) : b; }); f.layout = parsed; regrid(f, true); select(f.id, []); renderAll(); }
          else { const b = bs[0]; const i = f.layout.blocks.indexOf(b); parsed.id = b.id; if (parsed.kind === 'text' || parsed.kind === 'list') Canvas.refit(parsed); f.layout.blocks[i] = parsed; select(f.id, [b.id]); rerenderFrame(f); }
          persist(); updateUndo(); env.toast('Applied');
        } catch (err) { env.toast('JSON error: ' + err.message); }
      }
      else if (a === 'gen-reset' && bs[0]) { bs[0].genPrompt = null; persist(); renderProps(); }
      else if (a === 'gen-image' && bs[0]) {
        const b = bs[0]; const ta = el.querySelector('[data-gen="prompt"]'); const prompt = ta ? ta.value : b.genPrompt; b.genPrompt = prompt;
        act.disabled = true; act.textContent = 'Generating…';
        try {
          const out = await ImageGen.generate({ prompt, aspect: ImageGen.aspectOf(b.w, b.h) });
          const asset = await env.addImageData(out.dataUrl, `generated · ${out.provider} ${new Date().toLocaleTimeString()}`);
          hist.push(doc); b.asset = asset.id; b.genMeta = { provider: out.provider, model: out.model, ms: out.ms };
          rerenderFrame(f); persist(); updateUndo(); env.toast(`Image generated in ${Math.round(out.ms / 100) / 10}s`);
        } catch (err) { env.toast(err.message); }
        if (selBlocks()[0] === b) renderProps();
      }
    });
    el.addEventListener('change', async e => {
      const inp = e.target.closest('[data-file="image"]'); if (!inp || !inp.files[0]) return;
      const f = selFrame(); const b = selBlocks()[0]; if (!f || !b) return;
      try { const asset = await env.addImage(inp.files[0]); hist.push(doc); b.asset = asset.id; rerenderFrame(f); renderProps(); persist(); updateUndo(); } catch (err) { env.toast('Could not load image: ' + err.message); }
      inp.value = '';
    });
  }
  function renameToken(from, to) { const lo = String(from).toLowerCase(); for (const f of doc.frames) { if (String(f.layout.palette.bgToken || '').toLowerCase() === lo) f.layout.palette.bgToken = to; for (const b of f.layout.blocks) { if (String(b.fillToken || '').toLowerCase() === lo) b.fillToken = to; if (String(b.colorToken || '').toLowerCase() === lo) b.colorToken = to; } } }
  function followTokens() { const n = Canvas.applyTokens(doc, env.getKit()); if (n) { renderFrames(); persist(); env.toast(`${n} bound color${n > 1 ? 's' : ''} updated`); } }
  function regrid(f) { const fmt = Grid.byId[f.layout.format.id] && Grid.byId[f.layout.format.id].w === f.layout.format.w && Grid.byId[f.layout.format.id].h === f.layout.format.h ? Grid.byId[f.layout.format.id] : { ...f.layout.format, cols: Math.max(4, Math.min(12, Math.round(f.layout.format.w / 160))) }; const g = Grid.compute({ ...fmt, w: f.layout.format.w, h: f.layout.format.h }, { unit: (f.layout.grid && f.layout.grid.unit) || 8, marginRatio: 0.06, gutterUnits: 3 }); f.layout.grid = { unit: g.unit, gutter: g.gutter, cols: g.cols, rows: g.rows, cw: g.cw, rh: g.rh, mx: g.mx, my: g.my, safe: g.safe }; }

  // ---- Public surface --------------------------------------------------------------------------------------------
  return {
    init, open, close, addLayouts, count, fit, fitTo: ids => fitTo(ids.map(id => Canvas.frameById(doc, id)).filter(Boolean)),
    get doc() { return doc; }, get active() { return active; },
    select, selectFrames, selection, setTool, createFrame, placeRow, placeFrames, insertBlocks, mutate, remoteApplied, replaceDoc, renderAll, rerender: ids => ids.forEach(id => { const f = Canvas.frameById(doc, id); if (f) rerenderFrame(f); }),
    regrid, exportAction, makeVariations, resizeScreens, copySelection, pasteClipboard, startEdit: (fid, bid) => { const f = Canvas.frameById(doc, fid); return startEdit(f, f && Canvas.blockById(f, bid)); },
    on: (k, fn) => { hooks[k].push(fn); return () => { hooks[k] = hooks[k].filter(x => x !== fn); }; },
    setPeers: list => { peers = Array.isArray(list) ? list : []; if (active) drawOverlay(); },
    setUndoMerge: fn => { undoMerge = fn; },
    _history: () => hist,
  };
})();
