/* UI wiring. State lives here; the engine and renderer are pure. */
(() => {
  const $ = id => document.getElementById(id);
  const state = {
    kit: null, assets: { images: [] }, layouts: [], favs: new Set(), picks: new Set(),
    formats: ['square'], showGrid: false, lastPrompt: null, intent: Prompt.DEFAULT(), seedBase: 1, detail: null, busy: false,
    mode: 'single', outline: null, outlineEdited: false, deck: null, deckFormat: 'slide', copyVariant: 0, copyDraft: null,
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
  function registerKitFonts(kit) {
    for (const name of [kit.fonts?.display, kit.fonts?.body]) {
      if (name && !Brand.FONTS[name] && !Brand.customFonts[name]) Brand.customFonts[name] = { css: `"${name}", system-ui, sans-serif`, weights: [300, 400, 500, 600, 700, 800, 900], system: true };
    }
  }
  function loadKit(kit) {
    registerKitFonts(kit); fillFontSelects();
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

  // ---- Copy from the brief -----------------------------------------------------------------------------
  // The prompt bar names the subject and the kind of message; Copy.draft turns that into the Content panel.
  // Typing in a content field locks the copy so a later Generate does not overwrite hand edits.
  const COPY_FIELDS = ['eyebrow', 'headline', 'subhead', 'body', 'cta', 'stat'];
  function setCopyHint(text, locked) { const h = $('copyHint'); h.textContent = text; h.classList.toggle('locked', !!locked); }
  function applyBriefCopy(text, intent) {
    if (!$('copyFromBrief').checked) return null;
    const d = Copy.draft(text, state.kit, { intent, variant: state.copyVariant });
    state.copyDraft = d;
    if (!d) { setCopyHint(String(text || '').trim() ? 'The brief names no new subject, so the current copy stays.' : 'The brief names the subject; the copy follows it.'); return null; }
    for (const k of COPY_FIELDS) $(k).value = d.content[k] || '';
    setCopyHint(`From brief: ${d.summary} · phrasing ${d.variant + 1}/${d.variants}`);
    return d;
  }
  function redraftCopy() {
    const text = $('prompt').value;
    const d = applyBriefCopy(text, Prompt.parse(text, state.kit));
    if (!d) { toast('The brief names no subject to write about'); return; }
    readKit();
    if (state.mode !== 'canvas') generate(text);
  }
  for (const id of COPY_FIELDS) $(id).addEventListener('input', () => {
    if (!$('copyFromBrief').checked) return;
    $('copyFromBrief').checked = false; LS.set('lg.copyFromBrief', false);
    setCopyHint('Locked to your edits. Tick From brief to let the prompt write the copy again.', true);
  });
  $('copyFromBrief').addEventListener('change', () => {
    LS.set('lg.copyFromBrief', $('copyFromBrief').checked);
    if ($('copyFromBrief').checked) redraftCopy(); else setCopyHint('Locked: the copy below stays as it is.', true);
  });
  $('copyRewrite').addEventListener('click', () => {
    state.copyVariant = (state.copyVariant + 1) % 4; LS.set('lg.copyVariant', state.copyVariant);
    if (!$('copyFromBrief').checked) { $('copyFromBrief').checked = true; LS.set('lg.copyFromBrief', true); }
    redraftCopy();
  });

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
    state.outline = null; state.outlineEdited = false; if (state.mode === 'deck') { state.outline = Deck.outlineFromBrief($('prompt').value, state.kit); renderOutline(); }
  });

  // ---- Images -------------------------------------------------------------------------
  const readAsDataURL = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
  const loadImage = src => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('image failed to decode')); im.src = src; });
  function dataUrlToBlob(dataUrl) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl); if (!m) throw new Error('not a data URL');
    const mime = m[1] || 'application/octet-stream';
    if (!m[2]) return new Blob([decodeURIComponent(m[3])], { type: mime });
    const bin = atob(m[3]); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  async function addImage(dataUrl, name, placeholder = false, forcedId = null) {
    const im = await loadImage(dataUrl);
    const blob = dataUrlToBlob(dataUrl);
    const asset = { id: forcedId || 'img' + (imgSeq++), name, url: URL.createObjectURL(blob), dataUrl, w: im.naturalWidth, h: im.naturalHeight, lum: Color.luminanceMap(im), placeholder, palette: Color.extractPalette(im) };
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
    for (let i = 0; i < 3; i++) {
      try { await addImage(Brand.makeDemoImage(1000 + i * 7 + RNG.hashStr(state.kit.name), pal, 1200, i === 1 ? 800 : 1200), 'placeholder ' + (i + 1), true); }
      catch (err) { console.warn('placeholder image skipped', err); }
    }
  }

  // ---- Formats chips --------------------------------------------------------------------
  function renderChips() {
    $('formatChips').innerHTML = Grid.FORMATS.map(f => `<button type="button" class="chip-btn ${state.formats.includes(f.id) ? 'on' : ''}" data-f="${f.id}">${f.name}<span class="ratio">${f.ratio}</span></button>`).join('');
  }
  $('formatChips').addEventListener('click', e => {
    const b = e.target.closest('[data-f]'); if (!b) return;
    const id = b.dataset.f;
    if (state.mode === 'deck') { state.formats = [id]; state.deckFormat = id; renderChips(); return; }
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
    if (state.mode === 'deck' && !opts.intent) return generateDeck(text);
    state.busy = true; $('generateBtn').disabled = true; $('generateBtn').textContent = 'Reading brief…';
    try {
      let intent = opts.intent;
      if (!intent) {
        intent = await resolveIntent(text);
        applyBriefCopy(text, intent);
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
      const kit = readKit();
      await ensureDemoImages(false);
      await loadFonts(kit);
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
    } catch (err) {
      console.error(err);
      $('readout').innerHTML = `<span style="color:var(--danger)">Generation failed: ${escapeHtml(err && err.message ? err.message : String(err))}. Reload the page and try again; if it repeats, copy this message to Claude.</span>`;
      toast('Generation failed: ' + (err && err.message ? err.message : err));
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
    $('exportFavPptxBtn').disabled = !state.favs.size;
    $('toCanvasBtn').disabled = !(state.picks.size || state.favs.size);
    $('toCanvasBtn').textContent = state.picks.size ? `Send to canvas (${state.picks.size})` : state.favs.size ? `Send favorites to canvas (${state.favs.size})` : 'Send to canvas';
    updateCanvasBadge();
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
  function findLayout(id) { return state.layouts.find(l => l.id === id) || state.family?.find(l => l.id === id) || state.deck?.slides.flatMap(s => s.variations).find(l => l.id === id); }
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
      ['Copy capacity', l.blocks.filter(b => b.kind === 'text' && b.capacity).map(b => `${b.role} ${b.capacity.currentChars}/${b.capacity.maxChars} chars · ${b.lines.length}/${b.capacity.maxLines} lines`).join(' · ') || '—'],
      ['Moves', meta || '—'],
      ['Metrics', `whitespace ${Math.round(l.metrics.whitespace * 100)}% · density ${Math.round(l.metrics.density * 100)}% · balance ${Math.round(l.metrics.balance * 100)}%`],
    ];
    $('detailSpecs').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join('');
    $('detailJsonView').textContent = JSON.stringify(stripForJson(l), null, 1);
    $('familyStrip').innerHTML = '';
    $('detailFill').disabled = !($('apiKey').value.trim());
    $('detailFill').title = $('apiKey').value.trim() ? 'Ask Claude for copy that fits this exact layout' : 'Add an Anthropic API key in Settings to use this';
  }
  function stripForJson(l) {
    const c = JSON.parse(JSON.stringify(l)); delete c.signature; delete c.rejected;
    for (const b of c.blocks) { delete b.gap; delete b.maxLines; delete b.minSize; if (b.kind === 'text') { b.font = { family: b.font.family, size: b.font.size, weight: b.font.weight, lineHeight: b.font.lineHeight, letterSpacing: b.font.letterSpacing }; } }
    return c;
  }
  $('detailClose').addEventListener('click', () => { $('detail').hidden = true; state.detail = null; });
  $('detailSchema').addEventListener('click', async e => { const l = state.detail; if (!l) return; await copyText(JSON.stringify(Engine.contentSchema(l), null, 2)); toast('Content schema copied'); });
  $('detailFill').addEventListener('click', e => withBusy(e.target, async () => {
    const l = state.detail; if (!l) return;
    const key = $('apiKey').value.trim(); if (!key) { toast('Add an API key in Settings first'); return; }
    const schema = Engine.contentSchema(l);
    const current = {}; for (const b of l.blocks) if (!b.decorative && b.path && b.kind !== 'image') current[b.path] = b.kind === 'list' ? b.items : (b.lines ? b.lines.join(' ') : b.text);
    const content = await Prompt.fillContent({ brief: $('prompt').value, kit: state.kit, schema, current, apiKey: key, slideIntent: l.slideIntent });
    const next = Engine.hydrate(l, content, { intent: state.intent, kit: state.kit, assets: state.assets });
    if (!next) { toast('Claude wrote copy that does not fit this layout. Try again or pick a roomier variation.'); return; }
    next.id = next.id + '-c';
    if (state.mode === 'deck' && l.deckIndex != null && state.deck) { const row = state.deck.slides[l.deckIndex]; next.deckIndex = l.deckIndex; row.variations.unshift(next); row.pick = 0; renderDeck(); }
    else { state.layouts.unshift(next); renderGallery(); }
    state.detail = next; renderDetail(); toast('Copy refitted into the same layout');
  }));
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
  $('detailPptx').addEventListener('click', e => withBusy(e.target, async () => { const l = state.detail; const blob = await ExportPptx.buildDeck([l], { kit: state.kit, assets: state.assets }); if (await Render.download(blob, `${slug(state.kit.name)}-${l.id}.pptx`)) toast('PowerPoint saved: text, images, and fields stay editable'); }));
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
  $('exportFavPptxBtn').addEventListener('click', e => withBusy(e.target, async () => {
    const list = state.layouts.filter(l => state.favs.has(l.id));
    const decks = await ExportPptx.buildDecks(list, { kit: state.kit, assets: state.assets });
    let n = 0;
    for (const d of decks) { if (!(await Render.download(d.blob, `${slug(state.kit.name)}-${d.formatId}-${d.count}-slides.pptx`))) break; n++; await new Promise(r => setTimeout(r, 350)); }
    if (n) toast(`${n} deck${n > 1 ? 's' : ''} saved (one per format)`);
  }));
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
  $('settingsClose').addEventListener('click', () => { LS.set('lg.apiKey', $('apiKey').value); LS.set('lg.useClaude', $('useClaude').checked); saveImageGen(); $('settings').hidden = true; });
  // Image generation settings: provider → models, key per provider.
  $('imgProvider').innerHTML += Object.values(ImageGen.PROVIDERS).map(p => `<option value="${p.id}">${p.name}</option>`).join('');
  function fillImageModels(provider, model) { const P = ImageGen.PROVIDERS[provider]; $('imgModel').innerHTML = P ? P.models.map(m => `<option value="${m[0]}" ${m[0] === model ? 'selected' : ''}>${m[1]}</option>`).join('') : '<option value="">—</option>'; $('imgModel').disabled = !P; $('imgKey').disabled = !P; $('imgKey').placeholder = P ? P.keyHint : 'Pick a provider first'; $('imgHint').innerHTML = P ? `Keys: <a href="${P.keyUrl}" target="_blank" rel="noopener">${P.keyUrl.replace(/^https?:\/\//, '')}</a>. Runs locally or from your own host only; published copies block outbound requests.` : 'Off. Pick Google Gemini or OpenAI to enable Generate image on canvas image blocks.'; }
  function loadImageGen() { const s = ImageGen.settings.get(); $('imgProvider').value = s.provider || ''; fillImageModels(s.provider, s.model); $('imgKey').value = s.apiKey || ''; }
  function saveImageGen() { ImageGen.settings.set({ provider: $('imgProvider').value, model: $('imgModel').value, apiKey: $('imgKey').value.trim() }); }
  $('imgProvider').addEventListener('change', () => { fillImageModels($('imgProvider').value, ''); saveImageGen(); });
  $('imgModel').addEventListener('change', saveImageGen); $('imgKey').addEventListener('change', saveImageGen);
  loadImageGen();
  document.addEventListener('keydown', e => { if (e.key === 'Escape') for (const id of ['detail', 'compare', 'about', 'settings', 'importModal']) $(id).hidden = true; });
  for (const id of ['detail', 'compare', 'about', 'settings']) $(id).addEventListener('click', e => { if (e.target === $(id)) $(id).hidden = true; });
  $('aboutBody').innerHTML = `
    <p>Most AI design tools pick a template or paint pixels. This engine does neither. It takes the rules a design system already has (a column grid, a pixel grid, safe space, approved color pairs, the logo's clear zone, a type scale) and lets chance move only inside them. The result is not one answer but a field of valid answers you can scan, compare, and choose from. The design decision stays with the designer; the engine removes the blank canvas and the manual iteration.</p>
    <h4>How a variation is made</h4>
    <ul>
      <li><b>Brief → constraints.</b> The prompt becomes a small JSON intent: formats, count, loudness, light or dark, image-led or type-led, density, any quoted copy, any brand color you named.</li>
      <li><b>Grid.</b> Each format gets a modular grid from the kit's rules. Cells are multiples of the pixel unit. Platform-reserved zones (story UI) are excluded from usable rows.</li>
      <li><b>Moves.</b> A seeded random generator picks a composition family (type-led, split, full-bleed, framed image, mosaic, color blocks, editorial, stat), a column span, an anchor, a type step, an approved color pair, a crop, a shape.</li>
      <li><b>Checks.</b> Text is measured and must fit its cells. Nothing textual may leave the safe area or overlap. Text on a photo needs a scrim or a panel, chosen from the image's own luminance map. Text on a color field needs WCAG contrast. Duplicates are dropped.</li>
      <li><b>Output.</b> Every survivor is an SVG plus a JSON spec in which every block is a box on the grid and every text block carries its copy capacity. The same spec exports as PNG, SVG, or an editable PowerPoint slide, and can be re-rendered in another format or pushed to Figma later.</li>
    </ul>
    <h4>Where this sits in the landscape</h4>
    <ul>
      <li><b>Pitch, Beautiful.ai, Gamma, Tome</b> generate decks by choosing from smart templates and reflowing content. Strong inside their editors, closed to your own grid and rules.</li>
      <li><b>Canva Magic Design, Adobe Express, Microsoft Designer</b> return 8 to 12 template-based options from a prompt and a brand kit. Wide reach, template-shaped output.</li>
      <li><b>Figma Make, Framer, Relume</b> generate UI and web layouts from prompts using real components. Product surfaces, not brand comms.</li>
      <li><b>Research</b> (LayoutPrompter, PosterLlama, COLE, CreatiPoster, LayoutGPT) treats layout as structured generation: an LLM emits boxes in JSON or HTML under content-aware constraints. This prototype follows that idea with explicit rules instead of a trained model, so it runs anywhere and is auditable.</li>
    </ul>
    <h4>Decks</h4>
    <p>Deck mode turns the brief into an outline with one intent per slide (cover, agenda, statement, big number, comparison, process, cards, quote, closing), generates variations for every slide under one palette and type step, and exports your picks as an editable PowerPoint. Every editable block carries its copy capacity, so a layout can be handed to Claude as a schema and the copy refitted without moving anything.</p>
    <h4>Canvas</h4>
    <p>Send picks to the canvas to edit them: layers, properties, flex auto layout with gap and padding, align and distribute, typography, fills, and the frame's JSON beside it. Export a frame as PNG, SVG, or HTML/CSS, frames as an editable PPTX, or the whole canvas as one image. Copy link carries the canvas in the URL.</p>
    <h4>What it is not yet</h4>
    <p>Hosted links with assets, charts and tables, Figma export, and per-design-system connectors come next. The layout JSON is written so those can be added without changing the engine.</p>`;

  // ---- Deck mode -----------------------------------------------------------------------------------
  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
    const canvas = mode === 'canvas';
    document.body.classList.toggle('canvas-mode', canvas);
    $('canvasView').hidden = !canvas;
    $('promptForm').querySelector('#prompt').disabled = canvas; $('generateBtn').disabled = canvas;
    if (canvas) { CanvasUI.open(); $('outlinePanel').hidden = true; $('deckBar').hidden = true; $('deckView').hidden = true; $('gallery').hidden = true; $('empty').hidden = true; LS.set('lg.mode', mode); return; }
    CanvasUI.close();
    const deck = mode === 'deck';
    $('outlinePanel').hidden = !deck; $('deckBar').hidden = !deck; $('deckView').hidden = !deck;
    $('gallery').hidden = deck; $('empty').hidden = deck || state.layouts.length > 0;
    for (const id of ['count', 'sort', 'filterArch', 'favOnly', 'compareBtn', 'exportFavBtn', 'exportFavPptxBtn', 'toCanvasBtn']) $(id).closest('label, button').hidden = deck;
    $('prompt').placeholder = deck ? 'Describe the deck, e.g. "8-slide launch deck for Deel Global Payroll: cover, why now, what you get, how it works, proof, before and after, customer quote, next steps"' : 'Describe what you need, e.g. "36 bold image-led square posts for Deel Payroll, dark, with a CTA"';
    if (deck) { state.formats = [state.deckFormat]; renderChips(); if (!state.outline) { state.outline = Deck.outlineFromBrief($('prompt').value, state.kit); renderOutline(); } }
    LS.set('lg.mode', mode);
  }
  $('modeSeg').addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); });

  // Outline editor --------------------------------------------------------------------------------------
  const DETAIL_HINT = { cards: 'Title — text, one per line', process: 'Step title — text, one per line', agenda: 'One entry per line', comparison: 'Left title\nbullet\nbullet\n---\nRight title\nbullet\nbullet', quote: 'Quote\nAttribution', stat: 'Stat (e.g. 150+)\nSubhead', cover: 'Subhead', statement: 'Subhead', body: 'Body copy', closing: 'Subhead\nCTA label' };
  function detailsText(sl) {
    const i = sl.intent;
    if (i === 'cards' || i === 'process') return Engine.normItems(i === 'cards' ? sl.items : (sl.steps && sl.steps.length ? sl.steps : sl.items)).map(x => x.text ? `${x.title} — ${x.text}` : x.title).join('\n');
    if (i === 'agenda') return (sl.items && sl.items.length ? Engine.normItems(sl.items).map(x => x.title) : (sl.bullets || [])).join('\n');
    if (i === 'comparison') return (sl.columns || []).map(c => [c.title, ...(c.bullets || [])].join('\n')).join('\n---\n');
    if (i === 'quote') return [sl.quote || '', sl.attribution || ''].join('\n');
    if (i === 'stat') return [sl.stat || '', sl.subhead || ''].join('\n');
    if (i === 'closing') return [sl.subhead || '', sl.cta || ''].join('\n');
    if (i === 'body') return sl.body || '';
    return sl.subhead || '';
  }
  function parseDetails(sl, text) {
    const i = sl.intent; const lines = String(text || '').split('\n').map(x => x.trim()).filter(Boolean);
    const pair = l => { const m = l.split(/\s[—–-]\s|:\s/); return { title: m[0].trim(), text: m.slice(1).join(' ').trim() }; };
    delete sl.items; delete sl.steps; delete sl.columns; delete sl.bullets;
    if (i === 'cards') sl.items = lines.map(pair);
    else if (i === 'process') sl.steps = lines.map(pair);
    else if (i === 'agenda') sl.items = lines.map(l => ({ title: l, text: '' }));
    else if (i === 'comparison') { sl.columns = text.split(/\n-{3,}\n?/).map(block => { const ls = block.split('\n').map(x => x.trim()).filter(Boolean); return { title: ls[0] || '', bullets: ls.slice(1) }; }).filter(c => c.title); }
    else if (i === 'quote') { sl.quote = lines[0] || ''; sl.attribution = lines[1] || ''; }
    else if (i === 'stat') { sl.stat = lines[0] || ''; sl.subhead = lines.slice(1).join(' '); }
    else if (i === 'closing') { sl.subhead = lines[0] || ''; sl.cta = lines[1] || sl.cta || state.kit.content.cta; }
    else if (i === 'body') sl.body = lines.join(' ');
    else sl.subhead = lines.join(' ');
  }
  function renderOutline() {
    const o = state.outline; if (!o) return;
    $('outlineSource').textContent = `${o.slides.length} slides · ${o.source === 'claude' ? 'written by Claude' : state.outlineEdited ? 'edited' : 'from brief'}`;
    $('outlineList').innerHTML = o.slides.map((sl, i) => `<div class="outline-row" data-i="${i}">
      <div class="num">${String(i + 1).padStart(2, '0')}</div>
      <div class="fields">
        <select class="select" data-k="intent" id="ol-intent-${i}" aria-label="Slide intent">${Engine.SLIDE_INTENTS.map(k => `<option value="${k}" ${k === sl.intent ? 'selected' : ''}>${Deck.INTENT_LABEL[k]}</option>`).join('')}</select>
        <input class="input" data-k="headline" id="ol-headline-${i}" type="text" placeholder="${sl.intent === 'quote' ? 'Headline (optional)' : 'Headline'}" value="${escapeHtml(sl.headline || '')}">
        <textarea class="input" data-k="details" id="ol-details-${i}" rows="3" placeholder="${escapeHtml(DETAIL_HINT[sl.intent] || '')}">${escapeHtml(detailsText(sl))}</textarea>
      </div>
      <div class="ops"><button class="btn small" data-op="up" title="Move up" type="button">↑</button><button class="btn small" data-op="down" title="Move down" type="button">↓</button><button class="btn small" data-op="rm" title="Remove" type="button">✕</button></div>
    </div>`).join('');
  }
  $('outlineList').addEventListener('change', e => {
    const row = e.target.closest('.outline-row'); if (!row) return;
    const i = +row.dataset.i; const sl = state.outline.slides[i]; const k = e.target.dataset.k;
    if (k === 'intent') { const title = sl.headline; const fresh = Deck.slideFromTitle(state.kit, '', e.target.value); Object.assign(sl, fresh, { headline: title || fresh.headline, intent: e.target.value }); }
    else if (k === 'headline') sl.headline = e.target.value.trim();
    else if (k === 'details') parseDetails(sl, e.target.value);
    state.outlineEdited = true; renderOutline();
  });
  $('outlineList').addEventListener('click', e => {
    const b = e.target.closest('[data-op]'); if (!b) return;
    const i = +b.closest('.outline-row').dataset.i; const sl = state.outline.slides;
    if (b.dataset.op === 'rm') sl.splice(i, 1);
    else if (b.dataset.op === 'up' && i > 0) [sl[i - 1], sl[i]] = [sl[i], sl[i - 1]];
    else if (b.dataset.op === 'down' && i < sl.length - 1) [sl[i + 1], sl[i]] = [sl[i], sl[i + 1]];
    sl.forEach((x, j) => x.section = String(j + 1).padStart(2, '0'));
    state.outlineEdited = true; renderOutline();
  });
  $('outlineAdd').addEventListener('click', () => { const sl = state.outline.slides; sl.splice(Math.max(0, sl.length - 1), 0, Deck.slideFromTitle(state.kit, '', 'cards')); sl.forEach((x, j) => x.section = String(j + 1).padStart(2, '0')); state.outlineEdited = true; renderOutline(); });
  $('outlineReset').addEventListener('click', async () => { state.outlineEdited = false; state.outline = await resolveOutline($('prompt').value, true); renderOutline(); toast('Outline rebuilt'); });

  async function resolveOutline(text, force) {
    if (state.outline && state.outlineEdited && !force) return state.outline;
    const useClaude = $('useClaude').checked && $('apiKey').value.trim();
    if (useClaude) {
      try { const o = await Deck.outlineWithClaude(text, state.kit, $('apiKey').value.trim()); $('interpretLog').textContent = 'Claude outline: ' + (o.summary || ''); return o; }
      catch (err) { $('interpretLog').textContent = 'Claude outline failed, used rules. ' + err.message; toast('Claude outline failed, used rules'); }
    }
    const d = Copy.draft(text, state.kit, { intent: state.intent, variant: state.copyVariant });
    return Deck.outlineFromBrief(text, state.kit, { subject: d ? d.subject : null });
  }

  async function generateDeck(text) {
    state.busy = true; $('generateBtn').disabled = true; $('generateBtn').textContent = 'Reading brief…';
    try {
      const promptChanged = text !== state.lastPrompt;
      const base = await resolveIntent(text);
      applyBriefCopy(text, base);
      const kit = readKit();
      await ensureDemoImages(false); await loadFonts(kit);
      if (promptChanged) { state.outlineEdited = false; state.lastPrompt = text; }
      state.intent = base;
      state.outline = await resolveOutline(text, promptChanged && !state.outlineEdited);
      renderOutline();
      LS.set('lg.prompt', text);
      const format = Grid.byId[state.deckFormat] || Grid.byId.slide;
      const seedBase = (state.seedBase = (state.seedBase * 1664525 + 1013904223) >>> 0);
      const t0 = performance.now();
      state.deck = await Deck.generate({ outline: state.outline, kit, assets: state.assets, format, baseIntent: base, perSlide: +$('perSlide').value, seedBase, onProgress: (i, n) => { $('generateBtn').textContent = `Slide ${i}/${n}…`; } });
      const ms = Math.round(performance.now() - t0);
      const made = state.deck.slides.reduce((s, x) => s + x.variations.length, 0);
      $('readout').innerHTML = [
        `<span><span class="k">deck</span> <b>${escapeHtml(state.outline.title)}</b> · ${state.deck.slides.length} slides · ${format.name}</span>`,
        `<span><span class="k">outline by</span> <b>${state.outline.source === 'claude' ? 'Claude' : 'rules'}</b> · <span class="k">brief read by</span> <b>${base.source === 'claude' ? 'Claude' : 'rules'}</b></span>`,
        `<span><span class="k">palette</span> <b>${state.deck.palette ? state.deck.palette.bgName : '—'}</b> · <span class="k">type step</span> <b>${state.deck.level + 1}/6</b></span>`,
        `<span><span class="k">variations</span> <b>${made}</b> <span class="k">in ${ms} ms</span></span>`,
      ].join('');
      renderDeck();
    } catch (err) {
      console.error(err);
      $('readout').innerHTML = `<span style="color:var(--danger)">Deck generation failed: ${escapeHtml(err && err.message ? err.message : String(err))}. Reload the page and try again; if it repeats, copy this message to Claude.</span>`;
      toast('Deck generation failed: ' + (err && err.message ? err.message : err));
    } finally { state.busy = false; $('generateBtn').disabled = false; $('generateBtn').textContent = 'Generate'; }
  }
  function renderDeck() {
    const d = state.deck; if (!d) return;
    const tall = d.format.h > d.format.w;
    $('deckView').innerHTML = d.slides.map(s => `<div class="deck-row" data-i="${s.index}">
      <div class="head"><span class="n">${String(s.index + 1).padStart(2, '0')}</span><span class="intent">${Deck.INTENT_LABEL[s.outline.intent] || s.outline.intent}</span><span class="title">${escapeHtml(s.outline.headline || s.outline.quote || '')}</span><button class="btn small" data-shuffle="${s.index}" type="button">Shuffle</button></div>
      <div class="strip">${s.variations.length ? s.variations.map((l, j) => `<div class="deck-card ${tall ? 'tall' : ''} ${j === s.pick ? 'pick' : ''}" data-id="${l.id}" data-j="${j}">${Render.toSVG(l, { kit: state.kit, assets: state.assets, showGrid: state.showGrid, width: 440 })}<div class="lbl"><span>${l.archetypeLabel}</span><span>${Math.round(l.metrics.whitespace * 100)}% air</span></div><button class="open" data-open="${l.id}" type="button">Open</button></div>`).join('') : `<div class="empty-row">Nothing fit this slide's content. Shorten the copy in the outline or change its intent.</div>`}</div>
    </div>`).join('');
    const ok = d.slides.some(s => s.pick >= 0);
    $('deckPptxBtn').disabled = !ok; $('deckPngBtn').disabled = !ok; $('deckCanvasBtn').disabled = !ok;
  }
  $('deckView').addEventListener('click', async e => {
    const open = e.target.closest('[data-open]'); if (open) { openDetail(open.dataset.open); return; }
    const sh = e.target.closest('[data-shuffle]');
    if (sh) { const i = +sh.dataset.shuffle; sh.disabled = true; sh.textContent = '…'; try { await Deck.reshuffle(state.deck, i, { outline: state.outline, kit: state.kit, assets: state.assets, format: state.deck.format, baseIntent: { ...state.intent, lockPalette: state.deck.palette, level: state.deck.level }, perSlide: +$('perSlide').value }); } finally { renderDeck(); } return; }
    const card = e.target.closest('.deck-card'); if (!card) return;
    const row = card.closest('.deck-row'); const i = +row.dataset.i; state.deck.slides[i].pick = +card.dataset.j;
    row.querySelectorAll('.deck-card').forEach(c => c.classList.toggle('pick', c === card));
  });
  $('deckView').addEventListener('dblclick', e => { const card = e.target.closest('.deck-card'); if (card) openDetail(card.dataset.id); });
  $('deckShuffleAll').addEventListener('click', () => generateDeck($('prompt').value));
  $('deckPptxBtn').addEventListener('click', e => withBusy(e.target, async () => {
    const picks = Deck.picks(state.deck); if (!picks.length) return;
    const blob = await ExportPptx.buildDeck(picks, { kit: state.kit, assets: state.assets });
    if (await Render.download(blob, `${slug(state.outline.title || state.kit.name)}-deck-${picks.length}-slides.pptx`)) toast(`Deck saved: ${picks.length} editable slides`);
  }));
  $('deckPngBtn').addEventListener('click', e => withBusy(e.target, async () => {
    const picks = Deck.picks(state.deck); let n = 0;
    for (const l of picks) { const blob = await Render.exportPNG(l, { kit: state.kit, assets: state.assets }); if (!(await Render.download(blob, `${slug(state.outline.title || state.kit.name)}-${String(n + 1).padStart(2, '0')}.png`))) break; n++; await new Promise(r => setTimeout(r, 350)); }
    if (n) toast(`${n} slide PNG${n > 1 ? 's' : ''} saved`);
  }));

  // ---- Canvas integration ---------------------------------------------------------------------------
  function updateCanvasBadge() { const n = CanvasUI.count(); const b = $('canvasBadge'); b.hidden = !n; b.textContent = n; }
  // Variations of a canvas frame. Generated layouts re-run the engine with the frame's own copy; anything else
  // (imported, hand-built) gets palette swaps from the brand's approved pairs.
  const isEngineLayout = L => !!(L && L.archetype && L.archetype !== 'blank' && Engine.ARCH_LABEL[L.archetype] && Grid.byId[L.format.id] && Grid.byId[L.format.id].w === L.format.w && Grid.byId[L.format.id].h === L.format.h);
  function makeVariations({ frame, count, mode }) {
    const L = frame.layout; const kit = state.kit; const out = [];
    let seed = (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0;
    if (mode === 'palette' || !isEngineLayout(L)) {
      const cur = Color.normalize(L.palette.bg);
      const pairs = RNG.make(seed).shuffle(Brand.pairs(kit).filter(p => p.bg !== cur));
      for (const p of pairs.slice(0, count)) { const tmp = { layout: Canvas.clone(L) }; Canvas.recolor(tmp, { bg: p.bg, fg: p.fgs[0], accent: p.accents[0], bgName: p.bgName }); tmp.layout.palette.bgToken = p.bgName; tmp.layout.id = (L.id || 'v') + '-' + p.bgName.replace(/\W+/g, ''); out.push(tmp.layout); }
      return out;
    }
    const intent = { ...state.intent, content: Canvas.extractContent(L), slideIntent: L.slideIntent || undefined, formats: [L.format.id] };
    if (mode === 'similar') intent.level = L.type && L.type.level;
    const fmt = Grid.byId[L.format.id]; const seen = new Set([L.signature]); const used = new Map();
    for (let tries = 0; out.length < count && tries < count * 30; tries++) {
      seed = (seed + 0x9E3779B9) >>> 0;
      const V = Engine.generate({ intent, kit, assets: state.assets, format: fmt, seed, archetype: mode === 'similar' ? L.archetype : undefined });
      if (!V || seen.has(V.signature)) continue;
      if (mode === 'explore' && tries < count * 15 && (V.archetype === L.archetype || (used.get(V.archetype) || 0) >= 1)) continue;
      seen.add(V.signature); used.set(V.archetype, (used.get(V.archetype) || 0) + 1); out.push(V);
    }
    return out;
  }
  // The same layout idea in another format: same archetype, copy, palette and type step.
  function relayout(frame, fmt) {
    const L = frame.layout; if (!isEngineLayout(L)) return null;
    const intent = { ...state.intent, content: Canvas.extractContent(L), lockPalette: L.palette, level: L.type && L.type.level, slideIntent: L.slideIntent || undefined };
    for (let k = 0; k < 10; k++) { const V = Engine.generate({ intent, kit: state.kit, assets: state.assets, format: fmt, seed: (L.seed + k * 0x9E3779B9) >>> 0, archetype: L.archetype }); if (V) return V; }
    return null;
  }
  // ---- Import: Figma files and clipboard, canvas JSON ---------------------------------------------------------------
  const loadedFamilies = new Set();
  // Load families the import uses that we don't ship, from Google Fonts when they exist there; then refit their text.
  async function ensureFonts(frames) {
    const fams = new Map();
    for (const f of frames) for (const b of f.layout.blocks) if (b.font && b.font.family) { const name = String(b.font.family).split(',')[0].replace(/["']/g, '').trim(); if (!Brand.FONTS[name] && !Brand.customFonts[name] && !/^(inter|system-ui|sans-serif|serif|monospace)$/i.test(name)) { if (!fams.has(name)) fams.set(name, new Set()); fams.get(name).add(b.font.weight || 400); } }
    const loads = [];
    for (const [name, weights] of fams) {
      if (!loadedFamilies.has(name)) { loadedFamilies.add(name); const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g, '+')}:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;1,400&display=swap`; document.head.appendChild(l); }
      for (const w of weights) loads.push(document.fonts.load(`${w} 24px "${name}"`).catch(() => null));
    }
    if (!loads.length) return 0;
    await Promise.race([Promise.all(loads), new Promise(r => setTimeout(r, 3500))]);
    Text.clearCache();
    for (const f of frames) for (const b of f.layout.blocks) if (b.kind === 'text' || b.kind === 'list') Canvas.refit(b);
    return fams.size;
  }
  async function importFigmaData(data, how) {
    const res = await FigmaImport.convert(data, { addImage: (url, name) => addImage(url, name) });
    const items = FigmaImport.toLayouts(res.frames, state.kit);
    if (!items.length) { toast('Nothing visible to import'); return; }
    const MAX = 80; const list = items.slice(0, MAX);
    const sel = CanvasUI.selection();
    let added = [];
    if (list.length === 1 && list[0].loose && sel.frameIds.length === 1) CanvasUI.insertBlocks(sel.frameIds[0], list[0].layout.blocks);
    else added = CanvasUI.placeFrames(list);
    if (state.mode !== 'canvas') setMode('canvas');
    updateCanvasBadge();
    const s = res.stats; const skipped = Object.entries(s.skipped).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ');
    toast(`${how}: ${list.length > 1 || !list[0].loose ? `${list.length} frame${list.length > 1 ? 's' : ''}` : 'layers'}, ${s.blocks} layers${s.images ? `, ${s.images} images` : ''}${s.missingImages ? `, ${s.missingImages} images not included` : ''}${items.length > MAX ? `, first ${MAX} frames only` : ''}${skipped ? ` · skipped ${skipped}` : ''}`);
    const frames = added.length ? added : CanvasUI.doc.frames.filter(f => sel.frameIds.includes(f.id));
    if (await ensureFonts(frames)) CanvasUI.mutate(() => { }, { history: false, frames: frames.map(f => f.id) });
  }
  async function importFile(file) {
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer()); const sig = String.fromCharCode(...head);
    if (/\.fig$/i.test(file.name) || sig === 'fig-kiwi' || (sig.startsWith('PK') && /\.fig$/i.test(file.name))) {
      toast(`Reading ${file.name}…`);
      try { await importFigmaData(await FigmaImport.readFile(file), 'Figma file'); } catch (err) { console.error(err); toast('Could not read this Figma file: ' + err.message); }
      return true;
    }
    if (/\.json$/i.test(file.name) || file.type === 'application/json') {
      const text = await file.text(); let j; try { j = JSON.parse(text); } catch { return false; }
      if (j && j.lgCapture && typeof WebImport !== 'undefined') { await WebImport.importCapture(j.lgCapture); return true; }
      if (j && Array.isArray(j.frames)) { CanvasUI.replaceDoc(Canvas.deserialize(j), { keepView: false }); CanvasUI.fit(); toast('Canvas loaded'); updateCanvasBadge(); return true; }
    }
    return false;
  }
  function onCanvasPaste(e) {
    const dt = e.clipboardData; if (!dt) return false;
    const html = dt.getData('text/html');
    if (FigmaImport.hasFigmaHTML(html)) {
      e.preventDefault(); toast('Reading Figma layers…');
      FigmaImport.readClipboardHTML(html).then(d => importFigmaData(d, 'Pasted from Figma')).catch(err => { console.error(err); toast('Could not read the Figma paste: ' + err.message); });
      return true;
    }
    if (typeof WebImport !== 'undefined' && WebImport.handlePaste(e)) return true;
    const files = [...(dt.files || [])].filter(f => /^image\//.test(f.type));
    if (files.length) { e.preventDefault(); (async () => { for (const f of files) { const a = await addImage(await readAsDataURL(f), f.name || 'pasted image'); const sel = CanvasUI.selection(); if (sel.frameIds.length === 1) { const fr = Canvas.frameById(CanvasUI.doc, sel.frameIds[0]); const s = Math.min(1, fr.layout.format.w * 0.6 / a.w, fr.layout.format.h * 0.6 / a.h); CanvasUI.insertBlocks(fr.id, [{ id: 'x', kind: 'image', x: 0, y: 0, w: Math.round(a.w * s), h: Math.round(a.h * s), asset: a.id, focal: 'xMidYMid', radius: 0, decorative: false, path: 'image_pasted' }]); } else { CanvasUI.placeFrames([{ name: f.name || 'Pasted image', x: 0, y: 0, clip: true, layout: FigmaImport.toLayouts([{ name: 'Pasted image', x: 0, y: 0, w: a.w, h: a.h, bg: '#FFFFFF', clip: true, blocks: [{ id: 'img', kind: 'image', x: 0, y: 0, w: a.w, h: a.h, asset: a.id, focal: 'xMidYMid', radius: 0, decorative: false, path: 'image_1' }] }], state.kit)[0].layout }]); } } })(); return true; }
    return false;
  }
  WebImport.init({
    getKit: () => state.kit, toast, addImage: (url, name) => addImage(url, name),
    placeFrames: items => { const out = CanvasUI.placeFrames(items); if (state.mode !== 'canvas') setMode('canvas'); updateCanvasBadge(); $('importModal').hidden = true; return out; },
    afterImport: async frames => { if (await ensureFonts(frames)) CanvasUI.mutate(() => { }, { history: false, frames: frames.map(f => f.id) }); },
  });
  function openImport() { $('importModal').hidden = false; if (typeof WebImport !== 'undefined') WebImport.renderSection($('captureSection')); }
  $('cvImport').addEventListener('click', openImport);
  $('importClose').addEventListener('click', () => { $('importModal').hidden = true; });
  $('importModal').addEventListener('click', e => { if (e.target === $('importModal')) $('importModal').hidden = true; });
  $('figFile').addEventListener('change', async e => { const f = e.target.files[0]; if (!f) return; $('figStatus').textContent = 'Reading…'; await importFile(f); $('figStatus').textContent = ''; $('importModal').hidden = true; e.target.value = ''; });
  $('canvasFile').addEventListener('change', async e => { const f = e.target.files[0]; if (!f) return; if (!(await importFile(f))) toast('Not a canvas file'); $('importModal').hidden = true; e.target.value = ''; });

  function sendToCanvas(layouts) {
    if (!layouts.length) return;
    CanvasUI.addLayouts(layouts);
    setMode('canvas'); updateCanvasBadge();
    toast(`${layouts.length} layout${layouts.length > 1 ? 's' : ''} on the canvas`);
  }
  $('toCanvasBtn').addEventListener('click', () => { const ids = state.picks.size ? state.picks : state.favs; sendToCanvas(state.layouts.filter(l => ids.has(l.id))); });
  $('deckCanvasBtn').addEventListener('click', () => { if (state.deck) sendToCanvas(Deck.picks(state.deck)); });
  $('detailCanvas').addEventListener('click', () => { if (state.detail) { const l = state.detail; $('detail').hidden = true; sendToCanvas([l]); } });
  // An image another person shared: by data URL when it could be read, else by its URL only (shows, but exports skip it).
  async function addAssetWithId(id, dataUrl, url, name) {
    if (state.assets.images.some(a => a.id === id)) return;
    if (dataUrl) { await addImage(dataUrl, name, false, id); return; }
    const im = await loadImage(url);
    state.assets.images.push({ id, name, url, dataUrl: url, w: im.naturalWidth, h: im.naturalHeight, lum: null, placeholder: false, palette: [] }); renderImages();
  }
  CanvasUI.init({
    getKit: () => state.kit, getAssets: () => state.assets, toast,
    addImage: async file => addImage(await readAsDataURL(file), file.name),
    importFile: file => importFile(file),
    onPaste: e => onCanvasPaste(e),
    openImport: () => openImport(),
    addImageData: (dataUrl, name) => addImage(dataUrl, name),
    updateColors: colors => { state.kit.colors = colors.map(c => ({ name: c.name || c.hex, hex: Color.normalize(c.hex), role: c.role || 'accent' })); renderColors(); persistKit(); },
    resetColors: () => { const preset = Brand.PRESETS[state.kit.presetId]; if (!preset) return false; state.kit.colors = preset.colors.map(c => ({ ...c })); renderColors(); persistKit(); return true; },
    openSettings: () => { $('settings').hidden = false; $('imgProvider').focus(); },
    download: (blob, name) => Render.download(blob, name),
    renderSVG: (layout, opts) => Render.toSVG(layout, { kit: state.kit, assets: state.assets, showGrid: !!(opts && opts.showGrid) }),
    exportPNG: (layout, scale) => Render.exportPNG(layout, { kit: state.kit, assets: state.assets }, scale || 1),
    exportPDF: layouts => Render.exportPDF(layouts, { kit: state.kit, assets: state.assets }),
    variations: async opts => makeVariations(opts),
    relayout: (frame, fmt) => relayout(frame, fmt),
    exportSVG: layout => Render.exportSVG(layout, { kit: state.kit, assets: state.assets }),
    shareLink: async () => { const link = Sync.roomLink(); if (!link) return false; try { await navigator.clipboard.writeText(link); } catch { } toast('Room link copied: anyone with it edits this canvas with you'); return true; },
    buildPptx: layouts => ExportPptx.buildDeck(layouts, { kit: state.kit, assets: state.assets }),
  });
  // ---- Multiplayer ------------------------------------------------------------------------------------------------
  Sync.init(CanvasUI, {
    getAssets: () => state.assets, dataUrlToBlob, addAssetWithId,
    toolList: () => (typeof AgentTools !== 'undefined' ? AgentTools.defs() : []),
    onRpc: (name, args) => (typeof AgentTools !== 'undefined' ? AgentTools.call(name, args, { via: 'mcp' }) : Promise.reject(new Error('Agent tools are not loaded'))),
  });
  const initials = n => String(n || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
  function renderPeers(st, peers) {
    const el = $('cvPeers'); const me = Sync.me;
    const live = st.mode !== 'local';
    el.hidden = !live;
    if (live) el.innerHTML = `<span class="cv-live ${st.connected ? 'on' : ''}" title="${escapeHtml(st.label)}${st.readOnly ? ' · view only' : ''}">${st.connected ? 'Live' : 'Connecting…'}${st.readOnly ? ' · view only' : ''}</span>`
      + peers.slice(0, 8).map(p => `<button type="button" class="cv-av" data-peer="${escapeHtml(p.id)}" title="${escapeHtml(p.name || 'Someone')}${p.cursor ? ' · click to go to their cursor' : ''}" style="background:${Render.col(p.color, '#7C5CFF')}">${escapeHtml(initials(p.name || 'Someone'))}</button>`).join('')
      + (peers.length > 8 ? `<span class="cv-av more">+${peers.length - 8}</span>` : '')
      + (st.mode === 'server' ? `<button type="button" class="cv-av me" data-me title="You: ${escapeHtml(me.name || 'set your name')}. Click to rename." style="background:${me.color}">${escapeHtml(initials(me.name || 'You'))}</button>` : '');
    const btn = $('cvLive'); btn.hidden = !serverHere; btn.textContent = st.mode === 'server' ? 'Copy room link' : 'Go live';
  }
  let serverHere = false;
  Sync.onStatus(renderPeers);
  $('cvPeers').addEventListener('click', e => {
    const p = e.target.closest('[data-peer]'); if (p) { const peer = Sync.peers.find(x => x.id === p.dataset.peer); if (peer && peer.cursor) CanvasUI.centerOn(peer.cursor.x, peer.cursor.y); else toast('Their cursor is not on the canvas right now'); return; }
    if (e.target.closest('[data-me]')) { const n = prompt('Your name, as others in this room see it', Sync.me.name || ''); if (n != null) Sync.setName(n); }
  });
  $('cvLive').addEventListener('click', async () => {
    if (Sync.status.mode === 'server') { const link = Sync.roomLink(); try { await navigator.clipboard.writeText(link); } catch { } toast('Room link copied'); return; }
    if (!Sync.me.name) { const n = prompt('Your name, as others in this room see it', ''); if (n) Sync.setName(n); }
    const id = Sync.joinServer(Sync.newRoomId());
    try { await navigator.clipboard.writeText(Sync.roomLink()); } catch { }
    toast(`Live room ${id} started; link copied. Anyone with it edits this canvas with you.`);
  });
  (async () => {
    if (await Sync.startArtifact()) return;
    serverHere = await Sync.serverAvailable();
    if (serverHere) { const room = Sync.roomFromUrl(); if (room) { if (!Sync.me.name) Sync.setName('Guest ' + Sync.me.id.slice(-3).toUpperCase()); Sync.joinServer(room); if (state.mode !== 'canvas') setMode('canvas'); } }
    renderPeers(Sync.status, Sync.peers);
  })();

  $('cvFrameFormat').innerHTML = Grid.FORMATS.map(f => `<option value="${f.id}" ${f.id === 'slide' ? 'selected' : ''}>${f.name}</option>`).join('');

  // ---- Init --------------------------------------------------------------------------------------
  async function init() {
    fillPresets(); fillFontSelects();
    const savedKit = LS.get('lg.kit', null); const savedPreset = LS.get('lg.preset', 'deel');
    try {
      if (savedKit && savedKit.colors && savedKit.fonts && savedKit.content && savedKit.grid && savedKit.logo) {
        // Saved kits from older versions get the preset's sample deck back.
        if (!savedKit.deck && savedKit.presetId && Brand.PRESETS[savedKit.presetId]) savedKit.deck = Brand.PRESETS[savedKit.presetId].deck;
        loadKit(savedKit); $('presetSelect').value = savedKit.presetId && Brand.PRESETS[savedKit.presetId] ? savedKit.presetId : '__custom';
      } else throw new Error('no saved kit');
    } catch { loadKit(Brand.fromPreset(savedPreset in Brand.PRESETS ? savedPreset : 'deel')); $('presetSelect').value = state.kit.presetId; }
    renderChips();
    $('apiKey').value = LS.get('lg.apiKey', ''); $('useClaude').checked = !!LS.get('lg.useClaude', false);
    state.copyVariant = (+LS.get('lg.copyVariant', 0) || 0) % 4; $('copyFromBrief').checked = LS.get('lg.copyFromBrief', true) !== false;
    if (!$('copyFromBrief').checked) setCopyHint('Locked: the copy below stays as it is.', true);
    $('prompt').value = LS.get('lg.prompt', '');
    $('promptForm').addEventListener('submit', e => { e.preventDefault(); generate($('prompt').value); });
    await ensureDemoImages(false);
    // First frame: a working state, not an empty shell.
    const savedMode = LS.get('lg.mode', 'single');
    if (!$('prompt').value) $('prompt').value = savedMode === 'deck' ? '8-slide launch deck for Deel Global Payroll' : 'Launch posts for Deel Global Payroll, bold, image-led, square and story';
    if (savedMode === 'deck') setMode('deck');
    updateCanvasBadge();
    if (savedMode === 'canvas') { await ensureDemoImages(false); await loadFonts(state.kit); setMode('canvas'); return; }
    await generate($('prompt').value);
  }
  init();
})();
