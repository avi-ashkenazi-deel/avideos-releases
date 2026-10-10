/* PowerPoint (and Google Slides, which exports .pptx) in. Reads the package with the browser's own unzip and XML parser:
   slides in order, their layouts and masters (placeholder positions and text styles are inherited the way PowerPoint
   does it), the theme's colors and fonts, backgrounds, shapes, text with bullets, pictures (with crops), groups,
   lines and tables. Each text box becomes a stack (padding from its insets, aligned like its anchor) so edited copy
   reflows; with Fixed positions chosen, everything is laid out once and then pinned where it was. */
const PptxImport = (() => {
  const A = 'http://schemas.openxmlformats.org/drawingml/2006/main', P = 'http://schemas.openxmlformats.org/presentationml/2006/main', R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const EMU = 9525; // per CSS px at 96 dpi
  const r2 = v => Math.round(v * 100) / 100;
  const num = (v, d = 0) => (v != null && v !== '' && Number.isFinite(+v)) ? +v : d;
  const ch = (el, name, ns) => el ? [...el.children].filter(c => c.localName === name && (!ns || c.namespaceURI === ns)) : [];
  const one = (el, name, ns) => ch(el, name, ns)[0] || null;
  const at = (el, ...names) => { let cur = el; for (const n of names) { if (!cur) return null; cur = one(cur, n); } return cur; };
  const attr = (el, n, d = null) => el && el.hasAttribute(n) ? el.getAttribute(n) : d;
  const rid = (el, n) => el ? (el.getAttributeNS(R, n) || el.getAttribute('r:' + n)) : null;
  const uid = () => Math.random().toString(36).slice(2, 8);

  // ---- Package -------------------------------------------------------------------------------------------------------
  const resolve = (dir, t) => { if (/^\//.test(t)) return t.slice(1); const out = []; for (const p of (dir + '/' + t).split('/')) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); } return out.join('/'); };
  function open(bytes) {
    const zip = FigmaImport._zip.readZip(bytes); const xmlCache = new Map(); const relCache = new Map();
    const raw = async name => { const e = zip.get(name); return e ? FigmaImport._zip.zipEntry(e) : null; };
    const xml = async name => { if (!xmlCache.has(name)) xmlCache.set(name, (async () => { const b = await raw(name); if (!b) return null; const d = new DOMParser().parseFromString(new TextDecoder().decode(b), 'application/xml'); return d.querySelector('parsererror') ? null : d; })()); return xmlCache.get(name); };
    const rels = async part => {
      if (!relCache.has(part)) relCache.set(part, (async () => {
        const dir = part.slice(0, part.lastIndexOf('/')); const d = await xml(`${dir}/_rels/${part.slice(part.lastIndexOf('/') + 1)}.rels`); const m = new Map();
        if (d) for (const r of d.documentElement.children) m.set(r.getAttribute('Id'), { type: String(r.getAttribute('Type') || '').split('/').pop(), target: r.getAttribute('TargetMode') === 'External' ? r.getAttribute('Target') : resolve(dir, r.getAttribute('Target') || ''), external: r.getAttribute('TargetMode') === 'External' });
        return m;
      })());
      return relCache.get(part);
    };
    return { zip, raw, xml, rels };
  }

  // ---- Colors --------------------------------------------------------------------------------------------------------
  const PRST = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', gray: '808080', grey: '808080', darkGray: 'A9A9A9', lightGray: 'D3D3D3', orange: 'FFA500', purple: '800080', navy: '000080' };
  const toHex = (r, g, b) => '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
  const fromHex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  function rgb2hsl([r, g, b]) { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h = 0, s = 0; const l = (mx + mn) / 2; if (mx !== mn) { const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6; } return [h, s, l]; }
  function hsl2rgb([h, s, l]) { if (!s) return [l * 255, l * 255, l * 255]; const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q; const f = t => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; }; return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255]; }
  function mods(hex, el) {
    let rgb = fromHex(hex); let a = 1;
    for (const m of (el ? el.children : [])) {
      const v = num(m.getAttribute('val')) / 100000;
      if (m.localName === 'alpha') a = v;
      else if (m.localName === 'tint') rgb = rgb.map(c => c * v + 255 * (1 - v));
      else if (m.localName === 'shade') rgb = rgb.map(c => c * v);
      else if (m.localName === 'lumMod' || m.localName === 'lumOff' || m.localName === 'satMod' || m.localName === 'satOff' || m.localName === 'hueOff') {
        const h = rgb2hsl(rgb);
        if (m.localName === 'lumMod') h[2] *= v; else if (m.localName === 'lumOff') h[2] += v; else if (m.localName === 'satMod') h[1] *= v; else if (m.localName === 'satOff') h[1] += v; else h[0] = (h[0] + num(m.getAttribute('val')) / 21600000) % 1;
        h[1] = Math.max(0, Math.min(1, h[1])); h[2] = Math.max(0, Math.min(1, h[2])); rgb = hsl2rgb(h);
      }
    }
    return { hex: toHex(...rgb), a };
  }
  // A color element (srgbClr, schemeClr, ...) under ctx's theme and color map; phClr is the style's placeholder color.
  function colorOf(el, ctx, phClr) {
    if (!el) return null;
    const ln = el.localName; let hex = null;
    if (ln === 'srgbClr') hex = el.getAttribute('val');
    else if (ln === 'schemeClr') { const v = el.getAttribute('val'); if (v === 'phClr') return phClr ? mods(phClr.hex, el) : null; hex = ctx.theme.scheme[ctx.clrMap[v] || v] || ctx.theme.scheme[v]; }
    else if (ln === 'sysClr') hex = el.getAttribute('lastClr') || (el.getAttribute('val') === 'window' ? 'FFFFFF' : '000000');
    else if (ln === 'prstClr') hex = PRST[el.getAttribute('val')] || '000000';
    else if (ln === 'scrgbClr') { const c = ['r', 'g', 'b'].map(k => num(el.getAttribute(k)) / 100000 * 255); return mods(toHex(...c), el); }
    else if (ln === 'hslClr') { const c = hsl2rgb([num(el.getAttribute('hue')) / 21600000, num(el.getAttribute('sat')) / 100000, num(el.getAttribute('lum')) / 100000]); return mods(toHex(...c), el); }
    if (!hex || !/^[0-9a-fA-F]{6}$/.test(hex)) return null;
    return mods('#' + hex.toUpperCase(), el);
  }
  const colorChild = el => el ? [...el.children].find(c => /Clr$/.test(c.localName)) : null;
  // Fill under an spPr-like element: {none} | {color} | {grad} | {embed} | null (not set here).
  function fillOf(pr, ctx, phClr) {
    if (!pr) return null;
    for (const c of pr.children) {
      if (c.localName === 'noFill') return { none: true };
      if (c.localName === 'solidFill') { const col = colorOf(colorChild(c), ctx, phClr); return col ? { color: col } : null; }
      if (c.localName === 'gradFill') {
        const stops = ch(at(c, 'gsLst'), 'gs').map(g => { const col = colorOf(colorChild(g), ctx, phClr) || { hex: '#000000', a: 1 }; return { c: col.hex, p: r2(num(g.getAttribute('pos')) / 100000), a: col.a }; }).sort((x, y) => x.p - y.p);
        if (stops.length < 2) return stops.length ? { color: { hex: stops[0].c, a: stops[0].a } } : null;
        const lin = at(c, 'lin'); const path = at(c, 'path');
        return { grad: path ? { type: 'radial', stops } : { type: 'linear', angle: Math.round((num(attr(lin, 'ang')) / 60000 + 90) % 360), stops }, color: { hex: stops[0].c, a: stops[0].a } };
      }
      if (c.localName === 'blipFill') { const blip = at(c, 'blip'); return { embed: rid(blip, 'embed'), srcRect: at(c, 'srcRect') }; }
      if (c.localName === 'pattFill') { const col = colorOf(colorChild(at(c, 'fgClr')), ctx, phClr); return col ? { color: col } : null; }
      if (c.localName === 'grpFill') return ctx.grpFill || null;
    }
    return null;
  }
  function lineOf(pr, ctx, phClr) {
    const ln = at(pr, 'ln'); if (!ln) return null;
    if (one(ln, 'noFill')) return { none: true };
    const sf = one(ln, 'solidFill'); const col = sf ? colorOf(colorChild(sf), ctx, phClr) : null;
    const w = num(ln.getAttribute('w'), 12700) / EMU;
    return col ? { color: col.hex, width: w } : (ln.hasAttribute('w') ? { width: w } : null);
  }
  // Theme fill/line styles referenced by p:style (fillRef / lnRef idx) take the ref's color as phClr.
  function styleRef(sp, name, ctx) { const st = at(sp, 'style'); const ref = st && one(st, name); if (!ref) return null; const idx = num(ref.getAttribute('idx')); if (!idx) return null; return { idx, color: colorOf(colorChild(ref), ctx) }; }

  // ---- Text styles ---------------------------------------------------------------------------------------------------
  // A chain of lstStyle-like elements (most specific first); properties for level n come from the first that sets them.
  function lvlOf(chain, lvl) {
    const out = { rpr: [], ppr: [] };
    for (const ls of chain) { if (!ls) continue; const p = one(ls, `lvl${lvl + 1}pPr`) || (lvl === 0 ? one(ls, 'defPPr') : null); if (p) { out.ppr.push(p); const d = one(p, 'defRPr'); if (d) out.rpr.push(d); } }
    return out;
  }
  const firstAttr = (els, name) => { for (const e of els) if (e && e.hasAttribute(name)) return e.getAttribute(name); return null; };
  const firstChild = (els, name) => { for (const e of els) { const c = e && one(e, name); if (c) return c; } return null; };
  function fontName(tf, ctx) { if (!tf) return null; if (tf === '+mj-lt' || tf === '+mj-ea') return ctx.theme.major; if (tf === '+mn-lt' || tf === '+mn-ea') return ctx.theme.minor; return tf; }
  function fontCss(name) { name = String(name || 'Inter').replace(/["'<>]/g, ''); if (typeof Brand !== 'undefined' && (Brand.FONTS[name] || Brand.customFonts[name])) return Brand.fontCss(name); return `"${name}", Inter, system-ui, sans-serif`; }

  // ---- Slides --------------------------------------------------------------------------------------------------------
  async function read(bytes, opts = {}) {
    const pkg = open(bytes);
    const pres = await pkg.xml('ppt/presentation.xml'); if (!pres) throw new Error('Not a PowerPoint file (no ppt/presentation.xml)');
    const root = pres.documentElement; const sz = at(root, 'sldSz');
    const cx = num(attr(sz, 'cx'), 12192000), cy = num(attr(sz, 'cy'), 6858000);
    const wpx = cx / EMU, hpx = cy / EMU; const S = wpx >= hpx ? 1920 / wpx : 1080 / wpx;
    const W = Math.round(wpx * S), H = Math.round(hpx * S);
    const presRels = await pkg.rels('ppt/presentation.xml');
    const slideIds = ch(at(root, 'sldIdLst'), 'sldId').map(s => presRels.get(rid(s, 'id'))).filter(r => r && r.type === 'slide').map(r => r.target);
    const defaultText = at(root, 'defaultTextStyle');
    const slides = []; const families = new Set(); const stats = { slides: 0, blocks: 0, pictures: 0, missingPictures: 0, tables: 0, charts: 0 };
    const limit = Math.min(slideIds.length, opts.max || 120);
    for (let i = 0; i < limit; i++) {
      const s = await slide(pkg, slideIds[i], { S, W, H, defaultText, families, stats, addImage: opts.addImage, layoutMode: opts.layout || 'auto' });
      if (s) { s.index = i; slides.push(s); stats.slides++; }
      if (opts.onProgress) opts.onProgress(i + 1, slideIds.length);
    }
    return { slides, W, H, families: [...families], stats, total: slideIds.length };
  }
  async function partInfo(pkg, part) { const doc = await pkg.xml(part); const rels = await pkg.rels(part); return { part, doc, rels, root: doc && doc.documentElement }; }
  async function slide(pkg, slidePart, g) {
    const sl = await partInfo(pkg, slidePart); if (!sl.root) return null;
    if (sl.root.getAttribute('show') === '0') return null; // hidden slide
    const layoutRel = [...sl.rels.values()].find(r => r.type === 'slideLayout'); const lay = layoutRel ? await partInfo(pkg, layoutRel.target) : null;
    const masterRel = lay && [...lay.rels.values()].find(r => r.type === 'slideMaster'); const mas = masterRel ? await partInfo(pkg, masterRel.target) : null;
    const themeRel = mas && [...mas.rels.values()].find(r => r.type === 'theme'); const themeDoc = themeRel ? await pkg.xml(themeRel.target) : null;
    const theme = themeOf(themeDoc);
    let clrMap = {}; const cm = mas && at(mas.root, 'clrMap'); if (cm) for (const a of cm.attributes) clrMap[a.name] = a.value;
    for (const part of [lay, sl]) { const ov = part && at(part.root, 'clrMapOvr', 'overrideClrMapping'); if (ov) { clrMap = {}; for (const a of ov.attributes) clrMap[a.name] = a.value; } }
    const ctx = { ...g, theme, clrMap, pkg, sl, lay, mas, blocks: [] };
    g.families.add(theme.major); g.families.add(theme.minor);
    // background: slide, else layout, else master
    let bg = null; for (const part of [sl, lay, mas]) { if (!part || !part.root) continue; const b = bgOf(at(part.root, 'cSld', 'bg'), ctx); if (b) { bg = { ...b, part }; break; } }
    const out = ctx.blocks;
    if (bg && bg.embed) { const img = await picture(bg.part, bg.embed, bg.srcRect, ctx); if (img) out.push({ id: uid(), kind: 'image', x: 0, y: 0, w: g.W, h: g.H, asset: img.id, focal: 'xMidYMid', fit: 'cover', radius: 0, decorative: true, path: 'image_bg', label: 'background' }); }
    // master and layout artwork (not their placeholders), then the slide
    const showMaster = sl.root.getAttribute('showMasterSp') !== '0' && (!lay || lay.root.getAttribute('showMasterSp') !== '0');
    const xf0 = { sx: g.S / EMU, sy: g.S / EMU, ox: 0, oy: 0 };
    if (showMaster && mas) await tree(at(mas.root, 'cSld', 'spTree'), { ...ctx, part: mas, level: 'master' }, xf0, null);
    if (sl.root.getAttribute('showMasterSp') !== '0' && lay) await tree(at(lay.root, 'cSld', 'spTree'), { ...ctx, part: lay, level: 'layout' }, xf0, null);
    await tree(at(sl.root, 'cSld', 'spTree'), { ...ctx, part: sl, level: 'slide' }, xf0, null);
    g.stats.blocks += out.length;
    const titleB = out.find(b => b.role === 'headline' && b.kind === 'text');
    return { name: (titleB ? Canvas.sourceText(titleB).split('\n')[0].slice(0, 50) : '') || `Slide`, w: g.W, h: g.H, bg: bg && bg.color ? bg.color.hex : '#FFFFFF', bgGradient: bg && bg.grad ? bg.grad : null, blocks: out };
  }
  function themeOf(doc) {
    const scheme = {}; const cs = doc && doc.getElementsByTagNameNS(A, 'clrScheme')[0];
    if (cs) for (const c of cs.children) { const v = c.firstElementChild; if (!v) continue; scheme[c.localName] = v.localName === 'srgbClr' ? v.getAttribute('val') : v.localName === 'sysClr' ? (v.getAttribute('lastClr') || (v.getAttribute('val') === 'window' ? 'FFFFFF' : '000000')) : '000000'; }
    const fs = doc && doc.getElementsByTagNameNS(A, 'fontScheme')[0];
    return { scheme, major: attr(at(fs, 'majorFont', 'latin'), 'typeface') || 'Calibri Light', minor: attr(at(fs, 'minorFont', 'latin'), 'typeface') || 'Calibri' };
  }
  function bgOf(bgEl, ctx) {
    if (!bgEl) return null;
    const pr = one(bgEl, 'bgPr'); if (pr) { const f = fillOf(pr, ctx); if (f && !f.none) return f; return null; }
    const ref = one(bgEl, 'bgRef'); if (ref) { const c = colorOf(colorChild(ref), ctx); return c ? { color: c } : null; }
    return null;
  }
  // Placeholders on a slide take position and text styles from the layout's and master's placeholder of the same idx/type.
  function phOf(sp) { const ph = at(sp, 'nvSpPr', 'nvPr', 'ph') || at(sp, 'nvPicPr', 'nvPr', 'ph'); return ph ? { type: attr(ph, 'type', 'body'), idx: attr(ph, 'idx') } : null; }
  function findPh(part, info) {
    if (!part || !part.root || !info) return null;
    const sps = [...part.root.getElementsByTagNameNS(P, 'sp')];
    const titleish = t => t === 'title' || t === 'ctrTitle';
    let hit = info.idx != null ? sps.find(s => { const p = phOf(s); return p && p.idx === info.idx; }) : null;
    if (!hit) hit = sps.find(s => { const p = phOf(s); return p && (p.type === info.type || (titleish(p.type) && titleish(info.type))); });
    if (!hit && info.type !== 'title' && info.type !== 'ctrTitle') hit = sps.find(s => { const p = phOf(s); return p && p.type === 'body'; });
    return hit || null;
  }
  async function tree(spTree, ctx, xf, parentId) {
    if (!spTree) return;
    for (const el of spTree.children) {
      if (ctx.blocks.length > 1500) return;
      const ln = el.localName;
      if (ln === 'sp') await shape(el, ctx, xf, parentId);
      else if (ln === 'pic') await pic(el, ctx, xf, parentId);
      else if (ln === 'grpSp') await group(el, ctx, xf, parentId);
      else if (ln === 'cxnSp') connector(el, ctx, xf, parentId);
      else if (ln === 'graphicFrame') await frameEl(el, ctx, xf, parentId);
      else if (ln === 'AlternateContent') { const choice = one(el, 'Fallback') || one(el, 'Choice'); if (choice) await tree(choice, ctx, xf, parentId); }
    }
  }
  function boxOf(xfrm, xf) {
    const off = one(xfrm, 'off'), ext = one(xfrm, 'ext'); if (!off || !ext) return null;
    const x = num(off.getAttribute('x')), y = num(off.getAttribute('y')), w = num(ext.getAttribute('cx')), h = num(ext.getAttribute('cy'));
    return { x: r2(x * xf.sx + xf.ox), y: r2(y * xf.sy + xf.oy), w: r2(Math.max(0, w * xf.sx)), h: r2(Math.max(0, h * xf.sy)), rot: num(xfrm.getAttribute('rot')) / 60000, flipH: xfrm.getAttribute('flipH') === '1', flipV: xfrm.getAttribute('flipV') === '1' };
  }
  const hidden = el => { const c = el.querySelector(':scope > *:first-child > *:first-child'); return c && c.localName === 'cNvPr' && c.getAttribute('hidden') === '1'; };
  const nameOf = el => { const c = el.querySelector(':scope > *:first-child > *:first-child'); return c && c.localName === 'cNvPr' ? String(c.getAttribute('name') || '').slice(0, 60) : ''; };
  async function group(el, ctx, xf, parentId) {
    if (hidden(el)) return;
    const gx = at(el, 'grpSpPr', 'xfrm'); if (!gx) { await tree(el, ctx, xf, parentId); return; }
    const off = one(gx, 'off'), ext = one(gx, 'ext'), cOff = one(gx, 'chOff'), cExt = one(gx, 'chExt');
    const kx = cExt && num(cExt.getAttribute('cx')) ? num(attr(ext, 'cx')) / num(cExt.getAttribute('cx')) : 1, ky = cExt && num(cExt.getAttribute('cy')) ? num(attr(ext, 'cy')) / num(cExt.getAttribute('cy')) : 1;
    const nxf = { sx: xf.sx * kx, sy: xf.sy * ky, ox: xf.sx * (num(attr(off, 'x')) - num(attr(cOff, 'x')) * kx) + xf.ox, oy: xf.sy * (num(attr(off, 'y')) - num(attr(cOff, 'y')) * ky) + xf.oy };
    const b = boxOf(gx, xf);
    const box = { id: uid(), kind: 'box', x: b.x, y: b.y, w: Math.max(1, b.w), h: Math.max(1, b.h), fill: 'none', radius: 0, clip: false, decorative: true, label: nameOf(el) || 'group' };
    if (parentId) box.parent = parentId;
    ctx.blocks.push(box);
    const gf = fillOf(at(el, 'grpSpPr'), ctx);
    await tree(el, { ...ctx, grpFill: gf && !gf.none ? gf : ctx.grpFill }, nxf, box.id);
  }
  async function picture(part, embed, srcRect, ctx) {
    const rel = embed && part.rels.get(embed); if (!rel || rel.external) { ctx.stats.missingPictures++; return null; }
    const ext = rel.target.split('.').pop().toLowerCase(); const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml' }[ext];
    if (!mime) { ctx.stats.missingPictures++; return null; }
    const bytes = await ctx.pkg.raw(rel.target); if (!bytes) { ctx.stats.missingPictures++; return null; }
    let dataUrl = `data:${mime};base64,${b64(bytes)}`;
    const l = num(attr(srcRect, 'l')), t = num(attr(srcRect, 't')), r = num(attr(srcRect, 'r')), bb = num(attr(srcRect, 'b'));
    if (srcRect && (l || t || r || bb) && mime !== 'image/svg+xml') { try { dataUrl = await cropUrl(dataUrl, l / 100000, t / 100000, r / 100000, bb / 100000); } catch { } }
    try { const a = await ctx.addImage(dataUrl, rel.target.split('/').pop()); ctx.stats.pictures++; return a; } catch { ctx.stats.missingPictures++; return null; }
  }
  function b64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
  async function cropUrl(src, l, t, r, b) {
    const img = new Image(); await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
    const W = img.naturalWidth, H = img.naturalHeight; const sx = W * Math.max(0, l), sy = H * Math.max(0, t), sw = W * (1 - Math.max(0, l) - Math.max(0, r)), sh = H * (1 - Math.max(0, t) - Math.max(0, b));
    if (sw < 2 || sh < 2) return src;
    const c = document.createElement('canvas'); c.width = Math.round(sw); c.height = Math.round(sh); c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height); return c.toDataURL('image/png');
  }
  async function pic(el, ctx, xf, parentId) {
    if (hidden(el)) return;
    const info = phOf(el); const inh = info ? [findPh(ctx.lay, info), findPh(ctx.mas, info)] : [];
    const xfrm = at(el, 'spPr', 'xfrm') || inh.map(s => s && at(s, 'spPr', 'xfrm')).find(Boolean); if (!xfrm) return;
    const b = boxOf(xfrm, xf); if (!b || b.w < 1 || b.h < 1) return;
    const bf = at(el, 'blipFill'); const a = await picture(ctx.part, rid(at(bf, 'blip'), 'embed'), at(bf, 'srcRect'), ctx);
    const geom = attr(at(el, 'spPr', 'prstGeom'), 'prst');
    const blk = { id: uid(), kind: 'image', x: b.x, y: b.y, w: b.w, h: b.h, asset: a ? a.id : null, focal: 'xMidYMid', fit: 'cover', radius: geom === 'ellipse' ? Math.min(b.w, b.h) / 2 : geom === 'roundRect' ? Math.min(b.w, b.h) * 0.1 : 0, decorative: ctx.level !== 'slide', path: 'image_' + uid(), placeholder: '#D9D7E2', label: nameOf(el) || 'picture' };
    if (b.rot) blk.rotation = r2(b.rot); if (parentId) blk.parent = parentId;
    const lnp = lineOf(at(el, 'spPr'), ctx); if (lnp && !lnp.none && lnp.color) blk.stroke = { color: lnp.color, width: r2(lnp.width * ctx.S) };
    ctx.blocks.push(blk);
  }
  function connector(el, ctx, xf, parentId) {
    if (hidden(el)) return;
    const xfrm = at(el, 'spPr', 'xfrm'); if (!xfrm) return; const b = boxOf(xfrm, xf); if (!b) return;
    const st = styleRef(el, 'lnRef', ctx); const lnp = lineOf(at(el, 'spPr'), ctx, st && st.color) || (st && st.color ? { color: st.color.hex, width: 1 } : null);
    if (!lnp || lnp.none) return; const color = lnp.color || (st && st.color ? st.color.hex : '#000000'); const w = Math.max(1, lnp.width * ctx.S);
    let blk;
    if (b.h < 1 || b.w < 1) blk = { id: uid(), kind: 'line', x: b.x, y: b.y, w: Math.max(1, b.w), h: 0, fill: color, width: r2(w), decorative: true, label: nameOf(el) || 'line' };
    else { const [x1, y1, x2, y2] = [b.flipH ? b.w : 0, b.flipV ? b.h : 0, b.flipH ? 0 : b.w, b.flipV ? 0 : b.h]; blk = { id: uid(), kind: 'vector', x: b.x, y: b.y, w: b.w, h: b.h, viewBox: [0, 0, b.w, b.h], svg: `<path d="M${r2(x1)} ${r2(y1)}L${r2(x2)} ${r2(y2)}" fill="none" stroke="${color}" stroke-width="${r2(w)}"/>`, fill: color, decorative: true, label: nameOf(el) || 'line' }; }
    if (parentId) blk.parent = parentId; ctx.blocks.push(blk);
  }
  // Preset geometry -> the closest block. Unknown presets become rectangles of the same box.
  async function shape(el, ctx, xf, parentId) {
    if (hidden(el)) return;
    const info = phOf(el);
    if (info && ctx.level !== 'slide') return; // layout and master placeholders only lend styles and positions
    const lph = info ? findPh(ctx.lay, info) : null, mph = info ? findPh(ctx.mas, info) : null;
    const spPr = at(el, 'spPr');
    const xfrm = at(spPr, 'xfrm') || (lph && at(lph, 'spPr', 'xfrm')) || (mph && at(mph, 'spPr', 'xfrm')); if (!xfrm) return;
    const b = boxOf(xfrm, xf); if (!b || (b.w < 0.5 && b.h < 0.5)) return;
    const prst = attr(at(spPr, 'prstGeom'), 'prst') || (lph && attr(at(lph, 'spPr', 'prstGeom'), 'prst')) || (at(spPr, 'custGeom') ? 'cust' : 'rect');
    const sfill = styleRef(el, 'fillRef', ctx), sline = styleRef(el, 'lnRef', ctx);
    let fill = fillOf(spPr, ctx, sfill && sfill.color) || (lph && fillOf(at(lph, 'spPr'), ctx)) || (mph && fillOf(at(mph, 'spPr'), ctx)) || (sfill && sfill.color ? { color: sfill.color } : null);
    let line = lineOf(spPr, ctx, sline && sline.color) || (sline && sline.color ? { color: sline.color.hex, width: 1 } : null);
    if (fill && fill.none) fill = null; if (line && (line.none || !line.color)) line = null;
    const txBody = at(el, 'txBody'); const paras = txBody ? ch(txBody, 'p') : [];
    const hasText = paras.some(p => ch(p, 'r').some(r => (at(r, 't') || {}).textContent) || ch(p, 'fld').some(r => (at(r, 't') || {}).textContent));
    if (info && !hasText && !fill && !line) return; // an empty placeholder: nothing shows on the slide
    const label = nameOf(el);
    const adj = (() => { const gd = at(spPr, 'prstGeom', 'avLst'); const g0 = gd && ch(gd, 'gd')[0]; const f = g0 && /val (\d+)/.exec(g0.getAttribute('fmla') || ''); return f ? +f[1] : 16667; })();
    const radius = prst === 'roundRect' ? r2(Math.min(b.w, b.h) * adj / 100000) : 0;
    const visualKinds = { ellipse: 'ellipse', roundRect: 'rect', rect: 'rect', snipRoundRect: 'rect', round2SameRect: 'rect', flowChartProcess: 'rect', flowChartAlternateProcess: 'rect', cust: 'cust' };
    const vk = visualKinds[prst] || (/line|Connector/.test(prst) ? 'line' : 'other');
    const paint = (blk) => { if (fill && fill.grad) { blk.gradient = fill.grad; blk.fill = fill.grad.stops[0].c; } else if (fill && fill.color) { blk.fill = fill.color.hex; if (fill.color.a < 0.999) blk.fillAlpha = r2(fill.color.a); } if (line) blk.stroke = { color: line.color, width: r2(Math.max(0.5, line.width * ctx.S)) }; if (b.rot) blk.rotation = r2(b.rot); return blk; };
    let visual = null;
    if (fill && fill.embed) { const a = await picture(ctx.part, fill.embed, fill.srcRect, ctx); visual = { id: uid(), kind: 'image', x: b.x, y: b.y, w: b.w, h: b.h, asset: a ? a.id : null, focal: 'xMidYMid', fit: 'cover', radius, decorative: true, path: 'image_' + uid(), label: label || 'picture' }; fill = null; }
    else if (vk === 'line') { if (line) visual = { id: uid(), kind: 'line', x: b.x, y: b.y, w: Math.max(1, b.w), h: 0, fill: line.color, width: r2(Math.max(1, line.width * ctx.S)), decorative: true, label: label || 'line' }; }
    else if (vk === 'ellipse') { if (fill || line) visual = paint({ id: uid(), kind: 'shape', shape: Math.abs(b.w - b.h) < 1 ? 'circle' : 'ellipse', x: b.x, y: b.y, w: b.w, h: b.h, fill: 'none', decorative: true, label: label || 'ellipse' }); }
    else if (vk === 'cust') { const d = custPath(at(spPr, 'custGeom'), b); if (d && (fill || line)) visual = { id: uid(), kind: 'vector', x: b.x, y: b.y, w: Math.max(1, b.w), h: Math.max(1, b.h), viewBox: [0, 0, Math.max(1, b.w), Math.max(1, b.h)], svg: `<path d="${d}" fill="${fill && fill.color ? fill.color.hex : 'none'}"${fill && fill.color && fill.color.a < 1 ? ` fill-opacity="${r2(fill.color.a)}"` : ''}${line ? ` stroke="${line.color}" stroke-width="${r2(line.width * ctx.S)}"` : ''}/>`, fill: fill && fill.color ? fill.color.hex : '#000000', decorative: true, label: label || 'shape' }; }
    else if (vk === 'other' && (fill || line) && !hasText) visual = paint({ id: uid(), kind: 'field', x: b.x, y: b.y, w: b.w, h: b.h, fill: '#FFFFFF', radius, decorative: true, label: label || prst });
    if (!hasText) { if (visual) { if (parentId) visual.parent = parentId; ctx.blocks.push(visual); } else if (vk === 'rect' && (fill || line)) { const f = paint({ id: uid(), kind: 'field', x: b.x, y: b.y, w: b.w, h: b.h, fill: '#FFFFFF', radius, decorative: true, label: label || 'rectangle' }); if (!fill) f.alpha = 0; if (parentId) f.parent = parentId; ctx.blocks.push(f); } return; }
    // A text box: a stack with the shape's fill (rectangles) holding one text block per run of same-styled paragraphs.
    const rectLike = vk === 'rect' || vk === 'other';
    if (visual && !rectLike) { if (parentId) visual.parent = parentId; ctx.blocks.push(visual); }
    const bodyPr = at(txBody, 'bodyPr'); const lbp = lph && at(lph, 'txBody', 'bodyPr'), mbp = mph && at(mph, 'txBody', 'bodyPr');
    const bp = n => firstAttr([bodyPr, lbp, mbp], n);
    const ins = k => num(bp(k), k === 'tIns' || k === 'bIns' ? 45720 : 91440) * ctx.S / EMU;
    const anchor = bp('anchor') || 't';
    const autofit = bodyPr && (one(bodyPr, 'spAutoFit') ? 'grow' : one(bodyPr, 'normAutofit') ? 'shrink' : null);
    const fontScale = autofit === 'shrink' ? num(attr(one(bodyPr, 'normAutofit'), 'fontScale'), 100000) / 100000 : 1;
    const box = paint({ id: uid(), kind: 'box', x: b.x, y: b.y, w: Math.max(1, b.w), h: Math.max(1, b.h), fill: 'none', radius, clip: false, decorative: true, label: label || (info ? info.type : 'text box'),
      auto: { v: 2, mode: 'vertical', wrap: false, gap: 0, gapAuto: false, counterGap: 0, counterGapAuto: false, pad: { t: r2(ins('tIns')), r: r2(ins('rIns')), b: r2(ins('bIns')), l: r2(ins('lIns')) }, main: anchor === 'ctr' ? 'center' : anchor === 'b' ? 'end' : 'start', cross: 'start' }, sizeW: 'fixed', sizeH: autofit === 'grow' ? 'hug' : 'fixed' });
    if (!rectLike || !visual) { if (!fill || !rectLike) { box.fill = 'none'; delete box.gradient; delete box.fillAlpha; } if (!rectLike) delete box.stroke; }
    if (b.rot) box.rotation = r2(b.rot);
    if (parentId) box.parent = parentId;
    ctx.blocks.push(box);
    const kind = info ? (info.type === 'title' || info.type === 'ctrTitle' ? 'title' : /^(body|subTitle|obj)$/.test(info.type) ? 'body' : 'other') : 'other';
    const txStyles = ctx.mas && at(ctx.mas.root, 'txStyles');
    const masterStyle = txStyles ? one(txStyles, kind === 'title' ? 'titleStyle' : kind === 'body' ? 'bodyStyle' : 'otherStyle') : null;
    const chain = [at(txBody, 'lstStyle'), lph && at(lph, 'txBody', 'lstStyle'), mph && at(mph, 'txBody', 'lstStyle'), masterStyle, ctx.defaultText];
    const groups = paragraphsOf(paras, chain, ctx, fontScale, kind);
    for (const gp of groups) {
      const blk = gp.bullet
        ? { id: uid(), kind: 'list', role: 'list', path: 'list_' + uid(), items: gp.lines, marker: gp.bullet === 'num' ? 'number' : 'bullet', x: box.x, y: box.y, w: Math.max(8, box.w - box.auto.pad.l - box.auto.pad.r), h: gp.size * 1.3, font: gp.font, fill: gp.color, decorative: false, parent: box.id, sizeW: 'fill', sizeH: 'hug' }
        : { id: uid(), kind: 'text', role: kind === 'title' ? 'headline' : kind === 'body' ? 'body' : 'text', path: 'text_' + uid(), text: gp.lines.join('\n'), align: gp.align, x: box.x, y: box.y, w: Math.max(8, box.w - box.auto.pad.l - box.auto.pad.r), h: gp.size * 1.3, font: gp.font, fill: gp.color, decorative: false, parent: box.id, sizeW: 'fill', sizeH: 'hug' };
      if (gp.decoration) blk.decoration = gp.decoration; if (gp.alpha < 0.999) blk.opacity = r2(gp.alpha);
      Canvas.refit(blk); ctx.blocks.push(blk);
      ctx.families.add(gp.family);
    }
    if (groups.length > 1) box.auto.gap = r2(Math.max(0, Math.min(...groups.slice(1).map(gp => gp.spaceBefore))));
  }
  // Paragraphs -> groups of consecutive lines that share a style (one text or list block each).
  function paragraphsOf(paras, chain, ctx, fontScale, kind) {
    const groups = []; let pendingSpace = 0;
    for (const p of paras) {
      const pPr = at(p, 'pPr'); const lvl = num(attr(pPr, 'lvl'), 0); const L = lvlOf(chain, lvl);
      const runs = [...p.children].filter(c => c.localName === 'r' || c.localName === 'fld' || c.localName === 'br');
      let text = ''; const weights = new Map();
      const endR = at(p, 'endParaRPr');
      for (const r of runs) {
        if (r.localName === 'br') { text += '\n'; continue; }
        const t = (at(r, 't') || {}).textContent || ''; text += t;
        const rPr = at(r, 'rPr'); const key = rPr ? new XMLSerializer().serializeToString(rPr) : ''; weights.set(key, (weights.get(key) || 0) + t.length + 1);
        if (!weights.has('el:' + key)) weights.set('el:' + key, rPr);
      }
      const domKey = [...weights.entries()].filter(([k]) => !k.startsWith('el:')).sort((a, b) => b[1] - a[1])[0];
      const rPr = domKey ? weights.get('el:' + domKey[0]) : endR;
      const rprs = [rPr, ...(pPr ? [one(pPr, 'defRPr')] : []), ...L.rpr].filter(Boolean);
      const sz = num(firstAttr(rprs, 'sz'), kind === 'title' ? 4400 : 1800) / 100 * fontScale;
      const size = r2(sz * 96 / 72 * ctx.S);
      const bold = firstAttr(rprs, 'b') === '1' || firstAttr(rprs, 'b') === 'true';
      const italic = firstAttr(rprs, 'i') === '1';
      const cap = firstAttr(rprs, 'cap');
      const fam = fontName(attr(firstChild(rprs, 'latin'), 'typeface'), ctx) || (kind === 'title' ? ctx.theme.major : ctx.theme.minor);
      const fillEl = firstChild(rprs, 'solidFill'); const col = fillEl ? colorOf(colorChild(fillEl), ctx) : colorOf({ localName: 'schemeClr', getAttribute: () => 'tx1', children: [] }, ctx);
      const pprs = [pPr, ...L.ppr].filter(Boolean);
      const algn = firstAttr(pprs, 'algn'); const align = algn === 'ctr' ? 'center' : algn === 'r' ? 'right' : 'left';
      const buNone = firstChild(pprs, 'buNone'), buChar = firstChild(pprs, 'buChar'), buNum = firstChild(pprs, 'buAutoNum');
      const firstBu = pprs.find(e => one(e, 'buNone') || one(e, 'buChar') || one(e, 'buAutoNum')); const bullet = firstBu ? (one(firstBu, 'buAutoNum') ? 'num' : one(firstBu, 'buChar') ? 'char' : null) : null;
      const lnPct = (() => { const l = firstChild(pprs, 'lnSpc'); const pct = l && one(l, 'spcPct'); const pts = l && one(l, 'spcPts'); if (pct) return num(pct.getAttribute('val'), 100000) / 100000; if (pts) return (num(pts.getAttribute('val')) / 100) / Math.max(1, sz) / 1.2; return 1; })();
      const spc = name => { const s = firstChild(pprs, name); const pts = s && one(s, 'spcPts'), pct = s && one(s, 'spcPct'); if (pts) return num(pts.getAttribute('val')) / 100 * 96 / 72 * ctx.S; if (pct) return num(pct.getAttribute('val')) / 100000 * size; return 0; };
      if (!text.replace(/\s/g, '')) { pendingSpace += size * 1.2 * lnPct + spc('spcBef') + spc('spcAft'); continue; }
      const font = { family: fontCss(fam), size, weight: bold ? 700 : 400, lineHeight: r2(Math.max(0.8, 1.2 * lnPct * (1 - (fontScale < 1 ? 0.1 : 0)))), letterSpacing: r2(num(firstAttr(rprs, 'spc')) / 100 / Math.max(1, sz)) };
      if (italic) font.style = 'italic'; if (cap === 'all') font.transform = 'upper';
      const u = firstAttr(rprs, 'u'); const strike = firstAttr(rprs, 'strike');
      const sig = JSON.stringify([font, col && col.hex, align, !!bullet, lvl]);
      const last = groups[groups.length - 1];
      const before = spc('spcBef') + pendingSpace; pendingSpace = 0;
      if (last && last.sig === sig) { last.lines.push(text.replace(/\n+$/, '')); last.spaceAfter = spc('spcAft'); }
      else groups.push({ sig, lines: [text.replace(/\n+$/, '')], font, color: col ? col.hex : '#000000', alpha: col ? col.a : 1, align, bullet: bullet === 'num' ? 'num' : bullet ? 'char' : null, size, family: fam, decoration: u && u !== 'none' ? 'underline' : strike && strike !== 'noStrike' ? 'line-through' : null, spaceBefore: (last ? last.spaceAfter || 0 : 0) + before, spaceAfter: spc('spcAft') });
    }
    return groups;
  }
  // custGeom path list -> SVG path in the block's own box.
  function custPath(cg, b) {
    const list = at(cg, 'pathLst'); if (!list) return null; const parts = [];
    for (const p of ch(list, 'path')) {
      const pw = num(p.getAttribute('w'), 0) || 1, ph = num(p.getAttribute('h'), 0) || 1; const sx = b.w / pw, sy = b.h / ph;
      const pt = e => `${r2(num(e.getAttribute('x')) * sx)} ${r2(num(e.getAttribute('y')) * sy)}`;
      for (const c of p.children) {
        const pts = ch(c, 'pt');
        if (c.localName === 'moveTo' && pts[0]) parts.push('M' + pt(pts[0]));
        else if (c.localName === 'lnTo' && pts[0]) parts.push('L' + pt(pts[0]));
        else if (c.localName === 'cubicBezTo' && pts.length === 3) parts.push('C' + pts.map(pt).join(' '));
        else if (c.localName === 'quadBezTo' && pts.length === 2) parts.push('Q' + pts.map(pt).join(' '));
        else if (c.localName === 'close') parts.push('Z');
      }
    }
    return parts.join('');
  }
  // Tables become stacks: rows of cells with their fills and text; charts and other objects become a labeled placeholder.
  async function frameEl(el, ctx, xf, parentId) {
    if (hidden(el)) return;
    const xfrm = at(el, 'xfrm'); if (!xfrm) return; const b = boxOf(xfrm, xf); if (!b) return;
    const gd = at(el, 'graphic', 'graphicData'); const uri = attr(gd, 'uri') || '';
    const tbl = gd && one(gd, 'tbl');
    if (!tbl) {
      if (/chart/.test(uri)) ctx.stats.charts++;
      const blk = { id: uid(), kind: 'image', x: b.x, y: b.y, w: Math.max(1, b.w), h: Math.max(1, b.h), asset: null, focal: 'xMidYMid', radius: 0, decorative: false, path: 'image_' + uid(), placeholder: '#E6E4EE', label: /chart/.test(uri) ? 'chart (not imported)' : /diagram/.test(uri) ? 'diagram (not imported)' : 'object' };
      if (parentId) blk.parent = parentId; ctx.blocks.push(blk); return;
    }
    ctx.stats.tables++;
    const cols = ch(at(tbl, 'tblGrid'), 'gridCol').map(c => num(c.getAttribute('w')) * xf.sx);
    const table = { id: uid(), kind: 'box', x: b.x, y: b.y, w: Math.max(1, b.w), h: Math.max(1, b.h), fill: 'none', radius: 0, clip: false, decorative: true, label: nameOf(el) || 'table', auto: { v: 2, mode: 'vertical', wrap: false, gap: 0, gapAuto: false, counterGap: 0, counterGapAuto: false, pad: { t: 0, r: 0, b: 0, l: 0 }, main: 'start', cross: 'start' }, sizeW: 'hug', sizeH: 'hug' };
    if (parentId) table.parent = parentId; ctx.blocks.push(table);
    const txStyles = ctx.mas && at(ctx.mas.root, 'txStyles');
    for (const tr of ch(tbl, 'tr')) {
      const rh = num(tr.getAttribute('h')) * xf.sy;
      const row = { id: uid(), kind: 'box', parent: table.id, x: b.x, y: b.y, w: b.w, h: Math.max(1, rh), fill: 'none', radius: 0, clip: false, decorative: true, label: 'row', auto: { v: 2, mode: 'horizontal', wrap: false, gap: 0, gapAuto: false, counterGap: 0, counterGapAuto: false, pad: { t: 0, r: 0, b: 0, l: 0 }, main: 'start', cross: 'start' }, sizeW: 'hug', sizeH: 'hug' };
      ctx.blocks.push(row);
      let ci = 0;
      for (const tc of ch(tr, 'tc')) {
        const span = num(tc.getAttribute('gridSpan'), 1); if (tc.getAttribute('hMerge') === '1' || tc.getAttribute('vMerge') === '1') { ci += span; continue; }
        const w = cols.slice(ci, ci + span).reduce((t, v) => t + v, 0) || 100; ci += span;
        const tcPr = at(tc, 'tcPr'); const f = fillOf(tcPr, ctx);
        const pad = k => num(attr(tcPr, k), k === 'marT' || k === 'marB' ? 45720 : 91440) * xf.sx;
        const cell = { id: uid(), kind: 'box', parent: row.id, x: b.x, y: b.y, w: Math.max(1, w), h: Math.max(1, rh), fill: f && f.color ? f.color.hex : 'none', radius: 0, clip: false, decorative: true, label: 'cell', auto: { v: 2, mode: 'vertical', wrap: false, gap: 0, gapAuto: false, counterGap: 0, counterGapAuto: false, pad: { t: r2(pad('marT')), r: r2(pad('marR')), b: r2(pad('marB')), l: r2(pad('marL')) }, main: attr(tcPr, 'anchor') === 'ctr' ? 'center' : attr(tcPr, 'anchor') === 'b' ? 'end' : 'start', cross: 'start' }, sizeW: 'fixed', sizeH: 'fill', minH: r2(rh) };
        const lnB = at(tcPr, 'lnB'); const bc = lnB && one(lnB, 'solidFill') ? colorOf(colorChild(one(lnB, 'solidFill')), ctx) : null; if (bc) cell.stroke = { color: bc.hex, width: r2(Math.max(0.5, num(lnB.getAttribute('w'), 12700) * xf.sx)) };
        ctx.blocks.push(cell);
        const groups = paragraphsOf(ch(at(tc, 'txBody'), 'p'), [at(tc, 'txBody', 'lstStyle'), txStyles ? one(txStyles, 'otherStyle') : null, ctx.defaultText], ctx, 1, 'other');
        for (const gp of groups) { const t = { id: uid(), kind: 'text', role: 'text', path: 'text_' + uid(), text: gp.lines.join('\n'), align: gp.align, parent: cell.id, x: b.x, y: b.y, w: Math.max(8, w - cell.auto.pad.l - cell.auto.pad.r), h: gp.size * 1.3, font: gp.font, fill: gp.color, decorative: false, sizeW: 'fill', sizeH: 'hug' }; Canvas.refit(t); ctx.blocks.push(t); ctx.families.add(gp.family); }
      }
    }
  }

  // ---- Into the canvas -----------------------------------------------------------------------------------------------
  // Slides -> laid-out frames for placeFrames. Fixed positions: lay out once with the stacks, then pin everything.
  function toFrames(res, kit, layoutChoice) {
    const cols = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(res.slides.length))));
    return res.slides.map((s, i) => {
      const items = FigmaImport.toLayouts([{ name: `${i + 1} · ${s.name}`, x: (i % cols) * (s.w + 160), y: Math.floor(i / cols) * (s.h + 200), w: s.w, h: s.h, bg: s.bg, bgGradient: s.bgGradient, clip: true, blocks: s.blocks }], kit)[0];
      items.layout.archetype = 'slides'; items.layout.archetypeLabel = 'Slide'; items.layout.meta = { source: 'pptx', slide: s.index + 1 };
      if (s.w === 1920 && s.h === 1080) items.layout.format = { id: 'slide', name: 'Slide', w: 1920, h: 1080 };
      const f = { id: 'tmp', autoLayout: Canvas.defaultAuto(), layout: items.layout }; f.autoLayout.mode = 'none';
      Auto.layout(f);
      if (layoutChoice === 'fixed') { Auto.flatten(f); Auto.layout(f); }
      return items;
    });
  }
  return { read, toFrames, _open: open };
})();
