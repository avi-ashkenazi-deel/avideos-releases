/* Motion: slides that move and stay editable. Nothing is baked into pictures: a layout's blocks are grouped into units
   (a card with its words, a diagram node with its connector, a headline), each unit gets an effect and a step (with the
   slide, or on click N) from its role, and any unit can be told otherwise (the slide editor, the canvas). One plan plays
   in the app (Quick Look, Present, a card's hover) and becomes native PowerPoint animations in the export.
   settings: { builds: 'enter' (all at once) | 'click' (one part per click) }; a layout's own layout.motion
   { builds, units: { [unitKey]: { step: 0..n | 'none', effect } } } and a block's b.anim { step, effect } win over it. */
const Motion = (() => {
  const EFFECTS = ['auto', 'rise', 'lines', 'fade', 'pop', 'reveal', 'count', 'draw', 'none'];
  const LABEL = { auto: 'Auto', rise: 'Rise', lines: 'Lines rise', fade: 'Fade', pop: 'Pop', reveal: 'Reveal', count: 'Count up', draw: 'Draw', none: 'No motion' };
  const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)', BOUNCE = 'cubic-bezier(0.34, 1.32, 0.64, 1)';
  const tagOf = (b, i) => String(b.id || ('n' + i)); // the block's tag in a tagged drawing (Render.toSVG with tag: true)
  const center = b => [b.x + (b.w || 0) / 2, b.y + (b.h || 0) / 2];
  const inside = (b, r) => { const [x, y] = center(b); return x >= r.x - 1 && x <= r.x + r.w + 1 && y >= r.y - 1 && y <= r.y + r.h + 1; };
  const ITEM = /^(items|steps|sections|columns|diagram\.nodes)\.(\d+)/;
  const ROLE = { eyebrow: 'eyebrow', headline: 'headline', subhead: 'subhead', body: 'body', stat: 'stat', caption: 'caption', quote: 'quote', mark: 'quote', attribution: 'attribution', cta: 'cta', footer: 'footer', bullets: 'body', list: 'body', title: 'headline' };
  const NAME = { bg: 'Background', deco: 'Shape', visual: 'Number visual', eyebrow: 'Eyebrow', headline: 'Headline', subhead: 'Subhead', body: 'Body', stat: 'Number', caption: 'Caption', quote: 'Quote', attribution: 'Attribution', cta: 'Button', logo: 'Logo', footer: 'Footer', other: 'Text' };
  const LIST_NAME = { items: 'Card', steps: 'Step', sections: 'Section', columns: 'Column', 'diagram.nodes': 'Node' };

  // ---- Units: what moves together ----------------------------------------------------------------------------------
  function units(layout) {
    const W = layout.format.w, H = layout.format.h, A = W * H; const bs = layout.blocks || [];
    const U = new Map(), of = new Map(); const idx = new Map(bs.map((b, i) => [b, i]));
    const add = (key, b, props) => { let u = U.get(key); if (!u) { u = { key, blocks: [], ...props }; U.set(key, u); } u.blocks.push(b); of.set(b, u); return u; };
    const live = bs.filter(b => !b.hidden);
    // words with a place in a list belong to their item
    for (const b of live) { const m = b.path && ITEM.exec(b.path); if (m) add(`${m[1]}.${m[2]}`, b, { cat: 'item', list: m[1], n: +m[2] }); }
    const items = [...U.values()];
    const box = u => { const xs = u.blocks.map(b => b.x), ys = u.blocks.map(b => b.y), x2 = u.blocks.map(b => b.x + (b.w || 0)), y2 = u.blocks.map(b => b.y + (b.h || 0)); return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...x2) - Math.min(...xs), h: Math.max(...y2) - Math.min(...ys) }; };
    const nearest = (pt, list) => { let best = null, d = Infinity; for (const u of list) { const r = box(u); const c = [r.x + r.w / 2, r.y + r.h / 2]; const dd = Math.hypot(c[0] - pt[0], c[1] - pt[1]); if (dd < d) { d = dd; best = u; } } return best; };
    // a surface holding an item's words (a card, a node's shape) moves with it; so do a box's children
    for (const b of live) {
      if (of.has(b) || !(b.kind === 'field' || b.kind === 'box' || b.kind === 'shape' || b.kind === 'vector') || b.role === 'diagram-link' || b.role === 'diagram-arrow') continue;
      if ((b.w || 0) * (b.h || 0) > A * 0.45 || b.role === 'diagram' || b.role === 'panel') continue;
      const u = items.find(u => u.blocks.some(t => (t.kind === 'text' || t.kind === 'list') && inside(t, b))); if (u) add(u.key, b);
    }
    for (const b of live) { if (of.has(b) || !b.parent) continue; const p = bs.find(x => x.id === b.parent); if (p && of.has(p)) add(of.get(p).key, b); }
    const nodes = items.filter(u => u.list === 'diagram.nodes');
    for (const b of live) {
      if (of.has(b)) continue;
      if ((b.role === 'diagram-link' || b.role === 'diagram-arrow') && nodes.length) { const u = nearest(b.to || (b.role === 'diagram-arrow' ? center(b) : [b.x + b.w, b.y + b.h]), nodes); if (u) add(u.key, b); continue; }
      if (b.role === 'diagram-node' && nodes.length) { const u = nearest(center(b), nodes); if (u) add(u.key, b); }
    }
    // the rest, one unit each: words by role, the logo, big grounds, smaller shapes and visuals
    live.forEach(b => {
      if (of.has(b)) return; const i = idx.get(b);
      if (b.kind === 'logo') return add('logo', b, { cat: 'logo' });
      if (b.kind === 'text' || b.kind === 'list' || b.kind === 'button' || b.kind === 'badge') { const cat = b.kind === 'button' ? 'cta' : ROLE[b.role] || 'other'; return add(b.path || `${cat}#${i}`, b, { cat }); }
      if (b.role === 'diagram') return; // the invisible frame of a diagram
      if (b.role === 'stat-visual') return add(`visual#${i}`, b, { cat: 'visual' });
      const big = (b.w || 0) * (b.h || 0) >= A * (b.kind === 'image' ? 0.2 : 0.3) || b.role === 'panel';
      add(`${big ? 'bg' : 'deco'}#${i}`, b, { cat: big ? 'bg' : 'deco' });
    });
    const list = [...U.values()];
    for (const u of list) {
      const r = box(u); u.y = r.y; u.x = r.x; u.n = u.n ?? 0;
      u.label = u.cat === 'item' ? `${LIST_NAME[u.list] || 'Item'} ${u.n + 1}` : (NAME[u.cat] || 'Part');
      u.tags = u.blocks.map(b => tagOf(b, idx.get(b)));
    }
    return list;
  }

  // ---- Plan: which step and effect each unit gets, and when ---------------------------------------------------------
  const ORDER = { bg: 0, deco: 1, eyebrow: 2, headline: 3, quote: 3, other: 4, subhead: 5, stat: 6, caption: 7, body: 7, attribution: 7, visual: 8, item: 9, cta: 10, logo: 11, footer: 11 };
  const AT = { bg: 0, deco: 260, eyebrow: 120, headline: 180, quote: 180, other: 320, subhead: 420, stat: 360, caption: 620, body: 520, attribution: 640, visual: 520, item: 640, cta: 820, logo: 900, footer: 900 };
  const NUMERIC = /^\s*[^\d]{0,2}\d[\d,]*(\.\d+)?\s*[^\d\s]{0,4}\s*$/;
  function autoEffect(u) {
    const b = u.blocks[0];
    if (u.cat === 'bg') return b.kind === 'image' ? 'reveal' : 'fade';
    if (u.cat === 'deco') return 'pop';
    if (u.cat === 'visual') return /ring|whole/.test(b.label || '') ? 'draw' : 'pop';
    if (u.cat === 'headline' || u.cat === 'quote') return 'lines';
    if (u.cat === 'stat') return NUMERIC.test(b.text || '') ? 'count' : 'lines';
    if (u.cat === 'cta') return 'pop';
    if (u.cat === 'logo' || u.cat === 'footer') return 'fade';
    if (u.cat === 'item') return u.list === 'diagram.nodes' ? 'pop' : 'rise';
    return 'rise';
  }
  function plan(layout, settings = {}) {
    const lm = layout.motion || {}; const builds = lm.builds || settings.builds || 'enter'; const ov = lm.units || {};
    const us = units(layout).sort((a, b) => (ORDER[a.cat] - ORDER[b.cat]) || (a.cat === 'item' && b.cat === 'item' ? (a.list === b.list ? a.n - b.n : a.y - b.y || a.x - b.x) : (a.y - b.y || a.x - b.x)));
    const items = us.filter(u => u.cat === 'item'); const click = builds === 'click';
    // one part per click: each card, step, section or node; a lone number waits for its click
    for (const u of us) u.step = 0;
    if (click) {
      if (items.length) items.forEach((u, k) => { u.step = k + 1; });
      else { const st = us.find(u => u.cat === 'stat'); if (st) for (const u of us) if (u.cat === 'stat' || u.cat === 'caption' || u.cat === 'visual') u.step = 1; }
    }
    for (const u of us) {
      u.effect = autoEffect(u);
      const own = u.blocks.find(b => b.anim) ; const o = { ...(ov[u.key] || {}), ...(own ? own.anim : {}) };
      if (o.effect && o.effect !== 'auto') u.effect = o.effect;
      if (o.step === 'none' || u.effect === 'none') { u.step = -1; u.effect = 'none'; }
      else if (o.step != null && o.step !== 'auto' && Number.isFinite(+o.step)) u.step = Math.max(0, +o.step);
      u.custom = !!(ov[u.key] || own);
    }
    const n = Math.max(0, ...us.map(u => u.step)); const steps = [...Array(n + 1)].map(() => []);
    for (const u of us) if (u.step >= 0) steps[u.step].push(u);
    // timing inside a step: the slide's own order on enter, a short stagger on a click
    steps.forEach((list, s) => {
      let k = 0; const seen = {};
      for (const u of list) {
        if (s === 0) { const j = seen[u.cat] = (seen[u.cat] ?? -1) + 1; u.delay = (AT[u.cat] ?? 400) + j * (u.cat === 'item' ? 110 : 80); }
        else u.delay = (k++) * 120;
        u.dur = { lines: 900, rise: 750, fade: 650, pop: 700, reveal: 1200, count: 1500, draw: 1000 }[u.effect] || 700;
      }
    });
    // empty click steps (a unit moved away) fold up
    const kept = steps.filter((l, s) => s === 0 || l.length);
    return { builds, units: us, steps: kept, clicks: kept.length - 1, still: us.filter(u => u.step < 0) };
  }

  // ---- Playing it on a tagged drawing --------------------------------------------------------------------------------
  const fmtLike = (final, v) => { const m = /^(\s*[^\d]{0,2})(\d[\d,]*)(\.\d+)?(.*)$/.exec(final); if (!m) return final; const dec = m[3] ? m[3].length - 1 : 0; let s = v.toFixed(dec); if (m[2].includes(',')) s = Number(s).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }); return m[1] + s + m[4]; };
  function player(svg, layout, settings = {}, opts = {}) {
    const p = plan(layout, settings); const H = layout.format.h; const all = []; let at = -1; const counters = [];
    const els = tags => { const set = new Set(tags); return tags.flatMap(t => [...svg.querySelectorAll(`[data-b="${CSS.escape(t)}"]`)]).filter(el => { let a = el.parentElement && el.parentElement.closest('[data-b]'); while (a) { if (set.has(a.getAttribute('data-b'))) return false; a = a.parentElement && a.parentElement.closest('[data-b]'); } return true; }); };
    const prep = u => {
      const out = []; const rise = Math.round(H * 0.03);
      for (const el of els(u.tags)) {
        const b = u.blocks[u.tags.indexOf(el.getAttribute('data-b'))] || u.blocks[0];
        el.style.transformBox = 'fill-box'; el.style.transformOrigin = 'center';
        let eff = u.effect; if (b && (b.role === 'diagram-link') && eff !== 'none') eff = 'draw'; if (b && b.role === 'diagram-arrow' && eff !== 'none') eff = 'fade';
        const o = { duration: u.dur, delay: u.delay, easing: EASE, fill: 'both' };
        if (eff === 'lines' || eff === 'count') {
          const lines = [...el.querySelectorAll('[data-line] > text')];
          if (lines.length) { lines.forEach((t, k) => out.push(t.animate([{ transform: `translateY(${t.getAttribute('data-lh') || rise * 2}px)` }, { transform: 'none' }], { ...o, delay: u.delay + k * 90 }))); }
          else out.push(el.animate([{ opacity: 0, transform: `translateY(${rise}px)` }, { opacity: 1, transform: 'none' }], o));
          if (eff === 'count') { const spans = [...el.querySelectorAll('text tspan')].filter(t => /\d/.test(t.textContent)); for (const t of spans) { const final = t.textContent; const m = /(\d[\d,]*(?:\.\d+)?)/.exec(final); if (!m) continue; const to = parseFloat(m[1].replace(/,/g, '')); counters.push({ t, final, to, delay: u.delay, dur: u.dur, step: u.step }); t.textContent = fmtLike(final, 0); } }
        } else if (eff === 'draw') {
          const strokes = [...el.querySelectorAll('path, circle, line, polyline, ellipse, rect')].filter(x => (x.getAttribute('stroke') || 'none') !== 'none');
          if (strokes.length) for (const s of strokes) { let L = 0; try { L = s.getTotalLength(); } catch { } if (!L) continue; s.style.strokeDasharray = `${L} ${L}`; out.push(s.animate([{ strokeDashoffset: L }, { strokeDashoffset: 0 }], { ...o, easing: 'cubic-bezier(0.65, 0, 0.35, 1)' })); }
          out.push(el.animate([{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1 }], o));
        } else if (eff === 'fade') out.push(el.animate([{ opacity: 0 }, { opacity: 1 }], o));
        else if (eff === 'pop') out.push(el.animate([{ opacity: 0, transform: 'scale(0.82)' }, { opacity: 1, transform: 'none' }], { ...o, easing: BOUNCE }));
        else if (eff === 'reveal') out.push(el.animate([{ opacity: 0, transform: 'scale(1.08)' }, { opacity: 1, transform: 'none' }], o));
        else if (eff === 'rise') out.push(el.animate([{ opacity: 0, transform: `translateY(${rise}px)` }, { opacity: 1, transform: 'none' }], o));
      }
      return out;
    };
    p.steps.forEach((list, s) => { const anims = list.flatMap(prep); anims.forEach(a => { a.pause(); a.currentTime = 0; }); all[s] = anims; });
    let raf = 0; const t0 = {};
    const tick = now => { let live = false; for (const c of counters) { if (c.step > at || c.done) continue; const st = t0[c.step]; if (st == null) continue; const k = Math.min(1, Math.max(0, (now - st - c.delay) / c.dur)); const e = 1 - Math.pow(1 - k, 3); c.t.textContent = k >= 1 ? c.final : fmtLike(c.final, c.to * e); if (k >= 1) c.done = true; else live = true; } raf = live ? requestAnimationFrame(tick) : 0; };
    const api = {
      plan: p, get step() { return at; }, get clicks() { return p.clicks; },
      // play the next step; false when every step has played
      next() { if (at >= p.steps.length - 1) return false; at++; (all[at] || []).forEach(a => a.play()); t0[at] = performance.now(); if (!raf) raf = requestAnimationFrame(tick); return true; },
      // everything shown at once (skip)
      finish() { while (at < p.steps.length - 1) { at++; } all.flat().forEach(a => { try { a.finish(); } catch { } }); for (const c of counters) { c.t.textContent = c.final; c.done = true; } if (raf) cancelAnimationFrame(raf); raf = 0; },
      cancel() { all.flat().forEach(a => { try { a.cancel(); } catch { } }); for (const c of counters) c.t.textContent = c.final; if (raf) cancelAnimationFrame(raf); raf = 0; },
    };
    if (opts.autoplay !== false) api.next();
    return api;
  }

  // ---- PowerPoint: the same plan as native entrance animations ------------------------------------------------------
  // presetID/filter per effect: Float In for rises, Fade, Zoom for pops, Wipe for drawn lines.
  const PPT = { rise: { id: 42, kind: 'float' }, lines: { id: 42, kind: 'float' }, count: { id: 42, kind: 'float' }, fade: { id: 10, kind: 'fade' }, reveal: { id: 10, kind: 'fade' }, pop: { id: 53, sub: 16, kind: 'zoom' }, draw: { id: 22, sub: 8, kind: 'wipe' } };
  function pptTiming(steps, spidsOf) {
    let id = 2; const nid = () => ++id;
    const tgt = sp => `<p:tgtEl><p:spTgt spid="${sp}"/></p:tgtEl>`;
    const effect = (sp, u, first, auto) => {
      const P = PPT[u.effect] || PPT.fade; const dur = Math.round(u.dur);
      const vis = `<p:set><p:cBhvr><p:cTn id="${nid()}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>${tgt(sp)}<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>`;
      const fade = `<p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="${nid()}" dur="${dur}"/>${tgt(sp)}</p:cBhvr></p:animEffect>`;
      const prop = (name, from, to) => `<p:anim calcmode="lin" valueType="num"><p:cBhvr><p:cTn id="${nid()}" dur="${dur}" fill="hold"/>${tgt(sp)}<p:attrNameLst><p:attrName>${name}</p:attrName></p:attrNameLst></p:cBhvr><p:tavLst><p:tav tm="0"><p:val>${from}</p:val></p:tav><p:tav tm="100000"><p:val>${to}</p:val></p:tav></p:tavLst></p:anim>`;
      const sv = v => `<p:strVal val="${v}"/>`;
      let body = vis;
      if (P.kind === 'float') body += fade + prop('ppt_x', sv('#ppt_x'), sv('#ppt_x')) + prop('ppt_y', sv('#ppt_y+.1'), sv('#ppt_y'));
      else if (P.kind === 'zoom') body += prop('ppt_w', '<p:fltVal val="0"/>', sv('#ppt_w')) + prop('ppt_h', '<p:fltVal val="0"/>', sv('#ppt_h')) + fade;
      else if (P.kind === 'wipe') body += `<p:animEffect transition="in" filter="wipe(left)"><p:cBhvr><p:cTn id="${nid()}" dur="${dur}"/>${tgt(sp)}</p:cBhvr></p:animEffect>`;
      else body += fade;
      return `<p:par><p:cTn id="${nid()}" presetID="${P.id}" presetClass="entr" presetSubtype="${P.sub || 0}" fill="hold" nodeType="${first ? (auto ? 'afterEffect' : 'clickEffect') : 'withEffect'}"><p:stCondLst><p:cond delay="${Math.round(u.delay)}"/></p:stCondLst><p:childTnLst>${body}</p:childTnLst></p:cTn></p:par>`;
    };
    const groups = [];
    steps.forEach((list, s) => {
      const parts = []; let first = true;
      for (const u of list) for (const sp of spidsOf(u)) { parts.push(effect(sp, u, first, s === 0)); first = false; }
      if (!parts.length) return;
      const start = s === 0 ? `<p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond>` : `<p:cond delay="indefinite"/>`;
      groups.push(`<p:par><p:cTn id="${nid()}" fill="hold"><p:stCondLst>${start}</p:stCondLst><p:childTnLst><p:par><p:cTn id="${nid()}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>${parts.join('')}</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>`);
    });
    if (!groups.length) return '';
    return `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${groups.join('')}</p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>`;
  }

  return { EFFECTS, LABEL, units, plan, player, pptTiming, tagOf };
})();
