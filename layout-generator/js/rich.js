/* Rich text: words inside one text block that differ from the block's font (bold, italic, underline, strike, a color,
   a token, a gradient, a link, a size). A block keeps its plain `text`; `runs` split that same text into styled pieces,
   in order, and wrap together as one paragraph. Agents read and write the same thing as inline markup:
     **bold**  *italic*  __underline__  ~~strike~~  [words](https://…)  <c=#5938B8>color</c>  <c=primary.main>token</c>
     <g=#A,#B>gradient</g>  <size=32>bigger</size>   (a backslash keeps a mark literal: \*)
   Fonts are measured through Text; nothing here touches the DOM except the editor helpers at the end. */
const Rich = (() => {
  const STYLE_KEYS = ['weight', 'italic', 'underline', 'strike', 'fill', 'fillToken', 'gradient', 'link', 'size'];
  const styled = r => STYLE_KEYS.some(k => r[k] != null && r[k] !== false && r[k] !== '');
  const same = (a, b) => STYLE_KEYS.every(k => JSON.stringify(a[k] ?? null) === JSON.stringify(b[k] ?? null));
  const clean = r => { const o = { text: String(r.text ?? '') }; for (const k of STYLE_KEYS) if (r[k] != null && r[k] !== false && r[k] !== '') o[k] = r[k]; return o; };
  // Runs as the block stores them: non-empty, adjacent twins merged, only real styles kept.
  function norm(runs) {
    const out = [];
    for (const r0 of Array.isArray(runs) ? runs : []) { const r = clean(r0); if (!r.text) continue; const last = out[out.length - 1]; if (last && same(last, r)) last.text += r.text; else out.push(r); }
    return out;
  }
  const plain = runs => (runs || []).map(r => String(r.text ?? '')).join('');
  // Do the runs say anything the block's font does not? (Runs that only repeat the base style are dropped.)
  const hasStyle = runs => Array.isArray(runs) && runs.some(styled);
  function isRich(b) { return !!(b && b.kind === 'text' && Array.isArray(b.runs) && b.runs.length && hasStyle(b.runs) && plain(b.runs) === String(b.text ?? '')); }
  // A run's font: the block's font with the run's weight, slant and size over it.
  function fontOf(run, font) {
    const f = { ...(font || {}) };
    if (run.weight) f.weight = run.weight; if (run.italic) f.style = 'italic'; if (run.size > 0) f.size = run.size;
    return f;
  }
  const boldWeight = base => (Number(base) || 400) >= 700 ? 900 : 700;

  // ---- markup ------------------------------------------------------------------------------------------------------
  // Parse inline markup into {text, runs}. Marks nest; unknown or unbalanced marks stay as plain characters.
  function parse(src, opts = {}) { const runs = parseRuns(src, opts); return { text: plain(runs), runs: hasStyle(runs) ? runs : null }; }
  function parseRuns(src, opts = {}) {
    const s = String(src ?? ''); const out = []; const st = { weight: 0, italic: 0, underline: 0, strike: 0, fill: [], fillToken: [], gradient: [], link: [], size: [] };
    const base = opts.baseWeight || 400;
    const cur = () => { const r = {}; if (st.weight) r.weight = boldWeight(base); if (st.italic) r.italic = true; if (st.underline) r.underline = true; if (st.strike) r.strike = true; const c = st.fill[st.fill.length - 1]; if (c) r.fill = c; const t = st.fillToken[st.fillToken.length - 1]; if (t) r.fillToken = t; const g = st.gradient[st.gradient.length - 1]; if (g) r.gradient = g; const l = st.link[st.link.length - 1]; if (l) r.link = l; const z = st.size[st.size.length - 1]; if (z) r.size = z; return r; };
    const push = t => { if (!t) return; out.push({ ...cur(), text: t }); };
    let i = 0, buf = '';
    const flush = () => { push(buf); buf = ''; };
    const closes = (mark) => s.indexOf(mark, i + mark.length) >= 0; // a mark only opens when it closes later
    while (i < s.length) {
      const ch = s[i], two = s.slice(i, i + 2);
      if (ch === '\\' && i + 1 < s.length && /[*_~\[<\\]/.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
      if (two === '**') { if (st.weight) { flush(); st.weight = 0; i += 2; continue; } if (closes('**')) { flush(); st.weight = 1; i += 2; continue; } }
      if (two === '__') { if (st.underline) { flush(); st.underline = 0; i += 2; continue; } if (closes('__')) { flush(); st.underline = 1; i += 2; continue; } }
      if (two === '~~') { if (st.strike) { flush(); st.strike = 0; i += 2; continue; } if (closes('~~')) { flush(); st.strike = 1; i += 2; continue; } }
      if (ch === '*' && s[i + 1] !== '*' && s[i - 1] !== '*') { if (st.italic) { flush(); st.italic = 0; i += 1; continue; } if (s[i + 1] && !/\s/.test(s[i + 1]) && closes('*')) { flush(); st.italic = 1; i += 1; continue; } }
      if (ch === '_' && s[i + 1] !== '_' && s[i - 1] !== '_' && (i === 0 || /[\s(]/.test(s[i - 1]) || st.italic)) { if (st.italic) { flush(); st.italic = 0; i += 1; continue; } if (s[i + 1] && !/\s/.test(s[i + 1]) && closes('_')) { flush(); st.italic = 1; i += 1; continue; } }
      if (ch === '[') { const m = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+|#[^)\s]*)\)/.exec(s.slice(i)); if (m) { flush(); st.link.push(m[2]); const inner = parseRuns(m[1], opts); for (const r of inner) out.push({ ...cur(), ...r, text: r.text }); st.link.pop(); i += m[0].length; continue; } }
      if (ch === '<') {
        const m = /^<(c|g|size|b|i|u|s|strong|em)(?:=([^>]+))?>/i.exec(s.slice(i));
        if (m) { const tag = m[1].toLowerCase(); const close = `</${tag}>`; const end = s.toLowerCase().indexOf(close, i + m[0].length);
          if (end > 0) { flush(); const val = (m[2] || '').trim();
            if (tag === 'c') { if (/^#[0-9a-f]{3,8}$/i.test(val)) st.fill.push(val.toUpperCase()); else st.fillToken.push(val); }
            else if (tag === 'g') { const stops = val.split(/\s*,\s*/).filter(Boolean); if (stops.length >= 2) st.gradient.push({ type: 'linear', angle: 90, stops: stops.map(x => /^#/.test(x) ? x.toUpperCase() : x) }); }
            else if (tag === 'size') { const z = parseFloat(val); if (z > 0) st.size.push(Math.round(z * 100) / 100); }
            else if (tag === 'b' || tag === 'strong') st.weight++; else if (tag === 'i' || tag === 'em') st.italic++; else if (tag === 'u') st.underline++; else if (tag === 's') st.strike++;
            const inner = parseRuns(s.slice(i + m[0].length, end), opts); for (const r of inner) out.push({ ...cur(), ...r, text: r.text });
            if (tag === 'c') { if (/^#/.test(val)) st.fill.pop(); else st.fillToken.pop(); } else if (tag === 'g') { if (val.split(/\s*,\s*/).filter(Boolean).length >= 2) st.gradient.pop(); } else if (tag === 'size') { if (parseFloat(val) > 0) st.size.pop(); } else if (tag === 'b' || tag === 'strong') st.weight--; else if (tag === 'i' || tag === 'em') st.italic--; else if (tag === 'u') st.underline--; else if (tag === 's') st.strike--;
            i = end + close.length; continue; } }
      }
      buf += ch; i++;
    }
    flush();
    return norm(out);
  }
  // The markup for runs; plain text comes back as itself with marks escaped only where they would read as marks.
  const escape = t => String(t).replace(/\\/g, '\\\\').replace(/\*\*|__|~~|(?<=^|\s)\*(?=\S)|(?<=^|\s)_(?=\S)|\[(?=[^\]]*\]\()|<(?=(c|g|size|b|i|u|s|strong|em)[=>])/gi, m => m.length === 2 ? '\\' + m[0] + '\\' + m[1] : '\\' + m);
  function markup(runs) {
    if (!Array.isArray(runs) || !runs.length) return '';
    return runs.map(r => {
      let t = escape(r.text);
      if (r.size > 0) t = `<size=${r.size}>${t}</size>`;
      if (r.gradient && r.gradient.stops) t = `<g=${r.gradient.stops.join(',')}>${t}</g>`;
      else if (r.fillToken) t = `<c=${r.fillToken}>${t}</c>`; else if (r.fill) t = `<c=${r.fill}>${t}</c>`;
      if (r.strike) t = `~~${t}~~`; if (r.underline) t = `__${t}__`; if (r.italic) t = `*${t}*`; if (r.weight && r.weight >= 600) t = `**${t}**`;
      if (r.link) t = `[${t}](${r.link})`;
      return t;
    }).join('');
  }
  const textOf = b => isRich(b) ? markup(b.runs) : String(b && b.text != null ? b.text : '');

  // ---- wrapping ----------------------------------------------------------------------------------------------------
  // Greedy word wrap over the runs. Returns lines of fragments [{text, ri}] with the line's text alongside; a run's own
  // font measures its words, so a bold word takes the room it needs. Returns null when a single word cannot fit.
  function wrap(runs, font, maxWidth, measure) {
    const W = measure || ((t, f) => Text.width(t, f));
    const fonts = runs.map(r => fontOf(r, font));
    // pieces: words and single spaces, each inside one run; a newline ends the line
    const pieces = [];
    runs.forEach((r, ri) => { const t = String(r.text ?? ''); let m; const re = /\n|[^\S\n]+|[^\s]+/g; while ((m = re.exec(t))) pieces.push({ text: m[0], ri, nl: m[0] === '\n', sp: !/\S/.test(m[0]) && m[0] !== '\n' }); });
    const lines = []; let line = [], lineW = 0;
    const widthOf = p => W(p.text, fonts[p.ri]);
    const commit = () => { while (line.length && line[line.length - 1].sp) line.pop(); lines.push(line); line = []; lineW = 0; };
    for (const p of pieces) {
      if (p.nl) { commit(); continue; }
      if (p.sp) { if (!line.length) continue; const w = widthOf({ ...p, text: ' ' }); line.push({ ...p, text: ' ' }); lineW += w; continue; }
      const w = widthOf(p);
      if (lineW + w > maxWidth + 0.01 && line.some(x => !x.sp)) { commit(); }
      if (w > maxWidth + 0.01 && !line.length) return null;
      line.push(p); lineW += w;
    }
    commit();
    if (!lines.length) lines.push([]);
    return lines.map(frs => { const merged = []; for (const f of frs) { const last = merged[merged.length - 1]; if (last && last.ri === f.ri) last.text += f.text; else merged.push({ text: f.text, ri: f.ri }); } return { text: merged.map(f => f.text).join(''), frags: merged }; });
  }
  function lineWidth(line, runs, font, measure) {
    const W = measure || ((t, f) => Text.width(t, f));
    if (!line || !line.frags) return W(typeof line === 'string' ? line : (line && line.text) || '', font);
    return line.frags.reduce((t, f) => t + W(f.text, fontOf(runs[f.ri] || {}, font)), 0);
  }
  // The widest line when nothing wraps (hug width).
  function widestLine(runs, font, measure) { const lines = wrap(runs, font, 1e9, measure) || []; return Math.max(0, ...lines.map(l => lineWidth(l, runs, font, measure))); }
  // The same text case on every run (upper, lower).
  const transformed = (runs, mode) => mode ? runs.map(r => ({ ...r, text: Text.transform(r.text, mode) })) : runs;

  // ---- the editor and HTML -----------------------------------------------------------------------------------------
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // Runs as HTML (the editor's content, and the HTML export): b, i, u, s, span with a color, a.
  function toHTML(runs, opts = {}) {
    const resolve = opts.resolveToken || (() => null);
    return (runs || []).map(r => {
      let h = esc(r.text).replace(/\n/g, '<br>');
      const color = r.fill || (r.fillToken ? resolve(r.fillToken) : null); const styles = [];
      if (color) styles.push(`color:${color}`); if (r.size > 0) styles.push(`font-size:${opts.sizeScale ? r.size * opts.sizeScale : r.size}px`);
      if (r.gradient && r.gradient.stops && !opts.noGradient) styles.push(`background:linear-gradient(90deg,${r.gradient.stops.join(',')});-webkit-background-clip:text;background-clip:text;color:transparent`);
      if (styles.length || r.fillToken) h = `<span style="${styles.join(';')}"${r.fillToken ? ` data-token="${esc(r.fillToken)}"` : ''}${r.gradient ? ` data-gradient="${esc((r.gradient.stops || []).join(','))}"` : ''}>${h}</span>`;
      if (r.weight && r.weight >= 600) h = `<b>${h}</b>`; if (r.italic) h = `<i>${h}</i>`; if (r.underline) h = `<u>${h}</u>`; if (r.strike) h = `<s>${h}</s>`;
      if (r.link) h = `<a href="${esc(r.link)}">${h}</a>`;
      return h;
    }).join('');
  }
  // Runs from an edited DOM (the contenteditable editor): tags and inline styles decide, so what every browser's
  // execCommand writes (b/strong, i/em, u, s, span style, font color) reads back the same.
  function fromDOM(root, base = {}) {
    const runs = []; const baseWeight = Number(base.weight) || 400;
    const walk = (node, st) => {
      if (node.nodeType === 3) { runs.push({ ...st, text: node.nodeValue.replace(/ /g, ' ') }); return; }
      if (node.nodeType !== 1) return;
      const tag = node.tagName.toLowerCase(); const s = { ...st }; const css = node.style || {};
      if (tag === 'br') { runs.push({ ...st, text: '\n' }); return; }
      if (tag === 'b' || tag === 'strong' || /^(bold|[6-9]00)$/.test(css.fontWeight || '')) s.weight = boldWeight(baseWeight);
      if (css.fontWeight === 'normal' || css.fontWeight === '400') delete s.weight;
      if (tag === 'i' || tag === 'em' || css.fontStyle === 'italic') s.italic = true; if (css.fontStyle === 'normal') delete s.italic;
      if (tag === 'u' || /underline/.test(css.textDecorationLine || css.textDecoration || '')) s.underline = true;
      if (tag === 's' || tag === 'strike' || tag === 'del' || /line-through/.test(css.textDecorationLine || css.textDecoration || '')) s.strike = true;
      if (tag === 'a' && node.getAttribute('href')) s.link = node.getAttribute('href');
      if (node.dataset && node.dataset.token) { s.fillToken = node.dataset.token; delete s.fill; }
      else if (css.color && css.color !== 'inherit') { const hex = toHex(css.color); if (hex) { s.fill = hex; delete s.fillToken; } }
      if (tag === 'font' && node.getAttribute('color')) { const hex = toHex(node.getAttribute('color')); if (hex) { s.fill = hex; delete s.fillToken; } }
      if (node.dataset && node.dataset.gradient) { const stops = node.dataset.gradient.split(','); if (stops.length >= 2) s.gradient = { type: 'linear', angle: 90, stops }; }
      if (css.fontSize && /px$/.test(css.fontSize)) { const z = parseFloat(css.fontSize); if (z > 0) s.size = base.sizeScale ? Math.round(z / base.sizeScale * 100) / 100 : z; }
      const block = /^(div|p|li)$/.test(tag);
      if (block && runs.length && !/\n$/.test(runs[runs.length - 1].text)) runs.push({ ...st, text: '\n' });
      for (const k of node.childNodes) walk(k, s);
    };
    for (const k of root.childNodes) walk(k, {});
    const out = norm(runs); let text = plain(out);
    return { text, runs: hasStyle(out) ? out : null };
  }
  function toHex(c) {
    if (!c) return null; c = String(c).trim();
    if (/^#[0-9a-f]{6}$/i.test(c)) return c.toUpperCase(); if (/^#[0-9a-f]{3}$/i.test(c)) return ('#' + c.slice(1).split('').map(x => x + x).join('')).toUpperCase();
    const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(c); if (m) return '#' + [m[1], m[2], m[3]].map(v => (+v).toString(16).padStart(2, '0')).join('').toUpperCase();
    return null;
  }
  // Replace words in runs the way replaceText does on plain text (matches inside one run; runs rejoin after).
  function replace(runs, re, repl, count) {
    const out = runs.map(r => ({ ...r, text: String(r.text).replace(re, () => { count.n++; return repl; }) }));
    return norm(out);
  }
  return { STYLE_KEYS, norm, plain, hasStyle, isRich, fontOf, parse, markup, textOf, wrap, lineWidth, widestLine, transformed, toHTML, fromDOM, replace, boldWeight, toHex };
})();
