/* Brand kits: the contract between a design system and the engine.
   A kit is plain JSON, so any design system that can be described this way can be run through the engine. */
const Brand = (() => {
  const FONTS = {
    'Bricolage Grotesque': { css: '"Bricolage Grotesque", "Inter", system-ui, sans-serif', weights: [300, 400, 500, 600, 700, 800], kind: 'display', note: 'stand-in for Bagoss (humanist, has width axis)' },
    'Inter':               { css: '"Inter", system-ui, -apple-system, sans-serif', weights: [400, 500, 600, 700], kind: 'body' },
    'Fraunces':            { css: '"Fraunces", Georgia, serif', weights: [300, 400, 500, 600, 700, 900], kind: 'display' },
    'Manrope':             { css: '"Manrope", system-ui, sans-serif', weights: [400, 500, 700, 800], kind: 'both' },
    'Schibsted Grotesk':   { css: '"Schibsted Grotesk", system-ui, sans-serif', weights: [400, 500, 700, 900], kind: 'both' },
    'Instrument Serif':    { css: '"Instrument Serif", Georgia, serif', weights: [400], kind: 'display' },
    'IBM Plex Mono':       { css: '"IBM Plex Mono", ui-monospace, monospace', weights: [400, 500], kind: 'both' },
  };
  const customFonts = {}; // name -> {css, weights, buffer, mime}

  function fontCss(name) { return (FONTS[name] || customFonts[name] || { css: `"${name}", sans-serif` }).css; }
  function fontWeights(name) { return (FONTS[name] || customFonts[name] || { weights: [400, 700] }).weights; }
  function allFontNames() { return [...Object.keys(FONTS), ...Object.keys(customFonts)]; }

  // Roles: core (can be a background or a big field), accent (small pops, CTAs), background (calm grounds), neutral (text-only)
  const PRESETS = {
    deel: {
      name: 'Deel',
      note: 'Core palette and type roles from the Deel Brand Guidelines (2026). Hex values were read from the PDF; confirm against the Figma library before production use.',
      colors: [
        { name: 'Acai',       hex: '#5938B8', role: 'core' },
        { name: 'Blueberry',  hex: '#004999', role: 'core' },
        { name: 'Deelberry',  hex: '#201147', role: 'background' },
        { name: 'Slate',      hex: '#191A25', role: 'background' },
        { name: 'Smoothie',   hex: '#C4B1F7', role: 'accent' },
        { name: 'Seltzer',    hex: '#B1D8FF', role: 'accent' },
        { name: 'Tangelo',    hex: '#ED5E2C', role: 'accent' },
        { name: 'Cornbread',  hex: '#FFCF26', role: 'accent' },
        { name: 'Latte',      hex: '#FEF0D9', role: 'background' },
        { name: 'White',      hex: '#FFFFFF', role: 'background' },
        { name: 'Black',      hex: '#000000', role: 'neutral' },
      ],
      logo: { kind: 'wordmark', text: 'deel.', allowedColors: ['#5938B8', '#000000', '#FFFFFF'], monochrome: true, clearZone: 1.0, minPx: 20 },
      // Variants: the wordmark is kit.logo itself; the others can each take their own uploaded SVG or PNG.
      logos: [
        { id: 'wordmark', name: 'Wordmark' },
        { id: 'symbol', name: 'Symbol', kind: 'wordmark', text: 'd.' },
        { id: 'appicon', name: 'App icon', kind: 'appicon', text: 'd.', bg: '#5938B8', fg: '#FFFFFF' },
        { id: 'lockup', name: 'Product lockup', kind: 'lockup', text: 'deel.', product: 'Payroll' },
      ],
      fonts: { display: 'Bricolage Grotesque', body: 'Inter', displayWeight: 600, bodyWeight: 400, headlineCase: 'sentence', tracking: -0.025 },
      grid: { unit: 8, marginRatio: 0.06, gutterUnits: 3, radius: 1 },
      shapes: ['circle', 'pill', 'quarter'],
      content: {
        eyebrow: 'Deel Global Payroll',
        headline: 'Run payroll in 150+ countries from one platform',
        subhead: 'Owned infrastructure, 2,000+ local experts, and AI that takes action inside your workflows.',
        body: 'Consolidate vendors, close payroll faster, and keep every entity compliant without adding headcount.',
        cta: 'Book a demo',
        stat: '150+',
        footer: 'deel.com',
      },
      deck: {
        title: 'Deel Global Payroll',
        slides: [
          { intent: 'cover', eyebrow: 'Deel Global Payroll', headline: 'Global payroll, run from one platform', subhead: 'Payroll, HR, and compliance for teams in 150+ countries.' },
          { intent: 'agenda', headline: 'What we will cover', items: ['Why now', 'What Deel Global Payroll does', 'How it works', 'Proof', 'Before and after', 'Next steps'] },
          { intent: 'statement', eyebrow: 'Why now', headline: 'Most companies run five payroll vendors. One system can\'t cover them all.', subhead: 'Every new country adds a provider, a process, and a place for errors to hide.' },
          { intent: 'cards', eyebrow: 'What you get', headline: 'One platform, four things done for you', items: [
            { title: 'Owned infrastructure', text: 'No third-party processors. Faster fixes and total accountability.', icon: 'bank' },
            { title: 'Local experts', text: '2,000+ in-house specialists across 150+ countries.', icon: 'users-three' },
            { title: 'AI that takes action', text: 'Approvals, anomalies, and reports handled inside the workflow.', icon: 'sparkle' },
            { title: 'Compliance built in', text: 'Local tax logic and real-time checks on every run.', icon: 'shield-check' },
          ] },
          { intent: 'process', eyebrow: 'How it works', headline: 'From first entity to first payslip in four steps', steps: [
            { title: 'Connect your HRIS', text: 'Sync people, contracts, and pay data.' },
            { title: 'Map entities and pay groups', text: 'Local rules applied automatically.' },
            { title: 'Run and approve', text: 'One calendar, one approval flow.' },
            { title: 'Pay and report', text: 'Payslips, filings, and reporting in 200+ currencies.' },
          ] },
          { intent: 'stat', stat: '150+', headline: 'Countries where Deel runs payroll on its own rails', subhead: 'With 200+ currencies and in-house entities.' },
          { intent: 'comparison', headline: 'Before and after', columns: [
            { title: 'Vendor patchwork', bullets: ['Five providers on average', 'Manual reconciliation every cycle', 'Compliance gaps surface late'] },
            { title: 'Deel Global Payroll', bullets: ['One platform, one payroll engine', 'Automated reconciliation', 'Real-time compliance checks'] },
          ] },
          { intent: 'quote', quote: 'Deel enables us to hire and support exceptional talent anywhere.', attribution: 'Mati Staniszewski, CEO, ElevenLabs' },
          { intent: 'closing', headline: 'Let\'s run your next payroll together', subhead: 'Book a 30-minute walkthrough with a payroll specialist.', cta: 'Book a demo', footer: 'deel.com' },
        ],
      },
    },
    mono: {
      name: 'Editorial Mono',
      note: 'A neutral, type-led kit to show the engine is design-system agnostic.',
      colors: [
        { name: 'Ink',    hex: '#111111', role: 'core' },
        { name: 'Paper',  hex: '#F3EFE6', role: 'background' },
        { name: 'Signal', hex: '#D64526', role: 'accent' },
        { name: 'Stone',  hex: '#C9C2B4', role: 'accent' },
        { name: 'White',  hex: '#FFFFFF', role: 'background' },
      ],
      logo: { kind: 'wordmark', text: 'FOLIO', allowedColors: ['#111111', '#FFFFFF', '#D64526'], monochrome: true, clearZone: 1.0, minPx: 20 },
      fonts: { display: 'Fraunces', body: 'Manrope', displayWeight: 500, bodyWeight: 400, headlineCase: 'sentence', tracking: -0.02 },
      grid: { unit: 8, marginRatio: 0.08, gutterUnits: 2, radius: 0 },
      shapes: [],
      content: {
        eyebrow: 'Issue 14',
        headline: 'The quiet return of the printed annual report',
        subhead: 'Why finance teams are putting their numbers back on paper.',
        body: 'A 12-page reading on the design of trust, from typography to binding.',
        cta: 'Read the issue',
        stat: '12',
        footer: 'folio.studio',
      },
      deck: {
        title: 'Issue 14',
        slides: [
          { intent: 'cover', eyebrow: 'Issue 14', headline: 'The quiet return of the printed annual report', subhead: 'Why finance teams are putting their numbers back on paper.' },
          { intent: 'statement', headline: 'Trust is a typeface', subhead: 'What a page communicates before anyone reads it.' },
          { intent: 'cards', headline: 'Three things print still does better', items: [{ title: 'Sequence', text: 'A report read in order makes an argument.' }, { title: 'Permanence', text: 'Paper cannot be quietly edited after the board meeting.' }, { title: 'Attention', text: 'Twelve pages hold a reader longer than twelve tabs.' }] },
          { intent: 'quote', quote: 'We printed 400 copies and the questions in the AGM changed.', attribution: 'CFO, listed manufacturer' },
          { intent: 'closing', headline: 'Read the issue', cta: 'Read the issue', footer: 'folio.studio' },
        ],
      },
    },
    pastel: {
      name: 'Sprout',
      note: 'A playful kit with rounded shapes and bright grounds.',
      colors: [
        { name: 'Moss',   hex: '#1F5A3C', role: 'core' },
        { name: 'Lime',   hex: '#C5F35A', role: 'accent' },
        { name: 'Peach',  hex: '#FFC8A2', role: 'background' },
        { name: 'Cream',  hex: '#FFF7E6', role: 'background' },
        { name: 'Plum',   hex: '#3A1F4A', role: 'core' },
        { name: 'White',  hex: '#FFFFFF', role: 'background' },
      ],
      logo: { kind: 'wordmark', text: 'sprout', allowedColors: ['#1F5A3C', '#FFFFFF', '#3A1F4A'], monochrome: true, clearZone: 1.0, minPx: 20 },
      fonts: { display: 'Schibsted Grotesk', body: 'Manrope', displayWeight: 900, bodyWeight: 500, headlineCase: 'sentence', tracking: -0.03 },
      grid: { unit: 8, marginRatio: 0.06, gutterUnits: 3, radius: 3 },
      shapes: ['circle', 'pill', 'blob'],
      content: {
        eyebrow: 'New',
        headline: 'Plants that forgive you',
        subhead: 'Low-light, low-effort greenery delivered monthly.',
        body: 'Pick a plan, skip a month whenever, cancel in two taps.',
        cta: 'Start for $12',
        stat: '3 min',
        footer: 'sprout.plants',
      },
      deck: {
        title: 'Sprout',
        slides: [
          { intent: 'cover', eyebrow: 'New', headline: 'Plants that forgive you', subhead: 'Low-light, low-effort greenery delivered monthly.' },
          { intent: 'process', headline: 'How it works', steps: [{ title: 'Pick a plan', text: 'Three sizes, one price each.' }, { title: 'Meet your plant', text: 'Delivered potted, with a care card.' }, { title: 'Skip or swap', text: 'Any month, in two taps.' }] },
          { intent: 'stat', stat: '3 min', headline: 'Weekly care time, measured by our members' },
          { intent: 'cards', headline: 'Why members stay', items: [{ title: 'Forgiving species', text: 'Chosen for low light and missed waterings.' }, { title: 'Real support', text: 'Text a plant person, get an answer the same day.' }, { title: 'Fair pricing', text: 'From $12 a month, cancel anytime.' }] },
          { intent: 'closing', headline: 'Start with one plant', cta: 'Start for $12', footer: 'sprout.plants' },
        ],
      },
    },
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function fromPreset(id) { const p = clone(PRESETS[id] || PRESETS.deel); p.presetId = id; return p; }

  // Approved color pairs for a kit: backgrounds with readable foregrounds and accents.
  function pairs(kit) {
    const colors = kit.colors.map(c => ({ ...c, hex: Color.normalize(c.hex) }));
    const bgs = colors.filter(c => c.role === 'core' || c.role === 'background');
    const out = [];
    for (const bg of bgs) {
      const fgs = colors.filter(c => c.hex !== bg.hex && Color.contrast(bg.hex, c.hex) >= 4.5).map(c => c.hex);
      const fgFallback = Color.bestForeground(bg.hex, fgs, 4.5);
      const accents = colors.filter(c => c.hex !== bg.hex && (c.role === 'accent' || c.role === 'core') && Color.contrast(bg.hex, c.hex) >= 3).map(c => c.hex);
      const fields = colors.filter(c => c.hex !== bg.hex && (c.role === 'core' || c.role === 'accent') && Color.contrast(bg.hex, c.hex) >= 1.6).map(c => c.hex);
      out.push({ bg: bg.hex, bgName: bg.name, bgRole: bg.role, fgs: fgFallback, accents: accents.length ? accents : fgFallback, fields, dark: Color.isDark(bg.hex) });
    }
    return out;
  }

  // Logo handling ------------------------------------------------------------
  // kit.logo: {kind:'wordmark'|'svg'|'image', text?, svg?, dataUrl?, aspect, allowedColors, monochrome}
  function parseSvg(svgText) {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const svg = doc.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== 'svg') return null;
    let vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number).filter(n => !isNaN(n));
    let w = parseFloat(svg.getAttribute('width')), h = parseFloat(svg.getAttribute('height'));
    if (vb.length !== 4) vb = [0, 0, w || 100, h || 40];
    const aspect = vb[2] / vb[3];
    // Strip scripts and external refs for safety.
    doc.querySelectorAll('script, foreignObject').forEach(n => n.remove());
    const inner = svg.innerHTML;
    return { viewBox: vb.join(' '), aspect, inner };
  }
  // Logo variants: wordmark (kit.logo), a symbol, an app icon, a product lockup, or any uploaded SVG/PNG. Kits without
  // a list get the wordmark plus a symbol and an app icon made from its first letter.
  function logosOf(kit) {
    if (Array.isArray(kit.logos) && kit.logos.length) return kit.logos;
    const t = String((kit.logo && kit.logo.text) || kit.name || 'b').trim(); const first = t.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 1) || 'b';
    const core = (kit.colors.find(c => c.role === 'core') || kit.colors[0] || { hex: '#000000' }).hex;
    return [{ id: 'wordmark', name: 'Wordmark' }, { id: 'symbol', name: 'Symbol', kind: 'wordmark', text: first + (t.endsWith('.') ? '.' : '') }, { id: 'appicon', name: 'App icon', kind: 'appicon', text: first, bg: core, fg: '#FFFFFF' }];
  }
  function logoVariant(kit, id) {
    const list = logosOf(kit); const v = list.find(x => x.id === id) || list[0] || { id: 'wordmark' };
    if (v.id === 'wordmark' || !v.kind) return { ...kit.logo, id: 'wordmark', name: v.name || 'Wordmark' };
    return { allowedColors: kit.logo.allowedColors, monochrome: kit.logo.monochrome, clearZone: kit.logo.clearZone, ...v };
  }
  // Width over height of a variant at its drawn size (wordmarks are measured in the display font).
  function logoAspectOf(kit, v) {
    if (!v) v = kit.logo;
    if (v.kind === 'svg' && v.svg) return v.svg.aspect || 3;
    if (v.kind === 'image' && v.aspect) return v.aspect;
    if (v.kind === 'appicon') return 1;
    const f = { family: fontCss(kit.fonts.display), weight: 700, size: 100, letterSpacing: -0.04 };
    const w = (typeof Text !== 'undefined' ? Text.width(v.text || kit.name || 'brand', f) : 60 * String(v.text || '').length);
    if (v.kind === 'lockup') { const pf = { family: fontCss(kit.fonts.body), weight: 500, size: 62, letterSpacing: -0.01 }; return (w + 26 + (typeof Text !== 'undefined' ? Text.width(v.product || 'Product', pf) : 200)) / 74; }
    return w / 74;
  }
  // Return inner SVG markup recolored to `color` when monochrome is on.
  function logoInner(kit, color, variant) {
    const l = variant || kit.logo;
    if (l.kind !== 'svg' || !l.svg) return '';
    if (!l.monochrome) return l.svg.inner;
    let s = l.svg.inner;
    s = s.replace(/\sfill="(?!none)[^"]*"/g, ` fill="${color}"`);
    s = s.replace(/\sstroke="(?!none)[^"]*"/g, ` stroke="${color}"`);
    s = s.replace(/fill:\s*(?!none)[^;"']+/g, `fill:${color}`);
    s = s.replace(/stroke:\s*(?!none)[^;"']+/g, `stroke:${color}`);
    s = s.replace(/<(path|rect|circle|ellipse|polygon|polyline|g)(?![^>]*\sfill=)([^>]*)>/g, (m, tag, rest) => rest.includes('fill:') ? m : `<${tag} fill="${color}"${rest}>`);
    return s;
  }
  // Pick a logo color allowed by the brand for a given background.
  function logoColorFor(kit, bg) {
    const allowed = (kit.logo.allowedColors || []).map(Color.normalize);
    const ok = allowed.filter(c => Color.contrast(bg, c) >= 3).sort((a, b) => Color.contrast(bg, b) - Color.contrast(bg, a));
    if (ok.length) return ok;
    return [Color.contrast(bg, '#FFFFFF') > Color.contrast(bg, '#000000') ? '#FFFFFF' : '#000000'];
  }

  // Demo imagery: soft 3D-primitive renders (placeholders until real photos are dropped in).
  function makeDemoImage(seed, palette, w = 1200, h = 1200) {
    const rng = RNG.make(seed);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const bgA = rng.pick(palette), bgB = rng.pick(palette);
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, Color.mix(bgA, '#FFFFFF', 0.55)); g.addColorStop(1, Color.mix(bgB, '#000000', 0.15));
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    const n = rng.int(2, 4);
    for (let i = 0; i < n; i++) {
      const r = w * (0.12 + rng.next() * 0.22);
      const x = w * (0.15 + rng.next() * 0.7), y = h * (0.2 + rng.next() * 0.6);
      const col = rng.pick(palette);
      const rg = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
      rg.addColorStop(0, Color.mix(col, '#FFFFFF', 0.55)); rg.addColorStop(0.7, col); rg.addColorStop(1, Color.mix(col, '#000000', 0.35));
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.25)'; ctx.shadowBlur = r * 0.5; ctx.shadowOffsetY = r * 0.2;
      ctx.fillStyle = rg;
      if (rng.chance(0.5)) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
      else { const rr = r * 0.25; ctx.beginPath(); ctx.roundRect(x - r, y - r * 0.7, r * 2, r * 1.4, rr); ctx.fill(); }
      ctx.restore();
    }
    // brush stroke overlay
    ctx.globalAlpha = 0.25; ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = w * 0.02; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(w * 0.1, h * 0.8); ctx.bezierCurveTo(w * 0.4, h * 0.6, w * 0.6, h * 0.95, w * 0.9, h * 0.7); ctx.stroke();
    ctx.globalAlpha = 1;
    return c.toDataURL('image/jpeg', 0.86);
  }

  // Serialize a kit for download (logo image data included; fonts by name only).
  function serialize(kit) {
    const k = clone(kit);
    delete k.presetId;
    return JSON.stringify(k, null, 2);
  }

  return { FONTS, customFonts, fontCss, fontWeights, allFontNames, PRESETS, fromPreset, pairs, parseSvg, logoInner, logoColorFor, logosOf, logoVariant, logoAspectOf, makeDemoImage, serialize, clone };
})();
