/* Layout spec -> editable PowerPoint. Every block in the spec is already an absolute box on the canvas,
   so the mapping is direct: fields and simple shapes become native shapes, images stay images, text stays
   text in the brand font, and only gradients, arcs, and SVG logos are rasterized to transparent layers. */
const ExportPptx = (() => {
  const CDN = 'https://cdn.jsdelivr.net/npm/pptxgenjs@4.0.1/dist/pptxgen.bundle.js';
  const PX_PER_IN = 96;
  let loading = null;
  function lib() {
    if (window.PptxGenJS) return Promise.resolve(window.PptxGenJS);
    if (!loading) loading = new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = CDN; s.async = true;
      s.onload = () => window.PptxGenJS ? res(window.PptxGenJS) : rej(new Error('PptxGenJS did not initialize'));
      s.onerror = () => rej(new Error('Could not load the PowerPoint library (offline, or scripts blocked here)'));
      document.head.appendChild(s);
    });
    return loading;
  }
  const inch = v => Math.round(v / PX_PER_IN * 1000) / 1000;
  const pt = px => Math.round(px * 0.75 * 10) / 10;
  const hex = c => { const h = String(c || '#000000').replace('#', '').toUpperCase(); return h.length === 3 ? h.split('').map(x => x + x).join('') : h.slice(0, 6); };
  const stripData = d => String(d).replace(/^data:/, '');
  const fontName = css => String(css).split(',')[0].replace(/["']/g, '').trim();
  const RASTER = new Set(['scrim']);
  // Anything PowerPoint cannot draw natively with the same look is rasterized in place: vectors, gradients, shadows, rotation.
  const hasFx = b => !!(b.gradient || (b.shadow && b.shadow.on !== false && (b.shadow.blur || b.shadow.x || b.shadow.y)) || Number(b.rotation) || (b.opacity != null && b.opacity < 1 && b.kind !== 'text'));
  const isRaster = b => RASTER.has(b.kind) || b.kind === 'icon' || b.kind === 'line' || b.kind === 'vector' || (b.kind === 'shape' && (b.shape === 'quarter' || b.shape === 'blob')) || (b.kind === 'logo' && (b.logoKind === 'svg' || (b.variant && b.variant !== 'wordmark'))) || (hasFx(b) && b.kind !== 'text' && b.kind !== 'list');

  async function rasterLayer(layout, blocks, opts) {
    const svg = Render.toSVG({ ...layout, blocks }, { kit: opts.kit, assets: opts.assets, forExport: true, transparent: true, showGrid: false });
    return Render.svgToPngDataUrl(svg, layout.format.w, layout.format.h, 1);
  }

  async function addLayoutSlide(pptx, slide, layout, opts) {
    const { kit } = opts;
    const W = layout.format.w, H = layout.format.h;
    slide.background = { color: hex(layout.palette.bg) };
    // Paint order (a box, then what is inside it); a hidden box hides its contents. Positions are already absolute.
    const order = typeof Auto !== 'undefined' ? (() => { const I = Auto.index({ layout }); const out = []; const walk = id => { for (const k of Auto.childrenOf(I, id)) { if (k.hidden) continue; out.push(k); if (k.kind === 'box') walk(k.id); } }; walk(''); return out; })() : layout.blocks;
    const blocks = order.map(b => b.kind === 'logo' ? { ...b, logoKind: kit.logo.kind } : b);
    let pending = [];
    const flush = async () => {
      if (!pending.length) return;
      const data = await rasterLayer(layout, pending, opts);
      slide.addImage({ data: stripData(data), x: 0, y: 0, w: inch(W), h: inch(H) });
      pending = [];
    };
    for (const b of blocks) {
      if (b.hidden) continue;
      if (isRaster(b)) { pending.push(b); continue; }
      await flush();
      const box = { x: inch(b.x), y: inch(b.y), w: inch(b.w), h: inch(b.h) };
      if (b.kind === 'box') {
        const filled = b.fill && b.fill !== 'none'; const st = b.stroke && Number(b.stroke.width) > 0;
        if (filled || st) {
          const o = { ...box, fill: filled ? { color: hex(b.fill) } : { type: 'none' }, line: st ? { color: hex(b.stroke.color), width: pt(b.stroke.width) } : { color: 'FFFFFF', transparency: 100 } };
          if (b.radius) { o.rectRadius = inch(b.radius); slide.addShape(pptx.ShapeType.roundRect, o); } else slide.addShape(pptx.ShapeType.rect, o);
        }
      } else if (b.kind === 'field') {
        const o = { ...box, fill: { color: hex(b.fill), transparency: b.alpha != null ? Math.round((1 - b.alpha) * 100) : 0 }, line: { color: hex(b.fill), transparency: 100 } };
        if (b.radius) { o.rectRadius = inch(b.radius); slide.addShape(pptx.ShapeType.roundRect, o); } else slide.addShape(pptx.ShapeType.rect, o);
      } else if (b.kind === 'rule') {
        slide.addShape(pptx.ShapeType.rect, { ...box, fill: { color: hex(b.fill) }, line: { color: hex(b.fill), transparency: 100 } });
      } else if (b.kind === 'shape') {
        const o = { ...box, fill: { color: hex(b.fill) }, line: { color: hex(b.fill), transparency: 100 } };
        if (b.shape === 'circle' || b.shape === 'ellipse') slide.addShape(pptx.ShapeType.ellipse, o);
        else { o.rectRadius = inch(Math.min(b.w, b.h) / 2); slide.addShape(pptx.ShapeType.roundRect, o); }
      } else if (b.kind === 'image') {
        const a = opts.assets.images.find(i => i.id === b.asset);
        if (a) slide.addImage({ data: stripData(a.dataUrl), ...box, sizing: { type: 'cover', w: box.w, h: box.h } });
      } else if (b.kind === 'text') {
        const f = b.font;
        slide.addText(b.lines.join('\n'), {
          ...box, h: inch(b.h + f.size * 0.4),
          fontFace: fontName(f.family), fontSize: pt(f.size), color: hex(b.fill), bold: f.weight >= 600,
          align: b.align || 'left', valign: 'top', margin: 0, lineSpacingMultiple: f.lineHeight || 1.2,
          charSpacing: f.letterSpacing ? Math.round(f.letterSpacing * pt(f.size) * 10) / 10 : 0, fit: 'none', wrap: true,
        });
      } else if (b.kind === 'list') {
        const f = b.font;
        const runs = [];
        for (const line of b.lines) {
          if (line.marker != null) runs.push({ text: line.text, options: { bullet: b.marker === 'number' ? { type: 'number' } : { indent: Math.round(pt(b.indent)) }, breakLine: true, paraSpaceAfter: line.last ? pt(b.itemGap || 0) : 0 } });
          else runs.push({ text: line.text, options: { breakLine: true, indentLevel: 0 } });
        }
        slide.addText(runs, { ...box, h: inch(b.h + f.size * 0.4), fontFace: fontName(f.family), fontSize: pt(f.size), color: hex(b.fill), bold: f.weight >= 600, valign: 'top', margin: 0, lineSpacingMultiple: f.lineHeight || 1.3, fit: 'none', wrap: true });
      } else if (b.kind === 'badge') {
        slide.addText(b.text, { ...box, shape: pptx.ShapeType.ellipse, fill: { color: hex(b.fill) }, line: { color: hex(b.fill), transparency: 100 }, fontFace: fontName(b.font.family), fontSize: pt(b.h * 0.46), color: hex(b.color), bold: true, align: 'center', valign: 'middle', margin: 0 });
      } else if (b.kind === 'button') {
        const f = b.font;
        slide.addText(b.text, {
          ...box, shape: pptx.ShapeType.roundRect, rectRadius: inch(b.radius || 0), fill: { color: hex(b.fill) }, line: { color: hex(b.fill), transparency: 100 },
          fontFace: fontName(f.family), fontSize: pt(f.size), color: hex(b.color), bold: true, align: 'center', valign: 'middle', margin: 0,
        });
      } else if (b.kind === 'logo') {
        if (kit.logo.kind === 'image' && kit.logo.dataUrl) slide.addImage({ data: stripData(kit.logo.dataUrl), ...box, sizing: { type: 'contain', w: box.w, h: box.h } });
        else {
          const size = b.h / 0.74;
          slide.addText(kit.logo.text || kit.name, {
            x: box.x, y: inch(b.y - size * 0.2), w: inch(b.w * 1.3), h: inch(size * 1.2),
            fontFace: fontName(Brand.fontCss(kit.fonts.display)), fontSize: pt(size), color: hex(b.fill), bold: true,
            charSpacing: Math.round(-0.04 * pt(size) * 10) / 10, align: 'left', valign: 'middle', margin: 0,
          });
        }
      }
    }
    await flush();
  }

  // layouts: one or more layouts of the SAME format -> one deck Blob
  async function buildDeck(layouts, opts) {
    const PptxGenJS = await lib();
    const pptx = new PptxGenJS();
    const f = layouts[0].format;
    pptx.defineLayout({ name: 'LAYOUT_ENGINE', width: inch(f.w), height: inch(f.h) });
    pptx.layout = 'LAYOUT_ENGINE';
    pptx.title = `${opts.kit.name} layouts`;
    for (const L of layouts) {
      const slide = pptx.addSlide();
      await addLayoutSlide(pptx, slide, L, opts);
      slide.addNotes(`${L.archetypeLabel} · ${L.format.name} · seed ${L.seed} · ${L.id}`);
    }
    return pptx.write({ outputType: 'blob' });
  }
  // Mixed formats -> one deck per format
  async function buildDecks(layouts, opts) {
    const groups = new Map();
    for (const L of layouts) { const k = L.format.id; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(L); }
    const out = [];
    for (const [id, list] of groups) out.push({ formatId: id, formatName: list[0].format.name, count: list.length, blob: await buildDeck(list, opts) });
    return out;
  }
  return { buildDeck, buildDecks, lib };
})();
