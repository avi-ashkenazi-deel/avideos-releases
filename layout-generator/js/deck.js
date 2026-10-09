/* Deck mode: a brief becomes an outline (one intent per slide), the engine generates variations per slide
   under one palette and type level, you pick one per slide, and the picks export as one editable deck. */
const Deck = (() => {
  const INTENT_LABEL = { cover: 'Cover', agenda: 'Agenda', statement: 'Statement', stat: 'Big number', comparison: 'Comparison', process: 'Process', cards: 'Cards', quote: 'Quote', body: 'Body copy', closing: 'Closing' };
  const INTENT_KEYS = [
    [/\b(cover|title|intro|opening|welcome)\b/i, 'cover'], [/\b(agenda|contents|overview|what we.ll cover|toc)\b/i, 'agenda'],
    [/\b(problem|why now|challenge|context|statement|thesis|belief|pain)\b/i, 'statement'], [/\b(stat|number|metric|kpi|proof|results?|numbers)\b/i, 'stat'],
    [/\b(compar|versus|vs\.?|before and after|before\/after|alternative|old way)\b/i, 'comparison'], [/\b(process|how it works|steps?|timeline|roadmap|journey|workflow|phases?)\b/i, 'process'],
    [/\b(features?|benefits?|pillars?|cards?|what you get|solution|offer|pricing|plans?|team|values?|services?|products?)\b/i, 'cards'], [/\b(quote|testimonial|customer story|said|voice)\b/i, 'quote'],
    [/\b(closing|cta|next steps?|thank|contact|get started|call to action|end)\b/i, 'closing'], [/\b(detail|body|story|background|about|explain)\b/i, 'body'],
  ];
  const DEFAULT_STORY = ['cover', 'statement', 'cards', 'process', 'stat', 'comparison', 'quote', 'closing'];

  function intentFor(text, i, n) {
    for (const [re, intent] of INTENT_KEYS) if (re.test(text)) return intent;
    if (i === 0) return 'cover'; if (i === n - 1) return 'closing';
    return DEFAULT_STORY[1 + (i % (DEFAULT_STORY.length - 2))];
  }
  // Content for a slide from the kit's sample deck when the brief gives only an intent and a title.
  function sampleFor(kit, intent) {
    const sample = (kit.deck && kit.deck.slides || []).find(s => s.intent === intent);
    return sample ? { ...sample } : null;
  }
  function slideFromTitle(kit, title, intent) {
    const base = sampleFor(kit, intent) || {};
    const s = { ...base, intent };
    if (title) {
      if (intent === 'quote') { s.quote = base.quote || title; }
      else if (intent === 'stat') { const m = title.match(/(\d[\d,.]*\s*(?:\+|%|k|m|x)?)/); if (m) { s.stat = m[1].trim(); s.headline = title.replace(m[1], '').replace(/^\W+|\W+$/g, '') || base.headline; } else s.headline = title; }
      else s.headline = title;
    }
    if (!s.headline && intent !== 'quote') s.headline = kit.content.headline;
    if (intent === 'closing' && !s.cta) s.cta = kit.content.cta;
    if (intent === 'cover' && !s.eyebrow) s.eyebrow = kit.content.eyebrow;
    return s;
  }
  // Rule-based outline from the brief. Explicit lists ("cover, problem, how it works, pricing, cta") win.
  function outlineFromBrief(text, kit, opts = {}) {
    const raw = String(text || '').trim();
    let title = (kit.deck && kit.deck.title) || kit.name;
    const t = raw.toLowerCase();
    const cm = t.match(/\b(\d{1,2})[\s-]*(slides?|pages?|cards?)\b/);
    let n = cm ? Math.max(2, Math.min(16, +cm[1])) : null;
    let listPart = null;
    const colon = raw.split(/:(.+)/s);
    const looksLikeList = str => { const parts = str.split(/,|;|\n|\s→\s|\s->\s/).map(x => x.trim()).filter(Boolean); return parts.length >= 3 && parts.filter(p => INTENT_KEYS.some(([re]) => re.test(p))).length >= 2; };
    if (colon.length > 1 && colon[1].includes(',')) listPart = colon[1];
    else if (looksLikeList(raw)) listPart = raw;
    let slides = [];
    if (listPart) {
      const parts = listPart.split(/,|;|\n|\s→\s|\s->\s/).map(x => x.replace(/\b(then|and finally|finally|and)\b/gi, ' ').trim()).filter(x => x.length > 1);
      slides = parts.map((p, i) => slideFromTitle(kit, /^(cover|agenda|closing|cta|quote|stat|process|cards|comparison|statement)$/i.test(p) ? '' : p, intentFor(p, i, parts.length)));
      if (n && slides.length > n) slides = slides.slice(0, n);
    } else if (kit.deck && kit.deck.slides && kit.deck.slides.length) {
      slides = kit.deck.slides.map(s => ({ ...s }));
      // The brief is about something else than the sample deck: rename the product in every slide and
      // take cover and closing from the drafted copy. Body facts stay the sample's; Claude outline replaces them.
      const subject = opts.subject && String(opts.subject).trim();
      if (subject && kit.deck.title && !kit.deck.title.toLowerCase().includes(subject.toLowerCase()) && subject.toLowerCase() !== kit.name.toLowerCase()) {
        const re = new RegExp(kit.deck.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        const swap = v => typeof v === 'string' ? v.replace(re, subject) : Array.isArray(v) ? v.map(swap) : (v && typeof v === 'object') ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)])) : v;
        slides = slides.map(swap);
        const cover = slides.find(s => s.intent === 'cover'), closing = slides.find(s => s.intent === 'closing');
        if (cover) { cover.headline = kit.content.headline || cover.headline; cover.subhead = kit.content.subhead || cover.subhead; cover.eyebrow = kit.content.eyebrow || cover.eyebrow; }
        if (closing && kit.content.cta) closing.cta = kit.content.cta;
        title = subject;
      }
      if (n && slides.length > n) {
        const keep = new Set([0, slides.length - 1]);
        for (let k = 1; k < n - 1 && keep.size < n; k++) keep.add(Math.round(k * (slides.length - 1) / (n - 1)));
        for (let i = 1; i < slides.length - 1 && keep.size < n; i++) keep.add(i);
        slides = slides.filter((_, i) => keep.has(i));
      }
    } else {
      n = n || 6;
      slides = [];
      for (let i = 0; i < n; i++) { const intent = i === 0 ? 'cover' : i === n - 1 ? 'closing' : DEFAULT_STORY[1 + ((i - 1) % (DEFAULT_STORY.length - 2))]; slides.push(slideFromTitle(kit, '', intent)); }
    }
    slides.forEach((s, i) => { s.section = String(i + 1).padStart(2, '0'); });
    return { title, slides, source: 'rules' };
  }

  const OUTLINE_SCHEMA = {
    type: 'object', additionalProperties: false,
    properties: {
      title: { type: 'string' },
      slides: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        intent: { type: 'string', enum: Engine.SLIDE_INTENTS },
        eyebrow: { type: 'string' }, headline: { type: 'string' }, subhead: { type: 'string' }, body: { type: 'string' },
        bullets: { type: 'array', items: { type: 'string' } },
        items: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { title: { type: 'string' }, text: { type: 'string' } }, required: ['title', 'text'] } },
        steps: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { title: { type: 'string' }, text: { type: 'string' } }, required: ['title', 'text'] } },
        columns: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { title: { type: 'string' }, bullets: { type: 'array', items: { type: 'string' } } }, required: ['title', 'bullets'] } },
        quote: { type: 'string' }, attribution: { type: 'string' }, stat: { type: 'string' }, cta: { type: 'string' },
      }, required: ['intent', 'eyebrow', 'headline', 'subhead', 'body', 'bullets', 'items', 'steps', 'columns', 'quote', 'attribution', 'stat', 'cta'] } },
      summary: { type: 'string' },
    },
    required: ['title', 'slides', 'summary'],
  };
  async function outlineWithClaude(text, kit, apiKey) {
    const system = `You write presentation outlines for a layout engine. Return JSON that follows the schema exactly.
Intents and what each needs: cover (eyebrow, headline, subhead) · agenda (headline, items: titles of the other slides) · statement (headline ≤ 90 chars, subhead) · stat (stat like "150+" or "3 min", headline as its caption, subhead) · comparison (headline, exactly 2 columns with a title and 3 bullets each) · process (headline, 3 to 5 steps with title ≤ 32 chars and text ≤ 90 chars) · cards (headline, 3 to 4 items with title ≤ 32 chars and text ≤ 110 chars) · quote (quote ≤ 160 chars, attribution) · body (headline, body ≤ 300 chars) · closing (headline, subhead, cta).
Rules: first slide is a cover, last is a closing. 6 to 10 slides unless the brief says otherwise. Sentence case headlines, no exclamation marks, no emojis, active voice, concrete facts only from the brief and brand facts; never invent numbers. Fields a slide does not use must be empty strings or empty arrays. Write in the brand's voice.`;
    const brand = { name: kit.name, tagline: kit.content.subhead, products: kit.content.body, cta: kit.content.cta, sampleDeck: kit.deck ? kit.deck.slides.slice(0, 3) : null };
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 6000, system, messages: [{ role: 'user', content: `Brief:\n${text}\n\nBrand facts:\n${JSON.stringify(brand, null, 1)}` }], output_config: { effort: 'medium', format: { type: 'json_schema', schema: OUTLINE_SCHEMA } } }),
    });
    if (!res.ok) throw new Error(`Claude request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    if (data.stop_reason === 'refusal') throw new Error('Claude declined this brief.');
    const block = (data.content || []).find(b => b.type === 'text'); if (!block) throw new Error('No text in response');
    const parsed = JSON.parse(block.text);
    const slides = (parsed.slides || []).map((s, i) => { const o = { intent: s.intent, section: String(i + 1).padStart(2, '0') }; for (const [k, v] of Object.entries(s)) if (k !== 'intent' && v && (!Array.isArray(v) || v.length)) o[k] = v; return o; });
    return { title: parsed.title || kit.name, slides, source: 'claude', summary: parsed.summary };
  }

  // Generate variations for every slide under one palette and type level.
  // returns {palette, level, slides: [{index, outline, variations, pick}]}
  async function generate({ outline, kit, assets, format, baseIntent, perSlide = 6, seedBase, onProgress }) {
    const seed0 = seedBase >>> 0;
    const palette = Engine.palettePick(kit, baseIntent, seed0);
    const loud = baseIntent.loud ?? 0.5;
    const level = Math.max(1, Math.min(4, Math.round(loud * (Engine.H_LEVELS.length - 1))));
    const slides = [];
    let seed = seed0;
    for (let i = 0; i < outline.slides.length; i++) {
      const o = outline.slides[i];
      const content = { ...kit.content, eyebrow: '', subhead: '', body: '', stat: '', cta: '', footer: '', ...o };
      if (!content.eyebrow && o.intent !== 'cover' && o.intent !== 'closing' && o.intent !== 'quote') content.eyebrow = o.section ? `${o.section}` : '';
      if (o.intent === 'closing' && !content.footer) content.footer = kit.content.footer;
      const intent = { ...baseIntent, content, slideIntent: o.intent, lockPalette: palette, level, ctaAlways: o.intent === 'closing', includeCta: o.intent === 'closing' || o.intent === 'cover' ? baseIntent.includeCta !== false : false, logoPrefer: i === 0 ? null : ['TR', 'BR'] };
      const variations = []; const seen = new Set(); let attempts = 0;
      while (variations.length < perSlide && attempts < perSlide * 12) {
        seed = (seed + 0x9E3779B9) >>> 0; attempts++;
        const L = Engine.generate({ intent, kit, assets, format, seed });
        if (!L || seen.has(L.signature)) continue;
        seen.add(L.signature); L.deckIndex = i; variations.push(L);
      }
      slides.push({ index: i, outline: o, variations, pick: variations.length ? 0 : -1, attempts });
      if (onProgress) { onProgress(i + 1, outline.slides.length); await new Promise(r => setTimeout(r, 0)); }
    }
    return { palette, level, slides, format };
  }
  // Replace one slide's variations (new seed).
  async function reshuffle(deck, index, env) {
    const one = { ...env.outline, slides: [deck.slides[index].outline] };
    const res = await generate({ ...env, outline: one, seedBase: (Math.random() * 2 ** 32) >>> 0, baseIntent: { ...env.baseIntent }, perSlide: env.perSlide });
    // keep the deck's palette and level: regenerate with the lock
    const s = res.slides[0];
    deck.slides[index] = { ...s, index };
    return deck;
  }
  function picks(deck) { return deck.slides.map(s => s.pick >= 0 ? s.variations[s.pick] : null).filter(Boolean); }
  return { INTENT_LABEL, outlineFromBrief, outlineWithClaude, OUTLINE_SCHEMA, generate, reshuffle, picks, slideFromTitle };
})();
