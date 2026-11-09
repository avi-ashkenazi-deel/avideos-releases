/* Figma in: .fig files and Figma clipboard paste.
   Both carry the same binary: "fig-kiwi", a version, then a compressed kiwi schema and a compressed message (deflate-raw,
   or zstd in newer files). The schema travels with the data, so the decoder below knows nothing Figma-specific; only
   the conversion to frames and blocks reads Figma's node types. A .fig file is usually a zip around that binary
   (canvas.fig) with the image fills in images/<hash>. A FigJam board (a .jam file, or a paste from FigJam) is the same
   container with board node types: stickies, shapes with text, connectors, sections, stamps; they become a board. Fidelity is best-effort: frames, rectangles, ellipses, text,
   vectors, image fills, gradients, strokes, drop shadows, opacity and rotation come through; components are expanded
   from their main component when it is in the same data; variables, constraints and prototypes are not read. */
const FigmaImport = (() => {
  // ---- kiwi binary reader ----------------------------------------------------------------------------------------
  const f32 = new Float32Array(1), i32 = new Int32Array(f32.buffer);
  class BB {
    constructor(u8) { this.d = u8; this.i = 0; }
    byte() { if (this.i >= this.d.length) throw new Error('kiwi: read past end'); return this.d[this.i++]; }
    bool() { return this.byte() !== 0; }
    bytes() { const n = this.uint(); if (this.i + n > this.d.length) throw new Error('kiwi: read past end'); const out = this.d.subarray(this.i, this.i + n); this.i += n; return out; }
    uint() { let v = 0, s = 0, b; do { b = this.byte(); v |= (b & 127) << s; s += 7; } while (b & 128 && s < 35); return v >>> 0; }
    int() { const v = this.uint() | 0; return v & 1 ? ~(v >>> 1) : v >>> 1; }
    float() { const first = this.byte(); if (first === 0) return 0; if (this.i + 3 > this.d.length) throw new Error('kiwi: read past end'); let bits = first | (this.d[this.i++] << 8) | (this.d[this.i++] << 16) | (this.d[this.i++] << 24); bits = (bits << 23) | (bits >>> 9); i32[0] = bits; return f32[0]; }
    uint64() { let v = 0n, s = 0n, b; do { b = this.byte(); v |= BigInt(b & 127) << s; s += 7n; } while (b & 128 && s < 70n); return Number(v); }
    int64() { const v = BigInt(this.uint64()); return Number(v & 1n ? ~(v >> 1n) : v >> 1n); }
    string() { let out = ''; for (;;) { let c; const a = this.byte(); if (a < 0xC0) c = a; else { const b = this.byte(); if (a < 0xE0) c = ((a & 0x1F) << 6) | (b & 0x3F); else { const d = this.byte(); if (a < 0xF0) c = ((a & 0x0F) << 12) | ((b & 0x3F) << 6) | (d & 0x3F); else { const e = this.byte(); c = ((a & 0x07) << 18) | ((b & 0x3F) << 12) | ((d & 0x3F) << 6) | (e & 0x3F); } } } if (c === 0) break; out += String.fromCodePoint(c); } return out; }
  }
  const BUILTIN = ['bool', 'byte', 'int', 'uint', 'float', 'string', 'int64', 'uint64'];
  const KIND = ['ENUM', 'STRUCT', 'MESSAGE'];
  function decodeSchema(u8) {
    const bb = new BB(u8); const defs = []; const n = bb.uint();
    for (let i = 0; i < n; i++) {
      const name = bb.string(); const kind = KIND[bb.byte()]; const fc = bb.uint(); const fields = [];
      for (let j = 0; j < fc; j++) { const fname = bb.string(); const type = bb.int(); const isArray = !!(bb.byte() & 1); const value = bb.uint(); fields.push({ name: fname, type, isArray, value }); }
      defs.push({ name, kind, fields });
    }
    for (const d of defs) for (const f of d.fields) f.type = f.type < 0 ? BUILTIN[~f.type] : defs[f.type] ? defs[f.type].name : 'unknown';
    return defs;
  }
  function compile(defs) {
    const byName = new Map(defs.map(d => [d.name, d]));
    for (const d of defs) { d.byValue = new Map(d.fields.map(f => [f.value, f])); }
    const readOne = (bb, type) => {
      switch (type) {
        case 'bool': return bb.bool(); case 'byte': return bb.byte(); case 'int': return bb.int(); case 'uint': return bb.uint();
        case 'float': return bb.float(); case 'string': return bb.string(); case 'int64': return bb.int64(); case 'uint64': return bb.uint64();
      }
      const d = byName.get(type); if (!d) throw new Error('kiwi: unknown type ' + type);
      return decode(bb, d);
    };
    const readField = (bb, f) => {
      if (f.isArray) { if (f.type === 'byte') return bb.bytes().slice(); const n = bb.uint(); const out = new Array(n); for (let i = 0; i < n; i++) out[i] = readOne(bb, f.type); return out; }
      return readOne(bb, f.type);
    };
    function decode(bb, d) {
      if (d.kind === 'ENUM') { const v = bb.uint(); const f = d.byValue.get(v); return f ? f.name : v; }
      const out = {};
      if (d.kind === 'STRUCT') { for (const f of d.fields) out[f.name] = readField(bb, f); return out; }
      for (;;) { const id = bb.uint(); if (id === 0) return out; const f = d.byValue.get(id); if (!f) throw new Error(`kiwi: unknown field ${id} in ${d.name}`); out[f.name] = readField(bb, f); }
    }
    return { decode: (u8, root = 'Message') => { const d = byName.get(root); if (!d) throw new Error('kiwi: no ' + root); return decode(new BB(u8), d); } };
  }

  // ---- containers: zip, fig-kiwi archive, deflate / zstd ------------------------------------------------------------
  const isZstd = u8 => u8.length > 4 && u8[0] === 0x28 && u8[1] === 0xB5 && u8[2] === 0x2F && u8[3] === 0xFD;
  let fzstdP = null;
  function loadZstd() {
    if (window.fzstd) return Promise.resolve(window.fzstd);
    if (!fzstdP) fzstdP = new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/fzstd@0.1.1/umd/index.js'; s.onload = () => window.fzstd ? res(window.fzstd) : rej(new Error('zstd decoder did not load')); s.onerror = () => { fzstdP = null; rej(new Error('Could not load the zstd decoder this file needs')); }; document.head.appendChild(s); });
    return fzstdP;
  }
  async function inflateRaw(u8) {
    const ds = new DecompressionStream('deflate-raw'); const w = ds.writable.getWriter(); w.write(u8).catch(() => { }); w.close().catch(() => { });
    return new Uint8Array(await new Response(ds.readable).arrayBuffer());
  }
  async function unpack(u8) {
    if (isZstd(u8)) { const z = await loadZstd(); return z.decompress(u8); }
    try { return await inflateRaw(u8); } catch (e) { return u8; } // some chunks are stored uncompressed
  }
  function readZip(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('not a zip');
    const n = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true); const out = new Map(); const td = new TextDecoder();
    for (let k = 0; k < n; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
      const name = td.decode(u8.subarray(p + 46, p + 46 + nlen)); p += 46 + nlen + elen + clen;
      const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
      out.set(name, { method, data: u8.subarray(start, start + csize) });
    }
    return out;
  }
  async function zipEntry(e) { if (e.method === 0) return e.data; if (e.method === 8) return inflateRaw(e.data); throw new Error('unsupported zip compression ' + e.method); }
  function readArchive(u8) {
    const head = new TextDecoder().decode(u8.subarray(0, 8));
    if (head !== 'fig-kiwi' && head !== 'fig-jam.') throw new Error('Not Figma data (no fig-kiwi header)');
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); let p = 8; const version = dv.getUint32(p, true); p += 4; const files = [];
    while (p + 4 <= u8.length) { const size = dv.getUint32(p, true); p += 4; if (p + size > u8.length) break; files.push(u8.subarray(p, p + size)); p += size; }
    return { version, files, jam: head === 'fig-jam.' };
  }
  async function decodeArchive(u8) {
    const { version, files, jam } = readArchive(u8);
    if (files.length < 2) throw new Error('Figma data is missing its schema or content');
    const schema = decodeSchema(await unpack(files[0]));
    const message = compile(schema).decode(await unpack(files[1]));
    return { version, message, jam };
  }
  const hex = u8 => Array.from(u8 || [], b => b.toString(16).padStart(2, '0')).join('');

  // A .fig file (zip or bare archive) or ArrayBuffer -> { message, images: Map(hash -> bytes) }
  async function readFile(input) {
    const u8 = input instanceof Uint8Array ? input : new Uint8Array(input instanceof ArrayBuffer ? input : await input.arrayBuffer());
    const images = new Map();
    if (u8[0] === 0x50 && u8[1] === 0x4B) {
      const zip = readZip(u8);
      let main = zip.get('canvas.fig') || zip.get('canvas.jam') || [...zip.entries()].find(([k]) => /\.(fig|jam)$/.test(k))?.[1];
      // whatever it is called: the entry that starts with the archive's signature
      if (!main) for (const [k, e] of zip) { if (k.endsWith('/') || /^images\//.test(k)) continue; try { const head = new TextDecoder().decode((await zipEntry(e)).subarray(0, 8)); if (head === 'fig-kiwi' || head === 'fig-jam.') { main = e; break; } } catch { } }
      if (!main) throw new Error('This zip has no canvas.fig inside');
      for (const [k, e] of zip) if (/^images\//.test(k) && !k.endsWith('/')) images.set(k.slice(7).toLowerCase(), e);
      const res = await decodeArchive(await zipEntry(main));
      return { ...res, images, imageEntry: zipEntry };
    }
    const res = await decodeArchive(u8);
    return { ...res, images, imageEntry: zipEntry };
  }
  // Clipboard HTML from Figma carries the archive base64-encoded between (figma) markers.
  const hasFigmaHTML = html => typeof html === 'string' && html.includes('(figma)') && html.includes('(/figma)');
  async function readClipboardHTML(html) {
    const m = /\(figma\)([A-Za-z0-9+/=\s]+?)\(\/figma\)/.exec(html); if (!m) throw new Error('No Figma data on the clipboard');
    const bin = atob(m[1].replace(/\s+/g, '')); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    let meta = null; const mm = /\(figmeta\)([A-Za-z0-9+/=\s]+?)\(\/figmeta\)/.exec(html); if (mm) { try { meta = JSON.parse(atob(mm[1].replace(/\s+/g, ''))); } catch { } }
    const res = await decodeArchive(u8);
    return { ...res, meta, images: new Map(), imageEntry: zipEntry };
  }

  // ---- geometry helpers ------------------------------------------------------------------------------------------
  const I = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
  const mul = (a, b) => ({ m00: a.m00 * b.m00 + a.m01 * b.m10, m01: a.m00 * b.m01 + a.m01 * b.m11, m02: a.m00 * b.m02 + a.m01 * b.m12 + a.m02, m10: a.m10 * b.m00 + a.m11 * b.m10, m11: a.m10 * b.m01 + a.m11 * b.m11, m12: a.m10 * b.m02 + a.m11 * b.m12 + a.m12 });
  const inv = m => { const det = m.m00 * m.m11 - m.m01 * m.m10 || 1e-9; return { m00: m.m11 / det, m01: -m.m01 / det, m02: (m.m01 * m.m12 - m.m11 * m.m02) / det, m10: -m.m10 / det, m11: m.m00 / det, m12: (m.m10 * m.m02 - m.m00 * m.m12) / det }; };
  const ap = (m, x, y) => ({ x: m.m00 * x + m.m01 * y + m.m02, y: m.m10 * x + m.m11 * y + m.m12 });
  const r2 = v => Math.round(v * 100) / 100;
  const to255 = v => Math.max(0, Math.min(255, Math.round((v || 0) * 255)));
  const colorHex = c => '#' + [c.r, c.g, c.b].map(v => to255(v).toString(16).padStart(2, '0')).join('').toUpperCase();
  const idOf = g => g ? `${g.sessionID}:${g.localID}` : '';
  // Box (x, y, w, h, rotation about the centre) from a transform and a size.
  function boxOf(m, w, h) {
    const rot = Math.atan2(m.m10, m.m00) * 180 / Math.PI;
    const sx = Math.hypot(m.m00, m.m10), sy = Math.hypot(m.m01, m.m11);
    const W = w * sx, H = h * sy;
    const c = ap(m, w / 2, h / 2);
    return { x: r2(c.x - W / 2), y: r2(c.y - H / 2), w: r2(Math.max(1, W)), h: r2(Math.max(1, H)), rotation: Math.abs(rot) < 0.01 ? 0 : r2(rot) };
  }

  // ---- paints, effects, text ---------------------------------------------------------------------------------------
  const visiblePaints = ps => (ps || []).filter(p => p && p.visible !== false && (p.opacity ?? 1) > 0.001);
  function gradientOf(p, w, h) {
    const stops = (p.stops || []).map(s => ({ c: colorHex(s.color), p: r2(s.position), a: r2((s.color.a ?? 1) * (p.opacity ?? 1)) }));
    if (stops.length < 2) return null;
    if (p.type === 'GRADIENT_RADIAL' || p.type === 'GRADIENT_DIAMOND' || p.type === 'GRADIENT_ANGULAR') return { type: 'radial', stops };
    let angle = 180;
    if (p.transform) { const t = inv(p.transform); const a = ap(t, 0, 0.5), b = ap(t, 1, 0.5); const dx = (b.x - a.x) * (w || 1), dy = (b.y - a.y) * (h || 1); angle = Math.round((Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360); }
    return { type: 'linear', angle, stops };
  }
  // The first visible paint decides; Figma stacks paints, we keep the top solid/gradient/image.
  function mainPaint(ps) { const v = visiblePaints(ps); return v.length ? v[v.length - 1] : null; }
  // Of several drop shadows (Elevation/XL is two), the softest stands for the elevation; spread widens the blur.
  function shadowOf(effects) {
    let e = null; for (const x of effects || []) if (x && x.visible !== false && x.type === 'DROP_SHADOW' && (!e || (x.radius || 0) + (x.spread || 0) > (e.radius || 0) + (e.spread || 0))) e = x;
    if (!e) return null;
    return { on: true, x: r2(e.offset ? e.offset.x : 0), y: r2(e.offset ? e.offset.y : 0), blur: r2((e.radius || 0) + Math.max(0, e.spread || 0) * 2), color: colorHex(e.color || { r: 0, g: 0, b: 0 }), alpha: r2(e.color ? e.color.a ?? 0.25 : 0.25) };
  }
  function strokeOf(n) {
    const p = mainPaint(n.strokePaints); if (!p || p.type !== 'SOLID' || !(n.strokeWeight > 0)) return null;
    return { color: colorHex(p.color), width: r2(n.strokeWeight) };
  }
  // Dugma paints a stroke inside the box. A design's centre or outside stroke keeps its place by growing the box.
  function outsetStroke(b, n) {
    if (!b || !b.stroke || !(b.stroke.width > 0) || !n) return b; const k = n.strokeAlign === 'OUTSIDE' ? 1 : n.strokeAlign === 'CENTER' ? 0.5 : 0; if (!k) return b;
    const d = b.stroke.width * k; b.x = r2(b.x - d); b.y = r2(b.y - d); b.w = r2(b.w + 2 * d); b.h = r2(b.h + 2 * d); if (b.radius) b.radius = r2(b.radius + d); return b;
  }
  const WEIGHTS = [[/thin|hairline/i, 100], [/extra ?light|ultra ?light/i, 200], [/light/i, 300], [/semi ?bold|demi ?bold/i, 600], [/extra ?bold|ultra ?bold/i, 800], [/black|heavy/i, 900], [/bold/i, 700], [/medium/i, 500]];
  const weightOf = style => { for (const [re, w] of WEIGHTS) if (re.test(style || '')) return w; return 400; };
  function fontFamilyCss(family) {
    family = String(family || 'Inter').replace(/["'<>]/g, ''); if (typeof Brand !== 'undefined' && Brand.matchFamily) family = Brand.matchFamily(family);
    if (typeof Brand !== 'undefined' && (Brand.FONTS[family] || Brand.customFonts[family])) return Brand.fontCss(family);
    return `"${family}", Inter, system-ui, sans-serif`;
  }
  // Figma's Auto line height is the face's ascent plus descent; measured when the face is loaded here, else 1.2.
  function autoLineHeight(css, weight) {
    try { const fam = String(css).split(',')[0]; if (typeof Text !== 'undefined' && Text.metrics && document.fonts.check(`${weight} 16px ${fam}`)) { const m = Text.metrics({ family: css, weight }); const lh = m.asc + m.desc; if (lh > 0.9 && lh < 1.8) return Math.round(lh * 1000) / 1000; } } catch { }
    return 1.2;
  }
  function numberOf(v, size, dflt) { if (!v || typeof v.value !== 'number') return dflt; if (v.units === 'PIXELS') return size ? v.value / size : dflt; if (v.units === 'PERCENT') return v.value / 100; return v.value || dflt; }
  // Vector geometry: a blob of commands (0 close, 1 move, 2 line, 3 quad, 4 cubic) with little-endian float32 points.
  function pathOf(bytes) {
    if (!bytes || !bytes.length) return '';
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let i = 0; const out = [];
    const f = () => { const v = dv.getFloat32(i, true); i += 4; return r2(v); };
    const ARGS = [0, 2, 2, 4, 6]; const CMD = ['Z', 'M', 'L', 'Q', 'C'];
    while (i < bytes.length) {
      const c = bytes[i++]; if (c > 4 || i + ARGS[c] * 4 > bytes.length) break;
      const args = []; for (let k = 0; k < ARGS[c]; k++) args.push(f());
      out.push(CMD[c] + args.join(' '));
    }
    return out.join('');
  }

  // ---- conversion ----------------------------------------------------------------------------------------------------
  const CONTAINERS = new Set(['FRAME', 'GROUP', 'SYMBOL', 'INSTANCE', 'SECTION']);
  const VECTORS = new Set(['VECTOR', 'STAR', 'LINE', 'REGULAR_POLYGON', 'BOOLEAN_OPERATION', 'HIGHLIGHT', 'WASHI_TAPE']);
  // FigJam's own node types. Data that holds any of them (or says it is a .jam) is a board, not screens.
  const BOARD_TYPES = new Set(['STICKY', 'SHAPE_WITH_TEXT', 'CONNECTOR', 'STAMP', 'CODE_BLOCK', 'WIDGET', 'TABLE', 'HIGHLIGHT', 'WASHI_TAPE', 'LINK_UNFURL']);
  function isBoard(data) {
    if (!data || !data.message) return false; if (data.jam) return true;
    const nodes = data.message.nodeChanges || []; const doc = nodes.find(n => n && n.type === 'DOCUMENT');
    if (doc && /figjam|whiteboard/i.test(String(doc.editorType || ''))) return true;
    return nodes.some(n => n && n.phase !== 'REMOVED' && (n.type === 'STICKY' || n.type === 'SHAPE_WITH_TEXT' || n.type === 'CONNECTOR'));
  }
  const STAMPS = [[/thumbs?[ _-]?down|dislike|-1/i, '👎'], [/thumbs?[ _-]?up|like|\+1/i, '👍'], [/heart|love/i, '❤️'], [/star/i, '⭐'], [/question/i, '❓'], [/check|done|tick|yes/i, '✅'], [/cross|\bno\b|\bx\b/i, '❌'], [/plus/i, '➕'], [/minus/i, '➖'], [/fire|hot/i, '🔥'], [/eyes|look/i, '👀'], [/party|tada|celebrat|confetti/i, '🎉'], [/laugh|joy|haha|lol/i, '😂'], [/clap/i, '👏'], [/idea|bulb/i, '💡'], [/warn|alert|exclam/i, '⚠️'], [/rocket/i, '🚀'], [/smil|happy/i, '🙂'], [/sad/i, '🙁']];
  const lum = hex => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return 1; const v = parseInt(m[1], 16); const c = [v >> 16 & 255, v >> 8 & 255, v & 255].map(x => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  // Figma auto layout -> our stack settings (null when the node does not stack its children).
  const ALIGN = { MIN: 'start', CENTER: 'center', MAX: 'end' };
  function autoOf(n) {
    const mode = n.stackMode === 'HORIZONTAL' || n.stackMode === 'GRID' ? 'horizontal' : n.stackMode === 'VERTICAL' ? 'vertical' : null; if (!mode) return null;
    const legacy = n.stackPadding || 0; const l = n.stackHorizontalPadding ?? legacy, t = n.stackVerticalPadding ?? legacy; const r = n.stackPaddingRight ?? l, b = n.stackPaddingBottom ?? t;
    const just = n.stackPrimaryAlignItems || n.stackJustify || 'MIN'; const cross = n.stackCounterAlignItems || 'MIN';
    return { v: 2, mode, wrap: n.stackWrap === 'WRAP' || n.stackMode === 'GRID', gap: r2(n.stackSpacing || 0), gapAuto: just === 'SPACE_BETWEEN' || just === 'SPACE_EVENLY', counterGap: r2(n.stackCounterSpacing ?? n.stackSpacing ?? 0), counterGapAuto: n.stackCounterAlignContent === 'SPACE_BETWEEN', pad: { t: r2(t), r: r2(r), b: r2(b), l: r2(l) }, main: ALIGN[just] || 'start', cross: cross === 'BASELINE' ? 'baseline' : ALIGN[cross] || 'start' };
  }
  // message -> { frames: [{name, x, y, layout, clip, autoLayout}], stats }. opts.layout: 'auto' keeps Figma's auto
  // layout (stacks reflow here too); 'fixed' keeps every position as drawn. Frames inside frames are boxes either way.
  async function convert(data, env, opts = {}) {
    const BOARD = !!opts.board; const AUTO = opts.layout !== 'fixed' && !BOARD;
    const made1 = new Map();   // node guid -> the block it became (what a connector holds on to)
    const absM = new Map();    // node guid -> its transform into page space (for connector ends given relative to a node)
    const pendingConnectors = [];
    const { message } = data; const blobs = message.blobs || [];
    const nodes = (message.nodeChanges || []).filter(n => n && n.guid && n.phase !== 'REMOVED');
    const byId = new Map(nodes.map(n => [idOf(n.guid), n]));
    const kids = new Map();
    for (const n of nodes) { const pid = n.parentIndex && idOf(n.parentIndex.guid); if (!pid) continue; if (!kids.has(pid)) kids.set(pid, []); kids.get(pid).push(n); }
    for (const list of kids.values()) list.sort((a, b) => (a.parentIndex.position < b.parentIndex.position ? -1 : a.parentIndex.position > b.parentIndex.position ? 1 : 0));
    const childrenOf = n => kids.get(idOf(n.guid)) || [];
    // image bytes by hash, from the zip or from blobs inside the message
    const imageCache = new Map();
    async function imageAsset(paint) {
      const img = paint.image || paint.imageThumbnail; if (!img) return null;
      const key = img.hash ? hex(img.hash) : img.dataBlob != null ? 'blob' + img.dataBlob : null; if (!key) return null;
      if (imageCache.has(key)) return imageCache.get(key);
      let bytes = null;
      if (img.dataBlob != null && blobs[img.dataBlob]) bytes = blobs[img.dataBlob].bytes;
      else if (data.images && data.images.has(key)) bytes = await data.imageEntry(data.images.get(key));
      let asset = null;
      if (bytes && bytes.length) {
        const mime = bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xFF ? 'image/jpeg' : bytes[0] === 0x47 ? 'image/gif' : bytes[0] === 0x52 ? 'image/webp' : 'image/png';
        let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        try { asset = await env.addImage(`data:${mime};base64,${btoa(bin)}`, img.name || 'Figma image'); } catch { asset = null; }
      }
      imageCache.set(key, asset); return asset;
    }
    const stats = { nodes: nodes.length, blocks: 0, skipped: {}, images: 0, missingImages: 0, instances: 0 };
    const skip = t => { stats.skipped[t] = (stats.skipped[t] || 0) + 1; };

    // Walk a subtree; m is the transform from this node's parent space into frame space.
    // Sizing from Figma: text auto-resize, hugging stacks, and Fill / absolute for children of a stack.
    function applySizing(n, b, parentNode) {
      if (!AUTO) return;
      if (n.type === 'TEXT') { const r = n.textAutoResize; if (r === 'WIDTH_AND_HEIGHT') { b.sizeW = 'hug'; b.sizeH = 'hug'; } else if (r === 'HEIGHT') b.sizeH = 'hug'; else b.sizeH = 'fixed'; }
      if (b.kind === 'box' && b.auto) { const prim = n.stackPrimarySizing && n.stackPrimarySizing !== 'FIXED' ? 'hug' : 'fixed', cnt = n.stackCounterSizing && n.stackCounterSizing !== 'FIXED' ? 'hug' : 'fixed'; if (b.auto.mode === 'horizontal') { b.sizeW = prim; b.sizeH = cnt; } else { b.sizeH = prim; b.sizeW = cnt; } }
      const ps = parentNode && autoOf(parentNode); if (!ps) return;
      if (n.stackPositioning === 'ABSOLUTE') { b.absolute = true; return; }
      const H = ps.mode === 'horizontal';
      if ((n.stackChildPrimaryGrow || 0) > 0) { if (H) b.sizeW = 'fill'; else b.sizeH = 'fill'; }
      if (n.stackChildAlignSelf === 'STRETCH') { if (H) b.sizeH = 'fill'; else b.sizeW = 'fill'; }
      const mn = n.minSize && n.minSize.value, mx = n.maxSize && n.maxSize.value;
      if (mn) { if (mn.x > 0) b.minW = r2(mn.x); if (mn.y > 0) b.minH = r2(mn.y); } if (mx) { if (mx.x > 0 && mx.x < 1e6) b.maxW = r2(mx.x); if (mx.y > 0 && mx.y < 1e6) b.maxH = r2(mx.y); }
    }
    let out = null;
    async function walk(n, m, opacity, outList, overrides, depth, parentId, parentNode) {
      if (depth > 40 || n.visible === false || n.mask) return;
      out = outList;
      const ov = overrides && overrides.get(idOf(n.guid)); if (ov) n = { ...n, ...ov };
      n = inheritFromMain(n);
      if (n.visible === false) return;
      const local = n.transform || I; const M = mul(m, local); absM.set(idOf(n.guid), M);
      const w = n.size ? n.size.x : 0, h = n.size ? n.size.y : 0;
      const box = boxOf(M, w, h);
      const op = opacity * (n.opacity ?? 1);
      // The first block a node makes takes its place in the parent's stack; any extra layers ride along absolutely.
      let made = 0;
      const common = b => { if (!made) made1.set(idOf(n.guid), b.id); if (box.rotation) b.rotation = box.rotation; if (op < 0.999 && b.kind !== 'box') b.opacity = r2(op); else if (op < 0.999) b.opacity = r2(n.opacity ?? 1); const sh = shadowOf(n.effects); if (sh) b.shadow = sh; outsetStroke(b, n); if (n.name) b.label = String(n.name).slice(0, 80); if (parentId) b.parent = parentId; if (made++ === 0) applySizing(n, b, parentNode); else if (parentNode && AUTO && autoOf(parentNode)) b.absolute = true; stats.blocks++; out.push(b); return b; };
      const t = n.type;
      if (t === 'TEXT') { textBlock(n, box, common); return; }
      // board things
      if (t === 'STICKY') { stickyBlock(n, box, common); return; }
      if (t === 'SHAPE_WITH_TEXT') { shapeTextBlock(n, box, common, w, h); return; }
      if (t === 'CONNECTOR') { pendingConnectors.push({ n, m, list: outList }); return; }
      if (t === 'CODE_BLOCK') { codeBlock(n, box, common); return; }
      if (t === 'LINK_UNFURL') { const d = n.linkPreviewData || {}; const label = String(d.title || d.url || n.name || 'Link').slice(0, 200); const b = { id: uid(), kind: 'field', x: box.x, y: box.y, w: Math.max(120, box.w), h: Math.max(48, box.h), radius: 12, fill: '#FFFFFF', stroke: { color: '#C9C8D1', width: 1.5 }, text: label, font: { family: fontFamilyCss('Inter'), weight: 500, size: 16, lineHeight: 1.3 }, color: '#1E1C1A', decorative: false, path: 'shape_' + uid() }; common(b); if (typeof Canvas !== 'undefined') Canvas.refit(b); return; }
      if (t === 'STAMP') { const hit = STAMPS.find(([re]) => re.test(n.name || '')); if (hit || !childrenOf(n).length) { const sz = Math.max(32, Math.min(96, Math.max(box.w, box.h) || 56)); common({ id: uid(), kind: 'stamp', x: r2(box.x + box.w / 2 - sz / 2), y: r2(box.y + box.h / 2 - sz / 2), w: sz, h: sz, text: hit ? hit[1] : '📍', decorative: true, path: 'stamp_' + uid() }); return; } }
      let boxId = null;
      if (BOARD && t === 'SECTION') {
        const p = mainPaint(n.fillPaints); const a = p && p.type === 'SOLID' ? (p.color.a ?? 1) * (p.opacity ?? 1) : 1;
        const b = { id: uid(), kind: 'box', x: box.x, y: box.y, w: Math.max(40, box.w), h: Math.max(40, box.h), fill: p && p.type === 'SOLID' ? colorHex(p.color) : '#F3F2FA', radius: 8, clip: false, section: { title: String(n.name || 'Section').slice(0, 80), outside: true }, decorative: true, path: 'section_' + uid() };
        if (a < 0.999) b.fillAlpha = r2(a); const st = strokeOf(n); if (st) b.stroke = st;
        common(b); delete b.shadow; delete b.rotation; boxId = b.id;
        for (const c of childrenOf(n)) await walk(c, M, 1, out, overrides, depth + 1, boxId, null);
        return;
      }
      if (t === 'STAMP' || CONTAINERS.has(t)) {
        boxId = await containerBox(n, box, common, t === 'STAMP' ? 'GROUP' : t, op);
      } else if (t === 'RECTANGLE' || t === 'ROUNDED_RECTANGLE') {
        await fillBlocks(n, box, common, 'rect');
      } else if (t === 'ELLIPSE') {
        const p = mainPaint(n.fillPaints); const st = strokeOf(n);
        if (p && p.type === 'IMAGE') await imageBlock(n, box, common, p, Math.min(box.w, box.h) / 2);
        else if (p || st) { const b = { id: uid(), kind: 'shape', shape: Math.abs(box.w - box.h) < 0.5 ? 'circle' : 'ellipse', x: box.x, y: box.y, w: box.w, h: box.h, fill: p && p.type === 'SOLID' ? colorHex(p.color) : 'none', decorative: true }; if (p && p.type !== 'SOLID') { const g = gradientOf(p, w, h); if (g) b.gradient = g; b.fill = g ? g.stops[0].c : '#000000'; } if (p && p.type === 'SOLID' && (p.color.a ?? 1) * (p.opacity ?? 1) < 0.999) b.opacity = r2((b.opacity || 1) * (p.color.a ?? 1) * (p.opacity ?? 1)); if (st) b.stroke = st; common(b); }
      } else if (VECTORS.has(t)) {
        vectorBlock(n, box, common, w, h);
        if (t === 'BOOLEAN_OPERATION') return; // operands are already inside its geometry
      } else { skip(t); }
      const kidParent = boxId || parentId; const kidNode = boxId ? n : parentNode;
      // inside a box, opacity lives on the box
      const kidOp = boxId ? 1 : op;
      // children
      if (t === 'INSTANCE') {
        stats.instances++;
        const sym = n.symbolData && byId.get(idOf(n.symbolData.symbolID));
        const own = childrenOf(n);
        if (own.length) { for (const c of own) await walk(c, M, kidOp, out, overrides, depth + 1, kidParent, kidNode); }
        else if (sym) {
          // expand the main component inside the instance box; overrides keyed by the last guid of their path
          const ovs = new Map(overrides || []);
          for (const o of (n.symbolData.symbolOverrides || [])) { const path = o.guidPath && o.guidPath.guids; if (!path || !path.length) continue; const { guidPath, ...fields } = o; ovs.set(idOf(path[path.length - 1]), fields); }
          const sw = sym.size ? sym.size.x : w, shh = sym.size ? sym.size.y : h;
          const scale = { m00: sw ? w / sw : 1, m01: 0, m02: 0, m10: 0, m11: shh ? h / shh : 1, m12: 0 };
          for (const c of childrenOf(sym)) await walk(c, mul(M, scale), kidOp, out, ovs, depth + 1, kidParent, kidNode);
        }
        return;
      }
      if (t === 'STAMP' || CONTAINERS.has(t)) for (const c of childrenOf(n)) await walk(c, M, kidOp, out, overrides, depth + 1, kidParent, kidNode);
    }
    // A frame, component, instance or group inside a screen becomes a box: its first solid or gradient paint is the
    // box's fill, image paints become an image inside it, and (when kept) its auto layout drives its children.
    async function containerBox(n, box, common, t, op) {
      const paints = t === 'GROUP' ? [] : visiblePaints(n.fillPaints);
      const radius = r2(n.cornerRadius || Math.max(n.rectangleTopLeftCornerRadius || 0, n.rectangleTopRightCornerRadius || 0, n.rectangleBottomLeftCornerRadius || 0, n.rectangleBottomRightCornerRadius || 0) || 0);
      const b = { id: uid(), kind: 'box', x: box.x, y: box.y, w: Math.max(1, box.w), h: Math.max(1, box.h), fill: 'none', radius, clip: t !== 'GROUP' && !n.frameMaskDisabled, decorative: true };
      const main = paints.filter(p => p.type === 'SOLID' || /^GRADIENT/.test(p.type));
      if (main.length) { const p = main[main.length - 1]; if (p.type === 'SOLID') { b.fill = colorHex(p.color); const a = (p.color.a ?? 1) * (p.opacity ?? 1); if (a < 0.999) b.fillAlpha = r2(a); } else { const g = gradientOf(p, n.size ? n.size.x : 0, n.size ? n.size.y : 0); if (g) { b.gradient = g; b.fill = g.stops[0].c; } } }
      const st = t === 'GROUP' ? null : strokeOf(n); if (st) b.stroke = st;
      const auto = AUTO && t !== 'GROUP' ? autoOf(n) : null; if (auto) b.auto = auto;
      if (op < 0.999) b.opacity = r2(op);
      common(b);
      // image fills sit inside the box, behind its content
      for (const p of paints) if (p.type === 'IMAGE') { const asset = await imageAsset(p); if (asset) stats.images++; else stats.missingImages++; stats.blocks++; out.push({ id: uid(), kind: 'image', parent: b.id, absolute: auto ? true : undefined, x: box.x, y: box.y, w: box.w, h: box.h, asset: asset ? asset.id : null, focal: 'xMidYMid', fit: p.imageScaleMode === 'FIT' ? 'contain' : 'cover', radius, decorative: false, path: 'image_' + uid(), placeholder: '#D9D9DE' }); }
      return b.id;
    }
    async function fillBlocks(n, box, common, role) {
      const paints = visiblePaints(n.fillPaints);
      const radius = r2(n.cornerRadius || Math.max(n.rectangleTopLeftCornerRadius || 0, n.rectangleTopRightCornerRadius || 0, n.rectangleBottomLeftCornerRadius || 0, n.rectangleBottomRightCornerRadius || 0) || 0);
      const st = strokeOf(n);
      for (const p of paints) {
        if (p.type === 'IMAGE') { await imageBlock(n, box, common, p, radius); continue; }
        const b = { id: uid(), kind: 'field', x: box.x, y: box.y, w: box.w, h: box.h, radius, fill: '#000000', decorative: true };
        if (role === 'container') b.container = true;
        if (p.type === 'SOLID') { b.fill = colorHex(p.color); const a = (p.color.a ?? 1) * (p.opacity ?? 1); if (a < 0.999) b.alpha = r2(a); }
        else { const g = gradientOf(p, n.size ? n.size.x : 0, n.size ? n.size.y : 0); if (!g) continue; b.gradient = g; b.fill = g.stops[0].c; }
        common(b);
      }
      if (st) { const last = out && out[out.length - 1]; if (paints.length && last && last.kind === 'field' && last.x === box.x && last.y === box.y && !last.stroke) { last.stroke = st; outsetStroke(last, n); } else common({ id: uid(), kind: 'field', x: box.x, y: box.y, w: box.w, h: box.h, radius, fill: 'none', alpha: 0, stroke: st, decorative: true }); }
    }
    async function imageBlock(n, box, common, p, radius) {
      const asset = await imageAsset(p);
      if (asset) stats.images++; else stats.missingImages++;
      common({ id: uid(), kind: 'image', x: box.x, y: box.y, w: box.w, h: box.h, asset: asset ? asset.id : null, focal: 'xMidYMid', fit: p.imageScaleMode === 'FIT' ? 'contain' : 'cover', radius: radius || 0, decorative: false, path: 'image_' + uid(), placeholder: '#D9D9DE' });
    }
    function vectorBlock(n, box, common, w, h) {
      const fill = mainPaint(n.fillPaints); const strokeP = mainPaint(n.strokePaints);
      const parts = [];
      const fillCol = fill && fill.type === 'SOLID' ? colorHex(fill.color) : fill ? (gradientOf(fill, w, h) || { stops: [{ c: '#000000' }] }).stops[0].c : null;
      const fillA = fill && fill.type === 'SOLID' ? (fill.color.a ?? 1) * (fill.opacity ?? 1) : 1;
      for (const g of (n.fillGeometry || [])) { const d = pathOf(blobs[g.commandsBlob] && blobs[g.commandsBlob].bytes); if (d && fillCol) parts.push(`<path d="${d}" fill="${fillCol}"${fillA < 0.999 ? ` fill-opacity="${r2(fillA)}"` : ''}${g.windingRule === 'ODD' ? ' fill-rule="evenodd"' : ''}/>`); }
      if (strokeP && strokeP.type === 'SOLID') for (const g of (n.strokeGeometry || [])) { const d = pathOf(blobs[g.commandsBlob] && blobs[g.commandsBlob].bytes); if (d) parts.push(`<path d="${d}" fill="${colorHex(strokeP.color)}"${g.windingRule === 'ODD' ? ' fill-rule="evenodd"' : ''}/>`); }
      if (!parts.length && n.type === 'LINE' && strokeP && strokeP.type === 'SOLID') { common({ id: uid(), kind: 'line', x: box.x, y: box.y, w: box.w, h: 0, fill: colorHex(strokeP.color), width: r2(n.strokeWeight || 1), decorative: true }); return; }
      if (!parts.length) { skip(n.type + ' (no geometry)'); return; }
      common({ id: uid(), kind: 'vector', x: box.x, y: box.y, w: Math.max(1, box.w), h: Math.max(1, box.h), viewBox: [0, 0, r2(Math.max(w, 0.01)), r2(Math.max(h, 0.01))], svg: parts.join(''), fill: fillCol || '#000000', decorative: true });
    }
    // a board node's words: on the node itself, or (in data that keeps them apart) on a text layer inside it
    const wordsOf = n => { let t = n.textData && n.textData.characters; if (!t) { const kid = childrenOf(n).find(c => c.type === 'TEXT' && c.textData && c.textData.characters); if (kid) t = kid.textData.characters; } return String(t || '').replace(/\u2028|\u2029/g, '\n').replace(/\s+$/, ''); };
    const wordFont = (n, dflt) => ({ family: fontFamilyCss(n.fontName && n.fontName.family ? n.fontName.family : 'Inter'), weight: n.fontName ? weightOf(n.fontName.style) : 500, size: Math.max(11, Math.min(96, Math.round(n.fontSize || dflt))), lineHeight: 1.3 });
    // A sticky: its colour, its words (the note sizes them to fit), who wrote it when the board says so.
    function stickyBlock(n, box, common) {
      const p = mainPaint(n.fillPaints);
      const b = { id: uid(), kind: 'sticky', x: box.x, y: box.y, w: Math.max(40, box.w), h: Math.max(40, box.h), text: wordsOf(n), fill: p && p.type === 'SOLID' ? colorHex(p.color) : '#FFE066', font: wordFont(n, 20), path: 'sticky_' + uid() };
      b.font.weight = Math.min(600, Math.max(400, b.font.weight)); b.fontSizeMax = b.font.size;
      if (lum(b.fill) < 0.2) b.color = '#FFFFFF';
      if (n.authorName && n.authorVisible !== false) b.authorName = String(n.authorName).slice(0, 60);
      common(b); delete b.shadow; if (typeof Canvas !== 'undefined') Canvas.refit(b);
    }
    // A shape with words: rectangles, rounded rectangles, ellipses and diamonds are native; the rarer outlines
    // (triangles, parallelograms, the engineering set) keep their drawn outline with the words on top.
    function shapeTextBlock(n, box, common, w, h) {
      const T = String(n.shapeWithTextType || 'SQUARE'); const p = mainPaint(n.fillPaints); const st = strokeOf(n); const text = wordsOf(n);
      const fill = p && p.type === 'SOLID' ? colorHex(p.color) : p && /^GRADIENT/.test(p.type) ? (gradientOf(p, w, h) || { stops: [{ c: '#FFFFFF' }] }).stops[0].c : null;
      const a = p && p.type === 'SOLID' ? (p.color.a ?? 1) * (p.opacity ?? 1) : 1;
      // FigJam writes white on its strong fills (green, blue, purple, red) and dark on the light ones
      const color = fill && a > 0.5 && lum(fill) < 0.36 ? '#FFFFFF' : '#1E1C1A';
      const base = { x: box.x, y: box.y, w: Math.max(8, box.w), h: Math.max(8, box.h), text, font: wordFont(n, 16), color, decorative: false, path: 'shape_' + uid() };
      base.fontSizeMax = base.font.size;
      const native = T === 'ELLIPSE' || T === 'DIAMOND' || T === 'SQUARE' || T === 'ROUNDED_RECTANGLE';
      const geo = (n.fillGeometry || []).some(g => blobs[g.commandsBlob] && blobs[g.commandsBlob].bytes && blobs[g.commandsBlob].bytes.length);
      if (!native && geo) {
        const before = out.length; vectorBlock(n, box, common, w, h); const drew = out.length > before; const g = 'g' + uid(); if (drew) out[out.length - 1].group = g;
        if (text) { const tb = { id: uid(), kind: 'text', role: 'text', path: 'text_' + uid(), text, x: r2(box.x + box.w * 0.12), y: box.y, w: r2(box.w * 0.76), h: box.h, align: 'center', font: { ...base.font, letterSpacing: 0 }, fill: color, decorative: false }; if (drew) tb.group = g; if (typeof Canvas !== 'undefined') Canvas.refit(tb); tb.y = r2(box.y + (box.h - tb.h) / 2); common(tb); }
        return;
      }
      const b = T === 'ELLIPSE' || T === 'DIAMOND' ? { id: uid(), kind: 'shape', shape: T === 'ELLIPSE' ? 'ellipse' : 'diamond', ...base, fill: fill || '#FFFFFF' }
        : { id: uid(), kind: 'field', ...base, radius: T === 'SQUARE' ? r2(n.cornerRadius || 0) : r2(n.cornerRadius || Math.min(24, Math.min(box.w, box.h) / 5)), fill: fill || '#FFFFFF' };
      if (!fill) { if (b.kind === 'field') { b.fill = 'none'; b.alpha = 0; } else b.fill = 'none'; } else if (a < 0.999) { if (b.kind === 'field') b.alpha = r2(a); else b.opacity = r2(a); }
      if (st) b.stroke = st;
      if (p && /^GRADIENT/.test(p.type)) { const g = gradientOf(p, w, h); if (g) b.gradient = g; }
      common(b); if (typeof Canvas !== 'undefined') Canvas.refit(b);
    }
    // A code block: a dark card with its lines in a monospace face.
    function codeBlock(n, box, common) {
      const text = wordsOf(n).replace(/^[ \t]+/gm, m => '\u00A0'.repeat(m.replace(/\t/g, '  ').length)); const g = 'g' + uid(); // indentation survives line fitting
      common({ id: uid(), kind: 'field', x: box.x, y: box.y, w: Math.max(40, box.w), h: Math.max(24, box.h), radius: 8, fill: '#1E1E1E', decorative: true, group: g });
      if (!text) return;
      const tb = { id: uid(), kind: 'text', role: 'text', path: 'text_' + uid(), text, x: box.x + 16, y: box.y + 12, w: Math.max(24, box.w - 32), h: Math.max(16, box.h - 24), align: 'left', font: { family: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace', weight: 400, size: Math.max(10, Math.round(n.fontSize || 13)), lineHeight: 1.5, letterSpacing: 0 }, fill: '#EDEDED', decorative: false, group: g };
      if (typeof Canvas !== 'undefined') Canvas.refit(tb); common(tb);
    }
    // Connectors come last: their ends name the blocks the other nodes became. An end is a node (with the side it
    // leaves from when the board fixed one) or a loose point.
    function connectorBlocks() {
      const SIDE = { TOP: 't', RIGHT: 'r', BOTTOM: 'b', LEFT: 'l' }; const cap = c => !!c && c !== 'NONE' && c !== 'ROUND' && c !== 'SQUARE';
      for (const c of pendingConnectors) {
        const n = c.n; const M = mul(c.m, n.transform || I); const sz = n.size || { x: 0, y: 0 }; const own = boxOf(M, sz.x, sz.y);
        const dist = q => Math.max(own.x - q.x, 0, q.x - (own.x + own.w)) + Math.max(own.y - q.y, 0, q.y - (own.y + own.h));
        const end = e => {
          if (!e) return null; const nid = e.endpointNodeID ? idOf(e.endpointNodeID) : ''; const bid = nid && made1.get(nid);
          if (bid) return SIDE[e.magnet] ? { id: bid, side: SIDE[e.magnet] } : { id: bid };
          const pos = e.position; if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return null;
          // held by a node that did not come in: the point is given inside that node
          if (nid && absM.has(nid)) { const q = ap(absM.get(nid), pos.x, pos.y); return { x: r2(q.x), y: r2(q.y) }; }
          // a loose point: in the connector's parent space, or in its own; the one that lies on the connector's box
          const inParent = ap(c.m, pos.x, pos.y), inOwn = ap(M, pos.x, pos.y); const q = (sz.x || sz.y) && dist(inOwn) + 0.5 < dist(inParent) ? inOwn : inParent;
          return { x: r2(q.x), y: r2(q.y) };
        };
        const from = end(n.connectorStart) || { x: own.x, y: r2(own.y + own.h / 2) }, to = end(n.connectorEnd) || { x: r2(own.x + own.w), y: r2(own.y + own.h / 2) };
        if (from.id && to.id && from.id === to.id) continue;
        const sc = cap(n.connectorStartCap), ec = n.connectorEndCap === undefined && n.connectorStartCap === undefined ? true : cap(n.connectorEndCap);
        const sp = mainPaint(n.strokePaints);
        const b = { id: uid(), kind: 'connector', x: own.x, y: own.y, w: Math.max(1, own.w), h: Math.max(1, own.h), from, to, arrow: sc && ec ? 'both' : ec ? 'end' : sc ? 'start' : 'none', route: n.connectorLineStyle === 'STRAIGHT' ? 'straight' : 'elbow', text: wordsOf(n).replace(/\s*\n+\s*/g, ' ').slice(0, 200),
          stroke: { color: sp && sp.type === 'SOLID' ? colorHex(sp.color) : '#5E5A56', width: Math.max(1, Math.min(12, r2(n.strokeWeight || 2))) }, font: { family: fontFamilyCss('Inter'), weight: 500, size: Math.max(11, Math.min(32, Math.round(n.fontSize || 14))), lineHeight: 1.3 }, path: 'connector_' + uid() };
        if (Array.isArray(n.dashPattern) && n.dashPattern.some(v => v > 0)) b.dash = true;
        if (n.name && !/^connector/i.test(n.name)) b.label = String(n.name).slice(0, 80);
        stats.blocks++; c.list.push(b);
      }
      pendingConnectors.length = 0;
    }
    function textBlock(n, box, common) {
      const chars = (n.textData && n.textData.characters) || ''; if (!chars.trim()) return;
      const size = r2(n.fontSize || 16); const fam = n.fontName ? n.fontName.family : 'Inter'; const style = n.fontName ? n.fontName.style : 'Regular';
      const p = mainPaint(n.fillPaints);
      const b = {
        id: uid(), kind: 'text', role: 'text', path: 'text_' + uid(), text: chars.replace(/\u2028|\u2029/g, '\n'),
        x: box.x, y: box.y, w: box.w, h: box.h, align: { CENTER: 'center', RIGHT: 'right' }[n.textAlignHorizontal] || 'left',
        font: { family: fontFamilyCss(fam), weight: weightOf(style), size, lineHeight: r2(numberOf(n.lineHeight, size, autoLineHeight(fontFamilyCss(fam), weightOf(style))) || 1.2), letterSpacing: r2(numberOf(n.letterSpacing, size, 0)), transform: n.textCase === 'UPPER' ? 'upper' : n.textCase === 'LOWER' ? 'lower' : undefined, style: /italic|oblique/i.test(style) ? 'italic' : undefined },
        fill: p && p.type === 'SOLID' ? colorHex(p.color) : '#000000', decorative: false,
      };
      if (p && p.type !== 'SOLID' && p.type !== 'IMAGE') { const g = gradientOf(p, box.w, box.h); if (g) { b.gradient = g; b.fill = g.stops[0].c; } }
      if (p && p.type === 'SOLID' && (p.color.a ?? 1) * (p.opacity ?? 1) < 0.999) b.opacity = r2((p.color.a ?? 1) * (p.opacity ?? 1));
      if (n.textDecoration === 'UNDERLINE') b.decoration = 'underline'; else if (n.textDecoration === 'STRIKETHROUGH') b.decoration = 'line-through';
      if (!b.font.transform) delete b.font.transform; if (!b.font.style) delete b.font.style;
      // words styled on their own (characterStyleIDs point into styleOverrideTable) become runs
      const ids = n.textData && n.textData.characterStyleIDs, table = n.textData && n.textData.styleOverrideTable;
      if (typeof Rich !== 'undefined' && Array.isArray(ids) && ids.length && Array.isArray(table) && table.length) {
        const byId = new Map(table.map(o => [o.styleID ?? o.styleId ?? o.id, o])); const runs = []; const src = b.text;
        for (let i = 0; i < src.length; i++) { const sid = ids[i] ?? ids[ids.length - 1] ?? 0; const last = runs[runs.length - 1]; if (last && last.sid === sid) last.text += src[i]; else runs.push({ sid, text: src[i] }); }
        const out = runs.map(r => { const o = { text: r.text }; const ov = byId.get(r.sid); if (!ov || !r.sid) return o;
          if (ov.fontName) { const w = weightOf(ov.fontName.style); if (w !== b.font.weight) o.weight = w; if (/italic|oblique/i.test(ov.fontName.style || '') && !b.font.style) o.italic = true; }
          if (ov.fontSize && Math.abs(ov.fontSize - size) > 0.4) o.size = r2(ov.fontSize);
          if (ov.textDecoration === 'UNDERLINE') o.underline = true; else if (ov.textDecoration === 'STRIKETHROUGH') o.strike = true;
          if (ov.fillPaints) { const fp = mainPaint(ov.fillPaints); if (fp && fp.type === 'SOLID') { const hx = colorHex(fp.color); if (hx !== b.fill) o.fill = hx; } else if (fp && /^GRADIENT/.test(fp.type)) { const g = gradientOf(fp, box.w, box.h); if (g) o.gradient = { type: 'linear', angle: 90, stops: g.stops.map(st => st.c) }; } }
          if (ov.hyperlink && ov.hyperlink.url) o.link = String(ov.hyperlink.url).slice(0, 500);
          return o; });
        const normed = Rich.norm(out); if (Rich.hasStyle(normed) && Rich.plain(normed) === b.text) b.runs = normed;
      }
      // Auto-width text never wraps in Figma; give it room for font substitution.
      if (n.textAutoResize === 'WIDTH_AND_HEIGHT' && !/\n/.test(chars) && !AUTO) { const extra = b.w * 0.15; if (b.align === 'center') b.x -= extra / 2; else if (b.align === 'right') b.x -= extra; b.w += extra; }
      if (/^(headline|title|heading|h1|h2|hero)/i.test(n.name || '') || size >= 40) b.role = 'headline';
      if (typeof Canvas !== 'undefined') Canvas.refit(b);
      common(b);
    }
    const uid = () => Math.random().toString(36).slice(2, 8);
    // An instance without its own paints shows its main component's.
    const VISUAL = ['fillPaints', 'strokePaints', 'strokeWeight', 'strokeAlign', 'cornerRadius', 'effects', 'rectangleTopLeftCornerRadius', 'rectangleTopRightCornerRadius', 'rectangleBottomLeftCornerRadius', 'rectangleBottomRightCornerRadius', 'opacity', 'frameMaskDisabled',
      'stackMode', 'stackSpacing', 'stackPadding', 'stackHorizontalPadding', 'stackVerticalPadding', 'stackPaddingRight', 'stackPaddingBottom', 'stackPrimarySizing', 'stackCounterSizing', 'stackPrimaryAlignItems', 'stackCounterAlignItems', 'stackWrap', 'stackCounterSpacing', 'stackCounterAlignContent'];
    function inheritFromMain(n) {
      if (n.type !== 'INSTANCE' || !n.symbolData) return n;
      const sym = byId.get(idOf(n.symbolData.symbolID)); if (!sym) return n;
      const add = {}; for (const k of VISUAL) if (n[k] === undefined && sym[k] !== undefined) add[k] = sym[k];
      return Object.keys(add).length ? { ...n, ...add } : n;
    }

    // A board: every page's content becomes one list of blocks (pages side by side), sections stay sections.
    if (BOARD) {
      const top = nodes.filter(n => { if (n.type === 'DOCUMENT' || n.type === 'CANVAS' || n.visible === false) return false; const p = n.parentIndex && byId.get(idOf(n.parentIndex.guid)); return !p || p.type === 'CANVAS' || p.type === 'DOCUMENT'; });
      top.sort((a, b) => (a.parentIndex && b.parentIndex && a.parentIndex.position < b.parentIndex.position ? -1 : 1));
      const pageKey = n => { const p = n.parentIndex && byId.get(idOf(n.parentIndex.guid)); return p && p.type === 'CANVAS' ? idOf(p.guid) : ''; };
      const pages = new Map(); for (const n of top) { const p = n.parentIndex && byId.get(idOf(n.parentIndex.guid)); if (p && p.internalOnly) continue; const k = pageKey(n); if (!pages.has(k)) pages.set(k, []); pages.get(k).push(n); }
      const blocks = []; let offX = 0; const names = [];
      for (const [k, list] of pages) {
        // where this page's content sits, from its top nodes' boxes: pages go side by side
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity; for (const n of list) { const bx = boxOf(n.transform || I, n.size ? n.size.x : 0, n.size ? n.size.y : 0); x0 = Math.min(x0, bx.x); y0 = Math.min(y0, bx.y); x1 = Math.max(x1, bx.x + bx.w); }
        if (!Number.isFinite(x0)) continue;
        const T0 = { m00: 1, m01: 0, m02: offX - x0, m10: 0, m11: 1, m12: -y0 };
        for (const n of list) await walk(n, T0, 1, blocks, null, 1, null, null);
        offX += (x1 - x0) + 400; const pg = k && byId.get(k); if (pg && pg.name) names.push(String(pg.name));
      }
      connectorBlocks();
      if (!blocks.length) return { frames: [], board: null, stats };
      // from 0,0: blocks by their boxes, loose connector ends by their points
      const pts = []; for (const b of blocks) { if (b.kind === 'connector') { for (const e of [b.from, b.to]) if (e && !e.id) pts.push([e.x, e.y, e.x, e.y]); } else pts.push([b.x, b.y, b.x + b.w, b.y + b.h]); }
      if (!pts.length) return { frames: [], board: null, stats };
      const bx0 = Math.min(...pts.map(q => q[0])), by0 = Math.min(...pts.map(q => q[1])), bx1 = Math.max(...pts.map(q => q[2])), by1 = Math.max(...pts.map(q => q[3]));
      for (const b of blocks) { b.x = r2(b.x - bx0); b.y = r2(b.y - by0); if (b.kind === 'connector') for (const e of [b.from, b.to]) if (e && !e.id) { e.x = r2(e.x - bx0); e.y = r2(e.y - by0); } }
      const doc = nodes.find(n => n.type === 'DOCUMENT');
      return { frames: [], stats, board: { name: String((names.length === 1 && !/^page 1$/i.test(names[0]) ? names[0] : '') || (doc && doc.name && !/^document$/i.test(doc.name) ? doc.name : '') || 'FigJam board').slice(0, 80), blocks, w: Math.ceil(bx1 - bx0), h: Math.ceil(by1 - by0) } };
    }

    // Top level: nodes that sit on a page (or have no parent in this data).
    const tops = nodes.filter(n => { if (n.type === 'DOCUMENT' || n.type === 'CANVAS') return false; const p = n.parentIndex && byId.get(idOf(n.parentIndex.guid)); return !p || p.type === 'CANVAS' || p.type === 'DOCUMENT'; });
    tops.sort((a, b) => (a.parentIndex && b.parentIndex && a.parentIndex.position < b.parentIndex.position ? -1 : 1));
    // A section is a page-like holder: the frames inside it come in as screens of their own, at their place on the page.
    const expandSections = (list, T0) => list.flatMap(n => { if (n.type !== 'SECTION' || n.visible === false) return T0 === I ? [n] : [{ ...n, transform: mul(T0, n.transform || I) }]; const T = mul(T0, n.transform || I); return expandSections(childrenOf(n), T); });
    const expanded = expandSections(tops, I);
    tops.length = 0; tops.push(...expanded);
    const pageOf = n => { let p = n; for (let k = 0; k < 50 && p; k++) { const q = p.parentIndex && byId.get(idOf(p.parentIndex.guid)); if (!q || q.type === 'CANVAS') return q ? q.name : ''; p = q; } return ''; };
    const frames = []; const loose = [];
    for (let n of tops) {
      if (n.visible === false) continue;
      n = inheritFromMain(n);
      const isScreen = (n.type === 'FRAME' || n.type === 'SYMBOL' || n.type === 'INSTANCE' || n.type === 'SECTION') && n.size && n.size.x >= 8 && n.size.y >= 8;
      if (!isScreen) { loose.push(n); continue; }
      const T = n.transform || I; const W = Math.round(n.size.x), H = Math.round(n.size.y);
      const blocks = [];
      // the screen's own fill becomes the background (or a block when it is an image or there are several)
      const paints = visiblePaints(n.fillPaints); const solid = paints.length === 1 && paints[0].type === 'SOLID' ? paints[0] : null;
      const grad = paints.length === 1 && /^GRADIENT/.test(paints[0].type) ? gradientOf(paints[0], W, H) : null;
      const bg = solid ? colorHex(solid.color) : grad ? grad.stops[0].c : '#FFFFFF';
      const rootAuto = AUTO ? autoOf(n) : null;
      if (!solid && !grad && paints.length) { const tmp = { ...n, transform: I, effects: null, strokePaints: null }; out = blocks; await fillBlocks(tmp, { x: 0, y: 0, w: W, h: H, rotation: 0 }, b => { if (rootAuto) b.absolute = true; stats.blocks++; blocks.push(b); return b; }, 'rect'); }
      if (n.type === 'INSTANCE') { const sym = n.symbolData && byId.get(idOf(n.symbolData.symbolID)); const own = childrenOf(n); const src = own.length ? own : sym ? childrenOf(sym) : []; const sw = sym && sym.size ? sym.size.x : W, sh = sym && sym.size ? sym.size.y : H; const sc = own.length ? I : { m00: sw ? W / sw : 1, m01: 0, m02: 0, m10: 0, m11: sh ? H / sh : 1, m12: 0 }; const ovs = new Map(); if (!own.length) for (const o of (n.symbolData.symbolOverrides || [])) { const path = o.guidPath && o.guidPath.guids; if (!path || !path.length) continue; const { guidPath, ...fields } = o; ovs.set(idOf(path[path.length - 1]), fields); } for (const c of src) await walk(c, sc, 1, blocks, ovs, 1, null, n); }
      else for (const c of childrenOf(n)) await walk(c, I, 1, blocks, null, 1, null, n);
      frames.push({ name: String(n.name || 'Figma frame').slice(0, 80), x: Math.round(T.m02), y: Math.round(T.m12), w: W, h: H, bg, bgGradient: grad, clip: !n.frameMaskDisabled, blocks, page: pageOf(n), autoLayout: rootAuto });
    }
    if (loose.length) {
      const blocks = [];
      for (const n of loose) await walk(n, I, 1, blocks, null, 1, null, null);
      if (blocks.length) {
        const x0 = Math.min(...blocks.map(b => b.x)), y0 = Math.min(...blocks.map(b => b.y)), x1 = Math.max(...blocks.map(b => b.x + b.w)), y1 = Math.max(...blocks.map(b => b.y + b.h));
        for (const b of blocks) { b.x = r2(b.x - x0); b.y = r2(b.y - y0); }
        frames.push({ name: loose.length === 1 ? String(loose[0].name || 'Figma layers') : 'Figma layers', x: Math.round(x0), y: Math.round(y0), w: Math.max(8, Math.ceil(x1 - x0)), h: Math.max(8, Math.ceil(y1 - y0)), bg: '#FFFFFF', clip: false, blocks, loose: true });
      }
    }
    pendingConnectors.length = 0;
    return { frames, stats };
  }
  // Frames from convert() -> layouts the canvas can hold.
  function toLayouts(frames, kit) {
    return frames.map(F => {
      const fmt = { id: 'custom', name: 'Custom', w: F.w, h: F.h, cols: Math.max(4, Math.min(12, Math.round(F.w / 160))) };
      const g = Grid.compute(fmt, { unit: 8, marginRatio: 0.06, gutterUnits: 3 });
      const fg = F.blocks.find(b => b.kind === 'text');
      const layout = {
        id: 'fig-' + Math.random().toString(36).slice(2, 8), seed: 0, archetype: 'figma', archetypeLabel: 'Figma', format: { id: 'custom', name: 'Custom', w: F.w, h: F.h },
        grid: { unit: 8, gutter: g.gutter, cols: g.cols, rows: g.rows, cw: g.cw, rh: g.rh, mx: g.mx, my: g.my, safe: g.safe },
        palette: { bg: F.bg, fg: fg ? fg.fill : '#000000', accent: (F.blocks.find(b => b.kind === 'field' && b.fill && b.fill !== F.bg && b.fill !== 'none') || { fill: fg ? fg.fill : '#000000' }).fill, bgName: 'Figma', ...(F.bgGradient ? { bgGradient: F.bgGradient } : {}) },
        type: { level: 2, headline: 48, body: 16, display: kit.fonts.display, body_font: kit.fonts.body }, brand: kit.name, blocks: F.blocks, meta: { source: 'figma', page: F.page || '' }, metrics: { whitespace: 0, density: 0, balance: 0 },
      };
      return { name: F.name, x: F.x, y: F.y, layout, clip: F.clip, loose: !!F.loose, autoLayout: F.autoLayout || null, page: F.page || '' };
    });
  }
  // ---- Geometry from Figma's metadata (the MCP get_metadata XML: id, name, x, y, width, height per node) -------------
  // Code generated from Figma lays out close to the design, not on it: flex rounding, text metrics and negative gaps
  // drift by a few pixels. The metadata has every node's true box, so a capture of the rendered code is snapped to it.
  // Several XML documents merge: the frame's own (instances unexpanded) plus one per instance that was expanded. An
  // instance that was not expanded borrows the subtree of an expanded instance with the same name (same component),
  // its child ids re-prefixed the way Figma does (I<instance>;<child>).
  function boundsFromMetadata(xmls) {
    const docs = (Array.isArray(xmls) ? xmls : [xmls]).map(x => { try { return new DOMParser().parseFromString(String(x), 'text/xml').documentElement; } catch { return null; } }).filter(e => e && e.tagName !== 'parsererror');
    if (!docs.length) return new Map();
    const byId = new Map(); for (const d of docs) byId.set(d.getAttribute('id'), d);
    const root = docs[0]; const bounds = new Map(); const pre = id => (id.startsWith('I') ? id : 'I' + id) + ';';
    const byName = new Map(); for (const d of docs) for (const el of [d, ...d.querySelectorAll('*')]) if (el.children.length && el.getAttribute('name')) { const k = el.tagName + '|' + el.getAttribute('name'); if (!byName.has(k)) byName.set(k, el); }
    const num = (el, a) => parseFloat(el.getAttribute(a)) || 0;
    const walk = (el, ox, oy, idMap, depth) => {
      if (depth > 40) return;
      let id = el.getAttribute('id') || ''; if (idMap) id = idMap(id); if (el.getAttribute('hidden') === 'true') return;
      const x = ox + num(el, 'x'), y = oy + num(el, 'y'), w = num(el, 'width'), h = num(el, 'height');
      if (id && !bounds.has(id)) bounds.set(id, { x, y, w, h, name: el.getAttribute('name') || '', type: el.tagName, tpl: !!idMap });
      let kids = [...el.children]; let map = idMap;
      if (!kids.length) {
        const own = byId.get(id); if (own && own !== el) kids = [...own.children];
        else if (el.tagName === 'instance') { const t = byName.get(el.tagName + '|' + (el.getAttribute('name') || '')); if (t && t !== el && t.getAttribute('id') !== id) { const from = pre(t.getAttribute('id')), to = pre(id); kids = [...t.children]; const prev = idMap; map = cid => { const m = prev ? prev(cid) : cid; return m.startsWith(from) ? to + m.slice(from.length) : m; }; } }
      }
      for (const k of kids) walk(k, x, y, map, depth + 1);
    };
    walk(root, -num(root, 'x'), -num(root, 'y'), null, 0);
    return bounds;
  }
  // Snap a web capture (WebImport.capturePage of the rendered code) to the design's geometry: each layer moves with the
  // tagged element it belongs to, mapped from that element's rendered box to the node's box in Figma.
  function alignCapture(cap, bounds, opts = {}) {
    if (!cap || !Array.isArray(cap.nodes) || !bounds || !bounds.size) return 0;
    const ox = Number(opts.offsetX) || 0, oy = Number(opts.offsetY) || 0; let moved = 0;
    const r1 = v => Math.round(v * 10) / 10;
    for (const n of cap.nodes) {
      // the nearest tagged element the metadata knows: the layer's own tag, else a tagged ancestor
      let b = n.fig && bounds.get(n.fig), fr = n.figRect, own = !!n.figOwn, border = n.figBorder;
      if (!b && Array.isArray(n.figUp)) for (const up of n.figUp) { const bb = bounds.get(up[0]); if (bb) { b = bb; fr = up.slice(1, 5); border = up.length >= 9 ? up.slice(5, 9) : null; own = false; break; } }
      if (!b || !Array.isArray(fr) || fr.length !== 4 || !(fr[2] > 0) || !(fr[3] > 0)) continue;
      // A stroke outside the node in Figma (an avatar's white ring) is a border around the content in the generated code,
      // and the metadata box excludes it: when the node's box is the rendered content box, the layer takes the border
      // box around Figma's node, so the ring lands where Figma paints it and the picture under it keeps its size.
      if (Array.isArray(border) && border.some(Boolean)) { const [bt, br, bb, bl] = border; if (Math.abs(fr[2] - (bl + br) - b.w) < 0.75 && Math.abs(fr[3] - (bt + bb) - b.h) < 0.75) b = { x: b.x - bl, y: b.y - bt, w: b.w + bl + br, h: b.h + bt + bb }; }
      const sx = b.w > 0 ? b.w / fr[2] : 1, sy = b.h > 0 ? b.h / fr[3] : 1;
      const nx = b.x + ox + (n.x - fr[0]) * sx, ny = b.y + oy + (n.y - fr[1]) * sy;
      let nw = own ? (b.w || n.w) : n.w * sx, nh = own ? (b.h || n.h) : (n.t === 'text' ? n.h : n.h * sy);
      // a borrowed subtree (another instance of the same component) has that instance's text widths: words keep the room
      // the browser gave them, and never less, or a label that fit on one line wraps
      if (n.t === 'text') { if (b.tpl) { nw = n.w; nh = n.h; } else nw = Math.max(nw, n.w); }
      if (Math.abs(nx - n.x) + Math.abs(ny - n.y) + Math.abs(nw - n.w) + Math.abs(nh - n.h) > 0.05) moved++;
      n.x = r1(nx); n.y = r1(ny); n.w = r1(nw); n.h = r1(nh);
    }
    return moved;
  }
  return { readFile, readClipboardHTML, hasFigmaHTML, isBoard, convert, toLayouts, boundsFromMetadata, alignCapture, _kiwi: { decodeSchema, compile, BB }, _pathOf: pathOf, _zip: { readZip, zipEntry }, readArchive };
})();
