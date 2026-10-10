/* Library panel: approved pieces to drop on a screen, from three kinds of source, each a section you can fold:
   - Brand kit (built in): generated from the brand kit, so it follows its colors, fonts and logos — logo variants,
     buttons, tags, cards, payment cards, device frames and starter illustrations.
   - Shared libraries (Brand, Product design, Sales…): the same for everyone (see LibStore). Admins make them and
     curate their items; everyone turns each one on or off for themselves in the Libraries window, like Figma.
   - This canvas: pieces saved in the current canvas only (doc.library), which anyone editing it can add.
   Items are block lists with positions from 0,0; inserting gives them fresh ids and drops them into the screen or box
   you pick. Code components (from a design-system manifest, see CodeKit) are items whose top box names the real
   component. */
const Library = (() => {
  const CATEGORIES = [['all', 'All'], ['logos', 'Logos'], ['components', 'Components'], ['code', 'Code'], ['cards', 'Cards'], ['devices', 'Devices'], ['illustrations', 'Illustrations']];
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let env = null; let cat = 'all'; let query = ''; let el = null; let naming = false; let pendingManifest = null; let publishing = null; let mgr = null; let editing = null; let confirmDel = null; let peopleHits = []; let names = {};
  const LS = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } } };
  const folded = new Set(LS.get('lg.libFolded', [])); const expanded = new Set(); let imgEpoch = 0;

  // ---- Building blocks ------------------------------------------------------------------------------------------------
  let seq = 0; const id = p => `${p}${++seq}`;
  const stackS = (mode, gap, pad, more = {}) => ({ v: 2, mode, wrap: false, gap, gapAuto: false, counterGap: gap, counterGapAuto: false, pad: typeof pad === 'number' ? { t: pad, r: pad, b: pad, l: pad } : pad, main: 'start', cross: 'start', ...more });
  const box = (props = {}) => ({ id: id('bx'), kind: 'box', x: 0, y: 0, w: 100, h: 100, fill: 'none', radius: 0, clip: false, decorative: true, ...props });
  function palette(kit) {
    const C = kit.colors.map(c => ({ ...c, hex: Color.normalize(c.hex) }));
    const byName = n => (C.find(c => String(c.name).toLowerCase() === n) || {}).hex;
    const core = C.find(c => c.role === 'core') || C[0] || { hex: '#5938B8' };
    const darks = C.filter(c => Color.isDark(c.hex)).sort((a, b) => Color.luminance(a.hex) - Color.luminance(b.hex));
    const lights = C.filter(c => !Color.isDark(c.hex) && c.role === 'background').sort((a, b) => Color.luminance(a.hex) - Color.luminance(b.hex));
    const accents = C.filter(c => c.role === 'accent');
    return {
      core: core.hex, deep: byName('deelberry') || (darks.find(c => c.hex !== '#000000') || darks[0] || { hex: '#191A25' }).hex, ink: (darks[0] || { hex: '#111111' }).hex,
      light: byName('latte') || (lights[0] || { hex: '#F6F4EE' }).hex, white: '#FFFFFF', soft: byName('smoothie') || (accents.find(c => !Color.isDark(c.hex)) || { hex: '#E4DDFB' }).hex,
      hot: byName('tangelo') || (accents.find(c => Color.isDark(c.hex) || Color.luminance(c.hex) < 0.5) || { hex: '#ED5E2C' }).hex, sun: byName('cornbread') || (accents.find(c => Color.luminance(c.hex) > 0.5) || { hex: '#FFCF26' }).hex,
      muted: '#6B6B78',
    };
  }
  function makers(kit) {
    const P = palette(kit); const D = Brand.fontCss(kit.fonts.display), B = Brand.fontCss(kit.fonts.body); const dW = kit.fonts.displayWeight || 600;
    const mono = Brand.FONTS['IBM Plex Mono'] ? Brand.fontCss('IBM Plex Mono') : '"IBM Plex Mono", ui-monospace, monospace';
    const text = (t, size, weight, fill, more = {}) => ({ id: id('t'), kind: 'text', role: more.role || 'text', path: 'text_' + id('p'), text: t, x: 0, y: 0, w: 320, h: size * 1.3, font: { family: more.display ? D : more.mono ? mono : B, weight, size, lineHeight: more.lh || 1.2, letterSpacing: more.ls || 0, ...(more.upper ? { transform: 'upper' } : {}) }, fill, align: more.align || 'left', decorative: false, sizeW: more.sizeW || 'hug', sizeH: 'hug', ...(more.opacity ? { opacity: more.opacity } : {}), ...(more.label ? { label: more.label } : {}) });
    const logo = (variant, h, fill, more = {}) => { const v = Brand.logoVariant(kit, variant); return { id: id('lg'), kind: 'logo', ...(variant !== 'wordmark' ? { variant } : {}), x: 0, y: 0, h, w: Math.round(h * Brand.logoAspectOf(kit, v)), fill, decorative: true, ...more }; };
    const circle = (d, fill, more = {}) => ({ id: id('c'), kind: 'shape', shape: 'circle', x: 0, y: 0, w: d, h: d, fill, decorative: true, ...more });
    const img = (w, h, more = {}) => ({ id: id('im'), kind: 'image', x: 0, y: 0, w, h, asset: null, focal: 'xMidYMid', radius: 0, decorative: false, path: 'image_' + id('p'), placeholder: '#D6D3E4', ...more });
    const tree = (parent, ...kids) => { const out = [parent]; for (const k of kids) { const list = Array.isArray(k) ? k : [k]; list[0].parent = parent.id; out.push(...list); } return out; };
    const contactless = (fill) => ({ id: id('v'), kind: 'vector', x: 0, y: 0, w: 26, h: 26, viewBox: [0, 0, 24, 24], svg: `<g fill="none" stroke="${fill}" stroke-width="2" stroke-linecap="round"><path d="M8.5 8.5a5 5 0 0 1 0 7"/><path d="M12 6a8.5 8.5 0 0 1 0 12"/><path d="M15.5 3.5a12 12 0 0 1 0 17"/></g>`, fill, decorative: true, label: 'contactless' });
    const card = (name, bg, grad, ink, logoFill) => {
      const root = box({ label: name, w: 428, h: 270, radius: 22, clip: true, fill: bg, ...(grad ? { gradient: grad } : {}), auto: stackS('vertical', 0, 28, { gapAuto: true }), sizeW: 'fixed', sizeH: 'fixed', shadow: { on: true, x: 0, y: 18, blur: 40, color: '#191A25', alpha: 0.25 } });
      const top = box({ label: 'top', auto: stackS('horizontal', 0, 0, { gapAuto: true, cross: 'center' }), sizeW: 'fill', sizeH: 'hug' });
      const chip = { id: id('f'), kind: 'field', x: 0, y: 0, w: 52, h: 40, radius: 8, fill: '#E3C27A', gradient: { type: 'linear', angle: 135, stops: [{ c: '#F3D99A', p: 0 }, { c: '#B8893A', p: 1 }] }, decorative: true, label: 'chip' };
      const num = text('••••  ••••  ••••  4821', 24, 500, ink, { mono: true, ls: 0.06, label: 'card number' });
      const bottom = box({ label: 'bottom', auto: stackS('horizontal', 0, 0, { gapAuto: true, cross: 'end' }), sizeW: 'fill', sizeH: 'hug' });
      const holder = box({ label: 'holder', auto: stackS('vertical', 2, 0), sizeW: 'hug', sizeH: 'hug' });
      const valid = box({ label: 'valid', auto: stackS('vertical', 2, 0), sizeW: 'hug', sizeH: 'hug' });
      const net = box({ label: 'network', auto: stackS('horizontal', -14, 0, { cross: 'center' }), sizeW: 'hug', sizeH: 'hug' });
      return tree(root,
        tree(top, logo('wordmark', 26, logoFill), contactless(ink)),
        chip, num,
        tree(bottom, tree(holder, text('CARDHOLDER', 11, 600, ink, { ls: 0.12, opacity: 0.7 }), text('Alex Morgan', 18, 600, ink)), tree(valid, text('VALID THRU', 11, 600, ink, { ls: 0.12, opacity: 0.7 }), text('09/29', 18, 600, ink)), tree(net, circle(34, P.hot, { opacity: 0.95 }), circle(34, P.sun, { opacity: 0.9 }))));
    };
    const phone = (name, w, h, r, island) => {
      const root = box({ label: name, w, h, radius: r, fill: '#0E0E12', clip: true, auto: stackS('vertical', 0, 11), sizeW: 'fixed', sizeH: 'fixed' });
      const screen = box({ label: 'screen', radius: r - 11, fill: P.white, clip: true, auto: stackS('vertical', 0, 0), sizeW: 'fill', sizeH: 'fill' });
      const bar = box({ label: 'status bar', auto: stackS('horizontal', 0, { t: 16, r: 30, b: 10, l: 34 }, { gapAuto: true, cross: 'center' }), sizeW: 'fill', sizeH: 'hug' });
      const icons = { id: id('v'), kind: 'vector', x: 0, y: 0, w: 66, h: 13, viewBox: [0, 0, 66, 13], svg: `<g fill="#111"><rect x="0" y="8" width="3" height="5" rx="1"/><rect x="5" y="6" width="3" height="7" rx="1"/><rect x="10" y="3" width="3" height="10" rx="1"/><rect x="15" y="0" width="3" height="13" rx="1"/><path d="M27 4.5a10 10 0 0 1 13 0l-1.6 1.7a7.6 7.6 0 0 0-9.8 0zM30 7.6a5.6 5.6 0 0 1 7 0L33.5 11z"/><rect x="44" y="1" width="19" height="11" rx="3" fill="none" stroke="#111" stroke-width="1.2"/><rect x="46" y="3" width="13" height="7" rx="1.5"/><rect x="64" y="4.5" width="1.6" height="4" rx=".8"/></g>`, fill: '#111111', decorative: true, label: 'status icons' };
      const content = img(w - 22, h - 80, { label: 'app screen', sizeW: 'fill', sizeH: 'fill', placeholder: '#EDEBF3' });
      const kids = [tree(bar, text('9:41', 15, 600, '#111111'), icons), content];
      const out = tree(root, tree(screen, ...kids));
      if (island) { const isl = box({ label: 'island', fill: '#0E0E12', radius: 18, w: 120, h: 34, x: Math.round((w - 22 - 120) / 2), y: 11, absolute: true, parent: screen.id }); out.push(isl); }
      return out;
    };
    const items = [];
    const add = (category, key, name, build, more = {}) => items.push({ id: 'b:' + key, builtin: true, approved: true, category, name, build, ...more });
    for (const v of Brand.logosOf(kit)) add('logos', 'logo-' + v.id, v.name || v.id, () => [logo(v.id, v.kind === 'appicon' ? 96 : 56, v.kind === 'appicon' ? (v.fg || '#FFFFFF') : P.core)]);
    add('components', 'btn-primary', 'Button', () => tree(box({ label: 'Button', radius: 999, fill: P.core, auto: stackS('horizontal', 8, { t: 16, r: 30, b: 16, l: 30 }, { main: 'center', cross: 'center' }), sizeW: 'hug', sizeH: 'hug' }), text('Book a demo', 20, 600, P.white)));
    add('components', 'btn-secondary', 'Button · outline', () => tree(box({ label: 'Button', radius: 999, stroke: { color: P.core, width: 2 }, auto: stackS('horizontal', 8, { t: 14, r: 28, b: 14, l: 28 }, { main: 'center', cross: 'center' }), sizeW: 'hug', sizeH: 'hug' }), text('Learn more', 20, 600, P.core)));
    add('components', 'tag', 'Tag', () => tree(box({ label: 'Tag', radius: 999, fill: P.soft, auto: stackS('horizontal', 6, { t: 7, r: 14, b: 7, l: 14 }, { cross: 'center' }), sizeW: 'hug', sizeH: 'hug' }), text('New', 14, 600, P.deep, { upper: true, ls: 0.08 })));
    add('components', 'stat', 'Stat', () => tree(box({ label: 'Stat', auto: stackS('vertical', 4, 0), sizeW: 'hug', sizeH: 'hug' }), text('150+', 96, dW, P.core, { display: true, lh: 1, ls: -0.03, role: 'stat' }), text('countries', 22, 500, P.ink)));
    add('components', 'quote', 'Quote card', () => { const root = box({ label: 'Quote card', w: 560, radius: 24, fill: P.light, auto: stackS('vertical', 28, 40), sizeW: 'fixed', sizeH: 'hug' }); const who = box({ label: 'person', auto: stackS('horizontal', 16, 0, { cross: 'center' }), sizeW: 'hug', sizeH: 'hug' }); const names = box({ label: 'names', auto: stackS('vertical', 2, 0), sizeW: 'hug', sizeH: 'hug' }); return tree(root, text('“We hired in nine countries in a quarter, without opening a single entity.”', 30, dW, P.ink, { display: true, lh: 1.2, sizeW: 'fill', role: 'quote' }), tree(who, img(56, 56, { radius: 28, label: 'avatar' }), tree(names, text('Jordan Reyes', 19, 600, P.ink), text('VP People, Northwind', 16, 400, P.muted)))); });
    add('components', 'feature', 'Feature card', () => tree(box({ label: 'Feature card', w: 360, radius: 20, fill: P.white, stroke: { color: '#E6E3EE', width: 1 }, auto: stackS('vertical', 14, 32), sizeW: 'fixed', sizeH: 'hug' }), { id: id('ic'), kind: 'icon', name: 'sparkle', x: 0, y: 0, w: 40, h: 40, fill: P.core, decorative: true }, text('Payroll in minutes', 26, 600, P.ink, { sizeW: 'fill' }), text('Run every country from one place, with local compliance built in.', 18, 400, P.muted, { sizeW: 'fill', lh: 1.45 })));
    add('components', 'person', 'Person', () => { const root = box({ label: 'Person', auto: stackS('horizontal', 16, 0, { cross: 'center' }), sizeW: 'hug', sizeH: 'hug' }); const names = box({ label: 'names', auto: stackS('vertical', 2, 0), sizeW: 'hug', sizeH: 'hug' }); return tree(root, img(64, 64, { radius: 32, label: 'avatar' }), tree(names, text('Priya Natarajan', 20, 600, P.ink), text('Head of Finance', 16, 400, P.muted))); });
    add('cards', 'card-core', 'Deel Card · core', () => card('Deel Card', P.core, { type: 'linear', angle: 135, stops: [{ c: P.core, p: 0 }, { c: P.deep, p: 1 }] }, P.white, P.white));
    add('cards', 'card-black', 'Deel Card · black', () => card('Deel Card', '#111111', { type: 'linear', angle: 135, stops: [{ c: '#2B2B33', p: 0 }, { c: '#050507', p: 1 }] }, P.white, P.white));
    add('cards', 'card-virtual', 'Virtual card', () => card('Virtual card', P.light, null, P.deep, P.core));
    add('devices', 'iphone', 'Phone · iOS', () => phone('Phone · iOS', 390, 844, 56, true));
    add('devices', 'android', 'Phone · Android', () => phone('Phone · Android', 412, 915, 40, false));
    add('devices', 'browser', 'Browser window', () => { const root = box({ label: 'Browser', w: 1280, h: 800, radius: 12, fill: P.white, stroke: { color: '#D9D7E2', width: 1 }, clip: true, auto: stackS('vertical', 0, 0), sizeW: 'fixed', sizeH: 'fixed', shadow: { on: true, x: 0, y: 20, blur: 50, color: '#191A25', alpha: 0.18 } }); const bar = box({ label: 'toolbar', fill: '#F1F0F5', auto: stackS('horizontal', 8, { t: 12, r: 16, b: 12, l: 16 }, { cross: 'center' }), sizeW: 'fill', sizeH: 'hug' }); const url = box({ label: 'address', fill: P.white, radius: 8, auto: stackS('horizontal', 0, { t: 6, r: 12, b: 6, l: 12 }, { cross: 'center' }), sizeW: 'fill', sizeH: 'hug' }); return tree(root, tree(bar, circle(12, '#FF5F57'), circle(12, '#FEBC2E'), circle(12, '#28C840'), tree(url, text('deel.com', 13, 500, P.muted))), img(1280, 740, { label: 'page', sizeW: 'fill', sizeH: 'fill', placeholder: '#EDEBF3' })); });
    add('illustrations', 'orbit', 'Orbit (starter)', () => { const root = box({ label: 'Orbit', w: 420, h: 420 }); const big = circle(300, P.core, { x: 60, y: 60 }), small = circle(110, P.hot, { x: 290, y: 40 }), dot = circle(56, P.sun, { x: 40, y: 300 }); const ring = { id: id('v'), kind: 'vector', x: 0, y: 150, w: 420, h: 140, viewBox: [0, 0, 420, 140], svg: `<ellipse cx="210" cy="70" rx="200" ry="56" fill="none" stroke="${P.soft}" stroke-width="10"/>`, fill: P.soft, decorative: true, label: 'ring' }; return tree(root, big, ring, small, dot); }, { starter: true });
    add('illustrations', 'blocks', 'Color blocks (starter)', () => { const root = box({ label: 'Color blocks', w: 420, h: 300 }); const f = (x, y, w, h, fill, r) => ({ id: id('f'), kind: 'field', x, y, w, h, fill, radius: r, decorative: true }); return tree(root, f(0, 0, 260, 300, P.core, 0), f(260, 0, 160, 150, P.sun, 0), { id: id('q'), kind: 'shape', shape: 'quarter', x: 260, y: 150, w: 160, h: 150, fill: P.hot, decorative: true }, circle(120, P.soft, { x: 70, y: 90 })); }, { starter: true });
    return items;
  }

  // ---- Items ------------------------------------------------------------------------------------------------------------
  const cache = { sig: '', items: [], thumbs: new Map() };
  const kitSig = kit => JSON.stringify([kit.colors, kit.fonts, (kit.logos || []).map(v => [v.id, v.kind, v.text, v.product, v.bg, v.svg ? v.svg.viewBox : 0]), kit.logo && kit.logo.text, kit.logo && kit.logo.kind, kit.logo && kit.logo.svg ? kit.logo.svg.viewBox : 0]);
  // Lay out a block list on a scratch screen and move it to 0,0; returns {blocks, w, h}.
  function settle(blocks) {
    const f = { id: 'lib', autoLayout: Canvas.defaultAuto(), layout: { format: { w: 4000, h: 4000 }, palette: { bg: '#FFFFFF' }, grid: { unit: 8 }, blocks: Canvas.clone(blocks) } };
    f.autoLayout.mode = 'none';
    for (const b of f.layout.blocks) if (b.kind === 'text' || b.kind === 'list') Canvas.refit(b);
    Auto.layout(f);
    const I = Auto.index(f); const tops = Auto.childrenOf(I, '');
    const bb = Canvas.bounds(tops.length ? tops : f.layout.blocks);
    for (const b of f.layout.blocks) { b.x = Math.round((b.x - bb.x) * 100) / 100; b.y = Math.round((b.y - bb.y) * 100) / 100; delete b.lx; delete b.ly; }
    return { blocks: f.layout.blocks, w: Math.max(1, Math.ceil(bb.w)), h: Math.max(1, Math.ceil(bb.h)) };
  }
  function builtins(kit) {
    const sig = kitSig(kit);
    if (cache.sig !== sig) { cache.sig = sig; cache.thumbs.clear(); cache.items = makers(kit).map(it => { const s = settle(it.build()); return { ...it, blocks: s.blocks, w: s.w, h: s.h }; }); }
    return cache.items;
  }
  function thumb(item, kit) {
    const key = item.id + ':' + (item.v || 0) + ':' + cache.sig + ':' + (item.assets ? imgEpoch : 0);
    if (cache.thumbs.has(key)) return cache.thumbs.get(key);
    const pad = Math.max(item.w, item.h) * 0.08; const W = item.w + pad * 2, H = item.h + pad * 2;
    const blocks = Canvas.clone(item.blocks).map(b => ({ ...b, x: b.x + pad, y: b.y + pad }));
    // code components are product UI: shown on a light page so dark text reads
    const light = !!item.code;
    const svg = Render.toSVG({ id: 'th-' + String(item.id).replace(/[^\w-]/g, ''), format: { w: W, h: H }, palette: { bg: light ? '#F6F5FA' : '#000' }, blocks }, { kit, assets: env ? env.getAssets() : { images: [] }, transparent: !light, width: 120 });
    cache.thumbs.set(key, svg); return svg;
  }
  // ---- Sources ----------------------------------------------------------------------------------------------------------
  // Every library this person could see, in panel order: the brand kit, the shared ones, then this canvas.
  function sources(doc, kit) {
    const role = LibStore.role();
    return [
      { id: 'kit', name: 'Brand kit', note: 'Built in · follows the brand kit', builtin: true, editable: false, items: builtins(kit) },
      ...LibStore.libraries().map(l => ({ id: l.id, name: l.name, note: l.description, shared: true, lib: l, editable: role.admin, items: LibStore.items(l.id) })),
      { id: 'canvas', name: 'This canvas', note: 'Saved in this canvas only', local: true, editable: true, items: ((doc && doc.library) || []).map(it => ({ ...it, category: it.category && it.category !== 'saved' ? it.category : 'components' })) },
    ];
  }
  const tag = (src, it) => ({ ...it, libId: src.id, libName: src.name, team: !!src.local, shared: !!src.shared, editable: src.editable });
  // Items from the libraries this person has on (all of them with {any: true}).
  function all(doc, kit, opts = {}) { return sources(doc, kit).filter(s => opts.any || LibStore.isOn(s.id)).flatMap(s => s.items.map(it => tag(s, it))); }
  function find(itemId) { return all(env.canvas.doc, env.getKit(), { any: true }).find(x => x.id === itemId); }
  // Every code component spec any library knows about (for the props panel and for binding).
  function codeSpecs() { return all(env.canvas.doc, env.getKit(), { any: true }).filter(it => it.code && it.code.spec); }
  function specFor(code) { return CodeKit.specFor(code, codeSpecs()); }

  // Selected blocks (with what is inside boxes) -> a library item.
  function fromSelection(frame, blocks, name, category) {
    const tops = Auto.topmost(frame, blocks); const list = Canvas.clone(Auto.withDescendants(frame, tops)); const topIds = new Set(tops.map(b => b.id));
    for (const b of list) if (topIds.has(b.id)) { delete b.parent; delete b.rx; delete b.ry; delete b.absolute; if (b.sizeW === 'fill') b.sizeW = 'fixed'; if (b.sizeH === 'fill') b.sizeH = 'fixed'; }
    const s = settle(list);
    const item = { id: 'u' + Math.random().toString(36).slice(2, 10), name: String(name || 'Component').slice(0, 60), category: category || 'components', approved: false, created: Date.now(), v: 1, w: s.w, h: s.h, blocks: s.blocks };
    // a code component keeps its tie to the real one
    const top = tops.length === 1 ? s.blocks.find(b => b.id === tops[0].id) : null;
    if (top && top.code) { const spec = specFor(top.code); item.code = { pkg: top.code.pkg, name: top.code.name, ...(spec ? { spec: { group: spec.group, props: spec.props, story: spec.story } } : {}) }; item.category = 'code'; }
    return item;
  }

  // ---- Panel ------------------------------------------------------------------------------------------------------------
  function init(e) { env = e; LibStore.on(() => { refresh(); }); }
  const isOpen = () => !!(el && !el.hidden && el.offsetParent !== null);
  let rq = 0; function refresh() { if (rq) return; rq = requestAnimationFrame(() => { rq = 0; if (isOpen()) render(); if (mgr && !mgr.hidden) renderManager(); }); }
  function imagesChanged() { imgEpoch++; refresh(); }
  const MODE_NOTE = { artifact: 'Shared with everyone who opens this page', server: 'Shared with everyone on this server', local: 'Kept in this browser' };
  function itemCard(it, kit) {
    const acts = [];
    if (it.editable && (it.team || it.shared)) acts.push(`<button type="button" data-approve="${esc(it.id)}" data-src="${esc(it.libId)}" title="${it.approved ? 'Unmark as approved' : 'Mark as approved'}">${it.approved ? '✓ Approved' : 'Approve'}</button>`);
    if (it.team && LibStore.role().admin && LibStore.libraries().length) acts.push(`<button type="button" data-publish="${esc(it.id)}" title="Publish to a shared library">↗</button>`);
    if (it.editable && (it.team || it.shared)) acts.push(`<button type="button" data-remove="${esc(it.id)}" data-src="${esc(it.libId)}" title="Remove from ${esc(it.libName)}">✕</button>`);
    const badge = it.code ? ` <span class="lib-tag" title="${esc(it.code.pkg)}">code</span>` : it.starter ? ' <span class="lib-tag">starter</span>' : '';
    return `<div class="lib-item" draggable="true" data-item="${esc(it.id)}" title="${esc(it.name)}${it.code ? ` · <${esc(it.code.name)}> from ${esc(it.code.pkg)}` : ''} · click to add, or drag onto a screen"><div class="lib-thumb">${thumb(it, kit)}</div><div class="lib-name">${esc(it.name)}${it.approved ? ' <span class="lib-ok" title="Approved">✓</span>' : ''}${badge}</div>${acts.length ? `<div class="lib-acts">${acts.join('')}</div>` : ''}</div>`;
  }
  function render(container, q) {
    el = container || el; if (!el || !env) return; query = (q ?? query).toLowerCase();
    const kit = env.getKit(); const doc = env.canvas.doc; const srcs = sources(doc, kit); const role = LibStore.role();
    const on = srcs.filter(s => LibStore.isOn(s.id));
    const sel = env.canvas.selection(); const canSave = sel.blockIds.length > 0;
    const match = it => (cat === 'all' || it.category === cat) && (!query || `${it.name} ${it.category} ${it.code ? it.code.name + ' ' + (it.code.spec && it.code.spec.group || '') : ''}`.toLowerCase().includes(query));
    const sections = on.map(s => {
      const list = s.items.map(it => tag(s, it)).filter(match); if (!list.length && (query || cat !== 'all' || s.builtin)) return '';
      const fold = folded.has(s.id) && !query; const max = expanded.has(s.id) || query ? 400 : 24;
      return `<section class="lib-sec"><button type="button" class="lib-sec-head" data-fold="${esc(s.id)}" aria-expanded="${!fold}"><span class="lib-caret">${fold ? '▸' : '▾'}</span>${esc(s.name)} <span class="lib-count">${list.length}</span>${s.shared ? '' : s.builtin ? ' <span class="lib-tag">built in</span>' : ' <span class="lib-tag">local</span>'}</button>
        ${fold ? '' : `<div class="lib-grid">${list.slice(0, max).map(it => itemCard(it, kit)).join('') || '<p class="hint" style="padding:6px 8px">Nothing here yet.</p>'}</div>${list.length > max ? `<button type="button" class="btn small ghost lib-more" data-more="${esc(s.id)}">Show all ${list.length}</button>` : ''}`}</section>`;
    }).join('');
    const dests = [{ id: 'canvas', name: 'This canvas' }, ...(role.admin ? LibStore.libraries().map(l => ({ id: l.id, name: l.name })) : [])];
    const lastDest = LS.get('lg.libDest', 'canvas'); const dest = dests.some(d => d.id === lastDest) ? lastDest : 'canvas';
    const destSel = (attr, cur, list) => `<select class="input cv-mini" data-lib="${attr}" aria-label="Save to">${list.map(d => `<option value="${esc(d.id)}" ${d.id === cur ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>`;
    const codeNames = [...new Map(codeSpecs().map(it => [it.code.pkg + ':' + it.code.name, it.code])).values()];
    el.innerHTML = `<div class="lib-top"><button type="button" class="btn small" data-lib="manage" title="Turn libraries on or off${role.admin ? ', make new ones' : ''}">Libraries · ${on.length} of ${srcs.length} on</button><span class="hint">${esc(MODE_NOTE[LibStore.mode] || '')}${role.admin && LibStore.mode !== 'local' ? ' · you can edit' : ''}</span></div>
      <div class="lib-cats">${CATEGORIES.map(([k, l]) => `<button type="button" class="${cat === k ? 'on' : ''}" data-cat="${k}">${l}</button>`).join('')}</div>
      ${sections || `<p class="hint" style="padding:8px">${query ? 'Nothing matches.' : 'Every library is off. Turn some on under Libraries.'}</p>`}
      ${naming ? `<div class="lib-form"><input type="text" class="input" data-lib="name" placeholder="Name, e.g. Pricing card" maxlength="60"><div class="cv-row">${destSel('dest', dest, dests)}${codeNames.length ? `<input type="text" class="input grow" data-lib="bind" list="libCodeNames" placeholder="Code component (optional)"><datalist id="libCodeNames">${codeNames.map(c => `<option value="${esc(c.name)}">${esc(c.pkg)}</option>`).join('')}</datalist>` : ''}</div><div class="cv-row"><button type="button" class="btn small primary" data-lib="save-ok">Save</button><button type="button" class="btn small ghost" data-lib="save-cancel">Cancel</button></div></div>` : ''}
      ${publishing ? `<div class="lib-form"><span class="hint">Publish “${esc((find(publishing) || {}).name || '')}” to</span><div class="cv-row">${destSel('pub-dest', LibStore.libraries().some(l => l.id === lastDest) ? lastDest : (LibStore.libraries()[0] || {}).id, LibStore.libraries())}<button type="button" class="btn small primary" data-lib="pub-ok">Publish</button><button type="button" class="btn small ghost" data-lib="pub-cancel">Cancel</button></div></div>` : ''}
      ${pendingManifest ? `<div class="lib-form"><span class="hint">${pendingManifest.count} code components from “${esc(pendingManifest.name)}”. Add them to</span><div class="cv-row">${destSel('man-dest', (LibStore.libraries().find(l => /product|design|code|ui/i.test(l.name)) || LibStore.libraries()[0] || { id: '__new' }).id, [...LibStore.libraries(), { id: '__new', name: '＋ New library: ' + pendingManifest.name }])}<button type="button" class="btn small primary" data-lib="man-ok">Add</button><button type="button" class="btn small ghost" data-lib="man-cancel">Cancel</button></div></div>` : ''}
      <div class="lib-foot">
        <button type="button" class="btn small" data-lib="save" ${canSave ? '' : 'disabled'} title="Select blocks on a screen first">＋ Save selection</button>
        <label class="btn small file">＋ Add SVG or PNG<input type="file" data-lib="files" accept=".svg,image/svg+xml,image/png,image/jpeg,image/webp" multiple hidden></label>
        <label class="btn small ghost file" title="A library file, or a code component manifest (lgComponents)">Import<input type="file" data-lib="import" accept=".json,application/json" hidden></label>
        <button type="button" class="btn small ghost" data-lib="export" title="Download this canvas's pieces as JSON">Export</button>
      </div>
      <p class="hint lib-hint">${role.admin ? 'Save a selection to a shared library to make it the same for everyone; This canvas keeps it here only.' : 'Shared libraries are curated by admins. Save your own pieces to This canvas.'}</p>`;
  }
  function bind(container) {
    el = container;
    el.addEventListener('click', async e => {
      const c = e.target.closest('[data-cat]'); if (c) { cat = c.dataset.cat; render(); return; }
      const fo = e.target.closest('[data-fold]'); if (fo) { const id = fo.dataset.fold; folded.has(id) ? folded.delete(id) : folded.add(id); LS.set('lg.libFolded', [...folded]); render(); return; }
      const mo = e.target.closest('[data-more]'); if (mo) { expanded.add(mo.dataset.more); render(); return; }
      const ap = e.target.closest('[data-approve]'); if (ap) { await guard(() => setApproved(ap.dataset.src, ap.dataset.approve)); return; }
      const rm = e.target.closest('[data-remove]'); if (rm) { await guard(() => removeItem(rm.dataset.src, rm.dataset.remove)); return; }
      const pb = e.target.closest('[data-publish]'); if (pb) { publishing = pb.dataset.publish; naming = false; render(); return; }
      const act = e.target.closest('[data-lib]'); const a = act && act.dataset.lib;
      if (a === 'manage') { openManager(); return; }
      if (a === 'save') { const sel = env.canvas.selection(); if (!sel.blockIds.length) { env.toast('Select blocks on a screen to save them'); return; } naming = true; publishing = null; render(); const inp = el.querySelector('[data-lib="name"]'); if (inp) { const f = Canvas.frameById(env.canvas.doc, sel.frameId); const b = f && Canvas.blockById(f, sel.blockIds[0]); inp.value = b ? (b.label || (b.kind === 'box' ? 'Component' : b.role || b.kind)) : 'Component'; inp.focus(); inp.select(); } return; }
      if (a === 'save-cancel') { naming = false; render(); return; }
      if (a === 'save-ok') { await submitSave(); return; }
      if (a === 'pub-cancel') { publishing = null; render(); return; }
      if (a === 'pub-ok') { const lib = el.querySelector('[data-lib="pub-dest"]').value; const id = publishing; publishing = null; await guard(() => publish(id, lib)); return; }
      if (a === 'man-cancel') { pendingManifest = null; render(); return; }
      if (a === 'man-ok') { const lib = el.querySelector('[data-lib="man-dest"]').value; const m = pendingManifest; pendingManifest = null; render(); await guard(() => addManifest(m, lib)); return; }
      if (a === 'export') { exportLibrary(); return; }
      const it = e.target.closest('[data-item]'); if (it && !act) { insert(it.dataset.item); }
    });
    el.addEventListener('keydown', e => { if (e.target.dataset.lib === 'name' || e.target.dataset.lib === 'bind') { e.stopPropagation(); if (e.key === 'Enter') submitSave(); else if (e.key === 'Escape') { naming = false; render(); } } });
    el.addEventListener('change', async e => {
      const t = e.target;
      if (t.dataset.lib === 'dest') LS.set('lg.libDest', t.value);
      if (t.dataset.lib === 'files') { for (const f of t.files) await guard(() => addFile(f)); t.value = ''; render(); }
      if (t.dataset.lib === 'import') { const f = t.files[0]; t.value = ''; if (f) await guard(async () => importFile(JSON.parse(await f.text()))); render(); }
    });
    el.addEventListener('dragstart', e => { const it = e.target.closest('[data-item]'); if (!it) return; e.dataTransfer.setData('application/x-lg-library', it.dataset.item); e.dataTransfer.effectAllowed = 'copy'; });
  }
  async function guard(fn) { try { return await fn(); } catch (err) { env.toast(err && err.message ? err.message : String(err)); render(); return null; } }
  // Insert into the selected screen (or box), else the screen in view; at a point when dropped.
  function insert(itemId, at) {
    const it = find(itemId); if (!it) return;
    const out = env.canvas.insertComponent(it.blocks, { at, name: it.name });
    if (out) env.toast(`${it.name} added${it.approved ? '' : ' (not yet approved)'}`);
  }
  async function submitSave() {
    const inp = el.querySelector('[data-lib="name"]'); const d = el.querySelector('[data-lib="dest"]'); const bnd = el.querySelector('[data-lib="bind"]');
    const name = inp ? inp.value : ''; const dest = d ? d.value : 'canvas'; const bindTo = bnd ? bnd.value.trim() : '';
    naming = false; LS.set('lg.libDest', dest);
    await guard(() => saveSelection(name, dest, bindTo));
  }
  async function saveSelection(name, dest = 'canvas', bindTo = '') {
    const sel = env.canvas.selection(); const f = sel.frameId && Canvas.frameById(env.canvas.doc, sel.frameId);
    if (!f || !sel.blockIds.length) { env.toast('Select blocks on a screen to save them'); render(); return; }
    const blocks = sel.blockIds.map(i => Canvas.blockById(f, i)).filter(Boolean);
    name = String(name || '').trim() || 'Component';
    const category = /card/i.test(name) ? 'cards' : /illus|art|shape/i.test(name) ? 'illustrations' : /phone|device|browser/i.test(name) ? 'devices' : /logo/i.test(name) ? 'logos' : 'components';
    const item = fromSelection(f, blocks, name, category); item.by = env.me ? env.me() : '';
    if (bindTo) bindCode(item, bindTo);
    if (dest === 'canvas') { env.canvas.mutate(d2 => { d2.library = [...(d2.library || []), item]; }, { history: true }); render(); env.toast(`Saved “${item.name}” to This canvas`); return; }
    env.toast('Saving to the shared library…');
    const saved = await LibStore.putItem({ ...item, lib: dest, id: undefined });
    env.toast(`Saved “${saved.name}” to ${(LibStore.libraries().find(l => l.id === dest) || {}).name || 'the library'}`);
  }
  // Tie an item (often captured from Storybook or a live page) to a code component by name.
  function bindCode(item, nameOrPkgName) {
    const n = nameOrPkgName.replace(/^<|\s*\/?>$/g, '').trim(); const spec = codeSpecs().find(it => it.code.name === n || `${it.code.pkg}:${it.code.name}` === n);
    const code = spec ? spec.code : { pkg: 'components', name: n.replace(/[^A-Za-z0-9_]/g, '') || 'Component' };
    const tops = item.blocks.filter(b => !b.parent); let top = tops.length === 1 ? tops[0] : null;
    if (!top) { const bb = { w: item.w, h: item.h }; top = { id: 'bx' + Math.random().toString(36).slice(2, 8), kind: 'box', x: 0, y: 0, w: bb.w, h: bb.h, fill: 'none', radius: 0, clip: false, decorative: true }; for (const b of tops) b.parent = top.id; item.blocks.unshift(top); }
    const tp = spec && spec.code.spec ? CodeKit.textPropOf(spec.code.spec) : 'children';
    top.code = { pkg: code.pkg, name: code.name, props: {}, ...(tp ? { text: tp } : {}) }; top.label = top.label || code.name;
    item.code = { pkg: code.pkg, name: code.name, ...(spec && spec.code.spec ? { spec: spec.code.spec } : {}) }; item.category = 'code';
  }
  async function setApproved(src, id) {
    if (src === 'canvas') { env.canvas.mutate(d => { const it = (d.library || []).find(x => x.id === id); if (it) { it.approved = !it.approved; it.v = (it.v || 0) + 1; } }); render(); return; }
    const it = LibStore.items().find(x => x.id === id); if (it) await LibStore.updateItem(id, { approved: !it.approved });
  }
  async function removeItem(src, id) {
    if (src === 'canvas') { env.canvas.mutate(d => { d.library = (d.library || []).filter(x => x.id !== id); }); render(); env.toast('Removed from This canvas'); return; }
    const it = LibStore.items().find(x => x.id === id); await LibStore.deleteItem(id); env.toast(`Removed “${it ? it.name : 'item'}”`);
  }
  async function publish(id, lib) {
    const it = (env.canvas.doc.library || []).find(x => x.id === id); if (!it || !lib) return;
    env.toast('Publishing…'); LS.set('lg.libDest', lib);
    const saved = await LibStore.putItem({ ...Canvas.clone(it), lib, id: undefined, approved: true });
    env.toast(`Published “${saved.name}” to ${(LibStore.libraries().find(l => l.id === lib) || {}).name}`);
  }
  async function addFile(file) {
    const name = file.name.replace(/\.[^.]+$/, '').slice(0, 60);
    let blocks, w, h;
    if (/svg/.test(file.type) || /\.svg$/i.test(file.name)) {
      const svg = Brand.parseSvg(await file.text()); if (!svg) { env.toast(`Could not read ${file.name}`); return; }
      const vb = svg.viewBox.split(/\s+/).map(Number); w = Math.round(Math.min(600, vb[2] || 300)); h = Math.round(w / (svg.aspect || 1));
      blocks = [{ id: 'v1', kind: 'vector', x: 0, y: 0, w, h, viewBox: vb, svg: svg.inner, keepAspect: true, fill: '#000000', decorative: true, label: name }];
    } else {
      const a = await env.addImage(file); w = Math.round(Math.min(600, a.w || 400)); h = Math.round(w * (a.h || 300) / (a.w || 400));
      blocks = [{ id: 'i1', kind: 'image', x: 0, y: 0, w, h, asset: a.id, focal: 'xMidYMid', fit: 'contain', radius: 0, decorative: true, path: 'image_lib', label: name }];
    }
    const item = { id: 'u' + Math.random().toString(36).slice(2, 10), name, category: 'illustrations', approved: false, created: Date.now(), v: 1, w, h, blocks };
    const dest = LS.get('lg.libDest', 'canvas');
    if (dest !== 'canvas' && LibStore.role().admin && LibStore.libraries().some(l => l.id === dest)) { await LibStore.putItem({ ...item, lib: dest, id: undefined }); env.toast(`Added ${name} to ${(LibStore.libraries().find(l => l.id === dest) || {}).name}`); }
    else { env.canvas.mutate(d => { d.library = [...(d.library || []), item]; }); env.toast(`Added ${name} to This canvas`); }
    cat = 'illustrations';
  }
  async function exportLibrary() {
    const doc = env.canvas.doc; const items = doc.library || []; if (!items.length) { env.toast('This canvas has no saved pieces. Shared libraries export from Libraries.'); return; }
    const assets = {}; const imgs = env.getAssets().images;
    for (const it of items) for (const b of it.blocks) if (b.kind === 'image' && b.asset) { const a = imgs.find(x => x.id === b.asset); if (a && a.dataUrl) assets[b.asset] = { name: a.name, dataUrl: a.dataUrl }; }
    const blob = new Blob([JSON.stringify({ lgLibrary: { v: 1, kit: env.getKit().name, items, assets } }, null, 1)], { type: 'application/json' });
    if (await env.download(blob, `${String(env.getKit().name || 'brand').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-canvas-pieces.json`)) env.toast(`Exported ${items.length} pieces`);
  }
  // A JSON file: a code component manifest, shared libraries (v2), or a canvas's pieces (v1).
  async function importFile(j) {
    if (j && j.lgComponents) {
      if (!LibStore.role().admin) throw new Error('Only library admins can add code components to shared libraries');
      const M = CodeKit.readManifest(j); if (!M.components.length) throw new Error('No components in that manifest');
      pendingManifest = { name: M.name, count: M.components.length, json: j }; naming = false; publishing = null; render(); return;
    }
    const L = j && j.lgLibrary; if (!L) throw new Error('Not a library or component file');
    if (L.v >= 2 && Array.isArray(L.libraries)) { const r = await LibStore.importJSON(j); env.toast(`Imported ${r.items} items${r.libraries ? ` into ${r.libraries} new librar${r.libraries > 1 ? 'ies' : 'y'}` : ''}`); return; }
    if (!Array.isArray(L.items)) throw new Error('not a library file');
    const remap = new Map();
    for (const [oldId, a] of Object.entries(L.assets || {})) { if (a && typeof a.dataUrl === 'string' && /^data:image\//.test(a.dataUrl)) { const added = await env.addImageData(a.dataUrl, a.name || 'library image'); remap.set(oldId, added.id); } }
    const have = new Set((env.canvas.doc.library || []).map(x => x.id)); let n = 0;
    const items = L.items.filter(it => it && it.id && Array.isArray(it.blocks) && !have.has(it.id)).slice(0, 300).map(it => { n++; const c = Canvas.clone(it); for (const b of c.blocks) if (b.kind === 'image' && remap.has(b.asset)) b.asset = remap.get(b.asset); return c; });
    env.canvas.mutate(d => { d.library = [...(d.library || []), ...items]; });
    env.toast(n ? `Imported ${n} piece${n > 1 ? 's' : ''} into This canvas` : 'Those pieces are already here');
  }
  async function addManifest(m, libId) {
    if (libId === '__new') libId = (await LibStore.createLibrary({ name: m.name, description: 'Code components', defaultOn: true })).id;
    const { items } = CodeKit.itemsFrom(m.json, env.getKit(), libId);
    const have = new Map(LibStore.items(libId).filter(x => x.code).map(x => [x.code.pkg + ':' + x.code.name, x.id]));
    let n = 0; env.toast(`Adding ${items.length} code components…`);
    for (let i = 0; i < items.length; i += 6) {
      await Promise.all(items.slice(i, i + 6).map(async it => { const prev = have.get(it.code.pkg + ':' + it.code.name); await LibStore.putItem({ ...it, id: prev || it.id }, { images: false }); n++; }));
      if (items.length > 30 && i % 60 === 0) env.toast(`Adding code components… ${n} of ${items.length}`);
    }
    folded.delete(libId); render();
    env.toast(`${n} code components in ${(LibStore.libraries().find(l => l.id === libId) || {}).name}. Their props show in the panel when you select one.`);
  }

  // ---- Libraries window: on/off, create and edit (admins), the admin list (owner) ---------------------------------------
  function openManager() { mgr = mgr || document.getElementById('libsModal'); if (!mgr) return; mgr.hidden = false; editing = null; confirmDel = null; renderManager(); loadNames(); }
  async function loadNames() { const ids = LibStore.admins; if (!ids.length) return; const ps = await LibStore.people(ids); for (const id of ids) names[id] = (ps[id] && ps[id].name) || names[id] || ''; renderManager(); }
  function renderManager() {
    const body = mgr && mgr.querySelector('.libs-body'); if (!body) return;
    const kit = env.getKit(); const srcs = sources(env.canvas.doc, kit); const role = LibStore.role(); const mode = LibStore.mode;
    const row = s => {
      const on = LibStore.isOn(s.id); const ed = editing === s.id && s.shared && role.admin;
      const meta = [s.note, `${s.items.length} item${s.items.length === 1 ? '' : 's'}`, s.shared && s.lib.defaultOn ? 'on for everyone by default' : s.shared ? 'off by default' : ''].filter(Boolean).map(esc).join(' · ');
      return `<div class="libs-row${on ? ' on' : ''}"><label class="libs-switch" title="${on ? 'Turn off for me' : 'Turn on for me'}"><input type="checkbox" data-on="${esc(s.id)}" ${on ? 'checked' : ''}><span></span></label>
        <div class="libs-main"><b>${esc(s.name)}</b><span class="hint">${meta}</span></div>
        ${s.shared && role.admin && !ed ? `<button type="button" class="btn small ghost" data-edit="${esc(s.id)}">Edit</button>` : ''}</div>
        ${ed ? `<div class="libs-edit"><label class="cv-f"><span>Name</span><input type="text" class="input" data-le="name" value="${esc(s.lib.name)}" maxlength="60"></label><label class="cv-f"><span>About</span><input type="text" class="input" data-le="description" value="${esc(s.lib.description)}" maxlength="200" placeholder="What belongs here"></label><label class="cv-check"><input type="checkbox" data-le="defaultOn" ${s.lib.defaultOn ? 'checked' : ''}> On for everyone by default</label>
          <div class="cv-row wrap"><button type="button" class="btn small primary" data-le-save="${esc(s.id)}">Save</button><button type="button" class="btn small ghost" data-le-cancel>Cancel</button><button type="button" class="btn small ghost" data-le-export="${esc(s.id)}">Export</button>${confirmDel === s.id ? `<span class="hint">Delete ${s.items.length} items for everyone?</span><button type="button" class="btn small danger" data-le-del-ok="${esc(s.id)}">Delete</button>` : `<button type="button" class="btn small ghost" data-le-del="${esc(s.id)}">Delete library</button>`}</div></div>` : ''}`;
    };
    let admins = '';
    if (mode === 'artifact') {
      const list = LibStore.admins;
      const who = list.length ? list.map(id => `<span class="libs-person">${esc(names[id] || 'Someone')}${role.owner ? ` <button type="button" class="btn ghost icon" data-unadmin="${esc(id)}" aria-label="Remove ${esc(names[id] || 'admin')}">✕</button>` : ''}</span>`).join('') : '<span class="hint">No one yet besides the page owner.</span>';
      admins = `<h4>Admins</h4><p class="hint">${role.owner ? 'You own this page, so you are always an admin.' : role.admin ? 'You are a library admin.' : role.needsEditor ? 'You are on the admin list, but this page gives you no Editor access yet: ask the owner to add you as an Editor in Share.' : 'Admins make libraries and decide what goes in them. You can turn each library on or off for yourself.'}</p>
        <div class="libs-people">${who}</div>
        ${role.owner ? `<div class="cv-row"><input type="search" class="input grow" data-people="q" placeholder="Add an admin: search people" autocomplete="off"></div><div class="libs-hits">${peopleHits.filter(p => !list.includes(p.id)).slice(0, 6).map(p => `<button type="button" class="btn small ghost" data-addadmin="${esc(p.id)}" data-name="${esc(p.name)}">＋ ${esc(p.name)}${p.email ? ` <span class="hint">${esc(p.email)}</span>` : ''}</button>`).join('')}</div>
        <p class="hint">Admins also need <b>Editor</b> access to this page (claude.ai → Share). The page only accepts library changes from Editors, so people who are not on the list cannot change libraries, even by other means.</p>` : ''}`;
    } else if (mode === 'server') {
      admins = `<h4>Admins</h4>${LibStore._state.keyRequired ? (role.admin ? '<p class="hint">Library editing is unlocked in this browser.</p>' : `<p class="hint">This server limits library editing to people with the admin key.</p><div class="cv-row"><input type="password" class="input grow" data-lib-key placeholder="Admin key"><button type="button" class="btn small" data-lib-unlock>Unlock</button></div>`) : '<p class="hint">Anyone using this server can edit libraries. To limit it, start the server with LG_ADMIN_KEY=… and share the key with your admins.</p>'}`;
    } else admins = '<h4>Sharing</h4><p class="hint">Libraries live in this browser. Export one and import it elsewhere, or open the page in claude.ai or from the Layout Engine server to share them with everyone.</p>';
    body.innerHTML = `<div class="libs-list">${srcs.map(row).join('')}</div>
      ${role.admin ? `<div class="cv-row libs-new"><input type="text" class="input grow" data-new-lib placeholder="New library, e.g. Sales" maxlength="60"><button type="button" class="btn small primary" data-create-lib>Create</button></div>` : ''}
      ${admins}
      ${role.admin ? '<h4>Code components</h4><p class="hint">Import a component manifest (Library → Import) to add your design system\'s coded components to a library. On the canvas they are stand-ins with real props; React export writes the real components.</p>' : ''}
      <div class="cv-row wrap"><button type="button" class="btn small ghost" data-libs-export>Export shared libraries</button>${role.admin ? '<label class="btn small ghost file">Import libraries<input type="file" data-libs-import accept=".json,application/json" hidden></label>' : ''}</div>`;
  }
  function bindManager(root) {
    mgr = root;
    root.addEventListener('click', async e => {
      if (e.target === root || e.target.closest('[data-libs-close]')) { root.hidden = true; return; }
      const t = e.target;
      const ed = t.closest('[data-edit]'); if (ed) { editing = ed.dataset.edit; confirmDel = null; renderManager(); return; }
      if (t.closest('[data-le-cancel]')) { editing = null; confirmDel = null; renderManager(); return; }
      const sv = t.closest('[data-le-save]'); if (sv) { const box = sv.closest('.libs-edit'); const v = k => box.querySelector(`[data-le="${k}"]`); await guard(() => LibStore.updateLibrary(sv.dataset.leSave, { name: v('name').value.trim() || 'Library', description: v('description').value, defaultOn: v('defaultOn').checked })); editing = null; renderManager(); return; }
      const dl = t.closest('[data-le-del]'); if (dl) { confirmDel = dl.dataset.leDel; renderManager(); return; }
      const dok = t.closest('[data-le-del-ok]'); if (dok) { await guard(() => LibStore.deleteLibrary(dok.dataset.leDelOk)); editing = null; confirmDel = null; renderManager(); env.toast('Library deleted'); return; }
      const ex = t.closest('[data-le-export]'); if (ex) { await downloadLibs([ex.dataset.leExport]); return; }
      if (t.closest('[data-libs-export]')) { if (!LibStore.libraries().length) { env.toast('No shared libraries yet'); return; } await downloadLibs(null); return; }
      if (t.closest('[data-create-lib]')) { const inp = root.querySelector('[data-new-lib]'); const name = inp.value.trim(); if (!name) { inp.focus(); return; } const lib = await guard(() => LibStore.createLibrary({ name })); if (lib) { env.toast(`${lib.name} created. Save pieces to it from the Library panel.`); LS.set('lg.libDest', lib.id); } renderManager(); return; }
      const ad = t.closest('[data-addadmin]'); if (ad) { names[ad.dataset.addadmin] = ad.dataset.name; await guard(() => LibStore.setAdmins([...LibStore.admins, ad.dataset.addadmin])); peopleHits = []; renderManager(); return; }
      const un = t.closest('[data-unadmin]'); if (un) { await guard(() => LibStore.setAdmins(LibStore.admins.filter(x => x !== un.dataset.unadmin))); renderManager(); return; }
      if (t.closest('[data-lib-unlock]')) { const k = root.querySelector('[data-lib-key]').value; await guard(async () => { await LibStore.checkKey(k); env.toast('Library editing unlocked'); }); renderManager(); return; }
    });
    root.addEventListener('change', async e => {
      const t = e.target;
      if (t.dataset.on) { LibStore.setOn(t.dataset.on, t.checked); refresh(); return; }
      if (t.hasAttribute('data-libs-import')) { const f = t.files[0]; t.value = ''; if (f) await guard(async () => { const j = JSON.parse(await f.text()); if (j && j.lgComponents) { root.hidden = true; await importFile(j); return; } const r = await LibStore.importJSON(j); env.toast(`Imported ${r.items} items`); }); renderManager(); }
    });
    root.addEventListener('input', async e => { if (e.target.dataset.people === 'q') { const q = e.target.value; peopleHits = q.trim() ? await LibStore.searchPeople(q) : []; const pos = e.target.selectionStart; renderManager(); const inp = root.querySelector('[data-people="q"]'); if (inp) { inp.value = q; inp.focus(); try { inp.setSelectionRange(pos, pos); } catch { } } } });
    root.addEventListener('focusin', async e => { if (e.target.dataset.people === 'q' && !e.target.value && !peopleHits.length) { peopleHits = await LibStore.searchPeople(''); const inp = e.target; renderManager(); const again = root.querySelector('[data-people="q"]'); if (again && again !== inp) again.focus(); } });
    root.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') root.hidden = true; if (e.key === 'Enter' && e.target.hasAttribute('data-new-lib')) root.querySelector('[data-create-lib]').click(); });
  }
  async function downloadLibs(ids) {
    const j = LibStore.exportJSON(ids); const blob = new Blob([JSON.stringify(j, null, 1)], { type: 'application/json' });
    const nm = ids && ids.length === 1 ? (LibStore.libraries().find(l => l.id === ids[0]) || {}).name : 'libraries';
    if (await env.download(blob, `${String(nm || 'libraries').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`)) env.toast(`Exported ${j.lgLibrary.items.length} items`);
  }
  return { init, bind, bindManager, render, refresh, imagesChanged, openManager, all, sources, builtins, thumb, fromSelection, insert, specFor, codeSpecs, palette, settle, CATEGORIES };
})();
