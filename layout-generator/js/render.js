/* Layout spec -> SVG. Also PNG and PDF export with fonts and images embedded.
   Every value that reaches markup is coerced or escaped: in a shared canvas, layout JSON comes from other people. */
const Render = (() => {
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const n = v => { const x = Math.round(Number(v) * 100) / 100; return Number.isFinite(x) ? x : 0; };
  const clamp01 = v => Math.max(0, Math.min(1, Number(v)));
  const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%a-z]+\)|[a-zA-Z]{3,24})$/;
  const col = (v, d = '#000000') => (typeof v === 'string' && COLOR_RE.test(v.trim())) ? v.trim() : d;
  const fam = f => Text.quote(String((f && f.family) || 'sans-serif')).replace(/['<>&]/g, '');
  const FOCAL = new Set(['xMinYMin', 'xMidYMin', 'xMaxYMin', 'xMinYMid', 'xMidYMid', 'xMaxYMid', 'xMinYMax', 'xMidYMax', 'xMaxYMax']);
  const PATH_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]*$/;

  // ---- SVG markup from outside (Figma vectors, captured pages): allowlist elements and attributes ----------------
  const SVG_TAGS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'title', 'text', 'tspan', 'use', 'symbol', 'pattern']);
  const SVG_ATTRS = /^(d|x|y|x1|y1|x2|y2|cx|cy|r|rx|ry|width|height|points|fill|fill-rule|fill-opacity|stroke|stroke-width|stroke-linecap|stroke-linejoin|stroke-miterlimit|stroke-dasharray|stroke-dashoffset|stroke-opacity|opacity|transform|viewbox|preserveaspectratio|id|clip-path|clip-rule|mask|offset|stop-color|stop-opacity|gradientunits|gradienttransform|spreadmethod|fx|fy|font-family|font-size|font-weight|font-style|text-anchor|dominant-baseline|letter-spacing|href|xlink:href|patternunits|patterncontentunits|maskunits|maskcontentunits|clippathunits|style|visibility|display|vector-effect|overflow|color)$/i;
  const svgCache = new Map();
  function sanitizeSvgInner(markup) {
    markup = String(markup || ''); if (!markup) return '';
    if (svgCache.has(markup)) return svgCache.get(markup);
    let out = '';
    try {
      const d = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">${markup}</svg>`, 'image/svg+xml');
      if (!d.querySelector('parsererror')) {
        const walk = el => {
          for (const c of [...el.children]) {
            if (!SVG_TAGS.has(c.localName.toLowerCase())) { c.remove(); continue; }
            for (const a of [...c.attributes]) {
              const v = a.value; const nm = a.name;
              if (!SVG_ATTRS.test(nm) || /^on/i.test(nm) || /javascript:|data:text\/html/i.test(v)) { c.removeAttribute(nm); continue; }
              if (/href$/i.test(nm) && !/^#/.test(v.trim())) c.removeAttribute(nm);
              if (nm.toLowerCase() === 'style' && /url\(\s*['"]?(?!#)|expression|@import|behavior/i.test(v)) c.removeAttribute(nm);
            }
            walk(c);
          }
        };
        walk(d.documentElement);
        const ser = new XMLSerializer(); out = [...d.documentElement.childNodes].map(x => ser.serializeToString(x)).join('');
      }
    } catch { out = ''; }
    if (svgCache.size > 400) svgCache.clear();
    svgCache.set(markup, out);
    return out;
  }

  // ---- Paint and effects -------------------------------------------------------------------------------------
  function gradientDef(g, id) {
    const stops = (Array.isArray(g.stops) ? g.stops : []).slice(0, 8).map(st => `<stop offset="${n(clamp01(st.p ?? 0))}" stop-color="${col(st.c)}"${st.a != null && st.a < 1 ? ` stop-opacity="${n(clamp01(st.a))}"` : ''}/>`).join('');
    if (g.type === 'radial') return `<radialGradient id="${id}" cx="0.5" cy="0.5" r="0.7">${stops}</radialGradient>`;
    const a = (Number(g.angle) || 0) * Math.PI / 180; const dx = Math.sin(a), dy = -Math.cos(a);
    return `<linearGradient id="${id}" x1="${n(0.5 - dx / 2)}" y1="${n(0.5 - dy / 2)}" x2="${n(0.5 + dx / 2)}" y2="${n(0.5 + dy / 2)}">${stops}</linearGradient>`;
  }
  // Fill for a block: a gradient when it has one, else its solid color.
  function paint(b, ctx, key = 'fill') {
    if (key === 'fill' && b.gradient && Array.isArray(b.gradient.stops) && b.gradient.stops.length >= 2) { const id = ctx.id('p'); ctx.defs.push(gradientDef(b.gradient, id)); return `url(#${id})`; }
    return col(b[key]);
  }
  function strokeAttr(b) { const s = b.stroke; if (!s || !(Number(s.width) > 0)) return ''; return ` stroke="${col(s.color, '#000000')}" stroke-width="${n(s.width)}"${s.dash ? ` stroke-dasharray="${n(s.width) * 3} ${n(s.width) * 2}"` : ''}`; }
  // Opacity, drop shadow and rotation wrap the element in a group.
  function fx(b, el, ctx) {
    let attrs = '';
    if (b.opacity != null && Number(b.opacity) < 1) attrs += ` opacity="${n(clamp01(b.opacity))}"`;
    const s = b.shadow;
    if (s && s.on !== false && (Number(s.blur) || Number(s.x) || Number(s.y))) {
      const id = ctx.id('s');
      ctx.defs.push(`<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="${n(s.x || 0)}" dy="${n(s.y || 0)}" stdDeviation="${n((Number(s.blur) || 0) / 2)}" flood-color="${col(s.color, '#000000')}" flood-opacity="${n(clamp01(s.alpha ?? 0.25))}"/></filter>`);
      attrs += ` filter="url(#${id})"`;
    }
    if (Number(b.rotation)) attrs += ` transform="rotate(${n(b.rotation)} ${n(b.x + b.w / 2)} ${n(b.y + b.h / 2)})"`;
    return attrs ? `<g${attrs}>${el}</g>` : el;
  }

  function textEl(b, ctx) {
    const f = b.font || {};
    const anchor = b.align === 'center' ? 'middle' : b.align === 'right' ? 'end' : 'start';
    const x = b.align === 'center' ? b.x + b.w / 2 : b.align === 'right' ? b.x + b.w : b.x;
    const size = n(f.size || 16); const lh = size * (Number(f.lineHeight) || 1.2);
    const first = b.y + size * 0.78 + (lh - size) / 2;
    const ls = f.letterSpacing ? ` letter-spacing="${n(f.letterSpacing * size)}"` : '';
    const it = f.style === 'italic' ? ' font-style="italic"' : '';
    const deco = b.decoration === 'underline' || b.decoration === 'line-through' ? ` text-decoration="${b.decoration}"` : '';
    const spans = (b.lines || []).map((line, i) => `<tspan x="${n(x)}" y="${n(first + i * lh)}">${esc(typeof line === 'string' ? line : line.text)}</tspan>`).join('');
    return `<text font-family='${fam(f)}' font-size="${size}" font-weight="${n(f.weight || 400)}"${it}${deco} fill="${paint(b, ctx)}" text-anchor="${anchor}"${ls}>${spans}</text>`;
  }
  function listEl(b, ctx) {
    const f = b.font || {}; const size = n(f.size || 16);
    const lh = size * (Number(f.lineHeight) || 1.3);
    const first = b.y + size * 0.78 + (lh - size) / 2;
    const ls = f.letterSpacing ? ` letter-spacing="${n(f.letterSpacing * size)}"` : '';
    const parts = []; let yy = first;
    for (const line of (b.lines || [])) {
      if (line.marker != null) parts.push(`<tspan x="${n(b.x)}" y="${n(yy)}"${line.markerFill ? ` fill="${col(line.markerFill)}"` : ''}${line.markerBold ? ' font-weight="700"' : ''}>${esc(line.marker)}</tspan>`);
      parts.push(`<tspan x="${n(b.x + (b.indent || 0))}" y="${n(yy)}">${esc(line.text)}</tspan>`);
      yy += lh + (line.last ? (b.itemGap || 0) : 0);
    }
    return `<text font-family='${fam(f)}' font-size="${size}" font-weight="${n(f.weight || 400)}" fill="${paint(b, ctx)}" text-anchor="start"${ls}>${parts.join('')}</text>`;
  }
  function badgeEl(b) {
    const r = Math.min(b.w, b.h) / 2; const size = b.h * 0.46;
    return `<circle cx="${n(b.x + r)}" cy="${n(b.y + r)}" r="${n(r)}" fill="${col(b.fill)}"/><text x="${n(b.x + r)}" y="${n(b.y + r + size * 0.35)}" font-family='${fam(b.font)}' font-size="${n(size)}" font-weight="700" fill="${col(b.color)}" text-anchor="middle">${esc(b.text)}</text>`;
  }
  function logoEl(b, kit) {
    const l = kit.logo; const fill = col(b.fill);
    if (l.kind === 'svg' && l.svg) return `<svg x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" viewBox="${esc(l.svg.viewBox)}" preserveAspectRatio="xMidYMid meet" overflow="visible">${Brand.logoInner(kit, fill)}</svg>`;
    if (l.kind === 'image' && l.dataUrl) return `<image x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" href="${esc(l.dataUrl)}" preserveAspectRatio="xMidYMid meet"/>`;
    const size = b.h / 0.74;
    const family = Text.quote(Brand.fontCss(kit.fonts.display)).replace(/['<>&]/g, '');
    return `<text x="${n(b.x)}" y="${n(b.y + b.h)}" font-family='${family}' font-size="${n(size)}" font-weight="700" letter-spacing="${n(-0.04 * size)}" fill="${fill}">${esc(l.text || kit.name)}</text>`;
  }
  function shapeEl(b, ctx) {
    const fill = paint(b, ctx); const st = strokeAttr(b);
    if (b.shape === 'ellipse') return `<ellipse cx="${n(b.x + b.w / 2)}" cy="${n(b.y + b.h / 2)}" rx="${n(b.w / 2)}" ry="${n(b.h / 2)}" fill="${fill}"${st}/>`;
    if (b.shape === 'circle' || b.shape === 'blob') return `<circle cx="${n(b.x + b.w / 2)}" cy="${n(b.y + b.h / 2)}" r="${n(Math.min(b.w, b.h) / 2)}" fill="${fill}"${st}/>`;
    if (b.shape === 'pill') return `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" rx="${n(Math.min(b.w, b.h) / 2)}" fill="${fill}"${st}/>`;
    const r = Math.min(b.w, b.h); // quarter circle
    const d = `M ${n(b.x)} ${n(b.y + r)} A ${n(r)} ${n(r)} 0 0 1 ${n(b.x + r)} ${n(b.y)} L ${n(b.x + r)} ${n(b.y + r)} Z`;
    return `<path d="${d}" fill="${fill}"${st} transform="rotate(${n(b.rot || 0)} ${n(b.x + r / 2)} ${n(b.y + r / 2)})"/>`;
  }
  // Vector: a path (d) or a sanitized SVG fragment in its own viewBox, stretched to the block.
  function vectorEl(b, ctx) {
    const vb = Array.isArray(b.viewBox) ? b.viewBox.map(n).join(' ') : `0 0 ${n(b.vw || b.w)} ${n(b.vh || b.h)}`;
    let inner = '';
    if (b.d && PATH_RE.test(b.d)) inner = `<path d="${b.d}" fill="${b.fill === 'none' ? 'none' : paint(b, ctx)}"${b.fillRule === 'evenodd' ? ' fill-rule="evenodd"' : ''}${strokeAttr(b)}/>`;
    else if (b.svg) inner = sanitizeSvgInner(b.svg);
    return `<svg x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" viewBox="${vb}" preserveAspectRatio="${b.keepAspect ? 'xMidYMid meet' : 'none'}" overflow="visible">${inner}</svg>`;
  }

  // opts: {showGrid, assets, kit, forExport (use data URLs), width (px attr), transparent}
  function toSVG(layout, opts) {
    const { kit, assets } = opts;
    const W = n(layout.format.w), H = n(layout.format.h);
    const prefix = String(layout.id || 'l').replace(/[^A-Za-z0-9_-]/g, '') || 'l';
    let seq = 0;
    const ctx = { defs: [], id: k => `${prefix}-${k}${seq++}` };
    const parts = [];
    if (!opts.transparent) parts.push(`<rect width="${W}" height="${H}" fill="${layout.palette && layout.palette.bgGradient ? (() => { const id = ctx.id('bg'); ctx.defs.push(gradientDef(layout.palette.bgGradient, id)); return `url(#${id})`; })() : col(layout.palette && layout.palette.bg, '#FFFFFF')}"/>`);
    // Boxes draw their fill, then their children (clipped when the box clips); siblings in list order.
    const blockEl = b => {
      let el = '';
      if (b.kind === 'field') el = `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" rx="${n(b.radius || 0)}" fill="${paint(b, ctx)}"${b.alpha != null && b.alpha < 1 ? ` fill-opacity="${n(clamp01(b.alpha))}"` : ''}${strokeAttr(b)}/>`;
      else if (b.kind === 'image') {
        const a = assets.images.find(i => i.id === b.asset);
        const href = a ? (opts.forExport ? a.dataUrl : a.url) : '';
        let clip = '';
        if (b.radius) { const id = ctx.id('c'); ctx.defs.push(`<clipPath id="${id}"><rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" rx="${n(b.radius)}"/></clipPath>`); clip = ` clip-path="url(#${id})"`; }
        if (!a) el = `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" rx="${n(b.radius || 0)}" fill="${col(b.placeholder, '#C9C8D1')}"/>`;
        else el = `<image x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" href="${esc(href)}" preserveAspectRatio="${FOCAL.has(b.focal) ? b.focal : 'xMidYMid'} ${b.fit === 'contain' ? 'meet' : 'slice'}"${clip}/>`;
        if (b.stroke && Number(b.stroke.width) > 0) el += `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" rx="${n(b.radius || 0)}" fill="none"${strokeAttr(b)}/>`;
      } else if (b.kind === 'scrim') {
        const id = ctx.id('g');
        const dir = b.dir || 'up';
        const c = dir === 'up' ? ['0', '0', '0', '1'] : dir === 'down' ? ['0', '1', '0', '0'] : dir === 'right' ? ['1', '0', '0', '0'] : ['0', '0', '1', '0'];
        const al = n(clamp01(b.alpha || 0.7)); const fill = col(b.fill);
        ctx.defs.push(`<linearGradient id="${id}" x1="${c[0]}" y1="${c[1]}" x2="${c[2]}" y2="${c[3]}"><stop offset="0" stop-color="${fill}" stop-opacity="0"/><stop offset="0.55" stop-color="${fill}" stop-opacity="${n(al * 0.75)}"/><stop offset="1" stop-color="${fill}" stop-opacity="${al}"/></linearGradient>`);
        el = `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" fill="url(#${id})"/>`;
      } else if (b.kind === 'shape') el = shapeEl(b, ctx);
      else if (b.kind === 'rule') el = `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" fill="${paint(b, ctx)}"/>`;
      else if (b.kind === 'button') {
        const f = b.font || {};
        el = `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" rx="${n(b.radius || 0)}" fill="${paint(b, ctx)}"${strokeAttr(b)}/>`
          + `<text x="${n(b.x + b.w / 2)}" y="${n(b.y + b.h / 2 + (f.size || 16) * 0.35)}" font-family='${fam(f)}' font-size="${n(f.size || 16)}" font-weight="${n(f.weight || 600)}" fill="${col(b.color)}" text-anchor="middle">${esc(b.text)}</text>`;
      } else if (b.kind === 'text') el = textEl(b, ctx);
      else if (b.kind === 'list') el = listEl(b, ctx);
      else if (b.kind === 'icon') el = Icons.svg(Icons.has(b.name) ? b.name : 'check-circle', n(b.x), n(b.y), n(b.h), col(b.fill));
      else if (b.kind === 'badge') el = badgeEl(b);
      else if (b.kind === 'line') el = `<line x1="${n(b.x)}" y1="${n(b.y)}" x2="${n(b.x + b.w)}" y2="${n(b.y + b.h)}" stroke="${col(b.fill)}" stroke-width="${n(b.width || 2)}"${b.dash ? ` stroke-dasharray="${String(b.dash).replace(/[^\d\s.,]/g, '')}"` : ''}/>`;
      else if (b.kind === 'logo') el = logoEl(b, kit);
      else if (b.kind === 'vector') el = vectorEl(b, ctx);
      return el;
    };
    const I = typeof Auto !== 'undefined' ? Auto.index({ layout }) : null;
    const kidsOf = pid => I ? (I.kids.get(pid) || []) : (pid ? [] : layout.blocks);
    const drawList = pid => kidsOf(pid).filter(b => !b.hidden).map(drawBlock).join('');
    const drawBlock = b => {
      if (b.kind !== 'box') { const el = blockEl(b); return el ? fx(b, el, ctx) : ''; }
      const hasFill = (b.fill && b.fill !== 'none') || (b.gradient && Array.isArray(b.gradient.stops) && b.gradient.stops.length >= 2);
      const st = strokeAttr(b);
      const rect = hasFill || st ? `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" rx="${n(b.radius || 0)}" fill="${hasFill ? paint(b, ctx) : 'none'}"${st}/>` : '';
      let kids = drawList(b.id);
      if (b.clip && kids) { const id = ctx.id('k'); ctx.defs.push(`<clipPath id="${id}"><rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" rx="${n(b.radius || 0)}"/></clipPath>`); kids = `<g clip-path="url(#${id})">${kids}</g>`; }
      const bg = rect ? fx({ x: b.x, y: b.y, w: b.w, h: b.h, shadow: b.shadow }, rect, ctx) : '';
      return fx({ x: b.x, y: b.y, w: b.w, h: b.h, opacity: b.opacity, rotation: b.rotation }, bg + kids, ctx);
    };
    parts.push(drawList(''));
    if (opts.showGrid) parts.push(gridOverlay(layout));
    const attrs = opts.width ? ` width="${n(opts.width)}"` : ` width="${W}" height="${H}"`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"${attrs} data-id="${esc(layout.id)}">${opts.fontStyle ? `<defs><style>${opts.fontStyle}</style></defs>` : ''}${ctx.defs.length ? `<defs>${ctx.defs.join('')}</defs>` : ''}${parts.join('')}</svg>`;
  }

  function gridOverlay(layout) {
    const g = layout.grid, W = layout.format.w, H = layout.format.h;
    const out = [];
    const col = '#FF3B8D';
    // pixel grid (every 4 units to stay legible)
    const step = g.unit * 4;
    let px = '';
    for (let x = 0; x <= W; x += step) px += `M${x} 0V${H}`;
    for (let y = 0; y <= H; y += step) px += `M0 ${y}H${W}`;
    out.push(`<path d="${px}" stroke="${col}" stroke-opacity="0.12" stroke-width="1" fill="none"/>`);
    for (let c = 0; c < g.cols; c++) { const x = g.mx + c * (g.cw + g.gutter); out.push(`<rect x="${x}" y="0" width="${g.cw}" height="${H}" fill="${col}" fill-opacity="0.09"/>`); }
    for (let r = 0; r < g.rows; r++) { const y = g.my + r * (g.rh + g.gutter); out.push(`<rect x="0" y="${y}" width="${W}" height="${g.rh}" fill="${col}" fill-opacity="0.05"/>`); }
    // safe area
    out.push(`<rect x="${g.safe.left}" y="${g.safe.top}" width="${W - g.safe.left - g.safe.right}" height="${H - g.safe.top - g.safe.bottom}" fill="none" stroke="${col}" stroke-width="2" stroke-dasharray="8 8"/>`);
    return `<g pointer-events="none">${out.join('')}</g>`;
  }

  // ---- Export ------------------------------------------------------------------------
  const fontCache = new Map();
  const GOOGLE_SPECS = { 'Bricolage Grotesque': 'Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,300..800', 'Inter': 'Inter:wght@400;500;600;700', 'IBM Plex Mono': 'IBM+Plex+Mono:wght@400;500', 'Fraunces': 'Fraunces:opsz,wght@9..144,300..900', 'Manrope': 'Manrope:wght@400;500;700;800', 'Schibsted Grotesk': 'Schibsted+Grotesk:wght@400;500;700;900', 'Instrument Serif': 'Instrument+Serif:ital@0;1' };
  let lastEmbedFailed = false;
  function bufToBase64(buf) {
    const bytes = new Uint8Array(buf); let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  // Keep only the Latin subsets of a Google Fonts stylesheet (the rest can be a megabyte of Cyrillic and Vietnamese).
  function latinOnly(css) {
    const blocks = css.match(/@font-face\s*{[^}]*}/g) || [];
    const keep = blocks.filter(b => !/unicode-range/.test(b) || /U\+0000-00FF/.test(b) || /U\+0100-02BA|U\+0100-02AF/.test(b));
    return keep.join('\n');
  }
  let embedBlocked = false; // set once a host refuses the font fetch, so later exports skip the attempt (and the console noise)
  async function fontFaceCss(families, forRaster = false) {
    const out = [];
    lastEmbedFailed = false;
    for (const fam of families) {
      if (Brand.customFonts[fam]) {
        const cf = Brand.customFonts[fam];
        if (cf.dataUrl) out.push(`@font-face{font-family:"${fam}";src:url(${cf.dataUrl});font-weight:100 900;}`);
        continue;
      }
      if (!Brand.FONTS[fam]) continue;
      if (fontCache.has(fam)) { out.push(fontCache.get(fam)); continue; }
      const spec = GOOGLE_SPECS[fam];
      if (embedBlocked) { lastEmbedFailed = true; if (!forRaster) out.push(`@import url("https://fonts.googleapis.com/css2?family=${spec}&display=swap");`); continue; }
      try {
        const css = latinOnly(await (await fetch(`https://fonts.googleapis.com/css2?family=${spec}&display=swap`)).text());
        const urls = [...new Set([...css.matchAll(/url\((https:[^)]+)\)/g)].map(m => m[1]))];
        if (!urls.length) throw new Error('no font urls');
        let inlined = css;
        for (const u of urls) {
          const res = await fetch(u); if (!res.ok) throw new Error('font fetch ' + res.status);
          inlined = inlined.split(u).join(`data:font/woff2;base64,${bufToBase64(await res.arrayBuffer())}`);
        }
        fontCache.set(fam, inlined); out.push(inlined);
      } catch (e) {
        // Fetch is blocked in some hosts (published copies). For a downloadable SVG, fall back to a stylesheet import so a
        // browser still loads the face. Never for rasterization: an SVG with an @import refuses to load as an image there.
        lastEmbedFailed = true; if (e && /Failed to fetch|NetworkError|Refused/i.test(String(e.message || e))) embedBlocked = true;
        if (!forRaster) out.push(`@import url("https://fonts.googleapis.com/css2?family=${spec}&display=swap");`);
      }
    }
    return out.join('\n');
  }
  function fontsEmbedded() { return !lastEmbedFailed; }
  async function exportSVG(layout, opts, forRaster = false) {
    const fams = [opts.kit.fonts.display, opts.kit.fonts.body];
    const fontStyle = await fontFaceCss(fams, forRaster);
    return toSVG(layout, { ...opts, forExport: true, fontStyle, showGrid: false });
  }
  // Rasterize an SVG string to a PNG data URL at the layout's pixel size.
  async function svgToPngDataUrl(svg, w, h, scale = 1) {
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      const c = document.createElement('canvas'); c.width = Math.round(w * scale); c.height = Math.round(h * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/png');
    } finally { URL.revokeObjectURL(url); }
  }
  async function exportPNG(layout, opts, scale = 1) {
    const svg = await exportSVG(layout, opts, true);
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      const c = document.createElement('canvas'); c.width = layout.format.w * scale; c.height = layout.format.h * scale;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, c.width, c.height);
      return await new Promise(res => c.toBlob(res, 'image/png'));
    } finally { URL.revokeObjectURL(url); }
  }
  // Published copies hand files to the viewer through the host's download capability (the viewer confirms each save);
  // anywhere else a plain anchor works. Resolves true when a file was offered, false when the viewer declined.
  let hostDownloads; // undefined = not asked yet, null = unavailable
  async function hostDl() {
    if (hostDownloads !== undefined) return hostDownloads;
    try { hostDownloads = (window.claude && typeof window.claude.use === 'function') ? await window.claude.use('downloads') : null; }
    catch { hostDownloads = null; }
    return hostDownloads;
  }
  async function download(blob, name) {
    const host = await hostDl();
    if (host) {
      try { await host.save({ filename: name, data: blob }); return true; }
      catch (e) { if (e && e.code === 'declined') return false; throw new Error(e && e.message ? e.message : 'save failed'); }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    return true;
  }
  // PDF: one page per layout at its own size, each page a 2x PNG. jsPDF loads on first use.
  let jspdfP = null;
  function loadJsPDF() {
    if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
    if (!jspdfP) jspdfP = new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js'; s.onload = () => window.jspdf ? res(window.jspdf.jsPDF) : rej(new Error('jsPDF did not load')); s.onerror = () => { jspdfP = null; rej(new Error('Could not load the PDF library')); }; document.head.appendChild(s); });
    return jspdfP;
  }
  async function exportPDF(layouts, opts, scale = 2) {
    const JsPDF = await loadJsPDF();
    let pdf = null;
    for (const L of layouts) {
      const w = L.format.w, h = L.format.h; const orient = w >= h ? 'landscape' : 'portrait';
      if (!pdf) pdf = new JsPDF({ unit: 'px', format: [w, h], orientation: orient, hotfixes: ['px_scaling'], compress: true });
      else pdf.addPage([w, h], orient);
      const blob = await exportPNG(L, opts, scale);
      const dataUrl = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
      pdf.addImage(dataUrl, 'PNG', 0, 0, w, h, undefined, 'FAST');
    }
    return pdf ? pdf.output('blob') : null;
  }
  return { toSVG, gridOverlay, exportSVG, exportPNG, exportPDF, svgToPngDataUrl, download, fontFaceCss, fontsEmbedded, bufToBase64, sanitizeSvgInner, col };
})();
