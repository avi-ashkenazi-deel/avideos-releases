/* UI wiring. State lives here; the engine and renderer are pure. */
(() => {
  const $ = id => document.getElementById(id);
  const state = {
    kit: null, assets: { images: [] }, layouts: [], favs: new Set(), picks: new Set(),
    formats: ['square'], showGrid: false, lastPrompt: null, intent: Prompt.DEFAULT(), seedBase: 1, detail: null, busy: false,
  };
  const LS = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } } };
  let imgSeq = 1;

  // ---- Toast ---------------------------------------------------------------------
  let toastT;
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2600); }

  // ---- Brand kit form -------------------------------------------------------------
  function fillFontSelects() {
    for (const sel of [$('displayFont'), $('bodyFont')]) {
      const cur = sel.value;
      sel.innerHTML = Brand.allFontNames().map(n => `<option>${n}</option>`).join('');
      if (cur) sel.value = cur;
    }
  }
  function loadKit(kit) {
    state.kit = kit;
    $('brandName').value = kit.name;
    $('displayFont').value = kit.fonts.display; $('bodyFont').value = kit.fonts.body;
    for (const k of ['eyebrow', 'headline', 'subhead', 'body', 'cta', 'stat', 'footer']) $(k).value = kit.content[k] || '';
    $('unit').value = String(kit.grid.unit); $('margin').value = String(kit.grid.marginRatio); $('gutter').value = String(kit.grid.gutterUnits);
    $('radius').value = String(kit.grid.radius ?? 1); $('shapes').value = kit.shapes && kit.shapes.length ? 'on' : 'off';
    $('logoMono').checked = kit.logo.monochrome !== false;
    renderColors(); renderLogo();
  }
  function readKit() {
    const k = state.kit;
    k.name = $('brandName').value.trim() || k.name;
    k.fonts.display = $('displayFont').value; k.fonts.body = $('bodyFont').value;
    for (const f of ['eyebrow', 'headline', 'subhead', 'body', 'cta', 'stat', 'footer']) k.content[f] = $(f).value.trim();
    k.grid.unit = +$('unit').value; k.grid.marginRatio = +$('margin').value; k.grid.gutterUnits = +$('gutter').value; k.grid.radius = +$('radius').value;
    if ($('shapes').value === 'off') k.shapes = []; else if (!k.shapes || !k.shapes.length) k.shapes = ['circle', 'pill', 'quarter'];
    k.logo.monochrome = $('logoMono').checked;
    if (k.logo.kind === 'wordmark') k.logo.text = k.logo.text || k.name.toLowerCase();
    persistKit();
    return k;
  }
  function persistKit() { const s = Brand.serialize(state.kit); if (s.length < 800000) LS.set('lg.kit', state.kit); LS.set('lg.preset', state.kit.presetId || ''); }
  const ROLES = ['core', 'accent', 'background', 'neutral'];
  function renderColors() {
    $('colorList').innerHTML = state.kit.colors.map((c, i) =>
      `<span class="swatch" data-i="${i}" title="${c.hex} · click to change role"><span class="chip" style="background:${c.hex}"></span>${c.name || c.hex}<span class="role">${c.role}</span><span class="x" data-x="${i}" title="Remove">✕</span></span>`).join('');
  }
  $('colorList').addEventListener('click', e => {
    const x = e.target.closest('[data-x]'); const s = e.target.closest('.swatch');
    if (x) { state.kit.colors.splice(+x.dataset.x, 1); renderColors(); persistKit(); return; }
    if (s) { const c = state.kit.colors[+s.dataset.i]; c.role = ROLES[(ROLES.indexOf(c.role) + 1) % ROLES.length]; renderColors(); persistKit(); }
  });
  $('addColorBtn').addEventListener('click', () => {
    const hex = Color.normalize($('newColor').value); const name = $('newColorName').value.trim() || hex;
    state.kit.colors.push({ name, hex, role: 'accent' }); $('newColorName').value = ''; renderColors(); persistKit();
  });
  $('extractedSwatches').addEventListener('click', e => {
    const s = e.target.closest('.swatch'); if (!s) return;
    const hex = s.dataset.hex; if (state.kit.colors.some(c => Color.normalize(c.hex) === hex)) return toast('Already in the kit');
    state.kit.colors.push({ name: 'From image', hex, role: 'accent' }); renderColors(); persistKit(); toast('Added ' + hex);
  });
  function renderLogo() {
    const l = state.kit.logo; const el = $('logoPreview');
    if (l.kind === 'svg' && l.svg) el.innerHTML = `<svg viewBox="${l.svg.viewBox}" width="100%" height="100%">${Brand.logoInner(state.kit, '#ECEBF0')}</svg>`;
    else if (l.kind === 'image' && l.dataUrl) el.innerHTML = `<img src="${l.dataUrl}" alt="logo">`;
    else el.innerHTML = `<span class="wordmark" style="font-family:${Brand.fontCss(state.kit.fonts.display)}">${l.text || state.kit.name}</span>`;
  }
  $('logoFile').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    if (f.type.includes('svg') || f.name.endsWith('.svg')) {
      const svg = Brand.parseSvg(await f.text()); if (!svg) return toast('Could not read that SVG');
      state.kit.logo = { ...state.kit.logo, kind: 'svg', svg, monochrome: $('logoMono').checked };
    } else {
      const dataUrl = await readAsDataURL(f); const im = await loadImage(dataUrl);
      state.kit.logo = { ...state.kit.logo, kind: 'image', dataUrl, aspect: im.naturalWidth / im.naturalHeight };
    }
    renderLogo(); persistKit(); toast('Logo updated'); e.target.value = '';
  });
  $('logoMono').addEventListener('change', () => { state.kit.logo.monochrome = $('logoMono').checked; renderLogo(); persistKit(); });
  $('displayFont').addEventListener('change', () => { readKit(); renderLogo(); });
  $('bodyFont').addEventListener('change', readKit);
  $('brandName').addEventListener('change', () => { readKit(); if (state.kit.logo.kind === 'wordmark') { state.kit.logo.text = state.kit.name.toLowerCase(); renderLogo(); } });
  for (const id of ['eyebrow', 'headline', 'subhead', 'body', 'cta', 'stat', 'footer', 'unit', 'margin', 'gutter', 'radius', 'shapes']) $(id).addEventListener('change', readKit);

  $('fontFile').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    const name = f.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
    try {
      const buf = await f.arrayBuffer();
      const face = new FontFace(name, buf); await face.load(); document.fonts.add(face);
      const b64 = Render.bufToBase64(buf);
      const mime = f.name.endsWith('.woff2') ? 'font/woff2' : f.name.endsWith('.woff') ? 'font/woff' : f.name.endsWith('.otf') ? 'font/otf' : 'font/ttf';
      Brand.customFonts[name] = { css: `"${name}", sans-serif`, weights: [300, 400, 500, 600, 700, 800, 900], dataUrl: `data:${mime};base64,${b64}` };
      fillFontSelects(); $('displayFont').value = name; readKit(); renderLogo(); Text.clearCache();
      $('fontStatus').textContent = `Loaded "${name}" as the display font.`;
    } catch (err) { $('fontStatus').textContent = 'Could not load that font file.'; console.warn(err); }
    e.target.value = '';
  });

  // ---- Presets --------------------------------------------------------------------
  function fillPresets() {
    $('presetSelect').innerHTML = Object.entries(Brand.PRESETS).map(([id, p]) => `<option value="${id}">${p.name}</option>`).join('') + '<option value="__custom">Custom (loaded)</option>';
  }
  $('presetSelect').addEventListener('change', async e => {
    const id = e.target.value; if (id === '__custom') return;
    loadKit(Brand.fromPreset(id)); $('presetSelect').value = id;
    await ensureDemoImages(true); persistKit(); Text.clearCache();
  });

  // ---- Images -------------------------------------------------------------------------
  const readAsDataURL = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
  const loadImage = src => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
  async function addImage(dataUrl, name, placeholder = false) {
    const im = await loadImage(dataUrl);
    const blob = await (await fetch(dataUrl)).blob();
    const asset = { id: 'img' + (imgSeq++), name, url: URL.createObjectURL(blob), dataUrl, w: im.naturalWidth, h: im.naturalHeight, lum: Color.luminanceMap(im), placeholder, palette: Color.extractPalette(im) };
    state.assets.images.push(asset); renderImages();
    return asset;
  }
  function renderImages() {
    $('imageList').innerHTML = state.assets.images.map(a => `<div class="thumb" title="${a.name}"><img src="${a.url}" alt=""><button class="x" data-rm="${a.id}" title="Remove">✕</button>${a.placeholder ? '<span class="ph">placeholder</span>' : ''}</div>`).join('');
    const real = state.assets.images.filter(a => !a.placeholder);
    const pal = [...new Set(real.flatMap(a => a.palette))].slice(0, 8);
    $('extracted').hidden = !pal.length;
    $('extractedSwatches').innerHTML = pal.map(h => `<span class="swatch" data-hex="${h}" title="Add ${h} to the kit"><span class="chip" style="background:${h}"></span></span>`).join('');
  }
  $('imageList').addEventListener('click', e => {
    const b = e.target.closest('[data-rm]'); if (!b) return;
    const i = state.assets.images.findIndex(a => a.id === b.dataset.rm); if (i >= 0) { URL.revokeObjectURL(state.assets.images[i].url); state.assets.images.splice(i, 1); renderImages(); }
  });
  $('imageFiles').addEventListener('change', async e => {
    const files = [...e.target.files]; if (!files.length) return;
    // Real photos replace the placeholders.
    const ph = state.assets.images.filter(a => a.placeholder); for (const a of ph) URL.revokeObjectURL(a.url);
    state.assets.images = state.assets.images.filter(a => !a.placeholder);
    for (const f of files) { try { await addImage(await readAsDataURL(f), f.name); } catch (err) { console.warn(err); } }
    toast(`${files.length} image${files.length > 1 ? 's' : ''} added`); e.target.value = '';
  });
  async function ensureDemoImages(force) {
    if (!force && state.assets.images.length) return;
    if (state.assets.images.some(a => !a.placeholder)) return;
    for (const a of state.assets.images) URL.revokeObjectURL(a.url);
    state.assets.images = [];
    const pal = state.kit.colors.filter(c => c.role !== 'neutral').map(c => c.hex);
    for (let i = 0; i < 3; i++) await addImage(Brand.makeDemoImage(1000 + i * 7 + RNG.hashStr(state.kit.name), pal, 1200, i === 1 ? 800 : 1200), 'placeholder ' + (i + 1), true);
  }

  // ---- Formats chips --------------------------------------------------------------------
  function renderChips() {
    $('formatChips').innerHTML = Grid.FORMATS.map(f => `<button type="button" class="chip-btn ${state.formats.includes(f.id) ? 'on' : ''}" data-f="${f.id}">${f.name}<span class="ratio">${f.ratio}</span></button>`).join('');
  }
  $('formatChips').addEventListener('click', e => {
    const b = e.target.closest('[data-f]'); if (!b) return;
    const id = b.dataset.f;
    if (state.formats.includes(id)) { if (state.formats.length > 1) state.formats = state.formats.filter(x => x !== id); }
    else state.formats.push(id);
    renderChips();
  });

  // ---- Generation -----------------------------------------------------------------------
  async function loadFonts(kit) {
    const fams = [kit.fonts.display, kit.fonts.body];
    const loads = [];
    for (const fam of fams) for (const w of Brand.fontWeights(fam)) loads.push(document.fonts.load(`${w} 40px "${fam}"`).catch(() => { }));
    await Promise.all(loads);
    Text.clearCache();
  }
  async function resolveIntent(text) {
    const kit = state.kit;
    let intent;
    const useClaude = $('useClaude').checked && $('apiKey').value.trim();
    if (useClaude) {
      try { intent = await Prompt.interpret(text, kit, $('apiKey').value.trim()); $('interpretLog').textContent = 'Claude: ' + intent.summary; intent.source = 'claude'; }
      catch (err) { $('interpretLog').textContent = 'Claude failed, used the rule parser. ' + err.message; toast('Claude interpreter failed, used rules'); }
    }
    if (!intent) { intent = Prompt.parse(text, kit); intent.source = 'rules'; }
    return intent;
  }
  async function generate(text, opts = {}) {
    if (state.busy) return;
    state.busy = true; $('generateBtn').disabled = true; $('generateBtn').textContent = 'Reading brief…';
    try {
      const kit = readKit();
      await ensureDemoImages(false);
      await loadFonts(kit);
      let intent = opts.intent;
      if (!intent) {
        intent = await resolveIntent(text);
        const promptChanged = text !== state.lastPrompt;
        if (promptChanged) {
          if (intent.formatsExplicit && intent.formats?.length) { state.formats = intent.formats.slice(); renderChips(); }
          if (intent.countExplicit && intent.count) $('count').value = String([24, 48, 96, 180, 360].reduce((b, c) => Math.abs(c - intent.count) < Math.abs(b - intent.count) ? c : b, 96));
          state.lastPrompt = text;
        }
        intent.formats = state.formats.slice();
        intent.count = +$('count').value;
        state.intent = intent;
      }
      LS.set('lg.prompt', text);
      const formats = intent.formats.map(id => Grid.byId[id]).filter(Boolean);
      const count = intent.count;
      $('generateBtn').textContent = 'Generating…';
      const t0 = performance.now();
      const seen = new Set(opts.append ? state.layouts.map(l => l.signature) : []);
      const out = []; let attempts = 0; let seed = (opts.seedBase ?? (state.seedBase = (state.seedBase * 1664525 + 1013904223) >>> 0)) >>> 0;
      const rejected = {};
      const maxAttempts = count * 14;
      while (out.length < count && attempts < maxAttempts) {
        const format = formats[attempts % formats.length];
        seed = (seed + 0x9E3779B9) >>> 0; attempts++;
        const L = Engine.generate({ intent, kit, assets: state.assets, format, seed, archetype: opts.archetype });
        if (!L) { rejected.none = (rejected.none || 0) + 1; continue; }
        if (seen.has(L.signature)) { rejected.dup = (rejected.dup || 0) + 1; continue; }
        seen.add(L.signature); out.push(L);
        if (out.length % 16 === 0) { $('generateBtn').textContent = `Generating… ${out.length}`; await new Promise(r => setTimeout(r, 0)); }
      }
      const ms = Math.round(performance.now() - t0);
      if (opts.append) state.layouts = [...out, ...state.layouts]; else { state.layouts = out; state.picks.clear(); }
      renderReadout(intent, out.length, attempts, ms, formats);
      renderGallery();
      if (!out.length) toast('Nothing passed the rules. Try shorter copy or a bigger safe space.');
      else if (opts.append) toast(`${out.length} variations added`);
      $('main').scrollTop = 0;
    } finally { state.busy = false; $('generateBtn').disabled = false; $('generateBtn').textContent = 'Generate'; }
  }
  function renderReadout(intent, made, attempts, ms, formats) {
    const arch = {}; for (const l of state.layouts) arch[l.archetypeLabel] = (arch[l.archetypeLabel] || 0) + 1;
    $('readout').innerHTML = [
      `<span><span class="k">brief read by</span> <b>${intent.source === 'claude' ? 'Claude' : 'rules'}</b>${intent.summary ? ` · ${escapeHtml(intent.summary)}` : ''}</span>`,
      `<span><span class="k">formats</span> <b>${formats.map(f => f.name).join(', ')}</b></span>`,
      `<span><span class="k">emphasis</span> <b>${intent.emphasis}</b> · <span class="k">density</span> <b>${intent.density}</b> · <span class="k">loud</span> <b>${Math.round(intent.loud * 100)}%</b></span>`,
      `<span><span class="k">kept</span> <b>${made}</b> <span class="k">of ${attempts} attempts in ${ms} ms</span></span>`,
      `<span class="k">${Object.entries(arch).map(([k, v]) => `${k} ${v}`).join(' · ')}</span>`,
    ].join('');
    const sel = $('filterArch'); const cur = sel.value;
    sel.innerHTML = '<option value="">All archetypes</option>' + Object.keys(arch).sort().map(k => `<option>${k}</option>`).join('');
    sel.value = cur && arch[cur] ? cur : '';
  }
  const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---- Gallery ---------------------------------------------------------------------------
  function visibleLayouts() {
    let list = state.layouts.slice();
    const f = $('filterArch').value; if (f) list = list.filter(l => l.archetypeLabel === f);
    if ($('favOnly').checked) list = list.filter(l => state.favs.has(l.id));
    const s = $('sort').value;
    if (s === 'whitespace') list.sort((a, b) => b.metrics.whitespace - a.metrics.whitespace);
    else if (s === 'density') list.sort((a, b) => b.metrics.density - a.metrics.density);
    else if (s === 'balance') list.sort((a, b) => b.metrics.balance - a.metrics.balance);
    else if (s === 'archetype') list.sort((a, b) => a.archetype.localeCompare(b.archetype) || a.seed - b.seed);
    return list;
  }
  function cardSVG(l) { return Render.toSVG(l, { kit: state.kit, assets: state.assets, showGrid: state.showGrid, width: 480 }); }
  function renderGallery() {
    const list = visibleLayouts();
    $('empty').hidden = state.layouts.length > 0;
    const frag = document.createDocumentFragment();
    for (const l of list) {
      const card = document.createElement('div'); card.className = 'card' + (state.picks.has(l.id) ? ' selected' : ''); card.dataset.id = l.id;
      card.innerHTML = `<div class="canvas">${cardSVG(l)}</div><div class="meta"><span class="arch">${l.archetypeLabel}</span><span>${l.format.name} · ${l.id}</span></div><button class="fav ${state.favs.has(l.id) ? 'on' : ''}" data-fav="${l.id}" title="Favorite">★</button><input class="pick" type="checkbox" data-pick="${l.id}" ${state.picks.has(l.id) ? 'checked' : ''} title="Pick for compare" aria-label="Pick for compare">`;
      frag.appendChild(card);
    }
    $('gallery').replaceChildren(frag);
    updateBars();
  }
  function updateBars() {
    $('compareBtn').textContent = `Compare (${state.picks.size})`; $('compareBtn').disabled = state.picks.size < 2;
    $('exportFavBtn').disabled = !state.favs.size; $('exportFavBtn').textContent = state.favs.size ? `Export favorites (${state.favs.size})` : 'Export favorites';
  }
  $('gallery').addEventListener('click', e => {
    const fav = e.target.closest('[data-fav]'); if (fav) { toggleFav(fav.dataset.fav); return; }
    const pick = e.target.closest('[data-pick]'); if (pick) { if (pick.checked) state.picks.add(pick.dataset.pick); else state.picks.delete(pick.dataset.pick); pick.closest('.card').classList.toggle('selected', pick.checked); updateBars(); return; }
    const card = e.target.closest('.card'); if (card) openDetail(card.dataset.id);
  });
  function toggleFav(id) {
    if (state.favs.has(id)) state.favs.delete(id); else state.favs.add(id);
    document.querySelectorAll(`[data-fav="${id}"]`).forEach(b => b.classList.toggle('on', state.favs.has(id)));
    if (state.detail && state.detail.id === id) $('detailFav').classList.toggle('active', state.favs.has(id));
    updateBars();
  }
  for (const id of ['sort', 'filterArch', 'favOnly']) $(id).addEventListener('change', renderGallery);
  $('showGrid').addEventListener('change', () => { state.showGrid = $('showGrid').checked; renderGallery(); });

  // ---- Detail --------------------------------------------------------------------------
  function findLayout(id) { return state.layouts.find(l => l.id === id) || state.family?.find(l => l.id === id); }
  function openDetail(id) {
    const l = findLayout(id); if (!l) return;
    state.detail = l; state.family = null;
    $('detailGrid').checked = state.showGrid;
    renderDetail();
    $('detail').hidden = false;
  }
  function renderDetail() {
    const l = state.detail; if (!l) return;
    $('detailPreview').innerHTML = Render.toSVG(l, { kit: state.kit, assets: state.assets, showGrid: $('detailGrid').checked, width: 1000 });
    $('detailId').textContent = `${l.id} · seed ${l.seed}`;
    $('detailTitle').textContent = `${l.archetypeLabel} · ${l.format.name}`;
    $('detailFav').classList.toggle('active', state.favs.has(l.id));
    const g = l.grid;
    const meta = Object.entries(l.meta || {}).filter(([k]) => k !== 'overlay').map(([k, v]) => `${k}: ${v}`).join(', ');
    const rows = [
      ['Canvas', `${l.format.w} × ${l.format.h}`],
      ['Grid', `${g.cols} cols × ${g.rows} rows · cell ${g.cw}×${g.rh} · gutter ${g.gutter} · unit ${g.unit}px`],
      ['Safe space', `${g.safe.left} / ${g.safe.top} / ${g.safe.right} / ${g.safe.bottom}`],
      ['Palette', `${l.palette.bgName} ${l.palette.bg} · text ${l.palette.fg} · accent ${l.palette.accent}`],
      ['Type', `${l.type.display} ${l.type.headline}px headline · ${l.type.body_font} ${l.type.body}px body · step ${l.type.level + 1}/6`],
      ['Elements', l.blocks.map(b => b.role || b.kind).join(', ')],
      ['Moves', meta || '—'],
      ['Metrics', `whitespace ${Math.round(l.metrics.whitespace * 100)}% · density ${Math.round(l.metrics.density * 100)}% · balance ${Math.round(l.metrics.balance * 100)}%`],
    ];
    $('detailSpecs').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join('');
    $('detailJsonView').textContent = JSON.stringify(stripForJson(l), null, 1);
    $('familyStrip').innerHTML = '';
  }
  function stripForJson(l) {
    const c = JSON.parse(JSON.stringify(l)); delete c.signature; delete c.rejected;
    for (const b of c.blocks) { delete b.gap; delete b.maxLines; delete b.minSize; if (b.kind === 'text') { b.font = { family: b.font.family, size: b.font.size, weight: b.font.weight, lineHeight: b.font.lineHeight, letterSpacing: b.font.letterSpacing }; } }
    return c;
  }
  $('detailClose').addEventListener('click', () => { $('detail').hidden = true; state.detail = null; });
  $('detailGrid').addEventListener('change', renderDetail);
  $('detailFav').addEventListener('click', () => state.detail && toggleFav(state.detail.id));
  $('detailMore').addEventListener('click', async () => {
    const l = state.detail; if (!l) return;
    $('detail').hidden = true;
    const intent = { ...state.intent, formats: [l.format.id], count: 24, colorHints: [l.palette.bg, l.palette.accent], archetypes: [l.archetype] };
    await generate($('prompt').value, { intent, append: true, archetype: l.archetype, seedBase: (l.seed * 7 + 13) >>> 0 });
  });
  $('detailFamily').addEventListener('click', () => {
    const l = state.detail; if (!l) return;
    const fam = [];
    for (const f of Grid.FORMATS) {
      if (f.id === l.format.id) { fam.push(l); continue; }
      let L = null;
      for (let k = 0; k < 6 && !L; k++) L = Engine.generate({ intent: { ...state.intent, colorHints: [l.palette.bg, l.palette.accent] }, kit: state.kit, assets: state.assets, format: f, seed: (l.seed + k * 0x9E3779B9) >>> 0, archetype: l.archetype });
      if (L) fam.push(L);
    }
    state.family = fam;
    $('familyStrip').innerHTML = fam.map(x => `<div class="fam" data-id="${x.id}">${Render.toSVG(x, { kit: state.kit, assets: state.assets, width: 240 })}<div class="lbl">${x.format.name}</div></div>`).join('');
  });
  $('familyStrip').addEventListener('click', e => {
    const f = e.target.closest('[data-id]'); if (!f) return;
    const l = state.family?.find(x => x.id === f.dataset.id); if (!l) return;
    if (!state.layouts.some(x => x.id === l.id)) { state.layouts.unshift(l); renderGallery(); }
    const keep = state.family; state.detail = l; renderDetail(); state.family = keep;
    $('familyStrip').innerHTML = keep.map(x => `<div class="fam" data-id="${x.id}">${Render.toSVG(x, { kit: state.kit, assets: state.assets, width: 240 })}<div class="lbl">${x.format.name}</div></div>`).join('');
  });
  async function withBusy(btn, fn) { const t = btn.textContent; btn.disabled = true; btn.textContent = '…'; try { await fn(); } catch (e) { console.warn(e); toast('Export failed: ' + e.message); } finally { btn.disabled = false; btn.textContent = t; } }
  $('detailPng').addEventListener('click', e => withBusy(e.target, async () => { const l = state.detail; const blob = await Render.exportPNG(l, { kit: state.kit, assets: state.assets }); if (await Render.download(blob, `${slug(state.kit.name)}-${l.id}.png`)) toast(Render.fontsEmbedded() ? 'PNG saved' : 'PNG saved with fallback fonts (run locally for exact type)'); }));
  $('detailSvg').addEventListener('click', e => withBusy(e.target, async () => { const l = state.detail; const svg = await Render.exportSVG(l, { kit: state.kit, assets: state.assets }); if (await Render.download(new Blob([svg], { type: 'image/svg+xml' }), `${slug(state.kit.name)}-${l.id}.svg`)) toast('SVG saved'); }));
  $('detailJson').addEventListener('click', e => withBusy(e.target, async () => { const l = state.detail; if (await Render.download(new Blob([JSON.stringify(stripForJson(l), null, 2)], { type: 'application/json' }), `${slug(state.kit.name)}-${l.id}.json`)) toast('JSON saved'); }));
  $('detailCopySvg').addEventListener('click', e => withBusy(e.target, async () => { const svg = await Render.exportSVG(state.detail, { kit: state.kit, assets: state.assets }); await copyText(svg); toast('SVG copied'); }));
  const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'brand';
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); }
    catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } finally { ta.remove(); } }
  }

  // ---- Compare -----------------------------------------------------------------------------
  $('compareBtn').addEventListener('click', () => {
    const list = state.layouts.filter(l => state.picks.has(l.id)).slice(0, 8);
    $('compareGrid').innerHTML = list.map(l => `<div class="item">${Render.toSVG(l, { kit: state.kit, assets: state.assets, showGrid: state.showGrid, width: 600 })}<div class="lbl">${l.archetypeLabel} · ${l.format.name} · ${l.id}</div></div>`).join('');
    $('compare').hidden = false;
  });
  $('compareClose').addEventListener('click', () => $('compare').hidden = true);
  $('exportFavBtn').addEventListener('click', e => withBusy(e.target, async () => {
    const list = state.layouts.filter(l => state.favs.has(l.id));
    let n = 0;
    for (const l of list) { const blob = await Render.exportPNG(l, { kit: state.kit, assets: state.assets }); if (!(await Render.download(blob, `${slug(state.kit.name)}-${l.id}.png`))) break; n++; await new Promise(r => setTimeout(r, 350)); }
    if (n) toast(`${n} PNG${n > 1 ? 's' : ''} exported`);
  }));

  // ---- Brand JSON ----------------------------------------------------------------------------
  $('exportBrandBtn').addEventListener('click', e => withBusy(e.target, async () => { if (await Render.download(new Blob([Brand.serialize(readKit())], { type: 'application/json' }), `${slug(state.kit.name)}-brand-kit.json`)) toast('Brand kit saved'); }));
  $('copyBrandBtn').addEventListener('click', async () => { await copyText(Brand.serialize(readKit())); toast('Brand kit JSON copied'); });
  $('importBrand').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try { const kit = JSON.parse(await f.text()); if (!kit.colors || !kit.fonts) throw new Error('missing colors/fonts'); kit.presetId = '__custom'; kit.content = kit.content || {}; kit.grid = kit.grid || { unit: 8, marginRatio: 0.06, gutterUnits: 3, radius: 1 }; kit.logo = kit.logo || { kind: 'wordmark', text: kit.name, allowedColors: [], monochrome: true }; fillFontSelects(); loadKit(kit); $('presetSelect').value = '__custom'; await ensureDemoImages(true); toast('Brand kit loaded'); }
    catch (err) { toast('Could not load that kit: ' + err.message); }
    e.target.value = '';
  });

  // ---- Modals: about + settings ------------------------------------------------------------------
  $('aboutBtn').addEventListener('click', () => $('about').hidden = false);
  $('aboutClose').addEventListener('click', () => $('about').hidden = true);
  $('settingsBtn').addEventListener('click', () => $('settings').hidden = false);
  $('settingsClose').addEventListener('click', () => { LS.set('lg.apiKey', $('apiKey').value); LS.set('lg.useClaude', $('useClaude').checked); $('settings').hidden = true; });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') for (const id of ['detail', 'compare', 'about', 'settings']) $(id).hidden = true; });
  for (const id of ['detail', 'compare', 'about', 'settings']) $(id).addEventListener('click', e => { if (e.target === $(id)) $(id).hidden = true; });
  $('aboutBody').innerHTML = `
    <p>Most AI design tools pick a template or paint pixels. This engine does neither. It takes the rules a design system already has (a column grid, a pixel grid, safe space, approved color pairs, the logo's clear zone, a type scale) and lets chance move only inside them. The result is not one answer but a field of valid answers you can scan, compare, and choose from. The design decision stays with the designer; the engine removes the blank canvas and the manual iteration.</p>
    <h4>How a variation is made</h4>
    <ul>
      <li><b>Brief → constraints.</b> The prompt becomes a small JSON intent: formats, count, loudness, light or dark, image-led or type-led, density, any quoted copy, any brand color you named.</li>
      <li><b>Grid.</b> Each format gets a modular grid from the kit's rules. Cells are multiples of the pixel unit. Platform-reserved zones (story UI) are excluded from usable rows.</li>
      <li><b>Moves.</b> A seeded random generator picks a composition family (type-led, split, full-bleed, framed image, mosaic, color blocks, editorial, stat), a column span, an anchor, a type step, an approved color pair, a crop, a shape.</li>
      <li><b>Checks.</b> Text is measured and must fit its cells. Nothing textual may leave the safe area or overlap. Text on a photo needs a scrim or a panel, chosen from the image's own luminance map. Text on a color field needs WCAG contrast. Duplicates are dropped.</li>
      <li><b>Output.</b> Every survivor is an SVG plus a JSON spec, so the same layout can be edited, re-rendered in another format, or pushed to Figma later.</li>
    </ul>
    <h4>Where this sits in the landscape</h4>
    <ul>
      <li><b>Pitch, Beautiful.ai, Gamma, Tome</b> generate decks by choosing from smart templates and reflowing content. Strong inside their editors, closed to your own grid and rules.</li>
      <li><b>Canva Magic Design, Adobe Express, Microsoft Designer</b> return 8 to 12 template-based options from a prompt and a brand kit. Wide reach, template-shaped output.</li>
      <li><b>Figma Make, Framer, Relume</b> generate UI and web layouts from prompts using real components. Product surfaces, not brand comms.</li>
      <li><b>Research</b> (LayoutPrompter, PosterLlama, COLE, CreatiPoster, LayoutGPT) treats layout as structured generation: an LLM emits boxes in JSON or HTML under content-aware constraints. This prototype follows that idea with explicit rules instead of a trained model, so it runs anywhere and is auditable.</li>
    </ul>
    <h4>What it is not yet</h4>
    <p>Visual generation only. Editing, Figma export, and per-design-system connectors come next. The layout JSON is written so those can be added without changing the engine.</p>`;

  // ---- Init --------------------------------------------------------------------------------------
  async function init() {
    fillPresets(); fillFontSelects();
    const savedKit = LS.get('lg.kit', null); const savedPreset = LS.get('lg.preset', 'deel');
    if (savedKit && savedKit.colors && savedKit.fonts) { loadKit(savedKit); $('presetSelect').value = savedKit.presetId && Brand.PRESETS[savedKit.presetId] ? savedKit.presetId : '__custom'; }
    else { loadKit(Brand.fromPreset(savedPreset in Brand.PRESETS ? savedPreset : 'deel')); $('presetSelect').value = state.kit.presetId; }
    renderChips();
    $('apiKey').value = LS.get('lg.apiKey', ''); $('useClaude').checked = !!LS.get('lg.useClaude', false);
    $('prompt').value = LS.get('lg.prompt', '');
    $('promptForm').addEventListener('submit', e => { e.preventDefault(); generate($('prompt').value); });
    await ensureDemoImages(false);
    // First frame: a working state, not an empty shell.
    if (!$('prompt').value) $('prompt').value = 'Launch posts for Deel Global Payroll, bold, image-led, square and story';
    await generate($('prompt').value);
  }
  init();
})();
