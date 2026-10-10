/* Library: approved pieces to drop on a screen. Built-ins are generated from the brand kit (so they follow its colors,
   fonts and logos): logo variants, buttons, tags, cards, payment cards, device frames and starter illustrations.
   Team items live in the canvas document (doc.library), so everyone in a live room sees the same set; they are saved
   from a selection, or added from SVG/PNG files, and can be marked approved. Items are block lists with positions
   from 0,0; inserting gives them fresh ids and drops them into the screen or box you pick. */
const Library = (() => {
  const CATEGORIES = [['all', 'All'], ['logos', 'Logos'], ['components', 'Components'], ['cards', 'Cards'], ['devices', 'Devices'], ['illustrations', 'Illustrations'], ['saved', 'Team']];
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let env = null; let cat = 'all'; let query = ''; let el = null; let naming = false;

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
  function all(doc, kit) { return [...builtins(kit), ...((doc && doc.library) || []).map(it => ({ ...it, category: it.category || 'saved', team: true }))]; }
  function thumb(item, kit) {
    const key = item.id + ':' + (item.v || 0) + ':' + cache.sig;
    if (cache.thumbs.has(key)) return cache.thumbs.get(key);
    const pad = Math.max(item.w, item.h) * 0.08; const W = item.w + pad * 2, H = item.h + pad * 2;
    const blocks = Canvas.clone(item.blocks).map(b => ({ ...b, x: b.x + pad, y: b.y + pad }));
    const svg = Render.toSVG({ id: 'th-' + String(item.id).replace(/[^\w-]/g, ''), format: { w: W, h: H }, palette: { bg: '#000' }, blocks }, { kit, assets: env ? env.getAssets() : { images: [] }, transparent: true, width: 120 });
    cache.thumbs.set(key, svg); return svg;
  }
  // Selected blocks (with what is inside boxes) -> a library item.
  function fromSelection(frame, blocks, name, category) {
    const tops = Auto.topmost(frame, blocks); const list = Canvas.clone(Auto.withDescendants(frame, tops)); const topIds = new Set(tops.map(b => b.id));
    for (const b of list) if (topIds.has(b.id)) { delete b.parent; delete b.rx; delete b.ry; delete b.absolute; if (b.sizeW === 'fill') b.sizeW = 'fixed'; if (b.sizeH === 'fill') b.sizeH = 'fixed'; }
    const s = settle(list);
    return { id: 'u' + Math.random().toString(36).slice(2, 10), name: String(name || 'Component').slice(0, 60), category: category || 'saved', approved: false, created: Date.now(), v: 1, w: s.w, h: s.h, blocks: s.blocks };
  }

  // ---- Panel ------------------------------------------------------------------------------------------------------------
  function init(e) { env = e; }
  function render(container, q) {
    el = container || el; if (!el || !env) return; query = (q ?? query).toLowerCase();
    const kit = env.getKit(); const doc = env.canvas.doc; const list = all(doc, kit);
    const shown = list.filter(it => (cat === 'all' || it.category === cat || (cat === 'saved' && it.team)) && (!query || `${it.name} ${it.category}`.toLowerCase().includes(query)));
    const sel = env.canvas.selection(); const canSave = sel.blockIds.length > 0;
    el.innerHTML = `<div class="lib-cats">${CATEGORIES.map(([k, l]) => `<button type="button" class="${cat === k ? 'on' : ''}" data-cat="${k}">${l}</button>`).join('')}</div>
      <div class="lib-grid">${shown.map(it => `<div class="lib-item" draggable="true" data-item="${esc(it.id)}" title="${esc(it.name)} · click to add, or drag onto a screen"><div class="lib-thumb">${thumb(it, kit)}</div><div class="lib-name">${esc(it.name)}${it.approved ? ' <span class="lib-ok" title="Approved">✓</span>' : ''}${it.starter ? ' <span class="lib-tag">starter</span>' : ''}</div>${it.team ? `<div class="lib-acts"><button type="button" data-approve="${esc(it.id)}" title="${it.approved ? 'Unmark as approved' : 'Mark as approved'}">${it.approved ? '✓ Approved' : 'Approve'}</button><button type="button" data-remove="${esc(it.id)}" title="Remove from the library">✕</button></div>` : ''}</div>`).join('') || '<p class="hint" style="padding:8px">Nothing here yet.</p>'}</div>
      ${naming ? `<div class="lib-name-row"><input type="text" class="input grow" data-lib="name" placeholder="Name, e.g. Pricing card" maxlength="60"><button type="button" class="btn small primary" data-lib="save-ok">Save</button><button type="button" class="btn small ghost" data-lib="save-cancel">Cancel</button></div>` : ''}
      <div class="lib-foot">
        <button type="button" class="btn small" data-lib="save" ${canSave ? '' : 'disabled'} title="Select blocks on a screen first">＋ Save selection</button>
        <label class="btn small file">＋ Add SVG or PNG<input type="file" data-lib="files" accept=".svg,image/svg+xml,image/png,image/jpeg,image/webp" multiple hidden></label>
        <button type="button" class="btn small ghost" data-lib="export" title="Download the team library as JSON">Export</button>
        <label class="btn small ghost file" title="Add items from a library JSON">Import<input type="file" data-lib="import" accept=".json,application/json" hidden></label>
      </div>
      <p class="hint lib-hint">Built-in pieces follow the brand kit. Team items are shared with everyone on this canvas.</p>`;
  }
  function find(itemId) { return all(env.canvas.doc, env.getKit()).find(x => x.id === itemId); }
  function bind(container) {
    el = container;
    el.addEventListener('click', async e => {
      const c = e.target.closest('[data-cat]'); if (c) { cat = c.dataset.cat; render(); return; }
      const ap = e.target.closest('[data-approve]'); if (ap) { env.canvas.mutate(d => { const it = (d.library || []).find(x => x.id === ap.dataset.approve); if (it) { it.approved = !it.approved; it.v = (it.v || 0) + 1; } }); render(); return; }
      const rm = e.target.closest('[data-remove]'); if (rm) { env.canvas.mutate(d => { d.library = (d.library || []).filter(x => x.id !== rm.dataset.remove); }); render(); env.toast('Removed from the library'); return; }
      const act = e.target.closest('[data-lib]');
      if (act && act.dataset.lib === 'save') { const sel = env.canvas.selection(); if (!sel.blockIds.length) { env.toast('Select blocks on a screen to save them'); return; } naming = true; render(); const inp = el.querySelector('[data-lib="name"]'); if (inp) { const f = Canvas.frameById(env.canvas.doc, sel.frameId); const b = f && Canvas.blockById(f, sel.blockIds[0]); inp.value = b ? (b.label || (b.kind === 'box' ? 'Component' : b.role || b.kind)) : 'Component'; inp.focus(); inp.select(); } return; }
      if (act && act.dataset.lib === 'save-cancel') { naming = false; render(); return; }
      if (act && act.dataset.lib === 'save-ok') { const inp = el.querySelector('[data-lib="name"]'); naming = false; saveSelection(inp ? inp.value : ''); return; }
      if (act && act.dataset.lib === 'export') { exportLibrary(); return; }
      const it = e.target.closest('[data-item]'); if (it && !act) { insert(it.dataset.item); }
    });
    el.addEventListener('keydown', e => { if (e.target.dataset.lib === 'name') { e.stopPropagation(); if (e.key === 'Enter') { naming = false; saveSelection(e.target.value); } else if (e.key === 'Escape') { naming = false; render(); } } });
    el.addEventListener('change', async e => {
      const t = e.target;
      if (t.dataset.lib === 'files') { for (const f of t.files) await addFile(f); t.value = ''; render(); }
      if (t.dataset.lib === 'import') { try { await importLibrary(JSON.parse(await t.files[0].text())); } catch (err) { env.toast('Could not import: ' + err.message); } t.value = ''; render(); }
    });
    el.addEventListener('dragstart', e => { const it = e.target.closest('[data-item]'); if (!it) return; e.dataTransfer.setData('application/x-lg-library', it.dataset.item); e.dataTransfer.effectAllowed = 'copy'; });
  }
  // Insert into the selected screen (or box), else the screen in view; at a point when dropped.
  function insert(itemId, at) {
    const it = find(itemId); if (!it) return;
    const out = env.canvas.insertComponent(it.blocks, { at, name: it.name });
    if (out) env.toast(`${it.name} added${it.approved ? '' : ' (not yet approved)'}`);
  }
  function saveSelection(name) {
    const sel = env.canvas.selection(); const f = sel.frameId && Canvas.frameById(env.canvas.doc, sel.frameId);
    if (!f || !sel.blockIds.length) { env.toast('Select blocks on a screen to save them'); render(); return; }
    const blocks = sel.blockIds.map(i => Canvas.blockById(f, i)).filter(Boolean);
    name = String(name || '').trim() || 'Component';
    const category = /card/i.test(name) ? 'cards' : /illus|art|shape/i.test(name) ? 'illustrations' : /phone|device|browser/i.test(name) ? 'devices' : 'components';
    const item = fromSelection(f, blocks, name, category); item.by = env.me ? env.me() : '';
    env.canvas.mutate(d => { d.library = [...(d.library || []), item]; }, { history: true });
    cat = 'saved'; render(); env.toast(`Saved “${item.name}” to the team library`);
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
    env.canvas.mutate(d => { d.library = [...(d.library || []), item]; });
    cat = 'illustrations'; env.toast(`Added ${name} to Illustrations`);
  }
  async function exportLibrary() {
    const doc = env.canvas.doc; const items = doc.library || []; if (!items.length) { env.toast('The team library is empty'); return; }
    const assets = {}; const imgs = env.getAssets().images;
    for (const it of items) for (const b of it.blocks) if (b.kind === 'image' && b.asset) { const a = imgs.find(x => x.id === b.asset); if (a && a.dataUrl) assets[b.asset] = { name: a.name, dataUrl: a.dataUrl }; }
    const blob = new Blob([JSON.stringify({ lgLibrary: { v: 1, kit: env.getKit().name, items, assets } }, null, 1)], { type: 'application/json' });
    if (await env.download(blob, `${String(env.getKit().name || 'brand').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-library.json`)) env.toast(`Library exported: ${items.length} items`);
  }
  async function importLibrary(j) {
    const L = j && j.lgLibrary; if (!L || !Array.isArray(L.items)) throw new Error('not a library file');
    const remap = new Map();
    for (const [oldId, a] of Object.entries(L.assets || {})) { if (a && typeof a.dataUrl === 'string' && /^data:image\//.test(a.dataUrl)) { const added = await env.addImageData(a.dataUrl, a.name || 'library image'); remap.set(oldId, added.id); } }
    const have = new Set((env.canvas.doc.library || []).map(x => x.id)); let n = 0;
    const items = L.items.filter(it => it && it.id && Array.isArray(it.blocks) && !have.has(it.id)).slice(0, 300).map(it => { n++; const c = Canvas.clone(it); for (const b of c.blocks) if (b.kind === 'image' && remap.has(b.asset)) b.asset = remap.get(b.asset); return c; });
    env.canvas.mutate(d => { d.library = [...(d.library || []), ...items]; });
    env.toast(n ? `Imported ${n} library item${n > 1 ? 's' : ''}` : 'Those items are already here');
  }
  return { init, bind, render, all, builtins, thumb, fromSelection, insert, CATEGORIES };
})();
