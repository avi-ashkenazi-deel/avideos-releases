/* Canvas editor UI: infinite stage, selection and handles, layers, properties, code view, export.
   Everything the panels change is a field in the frame's layout JSON; the stage re-renders from it. */
const CanvasUI = (() => {
  const $ = id => document.getElementById(id);
  let env = null, doc = null, hist = null, active = false;
  const sel = { frameId: null, blockIds: [] };
  let tool = 'select', hover = null, drag = null, spaceDown = false, clipboard = null, lastPointer = null, dropTarget = null;
  const HANDLE = 7;
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---- Setup ------------------------------------------------------------------------------------
  function init(e) {
    env = e;
    try { const saved = localStorage.getItem('lg.canvas'); doc = saved ? Canvas.deserialize(saved) : Canvas.create(); } catch { doc = Canvas.create(); }
    hist = Canvas.history();
    bindStage(); bindToolbar(); bindKeys();
    Canvas.fromHash(location.hash).then(d => { if (d) { doc = d; env.toast('Canvas loaded from link'); if (active) renderAll(); } }).catch(() => { });
  }
  function count() { return doc ? doc.frames.length : 0; }
  function open() { active = true; renderAll(); if (doc.frames.length && !sel.frameId) fit(); }
  function close() { active = false; }
  function commit(label) { hist.push(doc); persist(); updateUndo(); }
  function persist() { try { const s = Canvas.serialize(doc); if (s.length < 3_000_000) localStorage.setItem('lg.canvas', s); } catch { } }
  function updateUndo() { $('cvUndo').disabled = !hist.canUndo; $('cvRedo').disabled = !hist.canRedo; }

  function addLayouts(layouts, opts = {}) {
    hist.push(doc);
    const start = doc.frames.length ? Math.max(...doc.frames.map(f => f.y + f.layout.format.h)) + 240 : 0;
    let x = 0; const added = [];
    for (const L of layouts) { const f = Canvas.addFrame(doc, L, { x, y: start }); x += L.format.w + 160; added.push(f); }
    sel.frameId = added.length ? added[0].id : null; sel.blockIds = [];
    persist(); updateUndo();
    if (active) { renderAll(); fitTo(added); }
    return added;
  }

  // ---- Geometry ------------------------------------------------------------------------------------
  const stage = () => $('stage');
  function toWorld(cx, cy) { const r = stage().getBoundingClientRect(); const v = doc.view; return { x: (cx - r.left - v.x) / v.zoom, y: (cy - r.top - v.y) / v.zoom }; }
  function toScreen(wx, wy) { const v = doc.view; return { x: wx * v.zoom + v.x, y: wy * v.zoom + v.y }; }
  function frameAt(p) { for (let i = doc.frames.length - 1; i >= 0; i--) { const f = doc.frames[i]; if (f.hidden) continue; if (p.x >= f.x && p.y >= f.y && p.x <= f.x + f.layout.format.w && p.y <= f.y + f.layout.format.h) return f; } return null; }
  function blockAt(f, p) { const lx = p.x - f.x, ly = p.y - f.y; const bs = f.layout.blocks; for (let i = bs.length - 1; i >= 0; i--) { const b = bs[i]; if (b.hidden) continue; const w = (b.kind === 'text' && b.align !== 'center' && b.align !== 'right') ? Math.max(b.inkW || b.w, 24) : b.w; if (lx >= b.x && ly >= b.y && lx <= b.x + w && ly <= b.y + b.h) return b; } return null; }
  function selBlocks() { const f = Canvas.frameById(doc, sel.frameId); return f ? sel.blockIds.map(id => Canvas.blockById(f, id)).filter(Boolean) : []; }
  function selFrame() { return Canvas.frameById(doc, sel.frameId); }

  function fit() { if (!doc.frames.length) { doc.view = { x: 60, y: 60, zoom: 0.5 }; applyView(); return; } fitTo(doc.frames); }
  function fitTo(frames) {
    const r = stage().getBoundingClientRect(); if (!r.width) return;
    const x0 = Math.min(...frames.map(f => f.x)), y0 = Math.min(...frames.map(f => f.y));
    const x1 = Math.max(...frames.map(f => f.x + f.layout.format.w)), y1 = Math.max(...frames.map(f => f.y + f.layout.format.h));
    const zoom = Math.min(2, Math.max(0.05, Math.min((r.width - 80) / (x1 - x0), (r.height - 120) / (y1 - y0))));
    doc.view = { zoom, x: (r.width - (x1 - x0) * zoom) / 2 - x0 * zoom, y: (r.height - (y1 - y0) * zoom) / 2 - y0 * zoom + 10 };
    applyView();
  }
  function zoomBy(factor, cx, cy) {
    const r = stage().getBoundingClientRect(); const px = cx != null ? cx - r.left : r.width / 2, py = cy != null ? cy - r.top : r.height / 2;
    const v = doc.view; const z = Math.min(4, Math.max(0.05, v.zoom * factor));
    v.x = px - (px - v.x) * (z / v.zoom); v.y = py - (py - v.y) * (z / v.zoom); v.zoom = z; applyView();
  }
  function applyView() { const v = doc.view; $('world').style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`; $('cvZoom').textContent = Math.round(v.zoom * 100) + '%'; stage().style.backgroundSize = `${24 * v.zoom}px ${24 * v.zoom}px`; stage().style.backgroundPosition = `${v.x}px ${v.y}px`; const fs = Math.max(11, 12 / v.zoom) + 'px', off = Math.max(16, 18 / v.zoom); $('world').querySelectorAll('.cv-frame-label').forEach(lb => { lb.style.fontSize = fs; const f = Canvas.frameById(doc, lb.dataset.label); if (f) lb.style.top = (f.y - off) + 'px'; }); drawOverlay(); }

  // ---- Rendering ----------------------------------------------------------------------------------------
  function renderAll() { renderFrames(); renderLayers(); renderProps(); applyView(); updateUndo(); $('cvCount').textContent = doc.frames.length ? `${doc.frames.length} frame${doc.frames.length > 1 ? 's' : ''}` : 'Empty canvas'; $('cvEmpty').hidden = doc.frames.length > 0; }
  function renderFrames() {
    const world = $('world');
    world.innerHTML = doc.frames.map(f => `<div class="cv-frame-label" data-label="${f.id}" style="left:${f.x}px;top:${f.y - Math.max(16, 18 / doc.view.zoom)}px;max-width:${f.layout.format.w}px;font-size:${Math.max(11, 12 / doc.view.zoom)}px;${f.hidden ? 'display:none;' : ''}">${esc(f.name)}</div><div class="cv-frame" data-id="${f.id}" style="left:${f.x}px;top:${f.y}px;width:${f.layout.format.w}px;height:${f.layout.format.h}px;${f.hidden ? 'display:none;' : ''}${f.clip ? '' : 'overflow:visible;'}">${frameSVG(f)}</div>`).join('');
  }
  function frameSVG(f) { return env.renderSVG(f.layout, { showGrid: !!f.showGrid }); }
  function rerenderFrame(f) {
    const el = $('world').querySelector(`.cv-frame[data-id="${f.id}"]`); if (!el) return renderFrames();
    const svg = el.querySelector('svg'); if (svg) svg.outerHTML = frameSVG(f); else el.insertAdjacentHTML('beforeend', frameSVG(f));
    el.style.left = f.x + 'px'; el.style.top = f.y + 'px'; el.style.width = f.layout.format.w + 'px'; el.style.height = f.layout.format.h + 'px'; el.style.display = f.hidden ? 'none' : '';
    const lb = $('world').querySelector(`.cv-frame-label[data-label="${f.id}"]`); if (lb) { lb.style.left = f.x + 'px'; lb.style.top = (f.y - Math.max(16, 18 / doc.view.zoom)) + 'px'; lb.style.maxWidth = f.layout.format.w + 'px'; lb.textContent = f.name; lb.style.display = f.hidden ? 'none' : ''; }
  }

  function drawOverlay() {
    const ov = $('overlay'); const r = stage().getBoundingClientRect(); ov.setAttribute('width', r.width); ov.setAttribute('height', r.height);
    const parts = [];
    const f = selFrame();
    if (hover && hover.frame && !(drag && drag.type)) {
      const hf = hover.frame; const b = hover.block;
      const rect = b ? { x: hf.x + b.x, y: hf.y + b.y, w: b.w, h: b.h } : { x: hf.x, y: hf.y, w: hf.layout.format.w, h: hf.layout.format.h };
      const p = toScreen(rect.x, rect.y); parts.push(`<rect x="${p.x}" y="${p.y}" width="${rect.w * doc.view.zoom}" height="${rect.h * doc.view.zoom}" fill="none" stroke="var(--accent)" stroke-opacity=".6" stroke-width="1"/>`);
    }
    if (f) {
      const p = toScreen(f.x, f.y); const W = f.layout.format.w * doc.view.zoom, H = f.layout.format.h * doc.view.zoom;
      parts.push(`<rect x="${p.x}" y="${p.y}" width="${W}" height="${H}" fill="none" stroke="var(--accent)" stroke-width="${sel.blockIds.length ? 1 : 2}" stroke-opacity="${sel.blockIds.length ? .45 : 1}"/>`);
      const blocks = selBlocks();
      for (const b of blocks) {
        const q = toScreen(f.x + b.x, f.y + b.y); const w = b.w * doc.view.zoom, h = b.h * doc.view.zoom;
        parts.push(`<rect x="${q.x}" y="${q.y}" width="${w}" height="${h}" fill="none" stroke="${b.overflow ? 'var(--danger)' : 'var(--accent)'}" stroke-width="1.5"/>`);
        if (blocks.length === 1 && !b.locked) for (const hnd of handles(q.x, q.y, w, h)) parts.push(`<rect class="cv-handle" data-h="${hnd.id}" x="${hnd.x - HANDLE / 2}" y="${hnd.y - HANDLE / 2}" width="${HANDLE}" height="${HANDLE}" fill="#fff" stroke="var(--accent)" stroke-width="1.5" style="cursor:${hnd.cursor}"/>`);
        parts.push(`<text x="${q.x}" y="${q.y - 6}" fill="var(--accent)" font-size="11" font-family="var(--font-mono)">${esc(b.role || b.kind)} ${Math.round(b.w)}×${Math.round(b.h)}</text>`);
      }
      if (!blocks.length) parts.push(`<text x="${p.x}" y="${p.y + H + 16}" fill="var(--fg-3)" font-size="11" font-family="var(--font-mono)">${f.layout.format.w}×${f.layout.format.h}</text>`);
    }
    if (drag && drag.type === 'draw-frame' && drag.moved) { const a = toScreen(Math.min(drag.start.x, drag.cur.x), Math.min(drag.start.y, drag.cur.y)); const w = Math.abs(drag.cur.x - drag.start.x), h = Math.abs(drag.cur.y - drag.start.y); parts.push(`<rect x="${a.x}" y="${a.y}" width="${w * doc.view.zoom}" height="${h * doc.view.zoom}" fill="rgba(216,201,163,.06)" stroke="var(--accent)" stroke-dasharray="6 4" stroke-width="1.5"/><text x="${a.x}" y="${a.y - 6}" fill="var(--accent)" font-size="11" font-family="var(--font-mono)">${Math.round(w / 8) * 8}×${Math.round(h / 8) * 8}</text>`); }
    if (dropTarget) { const a = toScreen(dropTarget.x, dropTarget.y); parts.push(`<rect x="${a.x}" y="${a.y}" width="${dropTarget.layout.format.w * doc.view.zoom}" height="${dropTarget.layout.format.h * doc.view.zoom}" fill="rgba(216,201,163,.1)" stroke="var(--accent)" stroke-dasharray="6 4" stroke-width="2"/><text x="${a.x + 8}" y="${a.y + 18}" fill="var(--accent)" font-size="12" font-weight="600" font-family="var(--font-mono)">Move into ${esc(dropTarget.name)}</text>`); }
    if (drag && drag.type === 'marquee') { const a = toScreen(Math.min(drag.start.x, drag.cur.x), Math.min(drag.start.y, drag.cur.y)); parts.push(`<rect x="${a.x}" y="${a.y}" width="${Math.abs(drag.cur.x - drag.start.x) * doc.view.zoom}" height="${Math.abs(drag.cur.y - drag.start.y) * doc.view.zoom}" fill="rgba(216,201,163,.08)" stroke="var(--accent)" stroke-dasharray="4 3"/>`); }
    ov.innerHTML = parts.join('');
  }
  function handles(x, y, w, h) {
    return [{ id: 'nw', x, y, cursor: 'nwse-resize' }, { id: 'n', x: x + w / 2, y, cursor: 'ns-resize' }, { id: 'ne', x: x + w, y, cursor: 'nesw-resize' }, { id: 'e', x: x + w, y: y + h / 2, cursor: 'ew-resize' }, { id: 'se', x: x + w, y: y + h, cursor: 'nwse-resize' }, { id: 's', x: x + w / 2, y: y + h, cursor: 'ns-resize' }, { id: 'sw', x, y: y + h, cursor: 'nesw-resize' }, { id: 'w', x, y: y + h / 2, cursor: 'ew-resize' }];
  }
  function handleAt(cx, cy) {
    const f = selFrame(); const bs = selBlocks(); if (!f || bs.length !== 1 || bs[0].locked) return null;
    const b = bs[0]; const q = toScreen(f.x + b.x, f.y + b.y); const r = stage().getBoundingClientRect();
    const px = cx - r.left, py = cy - r.top;
    for (const h of handles(q.x, q.y, b.w * doc.view.zoom, b.h * doc.view.zoom)) if (Math.abs(px - h.x) <= HANDLE && Math.abs(py - h.y) <= HANDLE) return h.id;
    return null;
  }

  // ---- Stage interaction ------------------------------------------------------------------------------
  function bindStage() {
    const st = stage();
    st.addEventListener('pointerdown', onDown); st.addEventListener('pointermove', onMove); st.addEventListener('pointerup', onUp); st.addEventListener('pointercancel', onUp);
    st.addEventListener('dblclick', e => { const p = toWorld(e.clientX, e.clientY); const f = frameAt(p); const b = f && blockAt(f, p); if (b && (b.kind === 'text' || b.kind === 'list' || b.kind === 'button')) { select(f.id, [b.id]); const ta = $('cvProps').querySelector('[data-p="text"],[data-p="items"]'); if (ta) { ta.focus(); ta.select && ta.select(); } } else if (f && !b) { fitTo([f]); } });
    st.addEventListener('wheel', e => { e.preventDefault(); if (e.ctrlKey || e.metaKey) zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY); else { doc.view.x -= e.deltaX; doc.view.y -= e.deltaY; applyView(); } }, { passive: false });
    st.addEventListener('contextmenu', e => e.preventDefault());
    new ResizeObserver(() => active && drawOverlay()).observe(st);
  }
  function onDown(e) {
    if (e.button === 1 || tool === 'hand' || spaceDown || e.button === 2) { drag = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: doc.view.x, vy: doc.view.y }; stage().setPointerCapture(e.pointerId); stage().style.cursor = 'grabbing'; return; }
    const p = toWorld(e.clientX, e.clientY);
    const f = frameAt(p);
    if (tool === 'frame') { drag = { type: 'draw-frame', start: p, cur: p, moved: false }; stage().setPointerCapture(e.pointerId); return; }
    if (tool !== 'select') { placeTool(f, p); return; }
    const h = handleAt(e.clientX, e.clientY);
    if (h) { const b = selBlocks()[0]; drag = { type: 'resize', h, b, f: selFrame(), start: p, orig: { x: b.x, y: b.y, w: b.w, h: b.h }, moved: false }; stage().setPointerCapture(e.pointerId); return; }
    if (!f) { if (!e.shiftKey) select(null, []); drag = { type: 'marquee', start: p, cur: p }; stage().setPointerCapture(e.pointerId); return; }
    const b = blockAt(f, p);
    if (b) {
      if (e.altKey) { hist.push(doc); const c = Canvas.duplicateBlock(f, b, 0); c.x = b.x; c.y = b.y; select(f.id, [c.id]); drag = { type: 'move', f, blocks: [c], start: p, orig: [{ x: c.x, y: c.y }], moved: true }; rerenderFrame(f); }
      else {
        if (e.shiftKey && sel.frameId === f.id) { const ids = sel.blockIds.includes(b.id) ? sel.blockIds.filter(i => i !== b.id) : [...sel.blockIds, b.id]; select(f.id, ids); }
        else if (!(sel.frameId === f.id && sel.blockIds.includes(b.id))) select(f.id, [b.id]);
        const blocks = selBlocks().filter(x => !x.locked); if (!blocks.length) return;
        drag = { type: 'move', f, blocks, start: p, orig: blocks.map(x => ({ x: x.x, y: x.y })), moved: false };
      }
    } else {
      select(f.id, []);
      if (!f.locked) drag = { type: 'move-frame', f, start: p, orig: { x: f.x, y: f.y }, moved: false };
    }
    stage().setPointerCapture(e.pointerId);
  }
  function onMove(e) {
    lastPointer = toWorld(e.clientX, e.clientY);
    if (!drag) { const p = lastPointer; const f = tool === 'select' ? frameAt(p) : null; const b = f && blockAt(f, p); const next = f ? { frame: f, block: b } : null; if ((next && next.frame) !== (hover && hover.frame) || (next && next.block) !== (hover && hover.block)) { hover = next; drawOverlay(); } const h = handleAt(e.clientX, e.clientY); stage().style.cursor = tool === 'hand' || spaceDown ? 'grab' : h ? handles(0, 0, 0, 0).find(x => x.id === h).cursor : b ? 'move' : tool === 'select' ? 'default' : 'crosshair'; return; }
    const p = toWorld(e.clientX, e.clientY);
    if (drag.type === 'pan') { doc.view.x = drag.vx + (e.clientX - drag.sx); doc.view.y = drag.vy + (e.clientY - drag.sy); applyView(); return; }
    if (drag.type === 'marquee') { drag.cur = p; drawOverlay(); return; }
    if (drag.type === 'draw-frame') { drag.cur = p; if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) * doc.view.zoom > 6) drag.moved = true; drawOverlay(); return; }
    const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) * doc.view.zoom < 3) return;
    if (!drag.moved) { drag.moved = true; hist.push(doc); }
    const u = doc.grid.snap && !e.shiftKey ? (drag.f ? drag.f.layout.grid.unit : 8) : 1;
    if (drag.type === 'move') { drag.blocks.forEach((b, i) => { b.x = Canvas.snap(drag.orig[i].x + dx, u); b.y = Canvas.snap(drag.orig[i].y + dy, u); }); const over = frameAt(p); dropTarget = over && over !== drag.f && !over.locked ? over : null; rerenderFrame(drag.f); drawOverlay(); liveProps(); }
    else if (drag.type === 'move-frame') { drag.f.x = Canvas.snap(drag.orig.x + dx, u); drag.f.y = Canvas.snap(drag.orig.y + dy, u); rerenderFrame(drag.f); drawOverlay(); liveProps(); }
    else if (drag.type === 'resize') {
      const o = drag.orig; let x = o.x, y = o.y, w = o.w, h = o.h; const hd = drag.h;
      if (hd.includes('e')) w = o.w + dx; if (hd.includes('s')) h = o.h + dy; if (hd.includes('w')) { x = o.x + dx; w = o.w - dx; } if (hd.includes('n')) { y = o.y + dy; h = o.h - dy; }
      Canvas.resizeBlock(drag.f, drag.b, { x, y, w: Math.max(4, w), h: Math.max(4, h) }, u);
      rerenderFrame(drag.f); drawOverlay(); liveProps();
    }
  }
  function onUp(e) {
    if (!drag) return;
    const d = drag; drag = null; stage().style.cursor = tool === 'hand' ? 'grab' : 'default';
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
      rerenderFrame(d.f); rerenderFrame(dst); select(dst.id, ids); persist(); updateUndo(); env.toast(`Moved into ${dst.name}`); return;
    }
    dropTarget = null;
    if (d.type === 'marquee') { const x0 = Math.min(d.start.x, d.cur.x), y0 = Math.min(d.start.y, d.cur.y), x1 = Math.max(d.start.x, d.cur.x), y1 = Math.max(d.start.y, d.cur.y); if (x1 - x0 > 4 && y1 - y0 > 4) { const f = frameAt({ x: x0, y: y0 }) || frameAt({ x: x1, y: y1 }); if (f) { const ids = f.layout.blocks.filter(b => !b.hidden && f.x + b.x >= x0 && f.y + b.y >= y0 && f.x + b.x + b.w <= x1 && f.y + b.y + b.h <= y1).map(b => b.id); select(f.id, ids); } } drawOverlay(); return; }
    if (d.moved) { if (d.f && d.f.autoLayout && d.f.autoLayout.mode !== 'none' && d.type !== 'move-frame') { Canvas.applyAutoLayout(d.f); rerenderFrame(d.f); } persist(); updateUndo(); renderLayers(); renderProps(); drawOverlay(); }
  }
  function placeTool(f, p) {
    const kit = env.getKit();
    if (tool === 'frame') { createFrame({ x: p.x, y: p.y }); setTool('select'); return; }
    if (!f) { env.toast('Click inside a frame to add it there'); return; }
    hist.push(doc);
    const kindMap = { text: 'text', body: 'body', rect: 'rect', ellipse: 'ellipse', button: 'button', image: 'image', icon: 'icon', logo: 'logo' };
    const b = Canvas.newBlock(kindMap[tool] || 'text', f, kit, { x: p.x - f.x, y: p.y - f.y });
    if (!b) return;
    f.layout.blocks.push(b);
    if (f.autoLayout.mode !== 'none') Canvas.applyAutoLayout(f);
    select(f.id, [b.id]); setTool('select'); rerenderFrame(f); renderLayers(); renderProps(); drawOverlay(); persist(); updateUndo();
    if (tool === 'image' || b.kind === 'image') { const inp = $('cvProps').querySelector('[data-file="image"]'); if (inp) inp.click(); }
  }
  // A blank frame of the toolbar's format (or a drawn custom size). With center, it lands in view on a free spot.
  function createFrame({ x, y, format, center } = {}) {
    const kit = env.getKit(); const fmt = format || Grid.byId[$('cvFrameFormat').value] || Grid.byId.slide;
    const bgs = kit.colors.filter(c => c.role === 'background').map(c => c.hex).sort((a, b) => Color.luminance(b) - Color.luminance(a));
    let fx = x, fy = y;
    if (center) {
      const r = stage().getBoundingClientRect(); const c = toWorld(r.left + r.width / 2, r.top + r.height / 2); fx = c.x - fmt.w / 2; fy = c.y - fmt.h / 2;
      const hits = f => !f.hidden && !(fx + fmt.w <= f.x || fx >= f.x + f.layout.format.w || fy + fmt.h <= f.y || fy >= f.y + f.layout.format.h);
      let guard = 0; while (doc.frames.some(hits) && guard++ < 60) { const f = doc.frames.filter(hits).sort((a, b) => (b.x + b.layout.format.w) - (a.x + a.layout.format.w))[0]; fx = f.x + f.layout.format.w + 160; }
    }
    hist.push(doc);
    const nf = Canvas.blankFrame(doc, fmt, kit, { x: Canvas.snap(fx, 8), y: Canvas.snap(fy, 8), bg: bgs[0] || '#FFFFFF' });
    select(nf.id, []); renderAll(); persist();
    if (center) { const r = stage().getBoundingClientRect(); const a = toScreen(nf.x, nf.y), b = toScreen(nf.x + fmt.w, nf.y + fmt.h); if (a.x < 0 || a.y < 0 || b.x > r.width || b.y > r.height) fitTo([nf]); }
    return nf;
  }
  // ---- Clipboard: blocks or a whole frame, inside the app and as JSON on the system clipboard -------------------
  function copySelection() {
    const f = selFrame(); if (!f) return false;
    const bs = selBlocks();
    clipboard = bs.length ? { type: 'blocks', frameId: f.id, blocks: bs.map(b => Canvas.clone(b)) } : { type: 'frame', frame: Canvas.clone(f) };
    try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(JSON.stringify({ lgClip: clipboard })).catch(() => { }); } catch { }
    env.toast(bs.length ? `Copied ${bs.length} block${bs.length > 1 ? 's' : ''}` : `Copied frame ${f.name}`);
    return true;
  }
  function pasteClipboard(clip = clipboard) {
    if (!clip) { env.toast('Nothing to paste yet. Select blocks or a frame and press ⌘C.'); return; }
    hist.push(doc);
    if (clip.type === 'frame') {
      const src = clip.frame; const c = Canvas.addFrame(doc, src.layout, { name: src.name.replace(/ copy( \d+)?$/, '') + ' copy' }); c.autoLayout = Canvas.clone(src.autoLayout); c.clip = src.clip;
      select(c.id, []); renderAll(); persist(); return;
    }
    const f = selFrame() || (lastPointer && frameAt(lastPointer)) || doc.frames[doc.frames.length - 1];
    if (!f) { env.toast('Add a frame to paste into'); return; }
    const same = f.id === clip.frameId; const u = f.layout.grid.unit;
    const ids = Canvas.pasteBlocks(f, clip.blocks, { dx: same ? 2 * u : 0, dy: same ? 2 * u : 0 }).map(b => b.id);
    if (same) clip.blocks.forEach(b => { b.x += 2 * u; b.y += 2 * u; });
    if (f.autoLayout.mode !== 'none') Canvas.applyAutoLayout(f);
    select(f.id, ids); rerenderFrame(f); renderLayers(); persist(); updateUndo();
  }
  function select(frameId, blockIds) { sel.frameId = frameId; sel.blockIds = blockIds || []; renderLayers(); renderProps(); drawOverlay(); }

  // ---- Keyboard --------------------------------------------------------------------------------------------
  function bindKeys() {
    document.addEventListener('keydown', e => {
      if (!active) return; const tag = (e.target.tagName || '').toLowerCase(); const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
      if (e.key === ' ' && !typing) { spaceDown = true; stage().style.cursor = 'grab'; e.preventDefault(); return; }
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (meta && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      if (meta && e.key.toLowerCase() === 'l') { e.preventDefault(); copyLink(); return; }
      if (typing) return;
      if (meta && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelection(); return; }
      if (meta && e.key.toLowerCase() === 'c') { if (copySelection()) e.preventDefault(); return; }
      if (meta && e.key.toLowerCase() === 'x') { if (copySelection()) { e.preventDefault(); deleteSelection(); } return; }
      if (meta && e.key.toLowerCase() === 'v') { if (clipboard) { e.preventDefault(); pasteClipboard(); } return; }
      if (e.shiftKey && e.key.toLowerCase() === 'n' && !meta) { e.preventDefault(); createFrame({ center: true }); return; }
      if (meta && e.key.toLowerCase() === 'g') { e.preventDefault(); const f = selFrame(); if (f) { f.showGrid = !f.showGrid; rerenderFrame(f); } return; }
      if (meta && e.key.toLowerCase() === 'a') { e.preventDefault(); const f = selFrame(); if (f) select(f.id, f.layout.blocks.filter(b => !b.hidden).map(b => b.id)); return; }
      const k = e.key.toLowerCase();
      if (k === 'v') setTool('select'); else if (k === 'h') setTool('hand'); else if (k === 't') setTool('text'); else if (k === 'r') setTool('rect'); else if (k === 'o') setTool('ellipse'); else if (k === 'f') setTool('frame'); else if (k === 'i') setTool('image');
      else if (k === 'escape') { if (sel.blockIds.length) select(sel.frameId, []); else select(null, []); setTool('select'); }
      else if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSelection(); }
      else if (k === '0') fit(); else if (k === '=' || k === '+') zoomBy(1.2); else if (k === '-') zoomBy(1 / 1.2);
      else if (k === '1' && e.shiftKey) { const f = selFrame(); if (f) fitTo([f]); }
      else if (k.startsWith('arrow')) { const f = selFrame(); const bs = selBlocks().filter(b => !b.locked); if (!f) return; e.preventDefault(); const step = e.shiftKey ? f.layout.grid.unit : 1; const dx = k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0, dy = k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0; hist.push(doc); if (bs.length) bs.forEach(b => { b.x += dx; b.y += dy; }); else { f.x += dx; f.y += dy; } rerenderFrame(f); drawOverlay(); liveProps(); persist(); updateUndo(); }
      else if (k === '[' ) { const f = selFrame(); selBlocks().forEach(b => Canvas.reorder(f, b, e.shiftKey ? 'back' : -1)); if (f) { hist.push(doc); rerenderFrame(f); renderLayers(); persist(); } }
      else if (k === ']' ) { const f = selFrame(); selBlocks().forEach(b => Canvas.reorder(f, b, e.shiftKey ? 'front' : 1)); if (f) { hist.push(doc); rerenderFrame(f); renderLayers(); persist(); } }
    });
    document.addEventListener('keyup', e => { if (e.key === ' ') { spaceDown = false; if (active) stage().style.cursor = tool === 'hand' ? 'grab' : 'default'; } });
    // JSON copied from another tab or session pastes as blocks or a frame.
    document.addEventListener('paste', e => {
      if (!active) return; const tag = (e.target.tagName || '').toLowerCase(); if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
      const text = e.clipboardData && e.clipboardData.getData('text/plain'); if (!text || text[0] !== '{') return;
      try { const j = JSON.parse(text); if (j && j.lgClip && (j.lgClip.type === 'blocks' || j.lgClip.type === 'frame')) { e.preventDefault(); pasteClipboard(j.lgClip); } } catch { }
    });
  }
  function setTool(t) { tool = t; document.querySelectorAll('#cvTools [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t)); stage().style.cursor = t === 'hand' ? 'grab' : t === 'select' ? 'default' : 'crosshair'; }
  function undo() { const d = hist.undo(doc); if (d) { doc = d; persist(); renderAll(); } }
  function redo() { const d = hist.redo(doc); if (d) { doc = d; persist(); renderAll(); } }
  function deleteSelection() {
    const f = selFrame(); if (!f) return; hist.push(doc);
    if (sel.blockIds.length) { Canvas.removeBlocks(f, sel.blockIds); if (f.autoLayout.mode !== 'none') Canvas.applyAutoLayout(f); select(f.id, []); rerenderFrame(f); }
    else { doc.frames = doc.frames.filter(x => x !== f); select(null, []); renderAll(); }
    persist(); updateUndo(); renderLayers();
  }
  function duplicateSelection() {
    const f = selFrame(); if (!f) return; hist.push(doc);
    if (sel.blockIds.length) { const ids = selBlocks().map(b => Canvas.duplicateBlock(f, b, f.layout.grid.unit).id); select(f.id, ids); rerenderFrame(f); }
    else { const c = Canvas.addFrame(doc, f.layout, { x: f.x + f.layout.format.w + 160, y: f.y, name: f.name + ' copy' }); c.autoLayout = Canvas.clone(f.autoLayout); select(c.id, []); renderAll(); }
    persist(); updateUndo(); renderLayers(); renderProps();
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
    $('cvLoad').addEventListener('change', async e => { const f = e.target.files[0]; if (!f) return; try { hist.push(doc); doc = Canvas.deserialize(await f.text()); select(null, []); renderAll(); fit(); env.toast('Canvas loaded'); } catch (err) { env.toast('Could not load: ' + err.message); } e.target.value = ''; });
    $('cvClear').addEventListener('click', () => { if (!doc.frames.length) return; hist.push(doc); doc.frames = []; select(null, []); renderAll(); persist(); });
    $('cvExport').addEventListener('click', async e => {
      const b = e.target.closest('[data-export]'); if (!b) return; const what = b.dataset.export; const f = selFrame();
      const t = b.textContent; b.disabled = true; b.textContent = '…';
      try {
        if (what === 'png' || what === 'svg' || what === 'pptx' || what === 'html') { if (!f) { env.toast('Select a frame first'); return; } }
        if (what === 'png') { const blob = await env.exportPNG(f.layout); if (await env.download(blob, `${slug(f.name)}.png`)) env.toast('PNG saved'); }
        else if (what === 'svg') { const svg = await env.exportSVG(f.layout); if (await env.download(new Blob([svg], { type: 'image/svg+xml' }), `${slug(f.name)}.svg`)) env.toast('SVG saved'); }
        else if (what === 'pptx') { const frames = doc.frames.filter(x => x.layout.format.id === f.layout.format.id && !x.hidden); const blob = await env.buildPptx(frames.map(x => x.layout)); if (await env.download(blob, `${slug(doc.name)}-${f.layout.format.id}.pptx`)) env.toast(`PPTX saved: ${frames.length} slide${frames.length > 1 ? 's' : ''} of this format`); }
        else if (what === 'html') { await copyText(Canvas.toHTML(f, { assets: env.getAssets() })); env.toast('HTML/CSS copied'); }
        else if (what === 'canvas') { const blob = await exportCanvasPNG(); if (blob && await env.download(blob, `${slug(doc.name)}-canvas.png`)) env.toast('Canvas PNG saved'); }
        else if (what === 'all') { let n = 0; for (const fr of doc.frames.filter(x => !x.hidden)) { const blob = await env.exportPNG(fr.layout); if (!(await env.download(blob, `${slug(fr.name)}.png`))) break; n++; await new Promise(r => setTimeout(r, 350)); } if (n) env.toast(`${n} PNG${n > 1 ? 's' : ''} saved`); }
      } catch (err) { console.error(err); env.toast('Export failed: ' + err.message); } finally { b.disabled = false; b.textContent = t; $('cvExport').removeAttribute('open'); }
    });
  }
  const slug = s => String(s || 'canvas').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'canvas';
  async function copyText(text) { try { await navigator.clipboard.writeText(text); } catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } finally { ta.remove(); } } }
  async function copyLink() {
    try {
      const link = await Canvas.toLink(doc);
      await copyText(link);
      const hasImages = doc.frames.some(f => f.layout.blocks.some(b => b.kind === 'image'));
      env.toast(link.length > 60000 ? 'Link copied (very long; a hosted link is the next step)' : hasImages ? 'Link copied: layout and copy travel, images do not yet' : 'Link copied');
    } catch (err) { env.toast('Could not build a link: ' + err.message); }
  }
  async function exportCanvasPNG() {
    const frames = doc.frames.filter(f => !f.hidden); if (!frames.length) { env.toast('Nothing on the canvas'); return null; }
    const margin = 120; const x0 = Math.min(...frames.map(f => f.x)) - margin, y0 = Math.min(...frames.map(f => f.y)) - margin;
    const x1 = Math.max(...frames.map(f => f.x + f.layout.format.w)) + margin, y1 = Math.max(...frames.map(f => f.y + f.layout.format.h)) + margin;
    const scale = Math.min(1, 7000 / Math.max(x1 - x0, y1 - y0));
    const c = document.createElement('canvas'); c.width = Math.round((x1 - x0) * scale); c.height = Math.round((y1 - y0) * scale);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#1b1b22'; ctx.fillRect(0, 0, c.width, c.height);
    for (const f of frames) { const blob = await env.exportPNG(f.layout); const url = URL.createObjectURL(blob); try { const img = new Image(); await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; }); ctx.drawImage(img, (f.x - x0) * scale, (f.y - y0) * scale, f.layout.format.w * scale, f.layout.format.h * scale); } finally { URL.revokeObjectURL(url); } }
    return new Promise(res => c.toBlob(res, 'image/png'));
  }

  // ---- Layers panel ----------------------------------------------------------------------------------------------
  function label(b) { if (b.kind === 'text') return `${b.role || 'text'} · ${Canvas.sourceText(b).slice(0, 28)}`; if (b.kind === 'list') return `${b.role || 'list'} · ${(b.items || []).length} items`; if (b.kind === 'button') return `button · ${b.text}`; if (b.kind === 'image') return 'image'; if (b.kind === 'field') return b.container ? 'card' : 'rectangle'; if (b.kind === 'shape') return b.shape; if (b.kind === 'icon') return `icon · ${b.name}`; return b.kind; }
  const KIND_GLYPH = { text: 'T', list: '≡', button: '▭', image: '▣', field: '■', shape: '●', icon: '✦', logo: 'L', scrim: '▒', rule: '—', line: '—', badge: '①' };
  function renderLayers() {
    const q = ($('cvSearch').value || '').toLowerCase();
    $('cvLayers').innerHTML = doc.frames.slice().reverse().map(f => {
      const blocks = f.layout.blocks.slice().reverse().filter(b => !q || label(b).toLowerCase().includes(q));
      return `<div class="cv-layer-frame ${sel.frameId === f.id && !sel.blockIds.length ? 'on' : ''}" data-frame="${f.id}">
        <div class="cv-layer-row frame"><button class="eye ${f.hidden ? 'off' : ''}" data-eye-frame="${f.id}" title="Toggle visibility">${f.hidden ? '◌' : '◉'}</button><span class="nm" title="${esc(f.name)}">${esc(f.name)}</span><span class="dim">${f.layout.format.w}×${f.layout.format.h}</span></div>
        <div class="cv-layer-children">${blocks.map(b => `<div class="cv-layer-row block ${sel.frameId === f.id && sel.blockIds.includes(b.id) ? 'on' : ''} ${b.hidden ? 'hidden-layer' : ''}" data-frame="${f.id}" data-block="${b.id}"><span class="glyph">${KIND_GLYPH[b.kind] || '·'}</span><span class="nm">${esc(label(b))}</span>${b.locked ? '<span class="dim">🔒</span>' : ''}<button class="eye ${b.hidden ? 'off' : ''}" data-eye="${b.id}" title="Toggle visibility">${b.hidden ? '◌' : '◉'}</button></div>`).join('')}</div>
      </div>`;
    }).join('') || '<div class="hint" style="padding:10px">No frames yet. Send layouts here from Single or Deck mode, or press F to draw a frame.</div>';
  }
  function bindLayers() {
    $('cvLayers').addEventListener('click', e => {
      const eyeF = e.target.closest('[data-eye-frame]'); if (eyeF) { const f = Canvas.frameById(doc, eyeF.dataset.eyeFrame); f.hidden = !f.hidden; rerenderFrame(f); renderLayers(); persist(); return; }
      const eye = e.target.closest('[data-eye]'); if (eye) { const f = Canvas.frameById(doc, eye.closest('[data-frame]').dataset.frame); const b = Canvas.blockById(f, eye.dataset.eye); b.hidden = !b.hidden; rerenderFrame(f); renderLayers(); persist(); return; }
      const row = e.target.closest('.cv-layer-row'); if (!row) return;
      const fid = row.closest('[data-frame]').dataset.frame;
      if (row.dataset.block) { if (e.shiftKey && sel.frameId === fid) select(fid, sel.blockIds.includes(row.dataset.block) ? sel.blockIds.filter(i => i !== row.dataset.block) : [...sel.blockIds, row.dataset.block]); else select(fid, [row.dataset.block]); }
      else select(fid, []);
    });
    $('cvSearch').addEventListener('input', renderLayers);
  }

  // ---- Properties panel ------------------------------------------------------------------------------------------
  const num = (k, label, v, step = 1, extra = '') => `<label class="cv-f"><span>${label}</span><input type="number" data-p="${k}" value="${Math.round(v * 100) / 100}" step="${step}" ${extra}></label>`;
  const color = (k, label, v) => `<label class="cv-f"><span>${label}</span><span class="cv-color"><input type="color" data-p="${k}" value="${toHex(v)}"><input type="text" data-p="${k}" value="${esc(v)}" class="hex"></span></label><div class="cv-swatches">${env.getKit().colors.map(c => `<button type="button" class="sw ${toHex(c.hex) === toHex(v) ? 'on' : ''}" data-sw="${toHex(c.hex)}" data-for="${k}" title="${esc(c.name || '')} ${toHex(c.hex)}" style="background:${toHex(c.hex)}"></button>`).join('')}<button type="button" class="sw edit" data-act="edit-palette" title="Edit the brand palette">✎</button></div>`;
  const ROLES = ['core', 'accent', 'background', 'neutral'];
  function paletteEditor() {
    const kit = env.getKit();
    return `<div class="cv-section" data-palette><h3>Brand palette</h3>
      ${kit.colors.map((c, i) => `<div class="cv-pal-row"><input type="color" data-pal="hex" data-i="${i}" value="${toHex(c.hex)}" title="${toHex(c.hex)}"><input type="text" data-pal="name" data-i="${i}" value="${esc(c.name || '')}" placeholder="Name"><select data-pal="role" data-i="${i}" title="Role">${ROLES.map(r => `<option value="${r}" ${c.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select><button type="button" class="btn small ghost" data-pal="rm" data-i="${i}" title="Remove">✕</button></div>`).join('')}
      <div class="cv-row"><button type="button" class="btn small" data-act="add-color">＋ Add color</button><button type="button" class="btn small ghost" data-act="reset-palette">Reset to preset</button></div>
      <p class="hint">These are the swatches in every color field, and the colors the generator may use. Roles decide what can be a background, an accent, or a core brand color.</p>
    </div>`;
  }
  function genSection(f, b) {
    const s = ImageGen.settings.get(); const P = ImageGen.PROVIDERS[s.provider]; const ready = ImageGen.ready();
    const prompt = b.genPrompt || ImageGen.promptFor(f, env.getKit());
    const model = P ? (P.models.find(m => m[0] === s.model) || P.models[0])[1] : '';
    return `<div class="cv-section"><h3>Generate image</h3>
      <textarea class="cv-text" data-gen="prompt" rows="5" spellcheck="true">${esc(prompt)}</textarea>
      <div class="cv-row"><button type="button" class="btn small primary" data-act="gen-image" ${ready ? '' : 'disabled'}>${ready ? 'Generate' : 'Generate'}</button><button type="button" class="btn small" data-act="gen-reset" title="Rewrite the prompt from the frame's copy">↻ From frame</button></div>
      <p class="hint">${ready ? `${esc(P.name)} · ${esc(model)} · ${ImageGen.aspectOf(b.w, b.h)} · <a href="#" data-act="open-settings">change</a>` : 'Pick a provider (Gemini or OpenAI) and add a key in <a href="#" data-act="open-settings">Settings</a>. Runs locally or from your own host; published copies cannot call out.'}</p>
      ${b.genMeta ? `<p class="hint">Last: ${esc(b.genMeta.provider)} · ${esc(b.genMeta.model)} · ${Math.round(b.genMeta.ms / 100) / 10}s</p>` : ''}
    </div>`;
  }
  const toHex = v => { try { return Color.normalize(v); } catch { return '#000000'; } };
  const selectF = (k, label, v, opts) => `<label class="cv-f"><span>${label}</span><select data-p="${k}">${opts.map(o => `<option value="${o[0]}" ${String(o[0]) === String(v) ? 'selected' : ''}>${o[1]}</option>`).join('')}</select></label>`;
  function renderProps() {
    const el = $('cvProps'); const f = selFrame(); const bs = selBlocks();
    if (!f) { el.innerHTML = `<div class="cv-section"><h3>Canvas</h3><label class="cv-f"><span>Name</span><input type="text" data-doc="name" value="${esc(doc.name)}"></label><div class="cv-row"><button type="button" class="btn small" data-act="new-frame">＋ New frame</button><button type="button" class="btn small" data-act="paste" ${clipboard ? '' : 'disabled'}>Paste</button></div><p class="hint">${doc.frames.length} frames. Select a frame to edit its layout, or a block inside it. Drag a block onto another frame to move it there; ⌥ drag copies. Hold space to pan, ⌘ wheel to zoom. Keys: V select · H hand · F frame (drag to draw) · ⇧N new frame · T text · R rectangle · O ellipse · I image · ⌘C ⌘X ⌘V copy cut paste · ⌘Z undo · ⌘D duplicate · ⌘L copy link · [ ] reorder.</p></div>${paletteEditor()}`; return; }
    if (!bs.length) { el.innerHTML = frameProps(f); return; }
    if (bs.length > 1) { el.innerHTML = `<div class="cv-section"><h3>${bs.length} blocks</h3>${alignBar()}<div class="cv-row"><button class="btn small" data-act="dist-h">Distribute ↔</button><button class="btn small" data-act="dist-v">Distribute ↕</button></div><div class="cv-row"><button class="btn small" data-act="copy">Copy</button><button class="btn small" data-act="dup">Duplicate</button><button class="btn small" data-act="del">Delete</button></div></div>`; return; }
    el.innerHTML = blockProps(f, bs[0]);
  }
  function alignBar() { return `<div class="cv-row cv-align">${[['left', '⇤'], ['hcenter', '⇔'], ['right', '⇥'], ['top', '⤒'], ['vcenter', '⇕'], ['bottom', '⤓']].map(([m, g]) => `<button class="btn small" data-align="${m}" title="Align ${m}">${g}</button>`).join('')}</div>`; }
  function frameProps(f) {
    const L = f.layout, al = f.autoLayout;
    return `<div class="cv-section"><h3>Frame</h3>
      <label class="cv-f"><span>Name</span><input type="text" data-f="name" value="${esc(f.name)}"></label>
      <div class="cv-grid2">${num('x', 'X', f.x, 8)}${num('y', 'Y', f.y, 8)}${num('w', 'W', L.format.w, 8)}${num('h', 'H', L.format.h, 8)}</div>
      ${selectF('format', 'Format', L.format.id, Grid.FORMATS.map(x => [x.id, `${x.name} ${x.w}×${x.h}`]).concat([['custom', 'Custom']]))}
      <label class="cv-check"><input type="checkbox" data-f="clip" ${f.clip ? 'checked' : ''}> Clip content (⌥C)</label>
      <label class="cv-check"><input type="checkbox" data-f="showGrid" ${f.showGrid ? 'checked' : ''}> Show grid (⌘G)</label>
      <label class="cv-check"><input type="checkbox" data-f="locked" ${f.locked ? 'checked' : ''}> Lock position</label>
    </div>
    <div class="cv-section"><h3>Layout</h3>
      ${selectF('al.mode', 'Flex', al.mode, [['none', 'Off (free)'], ['vertical', 'Vertical stack'], ['horizontal', 'Horizontal row']])}
      <div class="cv-grid2">${num('al.gap', 'Gap', al.gap, 4)}${num('al.padding', 'Padding', al.padding, 4)}</div>
      ${selectF('al.align', 'Align', al.align, [['start', 'Start'], ['center', 'Center'], ['end', 'End']])}
      ${selectF('al.justify', 'Justify', al.justify, [['start', 'Start'], ['center', 'Center'], ['end', 'End'], ['space-between', 'Space between']])}
      <label class="cv-check"><input type="checkbox" data-f="al.fill" ${al.fill ? 'checked' : ''}> Stretch text to inner width</label>
      <p class="hint">Flex stacks the frame's content blocks in reading order with gap and padding. Backgrounds stay put. Drag a block to reorder it.</p>
    </div>
    <div class="cv-section"><h3>Fill</h3>${color('bg', 'Background', L.palette.bg)}</div>
    <div class="cv-section"><h3>Add</h3><div class="cv-row wrap">${[['text', 'Headline'], ['body', 'Body'], ['button', 'Button'], ['rect', 'Rectangle'], ['ellipse', 'Ellipse'], ['image', 'Image'], ['icon', 'Icon'], ['logo', 'Logo']].map(([k, l]) => `<button class="btn small" data-add="${k}">${l}</button>`).join('')}</div></div>
    <div class="cv-section"><h3>Code</h3><p class="hint">The frame is this JSON. Edit and apply, or copy it as HTML/CSS from Export.</p><textarea class="cv-code" data-code="frame" spellcheck="false">${esc(JSON.stringify(stripLayout(L), null, 1))}</textarea><div class="cv-row"><button class="btn small" data-act="apply-code">Apply JSON</button><button class="btn small" data-act="copy-code">Copy</button></div></div>
    <div class="cv-section"><div class="cv-row wrap"><button class="btn small" data-act="copy">Copy frame</button><button class="btn small" data-act="paste" ${clipboard ? '' : 'disabled'}>Paste</button><button class="btn small" data-act="dup">Duplicate frame</button><button class="btn small" data-act="del">Delete frame</button></div></div>`;
  }
  function blockProps(f, b) {
    const isText = b.kind === 'text' || b.kind === 'list' || b.kind === 'button';
    const fontNames = Brand.allFontNames();
    const famName = isText ? String(b.font.family).split(',')[0].replace(/["']/g, '').trim() : '';
    return `<div class="cv-section"><h3>${esc(b.role || b.kind)}</h3>
      <div class="cv-grid2">${num('x', 'X', b.x, 8)}${num('y', 'Y', b.y, 8)}${num('w', 'W', b.w, 8)}${num('h', 'H', b.h, 8)}</div>
      ${alignBar()}
      <div class="cv-row wrap"><button class="btn small" data-act="back" title="Send backward ([)">↓ Back</button><button class="btn small" data-act="front" title="Bring forward (])">↑ Front</button><button class="btn small" data-act="copy" title="Copy (⌘C)">Copy</button><button class="btn small" data-act="paste" title="Paste (⌘V)" ${clipboard ? '' : 'disabled'}>Paste</button><button class="btn small" data-act="dup" title="Duplicate (⌘D)">Duplicate</button><button class="btn small" data-act="del" title="Delete (⌫)">Delete</button></div>
      <label class="cv-check"><input type="checkbox" data-b="locked" ${b.locked ? 'checked' : ''}> Lock</label>
      <label class="cv-check"><input type="checkbox" data-b="decorative" ${b.decorative ? 'checked' : ''}> Decorative (not content)</label>
    </div>
    ${b.kind === 'text' ? `<div class="cv-section"><h3>Text</h3><textarea class="cv-text" data-p="text" rows="3" spellcheck="true">${esc(Canvas.sourceText(b))}</textarea>${b.overflow ? '<p class="hint" style="color:var(--danger)">Text is wider than its box. Widen the box or lower the size.</p>' : ''}</div>` : ''}
    ${b.kind === 'list' ? `<div class="cv-section"><h3>Items</h3><textarea class="cv-text" data-p="items" rows="4" spellcheck="true">${esc((b.items || []).join('\n'))}</textarea>${selectF('marker', 'Marker', b.marker || 'bullet', [['bullet', 'Bullet'], ['number', 'Number'], ['none', 'None']])}</div>` : ''}
    ${b.kind === 'button' ? `<div class="cv-section"><h3>Label</h3><input type="text" class="cv-text" data-p="text" value="${esc(b.text)}">${color('color', 'Text color', b.color)}</div>` : ''}
    ${isText ? `<div class="cv-section"><h3>Typography</h3>
      ${selectF('font.familyName', 'Font', famName, fontNames.map(n => [n, n]).concat(fontNames.includes(famName) ? [] : [[famName, famName]]))}
      <div class="cv-grid2">${num('font.size', 'Size', b.font.size, 2)}${selectF('font.weight', 'Weight', b.font.weight, Brand.fontWeights(famName).map(w => [w, w]).concat(Brand.fontWeights(famName).includes(b.font.weight) ? [] : [[b.font.weight, b.font.weight]]))}</div>
      <div class="cv-grid2">${num('font.lineHeight', 'Line height', b.font.lineHeight || 1.2, 0.05)}${num('font.letterSpacing', 'Tracking (em)', b.font.letterSpacing || 0, 0.01)}</div>
      ${b.kind === 'text' ? selectF('align', 'Align', b.align || 'left', [['left', 'Left'], ['center', 'Center'], ['right', 'Right']]) : ''}
      ${b.kind === 'text' ? selectF('font.transform', 'Case', b.font.transform || 'none', [['none', 'As written'], ['upper', 'UPPERCASE'], ['lower', 'lowercase']]) : ''}
      <button class="btn small" data-act="fit-text">Fit size to box</button>
    </div>` : ''}
    ${b.kind === 'image' ? `<div class="cv-section"><h3>Image</h3>${selectF('focal', 'Crop focus', b.focal || 'xMidYMid', [['xMinYMin', 'Top left'], ['xMidYMin', 'Top'], ['xMaxYMin', 'Top right'], ['xMinYMid', 'Left'], ['xMidYMid', 'Center'], ['xMaxYMid', 'Right'], ['xMinYMax', 'Bottom left'], ['xMidYMax', 'Bottom'], ['xMaxYMax', 'Bottom right']])}${num('radius', 'Radius', b.radius || 0, 4)}<label class="btn small file">Replace image<input type="file" accept="image/*" data-file="image" hidden></label>${selectF('asset', 'Asset', b.asset || '', env.getAssets().images.map(a => [a.id, a.name]).concat([['', 'None']]))}</div>` : ''}
    ${b.kind === 'image' ? genSection(f, b) : ''}
    ${b.kind === 'icon' ? `<div class="cv-section"><h3>Icon</h3>${selectF('name', 'Icon', b.name, Icons.names.map(n => [n, n]))}</div>` : ''}
    ${b.kind === 'shape' ? `<div class="cv-section"><h3>Shape</h3>${selectF('shape', 'Shape', b.shape, [['circle', 'Circle'], ['pill', 'Pill'], ['quarter', 'Quarter circle']])}</div>` : ''}
    ${(b.kind !== 'image' && b.kind !== 'icon' && b.kind !== 'logo') || b.kind === 'logo' ? `<div class="cv-section"><h3>Fill</h3>${color('fill', b.kind === 'text' || b.kind === 'list' ? 'Text color' : 'Fill', b.fill || '#000000')}${(b.kind === 'field' || b.kind === 'button') ? num('radius', 'Radius', b.radius || 0, 4) : ''}${b.kind === 'field' ? num('alpha', 'Opacity', b.alpha ?? 1, 0.05, 'min="0" max="1"') : ''}</div>` : ''}
    <div class="cv-section"><h3>Code</h3><textarea class="cv-code" data-code="block" spellcheck="false">${esc(JSON.stringify(stripBlock(b), null, 1))}</textarea><div class="cv-row"><button class="btn small" data-act="apply-code">Apply JSON</button><button class="btn small" data-act="copy-code">Copy</button></div></div>`;
  }
  function stripBlock(b) { const c = Canvas.clone(b); delete c.lines; delete c.inkW; delete c.capacity; delete c.gap; delete c.maxLines; delete c.minSize; delete c.overflow; delete c.genPrompt; delete c.genMeta; return c; }
  function stripLayout(L) { const c = Canvas.clone(L); delete c.signature; c.blocks = c.blocks.map(stripBlock); return c; }
  function liveProps() {
    const f = selFrame(); const bs = selBlocks(); const el = $('cvProps');
    const set = (k, v) => { const inp = el.querySelector(`input[data-p="${k}"]`); if (inp && document.activeElement !== inp) inp.value = Math.round(v * 100) / 100; };
    if (f && bs.length === 1) { set('x', bs[0].x); set('y', bs[0].y); set('w', bs[0].w); set('h', bs[0].h); } else if (f && !bs.length) { set('x', f.x); set('y', f.y); }
  }
  function bindProps() {
    const el = $('cvProps');
    const getPath = (o, path) => path.split('.').reduce((a, k) => a == null ? a : a[k], o);
    const setPath = (o, path, v) => { const ks = path.split('.'); let t = o; for (let i = 0; i < ks.length - 1; i++) { if (t[ks[i]] == null) t[ks[i]] = {}; t = t[ks[i]]; } t[ks[ks.length - 1]] = v; };
    const apply = (e, live) => {
      const t = e.target; const f = selFrame(); if (!f) { if (t.dataset.doc === 'name') { doc.name = t.value; persist(); } return; }
      const bs = selBlocks();
      if (!live) hist.push(doc);
      if (t.dataset.f) { const k = t.dataset.f; const v = t.type === 'checkbox' ? t.checked : t.value; if (k.startsWith('al.')) { f.autoLayout[k.slice(3)] = t.type === 'number' ? +v : v; Canvas.applyAutoLayout(f); } else f[k] = v; if (k === 'clip' || k === 'showGrid') renderFrames(); else rerenderFrame(f); renderLayers(); drawOverlay(); persist(); return; }
      if (t.dataset.b && bs.length) { for (const b of bs) b[t.dataset.b] = t.checked; renderLayers(); drawOverlay(); persist(); return; }
      const k = t.dataset.p; if (!k) return;
      if (!bs.length) { // frame-level numeric / palette fields
        if (k === 'x') f.x = +t.value; else if (k === 'y') f.y = +t.value;
        else if (k === 'w' || k === 'h') { f.layout.format[k] = Math.max(64, +t.value); f.layout.format.id = 'custom'; f.layout.format.name = 'Custom'; regrid(f); }
        else if (k === 'format') { const fm = Grid.byId[t.value]; if (fm) { f.layout.format = { id: fm.id, name: fm.name, w: fm.w, h: fm.h }; regrid(f); if (f.autoLayout.mode !== 'none') Canvas.applyAutoLayout(f); } }
        else if (k === 'bg') { f.layout.palette.bg = toHex(t.value); }
        if (k.startsWith('al.')) { f.autoLayout[k.slice(3)] = t.type === 'number' ? +t.value : t.value; Canvas.applyAutoLayout(f); }
        rerenderFrame(f); drawOverlay(); if (!live) renderProps(); persist(); return;
      }
      for (const b of bs) {
        if (k === 'text') { b.text = t.value; Canvas.refit(b); }
        else if (k === 'items') { b.items = t.value.split('\n').map(x => x.trim()).filter(Boolean); Canvas.refit(b); }
        else if (k === 'font.familyName') { b.font.family = Brand.fontCss(t.value); const ws = Brand.fontWeights(t.value); if (!ws.includes(b.font.weight)) b.font.weight = ws.reduce((p, c) => Math.abs(c - b.font.weight) < Math.abs(p - b.font.weight) ? c : p, ws[0]); Canvas.refit(b); }
        else if (k.startsWith('font.')) { setPath(b, k, t.type === 'number' ? +t.value : (k === 'font.weight' ? +t.value : t.value)); Canvas.refit(b); }
        else if (k === 'x' || k === 'y') b[k] = +t.value;
        else if (k === 'w' || k === 'h') { b[k] = Math.max(4, +t.value); Canvas.refit(b); }
        else if (k === 'fill' || k === 'color') b[k] = toHex(t.value);
        else if (k === 'radius' || k === 'alpha') b[k] = +t.value;
        else if (k === 'asset') b.asset = t.value || null;
        else b[k] = t.value;
      }
      if (f.autoLayout.mode !== 'none' && !live) Canvas.applyAutoLayout(f);
      rerenderFrame(f); drawOverlay(); renderLayers(); persist(); if (!live) renderProps();
    };
    // Live fields (color, textarea) snapshot history on their FIRST input event, so undo returns to the text before the edit.
    let liveField = null;
    el.addEventListener('change', e => { if (e.target.dataset.pal || e.target.dataset.gen) return; if (liveField === e.target) { liveField = null; apply(e, true); renderProps(); } else apply(e, false); });
    // Brand palette rows edit the kit itself; the generator and every swatch row follow.
    el.addEventListener('change', e => {
      const t = e.target; const key = t.dataset.pal; if (!key || key === 'rm') return;
      const colors = env.getKit().colors.map(c => ({ ...c })); const c = colors[+t.dataset.i]; if (!c) return;
      if (key === 'hex') c.hex = toHex(t.value); else if (key === 'name') c.name = t.value.trim(); else if (key === 'role') c.role = t.value;
      env.updateColors(colors); renderProps();
    });
    el.addEventListener('input', e => { const t = e.target; if (t.dataset.gen) { const b = selBlocks()[0]; if (b) { b.genPrompt = t.value; persist(); } return; } if (t.dataset.pal) return; if (t.type === 'color' || t.type === 'range' || (t.tagName === 'TEXTAREA' && t.dataset.p) || (t.type === 'text' && t.dataset.p === 'text')) { if (liveField !== t) { hist.push(doc); liveField = t; updateUndo(); } if (t.type === 'color') { const hex = t.parentElement.querySelector('.hex'); if (hex) hex.value = t.value; } apply(e, true); } });
    el.addEventListener('click', async e => {
      const f = selFrame(); const bs = selBlocks();
      const sw = e.target.closest('[data-sw]'); if (sw) { const hex = el.querySelector(`input.hex[data-p="${sw.dataset.for}"]`); if (hex) { hex.value = sw.dataset.sw; const ci = hex.parentElement.querySelector('input[type="color"]'); if (ci) ci.value = sw.dataset.sw; hex.dispatchEvent(new Event('change', { bubbles: true })); } return; }
      const pal = e.target.closest('[data-pal="rm"]'); if (pal) { const colors = env.getKit().colors.filter((_, i) => i !== +pal.dataset.i); env.updateColors(colors); renderProps(); return; }
      const act0 = e.target.closest('[data-act]'); const a0 = act0 && act0.dataset.act;
      if (a0 === 'edit-palette') { select(null, []); const sec = el.querySelector('[data-palette]'); if (sec) sec.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
      if (a0 === 'add-color') { const colors = env.getKit().colors.map(c => ({ ...c })); colors.push({ name: 'Color ' + (colors.length + 1), hex: '#888888', role: 'accent' }); env.updateColors(colors); renderProps(); const rows = el.querySelectorAll('.cv-pal-row'); const last = rows.length ? rows[rows.length - 1].querySelector('input[type="text"]') : null; if (last) { last.focus(); last.select(); } return; }
      if (a0 === 'reset-palette') { if (env.resetColors()) { renderProps(); env.toast('Palette reset to the preset'); } else env.toast('This kit has no preset to reset to'); return; }
      if (a0 === 'new-frame') { createFrame({ center: true }); return; }
      if (a0 === 'copy') { copySelection(); renderProps(); return; }
      if (a0 === 'paste') { pasteClipboard(); return; }
      if (a0 === 'open-settings') { e.preventDefault(); env.openSettings(); return; }
      if (a0 === 'gen-reset' && f && bs[0]) { bs[0].genPrompt = null; persist(); renderProps(); return; }
      if (a0 === 'gen-image' && f && bs[0]) {
        const b = bs[0]; const ta = el.querySelector('[data-gen="prompt"]'); const prompt = ta ? ta.value : b.genPrompt; b.genPrompt = prompt;
        act0.disabled = true; act0.textContent = 'Generating…';
        try {
          const out = await ImageGen.generate({ prompt, aspect: ImageGen.aspectOf(b.w, b.h) });
          const asset = await env.addImageData(out.dataUrl, `generated · ${out.provider} ${new Date().toLocaleTimeString()}`);
          hist.push(doc); b.asset = asset.id; b.genMeta = { provider: out.provider, model: out.model, ms: out.ms };
          rerenderFrame(f); persist(); updateUndo(); env.toast(`Image generated in ${Math.round(out.ms / 100) / 10}s`);
        } catch (err) { env.toast(err.message); }
        if (selBlocks()[0] === b) renderProps();
        return;
      }
      const al = e.target.closest('[data-align]'); if (al && f) { hist.push(doc); Canvas.align(f, bs.length ? bs : [], al.dataset.align); rerenderFrame(f); drawOverlay(); liveProps(); persist(); return; }
      const add = e.target.closest('[data-add]'); if (add && f) { hist.push(doc); const b = Canvas.newBlock(add.dataset.add, f, env.getKit(), null); if (b) { f.layout.blocks.push(b); if (f.autoLayout.mode !== 'none') Canvas.applyAutoLayout(f); select(f.id, [b.id]); rerenderFrame(f); persist(); if (b.kind === 'image') { const inp = $('cvProps').querySelector('[data-file="image"]'); if (inp) inp.click(); } } return; }
      const act = e.target.closest('[data-act]'); if (!act || !f) return;
      const a = act.dataset.act;
      if (a === 'del') deleteSelection(); else if (a === 'dup') duplicateSelection();
      else if (a === 'front' || a === 'back') { hist.push(doc); bs.forEach(b => Canvas.reorder(f, b, a === 'front' ? 1 : -1)); rerenderFrame(f); renderLayers(); persist(); }
      else if (a === 'dist-h' || a === 'dist-v') { hist.push(doc); Canvas.distribute(bs, a === 'dist-h' ? 'h' : 'v'); rerenderFrame(f); drawOverlay(); persist(); }
      else if (a === 'fit-text') { hist.push(doc); for (const b of bs) { const fit = Text.fit(Text.transform(Canvas.sourceText(b), b.font.transform), b.font, b.w, b.h, { minSize: 10, step: 2, maxLines: 40 }); if (fit) { b.font.size = fit.size; Canvas.refit(b); } } rerenderFrame(f); drawOverlay(); renderProps(); persist(); }
      else if (a === 'copy-code') { const ta = el.querySelector('[data-code]'); await copyText(ta.value); env.toast('JSON copied'); }
      else if (a === 'apply-code') {
        const ta = el.querySelector('[data-code]');
        try {
          const parsed = JSON.parse(ta.value); hist.push(doc);
          if (ta.dataset.code === 'frame') { parsed.blocks = (parsed.blocks || []).map(b => { if (!b.id) b.id = Canvas.uid(); return (b.kind === 'text' || b.kind === 'list') ? Canvas.refit(b) : b; }); f.layout = parsed; regrid(f, true); select(f.id, []); renderAll(); }
          else { const b = bs[0]; const i = f.layout.blocks.indexOf(b); parsed.id = b.id; if (parsed.kind === 'text' || parsed.kind === 'list') Canvas.refit(parsed); f.layout.blocks[i] = parsed; select(f.id, [b.id]); rerenderFrame(f); }
          persist(); env.toast('Applied');
        } catch (err) { env.toast('JSON error: ' + err.message); }
      }
    });
    el.addEventListener('change', async e => {
      const inp = e.target.closest('[data-file="image"]'); if (!inp || !inp.files[0]) return;
      const f = selFrame(); const b = selBlocks()[0]; if (!f || !b) return;
      try { const asset = await env.addImage(inp.files[0]); hist.push(doc); b.asset = asset.id; rerenderFrame(f); renderProps(); persist(); } catch (err) { env.toast('Could not load image: ' + err.message); }
      inp.value = '';
    });
  }
  function regrid(f, keep) { const fmt = Grid.byId[f.layout.format.id] || { ...f.layout.format, cols: Math.max(4, Math.round(f.layout.format.w / 160)) }; const g = Grid.compute({ ...fmt, w: f.layout.format.w, h: f.layout.format.h }, { unit: f.layout.grid.unit || 8, marginRatio: 0.06, gutterUnits: 3 }); f.layout.grid = { unit: g.unit, gutter: g.gutter, cols: g.cols, rows: g.rows, cw: g.cw, rh: g.rh, mx: g.mx, my: g.my, safe: g.safe }; }

  function boot() { bindLayers(); bindProps(); }
  return { init: e => { init(e); boot(); }, open, close, addLayouts, count, fit, get doc() { return doc; }, select, setTool, _history: () => hist };
})();
