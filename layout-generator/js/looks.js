/* Looks: one frame, three treatments. Original is the frame as it was; Wireframe strips it to grey boxes, placeholder
   images and one typeface; Rebrand keeps the structure and images and moves colors and type onto the brand kit.
   The original is kept in layout.meta.original the first time a frame leaves it, so switching is always lossless for
   the original; edits made inside Wireframe or Rebrand are replaced when you switch again. */
const Looks = (() => {
  const LOOKS = [['original', 'Original'], ['wireframe', 'Wireframe'], ['rebrand', 'Rebrand']];
  const norm = v => { try { return Color.normalize(v); } catch { return null; } };
  const lum = v => { const h = norm(v); return h ? Color.luminance(h) : 1; };
  function sat(v) { const h = norm(v); if (!h) return 0; const r = parseInt(h.slice(1, 3), 16) / 255, g = parseInt(h.slice(3, 5), 16) / 255, b = parseInt(h.slice(5, 7), 16) / 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); const l = (mx + mn) / 2; return mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1)); }
  const center = b => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  const inside = (p, b) => p.x >= b.x && p.y >= b.y && p.x <= b.x + b.w && p.y <= b.y + b.h;
  // The fill under a block: the last field, shape or image before it that contains its centre, else the page.
  function under(blocks, i, pageBg, fillOf) { const c = center(blocks[i]); for (let j = i - 1; j >= 0; j--) { const u = blocks[j]; if (u.hidden) continue; if (((u.kind === 'field' || (u.kind === 'box' && u.fill && u.fill !== 'none')) && (u.alpha ?? 1) > 0.3) || u.kind === 'shape' || u.kind === 'image') { if (inside(c, u)) return u.kind === 'image' ? 'image' : fillOf(u, j); } } return pageBg; }
  const isText = b => b.kind === 'text' || b.kind === 'list' || b.kind === 'button';

  function apply(frame, look, kit) {
    const L = frame.layout; L.meta = L.meta || {};
    const cur = L.meta.look || 'original';
    if (cur === look && L.meta.original) return false;
    // Leaving the original: keep it, including edits made to it so far.
    if (cur === 'original' || !L.meta.original) L.meta.original = { blocks: Canvas.clone(L.blocks), palette: Canvas.clone(L.palette) };
    const O = L.meta.original;
    if (look === 'original') { L.blocks = Canvas.clone(O.blocks); L.palette = Canvas.clone(O.palette); }
    else if (look === 'wireframe') wireframe(L, O);
    else if (look === 'rebrand') rebrand(L, O, kit);
    else return false;
    L.meta.look = look;
    for (const b of L.blocks) if (isText(b) && b.font) Canvas.refit(b);
    return true;
  }

  // ---- Wireframe ------------------------------------------------------------------------------------------------
  const WF = { page: '#FFFFFF', panel: '#F3F3F6', box: '#ECECF0', line: '#D3D3DA', ink: '#2B2B33', soft: '#8C8C98', solid: '#3A3A44', img: '#D8D8DE' };
  function wireframe(L, O) {
    const W = L.format.w, H = L.format.h; const src = Canvas.clone(O.blocks); const out = [];
    const fillOf = new Map();
    const inter = Brand.fontCss('Inter');
    src.forEach((b, i) => {
      delete b.gradient; delete b.shadow; delete b.fillToken; delete b.colorToken; if (b.opacity != null && b.opacity < 0.5) b.opacity = 0.5; else delete b.opacity;
      const area = (b.w * b.h) / (W * H);
      // a layer made here keeps its place in the tree (parent, stack position, sizing)
      const place = { parent: b.parent, absolute: b.absolute, sizeW: b.sizeW, sizeH: b.sizeH, rx: b.rx, ry: b.ry };
      if (b.kind === 'box') {
        if (b.fill && b.fill !== 'none') { const was = norm(b.fill); const chromatic = was && sat(was) > 0.35 && lum(was) < 0.75; b.fill = area > 0.3 ? WF.panel : (chromatic && area < 0.06) ? WF.solid : WF.box; if (area <= 0.3) b.stroke = { color: WF.line, width: 1 }; else delete b.stroke; delete b.fillAlpha; fillOf.set(i, b.fill); }
        else if (b.stroke) b.stroke = { color: WF.line, width: 1 };
        out.push(b);
      } else if (b.kind === 'field' || b.kind === 'rule') {
        const was = norm(b.fill); const chromatic = was && sat(was) > 0.35 && lum(was) < 0.75; const darkSmall = was && lum(was) < 0.25 && area < 0.08;
        if ((b.alpha ?? 1) < 0.15 && !b.stroke) { b.hidden = true; }
        else if (area > 0.3) { b.fill = WF.panel; delete b.stroke; }
        else if ((chromatic || darkSmall) && area < 0.06) { b.fill = WF.solid; delete b.stroke; }
        else { b.fill = WF.box; b.stroke = { color: WF.line, width: 1 }; }
        b.alpha = 1; fillOf.set(i, b.fill); out.push(b);
      } else if (b.kind === 'scrim') { b.hidden = true; out.push(b); }
      else if (b.kind === 'shape') { b.fill = WF.line; delete b.stroke; fillOf.set(i, b.fill); out.push(b); }
      else if (b.kind === 'image') {
        b.asset = null; b.placeholder = WF.img; b.stroke = { color: WF.line, width: 1 }; out.push(b); fillOf.set(i, WF.img);
        if (b.w > 72 && b.h > 48) out.push({ ...place, absolute: b.parent ? true : undefined, sizeW: undefined, sizeH: undefined, rx: undefined, ry: undefined, id: Canvas.uid(), kind: 'icon', name: Icons.has('image') ? 'image' : 'squares-four', x: Math.round(b.x + b.w / 2 - 16), y: Math.round(b.y + b.h / 2 - 16), w: 32, h: 32, fill: WF.soft, decorative: true, label: 'placeholder' });
      } else if (b.kind === 'vector') { out.push({ ...place, id: b.id, kind: 'field', x: b.x, y: b.y, w: b.w, h: b.h, radius: Math.min(6, Math.min(b.w, b.h) / 4), fill: WF.line, decorative: true, label: b.label, opacity: b.opacity }); }
      else if (b.kind === 'icon' || b.kind === 'badge') { b.fill = WF.soft; if (b.color) b.color = '#FFFFFF'; out.push(b); }
      else if (b.kind === 'logo') { b.fill = WF.ink; out.push(b); }
      else if (b.kind === 'line') { b.fill = WF.line; out.push(b); }
      else if (b.kind === 'button') { b.fill = WF.solid; b.color = '#FFFFFF'; if (b.font) b.font.family = inter; out.push(b); }
      else if (b.kind === 'text' || b.kind === 'list') {
        const bg = under(src, i, WF.page, (u, j) => fillOf.get(j) || WF.box);
        b.fill = bg === WF.solid ? '#FFFFFF' : (b.font && b.font.size < 15 ? WF.soft : WF.ink);
        if (b.font) { b.font.family = inter; b.font.style = undefined; delete b.font.style; if (b.font.weight > 700) b.font.weight = 700; if (b.font.weight < 400) b.font.weight = 400; }
        delete b.decoration; out.push(b);
      } else out.push(b);
    });
    L.blocks = out;
    L.palette = { ...L.palette, bg: WF.page, fg: WF.ink, accent: WF.solid, bgName: 'Wireframe' }; delete L.palette.bgGradient; delete L.palette.bgToken;
  }

  // ---- Rebrand -------------------------------------------------------------------------------------------------
  function rebrand(L, O, kit) {
    const C = kit.colors.map(c => ({ name: c.name, role: c.role, hex: norm(c.hex) })).filter(c => c.hex);
    const brandAll = C.map(c => c.hex);
    const chroma = C.filter(c => (c.role === 'core' || c.role === 'accent') && sat(c.hex) > 0.25);
    const neutrals = C.filter(c => !(sat(c.hex) > 0.25) || c.role === 'background' || c.role === 'neutral');
    const pageBg = norm(O.palette.bg) || '#FFFFFF'; const dark = lum(pageBg) < 0.35;
    const lightBgs = C.filter(c => c.role === 'background' && lum(c.hex) > 0.6).sort((a, b) => lum(b.hex) - lum(a.hex));
    const darkBgs = C.filter(c => (c.role === 'background' || c.role === 'core') && lum(c.hex) < 0.12).sort((a, b) => lum(a.hex) - lum(b.hex));
    const newPage = dark ? (darkBgs[0] || { hex: '#111111' }).hex : (lightBgs.find(c => sat(c.hex) < 0.2) || lightBgs[0] || { hex: '#FFFFFF' }).hex;
    // Chromatic colors on the page, most used first, take the brand's chromatic colors in order.
    const usage = new Map();
    const src = Canvas.clone(O.blocks);
    for (const b of src) { if (b.hidden) continue; const area = b.w * b.h; for (const v of [b.fill, b.color, ...(b.gradient ? b.gradient.stops.map(s => s.c) : [])]) { const h = norm(v); if (h && sat(h) > 0.3 && lum(h) > 0.03) usage.set(h, (usage.get(h) || 0) + (b.kind === 'text' ? area * 0.3 : area)); } }
    const order = [...usage.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
    const ranked = chroma.slice().sort((a, b) => (a.role === 'core' ? 0 : 1) - (b.role === 'core' ? 0 : 1));
    const chromaMap = new Map(order.map((h, i) => [h, ranked.length ? ranked[i % ranked.length].hex : h]));
    const ramp = [...new Set([newPage, ...neutrals.map(c => c.hex)])].sort((a, b) => lum(a) - lum(b));
    const nearestLum = h => ramp.reduce((best, c) => Math.abs(lum(c) - lum(h)) < Math.abs(lum(best) - lum(h)) ? c : best, ramp[0]);
    const mapColor = v => { const h = norm(v); if (!h) return v; if (h === pageBg) return newPage; if (chromaMap.has(h)) return chromaMap.get(h); return nearestLum(h); };
    const display = Brand.fontCss(kit.fonts.display), body = Brand.fontCss(kit.fonts.body);
    const dW = kit.fonts.displayWeight || 600;
    const fills = new Map(); const out = [];
    src.forEach((b, i) => {
      delete b.fillToken; delete b.colorToken;
      if (b.kind === 'box') { if (b.fill && b.fill !== 'none') b.fill = mapColor(b.fill); if (b.stroke) b.stroke.color = mapColor(b.stroke.color); if (b.gradient) b.gradient.stops.forEach(s => { s.c = mapColor(s.c); }); if (b.fill !== 'none') fills.set(i, b.fill); }
      else if (b.kind === 'field' || b.kind === 'shape' || b.kind === 'rule' || b.kind === 'line') { b.fill = mapColor(b.fill); if (b.stroke) b.stroke.color = mapColor(b.stroke.color); if (b.gradient) b.gradient.stops.forEach(s => { s.c = mapColor(s.c); }); fills.set(i, b.fill); }
      else if (b.kind === 'button') { b.fill = chromaMap.get(norm(b.fill)) || (ranked[0] || { hex: b.fill }).hex; b.color = Color.bestForeground(b.fill, brandAll, 4.5)[0]; if (b.font) b.font.family = body; fills.set(i, b.fill); }
      else if (b.kind === 'text' || b.kind === 'list') {
        const bgU = under(src, i, newPage, (u, j) => fills.get(j) || mapColor(u.fill));
        const was = norm(b.fill) || '#000000';
        if (bgU === 'image') b.fill = lum(was) > 0.5 ? (C.find(c => lum(c.hex) > 0.9) || { hex: '#FFFFFF' }).hex : (darkBgs[0] || { hex: '#111111' }).hex;
        else if (sat(was) > 0.3 && chromaMap.has(was) && Color.contrast(chromaMap.get(was), bgU) >= 3) b.fill = chromaMap.get(was);
        else b.fill = Color.bestForeground(bgU, brandAll, 4.5)[0];
        if (b.gradient) delete b.gradient;
        if (b.font) { const big = b.font.size >= 28 || (b.font.weight >= 600 && b.font.size >= 20); b.font.family = big ? display : body; if (big) b.font.weight = dW; else { const ws = Brand.fontWeights(kit.fonts.body); b.font.weight = ws.reduce((p, c) => Math.abs(c - b.font.weight) < Math.abs(p - b.font.weight) ? c : p, ws[0]); } delete b.font.style; }
      } else if (b.kind === 'icon' || b.kind === 'logo' || b.kind === 'badge') { b.fill = mapColor(b.fill); }
      out.push(b);
    });
    L.blocks = out;
    const fg = Color.bestForeground(newPage, brandAll, 4.5)[0];
    L.palette = { ...L.palette, bg: newPage, fg, accent: (ranked[0] || { hex: fg }).hex, bgName: (C.find(c => c.hex === newPage) || { name: 'Brand' }).name };
    delete L.palette.bgGradient; L.palette.bgToken = (C.find(c => c.hex === newPage) || {}).name;
  }
  return { LOOKS, apply };
})();
