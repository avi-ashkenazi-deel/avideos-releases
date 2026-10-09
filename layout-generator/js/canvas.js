/* Canvas document model and editing operations. The document is plain JSON: frames on an infinite canvas,
   each frame carrying a layout spec (the same JSON the engine emits). Editing the canvas is editing that JSON. */
const Canvas = (() => {
  const uid = () => Math.random().toString(36).slice(2, 8);
  const clone = o => JSON.parse(JSON.stringify(o));
  const snap = (v, u) => u > 0 ? Math.round(v / u) * u : Math.round(v);

  function create(name = 'Untitled canvas') { return { v: 1, id: uid(), name, frames: [], view: { x: 0, y: 0, zoom: 0.5 }, grid: { unit: 8, snap: true }, created: Date.now() }; }

  function addFrame(doc, layout, opts = {}) {
    const L = clone(layout);
    const last = doc.frames[doc.frames.length - 1];
    const x = opts.x ?? (last ? last.x + last.layout.format.w + 160 : 0);
    const y = opts.y ?? (last ? last.y : 0);
    const frame = { id: uid(), name: opts.name || `${L.archetypeLabel || 'Frame'} · ${L.format.name}`, x, y, layout: L, autoLayout: { mode: 'none', gap: 24, padding: 72, align: 'start', justify: 'start', fill: false }, clip: true, hidden: false, locked: false };
    for (const b of L.blocks) { if (!b.id) b.id = uid(); if (b.hidden == null) b.hidden = false; if (b.locked == null) b.locked = false; }
    doc.frames.push(frame);
    return frame;
  }
  function blankFrame(doc, format, kit, opts = {}) {
    const g = Grid.compute(format, kit.grid);
    const bg = Color.normalize(opts.bg || '#FFFFFF');
    const fg = Color.bestForeground(bg, kit.colors.map(c => Color.normalize(c.hex)), 4.5)[0];
    const accent = (kit.colors.find(c => c.role === 'accent' && Color.contrast(bg, c.hex) >= 3) || kit.colors.find(c => c.role === 'core' && Color.contrast(bg, c.hex) >= 3) || { hex: fg }).hex;
    const minDim = Math.min(format.w, format.h);
    const layout = { id: 'blank-' + uid(), seed: 0, archetype: 'blank', archetypeLabel: 'Blank', format: { id: format.id, name: format.name, w: format.w, h: format.h }, grid: { unit: g.unit, gutter: g.gutter, cols: g.cols, rows: g.rows, cw: g.cw, rh: g.rh, mx: g.mx, my: g.my, safe: g.safe }, palette: { bg, fg, accent: Color.normalize(accent), bgName: (kit.colors.find(c => Color.normalize(c.hex) === bg) || { name: 'Custom' }).name }, type: { level: 2, headline: Math.round(minDim * 0.09 / 2) * 2, body: Math.round(minDim * 0.024 / 2) * 2, display: kit.fonts.display, body_font: kit.fonts.body }, brand: kit.name, blocks: [], meta: {}, metrics: { whitespace: 1, density: 0, balance: 1 } };
    return addFrame(doc, layout, { ...opts, name: opts.name || `Frame · ${format.name}` });
  }
  const frameById = (doc, id) => doc.frames.find(f => f.id === id);
  const blockById = (frame, id) => frame.layout.blocks.find(b => b.id === id);

  // ---- Text refitting ------------------------------------------------------------------------
  function sourceText(b) { return b.text != null ? String(b.text) : (b.lines ? b.lines.map(l => typeof l === 'string' ? l : l.text).join(' ') : ''); }
  function refit(b) {
    if (b.kind === 'text') {
      const f = b.font; const text = Text.transform(sourceText(b), f.transform);
      let lines = Text.wrap(text, f, Math.max(8, b.w));
      if (!lines) lines = text.split(/\s+/); // a single word wider than the box: keep it on one line per word
      b.lines = lines;
      b.h = Math.max(f.size, Math.round(lines.length * f.size * (f.lineHeight || 1.2)));
      b.inkW = Math.min(b.w, Math.max(...lines.map(l => Text.width(l, f))));
      b.overflow = lines.some(l => Text.width(l, f) > b.w + 1);
    } else if (b.kind === 'list') {
      const f = b.font; const indent = b.indent || Math.round(f.size * (b.marker === 'number' ? 2.1 : 1.3)); const itemGap = b.itemGap ?? Math.round(f.size * 0.4);
      const lines = []; let inkW = 0; let overflow = false;
      (b.items || []).forEach((item, i) => {
        let wrapped = Text.wrap(String(item), f, Math.max(8, b.w - indent)); if (!wrapped) { wrapped = [String(item)]; overflow = true; }
        wrapped.forEach((t, j) => { lines.push({ text: t, marker: j === 0 ? (b.marker === 'number' ? String(i + 1).padStart(2, '0') : b.marker === 'none' ? '' : '•') : null, last: j === wrapped.length - 1, markerFill: b.markerFill, markerBold: b.marker === 'number' }); inkW = Math.max(inkW, indent + Text.width(t, f)); });
      });
      b.lines = lines; b.indent = indent; b.itemGap = itemGap;
      b.h = Math.round(lines.length * f.size * (f.lineHeight || 1.3) + Math.max(0, (b.items || []).length - 1) * itemGap);
      b.inkW = Math.min(b.w, inkW); b.overflow = overflow;
    } else if (b.kind === 'button') {
      const tw = Text.width(b.text || '', b.font); b.overflow = tw + b.font.size > b.w;
    }
    return b;
  }

  // ---- Block operations ----------------------------------------------------------------------
  function newBlock(kind, frame, kit, at) {
    const L = frame.layout; const u = L.grid.unit; const pal = L.palette;
    const x = at ? snap(at.x, u) : L.grid.mx, y = at ? snap(at.y, u) : L.grid.my;
    const body = L.type.body || 26, head = L.type.headline || 72;
    if (kind === 'text') return refit({ id: uid(), kind: 'text', role: 'text', path: 'text_' + uid(), text: 'New text', x, y, w: Math.min(L.format.w - x - L.grid.mx, 12 * u * 4), h: head, font: { family: Brand.fontCss(kit.fonts.display), weight: kit.fonts.displayWeight || 600, size: head, lineHeight: 1.1, letterSpacing: kit.fonts.tracking ?? -0.02 }, fill: pal.fg, align: 'left', decorative: false });
    if (kind === 'body') return refit({ id: uid(), kind: 'text', role: 'body', path: 'body_' + uid(), text: 'Body copy goes here. Edit it in the properties panel.', x, y, w: Math.min(L.format.w - x - L.grid.mx, 12 * u * 4), h: body * 3, font: { family: Brand.fontCss(kit.fonts.body), weight: kit.fonts.bodyWeight || 400, size: body, lineHeight: 1.4, letterSpacing: 0 }, fill: pal.fg, align: 'left', decorative: false });
    if (kind === 'rect') return { id: uid(), kind: 'field', x, y, w: 24 * u, h: 16 * u, fill: pal.accent, radius: 0, decorative: true };
    if (kind === 'ellipse') return { id: uid(), kind: 'shape', shape: 'circle', x, y, w: 20 * u, h: 20 * u, fill: pal.accent, decorative: true };
    if (kind === 'button') return { id: uid(), kind: 'button', role: 'cta', path: 'cta_' + uid(), text: 'Learn more', x, y, w: Math.round(body * 9), h: Math.round(body * 2.7), font: { family: Brand.fontCss(kit.fonts.body), weight: 600, size: body, lineHeight: 1.2 }, fill: pal.accent, color: Color.contrast(pal.accent, '#FFFFFF') >= Color.contrast(pal.accent, '#000000') ? '#FFFFFF' : '#000000', radius: Math.round(body * 1.35), decorative: false };
    if (kind === 'image') return { id: uid(), kind: 'image', x, y, w: 40 * u, h: 30 * u, asset: null, focal: 'xMidYMid', radius: 0, decorative: false, path: 'image_' + uid() };
    if (kind === 'icon') return { id: uid(), kind: 'icon', name: 'sparkle', x, y, w: 8 * u, h: 8 * u, fill: pal.accent, decorative: true };
    if (kind === 'logo') return { id: uid(), kind: 'logo', x, y, w: Math.round(5 * u * Engine.logoAspect(kit, Engine.typeSet(kit, Grid.compute(Grid.byId[L.format.id] || Grid.FORMATS[0], kit.grid), 2))), h: 5 * u, fill: Brand.logoColorFor(kit, pal.bg)[0], decorative: true };
    return null;
  }
  function moveBlock(frame, b, dx, dy, u) { b.x = snap(b.x + dx, u); b.y = snap(b.y + dy, u); }
  function resizeBlock(frame, b, box, u) {
    const keepAspect = b.kind === 'icon' || b.kind === 'badge' || b.kind === 'logo' || (b.kind === 'shape' && b.shape === 'circle');
    let w = Math.max(u, snap(box.w, u)), h = Math.max(u, snap(box.h, u));
    if (keepAspect) { const a = (b.w || 1) / (b.h || 1); if (Math.abs(box.w - b.w) >= Math.abs(box.h - b.h)) h = Math.max(u, Math.round(w / a)); else w = Math.max(u, Math.round(h * a)); }
    b.x = snap(box.x, u); b.y = snap(box.y, u); b.w = w; b.h = h;
    if (b.kind === 'logo') { /* height drives wordmark size */ }
    refit(b);
  }
  function reorder(frame, b, dir) {
    const arr = frame.layout.blocks; const i = arr.indexOf(b); if (i < 0) return;
    const j = dir === 'front' ? arr.length - 1 : dir === 'back' ? 0 : Math.max(0, Math.min(arr.length - 1, i + dir));
    arr.splice(i, 1); arr.splice(j, 0, b);
  }
  function duplicateBlock(frame, b, u) { const c = clone(b); c.id = uid(); c.x = snap(c.x + 2 * u, u); c.y = snap(c.y + 2 * u, u); frame.layout.blocks.push(c); return c; }
  function removeBlocks(frame, ids) { frame.layout.blocks = frame.layout.blocks.filter(b => !ids.includes(b.id)); }
  // Move blocks into another frame and keep their place on the canvas.
  function transferBlocks(src, dst, blocks, u) {
    const out = [];
    for (const b of blocks) {
      src.layout.blocks = src.layout.blocks.filter(x => x !== b);
      const wx = src.x + b.x, wy = src.y + b.y;
      b.x = snap(wx - dst.x, u); b.y = snap(wy - dst.y, u);
      dst.layout.blocks.push(b); out.push(b);
    }
    return out;
  }
  // Paste clones into a frame; dx/dy nudge them off their source, and they are kept inside the frame.
  function pasteBlocks(frame, blocks, opts = {}) {
    const u = frame.layout.grid.unit; const W = frame.layout.format.w, H = frame.layout.format.h; const out = [];
    for (const b of blocks) {
      const c = clone(b); c.id = uid();
      c.x = snap(c.x + (opts.dx || 0), u); c.y = snap(c.y + (opts.dy || 0), u);
      c.x = Math.max(0, Math.min(W - Math.min(c.w, W), c.x)); c.y = Math.max(0, Math.min(H - Math.min(c.h, H), c.y));
      if (c.kind === 'text' || c.kind === 'list') refit(c);
      frame.layout.blocks.push(c); out.push(c);
    }
    return out;
  }
  // A format for a frame drawn by hand: columns scale with width, like the built-in formats.
  function customFormat(w, h) { w = Math.max(64, Math.round(w / 8) * 8); h = Math.max(64, Math.round(h / 8) * 8); return { id: 'custom', name: 'Custom', w, h, cols: Math.max(4, Math.min(12, Math.round(w / 160))) }; }

  // ---- Align and distribute (selected blocks within a frame) ---------------------------------
  function align(frame, blocks, mode) {
    const W = frame.layout.format.w, H = frame.layout.format.h;
    const ref = blocks.length > 1 ? bounds(blocks) : { x: 0, y: 0, w: W, h: H };
    for (const b of blocks) {
      if (mode === 'left') b.x = ref.x; if (mode === 'hcenter') b.x = Math.round(ref.x + (ref.w - b.w) / 2); if (mode === 'right') b.x = ref.x + ref.w - b.w;
      if (mode === 'top') b.y = ref.y; if (mode === 'vcenter') b.y = Math.round(ref.y + (ref.h - b.h) / 2); if (mode === 'bottom') b.y = ref.y + ref.h - b.h;
    }
  }
  function distribute(blocks, axis) {
    if (blocks.length < 3) return;
    const k = axis === 'h' ? 'x' : 'y', s = axis === 'h' ? 'w' : 'h';
    const sorted = blocks.slice().sort((a, b) => a[k] - b[k]);
    const first = sorted[0], last = sorted[sorted.length - 1];
    const total = (last[k] + last[s]) - first[k]; const sum = sorted.reduce((t, b) => t + b[s], 0);
    const gap = (total - sum) / (sorted.length - 1); let pos = first[k];
    for (const b of sorted) { b[k] = Math.round(pos); pos += b[s] + gap; }
  }
  function bounds(blocks) {
    const x0 = Math.min(...blocks.map(b => b.x)), y0 = Math.min(...blocks.map(b => b.y));
    const x1 = Math.max(...blocks.map(b => b.x + b.w)), y1 = Math.max(...blocks.map(b => b.y + b.h));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // ---- Auto layout (flex) for a frame ----------------------------------------------------------
  // Children = blocks that are not full-bleed backgrounds. Stacked in order along the main axis with gap and padding;
  // cross-axis alignment per `align`; `fill` stretches text and lists to the inner width (vertical) and refits them.
  function isBackground(frame, b) { const W = frame.layout.format.w, H = frame.layout.format.h; return (b.kind === 'image' || b.kind === 'field' || b.kind === 'scrim') && b.w >= W * 0.95 && b.h >= H * 0.95 && b.x <= 0 && b.y <= 0; }
  function applyAutoLayout(frame) {
    const al = frame.autoLayout; if (!al || al.mode === 'none') return;
    const W = frame.layout.format.w, H = frame.layout.format.h; const pad = al.padding, gap = al.gap;
    const children = frame.layout.blocks.filter(b => !isBackground(frame, b) && !b.hidden && b.kind !== 'scrim' && b.kind !== 'line');
    if (!children.length) return;
    const vertical = al.mode === 'vertical';
    children.sort((a, b) => vertical ? (a.y - b.y || a.x - b.x) : (a.x - b.x || a.y - b.y));
    const innerW = W - 2 * pad, innerH = H - 2 * pad;
    if (al.fill && vertical) for (const b of children) if (b.kind === 'text' || b.kind === 'list' || b.kind === 'field') { b.w = innerW; refit(b); }
    if (al.fill && !vertical) for (const b of children) if (b.kind === 'field' || b.kind === 'image') { b.h = innerH; }
    const mainSize = children.reduce((t, b) => t + (vertical ? b.h : b.w), 0) + gap * (children.length - 1);
    const mainInner = vertical ? innerH : innerW;
    let pos = pad; let step = gap;
    if (al.justify === 'center') pos = pad + Math.max(0, (mainInner - mainSize) / 2);
    else if (al.justify === 'end') pos = pad + Math.max(0, mainInner - mainSize);
    else if (al.justify === 'space-between' && children.length > 1) step = gap + Math.max(0, (mainInner - mainSize) / (children.length - 1));
    for (const b of children) {
      if (vertical) { b.y = Math.round(pos); pos += b.h + step; b.x = al.align === 'center' ? Math.round(pad + (innerW - b.w) / 2) : al.align === 'end' ? W - pad - b.w : pad; if (b.kind === 'text') b.align = al.align === 'center' ? 'center' : al.align === 'end' ? 'right' : 'left'; }
      else { b.x = Math.round(pos); pos += b.w + step; b.y = al.align === 'center' ? Math.round(pad + (innerH - b.h) / 2) : al.align === 'end' ? H - pad - b.h : pad; }
    }
  }

  // ---- Serialization, links, code -----------------------------------------------------------
  function serialize(doc, opts = {}) {
    const d = clone(doc);
    if (opts.stripAssets) for (const f of d.frames) for (const b of f.layout.blocks) if (b.kind === 'image') b.assetMissing = true;
    return JSON.stringify(d);
  }
  function deserialize(json) { const d = typeof json === 'string' ? JSON.parse(json) : json; if (!d || !Array.isArray(d.frames)) throw new Error('not a canvas file'); for (const f of d.frames) for (const b of f.layout.blocks) if (!b.id) b.id = uid(); return d; }
  async function toLink(doc) {
    const json = serialize(doc, { stripAssets: true });
    let payload;
    if (typeof CompressionStream === 'function') {
      const cs = new CompressionStream('deflate-raw'); const w = cs.writable.getWriter(); w.write(new TextEncoder().encode(json)); w.close();
      const buf = await new Response(cs.readable).arrayBuffer(); payload = 'z' + b64url(new Uint8Array(buf));
    } else payload = 'j' + b64url(new TextEncoder().encode(json));
    return `${location.origin}${location.pathname}#c=${payload}`;
  }
  async function fromHash(hash) {
    const m = /#c=([zj])([A-Za-z0-9_-]+)/.exec(hash || ''); if (!m) return null;
    const bytes = unb64url(m[2]);
    if (m[1] === 'z') { const ds = new DecompressionStream('deflate-raw'); const w = ds.writable.getWriter(); w.write(bytes); w.close(); return deserialize(await new Response(ds.readable).text()); }
    return deserialize(new TextDecoder().decode(bytes));
  }
  function b64url(bytes) { let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function unb64url(s) { const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/')); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }

  // HTML/CSS for one frame: what "copy as code" means here. Absolute positions on a fixed-size frame.
  function toHTML(frame, env) {
    const L = frame.layout; const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const px = v => `${Math.round(v)}px`;
    const parts = [`<div class="frame" style="position:relative;width:${px(L.format.w)};height:${px(L.format.h)};background:${L.palette.bg};overflow:${frame.clip ? 'hidden' : 'visible'}">`];
    for (const b of L.blocks) {
      if (b.hidden) continue;
      const pos = `position:absolute;left:${px(b.x)};top:${px(b.y)};width:${px(b.w)};height:${px(b.h)};`;
      if (b.kind === 'field') parts.push(`  <div style="${pos}background:${b.fill};border-radius:${px(b.radius || 0)};${b.alpha != null ? `opacity:${b.alpha};` : ''}"></div>`);
      else if (b.kind === 'shape') parts.push(`  <div style="${pos}background:${b.fill};border-radius:${b.shape === 'pill' ? '999px' : b.shape === 'circle' ? '50%' : '0 100% 0 0'};"></div>`);
      else if (b.kind === 'image') { const a = env && env.assets.images.find(i => i.id === b.asset); parts.push(`  <img src="${a ? a.dataUrl.slice(0, 40) + '…' : 'image.jpg'}" alt="" style="${pos}object-fit:cover;border-radius:${px(b.radius || 0)};">`); }
      else if (b.kind === 'text') { const f = b.font; parts.push(`  <p style="${pos}margin:0;font-family:${f.family};font-size:${px(f.size)};font-weight:${f.weight};line-height:${f.lineHeight || 1.2};letter-spacing:${f.letterSpacing || 0}em;color:${b.fill};text-align:${b.align || 'left'}">${b.lines.map(esc).join('<br>')}</p>`); }
      else if (b.kind === 'list') { const f = b.font; parts.push(`  <${b.marker === 'number' ? 'ol' : 'ul'} style="${pos}margin:0;padding-left:${px(b.indent)};font-family:${f.family};font-size:${px(f.size)};line-height:${f.lineHeight || 1.3};color:${b.fill}">${(b.items || []).map(i => `<li>${esc(i)}</li>`).join('')}</${b.marker === 'number' ? 'ol' : 'ul'}>`); }
      else if (b.kind === 'button') { const f = b.font; parts.push(`  <a href="#" style="${pos}display:flex;align-items:center;justify-content:center;background:${b.fill};color:${b.color};border-radius:${px(b.radius || 0)};font-family:${f.family};font-size:${px(f.size)};font-weight:600;text-decoration:none">${esc(b.text)}</a>`); }
      else if (b.kind === 'logo') parts.push(`  <div class="logo" style="${pos}color:${b.fill}"><!-- logo --></div>`);
      else if (b.kind === 'rule' || b.kind === 'line') parts.push(`  <div style="${pos}background:${b.fill};min-height:2px"></div>`);
      else if (b.kind === 'icon') parts.push(`  <svg viewBox="0 0 256 256" style="${pos}color:${b.fill}">${(Icons.SET[b.name] || '')}</svg>`);
      else if (b.kind === 'badge') parts.push(`  <div style="${pos}display:grid;place-items:center;border-radius:50%;background:${b.fill};color:${b.color};font-weight:700">${esc(b.text)}</div>`);
    }
    parts.push('</div>');
    return parts.join('\n');
  }

  // ---- History ----------------------------------------------------------------------------------
  function history(limit = 80) {
    const past = [], future = [];
    return {
      push(doc) { const s = JSON.stringify(doc); if (past.length && past[past.length - 1] === s) return; past.push(s); if (past.length > limit) past.shift(); future.length = 0; },
      undo(doc) { if (!past.length) return null; future.push(JSON.stringify(doc)); return JSON.parse(past.pop()); },
      redo(doc) { if (!future.length) return null; past.push(JSON.stringify(doc)); return JSON.parse(future.pop()); },
      get canUndo() { return past.length > 0; }, get canRedo() { return future.length > 0; },
      get depth() { return past.length; }, peek() { return past.length ? JSON.parse(past[past.length - 1]) : null; },
    };
  }

  return { create, addFrame, blankFrame, frameById, blockById, refit, sourceText, newBlock, moveBlock, resizeBlock, reorder, duplicateBlock, removeBlocks, transferBlocks, pasteBlocks, customFormat, align, distribute, bounds, applyAutoLayout, isBackground, serialize, deserialize, toLink, fromHash, toHTML, history, snap, uid, clone };
})();
