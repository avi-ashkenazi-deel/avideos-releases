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
  // Colors as one compact strip of swatches (a letter marks the role); clicking one opens a small editor below.
  let editingColor = -1;
  const ROLE_TAG = { core: 'C', accent: 'A', background: 'B', neutral: 'N' };
  function renderColors() {
    const cs = state.kit.colors; const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    $('colorList').innerHTML = cs.map((c, i) => `<button type="button" class="pal-sw${i === editingColor ? ' on' : ''}" data-i="${i}" style="background:${esc(c.hex)}" title="${esc(c.name || c.hex)} · ${esc(c.hex)} · ${esc(c.role)}"><i>${ROLE_TAG[c.role] || ''}</i></button>`).join('') + `<button type="button" class="pal-sw add" data-add="1" title="Add a color">＋</button>`;
    $('colorCount').textContent = `${cs.length} · C core, A accent, B background, N neutral`;
    const c = cs[editingColor]; const ed = $('colorEdit');
    if (!c) { ed.hidden = true; ed.innerHTML = ''; return; }
    ed.hidden = false;
    ed.innerHTML = `<input type="color" data-ce="hex" value="${esc(Color.normalize(c.hex))}" class="colorpick" aria-label="Color"><input type="text" class="input grow" data-ce="name" value="${esc(c.name || '')}" placeholder="Name"><select class="select mini" data-ce="role">${ROLES.map(r => `<option value="${r}" ${c.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select><button type="button" class="btn small ghost" data-ce="rm" title="Remove this color">✕</button>`;
  }
  $('colorList').addEventListener('click', e => {
    if (e.target.closest('[data-add]')) { $('colorAdd').hidden = !$('colorAdd').hidden; if (!$('colorAdd').hidden) $('newColorName').focus(); return; }
    const s = e.target.closest('.pal-sw'); if (!s) return;
    editingColor = editingColor === +s.dataset.i ? -1 : +s.dataset.i; renderColors();
  });
  $('colorEdit').addEventListener('input', e => {
    const k = e.target.dataset.ce; const c = state.kit.colors[editingColor]; if (!c || !k) return;
    if (k === 'hex') c.hex = Color.normalize(e.target.value); else if (k === 'name') c.name = e.target.value; else if (k === 'role') c.role = e.target.value;
    const sw = $('colorList').querySelector(`[data-i="${editingColor}"]`); if (sw) { sw.style.background = c.hex; sw.querySelector('i').textContent = ROLE_TAG[c.role] || ''; }
    persistKit();
  });
  $('colorEdit').addEventListener('click', e => { if (e.target.dataset.ce === 'rm') { state.kit.colors.splice(editingColor, 1); editingColor = -1; renderColors(); persistKit(); } });
  $('addColorBtn').addEventListener('click', () => {
    const hex = Color.normalize($('newColor').value); const name = $('newColorName').value.trim() || hex;
    state.kit.colors.push({ name, hex, role: 'accent' }); $('newColorName').value = ''; $('colorAdd').hidden = true; editingColor = state.kit.colors.length - 1; renderColors(); persistKit();
  });
  $('extractedSwatches').addEventListener('click', e => {
    const s = e.target.closest('.swatch'); if (!s) return;
    const hex = s.dataset.hex; if (state.kit.colors.some(c => Color.normalize(c.hex) === hex)) return toast('Already in the kit');
    state.kit.colors.push({ name: 'From image', hex, role: 'accent' }); renderColors(); persistKit(); toast('Added ' + hex);
  });
  // Logo variants as small tiles; the selected one takes the next upload.
  let logoPick = 'wordmark';
  function logoTile(v) {
    const kit = state.kit; const L = { id: 'logo-' + v.id, format: { w: 160, h: 64 }, palette: { bg: '#00000000' }, blocks: [] };
    const asp = Brand.logoAspectOf(kit, Brand.logoVariant(kit, v.id)); const h = v.kind === 'appicon' ? 44 : Math.min(26, 136 / asp); const w = Math.round(h * asp);
    L.blocks.push({ id: 'l', kind: 'logo', variant: v.id, x: Math.round((160 - w) / 2), y: Math.round((64 - h) / 2), w, h, fill: v.kind === 'appicon' ? '#FFFFFF' : '#ECEBF0' });
    return Render.toSVG(L, { kit, assets: { images: [] }, transparent: true, width: 160 });
  }
  function renderLogo() {
    const list = Brand.logosOf(state.kit); if (!list.some(v => v.id === logoPick)) logoPick = list[0].id;
    $('logoVariants').innerHTML = list.map(v => `<button type="button" class="logo-tile${v.id === logoPick ? ' on' : ''}" data-logo="${v.id}" role="option" aria-selected="${v.id === logoPick}" title="${v.name}">${logoTile(v)}<span>${v.name}</span></button>`).join('');
  }
  $('logoVariants').addEventListener('click', e => { const t = e.target.closest('[data-logo]'); if (!t) return; logoPick = t.dataset.logo; renderLogo(); });
  $('logoFile').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    let patch;
    if (f.type.includes('svg') || f.name.endsWith('.svg')) { const svg = Brand.parseSvg(await f.text()); if (!svg) return toast('Could not read that SVG'); patch = { kind: 'svg', svg, monochrome: $('logoMono').checked }; }
    else { const dataUrl = await readAsDataURL(f); const im = await loadImage(dataUrl); patch = { kind: 'image', dataUrl, aspect: im.naturalWidth / im.naturalHeight }; }
    if (logoPick === 'wordmark') state.kit.logo = { ...state.kit.logo, ...patch };
    else { state.kit.logos = Brand.logosOf(state.kit).map(v => v.id === logoPick ? { ...v, ...patch } : v); }
    renderLogo(); persistKit(); if (CanvasUI.active) CanvasUI.renderAll(); toast(`${(Brand.logosOf(state.kit).find(v => v.id === logoPick) || {}).name || 'Logo'} updated`); e.target.value = '';
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
    if (state.mode !== 'canvas' && state.mode !== 'home') generate(text);
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
  const loadImage = (src, cors) => new Promise((res, rej) => { const im = new Image(); if (cors) im.crossOrigin = 'anonymous'; im.onload = () => res(im); im.onerror = () => rej(new Error('image failed to decode')); im.src = src; });
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
    $('formatChips').innerHTML = Grid.POSTS.map(f => `<button type="button" class="chip-btn ${state.formats.includes(f.id) ? 'on' : ''}" data-f="${f.id}">${f.name}<span class="ratio">${f.ratio}</span></button>`).join('');
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
    if (!opts.intent && slidesLinkIn(text)) { setMode('deck'); toast('That is a presentation: rebuilding it as a deck'); return generateDeck(text); }
    if (!opts.auto) Stats.track('generate', { detail: String(text).slice(0, 60) });
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
    // one click opens the details, two open the slide editor
    const card = e.target.closest('.card'); if (card) { clearTimeout(cardClickT); cardClickT = setTimeout(() => openDetail(card.dataset.id), 240); }
  });
  let cardClickT = 0;
  $('gallery').addEventListener('dblclick', e => { const card = e.target.closest('.card'); if (!card || e.target.closest('[data-fav], [data-pick]')) return; clearTimeout(cardClickT); openSlideEditor(card.dataset.id); });
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
  // ---- Edit one slide: its words and type size, redrawn live in the same layout (double-click a slide) -------------
  const SE_LABEL = { eyebrow: 'Eyebrow', headline: 'Headline', subhead: 'Subhead', body: 'Body', stat: 'Number', quote: 'Quote', attribution: 'Attribution', cta: 'Button', footer: 'Footer', items: 'Cards', steps: 'Steps', columns: 'Columns', bullets: 'Bullets', sections: 'Sections', title: 'Title', text: 'Text' };
  const se = { l: null, content: null, level: 0, seed: 0, next: null, timer: 0 };
  const seLabel = k => SE_LABEL[k] || (k[0].toUpperCase() + k.slice(1)).replace(/_/g, ' ');
  function seEnv(l) { return { intent: l.genIntent || state.intent, kit: state.kit, assets: l.poolIds ? { ...state.assets, images: state.assets.images.filter(a => l.poolIds.includes(a.id)) } : state.assets }; }
  function openSlideEditor(id) {
    const l = findLayout(id); if (!l) return;
    $('detail').hidden = true;
    Object.assign(se, { l, content: JSON.parse(JSON.stringify(Canvas.extractContent(l))), level: l.type.level, seed: l.seed, next: l, merged: null, diagramType: null });
    const dg = l.blocks.find(b => b.role === 'diagram' && b.diagram);
    $('seDiagram').hidden = !dg; if (dg) $('seDiagramType').innerHTML = Diagram.TYPES.map(t => `<option value="${t}" ${t === dg.diagram.type ? 'selected' : ''}>${Diagram.LABEL[t]}</option>`).join('');
    const o = l.deckIndex != null && state.outline && state.outline.slides[l.deckIndex];
    $('seTitle').textContent = o ? `Slide ${l.deckIndex + 1} · ${Deck.INTENT_LABEL[o.intent] || o.intent}` : `${l.archetypeLabel} · ${l.format.name}`;
    renderSlideFields(); drawSlideEdit(l); $('seNote').textContent = ''; $('slideEdit').hidden = false;
    const first = $('seFields').querySelector('input, textarea'); if (first) first.focus();
  }
  function renderSlideFields() {
    const c = se.content; const esc = escapeHtml;
    const field = (path, label, v, long) => `<div><label for="se-${esc(path)}">${esc(label)}</label>${long || String(v).length > 60 ? `<textarea class="input" id="se-${esc(path)}" data-se="${esc(path)}" rows="${Math.min(8, Math.max(2, Math.ceil(String(v).length / 48)))}">${esc(v)}</textarea>` : `<input class="input" id="se-${esc(path)}" data-se="${esc(path)}" value="${esc(v)}">`}</div>`;
    const lines = (path, label, arr) => `<div><label for="se-${esc(path)}">${esc(label)} <span class="hint">(one per line)</span></label><textarea class="input" id="se-${esc(path)}" data-se="${esc(path)}" data-lines="1" rows="${Math.min(8, Math.max(2, arr.length + 1))}">${esc(arr.join('\n'))}</textarea></div>`;
    const out = [];
    for (const [k, v] of Object.entries(c)) {
      if (typeof v === 'string') out.push(field(k, seLabel(k), v, k === 'body' || k === 'quote'));
      else if (Array.isArray(v) && v.every(x => typeof x === 'string')) out.push(lines(k, seLabel(k), v));
      else if (Array.isArray(v)) out.push(`<div class="se-group"><b>${esc(seLabel(k))}</b>${v.map((it, i) => !it || typeof it !== 'object' ? '' : `<div class="se-group">${Object.entries(it).map(([kk, vv]) => typeof vv === 'string' ? field(`${k}.${i}.${kk}`, `${seLabel(kk)} ${i + 1}`, vv, kk === 'text') : Array.isArray(vv) ? lines(`${k}.${i}.${kk}`, `${seLabel(kk)} ${i + 1}`, vv.map(String)) : '').join('')}</div>`).join('')}</div>`);
    }
    $('seFields').innerHTML = out.join('') || '<p class="hint">This layout has no words to edit.</p>';
  }
  function drawSlideEdit(l) { $('sePreview').innerHTML = Render.toSVG(l, { kit: state.kit, assets: state.assets, width: 1000 }); }
  // Redraw from the edited words: same layout and palette, the chosen type size and arrangement.
  // Edited words over the slide's full content: a diagram keeps its type and links, a list its hidden items.
  const deepMerge = (a, b) => { if (Array.isArray(a) && Array.isArray(b)) { const out = a.slice(); for (let i = 0; i < b.length; i++) if (b[i] !== undefined) out[i] = deepMerge(a[i], b[i]); return out; } if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(b)) { const out = { ...a }; for (const [k, v] of Object.entries(b)) out[k] = deepMerge(a[k], v); return out; } return b === undefined ? a : b; };
  function slideEditRedraw() {
    const base = { ...se.l, seed: se.seed, type: { ...se.l.type, level: se.level } };
    const orig = (se.l.genIntent && se.l.genIntent.content) || {};
    const content = {}; for (const [k, v] of Object.entries(se.content)) content[k] = orig[k] && typeof orig[k] === 'object' ? deepMerge(orig[k], v) : v;
    if (se.diagramType && content.diagram) content.diagram = { ...content.diagram, type: se.diagramType };
    se.merged = content;
    let next = null; try { next = Engine.hydrate(base, content, seEnv(se.l)); } catch (e) { console.warn(e); }
    if (!next) { $('seNote').textContent = 'That does not fit this layout: shorten it, make the text smaller, or rearrange.'; return false; }
    se.next = next; drawSlideEdit(next); $('seNote').textContent = ''; return true;
  }
  $('seFields').addEventListener('input', e => {
    const t = e.target; const path = t.dataset.se; if (!path) return;
    const val = t.dataset.lines ? t.value.split('\n').map(x => x.trim()).filter(Boolean) : t.value;
    const ks = path.split('.'); let o = se.content; for (let i = 0; i < ks.length - 1; i++) o = o[/^\d+$/.test(ks[i]) ? +ks[i] : ks[i]]; o[ks[ks.length - 1]] = val;
    clearTimeout(se.timer); se.timer = setTimeout(slideEditRedraw, 160);
  });
  $('slideEdit').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') $('slideEdit').hidden = true; if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('slideEdit').querySelector('[data-se-save]').click(); });
  $('slideEdit').addEventListener('click', async e => {
    const t = e.target;
    if (t === $('slideEdit') || t.closest('[data-se-close]')) { $('slideEdit').hidden = true; return; }
    const sz = t.closest('[data-se-size]'); if (sz) { const prev = se.level; se.level = Math.max(0, Math.min(Engine.H_LEVELS.length - 1, se.level + +sz.dataset.seSize)); if (se.level !== prev && !slideEditRedraw()) { se.level = prev; slideEditRedraw(); $('seNote').textContent = 'That size does not fit: the text stays as it was.'; } return; }
    if (t.closest('[data-se-shuffle]')) { for (let k = 0; k < 12; k++) { se.seed = (Math.random() * 2 ** 32) >>> 0; if (slideEditRedraw()) break; } return; }
    const save = t.closest('[data-se-save]'); const canvas = t.closest('[data-se-canvas]');
    if (save || canvas) {
      clearTimeout(se.timer); if (se.next !== se.l && !slideEditRedraw()) return;
      const l = se.l, next = se.next === l ? l : Object.assign(se.next, { id: l.id.replace(/-e\d+$/, '') + '-e' + (++seCount), deckIndex: l.deckIndex, genIntent: l.genIntent, poolIds: l.poolIds });
      if (next !== l) {
        if (l.deckIndex != null && state.deck) {
          const row = state.deck.slides[l.deckIndex]; const j = row.variations.indexOf(l); if (j >= 0) { row.variations[j] = next; row.pick = j; }
          const o = state.outline && state.outline.slides[l.deckIndex];
          if (o) { const src = se.merged || se.content; for (const k of ['eyebrow', 'headline', 'subhead', 'body', 'stat', 'quote', 'attribution', 'cta', 'items', 'steps', 'columns', 'bullets', 'sections', 'diagram']) if (k in src) o[k] = JSON.parse(JSON.stringify(src[k])); state.outlineEdited = true; renderOutline(); }
          renderDeck();
        } else { const j = state.layouts.indexOf(l); if (j >= 0) state.layouts[j] = next; renderGallery(); }
        Stats.track('slide.edit');
      }
      $('slideEdit').hidden = true;
      if (canvas) await sendToCanvas([next]); else if (next !== l) toast('Slide saved');
    }
  });
  let seCount = 0;
  $('detailEdit').addEventListener('click', () => { if (state.detail) openSlideEditor(state.detail.id); });
  $('seDiagramType').addEventListener('change', e => { const prev = se.diagramType; se.diagramType = e.target.value; if (!slideEditRedraw()) { se.diagramType = prev; $('seNote').textContent = 'That kind of diagram does not fit these words here: try another, or fewer words.'; } });
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
    for (const f of Grid.POSTS) {
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
  $('aboutLink').addEventListener('click', () => { $('settings').hidden = true; $('about').hidden = false; });
  // ---- Appearance: light, dark, or whatever the system uses -------------------------------------
  const sysLight = matchMedia('(prefers-color-scheme: light)');
  function applyTheme(t) {
    const root = document.documentElement; if (t === 'light' || t === 'dark') root.dataset.theme = t; else delete root.dataset.theme;
    const eff = root.dataset.theme || (sysLight.matches ? 'light' : 'dark');
    $('themeBtn').textContent = eff === 'light' ? '☾' : '☀'; $('themeBtn').title = eff === 'light' ? 'Dark mode' : 'Light mode'; $('themeSelect').value = t === 'light' || t === 'dark' ? t : 'system';
  }
  applyTheme(LS.get('lg.theme', 'system'));
  $('themeBtn').addEventListener('click', () => { const eff = document.documentElement.dataset.theme || (sysLight.matches ? 'light' : 'dark'); const t = eff === 'light' ? 'dark' : 'light'; LS.set('lg.theme', t); applyTheme(t); });
  $('themeSelect').addEventListener('change', e => { LS.set('lg.theme', e.target.value); applyTheme(e.target.value); });
  sysLight.addEventListener('change', () => applyTheme(LS.get('lg.theme', 'system')));
  // ---- Preview size: one slider (Single and Deck), like a photo browser's ----------------------------
  function applyThumb(v) { v = Math.max(120, Math.min(720, +v || 210)); document.documentElement.style.setProperty('--thumb', v + 'px'); document.documentElement.style.setProperty('--thumb-deck', Math.round(v * 1.05) + 'px'); document.querySelectorAll('.thumbSize').forEach(r => { r.value = v; }); }
  applyThumb(LS.get('lg.thumb', 210));
  document.querySelectorAll('.thumbSize').forEach(r => r.addEventListener('input', e => { applyThumb(e.target.value); LS.set('lg.thumb', +e.target.value); }));
  // ---- The brief's clear button ------------------------------------------------------------------------
  const syncClear = () => { $('promptClear').hidden = !$('prompt').value; };
  $('prompt').addEventListener('input', syncClear); syncClear();
  $('promptClear').addEventListener('click', () => { $('prompt').value = ''; state.deckSource = null; LS.set('lg.prompt', ''); syncClear(); $('prompt').focus(); });
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
    if (mode === 'canvas' && PROJ.ready && !PROJ.id && Projects.mode !== 'local') { toast('Pick a project, or make a new one'); mode = 'home'; }
    state.mode = mode;
    document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
    const canvas = mode === 'canvas'; const home = mode === 'home';
    document.body.classList.toggle('canvas-mode', canvas); document.body.classList.toggle('home-mode', home);
    $('canvasView').hidden = !canvas; $('homeView').hidden = !home;
    $('promptForm').querySelector('#prompt').disabled = canvas || home; $('generateBtn').disabled = canvas || home;
    if (home) { CanvasUI.close(); for (const id of ['outlinePanel', 'deckBar', 'deckView', 'gallery', 'empty']) $(id).hidden = true; LS.set('lg.mode', 'home'); renderHome(); return; }
    if (canvas) { CanvasUI.open(); $('outlinePanel').hidden = true; $('deckBar').hidden = true; $('deckView').hidden = true; $('gallery').hidden = true; $('empty').hidden = true; LS.set('lg.mode', mode); return; }
    CanvasUI.close();
    const deck = mode === 'deck';
    $('outlinePanel').hidden = !deck; $('deckBar').hidden = !deck; $('deckView').hidden = !deck;
    $('gallery').hidden = deck; $('empty').hidden = deck || state.layouts.length > 0;
    for (const id of ['count', 'sort', 'filterArch', 'favOnly', 'compareBtn', 'exportFavBtn', 'exportFavPptxBtn', 'toCanvasBtn']) $(id).closest('label, button').hidden = deck;
    $('prompt').placeholder = deck ? 'Describe the deck, e.g. "8-slide launch deck for Deel Payroll: cover, why now, what you get, how it works, proof, before and after, customer quote, next steps"' : 'Describe what you need, e.g. "36 bold image-led square posts for Deel Payroll, dark, with a CTA"';
    if (deck) { state.formats = [state.deckFormat]; renderChips(); if (!state.outline) { state.outline = Deck.outlineFromBrief($('prompt').value, state.kit); renderOutline(); } }
    LS.set('lg.mode', mode);
  }
  $('modeSeg').addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); });

  // Outline editor --------------------------------------------------------------------------------------
  const DETAIL_HINT = { cards: 'Title — text, one per line', process: 'Step title — text, one per line', agenda: 'One entry per line', comparison: 'Left title\nbullet\nbullet\n---\nRight title\nbullet\nbullet', quote: 'Quote\nAttribution', stat: 'Stat (e.g. 150+)\nSubhead', cover: 'Subhead', statement: 'Subhead', body: 'Body copy', closing: 'Subhead\nCTA label' , sections: 'Section title\nIts paragraph\n- or bullets\n---\nNext section title\n…', diagram: 'type: flow (or cycle, tree, timeline, mindmap, pyramid, staircase, matrix)\nStep one — note\nStep two\n  child (indent under a parent for tree and mindmap)'};
  function detailsText(sl) {
    const i = sl.intent;
    if (i === 'cards' || i === 'process') return Engine.normItems(i === 'cards' ? sl.items : (sl.steps && sl.steps.length ? sl.steps : sl.items)).map(x => x.text ? `${x.title} — ${x.text}` : x.title).join('\n');
    if (i === 'agenda') return (sl.items && sl.items.length ? Engine.normItems(sl.items).map(x => x.title) : (sl.bullets || [])).join('\n');
    if (i === 'comparison') return (sl.columns || []).map(c => [c.title, ...(c.bullets || [])].join('\n')).join('\n---\n');
    if (i === 'quote') return [sl.quote || '', sl.attribution || ''].join('\n');
    if (i === 'stat') return [sl.stat || '', sl.subhead || ''].join('\n');
    if (i === 'closing') return [sl.subhead || '', sl.cta || ''].join('\n');
    if (i === 'body') return sl.body || '';
    if (i === 'sections' && !(sl.sections && sl.sections.length)) return sl.body || '';
    if (i === 'sections') return (sl.sections || []).map(x => [x.title || '', ...(x.text ? [x.text] : []), ...(x.bullets || []).map(b => '- ' + b)].join('\n')).join('\n---\n');
    if (i === 'diagram') return typeof Diagram !== 'undefined' && sl.diagram ? Diagram.toText(sl.diagram) : '';
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
    else if (i === 'sections') { sl.sections = text.split(/\n-{3,}\n?/).map(block => { const ls = block.split('\n').map(x => x.trim()).filter(Boolean); const bul = ls.filter(l => /^[-•*]\s+/.test(l)).map(l => l.replace(/^[-•*]\s+/, '')); const rest = ls.filter(l => !/^[-•*]\s+/.test(l)); const title = rest.length > 1 || (rest[0] && rest[0].length <= 60 && bul.length) ? rest.shift() : ''; return { title, text: rest.join(' '), bullets: bul }; }).filter(x => x.title || x.text || x.bullets.length); }
    else if (i === 'diagram') { if (typeof Diagram !== 'undefined') sl.diagram = Diagram.fromText(text, sl.diagram && sl.diagram.type); }
    else if (i === 'stat') { sl.stat = lines[0] || ''; sl.subhead = lines.slice(1).join(' '); }
    else if (i === 'closing') { sl.subhead = lines[0] || ''; sl.cta = lines[1] || sl.cta || state.kit.content.cta; }
    else if (i === 'body') sl.body = lines.join(' ');
    else sl.subhead = lines.join(' ');
  }
  function renderOutline() {
    const o = state.outline; if (!o) return;
    $('outlineSource').textContent = `${o.slides.length} slides · ${o.source === 'deck' ? `from “${o.title}”${state.outlineEdited ? ', edited' : o.by === 'claude' ? ', sorted by Claude' : ''}` : o.source === 'claude' ? 'written by Claude' : state.outlineEdited ? 'edited' : 'from brief'}`;
    $('outlineReset').textContent = o.source === 'deck' ? 'Rebuild from the deck' : 'Rebuild from brief';
    $('outlineList').innerHTML = o.slides.map((sl, i) => `<div class="outline-row" data-i="${i}">
      <div class="num">${String(i + 1).padStart(2, '0')}${sl.source ? `<small title="Slide ${sl.source} of the original deck">↳${sl.source}</small>` : ''}</div>
      <div class="fields">
        <select class="select" data-k="intent" id="ol-intent-${i}" aria-label="Slide intent">${Engine.SLIDE_INTENTS.map(k => `<option value="${k}" ${k === sl.intent ? 'selected' : ''}>${Deck.INTENT_LABEL[k]}</option>`).join('')}</select>
        <input class="input" data-k="headline" id="ol-headline-${i}" type="text" placeholder="${sl.intent === 'quote' ? 'Headline (optional)' : 'Headline'}" value="${escapeHtml(sl.headline || '')}">
        <textarea class="input" data-k="details" id="ol-details-${i}" rows="3" placeholder="${escapeHtml(DETAIL_HINT[sl.intent] || '')}">${escapeHtml(detailsText(sl))}</textarea>
        ${sl.notes ? `<details class="ol-notes"><summary>Speaker notes (what the slide leaves out)</summary><p>${escapeHtml(sl.notes)}</p></details>` : ''}
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
  $('outlineReset').addEventListener('click', async () => { if (state.outline && state.outline.source === 'deck' && state.deckSource) { if (state.busy) return; state.outlineEdited = false; return generateDeck($('prompt').value, { rebuild: true }); } state.outlineEdited = false; state.outline = await resolveOutline($('prompt').value, true); renderOutline(); toast('Outline rebuilt'); });

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

  // ---- A deck from a finished presentation: a Google Slides link in the brief, or a .pptx chosen or dropped -------------
  const slidesLinkIn = t => (String(t || '').match(/https?:\/\/docs\.google\.com\/presentation\/\S+/) || [])[0] || null;
  let sampleP = null;
  const sampleFn = () => { if (!sampleP) sampleP = (window.claude && typeof window.claude.use === 'function') ? window.claude.use('sample').catch(() => null) : Promise.resolve(null); return sampleP; };
  // Who reads the deck: the viewer's claude.ai account, else Claude with the API key (when "Use Claude" is on), else rules.
  async function deckAsker() {
    const sm = await sampleFn();
    if (sm) return { who: 'Claude', ask: prompt => sm.json(prompt, { modelTier: 'default' }) };
    const key = $('apiKey').value.trim();
    if (key && $('useClaude').checked) return { who: 'Claude', ask: async prompt => {
      const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 16000, messages: [{ role: 'user', content: prompt }], output_config: { effort: 'medium' } }) });
      if (!res.ok) throw new Error(`Claude request failed (${res.status})`);
      const data = await res.json(); const block = (data.content || []).find(b => b.type === 'text'); if (!block) throw new Error('No text in the reply');
      return DeckDigest.parseJSON(block.text);
    } };
    return null;
  }
  // In claude.ai a link is read as text through the Drive connector (fast even for a heavy deck); on the server, and for
  // files, the .pptx itself is read, pictures included.
  async function readDeckLink(url) {
    if (await GSlides.route() === 'connector') { const t = await GSlides.fetchText(url); return DeckDigest.fromText(t.text, t.title); }
    return readDeckBytes(await GSlides.fetchDeck(url), 'Google Slides deck');
  }
  const deckImages = new Map();
  async function readDeckBytes(bytes, name) {
    const res = await PptxImport.read(bytes, {
      addImage: async (url, nm) => { const key = nm + ':' + url.length + ':' + url.slice(-48); if (deckImages.has(key)) return deckImages.get(key); const a = await addImage(url, nm); a.deck = true; deckImages.set(key, a); return a; },
      layout: 'fixed', onProgress: (i, n) => { $('generateBtn').textContent = `Reading slide ${i}/${n}…`; },
    });
    if (!res.slides.length) throw new Error('No slides found in that deck');
    const deck = DeckDigest.fromPptx(res, name);
    // pictures no slide keeps (logos, icons, backgrounds) leave the image list again
    const keep = new Set(deck.slides.flatMap(sl => sl.images));
    const drop = state.assets.images.filter(a => a.deck && !keep.has(a.id));
    for (const a of drop) { const i = state.assets.images.indexOf(a); if (i >= 0) state.assets.images.splice(i, 1); try { URL.revokeObjectURL(a.url); } catch { } }
    for (const [k, a] of deckImages) if (drop.includes(a)) deckImages.delete(k);
    if (drop.length) renderImages();
    return deck;
  }
  async function outlineFromDeck(deck) {
    const asker = await deckAsker(); const opts = { keepText: $('keepText').checked };
    if (!asker) return DeckDigest.rules(deck, opts);
    $('generateBtn').textContent = 'Claude is reading the deck…';
    const o = await DeckDigest.withClaude(deck, state.kit, asker.ask, (d, n) => { $('generateBtn').textContent = `Claude is reading the deck… ${d}/${n}`; }, opts);
    if (o.by === 'rules') toast('Claude did not answer, so rules sorted the slides. Generate again to retry, or edit the outline.');
    else if (o.failed) toast(`Claude sorted most slides; ${o.failed} part${o.failed > 1 ? 's were' : ' was'} sorted by rules.`);
    return o;
  }

  async function generateDeck(text, opts = {}) {
    Stats.track('generate.deck', { detail: opts.file ? 'file' : slidesLinkIn(text) ? 'slides link' : String(text).slice(0, 60) });
    state.busy = true; $('generateBtn').disabled = true; $('generateBtn').textContent = 'Reading brief…';
    try {
      const link = slidesLinkIn(text); const src = state.deckSource;
      // a deck is in play when the brief holds its link, a file was just given, or the brief has not changed since
      if (opts.file) { $('generateBtn').textContent = 'Reading the deck…'; const deck = await readDeckBytes(new Uint8Array(await opts.file.arrayBuffer()), opts.file.name); state.deckSource = { key: 'file:' + opts.file.name + ':' + opts.file.size, prompt: text, deck }; Stats.track('import.deck', { detail: 'pptx' }); }
      else if (link && (!src || src.key !== link)) { $('generateBtn').textContent = 'Opening the deck…'; const deck = await readDeckLink(link); state.deckSource = { key: link, prompt: text, deck }; Stats.track('import.deck', { detail: 'slides link' }); }
      else if (!link && src && src.prompt !== text) state.deckSource = null;
      const ds = state.deckSource; if (ds) ds.prompt = text;
      const promptChanged = text !== state.lastPrompt;
      const base = await resolveIntent(ds ? (text.replace(link || '', '').trim() || ds.deck.title) : text);
      if (!ds) applyBriefCopy(text, base);
      const kit = readKit();
      await ensureDemoImages(false); await loadFonts(kit);
      if (promptChanged) { state.outlineEdited = false; state.lastPrompt = text; }
      state.intent = base;
      if (ds) { if (!(state.outline && state.outline.source === 'deck' && ds.outlineFor === ds.key && (state.outlineEdited || !opts.rebuild))) { state.outline = await outlineFromDeck(ds.deck); ds.outlineFor = ds.key; state.outlineEdited = false; } }
      else state.outline = await resolveOutline(text, promptChanged && !state.outlineEdited);
      renderOutline();
      LS.set('lg.prompt', text);
      const format = Grid.byId[state.deckFormat] || Grid.byId.slide;
      const seedBase = (state.seedBase = (state.seedBase * 1664525 + 1013904223) >>> 0);
      const t0 = performance.now();
      state.deck = await Deck.generate({ outline: state.outline, kit, assets: state.assets, format, baseIntent: base, perSlide: +$('perSlide').value, seedBase, onProgress: (i, n) => { $('generateBtn').textContent = `Slide ${i}/${n}…`; } });
      const ms = Math.round(performance.now() - t0);
      const made = state.deck.slides.reduce((s, x) => s + x.variations.length, 0);
      const o = state.outline; const fr = o.source === 'deck' && o.from;
      $('readout').innerHTML = [
        `<span><span class="k">deck</span> <b>${escapeHtml(o.title)}</b> · ${state.deck.slides.length} slides · ${format.name}</span>`,
        fr ? `<span><span class="k">from</span> <b>${fr.used} of ${fr.slides} slides</b>${fr.ignored ? ` (${fr.ignored} after “ignore” left out)` : ''} · <span class="k">sorted by</span> <b>${o.by === 'claude' ? 'Claude' : 'rules'}</b>${fr.pictures ? '' : ' · <span class="k">pictures</span> from the brand library'}</span>`
          : `<span><span class="k">outline by</span> <b>${o.source === 'claude' ? 'Claude' : 'rules'}</b> · <span class="k">brief read by</span> <b>${base.source === 'claude' ? 'Claude' : 'rules'}</b></span>`,
        `<span><span class="k">palette</span> <b>${state.deck.palette ? state.deck.palette.bgName : '—'}</b> · <span class="k">type step</span> <b>${state.deck.level + 1}/6</b></span>`,
        `<span><span class="k">variations</span> <b>${made}</b> <span class="k">in ${ms} ms</span></span>`,
      ].join('');
      renderDeck();
    } catch (err) {
      console.error(err);
      const msg = err && err.message ? err.message : String(err);
      $('readout').innerHTML = `<span style="color:var(--danger)">${slidesLinkIn(text) || opts.file ? 'Could not read that deck' : 'Deck generation failed'}: ${escapeHtml(msg)}</span>`;
      toast((slidesLinkIn(text) || opts.file ? 'Could not read that deck: ' : 'Deck generation failed: ') + msg);
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
  $('deckView').addEventListener('dblclick', e => { const card = e.target.closest('.deck-card'); if (card) openSlideEditor(card.dataset.id); });
  // Keep long slides whole, or condense them: remembered, and a deck in play is sorted again
  $('keepText').checked = LS.get('lg.keepText', true) !== false;
  $('keepText').addEventListener('change', () => { LS.set('lg.keepText', $('keepText').checked); if (state.deckSource && state.outline && state.outline.source === 'deck' && !state.busy) { state.outlineEdited = false; generateDeck($('prompt').value, { rebuild: true }); } });
  // A .pptx chosen in the outline panel or dropped anywhere in Deck mode
  $('outlineFromDeck').addEventListener('click', () => $('deckFile').click());
  $('deckFile').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f && !state.busy) generateDeck(($('prompt').value || '').replace(slidesLinkIn($('prompt').value) || '', '').trim(), { file: f }); });
  document.addEventListener('dragover', e => { if (state.mode === 'deck' && e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  document.addEventListener('drop', e => {
    if (state.mode !== 'deck') return; const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f || !(/\.pptx$/i.test(f.name) || f.type === GSlides.PPTX)) return; e.preventDefault(); if (!state.busy) generateDeck(($('prompt').value || '').replace(slidesLinkIn($('prompt').value) || '', '').trim(), { file: f });
  });
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
      for (const p of pairs.slice(0, count)) { const tmp = { layout: Canvas.clone(L) }; Canvas.recolor(tmp, { bg: p.bg, fg: p.fgs[0], accent: p.accents[0], bgName: p.bgName, colors: state.kit.colors.map(c => c.hex) }); tmp.layout.palette.bgToken = p.bgName; tmp.layout.id = (L.id || 'v') + '-' + p.bgName.replace(/\W+/g, ''); out.push(tmp.layout); }
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
  // Imports keep auto layout (stacks reflow when text changes) or fixed positions (every layer stays where it was
  // drawn). Remembered per person; paste uses the same choice.
  const importLayout = () => LS.get('lg.importLayout', 'auto') === 'fixed' ? 'fixed' : 'auto';
  function renderImportLayout() {
    const v = importLayout();
    document.querySelectorAll('#importLayout [data-il]').forEach(b => b.classList.toggle('on', b.dataset.il === v));
    $('importLayoutHint').textContent = v === 'auto' ? 'Stacks from Figma, web pages and slides stay stacks: edit text and the rest moves along. Simple mode keeps them tidy for anyone.' : 'Every layer stays exactly where it was drawn, with no stacks. Easiest to drag around.';
  }
  $('importLayout').addEventListener('click', e => { const b = e.target.closest('[data-il]'); if (!b) return; LS.set('lg.importLayout', b.dataset.il); renderImportLayout(); });
  async function importFigmaData(data, how) {
    Stats.track('import.figma');
    const res = await FigmaImport.convert(data, { addImage: (url, name) => addImage(url, name) }, { layout: importLayout() });
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
    toast(`${how} (${importLayout() === 'auto' ? 'auto layout' : 'fixed positions'}): ${list.length > 1 || !list[0].loose ? `${list.length} frame${list.length > 1 ? 's' : ''}` : 'layers'}, ${s.blocks} layers${s.images ? `, ${s.images} images` : ''}${s.missingImages ? `, ${s.missingImages} images not included` : ''}${items.length > MAX ? `, first ${MAX} frames only` : ''}${skipped ? ` · skipped ${skipped}` : ''}`);
    const frames = added.length ? added : CanvasUI.doc.frames.filter(f => sel.frameIds.includes(f.id));
    if (await ensureFonts(frames)) CanvasUI.mutate(() => { }, { history: false, frames: frames.map(f => f.id) });
  }
  // ---- Slides in and out: .pptx files, Google Slides links, Save to Google Slides --------------------------------------
  async function importPptxBytes(bytes, label) {
    Stats.track('import.pptx', { detail: label });
    toast(`Reading ${label}…`); $('slidesStatus').textContent = 'Reading…';
    try {
      const res = await PptxImport.read(bytes, { addImage: (url, name) => addImage(url, name), layout: importLayout(), onProgress: (i, n) => { $('slidesStatus').textContent = `Slide ${i} of ${n}`; } });
      if (!res.slides.length) { toast('No slides found in that deck'); return; }
      await ensureFonts(res.slides.map(sl => ({ layout: { blocks: sl.blocks } })));
      const items = PptxImport.toFrames(res, state.kit, importLayout());
      const added = CanvasUI.placeFrames(items); if (state.mode !== 'canvas') setMode('canvas'); updateCanvasBadge(); $('importModal').hidden = true;
      const st = res.stats; toast(`${label} (${importLayout() === 'auto' ? 'auto layout' : 'fixed positions'}): ${added.length} slide${added.length > 1 ? 's' : ''}${res.total > res.slides.length ? ` of ${res.total}` : ''}, ${st.pictures} pictures${st.tables ? `, ${st.tables} tables` : ''}${st.charts ? `, ${st.charts} charts as placeholders` : ''}${st.missingPictures ? `, ${st.missingPictures} pictures not readable (EMF/WMF)` : ''}`);
      return added;
    } catch (err) { console.error(err); toast('Could not read the deck: ' + err.message); }
    finally { $('slidesStatus').textContent = ''; }
  }
  async function importSlidesLink(url) {
    Stats.track('import.gslides');
    try { $('slidesStatus').textContent = 'Fetching the deck…'; const bytes = await GSlides.fetchDeck(url); await importPptxBytes(bytes, 'Google Slides'); }
    catch (err) { toast(err.message); $('slidesStatus').textContent = ''; }
  }
  $('gslidesGo').addEventListener('click', () => { const v = $('gslidesUrl').value.trim(); if (!v) { $('gslidesUrl').focus(); return; } importSlidesLink(v); });
  $('gslidesUrl').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') $('gslidesGo').click(); });
  $('pptxFile').addEventListener('change', async e => { const f = e.target.files[0]; if (f) await importPptxBytes(new Uint8Array(await f.arrayBuffer()), f.name); e.target.value = ''; });
  async function renderSlidesHint() {
    const r = await GSlides.route();
    $('slidesHint').textContent = (r === 'connector' ? 'Links open through your Google Drive connector, so private decks you can see work too. ' : r === 'server' ? 'Links work for decks shared “Anyone with the link”. ' : 'For a link, download the deck first (File → Download → Microsoft PowerPoint) and choose the file here. ') + 'Each slide becomes a screen with editable text, shapes, pictures, tables and the theme’s colors and fonts. Charts come in as placeholders.';
  }
  // Selected screens -> Google Slides (one deck per slide size), through the Drive connector; else a .pptx to import.
  async function saveToGoogleSlides(frames) {
    Stats.track('export.gslides');
    const groups = new Map(); for (const f of frames) { const k = `${f.layout.format.w}x${f.layout.format.h}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(f); }
    const links = [];
    for (const [k, list] of groups) {
      const blob = await ExportPptx.buildDeck(list.map(f => f.layout), { kit: state.kit, assets: state.assets });
      const title = `${CanvasUI.doc.name || 'Canvas'}${groups.size > 1 ? ' ' + k : ''}`;
      try { toast('Sending to Google Slides…'); const out = await GSlides.saveDeck(blob, title); if (out.url) links.push(out.url); }
      catch (err) {
        if (err.manual) { if (await Render.download(blob, `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pptx`)) toast('Saved a .pptx. In Google Slides choose File → Import slides (or open it in Drive) to make it a Slides deck.'); return; }
        toast(err.message); return;
      }
    }
    if (links.length) { try { await navigator.clipboard.writeText(links.join('\n')); } catch { } toast(`Google Slides created: ${links.length > 1 ? links.length + ' decks' : links[0]} (link copied)`); }
  }
  async function importFile(file) {
    if (/\.pptx$/i.test(file.name) || file.type === GSlides.PPTX) { await importPptxBytes(new Uint8Array(await file.arrayBuffer()), file.name); return true; }
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer()); const sig = String.fromCharCode(...head);
    if (/\.fig$/i.test(file.name) || sig === 'fig-kiwi' || (sig.startsWith('PK') && /\.fig$/i.test(file.name))) {
      toast(`Reading ${file.name}…`);
      try { await importFigmaData(await FigmaImport.readFile(file), 'Figma file'); } catch (err) { console.error(err); toast('Could not read this Figma file: ' + err.message); }
      return true;
    }
    if (/\.json$/i.test(file.name) || file.type === 'application/json') {
      const text = await file.text(); let j; try { j = JSON.parse(text); } catch { return false; }
      if (j && j.lgCapture && typeof WebImport !== 'undefined') { Stats.track('import.web'); await WebImport.importCapture(j.lgCapture); return true; }
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
    const plain = dt.getData('text/plain'); if (plain && GSlides.isLink(plain) && plain.length < 500) { e.preventDefault(); importSlidesLink(plain.trim()); return true; }
    const files = [...(dt.files || [])].filter(f => /^image\//.test(f.type));
    if (files.length) { e.preventDefault(); (async () => { for (const f of files) { const a = await addImage(await readAsDataURL(f), f.name || 'pasted image'); const sel = CanvasUI.selection(); if (sel.frameIds.length === 1) { const fr = Canvas.frameById(CanvasUI.doc, sel.frameIds[0]); const s = Math.min(1, fr.layout.format.w * 0.6 / a.w, fr.layout.format.h * 0.6 / a.h); CanvasUI.insertBlocks(fr.id, [{ id: 'x', kind: 'image', x: 0, y: 0, w: Math.round(a.w * s), h: Math.round(a.h * s), asset: a.id, focal: 'xMidYMid', radius: 0, decorative: false, path: 'image_pasted' }]); } else { CanvasUI.screenFromImage(a, (f.name || 'Pasted image').replace(/\.[^.]+$/, ''), null); } } })(); return true; }
    return false;
  }
  WebImport.init({
    getKit: () => state.kit, toast, addImage: (url, name) => addImage(url, name), layoutChoice: importLayout,
    placeFrames: items => { const out = CanvasUI.placeFrames(items); if (state.mode !== 'canvas') setMode('canvas'); updateCanvasBadge(); $('importModal').hidden = true; return out; },
    afterImport: async frames => { if (await ensureFonts(frames)) CanvasUI.mutate(() => { }, { history: false, frames: frames.map(f => f.id) }); },
  });
  function openImport() { $('importModal').hidden = false; renderImportLayout(); renderSlidesHint(); if (typeof WebImport !== 'undefined') WebImport.renderSection($('captureSection')); }
  $('cvImport').addEventListener('click', openImport);
  $('importClose').addEventListener('click', () => { $('importModal').hidden = true; });
  $('importModal').addEventListener('click', e => { if (e.target === $('importModal')) $('importModal').hidden = true; });
  $('figFile').addEventListener('change', async e => { const f = e.target.files[0]; if (!f) return; $('figStatus').textContent = 'Reading…'; await importFile(f); $('figStatus').textContent = ''; $('importModal').hidden = true; e.target.value = ''; });
  $('canvasFile').addEventListener('change', async e => { const f = e.target.files[0]; if (!f) return; if (!(await importFile(f))) toast('Not a canvas file'); $('importModal').hidden = true; e.target.value = ''; });

  async function sendToCanvas(layouts) {
    if (!layouts.length) return;
    if (!PROJ.id && !(await ensureProject($('prompt').value.split(/[,.:\n]/)[0]))) return;
    Stats.track('to-canvas', { detail: layouts.length + ' layouts' });
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
  // A picture a shared library item uses, under its shared id: from a data URL, or read from its URL (kept as a URL
  // when the browser may not read its pixels).
  async function ensureImage({ id, url, dataUrl, name }) {
    if (state.assets.images.some(a => a.id === id)) return;
    if (dataUrl) await addImage(dataUrl, name || 'library image', false, id);
    else if (url) {
      let data = null;
      try { const im = await loadImage(url, true); const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; c.getContext('2d').drawImage(im, 0, 0); data = c.toDataURL(/\.jpe?g/i.test(url + name) ? 'image/jpeg' : 'image/png', 0.9); } catch { data = null; }
      await addAssetWithId(id, data, url, name || 'library image');
    } else return;
    Library.imagesChanged();
    const fids = CanvasUI.doc.frames.filter(f => f.layout.blocks.some(b => b.asset === id)).map(f => f.id); if (fids.length) CanvasUI.rerender(fids);
  }
  // The open project: its canvas is backed up in this browser under its own key.
  const PROJ = { id: null, ready: false };
  function backupKey() { return PROJ.id ? `lg.canvas.${PROJ.id}` : 'lg.canvas'; }
  CanvasUI.init({
    getKit: () => state.kit, getAssets: () => state.assets, toast, backupKey,
    addImage: async file => addImage(await readAsDataURL(file), file.name),
    importFile: file => importFile(file),
    onPaste: e => onCanvasPaste(e),
    openImport: () => openImport(),
    openAgent: () => Agent.show(),
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
    libraryDrop: (id, at) => Library.insert(id, at),
    saveToGoogleSlides: frames => saveToGoogleSlides(frames),
    traceImage: (f, b) => Trace.run(f, b, { getAssets: () => state.assets, getKit: () => state.kit, addImageData: (url, name) => addImage(url, name), toast, canvas: CanvasUI }),
  });
  // ---- Library: approved components, logos, cards, devices, illustrations ------------------------------------------
  Library.init({ getKit: () => state.kit, getAssets: () => state.assets, toast, canvas: CanvasUI, download: (blob, name) => Render.download(blob, name),
    addImage: async file => addImage(await readAsDataURL(file), file.name), addImageData: (dataUrl, name) => addImage(dataUrl, name), me: () => (typeof Sync !== 'undefined' && Sync.me.name) || '', track: (a, d) => Stats.track(a, { detail: d }) });
  Library.bind($('cvLibrary')); Library.bindManager($('libsModal'));
  LibStore.init({ getAssets: () => state.assets, dataUrlToBlob, ensureImage });
  LibStore.start();
  let leftTab = 'layers';
  const libraryOpen = () => leftTab === 'library' && !$('cvLibrary').hidden;
  function setLeftTab(t) {
    leftTab = t; document.querySelectorAll('#cvLeftTabs [data-left]').forEach(b => b.classList.toggle('on', b.dataset.left === t));
    $('cvLayers').hidden = t !== 'layers'; $('cvLibrary').hidden = t !== 'library';
    $('cvSearch').placeholder = t === 'library' ? 'Search the library' : 'Search layers'; $('cvSearch').value = '';
    if (t === 'library') Library.render($('cvLibrary'), ''); else CanvasUI.renderAll();
  }
  $('cvLeftTabs').addEventListener('click', e => { const b = e.target.closest('[data-left]'); if (b) setLeftTab(b.dataset.left); });
  $('cvSearch').addEventListener('input', () => { if (libraryOpen()) Library.render(null, $('cvSearch').value); });
  CanvasUI.on('select', () => { if (libraryOpen()) Library.render(); });
  // ---- Agent (in-app panel and the tools outside agents call over MCP) ---------------------------------------------
  AgentTools.init({
    getKit: () => state.kit, getAssets: () => state.assets, addImageData: (url, name) => addImage(url, name),
    exportPNG: (layout, scale) => Render.exportPNG(layout, { kit: state.kit, assets: state.assets }, scale || 1),
    variations: opts => makeVariations(opts),
    onExternal: name => { toast(`Outside agent: ${name.replace(/_/g, ' ')}`); Stats.track('agent.tool', { detail: name }); },
  });
  Agent.init({ getKit: () => state.kit, toast, openSettings: () => { $('settings').hidden = false; }, onRun: text => Stats.track('agent.run', { detail: String(text).slice(0, 60) }) });

  // ---- Multiplayer ------------------------------------------------------------------------------------------------
  Sync.init(CanvasUI, {
    getAssets: () => state.assets, dataUrlToBlob, addAssetWithId, onLibrary: () => { if (libraryOpen()) Library.render(); },
    knownAsset: id => LibStore.assetInfo(id), onLibs: () => LibStore.refresh(), onProjects: () => Projects.refresh(),
    userId: () => Projects.me, onDenied: (room, reason) => { if (PROJ.id === room) closeProject(reason || 'That project is not shared with you.'); else toast(reason || 'That project is not shared with you.'); },
    toolList: () => (typeof AgentTools !== 'undefined' ? AgentTools.defs() : []),
    onRpc: (name, args) => (typeof AgentTools !== 'undefined' ? AgentTools.call(name, args, { via: 'mcp' }) : Promise.reject(new Error('Agent tools are not loaded'))),
  });
  const initials = n => String(n || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
  let peersSig = '';
  function renderPeers(st, peers) {
    const el = $('cvPeers'); const me = Sync.me;
    const live = st.mode !== 'local';
    const sig = [st.mode, st.connected, st.readOnly, st.label, me.name, ...peers.map(p => `${p.id}|${p.name}|${p.color}|${!!p.cursor}`)].join('\u0001');
    if (sig === peersSig) return; peersSig = sig;
    el.hidden = !live;
    // a private canvas has no live room: it is saved to this person's private part only
    if (live && st.room === 'private') el.innerHTML = `<span class="cv-live" title="${escapeHtml(st.label)}"><svg class="home-ico" viewBox="0 0 256 256" aria-hidden="true">${Icons.SET.lock || ''}</svg>Only you${st.readOnly ? ' · view only' : ''}</span>`;
    else if (live) el.innerHTML = `<span class="cv-live ${st.connected ? 'on' : ''}" title="${escapeHtml(st.label)}${st.readOnly ? ' · view only' : ''}">${st.connected ? 'Live' : 'Connecting…'}${st.readOnly ? ' · view only' : ''}</span>`
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
    toast('On this server every project is a live room already: open one from Home and share its link.');
  });

  // ---- Projects (Home) and usage analytics ---------------------------------------------------------------------------
  Projects.init({
    me: () => ({ id: Sync.me.id, name: Sync.me.name }),
    // a project changing place (into or out of someone's private part): let the open canvas go, then open it again
    release: async id => { if (PROJ.id !== id) return false; await Sync.flushWrites(); CanvasUI.flushBackup(); Sync.leave(); return true; },
    reopen: async id => { if (Projects.get(id)) await openProject(id, { quiet: true, keepDoc: true, force: true }); },
  });
  Stats.init({ currentProject: () => PROJ.id });
  const ago = t => { if (!t) return 'new'; const m = Math.round((Date.now() - t) / 60000); if (m < 2) return 'just now'; if (m < 60) return m + ' min ago'; const h = Math.round(m / 60); if (h < 36) return h + ' h ago'; return Math.round(h / 24) + ' d ago'; };
  // Which project to open on load: the one in the link, else the one this person had open, else (when nothing exists
  // yet) a first one. On a shared page or server, someone who has not picked a project is not dropped into whatever
  // someone else touched last: they start on Home, and their first canvas work makes them a project of their own.
  async function startProject() {
    // a link to one project: ?room=<id> on a server, #project=<id> in claude.ai
    let fromUrl = serverHere ? Sync.roomFromUrl() : null;
    if (fromUrl && !Projects.get(fromUrl)) { try { await Projects.create({ id: fromUrl, name: 'Room ' + fromUrl }); } catch { toast('That project is not shared with you'); fromUrl = null; } }
    const fromHash = /[#&]project=([A-Za-z0-9_.:-]{1,64})/.exec(location.hash);
    if (!fromUrl && fromHash) { if (Projects.get(fromHash[1])) fromUrl = fromHash[1]; else toast('That project is not here, or it is not shared with you'); }
    let id = fromUrl || Projects.current; let keepDoc = false;
    if (id && !Projects.get(id)) id = null;
    if (!id) {
      const any = Projects.projects();
      if (!any.length) { id = await firstProject(); keepDoc = true; }
      else if (Projects.mode === 'local') id = any[0].id;
      else { PROJ.ready = true; renderProjectName(); if (state.mode === 'canvas') setMode('home'); return; }
    }
    await openProject(id, { quiet: true, keepDoc });
    PROJ.ready = true;
    if (fromUrl && state.mode !== 'canvas') setMode('canvas');
  }
  // Canvas work with no project open: a new project for it (named after the brief), opened.
  async function ensureProject(name) {
    if (PROJ.id) return true;
    try {
      const p = await Projects.create({ name: String(name || '').trim().slice(0, 60) || 'Untitled project' });
      Stats.track('project.create', { project: p.id, detail: projLabel(p) });
      await openProject(p.id, { quiet: true }); toast(`New project “${p.name}” for this work; Home lists every project.`); return true;
    } catch (e) { toast(e && e.message ? e.message : String(e)); return false; }
  }
  // Nothing yet: what this browser already holds becomes the first project (in claude.ai, the page's own canvas).
  async function firstProject() {
    const mode = Projects.mode;
    if (mode === 'artifact') { try { await Projects.create({ id: '_root', name: 'Shared canvas' }); } catch { } return '_root'; }
    if (mode === 'server') { try { const p = await Projects.create({ name: 'My first project' }); return p.id; } catch { return 'local'; } }
    try { await Projects.create({ id: 'local', name: 'My first project' }); } catch { }
    try { if (!localStorage.getItem('lg.canvas.local')) { const old = localStorage.getItem('lg.canvas'); if (old) localStorage.setItem('lg.canvas.local', old); } } catch { }
    return 'local';
  }
  async function openProject(id, opts = {}) {
    const p = Projects.get(id); if (!p && id !== '_root') { toast('That project is not here any more'); return false; }
    if (PROJ.id === id && !opts.force) { if (!opts.quiet) setMode('canvas'); return true; }
    // the canvas being left saves its last edits before it is let go
    if (Sync.status.mode === 'artifact') await Sync.flushWrites();
    CanvasUI.flushBackup(); PROJ.id = id; Projects.setCurrent(id);
    const name = p ? p.name : 'Shared canvas'; const mode = Projects.mode;
    const acc = p ? Projects.accessOf(p) : 'all';
    const label = acc === 'me' ? 'Only you can open this project' : acc === 'people' ? 'You and the people this folder is shared with edit it together' : undefined;
    if (mode === 'artifact') {
      Sync.leave(); Sync.resetState();
      if (!opts.keepDoc) CanvasUI.replaceDoc(Canvas.create(name), { silent: true });
      await Sync.startArtifact(id === '_root' ? {} : { base: Projects.baseOf(id), room: Projects.roomOf(id), solo: Projects.isPrivate(id), label });
    } else if (mode === 'server') {
      if (!opts.keepDoc) CanvasUI.replaceDoc(Canvas.create(name), { silent: true });
      if (!Sync.me.name) Sync.setName('Guest ' + Sync.me.id.slice(-3).toUpperCase());
      Sync.joinServer(id, label);
    } else {
      let doc = null; try { const saved = localStorage.getItem(backupKey()); doc = saved ? Canvas.deserialize(saved) : null; } catch { doc = null; }
      if (!(opts.keepDoc && !doc)) CanvasUI.replaceDoc(doc || Canvas.create(name), { silent: true });
    }
    renderProjectName(); updateCanvasBadge();
    if (!opts.quiet) { setMode('canvas'); Stats.track('project.open', { project: id, detail: p ? projLabel(p) : name }); }
    return true;
  }
  function renderProjectName() { const p = Projects.get(PROJ.id); $('cvProject').textContent = '⌂ ' + (p ? p.name : PROJ.id === '_root' ? 'Shared canvas' : PROJ.id ? 'Project' : 'Projects'); }
  $('cvProject').addEventListener('click', () => setMode('home'));
  // Project bookkeeping from the canvas: screen count and a small cover, at most every 20 s.
  let touchTimer = 0;
  async function thumbnail(f) {
    try {
      const svg = Render.toSVG(f.layout, { kit: state.kit, assets: state.assets, forExport: true });
      const img = new Image(); await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
      const W = 320, H = Math.max(40, Math.round(320 * f.layout.format.h / f.layout.format.w)); const c = document.createElement('canvas'); c.width = W; c.height = Math.min(H, 400);
      c.getContext('2d').drawImage(img, 0, 0, W, H); return c.toDataURL('image/jpeg', 0.6);
    } catch { return ''; }
  }
  CanvasUI.on('change', () => { if (!PROJ.id) return; clearTimeout(touchTimer); touchTimer = setTimeout(async () => { const d = CanvasUI.doc; const f = d.frames.find(x => !x.hidden) || d.frames[0]; Projects.touch(PROJ.id, { frames: d.frames.length, cover: f ? await thumbnail(f) : '' }); }, 4000); });
  CanvasUI.on('action', (a, d) => Stats.track(a, { detail: d }));
  $('stage').addEventListener('pointerdown', () => Stats.active()); $('stage').addEventListener('wheel', () => Stats.active(), { passive: true });
  document.addEventListener('keydown', () => { if (state.mode === 'canvas') Stats.active(); });

  // ---- Home ------------------------------------------------------------------------------------------------------------
  let homeFolder = LS.get('lg.homeFolder', ''); let homeQ = ''; let homeMenu = null; let homeArchived = false; let folderMenu = null;
  const ico = name => Icons.SET[name] ? `<svg class="home-ico" viewBox="0 0 256 256" aria-hidden="true">${Icons.SET[name]}</svg>` : '';
  const accIcon = a => a === 'me' ? ico('lock') : a === 'people' ? ico('users') : '';
  const accWords = f => !f || f.access === 'all' ? (Projects.mode === 'artifact' ? 'Everyone with this page' : 'Everyone on this server') : f.access === 'me' ? 'Only you' : f.by === Projects.me ? `You and ${f.people.length} ${f.people.length === 1 ? 'person' : 'people'}` : 'Shared with you';
  const sharing = () => Projects.mode !== 'local';
  // What analytics records about a project: its name, unless its folder is not everyone's.
  const projLabel = p => !p ? '' : Projects.accessOf(p) === 'all' ? p.name : 'Private project';
  function renderHome() {
    const v = $('homeView'); if (v.hidden) return;
    const folders = Projects.folders(); const all = Projects.projects(); const arch = Projects.archived(); const shared = Projects.sharedWithMe();
    if (homeFolder && !['_none', '_shared'].includes(homeFolder) && !folders.some(f => f.id === homeFolder)) homeFolder = '';
    const base = homeArchived ? arch : homeFolder === '' ? all : homeFolder === '_none' ? all.filter(p => !p.folder) : homeFolder === '_shared' ? shared : all.filter(p => p.folder === homeFolder);
    const list = base.filter(p => !homeQ || p.name.toLowerCase().includes(homeQ));
    const count = f => all.filter(p => p.folder === f).length; const fname = id => (folders.find(f => f.id === id) || {}).name || '';
    const cur = folders.find(f => f.id === homeFolder) || null;
    $('homeSide').innerHTML = `<button type="button" class="home-f ${homeFolder === '' && !homeArchived ? 'on' : ''}" data-folder="">All projects <span>${all.length}</span></button>
      ${shared.length ? `<button type="button" class="home-f ${homeFolder === '_shared' && !homeArchived ? 'on' : ''}" data-folder="_shared"><b>${ico('users')} Shared with you</b> <span>${shared.length}</span></button>` : ''}
      ${folders.map(f => `<div class="home-frow"><button type="button" class="home-f ${homeFolder === f.id && !homeArchived ? 'on' : ''}" data-folder="${escapeHtml(f.id)}" title="${escapeHtml(accWords(f))}"><b>${accIcon(f.access)}${escapeHtml(f.name)}</b> <span>${count(f.id)}</span></button><button type="button" class="home-fx" data-folder-menu="${escapeHtml(f.id)}" title="Rename, share or remove" aria-label="Folder menu">⋯</button></div>
        ${folderMenu === f.id ? `<div class="home-pop" style="position:static;margin:4px 0 8px"><input type="text" class="input" data-folder-name="${escapeHtml(f.id)}" value="${escapeHtml(f.name)}" maxlength="60" aria-label="Folder name"><button type="button" class="btn small" data-folder-rename="${escapeHtml(f.id)}">Rename</button>${Projects.canShare(f) ? `<button type="button" class="btn small" data-folder-share="${escapeHtml(f.id)}">${ico('users')} Sharing…</button>` : ''}<button type="button" class="btn small ghost" data-folder-remove="${escapeHtml(f.id)}">${f.access === 'all' ? 'Remove folder (projects stay)' : 'Remove folder (once empty)'}</button></div>` : ''}`).join('')}
      <button type="button" class="home-f ${homeFolder === '_none' && !homeArchived ? 'on' : ''}" data-folder="_none">Unfiled <span>${all.filter(p => !p.folder).length}</span></button>
      <div class="home-newf"><input type="text" class="input" id="homeFolderNew" placeholder="New folder" maxlength="60" aria-label="New folder name"><button type="button" class="btn small" id="homeAddFolder">Add</button></div>
      ${sharing() ? `<select class="input home-newacc" id="homeFolderAccess" aria-label="Who sees the new folder"><option value="all">Everyone sees it</option><option value="people">Specific people…</option><option value="me">Only me</option></select>` : ''}`;
    $('homeTitle').textContent = homeArchived ? 'Archived projects' : homeFolder === '' ? 'All projects' : homeFolder === '_none' ? 'Unfiled' : homeFolder === '_shared' ? 'Shared with you' : fname(homeFolder);
    const acc = $('homeAccess'); acc.hidden = !(cur && sharing() && !homeArchived);
    if (!acc.hidden) acc.innerHTML = `${accIcon(cur.access)}${escapeHtml(accWords(cur))}${Projects.canShare(cur) ? ` · <button type="button" class="linkish" data-folder-share="${escapeHtml(cur.id)}">Share</button>` : ''}`;
    $('homeGrid').innerHTML = list.map(p => { const a = Projects.accessOf(p); const link = Projects.linkFor(p.id); return `<div class="home-card${p.archived ? ' home-archived' : ''}${p.id === PROJ.id ? ' current' : ''}" data-open="${escapeHtml(p.id)}" tabindex="0" role="button" aria-label="Open ${escapeHtml(p.name)}">
        <div class="home-cover">${p.cover ? `<img src="${escapeHtml(p.cover)}" alt="">` : `<span>${escapeHtml((p.name || '?')[0].toUpperCase())}</span>`}</div>
        <div class="home-name">${a !== 'all' ? `<span title="${a === 'me' ? 'Only you' : 'Specific people'}">${accIcon(a)}</span>` : ''}${escapeHtml(p.name)}${p.id === PROJ.id ? ' <span class="cv-token">open</span>' : ''}</div>
        <div class="home-meta">${p.frames ? p.frames + ' screen' + (p.frames === 1 ? '' : 's') + ' · ' : ''}${escapeHtml(ago(p.updated || p.created))}${p.byName ? ' · ' + escapeHtml(p.byName) : ''}${p.folder && homeFolder !== p.folder ? ' · ' + escapeHtml(fname(p.folder)) : ''}</div>
        <button type="button" class="home-menu${homeMenu === p.id ? ' open' : ''}" data-menu="${escapeHtml(p.id)}" title="Rename, move, copy link, archive" aria-label="Project menu">⋯</button>
        ${homeMenu === p.id ? `<div class="home-pop" data-pop><input type="text" class="input" data-rename="${escapeHtml(p.id)}" value="${escapeHtml(p.name)}" maxlength="80" aria-label="Project name"><select class="input" data-move="${escapeHtml(p.id)}" aria-label="Folder"><option value="">No folder (everyone)</option>${folders.map(f => `<option value="${escapeHtml(f.id)}" ${p.folder === f.id ? 'selected' : ''}>${escapeHtml(f.name)}${f.access === 'me' ? ' (only me)' : f.access === 'people' ? ' (specific people)' : ''}</option>`).join('')}</select>${link && p.id !== '_root' ? `<button type="button" class="btn small" data-link="${escapeHtml(p.id)}">Copy link</button>` : ''}${Projects.canChange(p) ? (p.archived ? `<button type="button" class="btn small" data-restore="${escapeHtml(p.id)}">Restore</button>` : `<button type="button" class="btn small ghost" data-archive="${escapeHtml(p.id)}">Archive</button>`) : '<span class="hint">Made by someone else: open it, or ask them or an admin to change it.</span>'}</div>` : ''}
      </div>`; }).join('') || `<p class="hint">${homeArchived ? 'Nothing archived.' : homeFolder === '_shared' ? 'Nothing is shared with you by name yet.' : 'No projects here yet. Make one with “New project”.'}</p>`;
    $('homeArchived').textContent = homeArchived ? 'Back to projects' : `Show archived${arch.length ? ` (${arch.length})` : ''}`;
    $('homeNote').textContent = Projects.mode === 'artifact' ? 'Unfiled projects and Everyone folders are seen by everyone who opens this page. A folder’s ⋯ → Sharing limits it.' : Projects.mode === 'server' ? 'Unfiled projects and Everyone folders are seen by everyone on this server; each project is a live room. A folder’s ⋯ → Sharing limits it.' : 'Projects are kept in this browser.';
    $('homeOpenBtn').hidden = !sharing();
    $('homeNewFolder').innerHTML = `<option value="">No folder (everyone)</option>` + folders.map(f => `<option value="${escapeHtml(f.id)}" ${homeFolder === f.id ? 'selected' : ''}>${escapeHtml(f.name)}${f.access === 'me' ? ' (only me)' : f.access === 'people' ? ' (specific people)' : ''}</option>`).join('');
  }
  // The open project went away for this person (sharing changed, or it moved): back to Home.
  function closeProject(msg) {
    Sync.leave(); Sync.resetState(); PROJ.id = null; Projects.setCurrent(null);
    CanvasUI.replaceDoc(Canvas.create('Untitled'), { silent: true }); renderProjectName(); updateCanvasBadge();
    if (state.mode === 'canvas') setMode('home'); toast(msg);
  }
  Projects.on(() => {
    renderHome(); if (PROJ.id) renderProjectName();
    if (PROJ.id && PROJ.id !== '_root' && Projects.mode !== 'local' && Projects.ready && !Projects.moving && !Projects.get(PROJ.id)) closeProject('That project is no longer shared with you (or it was moved).');
  });
  // The server only pushes project changes to people inside a room; on Home, ask for them.
  setInterval(() => { if (state.mode === 'home' && !document.hidden && Projects.mode === 'server' && Sync.status.mode !== 'server') Projects.refresh(); }, 4000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Projects.mode === 'server') Projects.refresh(); });
  const guardHome = async fn => { try { await fn(); } catch (e) { toast(e && e.message ? e.message : String(e)); } renderHome(); };
  async function copyProjectLink(id) {
    const link = Projects.linkFor(id); if (!link) return;
    try { await navigator.clipboard.writeText(link); } catch { }
    toast(Projects.mode === 'artifact' && !Projects.pageLink ? 'Link code copied. Paste it in Home → Open a link. (The page’s owner can set the page address under a folder’s Sharing, for full links.)' : 'Link copied. It opens this project for anyone it is shared with.');
  }
  async function openFromLink(text) {
    const id = Projects.idFromLink(text); if (!id) { toast('That is not a project link'); return false; }
    if (!Projects.get(id)) { toast('That project is not here, or it is not shared with you'); return false; }
    $('homeOpenRow').hidden = true; return openProject(id);
  }

  // ---- Share a folder: everyone, specific people, or only me ----------------------------------------------------------------
  const share = { id: null, access: 'all', people: [], hits: [], names: {}, q: '' };
  async function openShare(id) {
    const f = Projects.folder(id); if (!f) return;
    Object.assign(share, { id, access: f.access, people: [...f.people], hits: [], q: '' });
    $('shareModal').hidden = false; renderShare(); share.names = await Projects.names([...share.people, f.by]); renderShare();
    share.hits = await Projects.searchPeople(''); renderShare();
  }
  function renderShare() {
    const f = Projects.folder(share.id); if (!f) { $('shareModal').hidden = true; return; }
    const art = Projects.mode === 'artifact'; const inside = Projects.projects(f.id).length + Projects.archived().filter(p => p.folder === f.id).length;
    const opt = (v, title, sub) => `<label class="share-opt${share.access === v ? ' on' : ''}"><input type="radio" name="shareAcc" value="${v}" ${share.access === v ? 'checked' : ''}><span><b>${accIcon(v)}${title}</b><small>${sub}</small></span></label>`;
    const nm = id => (share.names[id] && share.names[id].name) || (id === Projects.me ? 'You' : 'Someone');
    const note = share.access === 'me'
      ? (art ? 'Kept in your private part of this page: nobody else can open it, the page’s owner included. Live co-editing is off for its projects.' : Projects.trusted ? 'The server checks who you are through your sign-in.' : 'This server has no sign-in, so “you” means this browser. Ask whoever runs it to set LG_USER_HEADER for sign-in.')
      : share.access === 'people'
        ? (art ? 'Only you and the people you add see it in the app. Its data still sits in the page’s shared database, so it is not a lock against someone who reads that data directly: use Only me for anything sensitive.' : Projects.trusted ? 'The server only lets these people (and you) see and open it, checked through sign-in.' : 'The server only shows it to these people, but it has no sign-in, so people are told apart by browser. Ask whoever runs it to set LG_USER_HEADER.')
        : (art ? 'Everyone who opens this page sees it and edits its projects together.' : 'Everyone on this server sees it and edits its projects together.');
    const moving = art && inside && (share.access === 'me') !== (f.access === 'me');
    $('shareModal').querySelector('.share-body').innerHTML = `
      <p class="hint">Who sees <b>${escapeHtml(f.name)}</b> and the projects in it.</p>
      <div class="share-opts">${opt('all', 'Everyone', art ? 'Everyone with this page' : 'Everyone on this server')}${opt('people', 'Specific people', 'You and the people you add')}${opt('me', 'Only me', 'Just you')}</div>
      ${share.access === 'people' ? `<div class="share-people">
        <div class="share-chips">${share.people.map(id => `<span class="share-chip">${escapeHtml(nm(id))}<button type="button" data-unshare="${escapeHtml(id)}" aria-label="Remove ${escapeHtml(nm(id))}">✕</button></span>`).join('') || '<span class="hint">Nobody added yet.</span>'}</div>
        <input type="search" class="input" id="shareSearch" placeholder="${art ? 'Add people by name or email' : 'Add people by name'}" value="${escapeHtml(share.q)}" aria-label="Find people" autocomplete="off">
        <div class="share-hits">${share.hits.filter(h => !h.me && !share.people.includes(h.id) && h.id !== f.by).map(h => `<button type="button" class="share-hit" data-addshare="${escapeHtml(h.id)}">${h.avatar ? `<img src="${escapeHtml(h.avatar)}" alt="">` : ''}<span>${escapeHtml(h.name || 'Someone')}</span></button>`).join('') || (share.q ? '<span class="hint">Nobody found.</span>' : '')}</div>
      </div>` : ''}
      <p class="hint share-note">${note}${moving ? ` <b>Its ${inside} project${inside === 1 ? '' : 's'} move${inside === 1 ? 's' : ''} ${share.access === 'me' ? 'into your private part' : 'back to the shared database'}.</b>` : ''}</p>
      <div class="share-actions"><button type="button" class="btn primary" data-share-save>Save</button><button type="button" class="btn ghost" data-share-close>Cancel</button></div>
      ${art && Projects.owner ? `<details class="share-page"><summary>Project links: this page’s address</summary><p class="hint">Copy the address from your browser (https://claude.ai/…) so “Copy link” makes links that open a project directly.</p><div class="home-newf"><input type="url" class="input" id="sharePageLink" value="${escapeHtml(Projects.pageLink)}" placeholder="https://claude.ai/…"><button type="button" class="btn small" data-share-page>Set</button></div></details>` : ''}`;
    const s = $('shareSearch'); if (s && document.activeElement !== s && share.focus) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
  }
  $('shareModal').addEventListener('click', async e => {
    const t = e.target;
    if (t === $('shareModal') || t.closest('[data-share-close]')) { $('shareModal').hidden = true; return; }
    const add = t.closest('[data-addshare]'); if (add) { share.people.push(add.dataset.addshare); const h = share.hits.find(x => x.id === add.dataset.addshare); if (h) share.names[h.id] = h; share.q = ''; share.focus = true; renderShare(); share.hits = await Projects.searchPeople(''); renderShare(); return; }
    const rm = t.closest('[data-unshare]'); if (rm) { share.people = share.people.filter(x => x !== rm.dataset.unshare); renderShare(); return; }
    if (t.closest('[data-share-page]')) { try { await Projects.setPageLink($('sharePageLink').value); toast('Page address saved: project links now open the project'); } catch (err) { toast(err.message); } return; }
    if (t.closest('[data-share-save]')) {
      const btn = t.closest('[data-share-save]'); btn.disabled = true; btn.textContent = 'Saving…';
      try { await Projects.setSharing(share.id, { access: share.access, people: share.people }); Stats.track('folder.share', { detail: share.access }); $('shareModal').hidden = true; toast(share.access === 'all' ? 'Everyone sees this folder now' : share.access === 'me' ? 'Only you see this folder now' : `Shared with ${share.people.length} ${share.people.length === 1 ? 'person' : 'people'}`); }
      catch (err) { toast(err && err.message ? err.message : String(err)); btn.disabled = false; btn.textContent = 'Save'; }
      renderHome(); return;
    }
  });
  $('shareModal').addEventListener('change', e => { if (e.target.name === 'shareAcc') { share.access = e.target.value; share.focus = share.access === 'people'; renderShare(); } });
  $('shareModal').addEventListener('input', async e => { if (e.target.id !== 'shareSearch') return; share.q = e.target.value; const q = share.q; const hits = await Projects.searchPeople(q); if (q !== share.q) return; share.hits = hits; share.focus = true; renderShare(); });
  $('shareModal').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') $('shareModal').hidden = true; });

  $('homeView').addEventListener('click', async e => {
    const t = e.target;
    const fs = t.closest('[data-folder-share]'); if (fs) { folderMenu = null; renderHome(); await openShare(fs.dataset.folderShare); return; }
    const f = t.closest('[data-folder]'); if (f && !t.closest('[data-pop]')) { homeFolder = f.dataset.folder; homeArchived = false; LS.set('lg.homeFolder', homeFolder); folderMenu = null; renderHome(); return; }
    const fm = t.closest('[data-folder-menu]'); if (fm) { folderMenu = folderMenu === fm.dataset.folderMenu ? null : fm.dataset.folderMenu; renderHome(); return; }
    const fr = t.closest('[data-folder-rename]'); if (fr) { const inp = $('homeSide').querySelector(`[data-folder-name="${CSS.escape(fr.dataset.folderRename)}"]`); folderMenu = null; await guardHome(() => Projects.renameFolder(fr.dataset.folderRename, inp.value)); return; }
    const frm = t.closest('[data-folder-remove]'); if (frm) { folderMenu = null; const id = frm.dataset.folderRemove; await guardHome(async () => { await Projects.removeFolder(id); if (homeFolder === id) homeFolder = ''; }); return; }
    if (t.closest('#homeAddFolder')) {
      const inp = $('homeFolderNew'); const name = inp.value.trim(); if (!name) { inp.focus(); return; }
      const access = $('homeFolderAccess') ? $('homeFolderAccess').value : 'all';
      await guardHome(async () => { const f = await Projects.createFolder(name, { access }); homeFolder = f.id; LS.set('lg.homeFolder', homeFolder); if (access !== 'all') Stats.track('folder.share', { detail: access }); if (access === 'people') setTimeout(() => openShare(f.id), 0); });
      return;
    }
    if (t.closest('#homeNewBtn')) { $('homeNew').hidden = false; $('homeOpenRow').hidden = true; $('homeNewName').value = ''; $('homeNewName').focus(); return; }
    if (t.closest('#homeCancel')) { $('homeNew').hidden = true; return; }
    if (t.closest('#homeCreate')) { await createProjectFromForm(); return; }
    if (t.closest('#homeOpenBtn')) { $('homeOpenRow').hidden = !$('homeOpenRow').hidden; $('homeNew').hidden = true; if (!$('homeOpenRow').hidden) { $('homeOpenInput').value = ''; $('homeOpenInput').focus(); } return; }
    if (t.closest('#homeOpenGo')) { await openFromLink($('homeOpenInput').value); return; }
    if (t.closest('#homeOpenCancel')) { $('homeOpenRow').hidden = true; return; }
    if (t.closest('#homeArchived')) { homeArchived = !homeArchived; homeMenu = null; renderHome(); return; }
    const m = t.closest('[data-menu]'); if (m) { homeMenu = homeMenu === m.dataset.menu ? null : m.dataset.menu; renderHome(); const inp = $('homeGrid').querySelector('[data-rename]'); if (inp) { inp.focus(); inp.select(); } return; }
    if (t.closest('[data-pop]')) {
      const ln = t.closest('[data-link]'); if (ln) { homeMenu = null; renderHome(); await copyProjectLink(ln.dataset.link); return; }
      const ar = t.closest('[data-archive]'); if (ar) { homeMenu = null; await guardHome(() => Projects.remove(ar.dataset.archive)); toast('Project archived (Show archived brings it back)'); return; }
      const rs = t.closest('[data-restore]'); if (rs) { homeMenu = null; await guardHome(() => Projects.restore(rs.dataset.restore)); return; }
      return;
    }
    const card = t.closest('[data-open]'); if (card) { homeMenu = null; await openProject(card.dataset.open); }
  });
  $('homeView').addEventListener('change', async e => {
    const t = e.target;
    if (t.dataset.move != null) { const id = t.dataset.move; const to = t.value; homeMenu = null; if (to && Projects.folderAccess(to) !== Projects.accessOf(Projects.get(id))) toast('Moving the project…'); await guardHome(() => Projects.update(id, { folder: to })); return; }
  });
  $('homeView').addEventListener('keydown', async e => {
    const t = e.target; e.stopPropagation();
    if (e.key === 'Enter' && t.dataset.rename != null) { const id = t.dataset.rename; homeMenu = null; await guardHome(() => Projects.update(id, { name: t.value.trim() || 'Untitled project' })); if (id === PROJ.id) renderProjectName(); return; }
    if (e.key === 'Enter' && t.id === 'homeNewName') { await createProjectFromForm(); return; }
    if (e.key === 'Enter' && t.id === 'homeOpenInput') { await openFromLink(t.value); return; }
    if (e.key === 'Enter' && t.id === 'homeFolderNew') { $('homeAddFolder').click(); return; }
    if (e.key === 'Enter' && t.dataset.folderName != null) { $('homeSide').querySelector(`[data-folder-rename="${CSS.escape(t.dataset.folderName)}"]`).click(); return; }
    if (e.key === 'Escape') { homeMenu = null; folderMenu = null; $('homeNew').hidden = true; $('homeOpenRow').hidden = true; renderHome(); return; }
    if (e.key === 'Enter' && t.classList.contains('home-card')) { await openProject(t.dataset.open); }
  });
  $('homeSearch').addEventListener('input', e => { homeQ = e.target.value.trim().toLowerCase(); renderHome(); });
  async function createProjectFromForm() {
    const name = $('homeNewName').value.trim(); if (!name) { $('homeNewName').focus(); return; }
    const folder = $('homeNewFolder').value || '';
    await guardHome(async () => { const p = await Projects.create({ name, folder }); $('homeNew').hidden = true; Stats.track('project.create', { project: p.id, detail: projLabel(p) }); await openProject(p.id); toast(`${name} created. Generate layouts, import, or draw a frame to begin.`); });
  }

  // ---- Admin ------------------------------------------------------------------------------------------------------------
  Admin.bind($('adminModal'), { download: (blob, name) => Render.download(blob, name) });
  $('adminBtn').addEventListener('click', () => Admin.open());
  function updateAdminButton() { $('adminBtn').hidden = !LibStore.role().admin; }
  LibStore.on(updateAdminButton);

  (async () => {
    if (!Sync.canArtifact()) serverHere = await Sync.serverAvailable();
    await Promise.all([Projects.start(), Stats.start()]);
    await Projects.whenReady(5000);
    await startProject();
    renderPeers(Sync.status, Sync.peers); renderHome(); updateAdminButton();
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
        if (!savedKit.logos && savedKit.presetId && Brand.PRESETS[savedKit.presetId] && Brand.PRESETS[savedKit.presetId].logos) savedKit.logos = Brand.clone(Brand.PRESETS[savedKit.presetId].logos);
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
    if (!$('prompt').value) $('prompt').value = savedMode === 'deck' ? '8-slide launch deck for Deel Payroll' : 'Launch posts for Deel Payroll, bold, image-led, square and story';
    $('promptClear').hidden = !$('prompt').value;
    if (savedMode === 'deck') setMode('deck');
    updateCanvasBadge();
    if (savedMode === 'canvas' || savedMode === 'home') { await ensureDemoImages(false); await loadFonts(state.kit); setMode(savedMode); return; }
    await generate($('prompt').value, { auto: true });
  }
  init();
})();
