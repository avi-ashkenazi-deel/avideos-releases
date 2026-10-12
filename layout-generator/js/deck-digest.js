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
      return { n: i + 1, title: head ? textOf(head).join(' ') : '', lines, images: [...new Set(pics.map(b => b.asset))].slice(0, 2) };
    });
    // words that repeat on many slides are a footer ("Confidential", the company name), not content
    const seen = new Map(); for (const s of slides) for (const t of new Set(s.lines.map(l => l.text))) seen.set(t, (seen.get(t) || 0) + 1);
    const limit = Math.max(3, n * 0.4); for (const s of slides) s.lines = s.lines.filter(l => (seen.get(l.text) || 0) < limit);
    return { title: sp(name).replace(/\.pptx$/i, '') || (slides[0] && slides[0].title) || 'Deck', slides, pictures: true };
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
  function slideByRules(s, i, n, deck) {
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
    const rows = s.lines.filter(l => l.table).map(l => l.text.split(' | ').map(sp));
    if (rows.length >= 2) {
      const w = rows[0].length;
      if (w === 2 || w === 3) { const off = w - 2; return { ...base, intent: 'comparison', columns: [1, 2].map(c => ({ title: cut(rows[0][c - 1 + off] || '', 40), bullets: rows.slice(1, 5).map(r => cut(off ? `${r[0]}: ${r[c]}` : r[c - 1], 80)).filter(Boolean) })) }; }
      return { ...base, intent: 'cards', items: rows.slice(1, 7).map(r => ({ title: cut(r[0], 32), text: cut(r.slice(1).join(' · '), 110) })) };
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
  function rules(deck0) {
    const deck = prune(deck0); const n = deck.slides.length;
    const slides = deck.slides.map((s, i) => slideByRules(s, i, n, deck)).map(finish);
    return { title: deck.title, slides, source: 'deck', by: 'rules', from: { title: deck.title, slides: deck0.slides.length, used: n, ignored: deck.ignored, pictures: deck.pictures } };
  }
  // Every outline slide carries every field the engine reads, so nothing falls back to the brand's sample copy.
  function finish(o, k) {
    const s = { intent: Engine.SLIDE_INTENTS.includes(o.intent) ? o.intent : 'body', eyebrow: sp(o.eyebrow), headline: sp(o.headline), subhead: sp(o.subhead), body: sp(o.body), quote: sp(o.quote), attribution: sp(o.attribution), stat: sp(o.stat), cta: sp(o.cta), source: o.source, images: o.images || [], section: String(k + 1).padStart(2, '0') };
    const pairs = a => (Array.isArray(a) ? a : []).map(x => typeof x === 'string' ? { title: sp(x), text: '' } : { title: sp(x && x.title), text: sp(x && x.text) }).filter(x => x.title || x.text);
    if (o.items && o.items.length) s.items = pairs(o.items).slice(0, 8);
    if (o.steps && o.steps.length) s.steps = pairs(o.steps).slice(0, 6);
    if (o.bullets && o.bullets.length) s.bullets = o.bullets.map(sp).filter(Boolean).slice(0, 8);
    if (o.columns && o.columns.length) s.columns = o.columns.slice(0, 2).map(c => ({ title: sp(c && c.title), bullets: (c && Array.isArray(c.bullets) ? c.bullets : []).map(sp).filter(Boolean).slice(0, 5) }));
    if (s.intent === 'quote' && !s.quote) { s.intent = 'statement'; }
    if (s.intent === 'stat' && !s.stat) s.intent = 'statement';
    if ((s.intent === 'cards' || s.intent === 'agenda') && !(s.items && s.items.length)) s.intent = s.body ? 'body' : 'statement';
    if (s.intent === 'process' && !(s.steps && s.steps.length)) s.intent = s.body ? 'body' : 'statement';
    if (s.intent === 'comparison' && !(s.columns && s.columns.length === 2)) s.intent = s.body ? 'body' : 'statement';
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
    return s;
  }

  // ---- Claude: a few slides per request ----------------------------------------------------------------------------------------
  const FIELDS = 'intent, eyebrow, headline, subhead, body, items [{title, text}], steps [{title, text}], columns [{title, bullets}], quote, attribution, stat, cta, notes';
  function promptFor(batch, deck, kit, first, last) {
    const src = batch.map(s => `### Slide ${s.n}${s.title ? `: ${s.title}` : ''}${s.images.length ? ` (has ${s.images.length} picture${s.images.length > 1 ? 's' : ''})` : ''}\n` + s.lines.map(l => (l.table ? '| ' : l.list ? '- ' : l.head ? '## ' : '') + l.text).join('\n').slice(0, 6000)).join('\n\n');
    return `You turn slides from an existing presentation into an outline for a brand layout engine that redraws every slide in the ${kit.name} brand. The presentation is "${deck.title}".

Return one outline slide for each source slide below, in the same order, each with "source" set to its slide number. A very dense source slide may become two outline slides with the same "source"; a slide that only repeats the previous one may be left out.

Intents and the fields each uses:
- cover: eyebrow (≤ 24 chars), headline (≤ 70), subhead (≤ 140)
- agenda: headline, items (3 to 8, title ≤ 50, text "")
- statement: headline (≤ 90) and subhead (≤ 140). Section dividers and single big ideas.
- stat: stat (the number as written, e.g. "$1BN", "1.5-2x", "+237%"), headline as its caption (≤ 70), subhead (≤ 140)
- comparison: headline, exactly 2 columns, each a title (≤ 30) and 2 to 4 bullets (≤ 70)
- process: headline, 3 to 6 steps (title ≤ 32, text ≤ 90). Sequences, milestones, phases, timelines.
- cards: headline, 2 to 6 items (title ≤ 32, text ≤ 110). Parallel points, pillars, options, several numbers (the number as the title).
- quote: quote (≤ 200), attribution
- body: headline, body (≤ 360). Only when nothing above fits.
- closing: headline, subhead, cta (≤ 30)
${first ? 'The first source slide is the cover: its headline is the presentation\'s own title as that slide shows it, and its subtitle the subhead.' : ''}${last ? ' If the last source slide ends the talk (thanks, questions, next steps) it is the closing.' : ''}

Vary the intents where the content allows (a key number as a stat slide, a sequence as a process, two sides as a comparison, a section title as a statement): cards should not be most of the deck.
Rules: keep the presentation's own facts, numbers, names and terms; condense long text to what a slide can hold (it is read in seconds) and put the detail you cut, in full sentences, in "notes" for the speaker; never invent facts or numbers; fix obvious typos; sentence case headlines; no emojis, no exclamation marks. Unused fields are "" or [].

Reply with only JSON: {"slides":[{"source":2,"intent":"stat","eyebrow":"","headline":"…","subhead":"","body":"","items":[],"steps":[],"columns":[],"quote":"","attribution":"","stat":"$1BN","cta":"","notes":"…"}]}
Fields: ${FIELDS}.

Source slides:

${src}`;
  }
  function batches(slides) { const out = []; let cur = [], size = 0; for (const s of slides) { const n = s.lines.reduce((t, l) => t + l.text.length, s.title.length); if (cur.length && (cur.length >= 6 || size + n > 9000)) { out.push(cur); cur = []; size = 0; } cur.push(s); size += n; } if (cur.length) out.push(cur); return out; }
  // ask(prompt) -> parsed JSON. Batches go two at a time; one that fails falls back to rules for its slides.
  async function withClaude(deck0, kit, ask, onProgress) {
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
          const res = await ask(promptFor(g, deck, kit, gi === 0, gi === groups.length - 1));
          const list = (res && Array.isArray(res.slides) ? res.slides : Array.isArray(res) ? res : []).filter(x => x && typeof x === 'object');
          const own = new Set(g.map(s => s.n));
          const ok = list.filter(x => own.has(+x.source)).map(x => ({ ...x, source: +x.source, images: (g.find(s => s.n === +x.source) || {}).images || [] }));
          if (!ok.length) throw new Error('no slides came back');
          results[gi] = ok;
        } catch (e) { failed++; if (e && ['not_granted', 'rate_limited', 'unavailable', 'capability_disabled'].includes(e.code)) stop = e; if (e !== stop) console.warn('deck digest batch', e); results[gi] = g.map(s => slideByRules(s, s.k, n, deck)); }
        done++; if (onProgress) onProgress(done, groups.length, g);
      }
    };
    // the first request goes alone (in claude.ai it is the one that asks the viewer's permission), then two at a time
    await runOne(); await Promise.all([run(), run()]);
    const slides = results.flat().map(finish);
    if (slides.length && slides[0].intent !== 'cover') slides[0].intent = 'cover';
    return { title: deck.title, slides, source: 'deck', by: failed === groups.length ? 'rules' : 'claude', failed, from: { title: deck.title, slides: deck0.slides.length, used: n, ignored: deck.ignored, pictures: deck.pictures } };
  }
  // Tolerant JSON out of a reply: the whole text, else from the first { to the last }.
  function parseJSON(text) { try { return JSON.parse(text); } catch { } const a = text.indexOf('{'), b = text.lastIndexOf('}'); if (a >= 0 && b > a) return JSON.parse(text.slice(a, b + 1)); throw new Error('Claude did not reply with JSON'); }
  return { fromText, fromPptx, prune, rules, withClaude, shorten, parseJSON, _promptFor: promptFor };
})();
