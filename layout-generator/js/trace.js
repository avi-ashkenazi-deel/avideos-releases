/* Rebuild an image as layers: an app screenshot (or a slide, a mockup) goes to Claude with a request for its layers
   (rectangles, text with exact wording, buttons, icons, pictures) in the image's own coordinates. The answer becomes a
   new screen next to the original: text and shapes are editable, and pictures are cropped from the image itself, so
   photos and logos keep their real pixels. The source image rides along as a hidden reference layer. */
const Trace = (() => {
  const r2 = v => Math.round(Number(v) * 100) / 100;
  const hex = (v, d) => { try { return Color.normalize(v); } catch { return d; } };
  const clampN = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
  async function loadImg(src) { const img = new Image(); img.crossOrigin = 'anonymous'; await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('image load')); img.src = src; }); return img; }
  // The image at up to 1568 px on its long side (what vision reads best), as PNG or JPEG.
  async function blobOf(img, maxSide = 1568) {
    const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight)); const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise(res => c.toBlob(res, 'image/jpeg', 0.9));
  }
  function crop(img, sx, sy, sw, sh) {
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(sw)); c.height = Math.max(1, Math.round(sh));
    c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height); return c.toDataURL('image/png');
  }
  function prompt(W, H) {
    return `This image is a user interface (an app screen, a web page, a slide or a mockup). Rebuild it as editable design layers for a ${W}×${H} canvas: use pixel coordinates on that canvas, origin at the top left, and measure carefully.
Reply with JSON only, no prose: {"background":"#RRGGBB","layers":[ ... ]}, layers from back to front, at most 140.
Layer kinds:
- {"type":"rect","x":0,"y":0,"w":0,"h":0,"fill":"#RRGGBB","radius":0,"stroke":"#RRGGBB or null"} for panels, cards, bars, list rows, input fields, chips, dividers (h 1 or 2). Use "fill": null for outline-only shapes.
- {"type":"text","x":0,"y":0,"w":0,"h":0,"text":"exact wording","size":16,"weight":400,"color":"#RRGGBB","align":"left|center|right"} one per block of lines that share a style; keep the wording exactly, line breaks as \\n; size is the font size in canvas pixels.
- {"type":"button","x":0,"y":0,"w":0,"h":0,"text":"label","fill":"#RRGGBB","color":"#RRGGBB","radius":0,"size":16} for buttons with a text label.
- {"type":"image","x":0,"y":0,"w":0,"h":0,"radius":0,"kind":"photo|avatar|illustration|logo|chart|map|status"} for anything pictorial; it is cropped from the image, so box it tightly. The phone status bar (time, signal, battery) is one image layer of kind "status".
- {"type":"icon","x":0,"y":0,"w":0,"h":0,"name":"one of: ${Icons.names.join(', ')}","color":"#RRGGBB"} for small glyphs; pick the closest name.`;
  }
  // JSON layers -> blocks in a W x H frame. imgW/imgH: the source picture's pixel size, for crops.
  async function build(json, W, H, kit, img, addImage) {
    const blocks = []; const body = Brand.fontCss(kit.fonts.body), display = Brand.fontCss(kit.fonts.display);
    const sx = img.naturalWidth / W, sy = img.naturalHeight / H; let crops = 0;
    for (const L of (Array.isArray(json.layers) ? json.layers : []).slice(0, 160)) {
      if (!L || typeof L !== 'object') continue;
      const x = clampN(L.x, -W, W * 2, 0), y = clampN(L.y, -H, H * 2, 0), w = clampN(L.w, 1, W * 2, 10), h = clampN(L.h, 1, H * 2, 10);
      const base = { id: Canvas.uid(), x: r2(x), y: r2(y), w: r2(w), h: r2(h) };
      const t = String(L.type || '').toLowerCase();
      if (t === 'rect') {
        const fill = L.fill ? hex(L.fill, null) : null; const stroke = L.stroke ? hex(L.stroke, null) : null; if (!fill && !stroke) continue;
        blocks.push({ ...base, kind: 'field', fill: fill || '#FFFFFF', ...(fill ? {} : { alpha: 0 }), radius: clampN(L.radius, 0, 999, 0), ...(stroke ? { stroke: { color: stroke, width: 1 } } : {}), decorative: true, label: 'rect' });
      } else if (t === 'text') {
        const size = clampN(L.size, 6, 400, 16), weight = Math.round(clampN(L.weight, 100, 900, 400) / 100) * 100;
        const b = { ...base, kind: 'text', role: size >= 28 ? 'headline' : 'text', path: 'text_' + Canvas.uid(), text: String(L.text || '').slice(0, 2000), align: /center|right/.test(L.align) ? L.align : 'left', fill: hex(L.color, '#111111'), decorative: false,
          font: { family: size >= 24 && weight >= 600 ? display : body, size: r2(size), weight, lineHeight: 1.25, letterSpacing: 0 } };
        if (!b.text.trim()) continue;
        Canvas.refit(b); if (b.overflow || (b.lines || []).length > Math.max(1, Math.round(h / (size * 1.25)) + 1)) { const longest = Math.max(...String(b.text).split('\n').map(l => Text.width(l, b.font))); if (longest > b.w && longest < W * 1.2) { if (b.align === 'center') b.x -= (longest - b.w) / 2; else if (b.align === 'right') b.x -= longest - b.w; b.w = Math.ceil(longest) + 2; Canvas.refit(b); } }
        blocks.push(b);
      } else if (t === 'button') {
        const size = clampN(L.size, 8, 80, 16);
        blocks.push({ ...base, kind: 'button', role: 'cta', path: 'cta_' + Canvas.uid(), text: String(L.text || 'Button').slice(0, 80), fill: hex(L.fill, '#5938B8'), color: hex(L.color, '#FFFFFF'), radius: clampN(L.radius, 0, 999, 8), font: { family: body, weight: 600, size, lineHeight: 1.2 }, decorative: false });
      } else if (t === 'image') {
        let asset = null;
        try { const dataUrl = crop(img, x * sx, y * sy, w * sx, h * sy); asset = await addImage(dataUrl, `crop · ${L.kind || 'image'}`); crops++; } catch { asset = null; }
        blocks.push({ ...base, kind: 'image', asset: asset ? asset.id : null, focal: 'xMidYMid', fit: 'cover', radius: clampN(L.radius, 0, 999, 0), decorative: L.kind === 'status', path: 'image_' + Canvas.uid(), placeholder: '#D6D3E4', label: L.kind || 'image' });
      } else if (t === 'icon') {
        const name = Icons.has(L.name) ? L.name : null; const s = Math.min(w, h);
        if (name) blocks.push({ ...base, kind: 'icon', name, w: r2(s), h: r2(s), fill: hex(L.color, '#111111'), decorative: true });
        else blocks.push({ ...base, kind: 'shape', shape: 'circle', w: r2(s), h: r2(s), fill: hex(L.color, '#111111'), decorative: true, label: 'icon' });
      }
    }
    return { blocks, crops };
  }
  // Read the image block `b` in frame `f` and lay the rebuilt screen next to it.
  async function run(f, b, env) {
    const assets = env.getAssets().images; const a = assets.find(x => x.id === b.asset); if (!a) throw new Error('This image has no picture to read yet');
    if (!Agent.canSee()) throw new Error('Rebuilding needs Claude: open this page in claude.ai, or add an Anthropic API key in Settings.');
    const img = await loadImg(a.dataUrl || a.url); const W = Math.round(b.w), H = Math.round(b.h);
    env.toast('Claude is reading the image… (about half a minute)');
    const json = await Agent.vision(prompt(W, H), await blobOf(img));
    const kit = env.getKit();
    const { blocks, crops } = await build(json, W, H, kit, img, env.addImageData);
    if (!blocks.length) throw new Error('No layers came back; try again or a sharper image');
    const ref = { id: Canvas.uid(), kind: 'image', x: 0, y: 0, w: W, h: H, asset: a.id, focal: 'xMidYMid', fit: 'cover', radius: 0, decorative: true, path: 'image_ref', hidden: true, locked: true, label: 'screenshot (reference)' };
    const fmt = Grid.FORMATS.find(x => x.screen && x.w === W && Math.abs(x.h - H) <= 2) || Canvas.customFormat(W, H);
    const nf = env.canvas.createFrame({ x: f.x + f.layout.format.w + 120, y: f.y, format: fmt, name: `${String(f.name).replace(/ · phone$/, '')} · layers`, bg: hex(json.background, '#FFFFFF') });
    env.canvas.mutate(() => { nf.layout.blocks.push(ref, ...blocks); nf.layout.meta = { ...(nf.layout.meta || {}), source: 'trace' }; }, { history: false, frames: [nf.id] });
    env.canvas.fitTo([f.id, nf.id]); env.canvas.selectFrames([nf.id]);
    const counts = blocks.reduce((m, x) => (m[x.kind] = (m[x.kind] || 0) + 1, m), {});
    env.toast(`Rebuilt as ${blocks.length} layers: ${counts.text || 0} text, ${counts.field || 0} shapes, ${counts.button || 0} buttons, ${crops} image crops, ${(counts.icon || 0) + (counts.shape || 0)} icons. The original is a hidden layer at the bottom.`);
    return nf;
  }
  return { run, build, prompt };
})();
