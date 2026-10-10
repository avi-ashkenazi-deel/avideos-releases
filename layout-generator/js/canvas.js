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
    const frame = { id: uid(), name: opts.name || `${L.archetypeLabel || 'Frame'} · ${L.format.name}`, x, y, layout: L, autoLayout: opts.autoLayout ? clone(opts.autoLayout) : defaultAuto(), clip: true, hidden: false, locked: false };
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
  const defaultAuto = () => ({ v: 2, mode: 'none', wrap: false, gap: 24, gapAuto: false, counterGap: 24, counterGapAuto: false, pad: { t: 72, r: 72, b: 72, l: 72 }, main: 'start', cross: 'start' });
  // Screens saved with the first flex (one stack per screen that skipped backgrounds and sorted by position) move to
  // auto layout: backgrounds become absolute, the flow follows reading order, and "stretch text" becomes Fill.
  function migrate(f) {
    const al = f.autoLayout;
    if (al && al.v === 2) return f;
    if (!al) { f.autoLayout = defaultAuto(); return f; }
    const vertical = al.mode === 'vertical';
    if (al.mode === 'vertical' || al.mode === 'horizontal') {
      const blocks = f.layout.blocks;
      const flow = blocks.filter(b => !b.parent && !isBackground(f, b) && !b.hidden && b.kind !== 'scrim' && b.kind !== 'line');
      for (const b of blocks) if (!b.parent && !flow.includes(b)) b.absolute = true;
      const order = flow.slice().sort((a, b) => vertical ? (a.y - b.y || a.x - b.x) : (a.x - b.x || a.y - b.y));
      const slots = flow.map(b => blocks.indexOf(b)).sort((a, b) => a - b); order.forEach((b, i) => { blocks[slots[i]] = b; });
      if (al.fill) for (const b of flow) { if (vertical && (b.kind === 'text' || b.kind === 'list' || b.kind === 'field')) b.sizeW = 'fill'; if (!vertical && (b.kind === 'field' || b.kind === 'image')) b.sizeH = 'fill'; }
    }
    f.autoLayout = Auto.norm(al);
    return f;
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
    if (kind === 'ellipse') return { id: uid(), kind: 'shape', shape: 'ellipse', x, y, w: 20 * u, h: 20 * u, fill: pal.accent, decorative: true };
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
  // Order among siblings (blocks with the same parent): in a stack that is also the flow order.
  function reorder(frame, b, dir) {
    const arr = frame.layout.blocks; if (arr.indexOf(b) < 0) return;
    const sib = arr.filter(x => (x.parent || '') === (b.parent || '')); const i = sib.indexOf(b);
    const j = dir === 'front' ? sib.length - 1 : dir === 'back' ? 0 : Math.max(0, Math.min(sib.length - 1, i + dir));
    if (j === i) return;
    const target = sib[j]; arr.splice(arr.indexOf(b), 1);
    const t = arr.indexOf(target); arr.splice(j > i ? t + 1 : t, 0, b);
  }
  // A copy of a block (and of what is inside it, for a box) right after it. In a stack it takes the next place in the
  // flow; elsewhere it is nudged so it shows.
  function duplicateBlock(frame, b, u) {
    const src = Auto.withDescendants(frame, [b]); const copies = clone(src); Auto.remap(copies, b.parent || null);
    const c = copies[0]; if (b.parent) c.parent = b.parent; else delete c.parent;
    const flow = Auto.inFlow(Auto.index(frame), b);
    if (!flow && u) for (const x of copies) { x.x = snap(x.x + 2 * u, u); x.y = snap(x.y + 2 * u, u); }
    const arr = frame.layout.blocks; const at = Math.max(...src.map(x => arr.indexOf(x))) + 1;
    arr.splice(at, 0, ...copies);
    return c;
  }
  // Removing a box removes what is inside it.
  function removeBlocks(frame, ids) { const gone = new Set(Auto.withDescendants(frame, frame.layout.blocks.filter(b => ids.includes(b.id))).map(b => b.id)); frame.layout.blocks = frame.layout.blocks.filter(b => !gone.has(b.id)); }
  // Move blocks (with what is inside them) into another frame and keep their place on the canvas. They land at the
  // top level of the other frame unless `into` names a box there.
  function transferBlocks(src, dst, blocks, u, into) {
    const top = Auto.topmost(src, blocks); const all = Auto.withDescendants(src, top); const ids = new Set(all.map(b => b.id));
    src.layout.blocks = src.layout.blocks.filter(x => !ids.has(x.id));
    const dx = src.x - dst.x, dy = src.y - dst.y; const ox = top.length ? snap(top[0].x + dx, u) - (top[0].x + dx) : 0, oy = top.length ? snap(top[0].y + dy, u) - (top[0].y + dy) : 0;
    for (const b of all) { b.x += dx + ox; b.y += dy + oy; if (b.lx != null) { b.lx += dx + ox; b.ly += dy + oy; } }
    for (const b of top) { if (into) b.parent = into; else delete b.parent; delete b.rx; delete b.ry; delete b.lx; delete b.ly; }
    dst.layout.blocks.push(...all);
    return top;
  }
  // Paste clones into a frame; dx/dy nudge them off their source, and they are kept inside the frame. Boxes bring
  // what is inside them. `into` pastes into a box.
  function pasteBlocks(frame, blocks, opts = {}) {
    const u = frame.layout.grid.unit; const W = frame.layout.format.w, H = frame.layout.format.h;
    const copies = clone(blocks); const inSet = new Set(copies.map(b => b.id));
    const tops = copies.filter(b => !b.parent || !inSet.has(b.parent));
    Auto.remap(copies, opts.into || null);
    const kidsOf = new Map(); for (const b of copies) if (b.parent) { if (!kidsOf.has(b.parent)) kidsOf.set(b.parent, []); kidsOf.get(b.parent).push(b); }
    const subtree = b => { const out = [b]; for (const k of kidsOf.get(b.id) || []) out.push(...subtree(k)); return out; };
    for (const t of tops) {
      let nx = snap(t.x + (opts.dx || 0), u), ny = snap(t.y + (opts.dy || 0), u);
      nx = Math.max(0, Math.min(W - Math.min(t.w, W), nx)); ny = Math.max(0, Math.min(H - Math.min(t.h, H), ny));
      const ddx = nx - t.x, ddy = ny - t.y;
      for (const x of subtree(t)) { x.x += ddx; x.y += ddy; if (x.lx != null) { x.lx += ddx; x.ly += ddy; } }
      if (!opts.into) { delete t.rx; delete t.ry; delete t.lx; delete t.ly; }
    }
    for (const c of copies) if (c.kind === 'text' || c.kind === 'list') refit(c);
    frame.layout.blocks.push(...copies);
    return tops;
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

  // ---- Auto layout: see autolayout.js. Full-bleed images and fields count as backgrounds (absolute when a screen's
  // auto layout is switched on). ---------------------------------------------------------------------------------------
  function isBackground(frame, b) { const W = frame.layout.format.w, H = frame.layout.format.h; return (b.kind === 'image' || b.kind === 'field' || b.kind === 'scrim') && b.w >= W * 0.95 && b.h >= H * 0.95 && b.x <= 0 && b.y <= 0; }
  function applyAutoLayout(frame) { return Auto.layout(frame); }

  // ---- Serialization, links, code -----------------------------------------------------------
  function serialize(doc, opts = {}) {
    const d = clone(doc);
    if (opts.stripAssets) for (const f of d.frames) for (const b of f.layout.blocks) if (b.kind === 'image') b.assetMissing = true;
    return JSON.stringify(d);
  }
  function deserialize(json) { const d = typeof json === 'string' ? JSON.parse(json) : json; if (!d || !Array.isArray(d.frames)) throw new Error('not a canvas file'); for (const f of d.frames) { for (const b of f.layout.blocks) if (!b.id) b.id = uid(); migrate(f); } return d; }
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

  // ---- Code: HTML/CSS and React + Tailwind for one frame ----------------------------------------------------
  const cssColor = v => (typeof v === 'string' && /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\)|[a-zA-Z]{3,24})$/.test(v.trim())) ? v.trim() : '#000000';
  function cssGradient(g) { if (!g || !Array.isArray(g.stops) || g.stops.length < 2) return null; const st = g.stops.map(x => `${cssColor(x.c)} ${Math.round((x.p || 0) * 100)}%`).join(', '); return g.type === 'radial' ? `radial-gradient(circle, ${st})` : `linear-gradient(${Math.round(g.angle || 0)}deg, ${st})`; }
  function cssFx(b) {
    const out = [];
    if (b.opacity != null && b.opacity < 1) out.push(`opacity:${b.opacity}`);
    if (b.rotation) out.push(`transform:rotate(${b.rotation}deg)`);
    const s = b.shadow; if (s && s.on !== false && (s.blur || s.x || s.y)) out.push(`box-shadow:${s.x || 0}px ${s.y || 0}px ${s.blur || 0}px ${hexAlpha(cssColor(s.color || '#000000'), s.alpha ?? 0.25)}`);
    if (b.stroke && b.stroke.width > 0) out.push(`border:${b.stroke.width}px solid ${cssColor(b.stroke.color)}`);
    return out;
  }
  function hexAlpha(hex, a) { if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return hex; return hex + Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0'); }
  function famName(f) { return String((f && f.family) || 'sans-serif').split(',')[0].replace(/["']/g, '').trim(); }
  // One intermediate description per block, as a tree: boxes hold their children. HTML and React render from it.
  // Children of an auto layout container are flex items (sized fixed, hug or fill); everything else is placed
  // absolutely inside its parent, like Figma's Dev Mode and Paper's code.
  function nodeOf(b, env) {
    const fxs = cssFx(b); const bg = cssGradient(b.gradient); const f = b.font || {};
    const type = { family: famName(f), size: Math.round(f.size || 16), weight: f.weight || 400, lh: f.lineHeight || 1.2, ls: f.letterSpacing || 0, italic: f.style === 'italic' };
    if (b.kind === 'box') return { tag: 'div', bg: bg || (b.fill && b.fill !== 'none' ? cssColor(b.fill) : null), radius: b.radius || 0, fxs, role: b.label || 'box', clip: !!b.clip };
    if (b.kind === 'field' || b.kind === 'rule') return { tag: 'div', bg: bg || cssColor(b.fill), radius: b.radius || 0, alpha: b.alpha, fxs, role: b.role || b.kind };
    if (b.kind === 'shape') return { tag: 'div', bg: bg || cssColor(b.fill), radius: b.shape === 'pill' ? 9999 : (b.shape === 'circle' || b.shape === 'ellipse') ? '50%' : '0 100% 0 0', fxs, role: b.shape };
    if (b.kind === 'image') { const a = env && env.assets && env.assets.images.find(i => i.id === b.asset); return { tag: 'img', src: a ? (a.name || 'image') : 'image.jpg', radius: b.radius || 0, fit: b.fit === 'contain' ? 'contain' : 'cover', fxs, role: 'image' }; }
    if (b.kind === 'text') return { tag: /^(headline|stat|quote)$/.test(b.role) ? 'h2' : 'p', text: sourceText(b), color: cssColor(b.fill), bgText: bg, type, align: b.align || 'left', upper: f.transform === 'upper', fxs, role: b.role || 'text' };
    if (b.kind === 'list') return { tag: b.marker === 'number' ? 'ol' : 'ul', items: b.items || [], color: cssColor(b.fill), type, indent: b.indent || 24, fxs, role: b.role || 'list' };
    if (b.kind === 'button') return { tag: 'a', text: b.text, color: cssColor(b.color), bg: bg || cssColor(b.fill), radius: b.radius || 0, type: { ...type, weight: f.weight || 600 }, fxs, role: 'cta' };
    if (b.kind === 'icon') return { tag: 'svg', inner: (Icons.SET[b.name] || '').replace(/currentColor/g, cssColor(b.fill)), viewBox: '0 0 256 256', fxs, role: 'icon ' + b.name };
    if (b.kind === 'vector') return { tag: 'svg', inner: b.d ? `<path d="${String(b.d).replace(/[^MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]/g, '')}" fill="${cssColor(b.fill)}"/>` : (typeof Render !== 'undefined' ? Render.sanitizeSvgInner(b.svg) : ''), viewBox: Array.isArray(b.viewBox) ? b.viewBox.join(' ') : `0 0 ${b.vw || b.w} ${b.vh || b.h}`, fxs, role: 'vector' };
    if (b.kind === 'logo') return { tag: 'div', text: (env && env.kit && env.kit.logo && env.kit.logo.text) || 'logo', color: cssColor(b.fill), type: { ...type, weight: 700, size: Math.round(b.h / 0.74) }, fxs, role: 'logo' };
    if (b.kind === 'line') return { tag: 'div', bg: cssColor(b.fill), fxs, role: 'line', minH: 2 };
    if (b.kind === 'badge') return { tag: 'div', text: b.text, color: cssColor(b.color), bg: cssColor(b.fill), radius: '50%', type: { ...type, weight: 700 }, fxs, role: 'badge' };
    return null;
  }
  function flexOf(s) {
    if (!Auto.on(s)) return null;
    const J = { start: 'flex-start', center: 'center', end: 'flex-end' }, A = { start: 'flex-start', center: 'center', end: 'flex-end', baseline: 'baseline' };
    return { dir: s.mode === 'horizontal' ? 'row' : 'column', gap: s.gapAuto ? 0 : s.gap, rowGap: s.wrap ? (s.counterGapAuto ? 0 : s.counterGap) : null, justify: s.gapAuto ? 'space-between' : J[s.main], align: A[s.cross], wrap: !!s.wrap, pad: s.pad, alignContent: s.wrap && s.counterGapAuto ? 'space-between' : null };
  }
  function codeTree(frame, env) {
    const I = Auto.index(frame);
    const build = (pid, origin, parentFlex) => Auto.childrenOf(I, pid).filter(b => !b.hidden).map(b => {
      const nd = nodeOf(b, env); if (!nd) return null;
      const flow = !!parentFlex && !b.absolute;
      nd.pos = flow ? 'flow' : 'abs';
      nd.box = { left: Math.round(b.x - origin.x), top: Math.round(b.y - origin.y), width: Math.round(b.w), height: Math.round(Math.max(b.h, nd.minH || 0)) };
      if (flow) { const main = parentFlex.dir === 'row' ? 'w' : 'h'; nd.size = { w: Auto.sizing(I, b, 'w'), h: Auto.sizing(I, b, 'h'), main }; for (const k of ['minW', 'maxW', 'minH', 'maxH']) if (b[k] != null) nd[k] = b[k]; }
      if (b.kind === 'box') { nd.flex = flexOf(I.S(b.id)); nd.children = build(b.id, { x: b.x, y: b.y }, nd.flex); }
      return nd;
    }).filter(Boolean);
    const flex = flexOf(I.rootS);
    return { flex, children: build('', { x: 0, y: 0 }, flex) };
  }
  // CSS for one node as [property, value] pairs (shared by HTML and, through a mapping, React).
  function cssOf(nd) {
    const st = [];
    if (nd.pos === 'abs') st.push(['position', 'absolute'], ['left', nd.box.left + 'px'], ['top', nd.box.top + 'px'], ['width', nd.box.width + 'px'], ['height', nd.box.height + 'px']);
    else {
      const sz = nd.size; const axis = (k, v) => { const isMain = sz.main === k; if (v === 'fill') return isMain ? [['flex', '1 1 0'], [k === 'w' ? 'min-width' : 'min-height', '0']] : [['align-self', 'stretch']]; if (v === 'hug') return [[k === 'w' ? 'width' : 'height', 'fit-content']]; return [[k === 'w' ? 'width' : 'height', (k === 'w' ? nd.box.width : nd.box.height) + 'px'], ...(isMain ? [['flex-shrink', '0']] : [])]; };
      st.push(['position', 'relative'], ...axis('w', sz.w), ...axis('h', sz.h));
      for (const [k, css] of [['minW', 'min-width'], ['maxW', 'max-width'], ['minH', 'min-height'], ['maxH', 'max-height']]) if (nd[k] != null) st.push([css, nd[k] + 'px']);
    }
    if (nd.flex) { const F = nd.flex; st.push(['display', 'flex'], ['flex-direction', F.dir], ['justify-content', F.justify], ['align-items', F.align]); if (F.wrap) st.push(['flex-wrap', 'wrap']); if (F.gap) st.push([F.wrap ? 'column-gap' : 'gap', F.gap + 'px']); if (F.rowGap) st.push(['row-gap', F.rowGap + 'px']); if (F.alignContent) st.push(['align-content', F.alignContent]); const p = F.pad; if (p.t || p.r || p.b || p.l) st.push(['padding', `${p.t}px ${p.r}px ${p.b}px ${p.l}px`]); st.push(['box-sizing', 'border-box']); }
    if (nd.clip) st.push(['overflow', 'hidden']);
    if (nd.bg) st.push(['background', nd.bg]); if (nd.radius) st.push(['border-radius', typeof nd.radius === 'number' ? nd.radius + 'px' : nd.radius]); if (nd.alpha != null && nd.alpha < 1) st.push(['opacity', String(nd.alpha)]);
    if (nd.type) { st.push(['margin', '0'], ['font-family', `'${nd.type.family}'`], ['font-size', nd.type.size + 'px'], ['font-weight', String(nd.type.weight)], ['line-height', String(nd.type.lh)]); if (nd.type.ls) st.push(['letter-spacing', nd.type.ls + 'em']); if (nd.type.italic) st.push(['font-style', 'italic']); }
    if (nd.color) st.push(['color', nd.color]); if (nd.align && nd.align !== 'left') st.push(['text-align', nd.align]); if (nd.upper) st.push(['text-transform', 'uppercase']);
    if (nd.tag === 'p' || nd.tag === 'h2') st.push(['white-space', 'pre-wrap']);
    if (nd.tag === 'a') st.push(['display', 'flex'], ['align-items', 'center'], ['justify-content', 'center'], ['text-decoration', 'none']);
    if (nd.tag === 'img') st.push(['object-fit', nd.fit]);
    if (nd.tag === 'ul' || nd.tag === 'ol') st.push(['padding-left', nd.indent + 'px'], ['margin', '0']);
    for (const x of nd.fxs) { const [k, v] = x.split(/:(.+)/); st.push([k, v]); }
    return st;
  }
  function rootCss(frame, tree) {
    const L = frame.layout; const st = [['position', 'relative'], ['width', L.format.w + 'px'], ['height', L.format.h + 'px'], ['background', cssGradient(L.palette.bgGradient) || cssColor(L.palette.bg)], ['overflow', frame.clip ? 'hidden' : 'visible']];
    if (tree.flex) { const F = tree.flex; st.push(['display', 'flex'], ['flex-direction', F.dir], ['justify-content', F.justify], ['align-items', F.align], ['box-sizing', 'border-box']); if (F.wrap) st.push(['flex-wrap', 'wrap']); if (F.gap) st.push([F.wrap ? 'column-gap' : 'gap', F.gap + 'px']); if (F.rowGap) st.push(['row-gap', F.rowGap + 'px']); const p = F.pad; st.push(['padding', `${p.t}px ${p.r}px ${p.b}px ${p.l}px`]); }
    return st;
  }
  // Kept for callers that want the flat list (every block's absolute box in frame coordinates).
  function codeNodes(frame, env) {
    const out = []; const walk = (list, ox, oy) => { for (const nd of list) { out.push({ ...nd, box: { ...nd.box, left: nd.box.left + ox, top: nd.box.top + oy } }); if (nd.children) walk(nd.children, ox + nd.box.left, oy + nd.box.top); } };
    walk(codeTree(frame, env).children, 0, 0); return out;
  }
  function toHTML(frame, env) {
    const e = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const tree = codeTree(frame, env); const style = st => st.map(([k, v]) => `${k}:${v}`).join(';');
    const parts = [`<div class="frame" style="${style(rootCss(frame, tree))}">`];
    const emitNode = (nd, depth) => {
      const pad = '  '.repeat(depth); const s = style(cssOf(nd));
      if (nd.children) { parts.push(`${pad}<div data-name="${e(nd.role)}" style="${s}">`); nd.children.forEach(c => emitNode(c, depth + 1)); parts.push(`${pad}</div>`); return; }
      if (nd.tag === 'img') parts.push(`${pad}<img src="${e(nd.src)}" alt="" style="${s}">`);
      else if (nd.tag === 'svg') parts.push(`${pad}<svg viewBox="${nd.viewBox}" preserveAspectRatio="none" style="${s}">${nd.inner}</svg>`);
      else if (nd.tag === 'ul' || nd.tag === 'ol') parts.push(`${pad}<${nd.tag} style="${s}">${nd.items.map(i => `<li>${e(i)}</li>`).join('')}</${nd.tag}>`);
      else parts.push(`${pad}<${nd.tag}${nd.tag === 'a' ? ' href="#"' : ''} style="${s}">${e(nd.text || '')}</${nd.tag}>`);
    };
    tree.children.forEach(nd => emitNode(nd, 1));
    parts.push('</div>');
    return parts.join('\n');
  }
  // React + Tailwind: arbitrary values keep the exact pixels; fonts and effects go to style where Tailwind has no utility.
  const TW = {
    'position:absolute': 'absolute', 'position:relative': 'relative', 'display:flex': 'flex', 'flex-direction:row': 'flex-row', 'flex-direction:column': 'flex-col', 'flex-wrap:wrap': 'flex-wrap',
    'justify-content:flex-start': 'justify-start', 'justify-content:center': 'justify-center', 'justify-content:flex-end': 'justify-end', 'justify-content:space-between': 'justify-between',
    'align-items:flex-start': 'items-start', 'align-items:center': 'items-center', 'align-items:flex-end': 'items-end', 'align-items:baseline': 'items-baseline', 'align-content:space-between': 'content-between',
    'align-self:stretch': 'self-stretch', 'flex:1 1 0': 'flex-1', 'flex-shrink:0': 'shrink-0', 'width:fit-content': 'w-fit', 'height:fit-content': 'h-fit', 'overflow:hidden': 'overflow-hidden', 'overflow:visible': 'overflow-visible',
    'box-sizing:border-box': 'box-border', 'margin:0': 'm-0', 'text-align:center': 'text-center', 'text-align:right': 'text-right', 'text-transform:uppercase': 'uppercase', 'font-style:italic': 'italic', 'white-space:pre-wrap': 'whitespace-pre-wrap',
    'text-decoration:none': 'no-underline', 'object-fit:cover': 'object-cover', 'object-fit:contain': 'object-contain', 'min-width:0': 'min-w-0', 'min-height:0': 'min-h-0',
  };
  const TWP = { left: 'left', top: 'top', width: 'w', height: 'h', gap: 'gap', 'column-gap': 'gap-x', 'row-gap': 'gap-y', padding: 'p', 'font-size': 'text', 'font-weight': 'font', 'line-height': 'leading', 'letter-spacing': 'tracking', 'border-radius': 'rounded', opacity: 'opacity', 'padding-left': 'pl', 'min-width': 'min-w', 'max-width': 'max-w', 'min-height': 'min-h', 'max-height': 'max-h' };
  function twClasses(st) {
    const cls = [], style = {};
    for (const [k, v] of st) {
      const key = `${k}:${v}`;
      if (TW[key]) { cls.push(TW[key]); continue; }
      if (k === 'background' || k === 'color') { if (/gradient/.test(v)) style[k] = v; else cls.push(`${k === 'color' ? 'text' : 'bg'}-[${v}]`); continue; }
      if (k === 'border-radius' && v === '9999px') { cls.push('rounded-full'); continue; }
      if (TWP[k]) { cls.push(`${TWP[k]}-[${String(v).replace(/\s+/g, '_')}]`); continue; }
      style[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v).replace(/^'(.*)'$/, '$1');
    }
    return { cls, style };
  }
  function toReact(frame, env) {
    const e = s => String(s ?? '').replace(/[{}<>]/g, c => ({ '{': '&#123;', '}': '&#125;', '<': '&lt;', '>': '&gt;' }[c]));
    const comp = (frame.name || 'Frame').replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => c ? c.toUpperCase() : '').replace(/^[^A-Za-z]+/, '') || 'Frame';
    const name = comp[0].toUpperCase() + comp.slice(1);
    const tree = codeTree(frame, env);
    const attrs = st => { const { cls, style } = twClasses(st); const sx = Object.keys(style).length ? ` style={{ ${Object.entries(style).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ')} }}` : ''; return ` className="${cls.join(' ')}"${sx}`; };
    const lines = [`export default function ${name}() {`, `  return (`, `    <div${attrs(rootCss(frame, tree))}>`];
    const emitNode = (nd, depth) => {
      const pad = '  '.repeat(depth + 2); const c = attrs(cssOf(nd));
      if (nd.children) { lines.push(`${pad}<div${c}>`); nd.children.forEach(ch => emitNode(ch, depth + 1)); lines.push(`${pad}</div>`); return; }
      if (nd.tag === 'img') lines.push(`${pad}<img src="/${e(nd.src).replace(/[^A-Za-z0-9._-]+/g, '-')}" alt=""${c} />`);
      else if (nd.tag === 'svg') lines.push(`${pad}<svg viewBox="${nd.viewBox}" preserveAspectRatio="none"${c} dangerouslySetInnerHTML={{ __html: ${JSON.stringify(nd.inner)} }} />`);
      else if (nd.tag === 'ul' || nd.tag === 'ol') lines.push(`${pad}<${nd.tag}${c}>`, ...nd.items.map(i => `${pad}  <li>${e(i)}</li>`), `${pad}</${nd.tag}>`);
      else lines.push(`${pad}<${nd.tag}${nd.tag === 'a' ? ' href="#"' : ''}${c}>${e(nd.text || '')}</${nd.tag}>`);
    };
    tree.children.forEach(nd => emitNode(nd, 1));
    lines.push('    </div>', '  );', '}');
    return lines.join('\n');
  }

  // ---- Batch edits for one or many frames -------------------------------------------------------------------------
  const norm = v => { try { return Color.normalize(v); } catch { return null; } };
  // Swap a frame's palette: every fill that matched the old bg, fg or accent takes the new one.
  function recolor(frame, to) {
    const L = frame.layout; const from = { ...L.palette };
    const map = new Map();
    for (const k of ['bg', 'fg', 'accent']) { const a = norm(from[k]), b = norm(to[k]); if (a && b && !map.has(a)) map.set(a, b); }
    const sw = v => { const k = norm(v); return k && map.has(k) ? map.get(k) : v; };
    for (const b of L.blocks) {
      if (b.fill) b.fill = sw(b.fill); if (b.color) b.color = sw(b.color);
      if (b.gradient && b.gradient.stops) b.gradient.stops.forEach(st => { st.c = sw(st.c); });
      if (b.stroke && b.stroke.color) b.stroke.color = sw(b.stroke.color);
      delete b.fillToken; delete b.colorToken;
    }
    L.palette = { ...L.palette, bg: norm(to.bg) || L.palette.bg, fg: norm(to.fg) || L.palette.fg, accent: norm(to.accent) || L.palette.accent, bgName: to.bgName || L.palette.bgName };
    delete L.palette.bgToken;
  }
  // The copy a layout carries, rebuilt from its blocks' content paths (what Engine.hydrate takes back).
  function extractContent(layout) {
    const out = {};
    const set = (path, v) => { const ks = path.split('.'); let t = out; for (let i = 0; i < ks.length - 1; i++) { const k = /^\d+$/.test(ks[i]) ? +ks[i] : ks[i]; const nextArr = /^\d+$/.test(ks[i + 1]); if (t[k] == null) t[k] = nextArr ? [] : {}; t = t[k]; } t[/^\d+$/.test(ks[ks.length - 1]) ? +ks[ks.length - 1] : ks[ks.length - 1]] = v; };
    for (const b of layout.blocks) {
      if (!b.path || b.decorative || b.hidden) continue;
      if (b.kind === 'text') set(b.path, sourceText(b).replace(/\s+→$/, ''));
      else if (b.kind === 'button') set(b.path, b.text || '');
      else if (b.kind === 'list') set(b.path, (b.items || []).slice());
    }
    return out;
  }
  // Resize a frame to another format by scaling its blocks; text sizes scale with the smaller ratio and refit.
  function scaleFrame(frame, format) {
    const L = frame.layout; const sx = format.w / L.format.w, sy = format.h / L.format.h; const sf = Math.min(sx, sy);
    const scaleAuto = a => { if (!a) return a; const s = Auto.norm(a); s.gap = Math.round(s.gap * sf); s.counterGap = Math.round(s.counterGap * sf); s.pad = { t: Math.round(s.pad.t * sy), r: Math.round(s.pad.r * sx), b: Math.round(s.pad.b * sy), l: Math.round(s.pad.l * sx) }; return s; };
    frame.autoLayout = scaleAuto(frame.autoLayout);
    for (const b of L.blocks) {
      if (b.auto) b.auto = scaleAuto(b.auto);
      if (b.rx != null) { b.rx = Math.round(b.rx * sx); b.ry = Math.round(b.ry * sy); } delete b.lx; delete b.ly;
      for (const k of ['minW', 'maxW']) if (b[k] != null) b[k] = Math.round(b[k] * sx); for (const k of ['minH', 'maxH']) if (b[k] != null) b[k] = Math.round(b[k] * sy);
      b.x = Math.round(b.x * sx); b.y = Math.round(b.y * sy); b.w = Math.max(4, Math.round(b.w * sx)); b.h = Math.max(4, Math.round(b.h * sy));
      if (b.font) { b.font.size = Math.max(8, Math.round(b.font.size * sf)); }
      if (b.kind === 'icon' || b.kind === 'badge' || b.kind === 'logo' || (b.kind === 'shape' && b.shape === 'circle')) { const s = Math.round(Math.min(b.w, b.h)); if (b.kind !== 'logo') { b.w = s; b.h = s; } else { b.h = Math.max(8, Math.round(b.h * sf / sy)); } }
      if (b.radius) b.radius = Math.round(b.radius * sf);
      if (b.kind === 'text' || b.kind === 'list' || b.kind === 'button') refit(b);
    }
    L.format = { id: format.id, name: format.name, w: format.w, h: format.h };
  }
  // Colors bound to a palette name follow the palette when it changes.
  function applyTokens(doc, kit) {
    const byName = new Map(kit.colors.map(c => [String(c.name || '').toLowerCase(), norm(c.hex)]));
    let n = 0;
    const res = t => t ? byName.get(String(t).toLowerCase()) : null;
    for (const f of doc.frames) {
      const pb = res(f.layout.palette.bgToken); if (pb && pb !== f.layout.palette.bg) { f.layout.palette.bg = pb; n++; } else if (f.layout.palette.bgToken && !byName.has(String(f.layout.palette.bgToken).toLowerCase())) delete f.layout.palette.bgToken;
      for (const b of f.layout.blocks) {
        for (const [tk, key] of [['fillToken', 'fill'], ['colorToken', 'color']]) {
          if (!b[tk]) continue; const hx = res(b[tk]);
          if (hx) { if (hx !== norm(b[key])) { b[key] = hx; n++; } } else delete b[tk];
        }
      }
    }
    return n;
  }
  function group(frame, blocks) { const g = 'g' + uid(); for (const b of blocks) b.group = g; return g; }
  function ungroup(frame, blocks) { const gs = new Set(blocks.map(b => b.group).filter(Boolean)); for (const b of frame.layout.blocks) if (gs.has(b.group)) delete b.group; return gs.size; }
  function groupMembers(frame, b) { return b && b.group ? frame.layout.blocks.filter(x => x.group === b.group) : (b ? [b] : []); }
  // Arrange frames: a row, or a grid about as wide as it is tall.
  function tidy(frames, mode = 'row', gap = 160) {
    if (!frames.length) return;
    const list = frames.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const x0 = Math.min(...list.map(f => f.x)), y0 = Math.min(...list.map(f => f.y));
    const cols = mode === 'grid' ? Math.max(1, Math.round(Math.sqrt(list.length * 1.6))) : list.length;
    let x = x0, y = y0, rowH = 0;
    list.forEach((f, i) => {
      if (i && i % cols === 0) { x = x0; y += rowH + gap; rowH = 0; }
      f.x = snap(x, 8); f.y = snap(y, 8); x += f.layout.format.w + gap; rowH = Math.max(rowH, f.layout.format.h);
    });
  }
  function replaceText(frames, find, repl, opts = {}) {
    if (!find) return 0; let n = 0;
    const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), opts.caseSensitive ? 'g' : 'gi');
    for (const f of frames) for (const b of f.layout.blocks) {
      if (b.kind === 'text') { const t = sourceText(b); const nt = t.replace(re, () => { n++; return repl; }); if (nt !== t) { b.text = nt; refit(b); } }
      else if (b.kind === 'button') { const nt = String(b.text || '').replace(re, () => { n++; return repl; }); if (nt !== b.text) { b.text = nt; refit(b); } }
      else if (b.kind === 'list') { const items = (b.items || []).map(i => String(i).replace(re, () => { n++; return repl; })); if (items.join('\n') !== (b.items || []).join('\n')) { b.items = items; refit(b); } }
    }
    return n;
  }
  const DISPLAY_ROLES = /^(headline|stat|eyebrow|quote|title|text)$/;
  function setFonts(frames, { display, body, kit }) {
    for (const f of frames) for (const b of f.layout.blocks) {
      if (!b.font || !(b.kind === 'text' || b.kind === 'list' || b.kind === 'button' || b.kind === 'badge')) continue;
      const isDisplay = b.kind === 'text' && DISPLAY_ROLES.test(b.role || 'text') && b.role !== 'body';
      const name = isDisplay ? display : body; if (!name) continue;
      b.font.family = Brand.fontCss(name);
      const ws = Brand.fontWeights(name); if (!ws.includes(b.font.weight)) b.font.weight = ws.reduce((p, c) => Math.abs(c - b.font.weight) < Math.abs(p - b.font.weight) ? c : p, ws[0]);
      refit(b);
    }
  }
  function pasteFrames(doc, frames, at) {
    const out = []; const x0 = Math.min(...frames.map(f => f.x)), y0 = Math.min(...frames.map(f => f.y));
    for (const src of frames) {
      const c = addFrame(doc, src.layout, { x: snap(at.x + (src.x - x0), 8), y: snap(at.y + (src.y - y0), 8), name: String(src.name || 'Frame').replace(/ copy( \d+)?$/, '') + ' copy' });
      c.autoLayout = clone(src.autoLayout || c.autoLayout); c.clip = src.clip !== false; migrate(c);
      Auto.remap(c.layout.blocks, null);
      out.push(c);
    }
    return out;
  }
  function framesBounds(frames) {
    const x0 = Math.min(...frames.map(f => f.x)), y0 = Math.min(...frames.map(f => f.y));
    const x1 = Math.max(...frames.map(f => f.x + f.layout.format.w)), y1 = Math.max(...frames.map(f => f.y + f.layout.format.h));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
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

  return { create, addFrame, blankFrame, migrate, defaultAuto, frameById, blockById, refit, sourceText, newBlock, moveBlock, resizeBlock, reorder, duplicateBlock, removeBlocks, transferBlocks, pasteBlocks, customFormat, align, distribute, bounds, applyAutoLayout, isBackground, serialize, deserialize, toLink, fromHash, toHTML, toReact, codeTree, codeNodes, recolor, extractContent, scaleFrame, applyTokens, group, ungroup, groupMembers, tidy, replaceText, setFonts, pasteFrames, framesBounds, cssGradient, history, snap, uid, clone };
})();
