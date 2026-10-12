/* A finished deck in, a Deck-mode outline out. The deck's words are read slide by slide (Google Slides' text through
   the Drive connector, or a .pptx with its pictures), then each slide is sorted into what the layout engine draws: a
   title, a subtitle, cards, steps, two columns, a big number, a quote, a paragraph. Claude does the sorting and the
   condensing when it is at hand (the viewer's claude.ai account, or an API key), a few slides per request; rules do
   it otherwise, keeping the deck's own words. Each new slide keeps its source slide's number and pictures. */
const DeckDigest = (() => {
  const sp = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const cut = (s, n) => { s = sp(s); if (s.length <= n) return s; const c = s.slice(0, n - 1); const i = c.lastIndexOf(' '); return (i > n * 0.6 ? c.slice(0, i) : c).replace(/[\s,;:.–—-]+$/, '') + '…'; };
  const words = s => sp(s).split(' ').filter(Boolean).length;
  const NUM = /^(?:[~≈<>]\s?)?[$€£¥]?\s?\d[\d,.]*\s?(?:%|\+|x|×|k|K|m|M|bn|BN|B|pp|pts)?\+?$/;
  const NUM_LEAD = /^((?:[~≈<>]\s?)?[$€£¥]?\d[\d,.]*\s?(?:%|\+|x|×|k|K|m|M|bn|BN|B)?\+?)\s+(?:[-–—:]\s*)?([A-Za-z].{2,90})$/;
  const IGNORE = /\bignore (?:anything|everything|all|the rest)\b.{0,40}\b(?:from|after|below|beyond|forwards?|onwards?)\b/i;

  // ---- Reading ---------------------------------------------------------------------------------------------------------
  // Google Drive's text for a Slides file: slides between "-----" rules, the title as "# …", Markdown escapes.
  const unescape = s => String(s).replace(/(?:&#11;)+/g, ' ').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&').replace(/\\([\\`*_{}[\]()#+\-.!<>|&$~])/g, '$1');
  function fromText(text, docTitle) {
    const slides = [];
    for (const chunk of String(text || '').split(/^\s*-{5,}\s*$/m)) {
      const lines = chunk.split('\n').map(l => unescape(l).trim()).filter(Boolean); if (!lines.length) continue;
      let title = ''; const out = [];
      for (const l of lines) {
        const h = /^#{1,6}\s+(.*)$/.exec(l);
        if (h) { const t = sp(h[1]); if (!title) title = t; else if (t) out.push({ text: t, head: true }); }
        else { const li = /^(?:[-*•]|\d+[.)])\s+/.test(l); const t = sp(l.replace(/^[-*•]\s+/, '')); if (t) out.push({ text: t, list: li }); }
      }
      slides.push({ n: slides.length + 1, title, lines: out, images: [] });
    }
    return { title: sp(docTitle) || (slides[0] && slides[0].title) || 'Deck', slides, pictures: false };
  }
  // A .pptx read by PptxImport: words in reading order (title first), tables as "a | b" rows, and the slide's own
  // pictures (not logos and backgrounds that repeat on many slides, not small icons).
  function fromPptx(res, name) {
    const n = res.slides.length; const area = res.W * res.H;
    const uses = new Map(); for (const sl of res.slides) for (const a of new Set(sl.blocks.filter(b => b.kind === 'image' && b.asset).map(b => b.asset))) uses.set(a, (uses.get(a) || 0) + 1);
    const textOf = b => b.kind === 'list' ? (b.items || []).map(it => sp(typeof it === 'string' ? it : it && (it.text || it.title))).filter(Boolean) : String(b.text != null ? b.text : '').split('\n').map(sp).filter(Boolean);
    const slides = res.slides.map((sl, i) => {
      const B = sl.blocks; const byId = new Map(B.map(b => [b.id, b]));
      const inCell = b => { let p = b.parent && byId.get(b.parent); while (p) { if (p.label === 'cell') return true; p = p.parent && byId.get(p.parent); } return false; };
      const texts = B.filter(b => (b.kind === 'text' || b.kind === 'list') && !inCell(b)).sort((a, b) => Math.abs(a.y - b.y) < 12 ? a.x - b.x : a.y - b.y);
      const sizes = texts.map(b => (b.font && b.font.size) || 16).sort((a, b) => a - b); const med = sizes[Math.floor(sizes.length / 2)] || 16;
      let head = texts.find(b => b.role === 'headline' && textOf(b).length);
      if (!head) { const big = texts.filter(b => b.kind === 'text' && ((b.font && b.font.size) || 0) >= med * 1.25 && textOf(b).join(' ').length <= 160).sort((a, b) => b.font.size - a.font.size)[0]; head = big || null; }
      const lines = [];
      for (const b of texts) {
        if (b === head) continue; const size = (b.font && b.font.size) || med;
        for (const t of textOf(b)) { if (/^\d{1,3}$/.test(t) && size <= med) continue; lines.push({ text: t, list: b.kind === 'list', big: size >= med * 1.6, size }); }
      }
      // tables: boxes holding "row" boxes holding "cell" boxes (the table box carries the shape's own name)
      for (const t of B.filter(b => b.kind === 'box' && B.some(r => r.parent === b.id && r.label === 'row'))) {
        for (const r of B.filter(x => x.parent === t.id && x.label === 'row')) {
          const cells = B.filter(c => c.parent === r.id && c.label === 'cell').map(c => B.filter(x => x.parent === c.id && x.kind === 'text').map(x => textOf(x).join(' ')).join(' '));
          if (cells.some(Boolean)) lines.push({ text: cells.map(sp).join(' | '), table: true });
        }
      }
      const pics = B.filter(b => b.kind === 'image' && b.asset && !b.decorative && b.w * b.h >= area * 0.035 && (uses.get(b.asset) || 0) < Math.max(3, n * 0.4)).sort((a, b) => b.w * b.h - a.w * a.h);
      return { n: i + 1, title: head ? textOf(head).join(' ') : '', lines, images: [...new Set(pics.map(b => b.asset))].slice(0, 2), drawn: drawnOf(B, head, textOf) };
    });
    // words that repeat on many slides are a footer ("Confidential", the company name), not content
    const seen = new Map(); for (const s of slides) for (const t of new Set(s.lines.map(l => l.text))) seen.set(t, (seen.get(t) || 0) + 1);
    const limit = Math.max(3, n * 0.4); for (const s of slides) s.lines = s.lines.filter(l => (seen.get(l.text) || 0) < limit);
    return { title: sp(name).replace(/\.pptx$/i, '') || (slides[0] && slides[0].title) || 'Deck', slides, pictures: true };
  }
  // Shapes joined by connectors or arrows, or a run of chevrons, are a drawn diagram: what each shape says and where it sits.
  function drawnOf(B, head, textOf) {
    const links = B.filter(b => b.connector || /arrow|chevron|homePlate|connector|^line$/i.test(b.geom || '')).length;
    const nodes = B.filter(b => b.kind === 'box' && (b.geom || (b.fill && b.fill !== 'none') || b.stroke) && !(head && head.parent === b.id))
      .map(b => ({ parts: B.filter(x => x.parent === b.id && (x.kind === 'text' || x.kind === 'list')).flatMap(textOf), x: b.x + b.w / 2, y: b.y + b.h / 2, geom: b.geom || '' }))
      .filter(x => x.parts.length && x.parts.join(' ').length <= 200);
    const chevrons = nodes.filter(x => /chevron|homePlate|arrow/i.test(x.geom)).length;
    if (nodes.length < 3 || nodes.length > 12 || (links < 2 && chevrons < 3)) return null;
    return { links, chevrons, nodes };
  }
  // The deck as it should be rebuilt: nothing after a slide that says to ignore the rest, no empty slides.
  function prune(deck) {
    let slides = deck.slides; const stop = slides.findIndex(s => IGNORE.test(s.title + ' ' + s.lines.map(l => l.text).join(' ')));
    const ignored = stop >= 0 ? slides.length - stop : 0; if (stop >= 0) slides = slides.slice(0, stop);
    const empty = slides.filter(s => !s.title && !s.lines.length).length;
    slides = slides.filter(s => s.title || s.lines.length).map((s, i) => ({ ...s, k: i }));
    return { ...deck, slides, ignored, empty };
  }

  // ---- Rules: each slide sorted by what is on it ---------------------------------------------------------------------------
  const pairOf = t => { const m = /^(.{2,48}?)\s*(?::|\s[–—-])\s+(.{3,})$/.exec(t); return m ? { title: sp(m[1]), text: sp(m[2]) } : null; };
  // A slide that is a structure is drawn as one. Shapes from a .pptx: a ring is a cycle, one shape over rows of more is a
  // tree, a rising diagonal a staircase, a 2 by 2 a matrix (a cycle when arrows join it), anything else a flow in reading order.
  function diagramFromDrawn(d) {
    const N = d.nodes; const xs = N.map(x => x.x), ys = N.map(x => x.y);
    const sx = Math.max(...xs) - Math.min(...xs) || 1, sy = Math.max(...ys) - Math.min(...ys) || 1;
    const rows = []; const tol = Math.max(24, sy * 0.12);
    for (const x of [...N].sort((a, b) => a.y - b.y)) { const r = rows.find(r => Math.abs(r.y - x.y) <= tol); if (r) r.list.push(x); else rows.push({ y: x.y, list: [x] }); }
    rows.forEach(r => r.list.sort((a, b) => a.x - b.x));
    const node = x => { const p = x.parts.length === 1 ? pairOf(x.parts[0]) : null; return p ? { label: p.title, text: p.text, parent: -1 } : { label: x.parts[0], text: x.parts.slice(1).join(' '), parent: -1 }; };
    const cx = xs.reduce((a, b) => a + b, 0) / N.length, cy = ys.reduce((a, b) => a + b, 0) / N.length;
    const ds = N.map(x => Math.hypot((x.x - cx) / sx, (x.y - cy) / sy)); const dmin = Math.min(...ds), dmax = Math.max(...ds);
    const angle = x => (Math.atan2((x.y - cy) / sy, (x.x - cx) / sx) + Math.PI / 2 + Math.PI * 4) % (Math.PI * 2);
    let type = 'flow', order = rows.flatMap(r => r.list), parents = null;
    if (N.length === 4 && rows.length === 2 && rows.every(r => r.list.length === 2)) { if (d.links >= 3) { type = 'cycle'; order = [rows[0].list[0], rows[0].list[1], rows[1].list[1], rows[1].list[0]]; } else type = 'matrix'; }
    else if (N.length >= 4 && rows.length >= 3 && dmin > 0.25 && dmax - dmin < 0.3 * dmax) { type = 'cycle'; order = [...N].sort((a, b) => angle(a) - angle(b)); }
    else if (rows.length >= 2 && rows[0].list.length === 1 && rows.some(r => r.list.length >= 2)) {
      type = 'tree'; parents = new Map();
      for (let k = 1; k < rows.length; k++) for (const x of rows[k].list) parents.set(x, rows[k - 1].list.reduce((b, p) => Math.abs(p.x - x.x) < Math.abs(b.x - x.x) ? p : b));
    }
    else if (rows.length === N.length && N.length >= 3 && [...N].sort((a, b) => a.x - b.x).every((x, k, a) => k === 0 || (x.y < a[k - 1].y && x.x - a[k - 1].x > sx * 0.1))) { type = 'staircase'; order = [...N].sort((a, b) => a.x - b.x); }
    const nodes = order.map(node);
    if (parents) order.forEach((x, k) => { const p = parents.get(x); if (p) nodes[k].parent = order.indexOf(p); });
    if (type === 'flow' && nodes.filter(x => MARK.test(x.label)).length >= Math.max(2, nodes.length - 1)) type = 'timeline';
    return { type, nodes, used: new Set(N.flatMap(x => x.parts)) };
  }
  // In words: numbered milestones, phases or stages (or years and quarters) in order are a timeline, each with the text
  // under it; a line that chains three or more steps with arrows is a flow.
  const MARK = /^((milestone|phase|stage|step|wave|horizon|release|sprint|year|month|week|day)\s*\d+\b|q[1-4]\s*(fy)?\s*'?\d{2,4}\b|h[12]\s*(fy)?\s*'?\d{2,4}\b|(fy\s?)?(19|20)\d{2}\b)/i;
  function diagramFromLines(lines) {
    const marks = []; const lead = [], tail = []; let cur = null;
    for (const l of lines) {
      const m = MARK.exec(l);
      if (m) { const p = pairOf(l); cur = l.length <= 60 && !p ? { label: l, text: '' } : p ? { label: p.title, text: p.text } : { label: m[0], text: sp(l.slice(m[0].length).replace(/^[\s:–—-]+/, '')) }; cur.lines = [l]; marks.push(cur); }
      else if (cur && (!cur.text || l.length <= 150) && !tail.length) { cur.text = sp(cur.text + ' ' + l); cur.lines.push(l); }
      else if (cur) tail.push(l); else lead.push(l);
    }
    if (marks.length >= 3 && marks.length <= 8 && marks.filter(x => x.text).length >= marks.length - 1)
      return { type: 'timeline', nodes: marks.map(x => ({ label: x.label, text: x.text, parent: -1 })), used: new Set(marks.flatMap(x => x.lines)), lead, tail };
    for (const l of lines) {
      const parts = l.split(/\s*(?:→|->|=>|⟶|➜|➔)\s*/).map(sp).filter(Boolean);
      if (parts.length >= 3 && parts.length <= 6 && parts.every(x => x.length <= 48)) return { type: 'flow', nodes: parts.map(x => ({ label: x, text: '', parent: -1 })), used: new Set([l]), lead: lines.filter(x => x !== l), tail: [] };
    }
    return null;
  }
  function slideByRules(s, i, n, deck, opts = {}) {
    const lines = s.lines.map(l => l.text); const all = lines.join(' ');
    let title = s.title; if (!title && lines.length && lines[0].length <= 90) title = lines.shift();
    const headline = cut(title || deck.title, 110);
    const base = { source: s.n, images: s.images, headline };
    const t = (title || '').toLowerCase();
    // a slide led by a number is that number's slide
    if (i > 0 && NUM.test(title || '') && lines.length <= 4) return { ...base, intent: 'stat', stat: cut(title, 14), headline: cut(lines[0] || '', 90), subhead: cut(lines.slice(1).join(' '), 140) };
    if (i === 0) return { ...base, intent: 'cover', headline: cut(title || deck.title, 90), subhead: cut(lines[0] || '', 160) };
    if (i === n - 1 && /\b(thank|questions|q ?& ?a|contact|next steps?|get in touch|let'?s talk|get started)\b/.test(t)) return { ...base, intent: 'closing', subhead: cut(lines.find(l => !/@|https?:/.test(l)) || '', 140), cta: cut(lines.find(l => /@|https?:\/\/|www\./.test(l)) || '', 40) };
    if (/^(agenda|contents|table of contents|overview|today|what we('|’)ll cover|outline|topics)\b/.test(t) && lines.length >= 2) return { ...base, intent: 'agenda', items: lines.slice(0, 8).map(l => ({ title: cut(l, 60), text: '' })) };
    const q = lines.findIndex(l => /^[“"‘]/.test(l) && l.length >= 30);
    if (q >= 0) return { ...base, intent: 'quote', quote: cut(lines[q].replace(/^[“"‘]+|[”"’]+$/g, ''), 220), attribution: cut((lines[q + 1] || '').replace(/^[—–~-]\s*/, ''), 60) };
    const dg = (s.drawn && diagramFromDrawn(s.drawn)) || diagramFromLines(lines);
    if (dg) {
      // what the diagram does not hold leads it (a short line) or goes to the speaker notes, never lost
      const rest = dg.lead ? dg.lead : lines.filter(l => !dg.used.has(l)); const lead = rest.join(' '); const tail = (dg.tail || []).join(' ');
      const long = dg.nodes.some(x => x.label.length > 32 || x.text.length > 160);
      return { ...base, intent: 'diagram', diagram: { type: dg.type, nodes: dg.nodes.slice(0, 8).map(x => ({ ...x, label: cut(x.label, 32), text: cut(x.text, 160) })) }, subhead: lead.length <= 200 ? lead : '', notes: [lead.length > 200 ? lead : '', tail, long || dg.nodes.length > 8 ? dg.nodes.map(x => x.label + (x.text ? ': ' + x.text : '')).join('\n') : ''].filter(Boolean).join('\n\n') };
    }
    const rows = s.lines.filter(l => l.table).map(l => l.text.split(' | ').map(sp));
    if (rows.length >= 2) {
      const w = rows[0].length;
      if (w === 2 || w === 3) { const off = w - 2; return { ...base, intent: 'comparison', columns: [1, 2].map(c => ({ title: cut(rows[0][c - 1 + off] || '', 40), bullets: rows.slice(1, 5).map(r => cut(off ? `${r[0]}: ${r[c]}` : r[c - 1], 80)).filter(Boolean) })) }; }
      return { ...base, intent: 'cards', items: rows.slice(1, 7).map(r => ({ title: cut(r[0], 32), text: cut(r.slice(1).join(' · '), 110) })) };
    }
    // a long slide with headed parts (short heading lines followed by text) stays whole as sections
    if (opts.keepText !== false && words(all) > 90) {
      const secs = []; let cur = null;
      for (const l of lines) { if (l.length <= 48 && !/[.!?]$/.test(l) && !/^\d/.test(l)) { cur = { title: l, text: '', bullets: [] }; secs.push(cur); } else { if (!cur) { cur = { title: '', text: '', bullets: [] }; secs.push(cur); } if (l.length > 140 && !cur.bullets.length && !cur.text) cur.text = l; else cur.bullets.push(l); } }
      const good = secs.filter(x => x.text || x.bullets.length);
      if (good.length >= 2 && good.length <= 6) return { ...base, intent: 'sections', sections: good.map(x => ({ title: cut(x.title, 40), text: cut(x.text, 420), bullets: x.bullets.slice(0, 6).map(b => cut(b, 200)) })) };
      if (good.length === 1 || words(all) > 140) return { ...base, intent: 'sections', body: cut(all, 1400) };
    }
    const nums = lines.map(l => NUM.test(l) ? { stat: l, text: '' } : (() => { const m = NUM_LEAD.exec(l); return m ? { stat: m[1], text: m[2] } : null; })()).filter(Boolean);
    if (nums.length === 1 && lines.length <= 4) { const other = lines.filter(l => !l.startsWith(nums[0].stat)); return { ...base, intent: 'stat', stat: cut(nums[0].stat, 14), headline: cut(nums[0].text || title || other[0] || '', 90), subhead: cut(other.join(' '), 140) }; }
    if (nums.length >= 2 && nums.length <= 6 && nums.length >= lines.length / 2) return { ...base, intent: 'cards', items: nums.map(x => ({ title: cut(x.stat, 16), text: cut(x.text, 90) })) };
    // a short label followed by its text, repeated: steps when the slide is about a sequence, cards otherwise
    const pairs = []; for (let j = 0; j < lines.length; j++) { const p = pairOf(lines[j]); if (p && p.title.length <= 48) { pairs.push(p); continue; } if (lines[j].length <= 48 && !/[.!?]$/.test(lines[j]) && lines[j + 1] && lines[j + 1].length > 48) { pairs.push({ title: lines[j], text: lines[j + 1] }); j++; } }
    const sequence = /\b(process|how it works|steps?|timeline|roadmap|phases?|journey|milestones?|plan)\b/.test(t) || pairs.filter(p => /^(step|phase|milestone|stage|p)\s*\d|^\d+[.)]|^#\d/i.test(p.title)).length >= 2;
    if (/\b(vs\.?|versus|before|after|compar|pros|cons|old way|new way)\b/.test(t) && pairs.length >= 2) { const h = Math.ceil(pairs.length / 2); return { ...base, intent: 'comparison', columns: [pairs.slice(0, h), pairs.slice(h)].map(g => ({ title: cut(g[0].title, 40), bullets: g.map(p => cut(p.text, 80)).slice(0, 4) })) }; }
    if (pairs.length >= 2 && pairs.length <= 6) return sequence ? { ...base, intent: 'process', steps: pairs.map(p => ({ title: cut(p.title, 32), text: cut(p.text, 100) })) } : { ...base, intent: 'cards', items: pairs.map(p => ({ title: cut(p.title, 32), text: cut(p.text, 110) })) };
    if (lines.length >= 2 && lines.length <= 6 && lines.every(l => l.length <= 70)) return { ...base, intent: sequence ? 'process' : 'cards', [sequence ? 'steps' : 'items']: lines.map(l => ({ title: cut(l, 60), text: '' })) };
    if (words(all) <= 30) return { ...base, intent: 'statement', headline: cut(title || lines.shift() || deck.title, 110), subhead: cut(lines.join(' '), 140) };
    return { ...base, intent: 'body', body: cut(all, 360) };
  }
  // Headlines the way the brand writes them (the rules path; Claude follows the writing rules itself): Title Case
  // becomes sentence case, end punctuation and trailing dots go. Words the deck capitalizes mid-sentence elsewhere
  // (names, places, products), acronyms and anything with digits keep their capitals.
  function properNouns(deck) {
    const keep = new Set(['deel', 'i']); const lower = new Set(), mid = new Set(); const core = w => w.replace(/^[^A-Za-z]+|[^A-Za-z']+$/g, '');
    for (const sl of deck.slides) for (const l of sl.lines) {
      const ws = l.text.split(/\s+/); for (const w of ws) if (/^[a-z]/.test(core(w))) lower.add(core(w).toLowerCase());
      // a line in Title Case says nothing about which words are names
      if (ws.filter(w => /^[A-Z][a-z]/.test(core(w))).length > ws.length * 0.5) continue;
      for (let i = 1; i < ws.length; i++) { const w = core(ws[i]); if (w && /^[A-Z][a-z]/.test(w) && !/[.!?:]$/.test(ws[i - 1])) mid.add(w.toLowerCase()); }
    }
    for (const w of mid) if (!lower.has(w)) keep.add(w);
    return keep;
  }
  function polish(t, keep) {
    let s = sp(t).replace(/\s*(\.{2,}|…)+$/, '').replace(/[.!]+$/, '').trim(); if (!s) return s;
    const ws = s.split(' '); const caps = ws.filter(w => /^[A-Z][a-z]/.test(w.replace(/^[^A-Za-z]+/, ''))).length;
    if (ws.length < 3 || caps < Math.max(2, ws.length * 0.6)) return s;
    return ws.map((w, i) => { const core = w.replace(/^[^A-Za-z]+|[^A-Za-z']+$/g, ''); if (i === 0 || !core || /[A-Z].*[A-Z]/.test(core) || /\d/.test(w) || keep.has(core.toLowerCase()) || /^Deel$/i.test((ws[i - 1] || '').replace(/[^A-Za-z]/g, ''))) return w; return /^[A-Z][a-z]/.test(core) ? w.replace(core, core.toLowerCase()) : w; }).join(' ');
  }
  function polishSlide(sl, keep) {
    sl.headline = polish(sl.headline, keep);
    for (const k of ['items', 'steps']) if (sl[k]) sl[k] = sl[k].map(x => ({ ...x, title: polish(x.title, keep) }));
    if (sl.sections) sl.sections = sl.sections.map(x => ({ ...x, title: polish(x.title, keep) }));
    if (sl.columns) sl.columns = sl.columns.map(c => ({ ...c, title: polish(c.title, keep) }));
    return sl;
  }
  function rules(deck0, opts = {}) {
    const deck = prune(deck0); const n = deck.slides.length; const keep = properNouns(deck);
    const slides = deck.slides.map((s, i) => slideByRules(s, i, n, deck, opts)).map(finish).map(sl => polishSlide(sl, keep));
    return { title: deck.title, slides, source: 'deck', by: 'rules', from: { title: deck.title, slides: deck0.slides.length, used: n, ignored: deck.ignored, pictures: deck.pictures } };
  }
  // Every outline slide carries every field the engine reads, so nothing falls back to the brand's sample copy.
  function finish(o, k) {
    const s = { intent: Engine.SLIDE_INTENTS.includes(o.intent) ? o.intent : 'body', eyebrow: sp(o.eyebrow), headline: sp(o.headline), subhead: sp(o.subhead), body: sp(o.body), quote: sp(o.quote), attribution: sp(o.attribution), stat: sp(o.stat), cta: sp(o.cta), source: o.source, images: o.images || [], section: String(k + 1).padStart(2, '0') };
    const pairs = a => (Array.isArray(a) ? a : []).map(x => typeof x === 'string' ? { title: sp(x), text: '' } : { title: sp(x && x.title), text: sp(x && x.text) }).filter(x => x.title || x.text);
    if (o.items && o.items.length) s.items = pairs(o.items).slice(0, 8);
    if (o.steps && o.steps.length) s.steps = pairs(o.steps).slice(0, 6);
    if (o.bullets && o.bullets.length) s.bullets = o.bullets.map(sp).filter(Boolean).slice(0, 8);
    if (Array.isArray(o.sections) && o.sections.length) s.sections = o.sections.slice(0, 6).map(x => ({ title: sp(x && x.title), text: sp(x && x.text), bullets: (x && Array.isArray(x.bullets) ? x.bullets : []).map(sp).filter(Boolean).slice(0, 10) })).filter(x => x.title || x.text || x.bullets.length);
    if (o.diagram && typeof Diagram !== 'undefined') { const d = Diagram.norm(o.diagram); if (d) s.diagram = d; }
    if (o.columns && o.columns.length) s.columns = o.columns.slice(0, 2).map(c => ({ title: sp(c && c.title), bullets: (c && Array.isArray(c.bullets) ? c.bullets : []).map(sp).filter(Boolean).slice(0, 5) }));
    if (s.intent === 'quote' && !s.quote) { s.intent = 'statement'; }
    if (s.intent === 'stat' && !s.stat) s.intent = 'statement';
    if ((s.intent === 'cards' || s.intent === 'agenda') && !(s.items && s.items.length)) s.intent = s.body ? 'body' : 'statement';
    if (s.intent === 'process' && !(s.steps && s.steps.length)) s.intent = s.body ? 'body' : 'statement';
    if (s.intent === 'comparison' && !(s.columns && s.columns.length === 2)) s.intent = s.body ? 'body' : 'statement';
    if (s.intent === 'sections' && !(s.sections && s.sections.length) && String(o.body || '').length < 240) s.intent = s.body ? 'body' : 'statement';
    if (s.intent === 'diagram' && !s.diagram) s.intent = s.items && s.items.length ? 'cards' : s.body ? 'body' : 'statement';
    if (o.notes) s.notes = String(o.notes).slice(0, 2000);
    return s;
  }
  // Tighter copy for a slide nothing could be laid out for.
  function shorten(o) {
    const s = JSON.parse(JSON.stringify(o));
    s.headline = cut(s.headline, 64); s.subhead = cut(s.subhead, 90); s.body = cut(s.body, 180); s.quote = cut(s.quote, 140); s.eyebrow = cut(s.eyebrow, 24);
    if (s.items) s.items = s.items.slice(0, 4).map(x => ({ title: cut(x.title, 26), text: cut(x.text, 70) }));
    if (s.steps) s.steps = s.steps.slice(0, 4).map(x => ({ title: cut(x.title, 26), text: cut(x.text, 70) }));
    if (s.columns) s.columns = s.columns.map(c => ({ title: cut(c.title, 28), bullets: c.bullets.slice(0, 3).map(b => cut(b, 56)) }));
    if (s.bullets) s.bullets = s.bullets.slice(0, 4).map(b => cut(b, 60));
    if (s.sections) s.sections = s.sections.slice(0, 4).map(x => ({ title: cut(x.title, 32), text: cut(x.text, 220), bullets: (x.bullets || []).slice(0, 4).map(b => cut(b, 110)) }));
    if (s.diagram) s.diagram = { ...s.diagram, nodes: s.diagram.nodes.slice(0, 8).map(x => ({ ...x, label: cut(x.label, 28), text: cut(x.text, 50) })) };
    return s;
  }

  // ---- Claude: a few slides per request ----------------------------------------------------------------------------------------
  const FIELDS = 'intent, eyebrow, headline, subhead, body, items [{title, text}], steps [{title, text}], columns [{title, bullets}], sections [{title, text, bullets}], diagram {type, nodes [{label, text, parent}]}, quote, attribution, stat, cta, notes';
  function promptFor(batch, deck, kit, first, last, opts = {}) {
    const keep = opts.keepText !== false;
    const drawnNote = s => { if (!s.drawn) return ''; const d = diagramFromDrawn(s.drawn); return `(drawn on the slide as a diagram: ${s.drawn.nodes.length} shapes${s.drawn.links ? ` joined by ${s.drawn.links} connectors or arrows` : ''}, laid out like a ${d.type})\n`; };
    const src = batch.map(s => `### Slide ${s.n}${s.title ? `: ${s.title}` : ''}${s.images.length ? ` (has ${s.images.length} picture${s.images.length > 1 ? 's' : ''})` : ''}\n` + drawnNote(s) + s.lines.map(l => (l.table ? '| ' : l.list ? '- ' : l.head ? '## ' : '') + l.text).join('\n').slice(0, 6000)).join('\n\n');
    return `You turn slides from an existing presentation into an outline for a brand layout engine that redraws every slide in the ${kit.name} brand. The presentation is "${deck.title}".

Return one outline slide for each source slide below, in the same order, each with "source" set to its slide number. ${keep ? 'Keep dense slides whole: a text-heavy slide (an executive summary, a page of sections) becomes one "sections" slide that keeps all its points, lightly edited for clarity, rather than being cut or split.' : 'A very dense source slide may become two outline slides with the same "source".'} A slide that only repeats the previous one may be left out.

Intents and the fields each uses:
- cover: eyebrow (≤ 24 chars), headline (≤ 70), subhead (≤ 140)
- agenda: headline, items (3 to 8, title ≤ 50, text "")
- statement: headline (≤ 90) and subhead (≤ 140). Section dividers and single big ideas.
- stat: stat (the number as written, e.g. "$2M", "1.5-2x", "+40%"), headline as its caption (≤ 70), subhead (≤ 140)
- comparison: headline, exactly 2 columns, each a title (≤ 30) and 2 to 4 bullets (≤ 70)
- process: headline, 3 to 6 steps (title ≤ 32, text ≤ 90). A short sequence of how-to steps.
- cards: headline, 2 to 6 items (title ≤ 32, text ≤ 110). Parallel points, pillars, options, several numbers (the number as the title).
- quote: quote (≤ 200), attribution
- sections: headline, optional subhead (a one-line lede), 2 to 6 sections, each a title (≤ 40) with text (a short paragraph) and/or bullets. For text-heavy slides${keep ? ' the presenter wants kept whole: keep every point' : ''}.
- diagram: headline, optional subhead, diagram {type, nodes}. Use it whenever the slide is a structure, drawn or written: a slide marked "drawn on the slide as a diagram", numbered milestones, phases or dated steps (timeline, even when each has a sentence), a team or org structure (tree), a loop (cycle), tiers or price bands (staircase or pyramid), a 2 by 2 (matrix), a chain joined by arrows (flow). Prefer it to process, cards and sections for these. Types: flow (a sequence or cause → effect, 2 to 6 nodes), cycle (a loop, 3 to 8), tree (an org chart or hierarchy: nodes with "parent" set to the index of their parent node, root first), timeline (dated or numbered milestones, 2 to 8), mindmap (one central idea, node 0, with branches whose parent is 0), pyramid (layers, top first), staircase (rising tiers, e.g. price bands, lowest first), matrix (four quadrants). Node label ≤ 32, text ≤ 70 (≤ 160 on slides kept whole).
- body: headline, body (≤ 360). Only when nothing above fits.
- closing: headline, subhead, cta (≤ 30)
${first ? 'The first source slide is the cover: its headline is the presentation\'s own title as that slide shows it, and its subtitle the subhead.' : ''}${last ? ' If the last source slide ends the talk (thanks, questions, next steps) it is the closing.' : ''}

Vary the intents where the content allows (a key number as a stat slide, a sequence as a process, two sides as a comparison, a section title as a statement): cards should not be most of the deck.
${typeof Brand !== 'undefined' && Brand.voiceText(kit) ? Brand.voiceText(kit) + '\n' : ''}Rules: keep the presentation's own facts, numbers, names and terms; ${keep ? 'on slides that are not kept whole, ' : ''}condense long text to what a slide can hold (it is read in seconds) and put the detail you cut, in full sentences, in "notes" for the speaker; never invent facts or numbers; fix obvious typos; sentence case headlines; no emojis, no exclamation marks. Unused fields are "" or [].

Reply with only JSON: {"slides":[{"source":2,"intent":"stat","eyebrow":"","headline":"…","subhead":"","body":"","items":[],"steps":[],"columns":[],"sections":[],"diagram":null,"quote":"","attribution":"","stat":"$2M","cta":"","notes":"…"}]}
Fields: ${FIELDS}.

Source slides:

${src}`;
  }
  function batches(slides) { const out = []; let cur = [], size = 0; for (const s of slides) { const n = s.lines.reduce((t, l) => t + l.text.length, s.title.length); if (cur.length && (cur.length >= 6 || size + n > 9000)) { out.push(cur); cur = []; size = 0; } cur.push(s); size += n; } if (cur.length) out.push(cur); return out; }
  // ask(prompt) -> parsed JSON. Batches go two at a time; one that fails falls back to rules for its slides.
  async function withClaude(deck0, kit, ask, onProgress, opts = {}) {
    const deck = prune(deck0); const n = deck.slides.length; const groups = batches(deck.slides);
    const results = new Array(groups.length); let done = 0, failed = 0, next = 0, stop = null;
    const runOne = async () => { if (next < groups.length) await step(); };
    const run = async () => { while (next < groups.length) await step(); };
    const step = async () => {
      {
        const gi = next++; const g = groups[gi];
        // once Claude is declined or out of turns, the rest goes by rules at once
        try {
          if (stop) throw stop;
          const res = await ask(promptFor(g, deck, kit, gi === 0, gi === groups.length - 1, opts));
          const list = (res && Array.isArray(res.slides) ? res.slides : Array.isArray(res) ? res : []).filter(x => x && typeof x === 'object');
          const own = new Set(g.map(s => s.n));
          const ok = list.filter(x => own.has(+x.source)).map(x => ({ ...x, source: +x.source, images: (g.find(s => s.n === +x.source) || {}).images || [] }));
          if (!ok.length) throw new Error('no slides came back');
          results[gi] = ok;
        } catch (e) { failed++; if (e && ['not_granted', 'rate_limited', 'unavailable', 'capability_disabled'].includes(e.code)) stop = e; if (e !== stop) console.warn('deck digest batch', e); results[gi] = g.map(s => slideByRules(s, s.k, n, deck, opts)); }
        done++; if (onProgress) onProgress(done, groups.length, g);
      }
    };
    // the first request goes alone (in claude.ai it is the one that asks the viewer's permission), then two at a time
    await runOne(); await Promise.all([run(), run()]);
    const keep = properNouns(deck); const slides = results.flat().map(finish).map(sl => polishSlide(sl, keep));
    if (slides.length && slides[0].intent !== 'cover') slides[0].intent = 'cover';
    return { title: deck.title, slides, source: 'deck', by: failed === groups.length ? 'rules' : 'claude', failed, from: { title: deck.title, slides: deck0.slides.length, used: n, ignored: deck.ignored, pictures: deck.pictures } };
  }
  // Tolerant JSON out of a reply: the whole text, else from the first { to the last }.
  function parseJSON(text) { try { return JSON.parse(text); } catch { } const a = text.indexOf('{'), b = text.lastIndexOf('}'); if (a >= 0 && b > a) return JSON.parse(text.slice(a, b + 1)); throw new Error('Claude did not reply with JSON'); }
  return { fromText, fromPptx, prune, rules, withClaude, shorten, parseJSON, _promptFor: promptFor };
})();
