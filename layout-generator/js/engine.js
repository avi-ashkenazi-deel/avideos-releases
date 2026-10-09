/* The engine: structured randomization.
   Every variation is built from (seed, intent, brand kit, assets, format). The model of chance only chooses
   among moves the rules allow: which cells a block spans, which approved color pair, which type step, which anchor.
   Anything that breaks a rule (overflowing text, text off the safe area, unreadable contrast) is rejected. */
const Engine = (() => {
  const H_LEVELS = [0.055, 0.07, 0.09, 0.115, 0.145, 0.18];
  const ARCHETYPES = ['type-led', 'split', 'full-bleed', 'poster', 'mosaic', 'color-block', 'editorial', 'stat', 'agenda', 'comparison', 'process', 'cards', 'quote'];
  const ARCH_LABEL = {
    'type-led': 'Type-led', 'split': 'Split', 'full-bleed': 'Full-bleed image', 'poster': 'Framed image',
    'mosaic': 'Mosaic', 'color-block': 'Color blocks', 'editorial': 'Editorial', 'stat': 'Statement stat',
    'agenda': 'Agenda', 'comparison': 'Comparison', 'process': 'Process', 'cards': 'Cards', 'quote': 'Quote',
  };
  // Slide intents (deck mode) and the families that can express them.
  const SLIDE_INTENTS = ['cover', 'agenda', 'statement', 'stat', 'comparison', 'process', 'cards', 'quote', 'body', 'closing'];
  const INTENT_WEIGHTS = {
    cover: { 'type-led': 3, 'full-bleed': 3, split: 2, 'color-block': 1.5, poster: 1 },
    agenda: { agenda: 1 },
    statement: { 'type-led': 3, 'color-block': 1.5, editorial: 1 },
    stat: { stat: 1 },
    comparison: { comparison: 1 },
    process: { process: 1 },
    cards: { cards: 1 },
    quote: { quote: 1 },
    body: { editorial: 2, split: 1.5, poster: 1, 'type-led': 1 },
    closing: { 'type-led': 2, 'color-block': 1.5, 'full-bleed': 1 },
  };
  const normItems = arr => (arr || []).map((it, i) => typeof it === 'string' ? { title: it, text: '' } : { title: it.title || it.name || '', text: it.text || it.body || it.description || '', icon: it.icon, bullets: it.bullets }).filter(it => it.title || it.text);

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
      if (it.kind === 'icon' || it.kind === 'badge') { blocks.push({ ...it, w: it.h }); total += it.h; continue; }
      if (it.kind === 'list') {
        const res = fitList(it, region, g); if (!res) return null;
        blocks.push({ ...it, lines: res.lines, font: { ...it.font, size: res.size }, h: res.height, w: region.w, inkW: res.inkW, indent: res.indent, itemGap: res.itemGap, align: 'left' });
        total += res.height; continue;
      }
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
    const slack = Math.max(0, region.h - total);
    for (const b of blocks) {
      b.y = y; b.align = align; b.x = region.x;
      if (b.kind !== 'text') {
        if (align === 'center') b.x = snap(region.x + (region.w - b.w) / 2, 1);
        else if (align === 'right') b.x = region.x + region.w - b.w;
      }
      if (b.kind === 'text') b.capacity = textCapacity(b, region.w, slack);
      if (b.kind === 'list') b.capacity = { items: b.items.length, maxItems: b.items.length + Math.floor(slack / (b.font.size * (b.font.lineHeight || 1.3) * 1.6)), charsPerItem: Math.max(1, Math.floor((region.w - b.indent) / (Text.width(SAMPLE, b.font) / SAMPLE.length) * (b.maxLinesPerItem || 3) * 0.85)) };
      y += b.h + (b.gap || 0);
    }
    return { blocks, total, y0: blocks[0].y, y1: y - (blocks[blocks.length - 1].gap || 0) };
  }
  // Safe copy capacity for a fitted text block: how much text this box can take before the
  // layout breaks (its own lines plus the stack's free height), with a safety factor. The spec
  // carries it so a copy generator can be asked for text that fits instead of text that is cut.
  const SAMPLE = 'Run payroll in 150+ countries from one platform, with local experts and owned infrastructure.';
  function textCapacity(b, width, slack) {
    const f = b.font;
    const avgGlyph = Text.width(SAMPLE, f) / SAMPLE.length;
    const charsPerLine = Math.max(1, Math.floor(width / avgGlyph));
    const lineH = f.size * (f.lineHeight || 1.2);
    const maxLines = Math.max(b.lines.length, Math.min(b.maxLines || 12, b.lines.length + Math.floor(slack / lineH)));
    const currentChars = b.lines.join(' ').length;
    return { charsPerLine, maxLines, maxChars: Math.max(currentChars, Math.floor(charsPerLine * maxLines * 0.85)), currentChars };
  }
  // Fit a bulleted or numbered list: every item wraps at the indent, size steps down until all lines fit.
  function fitList(it, region, g) {
    const lh = it.font.lineHeight || 1.3; let size = it.font.size; const minSize = Math.max(10, size * 0.6); const step = Math.max(2, g.unit / 4);
    const n = it.items.length;
    while (size >= minSize) {
      const f = { ...it.font, size }; const indent = snap(size * (it.marker === 'number' ? 2.1 : 1.3), 2); const itemGap = Math.round(size * (it.itemGap ?? 0.4));
      const lines = []; let ok = true; let inkW = 0;
      for (let i = 0; i < n; i++) {
        const wrapped = Text.wrap(String(it.items[i]), f, region.w - indent);
        if (!wrapped || wrapped.length > (it.maxLinesPerItem || 3)) { ok = false; break; }
        wrapped.forEach((t, j) => { lines.push({ text: t, marker: j === 0 ? (it.marker === 'number' ? String(i + 1).padStart(2, '0') : it.marker === 'none' ? '' : '•') : null, last: j === wrapped.length - 1, markerFill: it.markerFill, markerBold: it.marker === 'number' }); inkW = Math.max(inkW, indent + Text.width(t, f)); });
      }
      if (ok) { const height = lines.length * size * lh + (n - 1) * itemGap; if (height <= region.h) return { size, lines, height: snap(height, g.unit / 2) || height, inkW: Math.min(region.w, inkW), indent, itemGap }; }
      size -= step;
    }
    return null;
  }
  // Ink rect of a text stack (what other things must avoid).
  function inkRect(stack, region, align) {
    let x0 = region.x + region.w, x1 = region.x;
    for (const b of stack.blocks) {
      let w = (b.kind === 'text' || b.kind === 'list') ? b.inkW : b.w, x;
      if (b.kind === 'text') x = align === 'center' ? region.x + (region.w - w) / 2 : align === 'right' ? region.x + region.w - w : region.x;
      else if (b.kind === 'list') x = region.x;
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
    if (content.cta && intent.includeCta !== false && (intent.ctaAlways || rng.chance(opts.cta ?? P[3]))) {
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
    let pair = rng.weighted(pool.map(p => ({ v: p, w: p.bgRole === 'background' ? (intent.loud > 0.6 ? 1 : 2) : (intent.loud > 0.4 ? 2.2 : 1) })));
    const lock = intent.lockPalette;
    if (lock && lock.bg) { const found = pairs.find(p => p.bg === Color.normalize(lock.bg)); if (found) pair = found; }
    const fg = lock && lock.fg && pair.fgs.includes(Color.normalize(lock.fg)) ? Color.normalize(lock.fg) : pair.fgs[0];
    const fgAlt = !lock && pair.fgs.length > 1 && rng.chance(0.3) ? pair.fgs[1] : fg;
    let accent = lock && lock.accent && pair.accents.includes(Color.normalize(lock.accent)) ? Color.normalize(lock.accent) : rng.pick(pair.accents);
    if (intent.colorHints && intent.colorHints.length) { const a = pair.accents.filter(x => intent.colorHints.includes(x) && x !== pair.bg); if (a.length) accent = rng.pick(a); }
    const onAccent = Color.contrast(accent, '#FFFFFF') >= Color.contrast(accent, '#000000') ? '#FFFFFF' : '#000000';
    const accentText = Color.contrast(pair.bg, accent) >= 4.5 ? accent : fg;
    const fields = pair.fields.filter(f => f !== accent);
    const card = Color.mix(pair.bg, fg, pair.dark ? 0.1 : 0.06);
    const accentCard = (fields.find(f => Color.contrast(f, pair.bg) >= 1.3) || accent);
    const accentCardText = Color.bestForeground(accentCard, kit.colors.map(c => Color.normalize(c.hex)).concat(['#FFFFFF', '#000000']), 4.5)[0];
    return { bg: pair.bg, bgName: pair.bgName, fg: fgAlt, fg2: Color.mix(fg, pair.bg, 0.12), accent, onAccent, accentText, fields: fields.length ? fields : pair.fields, dark: pair.dark, pair, card, cardStroke: Color.mix(pair.bg, fg, 0.18), accentCard, accentCardText };
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
    const order = [...(intent.logoPrefer || []), ...(prefer || []), 'TL', 'BL', 'TR', 'BR', 'TC', 'BC'].filter((v, i, a) => a.indexOf(v) === i);
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


  // ---- Deck families -----------------------------------------------------------------
  // A card: a surface rect plus an inner stack. Returns blocks or null.
  function card(ctx, r, items, opts = {}) {
    const { g } = ctx;
    const pad = opts.pad ?? g.unit * 3;
    const region = { x: r.x + pad, y: r.y + pad, w: r.w - 2 * pad, h: r.h - 2 * pad };
    if (region.w < g.unit * 6 || region.h < g.unit * 4) return null;
    const stack = buildStack(items, region, opts.align || 'left', opts.valign || 'top', g);
    if (!stack) return null;
    const surface = opts.plain ? [] : [{ kind: 'field', x: r.x, y: r.y, w: r.w, h: r.h, fill: opts.fill, radius: opts.radius ?? ctx.radius(g.unit * 2), container: true, stroke: opts.stroke }];
    return [...surface, ...stack.blocks];
  }
  function headlineRegion(ctx, rows, cs, c0 = 0) {
    return Grid.rect(ctx.g, c0, ctx.r0, cs, rows);
  }
  function cardPal(ctx, highlighted) {
    const { pal } = ctx;
    if (highlighted) return { fill: pal.accentCard, fg: pal.accentCardText, fg2: Color.mix(pal.accentCardText, pal.accentCard, 0.15), accentText: pal.accentCardText };
    return { fill: pal.card, fg: pal.fg, fg2: pal.fg2, accentText: pal.accentText };
  }
  function iconOrBadge(ctx, cp, i, text, mode) {
    const { ts, g } = ctx;
    const h = snap(ts.body.size * 1.9, g.unit);
    if (mode === 'icon') return { kind: 'icon', name: Icons.forText(text, i), h, fill: cp.accentText, gap: snap(ts.body.size * 0.8, g.unit) };
    if (mode === 'badge') return { kind: 'badge', text: String(i + 1), h, fill: ctx.pal.accent, color: ctx.pal.onAccent, font: ts.cta, gap: snap(ts.body.size * 0.8, g.unit) };
    return null;
  }

  A['agenda'] = ctx => {
    const { g, rng, pal, ts, content } = ctx;
    const raw = content.items && content.items.length ? normItems(content.items).map(i => i.title) : (content.bullets || []);
    const items = raw.filter(Boolean).slice(0, 8);
    if (items.length < 2) return null;
    const C = g.cols, R = ctx.R, wide = g.w >= g.h;
    const head = [{ kind: 'text', role: 'eyebrow', path: 'eyebrow', text: content.eyebrow || '', font: ts.eyebrow, fill: pal.accentText, maxLines: 1, gap: snap(ts.headline.size * 0.4, g.unit) }].filter(i => i.text);
    head.push({ kind: 'text', role: 'headline', path: 'headline', text: content.headline || 'Agenda', font: ts.headline, fill: pal.fg, maxLines: 3 });
    const listItem = { kind: 'list', role: 'items', path: 'items', items, marker: rng.chance(0.75) ? 'number' : 'bullet', font: { ...ts.subhead, size: snapFont(ts.subhead.size * 1.15, g.unit), lineHeight: 1.25, weight: nearestWeight(ctx.kit.fonts.body, 500) }, fill: pal.fg, markerFill: pal.accentText, maxLinesPerItem: 2, itemGap: 0.55 };
    const blocks = []; let avoid = [];
    if (wide) {
      const k = Math.max(3, Math.round(C * rng.pick([0.36, 0.42])));
      const hr = Grid.rect(g, 0, ctx.r0, k, R - 1);
      const hs = buildStack(head, hr, 'left', rng.pick(['top', 'center']), g); if (!hs) return null;
      const lr = Grid.rect(g, k + 1, ctx.r0, C - k - 1, R - 1);
      const ls = buildStack([listItem], lr, 'left', rng.pick(['top', 'center']), g); if (!ls) return null;
      blocks.push(...hs.blocks, ...ls.blocks); avoid = [inkRect(hs, hr, 'left'), inkRect(ls, lr, 'left')];
    } else {
      const hr = Grid.rect(g, 0, ctx.r0, C, 2);
      const hs = buildStack(head, hr, 'left', 'top', g); if (!hs) return null;
      const lr = Grid.rect(g, 0, ctx.r0 + 2, C, R - 3);
      const ls = buildStack([listItem], lr, 'left', 'top', g); if (!ls) return null;
      blocks.push(...hs.blocks, ...ls.blocks); avoid = [inkRect(hs, hr, 'left'), inkRect(ls, lr, 'left')];
    }
    const logo = placeLogo(ctx, avoid, ['BL', 'BR', 'TR']); if (logo) { blocks.push(logo); avoid.push(logo); }
    const foot = footerBlock(ctx, avoid, logo); if (foot) blocks.push(foot);
    return { blocks, meta: { items: items.length, marker: listItem.marker } };
  };

  A['comparison'] = ctx => {
    const { g, rng, pal, ts, content } = ctx;
    let cols = normItems(content.columns);
    if (cols.length < 2) { const it = normItems(content.items); if (it.length >= 2) cols = it.slice(0, 2); }
    if (cols.length < 2 && content.bullets && content.bullets.length >= 4) { const h = Math.ceil(content.bullets.length / 2); cols = [{ title: 'Before', bullets: content.bullets.slice(0, h) }, { title: 'After', bullets: content.bullets.slice(h) }]; }
    if (cols.length < 2 || !content.headline) return null;
    const C = g.cols, R = ctx.R;
    if (R < 4) return null;
    const headRows = 2;
    const hr = headlineRegion(ctx, headRows, rng.pick([C, Math.round(C * 0.75)]));
    const hs = buildStack([{ kind: 'text', role: 'headline', path: 'headline', text: content.headline, font: { ...ts.headline, size: snapFont(ts.headline.size * 0.85, g.unit) }, fill: pal.fg, maxLines: 2 }], hr, 'left', 'top', g);
    if (!hs) return null;
    const plain = rng.chance(0.3); const highlight = !plain && rng.chance(0.55);
    const k = Math.floor(C / 2); const rows = R - headRows;
    const rects = [Grid.rect(g, 0, ctx.r0 + headRows, k, rows), Grid.rect(g, C - k, ctx.r0 + headRows, k, rows)];
    const blocks = [...hs.blocks]; const avoid = [inkRect(hs, hr, 'left')];
    cols.slice(0, 2).forEach((col, i) => {
      const cp = cardPal(ctx, highlight && i === 1);
      const items = [{ kind: 'text', role: 'title', path: `columns.${i}.title`, text: col.title, font: { ...ts.subhead, weight: nearestWeight(ctx.kit.fonts.body, 600) }, fill: cp.fg, maxLines: 2, gap: snap(ts.body.size * 0.8, g.unit) }];
      if (col.bullets && col.bullets.length) items.push({ kind: 'list', role: 'bullets', path: `columns.${i}.bullets`, items: col.bullets.slice(0, 6), marker: 'bullet', font: ts.body, fill: cp.fg2, markerFill: cp.accentText, maxLinesPerItem: 3 });
      else if (col.text) items.push({ kind: 'text', role: 'text', path: `columns.${i}.text`, text: col.text, font: ts.body, fill: cp.fg2, maxLines: 8 });
      const b = card(ctx, rects[i], items, { plain, fill: cp.fill, pad: plain ? 0 : g.unit * 3 });
      if (!b) { blocks.length = 0; return; }
      blocks.push(...b); avoid.push(rects[i]);
    });
    if (!blocks.length) return null;
    if (plain) { const r0 = rects[0]; blocks.push({ kind: 'line', x: r0.x + r0.w + g.gutter / 2 + (rects[1].x - r0.x - r0.w - g.gutter) / 2, y: r0.y, w: 0, h: r0.h, fill: pal.cardStroke, width: 2 }); }
    const logo = placeLogo(ctx, avoid, ['TR']); if (logo) blocks.push(logo);
    return { blocks, meta: { plain, highlight } };
  };

  A['process'] = ctx => {
    const { g, rng, pal, ts, content } = ctx;
    let steps = normItems(content.steps); if (steps.length < 3) steps = normItems(content.items);
    steps = steps.slice(0, 5);
    if (steps.length < 3 || !content.headline) return null;
    const C = g.cols, R = ctx.R, wide = g.w >= g.h * 1.2;
    const n = steps.length;
    const mode = rng.weighted([{ v: 'badge', w: 3 }, { v: 'icon', w: 2 }]);
    const blocks = []; const avoid = [];
    const hr = headlineRegion(ctx, 2, rng.pick([C, Math.round(C * 0.7)]));
    const hs = buildStack([{ kind: 'text', role: 'headline', path: 'headline', text: content.headline, font: { ...ts.headline, size: snapFont(ts.headline.size * 0.85, g.unit) }, fill: pal.fg, maxLines: 2 }], hr, 'left', 'top', g);
    if (!hs) return null;
    blocks.push(...hs.blocks); avoid.push(inkRect(hs, hr, 'left'));
    if (wide && R >= 4) {
      const per = Math.floor(C / n); const used = per * n; const c0 = Math.floor((C - used) / 2);
      const rows = R - 2 - (R > 5 ? 1 : 0);
      const stepBlocks = []; let badgeY = null, firstX = null, lastX = null;
      for (let i = 0; i < n; i++) {
        const r = Grid.rect(g, c0 + i * per, ctx.r0 + 2, per, rows); r.w -= g.gutter; // breathing room between steps
        const cp = cardPal(ctx, false);
        const items = [iconOrBadge(ctx, cp, i, steps[i].title + ' ' + steps[i].text, mode), { kind: 'text', role: 'title', path: `steps.${i}.title`, text: steps[i].title, font: { ...ts.subhead, weight: nearestWeight(ctx.kit.fonts.body, 600) }, fill: pal.fg, maxLines: 2, gap: snap(ts.body.size * 0.5, g.unit) }];
        if (steps[i].text) items.push({ kind: 'text', role: 'text', path: `steps.${i}.text`, text: steps[i].text, font: ts.body, fill: pal.fg2, maxLines: 4 });
        const st = buildStack(items.filter(Boolean), r, 'left', 'top', g); if (!st) return null;
        const badge = st.blocks[0]; if (badge && badge.kind === 'badge') { badgeY = badge.y + badge.h / 2; firstX = firstX ?? badge.x + badge.w; lastX = badge.x; }
        stepBlocks.push(...st.blocks); avoid.push(r);
      }
      if (badgeY != null && n > 1 && rng.chance(0.7)) blocks.push({ kind: 'line', x: firstX, y: badgeY, w: lastX - firstX, h: 0, fill: pal.cardStroke, width: 2, dash: '8 8' });
      blocks.push(...stepBlocks);
    } else {
      const rows = R - 2; const r = Grid.rect(g, 0, ctx.r0 + 2, C, rows);
      const badgeH = snap(ts.body.size * 1.9, g.unit); const gutter = g.unit * 2;
      const stepH = Math.floor(r.h / n);
      for (let i = 0; i < n; i++) {
        const region = { x: r.x + badgeH + gutter * 2, y: r.y + i * stepH, w: r.w - badgeH - gutter * 2, h: stepH - g.unit };
        const items = [{ kind: 'text', role: 'title', path: `steps.${i}.title`, text: steps[i].title, font: { ...ts.subhead, weight: nearestWeight(ctx.kit.fonts.body, 600) }, fill: pal.fg, maxLines: 2, gap: snap(ts.body.size * 0.4, g.unit) }];
        if (steps[i].text) items.push({ kind: 'text', role: 'text', path: `steps.${i}.text`, text: steps[i].text, font: ts.body, fill: pal.fg2, maxLines: 3 });
        const st = buildStack(items, region, 'left', 'top', g); if (!st) return null;
        const b = iconOrBadge(ctx, cardPal(ctx, false), i, steps[i].title, mode); b.x = r.x; b.y = region.y; b.w = b.h;
        if (i < n - 1) blocks.push({ kind: 'line', x: r.x + badgeH / 2, y: region.y + badgeH, w: 0, h: stepH - badgeH, fill: pal.cardStroke, width: 2, dash: '8 8' });
        blocks.push(b, ...st.blocks); avoid.push({ x: r.x, y: region.y, w: r.w, h: stepH });
      }
    }
    const logo = placeLogo(ctx, avoid, ['TR', 'BR']); if (logo) blocks.push(logo);
    return { blocks, meta: { steps: n, mode, wide } };
  };

  A['cards'] = ctx => {
    const { g, rng, pal, ts, content } = ctx;
    const items = normItems(content.items).slice(0, 6);
    if (items.length < 2 || !content.headline) return null;
    const C = g.cols, R = ctx.R, wide = g.w >= g.h * 1.2, tall = g.h > g.w * 1.3;
    const n = Math.min(items.length, wide ? 4 : tall ? 3 : 4);
    const list = items.slice(0, n);
    const mode = rng.weighted([{ v: 'icon', w: 3 }, { v: 'badge', w: 1 }, { v: 'none', w: 1 }]);
    const highlight = rng.chance(0.35) ? rng.int(0, n - 1) : -1;
    const blocks = []; const avoid = [];
    const headItems = [{ kind: 'text', role: 'headline', path: 'headline', text: content.headline, font: { ...ts.headline, size: snapFont(ts.headline.size * 0.85, g.unit) }, fill: pal.fg, maxLines: 2, gap: snap(ts.subhead.size * 0.6, g.unit) }];
    if (content.subhead && rng.chance(0.5)) headItems.push({ kind: 'text', role: 'subhead', path: 'subhead', text: content.subhead, font: ts.subhead, fill: pal.fg2, maxLines: 2 });
    const headRows = wide ? 2 : 2;
    const hr = headlineRegion(ctx, headRows, rng.pick([C, Math.round(C * 0.75)]));
    const hs = buildStack(headItems, hr, 'left', 'top', g); if (!hs) return null;
    blocks.push(...hs.blocks); avoid.push(inkRect(hs, hr, 'left'));
    // grid of cards
    let rects = [];
    if (wide || (!tall && n <= 2)) { const per = Math.floor(C / n); const c0 = Math.floor((C - per * n) / 2); const rows = R - headRows; for (let i = 0; i < n; i++) rects.push(Grid.rect(g, c0 + i * per, ctx.r0 + headRows, per, rows)); }
    else if (!tall) { const per = Math.floor(C / 2); const rowsEach = Math.floor((R - headRows) / 2); for (let i = 0; i < n; i++) rects.push(Grid.rect(g, (i % 2) * (C - per), ctx.r0 + headRows + Math.floor(i / 2) * rowsEach, per, rowsEach)); }
    else { const rowsEach = Math.floor((R - headRows) / n); for (let i = 0; i < n; i++) rects.push(Grid.rect(g, 0, ctx.r0 + headRows + i * rowsEach, C, rowsEach)); }
    for (let i = 0; i < n; i++) {
      const cp = cardPal(ctx, i === highlight);
      const ib = iconOrBadge(ctx, cp, i, list[i].title + ' ' + list[i].text, mode === 'none' ? null : mode);
      const its = [ib, { kind: 'text', role: 'title', path: `items.${i}.title`, text: list[i].title, font: { ...ts.subhead, weight: nearestWeight(ctx.kit.fonts.body, 600) }, fill: cp.fg, maxLines: 2, gap: snap(ts.body.size * 0.45, g.unit) }].filter(Boolean);
      if (list[i].text) its.push({ kind: 'text', role: 'text', path: `items.${i}.text`, text: list[i].text, font: ts.body, fill: cp.fg2, maxLines: 5 });
      const r = { ...rects[i] }; if (rects.length > 1 && (wide || !tall)) r.w -= 0; 
      const b = card(ctx, r, its, { fill: cp.fill, valign: tall ? 'center' : 'top' }); if (!b) return null;
      blocks.push(...b); avoid.push(r);
    }
    const logo = placeLogo(ctx, avoid, ['TR', 'BR']); if (logo) blocks.push(logo);
    return { blocks, meta: { cards: n, mode, highlight: highlight >= 0 } };
  };

  A['quote'] = ctx => {
    const { g, rng, pal, ts, content } = ctx;
    if (!content.quote) return null;
    const C = g.cols, R = ctx.R;
    const align = rng.weighted([{ v: 'left', w: 2 }, { v: 'center', w: 2 }]);
    const img = ctx.assets.images.length && g.w >= g.h && rng.chance(0.4) ? pickImage(ctx) : null;
    const blocks = []; let region, k = 0;
    if (img) { k = Math.round(C * 0.4); const r = Grid.rect(g, 0, ctx.r0, k, R); blocks.push(imageBlock(ctx, r, img, ctx.radius(g.unit * 2))); region = Grid.rect(g, k + 1, ctx.r0 + 1, C - k - 1, R - 2); }
    else { const cs = align === 'center' ? Math.round(C * 0.8) : Math.round(C * 0.75); const c0 = align === 'center' ? Math.floor((C - cs) / 2) : 0; region = Grid.rect(g, c0, ctx.r0 + 1, cs, R - 2); }
    const quoteFont = { ...ts.headline, size: snapFont(ts.headline.size * 0.8, g.unit), weight: nearestWeight(ctx.kit.fonts.display, (ctx.kit.fonts.displayWeight || 600) - 100), lineHeight: 1.15 };
    const items = [];
    if (rng.chance(0.7)) items.push({ kind: 'text', role: 'mark', text: '\u201C', font: { ...ts.headline, size: snapFont(ts.headline.size * 1.6, g.unit), lineHeight: 0.7 }, fill: pal.accentText, maxLines: 1, gap: 0, decorative: true });
    items.push({ kind: 'text', role: 'quote', path: 'quote', text: content.quote, font: quoteFont, fill: pal.fg, maxLines: 6, gap: snap(ts.body.size * 1.2, g.unit) });
    if (content.attribution) items.push({ kind: 'text', role: 'attribution', path: 'attribution', text: content.attribution, font: ts.eyebrow, fill: pal.fg2, maxLines: 2 });
    const stack = buildStack(items, region, img ? 'left' : align, 'center', g); if (!stack) return null;
    blocks.push(...stack.blocks);
    const avoid = [inkRect(stack, region, img ? 'left' : align), ...(img ? [blocks[0]] : [])];
    const logo = placeLogo(ctx, avoid, align === 'center' ? ['BC', 'BL'] : ['BL', 'TL']); if (logo && !(img && inter(logo, blocks[0]))) blocks.push(logo);
    return { blocks, meta: { align, image: !!img } };
  };

  // ---- Validation and metrics ------------------------------------------------------
  function validate(layout, g) {
    const texts = layout.blocks.filter(b => b.kind === 'text' || b.kind === 'list' || b.kind === 'button' || b.kind === 'logo' || b.kind === 'badge');
    const s = g.safe;
    for (const t of texts) {
      const r = { x: t.x, y: t.y, w: (t.kind === 'text' || t.kind === 'list') ? (t.inkW || t.w) : t.w, h: t.h };
      if (t.kind === 'text' && t.align === 'center') r.x = t.x + (t.w - r.w) / 2;
      if (t.kind === 'text' && t.align === 'right') r.x = t.x + t.w - r.w;
      if (r.x < s.left - 1 || r.y < s.top - 1 || r.x + r.w > g.w - s.right + 1 || r.y + r.h > g.h - s.bottom + 1) return 'outside safe area: ' + t.role;
      for (const o of texts) if (o !== t) {
        const ro = { x: o.x, y: o.y, w: (o.kind === 'text' || o.kind === 'list') ? (o.inkW || o.w) : o.w, h: o.h };
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
      if (topField && !topImage && (t.kind === 'text' || t.kind === 'list') && t.fill && Color.contrast(topField.fill, t.fill) < (t.role === 'headline' || t.role === 'stat' || t.role === 'mark' ? 3 : 4.5) && !topField.alpha) return 'low contrast on field: ' + t.role;
    }
    return null;
  }
  function metrics(layout, g) {
    const total = g.w * g.h;
    let ink = 0, sx = 0, sy = 0, sw = 0, textInk = 0;
    for (const b of layout.blocks) {
      if (b.kind === 'scrim') continue;
      const r = { x: b.x, y: b.y, w: (b.kind === 'text' || b.kind === 'list') ? (b.inkW || b.w) : b.w, h: b.h };
      const a = Math.min(total, area({ x: Math.max(0, r.x), y: Math.max(0, r.y), w: Math.min(g.w, r.x + r.w) - Math.max(0, r.x), h: Math.min(g.h, r.y + r.h) - Math.max(0, r.y) }));
      if (b.kind === 'text' || b.kind === 'list' || b.kind === 'button' || b.kind === 'logo') { textInk += a; sx += (r.x + r.w / 2) * a; sy += (r.y + r.h / 2) * a; sw += a; }
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
    return layout.archetype + '|' + layout.format.id + '|' + layout.palette.bg + layout.palette.fg + '|' + layout.blocks.map(b => (b.kind[0]) + (b.role ? b.role[0] : '') + cell(b.x) + ',' + cell(b.y) + ',' + cell(b.w) + ',' + cell(b.h) + ((b.kind === 'text' || b.kind === 'list') ? '/' + b.lines.length + ':' + b.font.size : '')).join(';');
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
    if (intent.slideIntent && INTENT_WEIGHTS[intent.slideIntent]) {
      const iw = INTENT_WEIGHTS[intent.slideIntent]; for (const k of Object.keys(w)) w[k] = 0; for (const k of Object.keys(iw)) w[k] = iw[k];
      for (const k of ['agenda', 'comparison', 'process', 'cards', 'quote']) if (!(k in w)) w[k] = 0;
    } else { for (const k of ['agenda', 'comparison', 'process', 'cards', 'quote']) w[k] = (intent.archetypes && intent.archetypes.includes(k)) ? 1 : 0; }
    if (!n) { w['full-bleed'] = 0; w.mosaic = 0; w.poster *= 0.6; w.split *= 0.7; }
    if (!content.stat) w.stat = 0;
    if (!content.quote) w.quote = 0;
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
    let level = intent.level != null ? Math.max(0, Math.min(H_LEVELS.length - 1, intent.level)) : Math.max(0, Math.min(H_LEVELS.length - 1, center + rng.int(-1, 1)));
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
      layout.slideIntent = intent.slideIntent || null;
      let imgN = 0;
      for (const b of layout.blocks) {
        if (b.kind === 'image') { b.decorative = false; b.path = b.path || `image_${++imgN}`; }
        else if (b.kind === 'text' || b.kind === 'list' || b.kind === 'button') { b.decorative = !!b.decorative; if (!b.path && b.role) b.path = b.role; }
        else b.decorative = true;
      }
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

  // Content schema: every editable block becomes a field; dotted paths with indices become arrays.
  function contentSchema(layout) {
    const root = { type: 'object', additionalProperties: false, properties: {}, required: [] };
    const ensure = (node, key, isArray) => {
      if (!node.properties[key]) node.properties[key] = isArray ? { type: 'array', items: { type: 'object', additionalProperties: false, properties: {}, required: [] }, maxItems: 0 } : { type: 'object', additionalProperties: false, properties: {}, required: [] };
      if (!node.required.includes(key)) node.required.push(key);
      return node.properties[key];
    };
    for (const b of layout.blocks) {
      if (b.decorative || !b.path) continue;
      const parts = b.path.split('.');
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i]; const nextIsIndex = /^\d+$/.test(parts[i + 1]);
        if (/^\d+$/.test(key)) continue;
        const child = ensure(node, key, nextIsIndex);
        if (nextIsIndex) { child.maxItems = Math.max(child.maxItems, +parts[i + 1] + 1); node = child.items; } else node = child;
      }
      const leaf = parts[parts.length - 1];
      let field;
      if (b.kind === 'list') field = { type: 'array', items: { type: 'string' }, description: `${leaf}: ${b.capacity.items} items (up to ${b.capacity.maxItems}), each up to ${b.capacity.charsPerItem} characters` };
      else if (b.kind === 'image') field = { type: 'string', description: `Image prompt for a ${Math.round(b.w)}×${Math.round(b.h)} area` };
      else if (b.kind === 'button') field = { type: 'string', description: `${leaf}: button label, up to 24 characters` };
      else field = { type: 'string', description: `${leaf}: up to ${b.capacity ? b.capacity.maxChars : 80} characters, ${b.capacity ? b.capacity.maxLines : 2} lines` };
      if (leaf === 'eyebrow' || leaf === 'footer') field.description += ' (optional, may be empty)';
      node.properties[leaf] = field; if (!node.required.includes(leaf)) node.required.push(leaf);
    }
    return root;
  }
  // Apply new copy to an existing layout: same seed, same moves, text refitted. Null when it no longer fits.
  function hydrate(layout, content, env) {
    const intent = { ...env.intent, content: { ...(env.intent.content || {}), ...content }, lockPalette: layout.palette, level: layout.type.level, slideIntent: layout.slideIntent };
    return generate({ intent, kit: env.kit, assets: env.assets, format: Grid.byId[layout.format.id], seed: layout.seed, archetype: layout.archetype });
  }
  function palettePick(kit, intent, seed) {
    const pal = choosePalette({ rng: RNG.make(seed), kit, intent });
    return pal ? { bg: pal.bg, fg: pal.fg, accent: pal.accent, bgName: pal.bgName } : null;
  }
  return { generate, generateMany, ARCHETYPES, ARCH_LABEL, SLIDE_INTENTS, INTENT_WEIGHTS, H_LEVELS, typeSet, logoAspect, contentSchema, hydrate, palettePick, normItems };
})();
