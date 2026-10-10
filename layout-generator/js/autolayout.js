/* Auto layout, Figma style. A box (kind 'box') stacks its children horizontally or vertically, optionally wrapping, with
   a gap (or Auto: space between), padding on four sides and alignment; each child sizes itself Fixed, Hug contents or
   Fill container per axis, and can opt out with absolute position. The screen itself can be an auto layout container.
   Blocks stay one flat list per frame; `parent` links a block to its box, and sibling order is list order.
   Positions are frame coordinates. For children in the flow, x/y (and hug or fill sizes) are computed here, so they are
   derived data. Children outside the flow keep an offset from their box (rx, ry), so they move with it. lx/ly remember
   where this pass left them: a later difference means someone moved the block by hand. */
const Auto = (() => {
  const MAINS = ['start', 'center', 'end'], CROSSES = ['start', 'center', 'end', 'baseline'];
  const num = (v, d = 0) => (v != null && v !== '' && Number.isFinite(+v)) ? +v : d;
  const r2 = v => Math.round(v * 100) / 100;

  // ---- Settings ------------------------------------------------------------------------------------------------------
  // Also reads the first flex shape screens had ({mode, gap, padding, align, justify, fill}).
  function norm(al) {
    const a = al || {};
    const out = { v: 2, mode: a.mode === 'horizontal' || a.mode === 'vertical' ? a.mode : 'none', wrap: !!a.wrap, gap: num(a.gap, 24), gapAuto: !!a.gapAuto, counterGap: num(a.counterGap ?? a.gap, 24), counterGapAuto: !!a.counterGapAuto };
    const pn = num(a.padding, 0);
    out.pad = a.pad && typeof a.pad === 'object' ? { t: num(a.pad.t), r: num(a.pad.r), b: num(a.pad.b), l: num(a.pad.l) } : { t: pn, r: pn, b: pn, l: pn };
    let main = a.main, cross = a.cross;
    if (a.v !== 2) { if (a.justify === 'space-between') out.gapAuto = true; main = a.justify && a.justify !== 'space-between' ? a.justify : 'start'; cross = a.align; }
    out.main = MAINS.includes(main) ? main : 'start'; out.cross = CROSSES.includes(cross) ? cross : 'start';
    if (out.mode !== 'horizontal') out.wrap = false;
    return out;
  }
  const on = s => !!s && (s.mode === 'horizontal' || s.mode === 'vertical');
  const isBox = b => !!b && b.kind === 'box';
  // A screen needs a layout pass when it, or any box in it, stacks children, or when blocks sit inside boxes.
  function needs(f) { return on(norm(f.autoLayout)) || f.layout.blocks.some(b => b.parent || isBox(b)); }

  // ---- Tree ------------------------------------------------------------------------------------------------------------
  // Parents must be boxes in the same frame and must not loop; anything else sits at the top level.
  function index(f) {
    const blocks = f.layout.blocks; const byId = new Map(blocks.map(b => [b.id, b]));
    const par = new Map();
    for (const b of blocks) {
      let p = b.parent; const seen = new Set([b.id]); let ok = true;
      while (p) { const P = byId.get(p); if (!P || !isBox(P) || seen.has(p)) { ok = false; break; } seen.add(p); p = P.parent; }
      par.set(b.id, ok && b.parent ? b.parent : '');
    }
    const kids = new Map([['', []]]);
    for (const b of blocks) { const p = par.get(b.id); if (!kids.has(p)) kids.set(p, []); kids.get(p).push(b); }
    const sCache = new Map(); const rootS = norm(f.autoLayout);
    return { f, byId, par, kids, rootS, S: id => { if (!id) return rootS; if (!sCache.has(id)) sCache.set(id, norm(byId.get(id).auto)); return sCache.get(id); } };
  }
  const childrenOf = (I, id) => I.kids.get(id || '') || [];
  const parentOf = (f, b) => { const I = index(f); return I.byId.get(I.par.get(b.id)) || null; };
  function ancestors(f, b, I = index(f)) { const out = []; let p = I.par.get(b.id); while (p) { const P = I.byId.get(p); out.push(P); p = I.par.get(p); } return out; }
  function descendants(f, b, I = index(f)) { const out = []; const walk = id => { for (const k of childrenOf(I, id)) { out.push(k); walk(k.id); } }; walk(b.id); return out; }
  // Paint order: each block, then its children, siblings in list order. Hit testing walks it backwards.
  function paintOrder(f, I = index(f)) { const out = []; const walk = id => { for (const k of childrenOf(I, id)) { out.push(k); if (isBox(k)) walk(k.id); } }; walk(''); return out; }
  // The blocks of a selection that are not inside another selected block (moving a box moves what is in it).
  function topmost(f, blocks) { const I = index(f); const ids = new Set(blocks.map(b => b.id)); return blocks.filter(b => !ancestors(f, b, I).some(a => ids.has(a.id))); }
  function inFlow(I, b) { if (b.hidden || b.absolute) return false; return on(I.S(I.par.get(b.id))); }
  const flowKids = (I, id) => childrenOf(I, id).filter(k => !k.hidden && !k.absolute);

  // ---- Sizing -------------------------------------------------------------------------------------------------------------
  const HUGGABLE = new Set(['text', 'list', 'button']);
  const canHug = (I, b) => HUGGABLE.has(b.kind) || (isBox(b) && on(I.S(b.id)));
  // fixed | hug | fill for one axis. Text and lists hug their height by default (auto height), like Figma's text.
  function sizing(I, b, axis) {
    const v = axis === 'w' ? b.sizeW : b.sizeH;
    if (v === 'fill') return 'fill';
    if (v === 'hug') return canHug(I, b) ? 'hug' : 'fixed';
    if (v === 'fixed') return 'fixed';
    if (axis === 'h' && (b.kind === 'text' || b.kind === 'list')) return 'hug';
    return 'fixed';
  }
  const clampW = (b, v) => Math.max(1, Math.min(num(b.maxW, Infinity), Math.max(num(b.minW, 0), v)));
  const clampH = (b, v) => Math.max(1, Math.min(num(b.maxH, Infinity), Math.max(num(b.minH, 0), v)));
  function textHugW(b) { const f = b.font || { size: 16, weight: 400, family: 'sans-serif' }; const t = Text.transform(Canvas.sourceText(b), f.transform); return Math.ceil(Math.max(8, ...t.split('\n').map(l => Text.width(l, f)))) + 1; }
  function listHugW(b) { const f = b.font || { size: 16, weight: 400, family: 'sans-serif' }; const indent = b.indent || Math.round(f.size * (b.marker === 'number' ? 2.1 : 1.3)); return Math.ceil(indent + Math.max(8, ...(b.items && b.items.length ? b.items : ['']).map(i => Text.width(String(i), f)))) + 1; }
  function buttonHug(b) { const f = b.font || { size: 16, weight: 600, family: 'sans-serif' }; const px = num(b.padX, Math.round(f.size * 1.4)), py = num(b.padY, Math.round(f.size * 0.75)); return { w: Math.ceil(Text.width(String(b.text || ''), f) + 2 * px), h: Math.ceil(f.size * (f.lineHeight || 1.2) + 2 * py) }; }
  function hugW(I, b) {
    if (b.kind === 'text') return textHugW(b);
    if (b.kind === 'list') return listHugW(b);
    if (b.kind === 'button') return buttonHug(b).w;
    if (isBox(b) && on(I.S(b.id))) return boxHugW(I, b);
    return b.w;
  }
  function hugH(I, b, w) {
    if (b.kind === 'text' || b.kind === 'list') { b.w = w; Canvas.refit(b); return b.h; }
    if (b.kind === 'button') return buttonHug(b).h;
    if (isBox(b) && on(I.S(b.id))) return arrange(I, b.id, I.S(b.id), w, null).h;
    return b.h;
  }
  function boxHugW(I, b) {
    const s = I.S(b.id), p = s.pad; const kids = flowKids(I, b.id);
    if (s.wrap) return b.w;
    const ws = kids.map(k => clampW(k, sizing(I, k, 'w') !== 'fixed' && canHug(I, k) ? hugW(I, k) : k.w));
    if (!ws.length) return p.l + p.r;
    return s.mode === 'vertical' ? Math.max(...ws) + p.l + p.r : ws.reduce((a, c) => a + c, 0) + (s.gapAuto ? 0 : s.gap) * (ws.length - 1) + p.l + p.r;
  }
  // A block's own size outside any flow: fill means nothing there, so it keeps its size.
  function ownSize(I, b) {
    const sw = sizing(I, b, 'w'); const w = clampW(b, sw === 'hug' ? hugW(I, b) : b.w);
    const sh = sizing(I, b, 'h'); const h = clampH(b, sh === 'hug' ? hugH(I, b, w) : b.h);
    return { w, h };
  }
  function baseline(b, h) {
    if ((b.kind === 'text' || b.kind === 'list') && b.font) { const s = b.font.size || 16; return s * 0.78 + (s * (b.font.lineHeight || 1.2) - s) / 2; }
    if (b.kind === 'button' && b.font) return h / 2 + (b.font.size || 16) * 0.35;
    if (isBox(b) && b.firstBaseline != null) return b.firstBaseline;
    return h;
  }
  const crossOff = (c, inner, size) => c === 'center' ? (inner - size) / 2 : c === 'end' ? inner - size : 0;

  // ---- Arrange: child boxes of one container for an outer size W x H (H null = hug) -------------------------------------
  function arrange(I, cid, s, W, H) {
    const p = s.pad; const kids = flowKids(I, cid);
    const innerW = Math.max(0, W - p.l - p.r), innerH = H == null ? null : Math.max(0, H - p.t - p.b);
    const items = kids.map(k => ({ k, x: 0, y: 0, w: 0, h: 0 }));
    if (!items.length) return { items, h: p.t + p.b };
    if (s.mode === 'vertical') return arrangeV(I, s, items, innerW, innerH, p);
    return s.wrap ? arrangeWrap(I, s, items, innerW, innerH, p) : arrangeH(I, s, items, innerW, innerH, p);
  }
  function arrangeV(I, s, items, innerW, innerH, p) {
    for (const it of items) { const sw = sizing(I, it.k, 'w'); it.w = clampW(it.k, sw === 'fill' ? innerW : sw === 'hug' ? hugW(I, it.k) : it.k.w); }
    const grow = [];
    for (const it of items) {
      const sh = sizing(I, it.k, 'h');
      if (sh === 'fill' && innerH != null) { grow.push(it); it.h = clampH(it.k, 1); }
      else it.h = clampH(it.k, sh === 'hug' || (sh === 'fill' && canHug(I, it.k)) ? hugH(I, it.k, it.w) : it.k.h);
    }
    const n = items.length; let gap = s.gap;
    const sum = items.filter(it => !grow.includes(it)).reduce((t, it) => t + it.h, 0);
    let free = innerH == null ? 0 : innerH - sum - gap * (n - 1);
    if (grow.length) { const each = Math.max(0, free) / grow.length; for (const it of grow) { it.h = clampH(it.k, each); if (it.k.kind === 'text' || it.k.kind === 'list') hugH(I, it.k, it.w); } free = innerH - items.reduce((t, it) => t + it.h, 0) - gap * (n - 1); }
    else if (s.gapAuto && n > 1 && innerH != null) { gap = Math.max(0, (innerH - sum) / (n - 1)); free = innerH - sum - gap * (n - 1); }
    const off = innerH == null || grow.length || (s.gapAuto && n > 1) ? 0 : s.main === 'center' ? free / 2 : s.main === 'end' ? free : 0;
    let y = p.t + off;
    for (const it of items) { it.y = y; y += it.h + gap; it.x = p.l + crossOff(s.cross, innerW, it.w); }
    const used = items.reduce((t, it) => t + it.h, 0) + gap * (n - 1);
    return { items, h: (innerH == null ? used : innerH) + p.t + p.b };
  }
  function arrangeH(I, s, items, innerW, innerH, p) {
    const grow = [];
    for (const it of items) { const sw = sizing(I, it.k, 'w'); if (sw === 'fill') { grow.push(it); it.w = clampW(it.k, 1); } else it.w = clampW(it.k, sw === 'hug' ? hugW(I, it.k) : it.k.w); }
    const n = items.length; let gap = s.gap;
    const sum = items.filter(it => !grow.includes(it)).reduce((t, it) => t + it.w, 0);
    let free = innerW - sum - gap * (n - 1);
    if (grow.length) { const each = Math.max(0, free) / grow.length; for (const it of grow) it.w = clampW(it.k, each); free = innerW - items.reduce((t, it) => t + it.w, 0) - gap * (n - 1); }
    else if (s.gapAuto && n > 1) { gap = Math.max(0, (innerW - sum) / (n - 1)); free = innerW - sum - gap * (n - 1); }
    rowHeights(I, s, items, innerH);
    const lineH = innerH != null ? innerH : rowExtent(s, items);
    placeRow(s, items, p.l + (grow.length || (s.gapAuto && n > 1) ? 0 : s.main === 'center' ? free / 2 : s.main === 'end' ? free : 0), gap, p.t, lineH);
    return { items, h: lineH + p.t + p.b };
  }
  function arrangeWrap(I, s, items, innerW, innerH, p) {
    for (const it of items) { const sw = sizing(I, it.k, 'w'); it.fill = sw === 'fill'; it.w = clampW(it.k, sw === 'fixed' ? it.k.w : canHug(I, it.k) ? hugW(I, it.k) : it.k.w); }
    const rows = []; let row = [], rowW = 0;
    for (const it of items) { const add = (row.length ? s.gap : 0) + it.w; if (row.length && rowW + add > innerW + 0.5) { rows.push(row); row = [it]; rowW = it.w; } else { row.push(it); rowW += add; } }
    if (row.length) rows.push(row);
    const metas = rows.map(r => {
      const n = r.length; let gap = s.gap; const sum = r.reduce((t, it) => t + it.w, 0); let free = innerW - sum - gap * (n - 1);
      const grow = r.filter(it => it.fill);
      if (grow.length && free > 0) { const each = free / grow.length; for (const it of grow) it.w = clampW(it.k, it.w + each); free = innerW - r.reduce((t, it) => t + it.w, 0) - gap * (n - 1); }
      else if (s.gapAuto && n > 1) { gap = Math.max(0, (innerW - sum) / (n - 1)); free = 0; }
      rowHeights(I, s, r, null);
      return { r, gap, off: grow.length || (s.gapAuto && n > 1) ? 0 : s.main === 'center' ? free / 2 : s.main === 'end' ? free : 0, h: rowExtent(s, r) };
    });
    const total = metas.reduce((t, m) => t + m.h, 0);
    let cgap = s.counterGap; if (s.counterGapAuto && innerH != null && metas.length > 1) cgap = Math.max(0, (innerH - total) / (metas.length - 1));
    let y = p.t;
    for (const m of metas) { for (const it of m.r) if (sizing(I, it.k, 'h') === 'fill') it.h = clampH(it.k, m.h); placeRow(s, m.r, p.l + m.off, m.gap, y, m.h); y += m.h + cgap; }
    const used = total + cgap * (metas.length - 1);
    return { items, h: (innerH == null ? used : Math.max(innerH, used)) + p.t + p.b };
  }
  // Heights of one row once widths are known; fill-height children take the row's height.
  function rowHeights(I, s, items, innerH) {
    const fills = [];
    for (const it of items) {
      const sh = sizing(I, it.k, 'h');
      if (sh === 'fill') { fills.push(it); it.h = clampH(it.k, innerH != null ? innerH : canHug(I, it.k) ? hugH(I, it.k, it.w) : it.k.h); }
      else it.h = clampH(it.k, sh === 'hug' ? hugH(I, it.k, it.w) : it.k.h);
    }
    if (innerH == null && fills.length) { const others = items.filter(it => !fills.includes(it)); const lh = others.length ? rowExtent(s, others) : Math.max(...fills.map(it => it.h)); for (const it of fills) it.h = clampH(it.k, lh); }
    for (const it of fills) if (it.k.kind === 'text' || it.k.kind === 'list') hugH(I, it.k, it.w);
  }
  function rowExtent(s, items) {
    if (s.cross !== 'baseline') return Math.max(...items.map(it => it.h));
    const bl = items.map(it => baseline(it.k, it.h)); const up = Math.max(...bl); return up + Math.max(...items.map((it, i) => it.h - bl[i]));
  }
  function placeRow(s, items, x0, gap, y0, lineH) {
    let x = x0;
    const up = s.cross === 'baseline' ? Math.max(...items.map(it => baseline(it.k, it.h))) : 0;
    for (const it of items) { it.x = x; x += it.w + gap; it.y = y0 + (s.cross === 'baseline' ? up - baseline(it.k, it.h) : crossOff(s.cross, lineH, it.h)); }
  }

  // ---- Commit: write boxes into blocks, top down ----------------------------------------------------------------------
  function commit(I, b, x, y, w, h, measured) {
    b.x = r2(x); b.y = r2(y);
    if (measured) {
      if (b.kind === 'text' || b.kind === 'list') { b.w = r2(w); Canvas.refit(b); if (sizing(I, b, 'h') !== 'hug') b.h = r2(h); }
      else { b.w = r2(w); b.h = r2(h); if (b.kind === 'button') Canvas.refit(b); }
    }
    if (isBox(b)) layoutInside(I, b);
  }
  function layoutInside(I, b) {
    const s = I.S(b.id);
    if (on(s)) { const r = arrange(I, b.id, s, b.w, b.h); for (const it of r.items) commit(I, it.k, b.x + it.x, b.y + it.y, it.w, it.h, true); }
    for (const k of childrenOf(I, b.id)) {
      if (on(s) && !k.hidden && !k.absolute) continue;
      const explicit = k.sizeW === 'hug' || k.sizeH === 'hug' || isBox(k);
      const sz = explicit ? ownSize(I, k) : null;
      commit(I, k, b.x + num(k.rx), b.y + num(k.ry), sz ? sz.w : k.w, sz ? sz.h : k.h, !!sz);
    }
  }
  // The pass for one screen. Returns true when it ran.
  function layout(f) {
    if (!needs(f)) return false;
    const I = index(f); const blocks = f.layout.blocks;
    // 1. offsets of blocks that sit in a box but outside its flow
    for (const b of blocks) {
      const pid = I.par.get(b.id);
      if (!pid) { if (b.parent) delete b.parent; delete b.rx; delete b.ry; if (!isBox(b)) { delete b.lx; delete b.ly; } continue; }
      if (inFlow(I, b)) continue;
      const P = I.byId.get(pid); const hasXY = Number.isFinite(b.x) && Number.isFinite(b.y);
      if (b.rx == null || b.ry == null) { b.rx = hasXY && Number.isFinite(P.x) ? b.x - P.x : 0; b.ry = hasXY && Number.isFinite(P.y) ? b.y - P.y : 0; }
      else if (hasXY && b.lx != null && b.ly != null && (b.x !== b.lx || b.y !== b.ly)) {
        // moved by hand: keep where it was put. Moved together with its box (same distance): the offset holds.
        const dp = P.lx != null && Number.isFinite(P.x) ? { x: P.x - P.lx, y: P.y - P.ly } : { x: 0, y: 0 };
        b.rx += (b.x - b.lx) - dp.x; b.ry += (b.y - b.ly) - dp.y;
      }
    }
    // 2. the screen, then every box inside it
    const W = f.layout.format.w, H = f.layout.format.h; const rs = I.rootS;
    if (on(rs)) { const r = arrange(I, '', rs, W, H); for (const it of r.items) commit(I, it.k, it.x, it.y, it.w, it.h, true); }
    for (const b of childrenOf(I, '')) {
      if (on(rs) && !b.hidden && !b.absolute) continue;
      const explicit = b.sizeW === 'hug' || b.sizeH === 'hug' || (isBox(b) && on(I.S(b.id)));
      const sz = explicit ? ownSize(I, b) : null;
      commit(I, b, num(b.x), num(b.y), sz ? sz.w : b.w, sz ? sz.h : b.h, !!sz);
    }
    // 3. bookkeeping for the next pass
    for (const b of blocks) {
      const parented = !!I.par.get(b.id); const flow = parented && inFlow(I, b);
      if (parented && !flow) { b.rx = r2(b.rx); b.ry = r2(b.ry); }
      if (flow) { delete b.rx; delete b.ry; }
      if ((parented && !flow) || isBox(b)) { b.lx = b.x; b.ly = b.y; } else { delete b.lx; delete b.ly; }
    }
    return true;
  }

  // ---- Sync view: drop what every viewer computes for themselves ------------------------------------------------------
  const MEASURED = ['lines', 'inkW', 'overflow'];
  // Measured again by every viewer's pass: blocks in a flow, explicit hug sizes, and stacks.
  const remeasured = (I, b, flow) => flow || b.sizeW === 'hug' || b.sizeH === 'hug' || (isBox(b) && on(I.S(b.id)));
  function syncBlock(f, b, I) {
    if (!I) return b;
    const pid = I.par.get(b.id); const flow = inFlow(I, b); const re = remeasured(I, b, flow);
    if (!pid && !re && b.lx == null) return b;
    const out = { ...b }; delete out.lx; delete out.ly;
    if (pid || flow) { delete out.x; delete out.y; }
    if (flow) { delete out.rx; delete out.ry; }
    if (re) {
      const sw = sizing(I, b, 'w'), sh = sizing(I, b, 'h');
      if (sw === 'hug' || (flow && sw === 'fill')) delete out.w;
      if (sh === 'hug' || (flow && sh === 'fill')) delete out.h;
      if (b.kind === 'text' || b.kind === 'list') for (const k of MEASURED) delete out[k];
    }
    return out;
  }
  // Blocks arriving without positions get defaults so nothing downstream sees undefined before the pass runs.
  function fillDefaults(f) { for (const b of f.layout.blocks) { for (const k of ['x', 'y']) if (!Number.isFinite(b[k])) b[k] = 0; for (const k of ['w', 'h']) if (!Number.isFinite(b[k])) b[k] = 8; } }

  // ---- Editing operations -------------------------------------------------------------------------------------------------
  const snapTo = (v, u = 4) => Math.max(0, Math.round(v / u) * u);
  // Direction, gap, padding and alignment read from how blocks already sit (what Shift+A does in Figma).
  function infer(blocks, box) {
    if (!blocks.length) return { mode: 'vertical', gap: 16, pad: { t: 0, r: 0, b: 0, l: 0 }, cross: 'start' };
    const ov = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
    const byX = blocks.slice().sort((a, b) => a.x - b.x), byY = blocks.slice().sort((a, b) => a.y - b.y);
    let ox = 0, oy = 0; for (let i = 1; i < blocks.length; i++) { ox += ov(byX[i - 1].x, byX[i - 1].x + byX[i - 1].w, byX[i].x, byX[i].x + byX[i].w); oy += ov(byY[i - 1].y, byY[i - 1].y + byY[i - 1].h, byY[i].y, byY[i].y + byY[i].h); }
    const mode = blocks.length > 1 && ox < oy ? 'horizontal' : 'vertical';
    const seq = mode === 'horizontal' ? byX : byY; const gaps = [];
    for (let i = 1; i < seq.length; i++) gaps.push(mode === 'horizontal' ? seq[i].x - (seq[i - 1].x + seq[i - 1].w) : seq[i].y - (seq[i - 1].y + seq[i - 1].h));
    gaps.sort((a, b) => a - b); const gap = gaps.length ? snapTo(gaps[Math.floor(gaps.length / 2)]) : 16;
    const bb = Canvas.bounds(blocks); const pad = box ? { t: snapTo(bb.y - box.y), r: snapTo(box.x + box.w - bb.x - bb.w), b: snapTo(box.y + box.h - bb.y - bb.h), l: snapTo(bb.x - box.x) } : { t: 0, r: 0, b: 0, l: 0 };
    const near = (vals, tol = 3) => vals.every(v => Math.abs(v - vals[0]) <= tol);
    let cross = 'start';
    if (blocks.length > 1) {
      if (mode === 'vertical') cross = near(blocks.map(b => b.x)) ? 'start' : near(blocks.map(b => b.x + b.w / 2)) ? 'center' : near(blocks.map(b => b.x + b.w)) ? 'end' : 'start';
      else cross = near(blocks.map(b => b.y)) ? 'start' : near(blocks.map(b => b.y + b.h / 2)) ? 'center' : near(blocks.map(b => b.y + b.h)) ? 'end' : 'start';
    }
    return { mode, gap, pad, cross, order: seq };
  }
  // Move a block to sit just before `before` (or last) among the children of parentId, keeping the list's other order.
  function moveInList(f, b, parentId, before) {
    const list = f.layout.blocks; list.splice(list.indexOf(b), 1);
    if (parentId) b.parent = parentId; else delete b.parent;
    let i = before ? list.indexOf(before) : -1;
    if (i < 0) { const I = index({ ...f, layout: { ...f.layout, blocks: list } }); const sib = childrenOf(I, parentId); const last = sib[sib.length - 1]; i = last ? lastIndexOfSubtree(list, I, last) + 1 : (parentId ? list.findIndex(x => x.id === parentId) + 1 : list.length); }
    list.splice(Math.max(0, i), 0, b);
  }
  function lastIndexOfSubtree(list, I, b) { let i = list.indexOf(b); const walk = id => { for (const k of childrenOf(I, id)) { i = Math.max(i, list.indexOf(k)); walk(k.id); } }; walk(b.id); return i; }
  // Wrap blocks (siblings) in a new box. withAuto: an auto layout stack inferred from their arrangement (Shift+A);
  // without: a plain box (Frame selection).
  function wrap(f, blocks, withAuto = true) {
    if (!blocks.length) return null;
    const I = index(f); const pid = I.par.get(blocks[0].id) || '';
    const sibs = blocks.filter(b => (I.par.get(b.id) || '') === pid);
    const bb = Canvas.bounds(sibs);
    const box = { id: Canvas.uid(), kind: 'box', x: bb.x, y: bb.y, w: Math.max(1, bb.w), h: Math.max(1, bb.h), fill: 'none', radius: 0, clip: false, decorative: true, hidden: false, locked: false };
    if (pid) box.parent = pid;
    if (withAuto) {
      const inf = infer(sibs, null);
      box.auto = { v: 2, mode: inf.mode, wrap: false, gap: inf.gap, gapAuto: false, counterGap: inf.gap, counterGapAuto: false, pad: { t: 0, r: 0, b: 0, l: 0 }, main: 'start', cross: inf.cross };
      box.sizeW = 'hug'; box.sizeH = 'hug';
      sibs.splice(0, sibs.length, ...inf.order);
    }
    const list = f.layout.blocks; const first = Math.min(...sibs.map(b => list.indexOf(b)));
    list.splice(first, 0, box);
    for (const b of sibs) { list.splice(list.indexOf(b), 1); b.parent = box.id; delete b.rx; delete b.ry; delete b.lx; delete b.ly; if (withAuto) delete b.absolute; }
    // children follow in their new order right after the box
    let at = list.indexOf(box) + 1; for (const b of sibs) { list.splice(at++, 0, b); }
    if (!withAuto) for (const b of sibs) { b.rx = b.x - box.x; b.ry = b.y - box.y; }
    return box;
  }
  // Turn auto layout on for a box (or the screen, box null), reading direction and spacing from the children.
  function enable(f, box) {
    const I = index(f); const pid = box ? box.id : '';
    const kids = childrenOf(I, pid).filter(k => !k.hidden);
    const area = box || { x: 0, y: 0, w: f.layout.format.w, h: f.layout.format.h };
    if (!box) for (const k of kids) if (Canvas.isBackground(f, k) || k.kind === 'scrim') k.absolute = true;
    const flow = kids.filter(k => !k.absolute);
    const inf = infer(flow, area);
    const s = { v: 2, mode: inf.mode, wrap: false, gap: inf.gap, gapAuto: false, counterGap: inf.gap, counterGapAuto: false, pad: inf.pad, main: 'start', cross: inf.cross };
    if (box) box.auto = s; else f.autoLayout = s;
    // flow order follows position
    const list = f.layout.blocks; const slots = flow.map(k => list.indexOf(k)).sort((a, b) => a - b);
    inf.order.forEach((k, i) => { list[slots[i]] = k; });
    for (const k of flow) { delete k.rx; delete k.ry; delete k.lx; delete k.ly; }
    return s;
  }
  // Turn it off: children stay where they are and become free.
  function disable(f, box) { if (box) box.auto = { ...norm(box.auto), mode: 'none' }; else f.autoLayout = { ...norm(f.autoLayout), mode: 'none' }; if (box) { delete box.sizeW; delete box.sizeH; } }
  // Every stack in the screen off at once (simple editing, when someone drags a block to a free spot).
  function flatten(f) {
    let n = 0;
    if (on(norm(f.autoLayout))) { f.autoLayout = { ...norm(f.autoLayout), mode: 'none' }; n++; }
    for (const b of f.layout.blocks) {
      if (isBox(b) && on(norm(b.auto))) { b.auto = { ...norm(b.auto), mode: 'none' }; n++; }
      if (b.sizeW === 'hug' || b.sizeW === 'fill') b.sizeW = 'fixed'; if (b.sizeH === 'fill') b.sizeH = 'fixed'; if (b.sizeH === 'hug' && b.kind !== 'text' && b.kind !== 'list') b.sizeH = 'fixed';
    }
    return n;
  }
  // Remove a box but keep what is in it (children move up a level and keep their places).
  function unwrap(f, box) {
    const I = index(f); const pid = I.par.get(box.id) || '';
    const kids = childrenOf(I, box.id); const list = f.layout.blocks;
    for (const k of kids) { if (pid) k.parent = pid; else delete k.parent; delete k.rx; delete k.ry; delete k.lx; delete k.ly; }
    list.splice(list.indexOf(box), 1);
    return kids;
  }
  // Ids in a pasted or duplicated subtree are new; parents inside the set follow, others drop to `root`.
  function remap(blocks, root) {
    const map = new Map(blocks.map(b => [b.id, Canvas.uid()]));
    for (const b of blocks) { b.id = map.get(b.id); if (b.parent && map.has(b.parent)) b.parent = map.get(b.parent); else if (root) b.parent = root; else delete b.parent; }
    return map;
  }
  // A selection plus everything inside its boxes, in list order.
  function withDescendants(f, blocks) {
    const I = index(f); const ids = new Set();
    for (const b of blocks) { ids.add(b.id); for (const d of descendants(f, b, I)) ids.add(d.id); }
    return f.layout.blocks.filter(b => ids.has(b.id));
  }
  // Where a dragged block would land among a stack's children: index before which it goes.
  function dropIndex(f, box, p, exclude = []) {
    const I = index(f); const pid = box ? box.id : ''; const s = I.S(pid);
    const ex = new Set(exclude.map(b => b.id)); const kids = flowKids(I, pid).filter(k => !ex.has(k.id));
    const H = s.mode === 'horizontal';
    for (let i = 0; i < kids.length; i++) { const k = kids[i]; const mid = H ? k.x + k.w / 2 : k.y + k.h / 2; const v = H ? p.x : p.y; if (s.wrap) { if (p.y < k.y + k.h && (p.x < k.x + k.w / 2 || p.y < k.y)) return { index: i, before: k, kids, s }; } else if (v < mid) return { index: i, before: k, kids, s }; }
    return { index: kids.length, before: null, kids, s };
  }
  // The deepest box under a point that could take a dropped block (never the dragged ones or what is in them).
  function containerAt(f, p, exclude = []) {
    const I = index(f); const ex = new Set(); for (const b of exclude) { ex.add(b.id); for (const d of descendants(f, b, I)) ex.add(d.id); }
    const order = paintOrder(f, I);
    for (let i = order.length - 1; i >= 0; i--) { const b = order[i]; if (!isBox(b) || b.hidden || ex.has(b.id)) continue; if (p.x >= b.x && p.y >= b.y && p.x <= b.x + b.w && p.y <= b.y + b.h) return b; }
    return null;
  }

  return { norm, on, isBox, needs, index, childrenOf, parentOf, ancestors, descendants, paintOrder, topmost, inFlow, flowKids, sizing, canHug, ownSize, layout, syncBlock, fillDefaults, infer, wrap, enable, disable, flatten, unwrap, remap, withDescendants, moveInList, dropIndex, containerAt, settingsOf: (f, b) => b ? norm(b.auto) : norm(f.autoLayout) };
})();
