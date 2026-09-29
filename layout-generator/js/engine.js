/* The engine: structured randomization.
   Every variation is built from (seed, intent, brand kit, assets, format). The model of chance only chooses
   among moves the rules allow: which cells a block spans, which approved color pair, which type step, which anchor.
   Anything that breaks a rule (overflowing text, text off the safe area, unreadable contrast) is rejected. */
const Engine = (() => {
  const H_LEVELS = [0.055, 0.07, 0.09, 0.115, 0.145, 0.18];
  const ARCHETYPES = ['type-led', 'split', 'full-bleed', 'poster', 'mosaic', 'color-block', 'editorial', 'stat'];
  const ARCH_LABEL = {
    'type-led': 'Type-led', 'split': 'Split', 'full-bleed': 'Full-bleed image', 'poster': 'Framed image',
    'mosaic': 'Mosaic', 'color-block': 'Color blocks', 'editorial': 'Editorial', 'stat': 'Statement stat',
  };

  const snap = (v, u) => Math.round(v / u) * u;
  const snapFont = (v, unit) => { const s = Math.max(2, unit / 4); return Math.max(10, Math.round(v / s) * s); };
  const inter = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const grow = (r, m) => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m });
  const area = r => Math.max(0, r.w) * Math.max(0, r.h);
  const nearestWeight = (name, w) => { const ws = Brand.fontWeights(name); return ws.reduce((b, x) => Math.abs(x - w) < Math.abs(b - w) ? x : b, ws[0]); };

  function typeSet(kit, g, level) {
    const minDim = Math.min(g.w, g.h);
    const disp = kit.fonts.display, body = kit.fonts.body;
    const tall = g.h / g.w;
    const bodySize = snapFont(minDim * (tall > 1.4 ? 0.028 : 0.024), g.unit);
    const dw = nearestWeight(disp, kit.fonts.displayWeight || 600);
    const bw = nearestWeight(body, kit.fonts.bodyWeight || 400);
    const bwMed = nearestWeight(body, 600);
    return {
      level,
      headline: { family: Brand.fontCss(disp), weight: dw, size: snapFont(minDim * H_LEVELS[level], g.unit), lineHeight: 1.0 + (5 - level) * 0.025, letterSpacing: kit.fonts.tracking ?? -0.02, transform: kit.fonts.headlineCase === 'upper' ? 'upper' : 'none' },
      subhead: { family: Brand.fontCss(body), weight: nearestWeight(body, 500), size: snapFont(bodySize * 1.3, g.unit), lineHeight: 1.3, letterSpacing: -0.005 },
      body:    { family: Brand.fontCss(body), weight: bw, size: bodySize, lineHeight: 1.42, letterSpacing: 0 },
      eyebrow: { family: Brand.fontCss(body), weight: bwMed, size: snapFont(bodySize * 0.82, g.unit), lineHeight: 1.2, letterSpacing: 0.1, transform: 'upper' },
      cta:     { family: Brand.fontCss(body), weight: bwMed, size: snapFont(bodySize * 1.0, g.unit), lineHeight: 1.2, letterSpacing: 0 },
      stat:    { family: Brand.fontCss(disp), weight: dw, size: snapFont(minDim * Math.min(0.4, H_LEVELS[level] * 2.4), g.unit), lineHeight: 0.92, letterSpacing: -0.045 },
      footer:  { family: Brand.fontCss(body), weight: nearestWeight(body, 500), size: snapFont(bodySize * 0.8, g.unit), lineHeight: 1.2, letterSpacing: 0.02 },
      wordmark:{ family: Brand.fontCss(disp), weight: nearestWeight(disp, 700), letterSpacing: -0.04 },
    };
  }

  // Logo aspect ratio (w/h) for any logo kind.
  function logoAspect(kit, ts) {
    const l = kit.logo;
    if (l.kind === 'svg' && l.svg) return l.svg.aspect || 3;
    if (l.kind === 'image' && l.aspect) return l.aspect;
    const w = Text.width(l.text || 'brand', { ...ts.wordmark, size: 100 });
    return w / 74; // cap-height box of a 100px wordmark is about 74px
  }

  // ---- Stack builder --------------------------------------------------------
  // items: [{kind:'text'|'button'|'rule'|'logo', role, text, font, fill, maxLines, gap, minSize}]
  function buildStack(items, region, align, valign, g) {
    const blocks = []; let total = 0;
    for (const it of items) {
      if (it.kind === 'button') {
        const tw = Text.width(it.text, it.font);
        const bw = Math.min(region.w, snap(tw + it.font.size * 2.6, g.unit));
        const bh = snap(it.font.size * 2.7, g.unit);
        if (tw + it.font.size * 1.2 > region.w) return null;
        blocks.push({ ...it, w: bw, h: bh }); total += bh; continue;
      }
      if (it.kind === 'rule') { const h = it.h || Math.max(2, g.unit / 4); blocks.push({ ...it, w: Math.min(region.w, it.w || snap(region.w * 0.25, g.unit)), h }); total += h; continue; }
      if (it.kind === 'logo') { const h = it.h; const w = Math.min(region.w, snap(h * it.aspect, g.unit)); blocks.push({ ...it, w, h }); total += h; continue; }
      const text = Text.transform(it.text, it.font.transform);
      const f = Text.fit(text, it.font, region.w, region.h, { minSize: it.minSize || Math.max(10, it.font.size * 0.62), step: Math.max(2, g.unit / 4), maxLines: it.maxLines || 12 });
      if (!f) return null;
      const lineW = Math.max(...f.lines.map(l => Text.width(l, { ...it.font, size: f.size })));
      blocks.push({ ...it, kind: 'text', lines: f.lines, font: { ...it.font, size: f.size }, h: snap(f.height, g.unit / 2) || f.height, w: region.w, inkW: Math.min(region.w, lineW) });
      total += blocks[blocks.length - 1].h;
    }
    for (let i = 0; i < blocks.length - 1; i++) total += blocks[i].gap || 0;
    if (total > region.h + 0.5) return null;
    let y = valign === 'top' ? region.y : valign === 'bottom' ? region.y + region.h - total : region.y + (region.h - total) / 2;
    y = Math.max(region.y, Math.min(region.y + region.h - total, snap(y, g.unit)));
    for (const b of blocks) {
      b.y = y; b.align = align; b.x = region.x;
      if (b.kind !== 'text') {
        if (align === 'center') b.x = snap(region.x + (region.w - b.w) / 2, 1);
        else if (align === 'right') b.x = region.x + region.w - b.w;
      }
      y += b.h + (b.gap || 0);
    }
    return { blocks, total, y0: blocks[0].y, y1: y - (blocks[blocks.length - 1].gap || 0) };
  }
  // Ink rect of a text stack (what other things must avoid).
  function inkRect(stack, region, align) {
    let x0 = region.x + region.w, x1 = region.x;
    for (const b of stack.blocks) {
      let w = b.kind === 'text' ? b.inkW : b.w, x;
      if (b.kind === 'text') x = align === 'center' ? region.x + (region.w - w) / 2 : align === 'right' ? region.x + region.w - w : region.x;
      else x = b.x;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x + w);
    }
    return { x: x0, y: stack.y0, w: x1 - x0, h: stack.y1 - stack.y0 };
  }

  // ---- Content selection ----------------------------------------------------
  function pickItems(ctx, opts = {}) {
    const { rng, ts, content, intent, pal, g } = ctx;
    const d = intent.density; const P = d === 'dense' ? [0.7, 0.9, 0.7, 0.8] : d === 'sparse' ? [0.25, 0.3, 0.05, 0.3] : [0.5, 0.6, 0.25, 0.55];
    const items = [];
    const gap = k => snap(k, g.unit);
    if (opts.logoInStack) items.push({ kind: 'logo', role: 'logo', h: opts.logoH, aspect: opts.logoAspect, fill: opts.logoColor, gap: gap(ts.headline.size * 0.6) });
    if (content.eyebrow && intent.includeEyebrow !== false && rng.chance(opts.eyebrow ?? P[0])) items.push({ kind: 'text', role: 'eyebrow', text: content.eyebrow, font: ts.eyebrow, fill: pal.accentText, maxLines: 1, gap: gap(ts.headline.size * 0.4) });
    if (opts.stat) items.push({ kind: 'text', role: 'stat', text: content.stat, font: ts.stat, fill: opts.statFill || pal.fg, maxLines: 1, gap: gap(ts.stat.size * 0.12), minSize: ts.stat.size * 0.5 });
    items.push({ kind: 'text', role: 'headline', text: content.headline, font: opts.headlineFont || ts.headline, fill: pal.fg, maxLines: opts.headlineMaxLines || (opts.stat ? 3 : 5), gap: gap(ts.subhead.size * 0.9) });
    if (content.subhead && intent.includeSubhead !== false && rng.chance(opts.subhead ?? P[1])) items.push({ kind: 'text', role: 'subhead', text: content.subhead, font: ts.subhead, fill: pal.fg2, maxLines: 4, gap: gap(ts.body.size * 0.9) });
    if (content.body && intent.includeBody !== false && rng.chance(opts.body ?? P[2])) items.push({ kind: 'text', role: 'body', text: content.body, font: ts.body, fill: pal.fg2, maxLines: 6, gap: gap(ts.body.size * 1.2) });
    if (content.cta && intent.includeCta !== false && rng.chance(opts.cta ?? P[3])) {
      const asButton = rng.chance(0.7);
      if (asButton) items.push({ kind: 'button', role: 'cta', text: content.cta, font: ts.cta, fill: pal.accent, color: pal.onAccent, radius: ctx.radius(ts.cta.size * 1.35) });
      else items.push({ kind: 'text', role: 'cta', text: content.cta + '  →', font: { ...ts.cta, weight: ts.eyebrow.weight }, fill: pal.accentText, maxLines: 1 });
    }
    // gap of last item is irrelevant
    return items;
  }

  // ---- Palette ----------------------------------------------------------------
  function choosePalette(ctx) {
    const { rng, kit, intent } = ctx;
    let pairs = Brand.pairs(kit);
    if (!pairs.length) return null;
    const hinted = intent.colorHints && intent.colorHints.length ? pairs.filter(p => intent.colorHints.includes(p.bg)) : [];
    let pool = hinted.length ? hinted : pairs;
    if (intent.dark > 0.5) { const d = pool.filter(p => p.dark); if (d.length) pool = d; }
    if (intent.dark < -0.5) { const l = pool.filter(p => !p.dark); if (l.length) pool = l; }
    const pair = rng.weighted(pool.map(p => ({ v: p, w: p.bgRole === 'background' ? (intent.loud > 0.6 ? 1 : 2) : (intent.loud > 0.4 ? 2.2 : 1) })));
    const fg = pair.fgs[0];
    const fgAlt = pair.fgs.length > 1 && rng.chance(0.3) ? pair.fgs[1] : fg;
    let accent = rng.pick(pair.accents);
    if (intent.colorHints && intent.colorHints.length) { const a = pair.accents.filter(x => intent.colorHints.includes(x) && x !== pair.bg); if (a.length) accent = rng.pick(a); }
    const onAccent = Color.contrast(accent, '#FFFFFF') >= Color.contrast(accent, '#000000') ? '#FFFFFF' : '#000000';
    const accentText = Color.contrast(pair.bg, accent) >= 4.5 ? accent : fg;
    const fields = pair.fields.filter(f => f !== accent);
    return { bg: pair.bg, bgName: pair.bgName, fg: fgAlt, fg2: Color.mix(fg, pair.bg, 0.12), accent, onAccent, accentText, fields: fields.length ? fields : pair.fields, dark: pair.dark, pair };
  }

  // ---- Logo placement -----------------------------------------------------------
  function placeLogo(ctx, avoid, prefer, ground) {
    const { g, kit, rng, ts, intent } = ctx;
    if (intent.includeLogo === false) return null;
    const minDim = Math.min(g.w, g.h);
    const h = snap(minDim * (0.03 + (intent.loud || 0.5) * 0.02), g.unit);
    const aspect = logoAspect(kit, ts);
    const w = snap(h * aspect, 1);
    const clear = h * (kit.logo.clearZone ?? 1);
    const s = g.safe;
    const spots = {
      TL: { x: g.mx, y: s.top }, TR: { x: g.w - g.mx - w, y: s.top }, TC: { x: (g.w - w) / 2, y: s.top },
      BL: { x: g.mx, y: g.h - s.bottom - h }, BR: { x: g.w - g.mx - w, y: g.h - s.bottom - h }, BC: { x: (g.w - w) / 2, y: g.h - s.bottom - h },
    };
    const order = [...(prefer || []), 'TL', 'BL', 'TR', 'BR', 'TC', 'BC'].filter((v, i, a) => a.indexOf(v) === i);
    const ok = order.filter(k => { const r = { ...spots[k], w, h }; return !avoid.some(a => inter(grow(r, clear), a)); });
    if (!ok.length) return null;
    const k = rng.weighted(ok.map((v, i) => ({ v, w: Math.max(1, 4 - i) })));
    const bg = ground ? ground(spots[k].x + w / 2, spots[k].y + h / 2) : ctx.pal.bg;
    const color = Brand.logoColorFor(kit, bg)[0];
    return { kind: 'logo', x: Math.round(spots[k].x), y: spots[k].y, w, h, fill: color, spot: k };
  }
  function footerBlock(ctx, avoid, logo) {
    const { g, rng, ts, content, pal } = ctx;
    if (!content.footer || !rng.chance(0.35)) return null;
    const font = ts.footer; const w = Text.width(content.footer, font); const h = font.size * 1.2;
    const s = g.safe;
    const cands = [{ x: g.w - g.mx - w, y: g.h - s.bottom - h, align: 'right' }, { x: g.mx, y: g.h - s.bottom - h, align: 'left' }, { x: g.w - g.mx - w, y: s.top, align: 'right' }];
    for (const c of cands) {
      const r = { x: c.x, y: c.y, w, h };
      if (logo && inter(grow(r, logo.h), logo)) continue;
      if (avoid.some(a => inter(grow(r, g.unit), a))) continue;
      return { kind: 'text', role: 'footer', x: c.x, y: c.y, w, h, inkW: w, lines: [content.footer], font, fill: pal.fg2, align: 'left' };
    }
    return null;
  }

  // ---- Shapes -----------------------------------------------------------------
  function addShape(ctx, avoid, colorPool) {
    const { g, rng, kit } = ctx;
    if (!kit.shapes || !kit.shapes.length || !colorPool.length) return null;
    const shape = rng.pick(kit.shapes);
    for (let t = 0; t < 14; t++) {
      const cs = rng.int(2, Math.max(2, Math.floor(g.cols * 0.5)));
      const rs = shape === 'pill' ? Math.max(1, Math.round(cs / 3)) : cs;
      const c0 = rng.int(-1, g.cols - 1), r0 = rng.int(-1, g.rows - 1);
      const r = Grid.rect(g, c0, r0, cs, rs);
      if (shape === 'circle' || shape === 'blob') r.h = r.w; // square cell box
      if (r.x + r.w < g.unit * 4 || r.y + r.h < g.unit * 4 || r.x > g.w - g.unit * 4 || r.y > g.h - g.unit * 4) continue; // mostly off canvas
      if (avoid.some(a => inter(r, grow(a, g.gutter)))) continue;
      return { kind: 'shape', shape, x: r.x, y: r.y, w: r.w, h: r.h, fill: rng.pick(colorPool), rot: shape === 'quarter' ? rng.int(0, 3) * 90 : 0 };
    }
    return null;
  }

  // ---- Images -----------------------------------------------------------------
  const FOCALS = ['xMinYMin', 'xMidYMin', 'xMaxYMin', 'xMinYMid', 'xMidYMid', 'xMaxYMid', 'xMinYMax', 'xMidYMax', 'xMaxYMax'];
  function imageBlock(ctx, r, asset, radius) {
    const { rng } = ctx;
    return { kind: 'image', x: r.x, y: r.y, w: r.w, h: r.h, asset: asset.id, focal: rng.weighted(FOCALS.map(f => ({ v: f, w: f === 'xMidYMid' ? 4 : 1 }))), radius: radius || 0 };
  }
  function pickImage(ctx, exclude = []) {
    const imgs = ctx.assets.images.filter(i => !exclude.includes(i.id));
    return imgs.length ? ctx.rng.pick(imgs) : null;
  }

  // ---- Archetypes ----------------------------------------------------------------
  // Each returns {blocks, meta} or null. `ctx.R` = usable rows, `ctx.r0` = first usable row.
  const A = {};

  A['type-led'] = ctx => {
    const { g, rng, pal, ts, intent } = ctx;
    const C = g.cols, R = ctx.R;
    const spans = [C, C, C - 2, Math.round(C * 0.75), Math.round(C * 0.66)].filter(s => s >= 3);
    const cs = rng.pick(spans);
    const align = cs === C ? rng.weighted([{ v: 'left', w: 3 }, { v: 'center', w: 2 }]) : rng.weighted([{ v: 'left', w: 4 }, { v: 'center', w: 1 }, { v: 'right', w: 1 }]);
    const c0 = align === 'center' ? Math.floor((C - cs) / 2) : align === 'right' ? C - cs : rng.chance(0.75) ? 0 : Math.min(C - cs, 1);
    const valign = rng.weighted([{ v: 'top', w: 2 }, { v: 'center', w: 2 }, { v: 'bottom', w: 3 }]);
    const logoInStack = rng.chance(0.3);
    const logoH = snap(Math.min(g.w, g.h) * 0.045, g.unit);
    // Reserve a row for the logo when it sits at the opposite end.
    const reserve = logoInStack ? 0 : 1;
    const rowStart = valign === 'top' ? ctx.r0 : ctx.r0 + reserve;
    const rowCount = Math.max(2, R - (valign === 'center' ? 2 * reserve : reserve));
    const region = Grid.rect(g, c0, rowStart, cs, rowCount);
    const items = pickItems(ctx, { logoInStack, logoH, logoAspect: logoAspect(ctx.kit, ts), logoColor: Brand.logoColorFor(ctx.kit, pal.bg)[0] });
    const stack = buildStack(items, region, align, valign, g);
    if (!stack) return null;
    const ink = inkRect(stack, region, align);
    const blocks = [...stack.blocks];
    const avoid = [ink];
    let logo = null;
    if (!logoInStack) {
      const prefer = valign === 'top' ? (align === 'right' ? ['BR', 'BL'] : ['BL', 'BR']) : valign === 'bottom' ? (align === 'right' ? ['TR', 'TL'] : ['TL', 'TR']) : (align === 'left' ? ['TL', 'BL', 'TR'] : ['TR', 'BR']);
      logo = placeLogo(ctx, avoid, prefer);
      if (logo) { blocks.push(logo); avoid.push(logo); }
    }
    const foot = footerBlock(ctx, avoid, logo); if (foot) blocks.push(foot);
    if (rng.chance(intent.loud > 0.5 ? 0.5 : 0.3)) { const s = addShape(ctx, [...avoid, ...(foot ? [foot] : [])], pal.fields); if (s) blocks.unshift(s); }
    return { blocks, meta: { align, valign, span: cs } };
  };

  A['split'] = ctx => {
    const { g, rng, pal, ts, fmt } = ctx;
    const C = g.cols, R = ctx.R;
    const portrait = g.h > g.w * 1.15;
    const vertical = portrait ? rng.chance(0.15) : g.w > g.h * 1.3 ? true : rng.chance(0.6);
    const img = pickImage(ctx);
    const radius = ctx.radius(g.unit * 2);
    const inset = rng.chance(0.3);
    const blocks = []; let region, align, valign, prefer;
    if (vertical) {
      const k = rng.pick([Math.round(C / 3), Math.round(C / 2), Math.round(C * 0.58), Math.round(C * 0.42)].filter(x => x >= 3 && C - x >= 3));
      const imgLeft = rng.chance(0.55);
      const imgCols = imgLeft ? [0, k] : [C - k, k];
      const txtCols = imgLeft ? [k, C - k] : [0, C - k];
      let r;
      if (inset) r = Grid.rect(g, imgCols[0], ctx.r0, imgCols[1], R);
      else { const cellR = Grid.rect(g, imgCols[0], 0, imgCols[1], g.rows); r = imgLeft ? { x: 0, y: 0, w: cellR.x + cellR.w + g.gutter / 2, h: g.h } : { x: cellR.x - g.gutter / 2, y: 0, w: g.w - cellR.x + g.gutter / 2, h: g.h }; }
      blocks.push(img ? imageBlock(ctx, r, img, inset ? radius : 0) : { kind: 'field', ...r, fill: rng.pick(pal.fields.length ? pal.fields : [pal.accent]), radius: inset ? radius : 0 });
      align = 'left'; valign = rng.weighted([{ v: 'center', w: 2 }, { v: 'bottom', w: 2 }, { v: 'top', w: 1 }]);
      const rowStart = valign === 'top' ? ctx.r0 : ctx.r0 + 1;
      region = Grid.rect(g, txtCols[0], rowStart, txtCols[1], Math.max(2, R - (valign === 'center' ? 2 : 1)));
      prefer = imgLeft ? (valign === 'top' ? ['BR', 'BL'] : ['TR', 'TL']) : (valign === 'top' ? ['BL', 'BR'] : ['TL', 'TR']);
    } else {
      const k = rng.pick([Math.round(R / 2), Math.round(R * 0.6), Math.round(R * 0.4)].filter(x => x >= 2 && R - x >= 2));
      if (!k) return null;
      const imgTop = rng.chance(0.6);
      const imgRows = imgTop ? [ctx.r0, k] : [ctx.r0 + R - k, k];
      const txtRows = imgTop ? [ctx.r0 + k, R - k] : [ctx.r0, R - k];
      let r;
      if (inset) r = Grid.rect(g, 0, imgRows[0], C, imgRows[1]);
      else { const cellR = Grid.rect(g, 0, imgRows[0], C, imgRows[1]); r = imgTop ? { x: 0, y: 0, w: g.w, h: cellR.y + cellR.h + g.gutter / 2 } : { x: 0, y: cellR.y - g.gutter / 2, w: g.w, h: g.h - cellR.y + g.gutter / 2 }; }
      blocks.push(img ? imageBlock(ctx, r, img, inset ? radius : 0) : { kind: 'field', ...r, fill: rng.pick(pal.fields.length ? pal.fields : [pal.accent]), radius: inset ? radius : 0 });
      align = rng.weighted([{ v: 'left', w: 3 }, { v: 'center', w: 1 }]);
      valign = imgTop ? rng.pick(['top', 'bottom']) : rng.pick(['top', 'bottom']);
      // leave one row for logo on the text side, at the far end from the image
      const logoRow = imgTop ? 'bottom' : 'top';
      const rowStart = logoRow === 'top' ? txtRows[0] + 1 : txtRows[0];
      region = Grid.rect(g, 0, rowStart, C, Math.max(1, txtRows[1] - 1));
      prefer = imgTop ? ['BL', 'BR'] : ['TL', 'TR'];
      if (txtRows[1] - 1 < 1) return null;
    }
    const items = pickItems(ctx, {});
    const stack = buildStack(items, region, align, valign, g);
    if (!stack) return null;
    blocks.push(...stack.blocks);
    const avoid = [inkRect(stack, region, align), blocks[0]];
    const logo = placeLogo(ctx, avoid, prefer, (x, y) => inter({ x, y, w: 1, h: 1 }, blocks[0]) ? (img ? '#777777' : blocks[0].fill) : pal.bg);
    if (logo && (!inter(logo, blocks[0]) || !img)) { blocks.push(logo); avoid.push(logo); }
    const foot = footerBlock(ctx, avoid, logo); if (foot && !inter(foot, blocks[0])) blocks.push(foot);
    return { blocks, meta: { vertical, inset, align, valign } };
  };

  A['full-bleed'] = ctx => {
    const { g, rng, pal, ts, kit } = ctx;
    const img = pickImage(ctx);
    if (!img) return A['color-block'](ctx);
    const C = g.cols, R = ctx.R;
    const blocks = [imageBlock(ctx, { x: 0, y: 0, w: g.w, h: g.h }, img, 0)];
    // Content-aware anchor: score the 3x3 anchors by luminance variance in the image map.
    const lum = img.lum;
    const cs = rng.pick([Math.round(C * 0.5), Math.round(C * 0.66), Math.round(C * 0.8), C].filter(x => x >= 3));
    const rs = Math.max(2, Math.round(R * rng.pick([0.45, 0.55, 0.65])));
    const anchors = [];
    for (const ax of ['left', 'center', 'right']) for (const ay of ['top', 'center', 'bottom']) {
      const c0 = ax === 'left' ? 0 : ax === 'center' ? Math.floor((C - cs) / 2) : C - cs;
      const r0 = ay === 'top' ? ctx.r0 : ay === 'center' ? ctx.r0 + Math.floor((R - rs) / 2) : ctx.r0 + R - rs;
      const region = Grid.rect(g, c0, r0, cs, rs);
      let mean = 0.5, std = 0.2;
      if (lum) {
        const cells = lum.cells.filter(c => { const cx = (c.x + 0.5) / lum.gx * g.w, cy = (c.y + 0.5) / lum.gy * g.h; return cx >= region.x && cx <= region.x + region.w && cy >= region.y && cy <= region.y + region.h; });
        if (cells.length) { mean = cells.reduce((s, c) => s + c.mean, 0) / cells.length; const m2 = cells.reduce((s, c) => s + c.mean * c.mean, 0) / cells.length; std = Math.sqrt(Math.max(0, m2 - mean * mean)) + cells.reduce((s, c) => s + c.std, 0) / cells.length; }
      }
      anchors.push({ ax, ay, region, mean, std, score: 1 / (0.05 + std) });
    }
    const a = rng.weighted(anchors.map(x => ({ v: x, w: x.score })));
    const align = a.ax, valign = a.ay;
    // Treatment: gradient scrim, solid panel, or bare text when the area is calm.
    const calm = a.std < 0.12;
    const treatment = calm && rng.chance(0.6) ? 'none' : rng.weighted([{ v: 'scrim', w: 3 }, { v: 'panel', w: 2 }]);
    const light = treatment === 'panel' ? !pal.dark : a.mean < 0.5;
    const textFill = treatment === 'panel' ? pal.fg : light ? '#FFFFFF' : (kit.colors.find(c => c.role === 'neutral' || Color.isDark(c.hex)) || { hex: '#111111' }).hex;
    const localPal = treatment === 'panel' ? pal : { ...pal, fg: textFill, fg2: Color.mix(textFill, light ? '#000000' : '#FFFFFF', 0.12), accentText: Color.contrast(light ? '#222222' : '#DDDDDD', pal.accent) >= 3 ? pal.accent : textFill };
    const pad = treatment === 'panel' ? g.unit * 4 : 0;
    const region = { x: a.region.x + pad, y: a.region.y + pad, w: a.region.w - 2 * pad, h: a.region.h - 2 * pad };
    const items = pickItems({ ...ctx, pal: localPal }, { body: 0.1 });
    const stack = buildStack(items, region, align, valign, g);
    if (!stack) return null;
    const ink = inkRect(stack, region, align);
    if (treatment === 'scrim') {
      const dir = valign === 'bottom' ? 'up' : valign === 'top' ? 'down' : align === 'left' ? 'right' : align === 'right' ? 'left' : 'up';
      const scrimColor = light ? '#000000' : '#FFFFFF';
      let r;
      if (dir === 'up') r = { x: 0, y: Math.max(0, ink.y - g.h * 0.25), w: g.w, h: g.h - Math.max(0, ink.y - g.h * 0.25) };
      else if (dir === 'down') r = { x: 0, y: 0, w: g.w, h: Math.min(g.h, ink.y + ink.h + g.h * 0.25) };
      else if (dir === 'right') r = { x: 0, y: 0, w: Math.min(g.w, ink.x + ink.w + g.w * 0.25), h: g.h };
      else r = { x: Math.max(0, ink.x - g.w * 0.25), y: 0, w: g.w - Math.max(0, ink.x - g.w * 0.25), h: g.h };
      blocks.push({ kind: 'scrim', ...r, fill: scrimColor, dir, alpha: 0.78 });
    } else if (treatment === 'panel') {
      const pr = grow({ x: align === 'center' ? ink.x : region.x, y: stack.y0, w: align === 'center' ? ink.w : ink.w, h: stack.y1 - stack.y0 }, pad);
      blocks.push({ kind: 'field', x: snap(pr.x, 1), y: snap(pr.y, 1), w: snap(pr.w, 1), h: snap(pr.h, 1), fill: pal.bg, radius: ctx.radius(g.unit * 2), alpha: 0.94 });
    }
    blocks.push(...stack.blocks);
    const avoid = [ink];
    const logoColor = treatment === 'panel' ? null : (light ? '#FFFFFF' : '#000000');
    const logo = placeLogo(ctx, avoid, valign === 'top' ? ['BL', 'BR'] : ['TL', 'TR'], () => light ? '#333333' : '#DDDDDD');
    if (logo) {
      if (logoColor) { const allowed = (kit.logo.allowedColors || []).map(Color.normalize); logo.fill = allowed.includes(logoColor) ? logoColor : logo.fill; }
      blocks.push(logo);
      // a soft scrim behind the logo when it sits on a busy corner
      if (treatment !== 'none') blocks.splice(1, 0, { kind: 'scrim', x: 0, y: logo.y < g.h / 2 ? 0 : g.h * 0.75, w: g.w, h: g.h * 0.25, fill: light ? '#000000' : '#FFFFFF', dir: logo.y < g.h / 2 ? 'down' : 'up', alpha: 0.35 });
    }
    return { blocks, meta: { anchor: a.ax + '-' + a.ay, treatment, overlay: true } };
  };

  A['poster'] = ctx => {
    const { g, rng, pal } = ctx;
    const C = g.cols, R = ctx.R;
    const img = pickImage(ctx);
    const radius = ctx.radius(g.unit * 2);
    const blocks = [];
    const textBelow = rng.chance(0.6);
    const imgRows = Math.max(2, Math.round(R * rng.pick([0.5, 0.58, 0.66])));
    const txtRows = R - imgRows;
    if (txtRows < 2) return null;
    const partial = rng.chance(0.35) && C >= 8;
    const imgCols = partial ? Math.round(C * rng.pick([0.66, 0.75])) : C;
    const imgC0 = partial ? (rng.chance(0.5) ? 0 : C - imgCols) : 0;
    const ir = Grid.rect(g, imgC0, textBelow ? ctx.r0 : ctx.r0 + txtRows, imgCols, imgRows);
    blocks.push(img ? imageBlock(ctx, ir, img, radius) : { kind: 'field', ...ir, fill: rng.pick(pal.fields.length ? pal.fields : [pal.accent]), radius });
    const align = rng.weighted([{ v: 'left', w: 4 }, { v: 'center', w: 1 }]);
    const cs = align === 'center' ? C : rng.pick([C, C, Math.round(C * 0.75)]);
    const c0 = align === 'center' ? 0 : partial && imgC0 === 0 && rng.chance(0.5) ? 0 : 0;
    // Text rows exclude one row for logo/footer at the outer edge.
    const rowStart = textBelow ? ctx.r0 + imgRows : ctx.r0 + 1;
    const rowCount = Math.max(1, txtRows - 1);
    const region = Grid.rect(g, c0, rowStart, cs, rowCount);
    const valign = textBelow ? 'top' : 'bottom';
    const items = pickItems(ctx, { body: 0.15 });
    const stack = buildStack(items, region, align, valign, g);
    if (!stack) return null;
    blocks.push(...stack.blocks);
    const avoid = [inkRect(stack, region, align), ir];
    const logo = placeLogo(ctx, avoid, textBelow ? ['BL', 'BR'] : ['TL', 'TR']);
    if (logo && !inter(logo, ir)) { blocks.push(logo); avoid.push(logo); }
    const foot = footerBlock(ctx, avoid, logo); if (foot && !inter(foot, ir)) blocks.push(foot);
    return { blocks, meta: { textBelow, partial } };
  };

  A['mosaic'] = ctx => {
    const { g, rng, pal } = ctx;
    const C = g.cols, R = ctx.R;
    const imgs = ctx.assets.images;
    if (imgs.length < 1) return null;
    const radius = ctx.radius(g.unit * 2);
    const blocks = [];
    const tileRows = Math.max(2, Math.round(R * rng.pick([0.5, 0.6])));
    const txtRows = R - tileRows;
    if (txtRows < 2) return null;
    const top = rng.chance(0.5);
    const tr0 = top ? ctx.r0 : ctx.r0 + txtRows;
    const pattern = rng.pick(['2', '3', '1+2', '4']);
    const tiles = [];
    if (pattern === '2') { const k = Math.round(C / 2); tiles.push(Grid.rect(g, 0, tr0, k, tileRows), Grid.rect(g, k, tr0, C - k, tileRows)); }
    else if (pattern === '3' && C >= 9) { const k = Math.floor(C / 3); tiles.push(Grid.rect(g, 0, tr0, k, tileRows), Grid.rect(g, k, tr0, k, tileRows), Grid.rect(g, 2 * k, tr0, C - 2 * k, tileRows)); }
    else if (pattern === '4' && tileRows >= 4) { const k = Math.round(C / 2), h = Math.floor(tileRows / 2); tiles.push(Grid.rect(g, 0, tr0, k, h), Grid.rect(g, k, tr0, C - k, h), Grid.rect(g, 0, tr0 + h, k, tileRows - h), Grid.rect(g, k, tr0 + h, C - k, tileRows - h)); }
    else { const k = Math.round(C * 0.6), h = Math.floor(tileRows / 2); if (h < 1) return null; tiles.push(Grid.rect(g, 0, tr0, k, tileRows), Grid.rect(g, k, tr0, C - k, h), Grid.rect(g, k, tr0 + h, C - k, tileRows - h)); }
    const order = rng.shuffle(imgs);
    tiles.forEach((t, i) => {
      const im = order[i % order.length];
      if (i < order.length || rng.chance(0.5)) blocks.push(imageBlock(ctx, t, im, radius));
      else blocks.push({ kind: 'field', ...t, fill: rng.pick(pal.fields.length ? pal.fields : [pal.accent]), radius });
    });
    const align = rng.weighted([{ v: 'left', w: 3 }, { v: 'center', w: 1 }]);
    const rowStart = top ? ctx.r0 + tileRows : ctx.r0 + 1;
    const region = Grid.rect(g, 0, rowStart, C, Math.max(1, txtRows - 1));
    const items = pickItems(ctx, { body: 0.1, subhead: 0.5 });
    const valign = txtRows > 3 ? rng.weighted([{ v: top ? 'top' : 'bottom', w: 2 }, { v: 'center', w: 2 }, { v: top ? 'bottom' : 'top', w: 1 }]) : (top ? 'top' : 'bottom');
    const stack = buildStack(items, region, align, valign, g);
    if (!stack) return null;
    blocks.push(...stack.blocks);
    const avoid = [inkRect(stack, region, align), ...tiles];
    const logo = placeLogo(ctx, avoid, top ? ['BL', 'BR'] : ['TL', 'TR']);
    if (logo && !tiles.some(t => inter(logo, t))) blocks.push(logo);
    return { blocks, meta: { pattern, top } };
  };

  A['color-block'] = ctx => {
    const { g, rng, pal, kit } = ctx;
    const C = g.cols, R = ctx.R;
    const fields = pal.fields.length ? pal.fields : [pal.accent];
    const pattern = rng.pick(['band-top', 'band-bottom', 'column-left', 'column-right', 'corner', 'stripes']);
    const blocks = [];
    let region, align = rng.weighted([{ v: 'left', w: 4 }, { v: 'center', w: 1 }]), valign, textOnField = false, fieldFill = rng.pick(fields), prefer;
    const bleed = rng.chance(0.6);
    const radius = bleed ? 0 : ctx.radius(g.unit * 2);
    const B = (c0, r0, cs, rs) => { const r = Grid.rect(g, c0, r0, cs, rs); if (!bleed) return r; return { x: c0 === 0 ? 0 : r.x, y: r0 === 0 ? 0 : r.y, w: (c0 === 0 ? r.x : 0) + r.w + (c0 + cs === C ? g.w - (r.x + r.w) : 0), h: (r0 === 0 ? r.y : 0) + r.h + (r0 + rs === g.rows ? g.h - (r.y + r.h) : 0) }; };
    const img = rng.chance(0.4) ? pickImage(ctx) : null;
    if (pattern === 'band-top' || pattern === 'band-bottom') {
      const k = Math.max(2, Math.round(g.rows * rng.pick([0.35, 0.45, 0.55])));
      const r0 = pattern === 'band-top' ? 0 : g.rows - k;
      const f = B(0, r0, C, k);
      blocks.push(img ? imageBlock(ctx, f, img, radius) : { kind: 'field', ...f, fill: fieldFill, radius });
      textOnField = !img && rng.chance(0.4);
      const rowsFree = pattern === 'band-top' ? [Math.max(ctx.r0, k), ctx.r0 + R - Math.max(ctx.r0, k)] : [ctx.r0, Math.min(ctx.r0 + R, g.rows - k) - ctx.r0];
      const rowsOn = pattern === 'band-top' ? [ctx.r0, Math.min(k, ctx.r0 + R) - ctx.r0] : [Math.max(ctx.r0, g.rows - k), ctx.r0 + R - Math.max(ctx.r0, g.rows - k)];
      const rows = textOnField ? rowsOn : rowsFree;
      if (rows[1] < 2) return null;
      valign = pattern === 'band-top' ? (textOnField ? 'top' : 'bottom') : (textOnField ? 'bottom' : 'top');
      const rowStart = valign === 'top' ? rows[0] : rows[0] + 1; const rowCount = Math.max(1, rows[1] - 1);
      region = Grid.rect(g, 0, rowStart, rng.pick([C, C, Math.round(C * 0.75)]), rowCount);
      prefer = valign === 'top' ? ['BL', 'BR'] : ['TL', 'TR'];
    } else if (pattern === 'column-left' || pattern === 'column-right') {
      const k = Math.max(2, Math.round(C * rng.pick([0.33, 0.42, 0.5])));
      const c0 = pattern === 'column-left' ? 0 : C - k;
      const f = B(c0, 0, k, g.rows);
      blocks.push(img ? imageBlock(ctx, f, img, radius) : { kind: 'field', ...f, fill: fieldFill, radius });
      textOnField = !img && rng.chance(0.3);
      const cols = textOnField ? [c0, k] : (pattern === 'column-left' ? [k, C - k] : [0, C - k]);
      if (cols[1] < 3) return null;
      valign = rng.pick(['top', 'bottom', 'center']);
      const rowStart = valign === 'top' ? ctx.r0 : ctx.r0 + 1;
      region = Grid.rect(g, cols[0], rowStart, cols[1], Math.max(2, R - (valign === 'center' ? 2 : 1)));
      prefer = pattern === 'column-left' && !textOnField ? (valign === 'top' ? ['BR', 'BL'] : ['TR', 'TL']) : (valign === 'top' ? ['BL', 'BR'] : ['TL', 'TR']);
    } else if (pattern === 'corner') {
      const kc = Math.max(2, Math.round(C * rng.pick([0.4, 0.5, 0.6]))), kr = Math.max(2, Math.round(g.rows * rng.pick([0.4, 0.5, 0.6])));
      const right = rng.chance(0.5), bottom = rng.chance(0.6);
      const f = B(right ? C - kc : 0, bottom ? g.rows - kr : 0, kc, kr);
      blocks.push(img ? imageBlock(ctx, f, img, radius) : { kind: 'field', ...f, fill: fieldFill, radius });
      if (rng.chance(0.5)) { const f2 = B(right ? 0 : C - Math.max(2, C - kc), bottom ? 0 : g.rows - Math.max(2, g.rows - kr), Math.max(2, C - kc), Math.max(2, g.rows - kr)); if (!inter(f2, f)) blocks.push({ kind: 'field', ...f2, fill: rng.pick(fields.filter(x => x !== fieldFill).concat([pal.accent])), radius, alpha: 1 }); }
      // Text in the opposite band (rows not covered by the corner field)
      const rowsFree = bottom ? [ctx.r0, Math.min(ctx.r0 + R, g.rows - kr) - ctx.r0] : [Math.max(ctx.r0, kr), ctx.r0 + R - Math.max(ctx.r0, kr)];
      if (rowsFree[1] < 2) return null;
      valign = bottom ? 'top' : 'bottom';
      const rowStart = valign === 'top' ? rowsFree[0] + 1 : rowsFree[0];
      region = Grid.rect(g, 0, rowStart, Math.max(3, Math.round(C * 0.75)), Math.max(1, rowsFree[1] - 1));
      align = 'left';
      prefer = bottom ? ['TL', 'TR'] : ['BL', 'BR'];
      if (blocks.length > 1) blocks.length = 1;
    } else { // stripes: 2-3 vertical column bands in field colors, text on top-left region
      const n = rng.int(2, 3); let c = 0; const widths = [];
      for (let i = 0; i < n; i++) { const w = i === n - 1 ? C - c : Math.max(1, Math.round(C / n)); widths.push([c, w]); c += w; }
      const pool = rng.shuffle([pal.bg, ...fields, pal.accent]);
      widths.forEach(([c0, w], i) => { if (pool[i % pool.length] !== pal.bg) blocks.push({ kind: 'field', ...B(c0, 0, w, g.rows), fill: pool[i % pool.length], radius }); });
      textOnField = true; fieldFill = null;
      valign = rng.pick(['top', 'bottom']);
      const rowStart = valign === 'top' ? ctx.r0 : ctx.r0 + 1;
      region = Grid.rect(g, 0, rowStart, C, Math.max(2, R - 1));
      align = 'left';
      prefer = valign === 'top' ? ['BL', 'BR'] : ['TL', 'TR'];
    }
    // Foreground on the field when text sits on it.
    let localPal = pal;
    if (textOnField) {
      const ground = fieldFill || pal.bg;
      const fg = Color.bestForeground(ground, kit.colors.map(c => Color.normalize(c.hex)), 4.5)[0];
      const accent = Color.contrast(ground, pal.accent) >= 3 ? pal.accent : fg;
      localPal = { ...pal, fg, fg2: Color.mix(fg, ground, 0.12), accentText: Color.contrast(ground, accent) >= 4.5 ? accent : fg, accent: accent === fg ? pal.accent : accent, onAccent: Color.contrast(accent === fg ? pal.accent : accent, '#FFFFFF') >= Color.contrast(accent === fg ? pal.accent : accent, '#000000') ? '#FFFFFF' : '#000000' };
    }
    const items = pickItems({ ...ctx, pal: localPal }, {});
    const stack = buildStack(items, region, align, valign, g);
    if (!stack) return null;
    blocks.push(...stack.blocks);
    const ink = inkRect(stack, region, align);
    const avoid = [ink, ...blocks.filter(b => b.kind === 'image')];
    const logo = placeLogo(ctx, avoid, prefer, (x, y) => { const f = blocks.filter(b => b.kind === 'field').reverse().find(b => inter({ x, y, w: 1, h: 1 }, b)); return f ? f.fill : pal.bg; });
    if (logo && !blocks.some(b => b.kind === 'image' && inter(logo, b))) { blocks.push(logo); avoid.push(logo); }
    const foot = footerBlock(ctx, avoid, logo); if (foot) blocks.push(foot);
    if (rng.chance(0.35)) { const s = addShape(ctx, [...avoid, ...blocks.filter(b => b.kind === 'field')], [pal.accent, ...fields]); if (s) blocks.splice(blocks.findIndex(b => b.kind === 'text'), 0, s); }
    return { blocks, meta: { pattern, textOnField, bleed } };
  };

  A['editorial'] = ctx => {
    const { g, rng, pal, ts } = ctx;
    const C = g.cols, R = ctx.R;
    const cs = Math.max(3, Math.round(C * rng.pick([0.4, 0.5, 0.58])));
    const right = rng.chance(0.4);
    const c0 = right ? C - cs : rng.pick([0, 0, 1]);
    const valign = rng.weighted([{ v: 'top', w: 2 }, { v: 'center', w: 2 }, { v: 'bottom', w: 3 }]);
    const rowStart = valign === 'top' ? ctx.r0 + 1 : ctx.r0 + 1;
    const region = Grid.rect(g, c0, rowStart, cs, Math.max(2, R - 2));
    const quiet = { ...ts.headline, size: snapFont(ts.headline.size * 0.8, g.unit), weight: nearestWeight(ctx.kit.fonts.display, (ctx.kit.fonts.displayWeight || 600) - 100) };
    const items = [{ kind: 'rule', role: 'rule', w: snap(region.w * 0.3, g.unit), fill: pal.accentText, gap: snap(ts.body.size * 1.2, g.unit) }, ...pickItems(ctx, { eyebrow: 0.7, subhead: 0.5, body: 0.6, cta: 0.35, headlineFont: quiet })];
    const stack = buildStack(items, region, 'left', valign, g);
    if (!stack) return null;
    const blocks = [...stack.blocks];
    const ink = inkRect(stack, region, 'left');
    const avoid = [ink];
    // small image or stat in the opposite corner
    const img = rng.chance(0.55) ? pickImage(ctx) : null;
    if (img) {
      const ics = Math.max(2, Math.round(C * rng.pick([0.25, 0.33]))), irs = Math.max(2, Math.round(R * rng.pick([0.25, 0.33])));
      const ic0 = right ? 0 : C - ics; const ir0 = valign === 'bottom' ? ctx.r0 : ctx.r0 + R - irs;
      const r = Grid.rect(g, ic0, ir0, ics, irs);
      if (!inter(grow(r, g.gutter), ink)) { blocks.unshift(imageBlock(ctx, r, img, ctx.radius(g.unit * 2))); avoid.push(r); }
    }
    const logo = placeLogo(ctx, avoid, right ? ['TL', 'BL'] : ['TR', 'BR', 'TL']);
    if (logo) { blocks.push(logo); avoid.push(logo); }
    const foot = footerBlock(ctx, avoid, logo); if (foot) blocks.push(foot);
    return { blocks, meta: { right, valign, span: cs } };
  };

  A['stat'] = ctx => {
    const { g, rng, pal, ts, content } = ctx;
    if (!content.stat) return null;
    const C = g.cols, R = ctx.R;
    const align = rng.weighted([{ v: 'left', w: 3 }, { v: 'center', w: 2 }]);
    const cs = align === 'center' ? C : rng.pick([C, Math.round(C * 0.8)]);
    const c0 = align === 'center' ? 0 : 0;
    const valign = rng.pick(['center', 'bottom', 'top']);
    const rowStart = valign === 'top' ? ctx.r0 : ctx.r0 + 1;
    const region = Grid.rect(g, c0, rowStart, cs, Math.max(2, R - (valign === 'center' ? 2 : 1)));
    const statFill = rng.chance(0.5) ? pal.accentText : pal.fg;
    const items = pickItems(ctx, { stat: true, statFill, eyebrow: 0.3, subhead: 0.35, body: 0.05, cta: 0.4, headlineFont: { ...ts.subhead, size: snapFont(ts.subhead.size * 1.15, g.unit), weight: nearestWeight(ctx.kit.fonts.body, 500) }, headlineMaxLines: 3 });
    const stack = buildStack(items, region, align, valign, g);
    if (!stack) return null;
    const blocks = [...stack.blocks];
    const ink = inkRect(stack, region, align);
    const avoid = [ink];
    const logo = placeLogo(ctx, avoid, valign === 'top' ? ['BL', 'BR'] : ['TL', 'TR']);
    if (logo) { blocks.push(logo); avoid.push(logo); }
    const foot = footerBlock(ctx, avoid, logo); if (foot) blocks.push(foot);
    if (rng.chance(0.45)) { const s = addShape(ctx, avoid, pal.fields); if (s) blocks.unshift(s); }
    return { blocks, meta: { align, valign } };
  };

  // ---- Validation and metrics ------------------------------------------------------
  function validate(layout, g) {
    const texts = layout.blocks.filter(b => b.kind === 'text' || b.kind === 'button' || b.kind === 'logo');
    const s = g.safe;
    for (const t of texts) {
      const r = { x: t.x, y: t.y, w: t.kind === 'text' ? (t.inkW || t.w) : t.w, h: t.h };
      if (t.kind === 'text' && t.align === 'center') r.x = t.x + (t.w - r.w) / 2;
      if (t.kind === 'text' && t.align === 'right') r.x = t.x + t.w - r.w;
      if (r.x < s.left - 1 || r.y < s.top - 1 || r.x + r.w > g.w - s.right + 1 || r.y + r.h > g.h - s.bottom + 1) return 'outside safe area: ' + t.role;
      for (const o of texts) if (o !== t) {
        const ro = { x: o.x, y: o.y, w: o.kind === 'text' ? (o.inkW || o.w) : o.w, h: o.h };
        if (o.kind === 'text' && o.align === 'center') ro.x = o.x + (o.w - ro.w) / 2;
        if (o.kind === 'text' && o.align === 'right') ro.x = o.x + o.w - ro.w;
        if (inter(r, ro)) return 'overlap: ' + t.role + '/' + o.role;
      }
      // What lies under the text? Images need a scrim/panel; fields need contrast.
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      const under = layout.blocks.filter(b => ['image', 'field', 'scrim', 'shape'].includes(b.kind) && inter({ x: cx, y: cy, w: 1, h: 1 }, b));
      const topImage = under.filter(b => b.kind === 'image').pop();
      const topField = under.filter(b => b.kind === 'field').pop();
      const shape = under.filter(b => b.kind === 'shape').pop();
      if (shape && inter(r, shape) && t.kind !== 'button') return 'text on shape: ' + t.role;
      if (topImage && !(under.some(b => b.kind === 'scrim') || (topField && layout.blocks.indexOf(topField) > layout.blocks.indexOf(topImage))) && !layout.meta.overlay) return 'text on image without treatment: ' + t.role;
      if (topField && !topImage && t.kind === 'text' && t.fill && Color.contrast(topField.fill, t.fill) < (t.role === 'headline' || t.role === 'stat' ? 3 : 4.5) && !topField.alpha) return 'low contrast on field: ' + t.role;
    }
    return null;
  }
  function metrics(layout, g) {
    const total = g.w * g.h;
    let ink = 0, sx = 0, sy = 0, sw = 0, textInk = 0;
    for (const b of layout.blocks) {
      if (b.kind === 'scrim') continue;
      const r = { x: b.x, y: b.y, w: b.kind === 'text' ? (b.inkW || b.w) : b.w, h: b.h };
      const a = Math.min(total, area({ x: Math.max(0, r.x), y: Math.max(0, r.y), w: Math.min(g.w, r.x + r.w) - Math.max(0, r.x), h: Math.min(g.h, r.y + r.h) - Math.max(0, r.y) }));
      if (b.kind === 'text' || b.kind === 'button' || b.kind === 'logo') { textInk += a; sx += (r.x + r.w / 2) * a; sy += (r.y + r.h / 2) * a; sw += a; }
      else if (b.kind === 'image' || b.kind === 'field') { sx += (r.x + r.w / 2) * a * 0.3; sy += (r.y + r.h / 2) * a * 0.3; sw += a * 0.3; }
      ink += a;
    }
    const whitespace = Math.max(0, 1 - Math.min(1, ink / total));
    const density = Math.min(1, textInk / total * 3);
    const balance = sw ? 1 - Math.min(1, Math.hypot(sx / sw - g.w / 2, sy / sw - g.h / 2) / Math.hypot(g.w / 2, g.h / 2)) : 0.5;
    return { whitespace: +whitespace.toFixed(3), density: +density.toFixed(3), balance: +balance.toFixed(3) };
  }
  function signature(layout, g) {
    const cell = v => Math.round(v / (g.cw + g.gutter));
    return layout.archetype + '|' + layout.format.id + '|' + layout.palette.bg + layout.palette.fg + '|' + layout.blocks.map(b => (b.kind[0]) + (b.role ? b.role[0] : '') + cell(b.x) + ',' + cell(b.y) + ',' + cell(b.w) + ',' + cell(b.h) + (b.kind === 'text' ? '/' + b.lines.length + ':' + b.font.size : '')).join(';');
  }

  // ---- Public API --------------------------------------------------------------------
  function archetypeWeights(intent, assets, content) {
    const n = assets.images.length;
    const e = intent.emphasis;
    let w = e === 'image'
      ? { 'full-bleed': 3, split: 3, poster: 2.2, mosaic: n >= 2 ? 2 : 0.3, 'color-block': 1, 'type-led': 0.5, editorial: 0.6, stat: 0.4 }
      : e === 'type'
        ? { 'type-led': 3, 'color-block': 2.5, editorial: 2, stat: 1.6, split: 1, poster: 0.5, 'full-bleed': 0.3, mosaic: 0.15 }
        : { 'type-led': 2, split: 2, poster: 1.5, 'full-bleed': 1.5, 'color-block': 2, editorial: 1.5, mosaic: n >= 2 ? 1 : 0.2, stat: 1 };
    if (!n) { w['full-bleed'] = 0; w.mosaic = 0; w.poster *= 0.6; w.split *= 0.7; }
    if (!content.stat) w.stat = 0;
    if (intent.archetypes && intent.archetypes.length) for (const k of Object.keys(w)) if (!intent.archetypes.includes(k)) w[k] = 0;
    return w;
  }

  function generate({ intent, kit, assets, format, seed, archetype: forced }) {
    const rng = RNG.make(seed);
    const g = Grid.compute(format, kit.grid);
    const content = { ...kit.content, ...(intent.content || {}) };
    if (!content.headline) return null;
    const radiusLevel = kit.grid.radius ?? 1;
    const ctx = { rng, g, kit, assets, intent, content, fmt: format, R: g.usableRows, r0: g.firstRow, radius: v => radiusLevel === 0 ? 0 : radiusLevel >= 3 ? Math.round(v * 4) : Math.round(v) };
    const pal = choosePalette(ctx);
    if (!pal) return null;
    ctx.pal = pal;
    // Type level from loudness, then step down if text refuses to fit.
    const loud = intent.loud ?? 0.5;
    const center = Math.round(loud * (H_LEVELS.length - 1));
    let level = Math.max(0, Math.min(H_LEVELS.length - 1, center + rng.int(-1, 1)));
    const weights = archetypeWeights(intent, assets, content);
    const items = Object.entries(weights).filter(([, w]) => w > 0).map(([v, w]) => ({ v, w }));
    if (!items.length) return null;
    const archetype = forced && weights[forced] !== undefined ? forced : rng.weighted(items);
    for (let tries = 0; tries < 3; tries++) {
      ctx.ts = typeSet(kit, g, Math.max(0, level - tries));
      const sub = RNG.make(seed ^ (tries * 0x9E3779B9));
      const localCtx = { ...ctx, rng: sub };
      const res = A[archetype](localCtx);
      if (!res) continue;
      const layout = {
        id: null, seed, archetype, archetypeLabel: ARCH_LABEL[archetype], format: { id: format.id, name: format.name, w: format.w, h: format.h },
        grid: { unit: g.unit, gutter: g.gutter, cols: g.cols, rows: g.rows, cw: g.cw, rh: g.rh, mx: g.mx, my: g.my, safe: g.safe },
        palette: { bg: pal.bg, bgName: pal.bgName, fg: pal.fg, accent: pal.accent },
        type: { level: ctx.ts.level, headline: ctx.ts.headline.size, body: ctx.ts.body.size, display: kit.fonts.display, body_font: kit.fonts.body },
        brand: kit.name, blocks: res.blocks, meta: res.meta || {},
      };
      const hl = res.blocks.find(b => b.role === 'headline'); if (hl && hl.fill) layout.palette.fg = hl.fill;
      const bad = validate(layout, g);
      if (bad) { layout.rejected = bad; continue; }
      layout.metrics = metrics(layout, g);
      layout.signature = signature(layout, g);
      layout.id = archetype.slice(0, 2).toUpperCase() + '-' + format.id.slice(0, 2).toUpperCase() + '-' + seed.toString(36);
      return layout;
    }
    return null;
  }

  // Generate a set: round-robin across formats, dedup by signature, cap attempts.
  function generateMany({ intent, kit, assets, formats, count, seedBase, onProgress }) {
    const out = []; const seen = new Set(); const rejections = {};
    let attempts = 0; const maxAttempts = count * 12;
    let seed = seedBase >>> 0;
    while (out.length < count && attempts < maxAttempts) {
      const format = formats[attempts % formats.length];
      seed = (seed + 0x9E3779B9) >>> 0;
      attempts++;
      const L = generate({ intent, kit, assets, format, seed });
      if (!L) continue;
      if (seen.has(L.signature)) continue;
      seen.add(L.signature); out.push(L);
      if (onProgress && out.length % 12 === 0) onProgress(out.length);
    }
    return { layouts: out, attempts };
  }

  return { generate, generateMany, ARCHETYPES, ARCH_LABEL, H_LEVELS, typeSet, logoAspect };
})();
