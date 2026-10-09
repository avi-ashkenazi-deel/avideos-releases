/* Brief -> intent. A rule parser that runs everywhere, plus an optional Claude interpreter that emits the same JSON. */
const Prompt = (() => {
  const INTENT_SCHEMA = {
    type: 'object', additionalProperties: false,
    properties: {
      formats: { type: 'array', items: { type: 'string', enum: Grid.FORMATS.map(f => f.id) } },
      count: { type: 'integer' },
      loud: { type: 'number', description: '0 quiet/minimal .. 1 loud/bold type scale' },
      dark: { type: 'number', description: '-1 prefer light grounds, 0 no preference, 1 prefer dark grounds' },
      emphasis: { type: 'string', enum: ['image', 'type', 'balanced'] },
      density: { type: 'string', enum: ['sparse', 'medium', 'dense'] },
      archetypes: { type: 'array', items: { type: 'string', enum: Engine.ARCHETYPES } },
      includeLogo: { type: 'boolean' }, includeCta: { type: 'boolean' }, includeBody: { type: 'boolean' }, includeSubhead: { type: 'boolean' }, includeEyebrow: { type: 'boolean' },
      colorHints: { type: 'array', items: { type: 'string' }, description: 'brand color names mentioned' },
      content: { type: 'object', additionalProperties: false, properties: { headline: { type: 'string' }, subhead: { type: 'string' }, body: { type: 'string' }, cta: { type: 'string' }, eyebrow: { type: 'string' }, stat: { type: 'string' } } },
      summary: { type: 'string', description: 'one line: how the brief was read' },
    },
    required: ['formats', 'count', 'loud', 'dark', 'emphasis', 'density', 'archetypes', 'includeLogo', 'includeCta', 'includeBody', 'includeSubhead', 'includeEyebrow', 'colorHints', 'content', 'summary'],
  };
  const DEFAULT = () => ({ formats: ['square'], count: 96, loud: 0.5, dark: 0, emphasis: 'balanced', density: 'medium', archetypes: [], includeLogo: true, includeCta: true, includeBody: true, includeSubhead: true, includeEyebrow: true, colorHints: [], content: {}, summary: '' });

  const has = (t, words) => words.some(w => new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(t));

  function parse(text, kit) {
    const intent = DEFAULT();
    const raw = String(text || '');
    const t = raw.toLowerCase();
    const notes = [];
    // CTA and stat first, so their quoted values are not mistaken for the headline.
    const ctaM = raw.match(/\bcta\s*[:=]?\s*["“]?([^"”.,;\n]{2,40}?)["”]?(?=[.,;\n]|$)/i) || raw.match(/\bbutton\s*[:=]\s*["“]?([^"”.,;\n]{2,40}?)["”]?(?=[.,;\n]|$)/i);
    if (ctaM && !/^(?:yes|no|button|please|and|with)$/i.test(ctaM[1].trim())) intent.content.cta = ctaM[1].trim();
    const statM = raw.match(/\bstat(?:istic)?\s*[:=]\s*["“]?([^"”,;\n]{1,24})/i)
      || raw.match(/\bstat(?:istic)?\s+(?:of\s+|is\s+)?["“]?(\d[\d,.]*\s*(?:\+|%|k\b|m\b|x\b|countries|currencies|min\b|hrs?\b|days?\b)?(?:\s+[a-z]+)?)/i)
      || (has(t, ['stat', 'stats', 'number', 'figure', 'metric']) ? raw.match(/(\d[\d,.]*\s*(?:\+|%|countries|currencies|min\b|hrs?\b|days?\b))/i) : null);
    if (statM && statM[1] && !/^\d+$/.test(statM[1].trim())) intent.content.stat = statM[1].trim().replace(/["”]$/, '');
    // quoted copy
    const quotes = [...raw.matchAll(/["“”']([^"“”']{3,140})["“”']/g)].map(m => m[1].trim()).filter(q => q !== intent.content.cta && q !== intent.content.stat);
    if (quotes[0]) { intent.content.headline = quotes[0]; notes.push('headline from quotes'); }
    if (quotes[1]) intent.content.subhead = quotes[1];
    // formats
    const fm = Grid.detectFormats(t); if (fm.length) { intent.formats = fm; intent.formatsExplicit = true; notes.push('formats: ' + fm.join(', ')); }
    // count
    const cm = t.match(/\b(\d{1,3})\s*(variations?|options?|layouts?|versions?|ideas?|iterations?|directions?|cards?|posts?|slides?|takes?|concepts?|routes?)\b/) || t.match(/(?<![:x×\d.,])\b(\d{2,3})\b(?!\s*(%|\+|px|countries|currencies|:|x|×|\d))/);
    if (cm) { const c = parseInt(cm[1], 10); if (c >= 4 && c <= 500) { intent.count = c; intent.countExplicit = true; notes.push(c + ' variations'); } }
    // mood
    if (has(t, ['loud', 'bold', 'big', 'huge', 'massive', 'punchy', 'shout', 'statement', 'impact', 'oversized'])) intent.loud = 0.85;
    if (has(t, ['quiet', 'minimal', 'minimalist', 'calm', 'subtle', 'understated', 'elegant', 'refined', 'whisper', 'small type'])) { intent.loud = 0.2; intent.density = 'sparse'; }
    if (has(t, ['dark', 'night', 'moody', 'black', 'dark mode'])) intent.dark = 1;
    if (has(t, ['light', 'bright', 'white', 'airy', 'clean', 'paper'])) intent.dark = -1;
    if (has(t, ['sparse', 'whitespace', 'white space', 'breathing room', 'lots of space', 'headline only', 'just the headline', 'only headline'])) intent.density = 'sparse';
    if (has(t, ['dense', 'busy', 'packed', 'detailed', 'informative', 'lots of copy', 'more copy', 'full copy'])) intent.density = 'dense';
    // emphasis
    if (has(t, ['image-led', 'image led', 'photo', 'photos', 'photography', 'imagery', 'picture', 'hero image', 'visual', 'full-bleed', 'full bleed', 'render', 'product shot'])) intent.emphasis = 'image';
    if (has(t, ['type-led', 'type led', 'typographic', 'typography', 'text-led', 'text led', 'wordy', 'copy-led', 'type only', 'no image', 'no images', 'no photos', 'without images'])) intent.emphasis = 'type';
    // archetypes
    const arch = [];
    if (has(t, ['full-bleed', 'full bleed', 'overlay'])) arch.push('full-bleed');
    if (has(t, ['split', 'half and half', 'side by side', 'two halves'])) arch.push('split');
    if (has(t, ['mosaic', 'collage', 'grid of images', 'image grid', 'tiles'])) arch.push('mosaic');
    if (has(t, ['color block', 'colour block', 'color blocks', 'colour blocks', 'blocks', 'bauhaus', 'geometric'])) arch.push('color-block');
    if (has(t, ['editorial', 'magazine', 'article', 'long copy'])) arch.push('editorial');
    if (has(t, ['stat', 'stats', 'number', 'figure', 'metric', 'data point'])) arch.push('stat');
    if (has(t, ['poster', 'framed', 'framed image'])) arch.push('poster');
    if (has(t, ['type-led', 'typographic', 'headline only', 'pure type'])) arch.push('type-led');
    if (arch.length) { intent.archetypes = [...new Set(arch)]; notes.push('archetypes: ' + intent.archetypes.join(', ')); }
    // inclusions
    if (has(t, ['no logo', 'without logo', 'logoless'])) intent.includeLogo = false;
    if (has(t, ['no cta', 'without cta', 'no button', 'no call to action'])) intent.includeCta = false;
    if (has(t, ['with a cta', 'with cta', 'add a cta', 'button'])) intent.includeCta = true;
    if (has(t, ['no body', 'without body', 'no paragraph', 'headline only', 'just the headline'])) { intent.includeBody = false; if (has(t, ['headline only', 'just the headline'])) { intent.includeSubhead = false; intent.includeEyebrow = false; } }
    // brand color names
    for (const c of (kit?.colors || [])) { if (c.name && has(t, [c.name.toLowerCase()])) intent.colorHints.push(Color.normalize(c.hex)); }
    if (intent.colorHints.length) notes.push('colors: ' + intent.colorHints.length);
    intent.summary = notes.length ? notes.join(' · ') : 'defaults';
    return intent;
  }

  // Optional: ask Claude to turn the brief into the same constraint JSON.
  async function interpret(text, kit, apiKey) {
    const brandSummary = {
      name: kit.name,
      colors: kit.colors.map(c => `${c.name} ${Color.normalize(c.hex)} (${c.role})`),
      formats: Grid.FORMATS.map(f => `${f.id}: ${f.name} ${f.w}x${f.h}`),
      archetypes: Engine.ARCHETYPES,
      currentContent: kit.content,
    };
    const system = `You turn a creative brief into layout-engine constraints. Read the brief and the brand facts, then return JSON that follows the schema exactly.
Rules: pick formats only from the list (default ["square"]); count 12..360 (default 96); loud 0..1; dark -1..1; emphasis image|type|balanced; density sparse|medium|dense;
archetypes: leave empty unless the brief clearly asks for a composition family; colorHints must be hex values copied from the brand colors list when the brief names a brand color;
content: only fields the brief explicitly supplies (quoted copy, a CTA, a stat), otherwise leave them out. summary: one short line on how you read the brief.`;
    const body = {
      model: 'claude-opus-5-5', max_tokens: 2048,
      betas: undefined,
      system,
      messages: [{ role: 'user', content: `Brief:\n${text}\n\nBrand facts:\n${JSON.stringify(brandSummary, null, 1)}` }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: INTENT_SCHEMA } },
    };
    delete body.betas;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Claude request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    if (data.stop_reason === 'refusal') throw new Error('Claude declined this brief.');
    const textBlock = (data.content || []).find(b => b.type === 'text');
    if (!textBlock) throw new Error('No text in response');
    const parsed = JSON.parse(textBlock.text);
    const intent = { ...DEFAULT(), ...parsed, content: Object.fromEntries(Object.entries(parsed.content || {}).filter(([, v]) => v)) };
    intent.count = Math.max(12, Math.min(360, intent.count || 96));
    if (!intent.formats?.length) intent.formats = ['square'];
    intent.formatsExplicit = true; intent.countExplicit = intent.count !== 96;
    return intent;
  }
  // Ask Claude for copy that fits one layout: the schema carries the capacities.
  async function fillContent({ brief, kit, schema, current, apiKey, slideIntent }) {
    const system = `You write on-brand copy for a fixed layout. Return JSON that follows the schema exactly; every description states the character and line limits, and they are hard limits: shorter is fine, longer breaks the layout. Keep the meaning of the current copy unless the brief asks for something else. Sentence case headlines, no exclamation marks, no emojis, active voice, concrete and specific, no invented numbers. Brand: ${kit.name}. Voice: ${kit.note || 'clear, confident, human'}.`;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 2048, system, messages: [{ role: 'user', content: `Brief:\n${brief}\n\nSlide intent: ${slideIntent || 'single piece'}\n\nCurrent copy (reference):\n${JSON.stringify(current, null, 1)}` }], output_config: { effort: 'low', format: { type: 'json_schema', schema } } }),
    });
    if (!res.ok) throw new Error(`Claude request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    if (data.stop_reason === 'refusal') throw new Error('Claude declined this brief.');
    const block = (data.content || []).find(b => b.type === 'text'); if (!block) throw new Error('No text in response');
    return JSON.parse(block.text);
  }
  return { parse, interpret, fillContent, INTENT_SCHEMA, DEFAULT };
})();
