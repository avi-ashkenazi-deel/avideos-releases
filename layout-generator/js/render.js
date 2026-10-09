/* Layout spec -> SVG. Also PNG export with fonts and images embedded. */
const Render = (() => {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const n = v => Math.round(v * 100) / 100;

  function textEl(b) {
    const f = b.font;
    const anchor = b.align === 'center' ? 'middle' : b.align === 'right' ? 'end' : 'start';
    const x = b.align === 'center' ? b.x + b.w / 2 : b.align === 'right' ? b.x + b.w : b.x;
    const lh = f.size * (f.lineHeight || 1.2);
    const first = b.y + f.size * 0.78 + (lh - f.size) / 2;
    const ls = f.letterSpacing ? ` letter-spacing="${n(f.letterSpacing * f.size)}"` : '';
    const spans = b.lines.map((line, i) => `<tspan x="${n(x)}" y="${n(first + i * lh)}">${esc(line)}</tspan>`).join('');
    return `<text font-family='${Text.quote(f.family).replace(/'/g, '')}' font-size="${f.size}" font-weight="${f.weight}" fill="${b.fill}" text-anchor="${anchor}"${ls}>${spans}</text>`;
  }
  function listEl(b) {
    const f = b.font;
    const lh = f.size * (f.lineHeight || 1.3);
    const first = b.y + f.size * 0.78 + (lh - f.size) / 2;
    const ls = f.letterSpacing ? ` letter-spacing="${n(f.letterSpacing * f.size)}"` : '';
    const parts = []; let yy = first;
    for (const line of b.lines) {
      if (line.marker != null) parts.push(`<tspan x="${n(b.x)}" y="${n(yy)}"${line.markerFill ? ` fill="${line.markerFill}"` : ''}${line.markerBold ? ' font-weight="700"' : ''}>${esc(line.marker)}</tspan>`);
      parts.push(`<tspan x="${n(b.x + b.indent)}" y="${n(yy)}">${esc(line.text)}</tspan>`);
      yy += lh + (line.last ? (b.itemGap || 0) : 0);
    }
    return `<text font-family='${Text.quote(f.family).replace(/'/g, '')}' font-size="${f.size}" font-weight="${f.weight}" fill="${b.fill}" text-anchor="start"${ls}>${parts.join('')}</text>`;
  }
  function badgeEl(b) {
    const r = Math.min(b.w, b.h) / 2; const size = b.h * 0.46;
    return `<circle cx="${n(b.x + r)}" cy="${n(b.y + r)}" r="${n(r)}" fill="${b.fill}"/><text x="${n(b.x + r)}" y="${n(b.y + r + size * 0.35)}" font-family='${Text.quote(b.font.family).replace(/'/g, '')}' font-size="${n(size)}" font-weight="700" fill="${b.color}" text-anchor="middle">${esc(b.text)}</text>`;
  }
  function logoEl(b, kit) {
    const l = kit.logo;
    if (l.kind === 'svg' && l.svg) return `<svg x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" viewBox="${l.svg.viewBox}" preserveAspectRatio="xMidYMid meet" overflow="visible">${Brand.logoInner(kit, b.fill)}</svg>`;
    if (l.kind === 'image' && l.dataUrl) return `<image x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" href="${l.dataUrl}" preserveAspectRatio="xMidYMid meet"/>`;
    const size = b.h / 0.74;
    const fam = Brand.fontCss(kit.fonts.display);
    return `<text x="${n(b.x)}" y="${n(b.y + b.h)}" font-family='${Text.quote(fam).replace(/'/g, '')}' font-size="${n(size)}" font-weight="700" letter-spacing="${n(-0.04 * size)}" fill="${b.fill}">${esc(l.text || kit.name)}</text>`;
  }
  function shapeEl(b) {
    if (b.shape === 'circle' || b.shape === 'blob') return `<circle cx="${n(b.x + b.w / 2)}" cy="${n(b.y + b.h / 2)}" r="${n(Math.min(b.w, b.h) / 2)}" fill="${b.fill}"/>`;
    if (b.shape === 'pill') return `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" rx="${n(Math.min(b.w, b.h) / 2)}" fill="${b.fill}"/>`;
    // quarter circle
    const r = Math.min(b.w, b.h);
    const d = `M ${n(b.x)} ${n(b.y + r)} A ${n(r)} ${n(r)} 0 0 1 ${n(b.x + r)} ${n(b.y)} L ${n(b.x + r)} ${n(b.y + r)} Z`;
    return `<path d="${d}" fill="${b.fill}" transform="rotate(${b.rot || 0} ${n(b.x + r / 2)} ${n(b.y + r / 2)})"/>`;
  }

  // opts: {showGrid, assets, kit, forExport (use data URLs), width (px attr)}
  function toSVG(layout, opts) {
    const { kit, assets } = opts;
    const W = layout.format.w, H = layout.format.h;
    const defs = []; const parts = [];
    let clipId = 0, gradId = 0;
    const uid = layout.id || 'l';
    if (!opts.transparent) parts.push(`<rect width="${W}" height="${H}" fill="${layout.palette.bg}"/>`);
    for (const b of layout.blocks) {
      if (b.kind === 'field') {
        parts.push(`<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" rx="${b.radius || 0}" fill="${b.fill}"${b.alpha != null && b.alpha < 1 ? ` fill-opacity="${b.alpha}"` : ''}/>`);
      } else if (b.kind === 'image') {
        const a = assets.images.find(i => i.id === b.asset);
        const href = a ? (opts.forExport ? a.dataUrl : a.url) : '';
        let clip = '';
        if (b.radius) { const id = `${uid}-c${clipId++}`; defs.push(`<clipPath id="${id}"><rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" rx="${b.radius}"/></clipPath>`); clip = ` clip-path="url(#${id})"`; }
        if (!a) parts.push(`<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" rx="${b.radius || 0}" fill="#888"/>`);
        else parts.push(`<image x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" href="${href}" preserveAspectRatio="${b.focal || 'xMidYMid'} slice"${clip}/>`);
      } else if (b.kind === 'scrim') {
        const id = `${uid}-g${gradId++}`;
        const dir = b.dir || 'up';
        const c = dir === 'up' ? ['0', '0', '0', '1'] : dir === 'down' ? ['0', '1', '0', '0'] : dir === 'right' ? ['1', '0', '0', '0'] : ['0', '0', '1', '0'];
        defs.push(`<linearGradient id="${id}" x1="${c[0]}" y1="${c[1]}" x2="${c[2]}" y2="${c[3]}"><stop offset="0" stop-color="${b.fill}" stop-opacity="0"/><stop offset="0.55" stop-color="${b.fill}" stop-opacity="${(b.alpha || 0.7) * 0.75}"/><stop offset="1" stop-color="${b.fill}" stop-opacity="${b.alpha || 0.7}"/></linearGradient>`);
        parts.push(`<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" fill="url(#${id})"/>`);
      } else if (b.kind === 'shape') parts.push(shapeEl(b));
      else if (b.kind === 'rule') parts.push(`<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" fill="${b.fill}"/>`);
      else if (b.kind === 'button') {
        const f = b.font;
        parts.push(`<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" rx="${b.radius || 0}" fill="${b.fill}"/>`);
        parts.push(`<text x="${n(b.x + b.w / 2)}" y="${n(b.y + b.h / 2 + f.size * 0.35)}" font-family='${Text.quote(f.family).replace(/'/g, '')}' font-size="${f.size}" font-weight="${f.weight}" fill="${b.color}" text-anchor="middle">${esc(b.text)}</text>`);
      } else if (b.kind === 'text') parts.push(textEl(b));
      else if (b.kind === 'list') parts.push(listEl(b));
      else if (b.kind === 'icon') parts.push(Icons.svg(b.name, n(b.x), n(b.y), n(b.h), b.fill));
      else if (b.kind === 'badge') parts.push(badgeEl(b));
      else if (b.kind === 'line') parts.push(`<line x1="${n(b.x)}" y1="${n(b.y)}" x2="${n(b.x + b.w)}" y2="${n(b.y + b.h)}" stroke="${b.fill}" stroke-width="${b.width || 2}"${b.dash ? ` stroke-dasharray="${b.dash}"` : ''}/>`);
      else if (b.kind === 'logo') parts.push(logoEl(b, kit));
    }
    if (opts.showGrid) parts.push(gridOverlay(layout));
    const attrs = opts.width ? ` width="${opts.width}"` : ` width="${W}" height="${H}"`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"${attrs} data-id="${layout.id}">${opts.fontStyle ? `<defs><style>${opts.fontStyle}</style></defs>` : ''}${defs.length ? `<defs>${defs.join('')}</defs>` : ''}${parts.join('')}</svg>`;
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
  return { toSVG, gridOverlay, exportSVG, exportPNG, svgToPngDataUrl, download, fontFaceCss, fontsEmbedded, bufToBase64 };
})();
