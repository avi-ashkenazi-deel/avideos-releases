/* Web pages in: a capture snippet runs on any open page (bookmarklet or DevTools console), records what is visible as
   boxes, text, images and inline SVG in page coordinates, embeds the images it is allowed to read, and copies the result
   as JSON. Pasting that JSON on the canvas builds an editable frame; Looks turn it into a wireframe or a rebrand.
   The page is read, never changed, apart from a small panel the snippet shows to hand over the copy. */
const WebImport = (() => {
  // ---- The capture. Self-contained: it is serialized with toString() and runs inside another page. ----------------
  function capturePage(OPTS) {
    'use strict';
    const MAX_H = (OPTS && OPTS.maxHeight) || 8000, MAX_NODES = 4000, MAX_IMG = 1.6e6, MAX_TOTAL = 12e6;
    const sx = window.scrollX, sy = window.scrollY;
    const W = document.documentElement.clientWidth || window.innerWidth;
    const H = Math.min(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, window.innerHeight), MAX_H);
    const out = []; const fonts = new Set(); const imgs = new Map();
    const BLOCKY = /^(block|flex|grid|table|list-item|flow-root|table-row|table-cell|inline-block|inline-flex|inline-grid)$/;
    const hexA = c => { const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?/.exec(c || ''); if (!m) return null; let a = m[4] == null ? 1 : /%$/.test(m[4]) ? parseFloat(m[4]) / 100 : parseFloat(m[4]); return { hex: '#' + [m[1], m[2], m[3]].map(v => Math.round(+v).toString(16).padStart(2, '0')).join('').toUpperCase(), a: Math.round(a * 1000) / 1000 }; };
    const px = v => parseFloat(v) || 0;
    const r1 = v => Math.round(v * 10) / 10;
    const famOf = ff => { const first = String(ff || '').split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).find(Boolean) || 'Inter'; return first; };
    const isCookie = el => { const t = (el.innerText || '').slice(0, 400).toLowerCase(); return /cookie|consent|gdpr|privacy preferences/.test(t) && t.length < 1600; };
    const nameOf = el => { const tag = el.tagName.toLowerCase(); const cls = (typeof el.className === 'string' ? el.className : '').split(/\s+/).filter(c => c && c.length < 28 && !/^(css|sc|jsx|_|svelte)-/.test(c))[0]; const role = el.getAttribute('aria-label') || el.getAttribute('alt') || ''; return (tag + (cls ? '.' + cls : '') + (role ? ' ' + role.slice(0, 24) : '')).slice(0, 60); };
    function rectOf(el) { const r = el.getBoundingClientRect(); return { x: r1(r.left + sx), y: r1(r.top + sy), w: r1(r.width), h: r1(r.height) }; }
    function visible(r, clip) { if (r.w < 1 || r.h < 1) return false; if (r.y > H || r.x > W + 2 || r.x + r.w < -2 || r.y + r.h < 0) return false; if (clip && (r.x >= clip.x + clip.w || r.y >= clip.y + clip.h || r.x + r.w <= clip.x || r.y + r.h <= clip.y)) return false; return true; }
    function shadowOf(cs) { const s = cs.boxShadow; if (!s || s === 'none') return null; const m = /(rgba?\([^)]*\))\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px/.exec(s); if (!m || /inset/.test(s.split(m[0])[0])) return null; const c = hexA(m[1]); return c && c.a > 0.01 ? { color: c.hex, alpha: c.a, x: +m[2], y: +m[3], blur: +m[4] } : null; }
    function radiusOf(cs, r) { const v = cs.borderTopLeftRadius; if (!v || v === '0px') return 0; return /%$/.test(v) ? Math.min(r.w, r.h) * parseFloat(v) / 100 : px(v); }
    function imgRef(src) { if (!src || /^data:image\/svg/.test(src) && src.length > 400000) return null; if (!imgs.has(src)) imgs.set(src, null); return src; }
    function pushText(el, cs, op, text, box, fixed) {
      text = text.replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').trim(); if (!text) return;
      fonts.add(famOf(cs.fontFamily));
      const c = hexA(cs.color) || { hex: '#000000', a: 1 }; const size = px(cs.fontSize) || 16;
      const lh = cs.lineHeight === 'normal' ? 1.2 : Math.round(px(cs.lineHeight) / size * 100) / 100;
      out.push({ t: 'text', name: nameOf(el), ...box, text, color: c.hex, alpha: c.a * op, family: famOf(cs.fontFamily), size, weight: parseInt(cs.fontWeight, 10) || 400, italic: cs.fontStyle === 'italic', lh: lh || 1.2, ls: cs.letterSpacing === 'normal' ? 0 : Math.round(px(cs.letterSpacing) / size * 1000) / 1000, align: /center/.test(cs.textAlign) ? 'center' : /right|end/.test(cs.textAlign) ? 'right' : 'left', transform: cs.textTransform === 'uppercase' ? 'upper' : cs.textTransform === 'lowercase' ? 'lower' : '', deco: /underline/.test(cs.textDecorationLine) ? 'underline' : /line-through/.test(cs.textDecorationLine) ? 'line-through' : '', fixed: !!fixed });
    }
    function svgMarkup(svg) {
      const clone = svg.cloneNode(true); const src = svg.querySelectorAll('*'); const dst = clone.querySelectorAll('*');
      for (let i = 0; i < src.length && i < 3000; i++) { const cs = getComputedStyle(src[i]); const d = dst[i]; if (!d) continue; for (const k of ['fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity', 'fill-rule', 'display']) { const v = cs.getPropertyValue(k); if (v && v !== 'normal') d.setAttribute(k, v); } }
      for (const u of clone.querySelectorAll('use')) { const ref = (u.getAttribute('href') || u.getAttribute('xlink:href') || '').trim(); if (ref.startsWith('#')) { const t = document.getElementById(ref.slice(1)); if (t) { const g = document.createElementNS('http://www.w3.org/2000/svg', 'g'); g.innerHTML = t.innerHTML; for (const a of ['x', 'y']) if (u.getAttribute(a)) g.setAttribute('transform', `translate(${u.getAttribute('x') || 0} ${u.getAttribute('y') || 0})`); u.replaceWith(g); } } }
      const cs = getComputedStyle(svg); const vb = svg.getAttribute('viewBox'); const r = svg.getBoundingClientRect();
      return { inner: clone.innerHTML.slice(0, 200000), viewBox: vb ? vb.split(/[\s,]+/).map(Number) : [0, 0, r.width, r.height], color: (hexA(cs.color) || {}).hex };
    }
    function walk(el, op, clip, fixed, depth) {
      if (out.length > MAX_NODES || depth > 60) return;
      const tag = el.tagName; if (!tag) return;
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|HEAD|META|LINK|TITLE)$/.test(tag) || el.id === '__lg_capture_panel') return;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return;
      const o = op * (parseFloat(cs.opacity) || 0); if (o < 0.02) return;
      const isFixed = fixed || cs.position === 'fixed' || cs.position === 'sticky';
      if ((cs.position === 'fixed' || cs.position === 'sticky') && isCookie(el) && (OPTS && OPTS.dropCookies !== false)) return;
      const r = rectOf(el); const vis = visible(r, clip);
      if (tag === 'svg' || el instanceof SVGSVGElement) { if (vis) { const m = svgMarkup(el); out.push({ t: 'svg', name: nameOf(el), ...r, svg: m.inner, viewBox: m.viewBox, color: m.color, alpha: o, fixed: isFixed }); } return; }
      if (tag === 'IFRAME' || tag === 'EMBED' || tag === 'OBJECT') { if (vis) out.push({ t: 'box', name: nameOf(el), ...r, bg: '#E4E4EA', bga: 1, radius: 0, alpha: o, fixed: isFixed }); return; }
      if (vis) {
        const bg = hexA(cs.backgroundColor); const bi = cs.backgroundImage;
        const bw = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map(px);
        const bc = [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor].map(hexA);
        const sides = bw.map((w, i) => w > 0 && bc[i] && bc[i].a > 0.02 && cs[['borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle'][i]] !== 'none');
        const radius = radiusOf(cs, r); const sh = shadowOf(cs);
        const grad = bi && /gradient\(/.test(bi) ? bi.slice(0, 600) : null;
        const uniform = sides.every(Boolean) && bw.every(w => w === bw[0]);
        if ((bg && bg.a > 0.02) || grad || uniform || sh) out.push({ t: 'box', name: nameOf(el), ...r, bg: bg && bg.a > 0.02 ? bg.hex : null, bga: bg ? bg.a : 0, grad, radius, border: uniform ? { w: bw[0], c: bc[0].hex } : null, shadow: sh, alpha: o, fixed: isFixed });
        if (!uniform) sides.forEach((on, i) => { if (!on) return; const w = bw[i]; const b = i === 0 ? { x: r.x, y: r.y, w: r.w, h: w } : i === 1 ? { x: r.x + r.w - w, y: r.y, w, h: r.h } : i === 2 ? { x: r.x, y: r.y + r.h - w, w: r.w, h: w } : { x: r.x, y: r.y, w, h: r.h }; out.push({ t: 'box', name: nameOf(el) + ' border', ...b, bg: bc[i].hex, bga: bc[i].a, radius: 0, alpha: o, fixed: isFixed }); });
        const url = bi && /url\(/.test(bi) ? (/url\(["']?([^"')]+)["']?\)/.exec(bi) || [])[1] : null;
        if (url) out.push({ t: 'img', name: nameOf(el) + ' bg', ...r, src: imgRef(new URL(url, location.href).href), fit: cs.backgroundSize === 'contain' ? 'contain' : 'cover', radius, alpha: o, fixed: isFixed });
        if (tag === 'IMG' || tag === 'VIDEO' || tag === 'CANVAS') {
          let src = tag === 'IMG' ? (el.currentSrc || el.src) : tag === 'VIDEO' ? el.poster : null;
          if (tag === 'CANVAS') { try { src = el.toDataURL('image/png'); } catch { src = null; } }
          out.push({ t: 'img', name: nameOf(el), ...r, src: src ? imgRef(src) : null, fit: cs.objectFit === 'contain' ? 'contain' : 'cover', radius, alpha: o, fixed: isFixed });
          return;
        }
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
          const v = tag === 'SELECT' ? (el.options[el.selectedIndex] || {}).text || '' : (el.type === 'password' ? '••••••' : el.value || el.placeholder || '');
          if (v && el.type !== 'checkbox' && el.type !== 'radio' && el.type !== 'hidden') { const pl = px(cs.paddingLeft), pt = px(cs.paddingTop); pushText(el, cs, el.value ? o : o * 0.6, v, { x: r.x + pl, y: r.y + Math.max(pt, (r.h - px(cs.fontSize) * 1.2) / 2), w: Math.max(4, r.w - pl - px(cs.paddingRight)), h: px(cs.fontSize) * 1.3 }); }
          return;
        }
      }
      // text: an element whose own children are only inline content becomes one text layer
      const kids = el.childNodes; let hasText = false, blockKid = false;
      for (const k of kids) { if (k.nodeType === 3 && k.nodeValue.trim()) hasText = true; else if (k.nodeType === 1) { const d = getComputedStyle(k).display; if (BLOCKY.test(d) && d !== 'inline-block' && d !== 'inline-flex') blockKid = true; } }
      let textDone = false;
      if (hasText && !blockKid && vis) {
        const range = document.createRange(); range.selectNodeContents(el); const rr = range.getBoundingClientRect();
        const box = { x: r1(rr.left + sx), y: r1(rr.top + sy), w: r1(Math.max(rr.width, 4)), h: r1(Math.max(rr.height, 4)) };
        // Wrapped or centred text takes the container's content width, which is what the browser wrapped against.
        const size = px(cs.fontSize) || 16; const lhPx = cs.lineHeight === 'normal' ? size * 1.2 : px(cs.lineHeight);
        const multi = rr.height > lhPx * 1.5; const disp = cs.display;
        if ((multi || /center|right|end/.test(cs.textAlign)) && disp !== 'inline') {
          const cl = r.x + px(cs.borderLeftWidth) + px(cs.paddingLeft); const cw = r.w - px(cs.borderLeftWidth) - px(cs.borderRightWidth) - px(cs.paddingLeft) - px(cs.paddingRight);
          if (cw > box.w) { box.x = r1(cl); box.w = r1(cw); }
        }
        if (visible(box, clip)) { pushText(el, cs, o, el.innerText || el.textContent || '', box, isFixed); textDone = true; }
      } else if (hasText && vis) {
        // mixed content: each direct text run on its own
        for (const k of kids) if (k.nodeType === 3 && k.nodeValue.trim()) { const range = document.createRange(); range.selectNodeContents(k); const rr = range.getBoundingClientRect(); const box = { x: r1(rr.left + sx), y: r1(rr.top + sy), w: r1(rr.width), h: r1(rr.height) }; if (visible(box, clip)) pushText(el, cs, o, k.nodeValue, box, isFixed); }
      }
      const clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
      const nextClip = clips && r.w > 0 && r.h > 0 ? (clip ? { x: Math.max(clip.x, r.x), y: Math.max(clip.y, r.y), w: Math.min(clip.x + clip.w, r.x + r.w) - Math.max(clip.x, r.x), h: Math.min(clip.y + clip.h, r.y + r.h) - Math.max(clip.y, r.y) } : r) : clip;
      for (const k of el.children) {
        // children of a text layer are already in its text: collect only their boxes, icons and images
        if (textDone && !(k instanceof SVGSVGElement) && k.tagName !== 'IMG') { walkBoxesOnly(k, o, nextClip, isFixed, depth + 1); continue; }
        walk(k, o, nextClip, isFixed, depth + 1);
      }
    }
    // Inside a text layer: backgrounds, icons and images of inline children, no text.
    function walkBoxesOnly(el, op, clip, fixed, depth) {
      if (out.length > MAX_NODES || depth > 60 || !el.tagName) return;
      const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') return;
      const o = op * (parseFloat(cs.opacity) || 0); const r = rectOf(el); if (!visible(r, clip)) return;
      if (el instanceof SVGSVGElement) { const m = svgMarkup(el); out.push({ t: 'svg', name: nameOf(el), ...r, svg: m.inner, viewBox: m.viewBox, color: m.color, alpha: o, fixed }); return; }
      if (el.tagName === 'IMG') { out.push({ t: 'img', name: nameOf(el), ...r, src: imgRef(el.currentSrc || el.src), fit: cs.objectFit === 'contain' ? 'contain' : 'cover', radius: radiusOf(cs, r), alpha: o, fixed }); return; }
      const bg = hexA(cs.backgroundColor); if (bg && bg.a > 0.02) out.push({ t: 'box', name: nameOf(el), ...r, bg: bg.hex, bga: bg.a, radius: radiusOf(cs, r), alpha: o, fixed });
      for (const k of el.children) walkBoxesOnly(k, o, clip, fixed, depth + 1);
    }
    async function embed(src) {
      if (/^data:/.test(src)) return src.length < MAX_IMG * 1.4 ? src : null;
      try {
        const res = await fetch(src, { mode: 'cors', credentials: 'omit' }); if (!res.ok) return null;
        let blob = await res.blob(); if (!/^image\//.test(blob.type) && !/\.(png|jpe?g|webp|gif|svg|avif)(\?|$)/i.test(src)) return null;
        if (blob.size > MAX_IMG && typeof createImageBitmap === 'function') {
          const bmp = await createImageBitmap(blob); const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height)); const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
          return c.toDataURL('image/jpeg', 0.84);
        }
        if (blob.size > MAX_IMG) return null;
        return await new Promise(res2 => { const fr = new FileReader(); fr.onload = () => res2(fr.result); fr.onerror = () => res2(null); fr.readAsDataURL(blob); });
      } catch { return null; }
    }
    function panel(msg, json, done) {
      let host = document.getElementById('__lg_capture_panel'); if (host) host.remove();
      host = document.createElement('div'); host.id = '__lg_capture_panel'; host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;';
      const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
      root.innerHTML = `<style>.p{font:13px/1.45 system-ui,-apple-system,sans-serif;background:#14141a;color:#ecebf0;border:1px solid #33333e;border-radius:10px;padding:14px 16px;width:300px;box-shadow:0 12px 40px rgba(0,0,0,.4)}b{color:#d8c9a3}button{font:600 13px system-ui,sans-serif;border:0;border-radius:6px;padding:8px 12px;cursor:pointer;margin:10px 6px 0 0}.a{background:#d8c9a3;color:#14141a}.g{background:#26262f;color:#ecebf0}.s{color:#a9a8b4;font-size:12px;margin-top:6px}</style><div class="p"><div><b>Layout Engine</b> · capture</div><div class="m">${msg}</div><div class="s" id="s"></div><div>${json ? '<button class="a" id="c">Copy capture</button><button class="g" id="d">Download</button>' : ''}<button class="g" id="x">Close</button></div></div>`;
      document.documentElement.appendChild(host);
      const $ = id => root.querySelector('#' + id);
      $('x').onclick = () => host.remove();
      if (json) {
        $('c').onclick = async () => { try { await navigator.clipboard.writeText(json); } catch { const ta = document.createElement('textarea'); ta.value = json; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); } $('s').textContent = 'Copied. Go back to the canvas and press ⌘V (Ctrl+V).'; };
        $('d').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' })); a.download = (document.title || 'page').replace(/[^\w-]+/g, '-').slice(0, 40) + '.capture.json'; a.click(); };
      }
      if (done) done(root);
    }
    panel('Capturing this page…');
    try {
      walk(document.documentElement, 1, null, false, 0);
      const fixedLast = out.filter(n => !n.fixed).concat(out.filter(n => n.fixed));
      const bgEl = [document.body, document.documentElement].map(e => e && hexA(getComputedStyle(e).backgroundColor)).find(c => c && c.a > 0.5);
      return (async () => {
        let total = 0, ok = 0, failed = 0; const list = [...imgs.keys()]; const t0 = Date.now();
        for (let i = 0; i < list.length; i += 6) {
          if (Date.now() - t0 > 15000) { failed += list.length - i; break; }
          const batch = await Promise.all(list.slice(i, i + 6).map(embed));
          batch.forEach((d, j) => { if (d && total + d.length < MAX_TOTAL) { imgs.set(list[i + j], d); total += d.length; ok++; } else failed++; });
        }
        const cap = { v: 1, url: location.href, title: document.title, w: W, h: H, scrollY: sy, bg: bgEl ? bgEl.hex : '#FFFFFF', fonts: [...fonts], nodes: fixedLast, images: Object.fromEntries([...imgs].filter(([, d]) => d)) };
        const json = JSON.stringify({ lgCapture: cap });
        panel(`Captured <b>${fixedLast.length}</b> layers from ${W}×${H}px${list.length ? `, ${ok} of ${list.length} images embedded` : ''}.`, json, root => { if (failed) root.querySelector('#s').textContent = `${failed} image${failed > 1 ? 's' : ''} could not be read from this page; they become placeholders.`; });
        return cap;
      })();
    } catch (err) { panel('Capture failed: ' + String(err && err.message || err)); throw err; }
  }

  // ---- Snippet text for the bookmarklet and the console ------------------------------------------------------------
  const source = () => `(${capturePage.toString()})({maxHeight:8000})`;
  const bookmarklet = () => 'javascript:' + encodeURIComponent(`(function(){${source()};})();void 0`);

  // ---- In the app: paste, convert, Looks -----------------------------------------------------------------------------
  let env = null;
  function init(e) { env = e; }
  function renderSection(el) {
    if (!el || el.dataset.ready) return; el.dataset.ready = '1';
    el.innerHTML = `<h4>From a web page</h4>
      <ol>
        <li>Drag this button to your bookmarks bar: <a class="btn small primary bm" id="lgBookmarklet" href="#" draggable="true" title="Drag me to the bookmarks bar">⤓ Capture to canvas</a></li>
        <li>Open any page, scrolled to where you want, and click the bookmark. Logged-in pages work too.</li>
        <li>Click <b>Copy capture</b> on the panel that appears, come back here and press ⌘V.</li>
      </ol>
      <div class="cv-row wrap"><button class="btn small" type="button" id="lgCopySnippet">Copy console snippet</button><button class="btn small" type="button" id="lgCopyBm">Copy bookmarklet code</button><label class="btn small file">Open a capture .json<input id="lgCaptureFile" type="file" accept=".json,application/json" hidden></label></div>
      <p class="hint">No bookmarks bar? Open the page's DevTools console, paste the snippet and press Enter. The page becomes boxes, text, images and SVG you can edit; cookie banners are left out. Use <b>Look</b> on the frame to switch between the original, a grey wireframe and a rebrand in your palette.</p>`;
    const a = el.querySelector('#lgBookmarklet'); a.setAttribute('href', bookmarklet());
    a.addEventListener('click', e => { e.preventDefault(); env.toast('Drag this button to your bookmarks bar, then click it on any page'); });
    const copy = async (text, msg) => { try { await navigator.clipboard.writeText(text); } catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); } env.toast(msg); };
    el.querySelector('#lgCopySnippet').addEventListener('click', () => copy(source(), 'Snippet copied: paste it in the page\'s DevTools console'));
    el.querySelector('#lgCopyBm').addEventListener('click', () => copy(bookmarklet(), 'Bookmarklet copied: make a new bookmark and paste this as its URL'));
    el.querySelector('#lgCaptureFile').addEventListener('change', async e => { const f = e.target.files[0]; if (!f) return; try { const j = JSON.parse(await f.text()); if (!j.lgCapture) throw new Error('not a capture file'); await importCapture(j.lgCapture); document.getElementById('importModal').hidden = true; } catch (err) { env.toast('Could not open the capture: ' + err.message); } e.target.value = ''; });
  }
  function handlePaste(e) {
    const text = e.clipboardData && e.clipboardData.getData('text/plain'); if (!text || !/^\s*\{\s*"lgCapture"/.test(text.slice(0, 40))) return false;
    e.preventDefault();
    let j; try { j = JSON.parse(text); } catch { env.toast('The capture on the clipboard is incomplete'); return true; }
    importCapture(j.lgCapture).catch(err => { console.error(err); env.toast('Could not import the capture: ' + err.message); });
    return true;
  }
  const r2 = v => Math.round(Number(v) * 100) / 100;
  const safeHex = v => /^#[0-9A-Fa-f]{6}$/.test(v || '') ? v.toUpperCase() : null;
  // Background layers are comma-separated at the top level; the first (topmost) gradient layer is the one we keep,
  // unless it is fully transparent, then the next.
  function layersOf(css) { const out = []; let depth = 0, cur = ''; for (const ch of css) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; }
  function parseGradient(css) {
    if (!css) return null;
    const layers = layersOf(css).filter(l => /^(repeating-)?(linear|radial)-gradient\(/.test(l)).map(parseLayer).filter(Boolean);
    return layers.find(g => g.stops.some(s => s.a > 0.05)) || null;
  }
  function parseLayer(css) {
    const m = /(linear|radial)-gradient\((.*)\)$/.exec(css); if (!m) return null;
    const body = m[2]; let angle = 180; const am = /^\s*(-?[\d.]+)deg/.exec(body); if (am) angle = +am[1]; else if (/^\s*to /.test(body)) { const dir = /^\s*to ([a-z ]+)/.exec(body)[1]; angle = { top: 0, right: 90, bottom: 180, left: 270, 'top right': 45, 'right top': 45, 'bottom right': 135, 'right bottom': 135, 'bottom left': 225, 'left bottom': 225, 'top left': 315, 'left top': 315 }[dir.trim()] ?? 180; }
    const stops = [...body.matchAll(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\)\s*([\d.]+%)?/g)].map(s => ({ c: '#' + [s[1], s[2], s[3]].map(v => Math.round(+v).toString(16).padStart(2, '0')).join('').toUpperCase(), a: s[4] != null ? +s[4] : 1, p: s[5] != null ? parseFloat(s[5]) / 100 : null }));
    if (stops.length < 2) return null; stops.forEach((s, i) => { if (s.p == null) s.p = i / (stops.length - 1); });
    return { type: m[1], angle, stops };
  }
  // Capture -> one frame with a layer per node; the original look is kept so Looks can rebuild from it.
  async function importCapture(cap) {
    if (!cap || !Array.isArray(cap.nodes)) throw new Error('empty capture');
    const kit = env.getKit(); const W = Math.max(64, Math.round(cap.w || 1280)), H = Math.max(64, Math.round(cap.h || 800));
    const assetBySrc = new Map(); let embedded = 0, missing = 0;
    for (const [src, data] of Object.entries(cap.images || {})) { if (typeof data === 'string' && /^data:image\//.test(data)) { try { const a = await env.addImage(data, 'web · ' + String(src).split('/').pop().split('?')[0].slice(0, 40)); assetBySrc.set(src, a); embedded++; } catch { } } }
    const uid = () => Math.random().toString(36).slice(2, 8);
    const blocks = [];
    for (const n of cap.nodes) {
      const x = r2(n.x), y = r2(n.y), w = r2(Math.max(1, n.w)), h = r2(Math.max(1, n.h)); if (!(w > 0 && h > 0) || y > H || x > W) continue;
      const base = { id: uid(), x, y, w, h, label: String(n.name || n.t).slice(0, 60) };
      if (n.alpha != null && n.alpha < 0.999) base.opacity = r2(n.alpha);
      if (n.t === 'box') {
        const g = parseGradient(n.grad);
        const b = { ...base, kind: 'field', fill: safeHex(n.bg) || (g ? g.stops[0].c : '#FFFFFF'), radius: r2(n.radius || 0), decorative: true };
        if (!n.bg && !g) { b.fill = '#FFFFFF'; b.alpha = 0; } else if (n.bga != null && n.bga < 0.999) b.alpha = r2(n.bga);
        if (g) { b.gradient = g; delete b.alpha; }
        if (n.border && n.border.w > 0 && safeHex(n.border.c)) b.stroke = { color: safeHex(n.border.c), width: r2(n.border.w) };
        if (n.shadow && safeHex(n.shadow.color)) b.shadow = { on: true, x: r2(n.shadow.x), y: r2(n.shadow.y), blur: r2(n.shadow.blur), color: safeHex(n.shadow.color), alpha: r2(n.shadow.alpha) };
        if (b.alpha === 0 && !b.stroke && !b.shadow) continue;
        blocks.push(b);
      } else if (n.t === 'img') {
        const a = n.src && assetBySrc.get(n.src); if (!a) missing++;
        blocks.push({ ...base, kind: 'image', asset: a ? a.id : null, focal: 'xMidYMid', fit: n.fit === 'contain' ? 'contain' : 'cover', radius: r2(n.radius || 0), decorative: false, path: 'image_' + uid(), placeholder: '#D6D6DC', src: typeof n.src === 'string' && /^https?:/.test(n.src) ? n.src.slice(0, 500) : undefined });
      } else if (n.t === 'svg') {
        blocks.push({ ...base, kind: 'vector', svg: String(n.svg || '').slice(0, 200000), viewBox: Array.isArray(n.viewBox) && n.viewBox.length === 4 ? n.viewBox.map(Number) : [0, 0, w, h], keepAspect: true, fill: safeHex(n.color) || '#000000', decorative: true });
      } else if (n.t === 'text') {
        const size = r2(Math.max(4, n.size || 16)); const fam = String(n.family || 'Inter').replace(/["'<>]/g, '');
        const lines = Math.max(1, Math.round(h / (size * (n.lh || 1.2))));
        const b = { ...base, kind: 'text', role: size >= 32 ? 'headline' : 'text', path: 'text_' + uid(), text: String(n.text || '').slice(0, 4000), align: n.align || 'left', fill: safeHex(n.color) || '#000000', decorative: false,
          font: { family: Brand.FONTS[fam] || Brand.customFonts[fam] ? Brand.fontCss(fam) : `"${fam}", Inter, system-ui, sans-serif`, size, weight: n.weight || 400, lineHeight: r2(n.lh || 1.2), letterSpacing: r2(n.ls || 0) } };
        if (n.italic) b.font.style = 'italic'; if (n.transform) b.font.transform = n.transform; if (n.deco) b.decoration = n.deco;
        // single lines get room for font substitution
        if (lines === 1 && !/\n/.test(b.text)) { const extra = b.w * 0.12 + 4; if (b.align === 'center') b.x -= extra / 2; else if (b.align === 'right') b.x -= extra; b.w += extra; }
        Canvas.refit(b);
        blocks.push(b);
      }
    }
    const host = (() => { try { return new URL(cap.url).hostname.replace(/^www\./, ''); } catch { return 'web page'; } })();
    const layout = FigmaImport.toLayouts([{ name: host, x: 0, y: 0, w: W, h: H, bg: safeHex(cap.bg) || '#FFFFFF', clip: true, blocks }], kit)[0].layout;
    layout.archetype = 'web'; layout.archetypeLabel = 'Web page'; layout.meta = { source: 'web', url: String(cap.url || '').slice(0, 500), title: String(cap.title || '').slice(0, 200), look: 'original' };
    const [f] = env.placeFrames([{ name: `${host}${cap.title ? ' · ' + String(cap.title).slice(0, 40) : ''}`, x: 0, y: 0, layout, clip: true }]);
    env.toast(`Captured ${host}: ${blocks.length} layers${embedded ? `, ${embedded} images` : ''}${missing ? `, ${missing} image placeholders` : ''}. Try Look → Wireframe or Rebrand.`);
    if (env.afterImport) await env.afterImport([f]);
    return f;
  }
  return { init, capturePage, source, bookmarklet, renderSection, handlePaste, importCapture, parseGradient };
})();
