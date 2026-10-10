/* Canvas tools, implemented over the editor. Used by the in-app agent and, through the server, by outside agents (MCP).
   During one agent run every change is a single undo step; each MCP call is its own step. */
const AgentTools = (() => {
  let env = null; let run = null;
  const doc = () => CanvasUI.doc;
  const MAX_TEXT = 240;
  function F(id) { const f = Canvas.frameById(doc(), String(id || '')); if (!f) throw new Error(`No screen with id "${id}". Call get_canvas or get_selection for ids.`); return f; }
  function Bk(f, id) { const b = Canvas.blockById(f, String(id || '')); if (!b) throw new Error(`No block "${id}" in screen ${f.id}. Call get_frame for block ids.`); return b; }
  const arr = v => Array.isArray(v) ? v : v == null ? [] : [v];
  const kit = () => env.getKit();
  // A color: hex, or a brand palette name (case-insensitive). Returns {hex, name}.
  function color(v) {
    if (v == null || v === '') throw new Error('Missing color');
    const s = String(v).trim(); const c = kit().colors.find(x => String(x.name || '').toLowerCase() === s.toLowerCase());
    if (c) return { hex: Color.normalize(c.hex), name: c.name };
    try { return { hex: Color.normalize(s), name: null }; } catch { throw new Error(`"${s}" is not a hex color or a brand color name (${kit().colors.map(x => x.name).join(', ')})`); }
  }
  // One write = one undo step per run (the first write of a run snapshots the canvas).
  // One agent run is one undo step: only its first write saves history.
  function firstWrite() { const first = !run || !run.wrote; if (run) run.wrote = true; return first; }
  function write(fn, frames) { return CanvasUI.mutate(fn, { history: firstWrite(), frames }); }
  const note = (s) => { if (run && run.onStep) run.onStep(s); };

  function blockInfo(b) {
    const o = { id: b.id, kind: b.kind };
    if (b.role) o.role = b.role; if (b.label) o.label = b.label; if (b.group) o.group = b.group;
    Object.assign(o, { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) });
    if (b.kind === 'text') o.text = Canvas.sourceText(b).slice(0, MAX_TEXT);
    if (b.kind === 'button') o.text = String(b.text || '').slice(0, MAX_TEXT);
    if (b.kind === 'list') o.items = (b.items || []).map(i => String(i).slice(0, 120)).slice(0, 12);
    if (b.fill) o.fill = b.fillToken ? `${b.fill} (${b.fillToken})` : b.fill;
    if (b.color) o.color = b.color;
    if (b.font) o.font = { family: String(b.font.family).split(',')[0].replace(/["']/g, ''), size: b.font.size, weight: b.font.weight };
    if (b.align && b.align !== 'left') o.align = b.align;
    if (b.kind === 'image') o.image = b.asset ? 'set' : 'empty';
    if (b.kind === 'icon') o.icon = b.name;
    if (b.overflow) o.overflow = true; if (b.hidden) o.hidden = true; if (b.locked) o.locked = true;
    if (b.opacity != null && b.opacity < 1) o.opacity = b.opacity;
    return o;
  }
  function frameInfo(f, withBlocks) {
    const L = f.layout;
    const o = { id: f.id, name: f.name, x: Math.round(f.x), y: Math.round(f.y), w: L.format.w, h: L.format.h, format: L.format.id, background: L.palette.bgToken ? `${L.palette.bg} (${L.palette.bgToken})` : L.palette.bg, look: (L.meta && L.meta.look) || 'original', kind: L.archetypeLabel || L.archetype || 'frame' };
    if (withBlocks) o.blocks = L.blocks.map(blockInfo); else o.blocks = L.blocks.length;
    return o;
  }
  // Props an agent can set on a block, in plain words.
  function applyProps(b, p) {
    if (!p || typeof p !== 'object') throw new Error('props must be an object');
    const num = (k, min = -1e6, max = 1e6) => { const v = Number(p[k]); if (!Number.isFinite(v)) throw new Error(`${k} must be a number`); return Math.max(min, Math.min(max, v)); };
    let refit = false;
    if ('text' in p) { if (b.kind === 'button') b.text = String(p.text).slice(0, 80); else if (b.kind === 'text') { b.text = String(p.text).slice(0, 4000); refit = true; } }
    if ('items' in p && b.kind === 'list') { b.items = arr(p.items).map(String).slice(0, 20); refit = true; }
    for (const k of ['x', 'y']) if (k in p) b[k] = Math.round(num(k));
    for (const k of ['w', 'h']) if (k in p) { b[k] = Math.round(num(k, 4, 20000)); refit = true; }
    if ('fill' in p) { const c = color(p.fill); b.fill = c.hex; if (c.name) b.fillToken = c.name; else delete b.fillToken; delete b.gradient; }
    if ('color' in p) { const c = color(p.color); b.color = c.hex; if (c.name) b.colorToken = c.name; else delete b.colorToken; }
    if (b.font) {
      if ('font_size' in p) { b.font.size = Math.round(num('font_size', 6, 800)); refit = true; }
      if ('font_weight' in p) { b.font.weight = Math.round(num('font_weight', 100, 900) / 100) * 100; refit = true; }
      if ('font_family' in p) { const name = String(p.font_family); if (!Brand.allFontNames().includes(name)) throw new Error(`Unknown font "${name}". Available: ${Brand.allFontNames().join(', ')}`); b.font.family = Brand.fontCss(name); const ws = Brand.fontWeights(name); if (!ws.includes(b.font.weight)) b.font.weight = ws.reduce((q, c) => Math.abs(c - b.font.weight) < Math.abs(q - b.font.weight) ? c : q, ws[0]); refit = true; }
      if ('line_height' in p) { b.font.lineHeight = num('line_height', 0.6, 4); refit = true; }
      if ('letter_spacing' in p) { b.font.letterSpacing = num('letter_spacing', -0.2, 1); refit = true; }
      if ('case' in p) { b.font.transform = p.case === 'upper' ? 'upper' : p.case === 'lower' ? 'lower' : undefined; if (!b.font.transform) delete b.font.transform; refit = true; }
    }
    if ('align' in p && b.kind === 'text') b.align = ['left', 'center', 'right'].includes(p.align) ? p.align : 'left';
    if ('opacity' in p) b.opacity = num('opacity', 0, 1);
    if ('radius' in p) b.radius = Math.round(num('radius', 0, 2000));
    if ('rotation' in p) { let r = num('rotation') % 360; if (r > 180) r -= 360; if (r < -180) r += 360; b.rotation = r; }
    if ('hidden' in p) b.hidden = !!p.hidden;
    if ('label' in p) { if (p.label) b.label = String(p.label).slice(0, 80); else delete b.label; }
    if ('icon' in p && b.kind === 'icon') { if (!Icons.has(String(p.icon))) throw new Error(`Unknown icon. Available: ${Icons.names.join(', ')}`); b.name = String(p.icon); }
    if ('shadow' in p) { const s = p.shadow; if (!s) delete b.shadow; else { const o = typeof s === 'object' ? s : {}; b.shadow = { on: true, x: Number(o.x) || 0, y: Number(o.y ?? 8), blur: Number(o.blur ?? 24), color: o.color ? color(o.color).hex : '#000000', alpha: Math.max(0, Math.min(1, Number(o.alpha ?? 0.25))) }; } }
    if ('stroke' in p) { const s = p.stroke; if (!s || !(Number(s.width) > 0)) delete b.stroke; else b.stroke = { width: Number(s.width), color: color(s.color || '#000000').hex }; }
    if ('gradient' in p) { const g = p.gradient; if (!g) delete b.gradient; else { const stops = arr(g.stops).map((c, i, all) => ({ c: color(typeof c === 'object' ? c.color || c.c : c).hex, p: typeof c === 'object' && c.position != null ? Number(c.position) : all.length > 1 ? i / (all.length - 1) : 0 })); if (stops.length < 2) throw new Error('gradient needs at least two stops'); b.gradient = { type: g.type === 'radial' ? 'radial' : 'linear', angle: Number(g.angle ?? 180), stops }; b.fill = stops[0].c; } }
    if (refit) Canvas.refit(b);
    return b;
  }
  function framesArg(ids) { const list = arr(ids); if (!list.length) throw new Error('frame_ids is empty'); return list.map(F); }
  const dataUrlOf = blob => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });

  const IMPL = {
    get_selection() {
      const s = CanvasUI.selection();
      if (!s.frameIds.length) return { selected: 'nothing', hint: 'Nothing is selected. Use get_canvas to see every screen.', screens: doc().frames.length };
      const frames = s.frameIds.map(F);
      return { screens: frames.map(f => frameInfo(f, frames.length <= 4)), selected_blocks: s.blockIds };
    },
    get_canvas() { return { name: doc().name, screens: doc().frames.map(f => frameInfo(f, false)) }; },
    get_frame({ frame_id, full }) { const f = F(frame_id); if (full) { const L = Canvas.clone(f.layout); delete L.signature; if (L.meta) delete L.meta.original; L.blocks = L.blocks.map(b => { delete b.lines; delete b.inkW; delete b.capacity; return b; }); return { id: f.id, name: f.name, layout: L }; } return frameInfo(f, true); },
    get_brand() {
      const k = kit();
      return { name: k.name, colors: k.colors.map(c => ({ name: c.name, hex: Color.normalize(c.hex), role: c.role })), pairs: Brand.pairs(k).slice(0, 12).map(p => ({ background: p.bgName, bg: p.bg, text: p.fgs[0], accent: p.accents[0] })), fonts: { display: k.fonts.display, body: k.fonts.body, available: Brand.allFontNames() }, voice: k.note || 'Clear, confident, human. Sentence case. No exclamation marks.', copy: k.content };
    },
    async get_screenshot({ frame_id, scale }) { const f = F(frame_id); const s = Math.max(0.25, Math.min(1, Number(scale) || 0.5)); const blob = await env.exportPNG(f.layout, s); return { image: await dataUrlOf(blob), frame_id: f.id, width: Math.round(f.layout.format.w * s), height: Math.round(f.layout.format.h * s) }; },
    get_code({ frame_id, format }) { const f = F(frame_id); const e = { assets: env.getAssets(), kit: kit() }; return format === 'html' ? Canvas.toHTML(f, e) : Canvas.toReact(f, e); },
    select({ frame_ids, block_ids }) { const ids = arr(frame_ids).map(id => F(id).id); if (ids.length === 1 && arr(block_ids).length) CanvasUI.select(ids[0], arr(block_ids).map(String)); else CanvasUI.selectFrames(ids); return { selected: CanvasUI.selection() }; },
    update_blocks({ updates }) {
      const list = arr(updates).slice(0, 300); if (!list.length) throw new Error('updates is empty');
      const touched = new Set(); const overflow = []; const errors = [];
      write(() => { for (const u of list) { try { const f = F(u.frame_id); const b = Bk(f, u.block_id); applyProps(b, u.props); touched.add(f.id); if (b.overflow) overflow.push(b.id); } catch (e) { errors.push(`${u.block_id}: ${e.message}`); } } }, null);
      note(`Updated ${list.length - errors.length} block${list.length - errors.length === 1 ? '' : 's'}`);
      return { updated: list.length - errors.length, overflow, errors };
    },
    add_blocks({ frame_id, blocks }) {
      const f = F(frame_id); const ids = []; const errors = [];
      write(() => { for (const spec of arr(blocks).slice(0, 50)) { try { const b = Canvas.newBlock(spec.kind, f, kit(), null); if (!b) throw new Error(`unknown kind ${spec.kind}`); applyProps(b, spec.props || {}); f.layout.blocks.push(b); ids.push(b.id); } catch (e) { errors.push(e.message); } } if (f.autoLayout.mode !== 'none') Canvas.applyAutoLayout(f); }, [f.id]);
      note(`Added ${ids.length} block${ids.length === 1 ? '' : 's'} to ${f.name}`);
      return { block_ids: ids, errors };
    },
    delete_blocks({ frame_id, block_ids }) { const f = F(frame_id); const ids = arr(block_ids).map(String); const before = f.layout.blocks.length; write(() => Canvas.removeBlocks(f, ids), [f.id]); const n = before - f.layout.blocks.length; note(`Removed ${n} block${n === 1 ? '' : 's'}`); return { removed: n }; },
    create_frame({ format, width, height, name, background }) {
      const fmt = format && Grid.byId[format] ? Grid.byId[format] : (Number(width) > 0 && Number(height) > 0 ? Canvas.customFormat(Number(width), Number(height)) : Grid.byId.square);
      const bg = background ? color(background).hex : undefined;
      const f = CanvasUI.createFrame({ center: true, format: fmt, name: name ? String(name).slice(0, 80) : undefined, bg, history: firstWrite() });
      note(`Created ${f.name}`); return { frame_id: f.id, w: fmt.w, h: fmt.h };
    },
    update_frames({ updates }) {
      const list = arr(updates); const ids = [];
      write(() => { for (const u of list) { const f = F(u.frame_id); if (u.name) f.name = String(u.name).slice(0, 80); if (Number.isFinite(Number(u.x)) && u.x != null) f.x = Math.round(Number(u.x)); if (Number.isFinite(Number(u.y)) && u.y != null) f.y = Math.round(Number(u.y)); if (u.background) { const c = color(u.background); f.layout.palette.bg = c.hex; if (c.name) { f.layout.palette.bgToken = c.name; f.layout.palette.bgName = c.name; } delete f.layout.palette.bgGradient; } ids.push(f.id); } }, null);
      note(`Updated ${ids.length} screen${ids.length === 1 ? '' : 's'}`); return { updated: ids.length };
    },
    duplicate_frames({ frame_ids, copies }) {
      const frames = framesArg(frame_ids); const n = Math.max(1, Math.min(6, Number(copies) || 1)); const out = [];
      write(() => { for (const f of frames) { let x = f.x + f.layout.format.w + 160; for (let i = 0; i < n; i++) { const c = Canvas.pasteFrames(doc(), [f], { x, y: f.y })[0]; out.push(c.id); x += f.layout.format.w + 160; } } }, null);
      note(`Duplicated ${frames.length} screen${frames.length === 1 ? '' : 's'}`); return { frame_ids: out };
    },
    delete_frames({ frame_ids }) { const ids = new Set(framesArg(frame_ids).map(f => f.id)); write(d => { d.frames = d.frames.filter(f => !ids.has(f.id)); }, null); note(`Deleted ${ids.size} screen${ids.size === 1 ? '' : 's'}`); return { deleted: ids.size }; },
    recolor_frames({ frame_ids, background, text, accent }) {
      const frames = framesArg(frame_ids); const bg = color(background); const cols = kit().colors.map(c => Color.normalize(c.hex));
      const fg = text ? color(text).hex : Color.bestForeground(bg.hex, cols, 4.5)[0];
      const acc = accent ? color(accent).hex : Color.normalize((kit().colors.find(c => (c.role === 'accent' || c.role === 'core') && Color.normalize(c.hex) !== bg.hex && Color.contrast(bg.hex, c.hex) >= 3) || { hex: fg }).hex);
      write(() => frames.forEach(f => { Canvas.recolor(f, { bg: bg.hex, fg, accent: acc, bgName: bg.name || undefined }); if (bg.name) f.layout.palette.bgToken = bg.name; }), frames.map(f => f.id));
      note(`Recolored ${frames.length} screen${frames.length === 1 ? '' : 's'} on ${bg.name || bg.hex}`); return { recolored: frames.length, background: bg.hex, text: fg, accent: acc };
    },
    async make_variations({ frame_id, count, mode }) {
      const f = F(frame_id); const n = Math.max(1, Math.min(6, Number(count) || 3)); const m = ['similar', 'explore', 'palette'].includes(mode) ? mode : 'explore';
      const layouts = await env.variations({ frame: f, count: n, mode: m });
      if (!layouts || !layouts.length) return { frame_ids: [], note: 'No variations fit the brand rules for this screen' };
      const added = CanvasUI.placeRow(layouts, f, { history: firstWrite(), names: layouts.map((L, i) => `${f.name.replace(/ · v\d+$/, '')} · v${i + 1}`) });
      note(`Made ${added.length} variation${added.length === 1 ? '' : 's'} of ${f.name}`); return { frame_ids: added.map(x => x.id) };
    },
    apply_look({ frame_ids, look }) { const frames = framesArg(frame_ids); if (!['original', 'wireframe', 'rebrand'].includes(look)) throw new Error('look is original, wireframe or rebrand'); let n = 0; write(() => { for (const f of frames) if (Looks.apply(f, look, kit())) n++; }, frames.map(f => f.id)); note(`${look[0].toUpperCase() + look.slice(1)} look on ${frames.length} screen${frames.length === 1 ? '' : 's'}`); return { changed: n }; },
    replace_text({ frame_ids, find, replace }) { const frames = framesArg(frame_ids); if (!find) throw new Error('find is empty'); const n = write(() => Canvas.replaceText(frames, String(find), String(replace ?? '')), frames.map(f => f.id)); note(`Replaced “${find}” ${n} time${n === 1 ? '' : 's'}`); return { replaced: n }; },
    set_fonts({ frame_ids, display, body }) { const frames = framesArg(frame_ids); for (const n of [display, body]) if (n && !Brand.allFontNames().includes(n)) throw new Error(`Unknown font "${n}". Available: ${Brand.allFontNames().join(', ')}`); write(() => Canvas.setFonts(frames, { display, body, kit: kit() }), frames.map(f => f.id)); note(`Fonts set on ${frames.length} screen${frames.length === 1 ? '' : 's'}`); return { updated: frames.length }; },
    async resize_frames({ frame_ids, format }) { const frames = framesArg(frame_ids); if (!Grid.byId[format]) throw new Error(`Unknown format. Use one of ${Grid.FORMATS.map(f => f.id).join(', ')}`); await CanvasUI.resizeScreens(frames, format, { history: firstWrite() }); note(`Resized ${frames.length} screen${frames.length === 1 ? '' : 's'} to ${Grid.byId[format].name}`); return { resized: frames.length }; },
    async generate_image({ frame_id, block_id, prompt }) {
      const f = F(frame_id); const b = Bk(f, block_id); if (b.kind !== 'image') throw new Error('That block is not an image');
      if (!ImageGen.ready()) throw new Error('No image model is set up. The person can pick Gemini or OpenAI and add a key in Settings.');
      const out = await ImageGen.generate({ prompt: String(prompt), aspect: ImageGen.aspectOf(b.w, b.h) });
      const asset = await env.addImageData(out.dataUrl, `generated · ${out.provider}`);
      write(() => { b.asset = asset.id; b.genPrompt = String(prompt); b.genMeta = { provider: out.provider, model: out.model, ms: out.ms }; }, [f.id]);
      note('Generated an image'); return { ok: true, model: out.model };
    },
    write_layout({ frame_id, layout }) {
      const f = F(frame_id); const L = layout && typeof layout === 'object' ? Canvas.clone(layout) : null;
      if (!L || !L.format || !(L.format.w > 0 && L.format.h > 0) || !Array.isArray(L.blocks)) throw new Error('layout needs format {w, h} and a blocks array');
      L.palette = { ...f.layout.palette, ...(L.palette || {}) }; L.grid = L.grid || f.layout.grid; L.type = L.type || f.layout.type; L.meta = { ...(L.meta || {}) };
      L.blocks = L.blocks.slice(0, 1500).map(b => { const c = { ...b }; if (!c.id) c.id = Canvas.uid(); if (!Number.isFinite(c.x)) c.x = 0; if (!Number.isFinite(c.y)) c.y = 0; if (!(c.w > 0)) c.w = 100; if (!(c.h > 0)) c.h = 40; if ((c.kind === 'text' || c.kind === 'list' || c.kind === 'button') && !c.font) c.font = { family: Brand.fontCss(kit().fonts.body), size: 24, weight: 400, lineHeight: 1.3 }; if (c.kind === 'text' || c.kind === 'list') Canvas.refit(c); return c; });
      write(() => { f.layout = L; CanvasUI.regrid(f); }, [f.id]);
      note(`Rebuilt ${f.name}`); return { blocks: L.blocks.length };
    },
  };

  function defs(opts = {}) { return TOOL_DEFS.filter(d => (!opts.core || d.core) && (!opts.exclude || !opts.exclude.includes(d.name))).map(d => ({ name: d.name, description: d.description, inputSchema: d.name === 'get_frame' ? { ...d.inputSchema, properties: { ...d.inputSchema.properties, full: { type: 'boolean', description: 'Whole layout JSON, for write_layout' } } } : d.inputSchema })); }
  async function call(name, input, ctx = {}) {
    const fn = IMPL[name]; if (!fn) throw new Error(`Unknown tool ${name}`);
    const out = await fn(input && typeof input === 'object' ? input : {});
    if (ctx.via === 'mcp' && env.onExternal && !/^(get_|select$)/.test(name)) env.onExternal(name, input);
    return out;
  }
  // A run groups an agent's calls: one undo step, and step notes for the panel.
  function beginRun(onStep) { run = { wrote: false, onStep }; }
  function endRun() { run = null; }
  return { init: e => { env = e; }, defs, call, beginRun, endRun, color };
})();
