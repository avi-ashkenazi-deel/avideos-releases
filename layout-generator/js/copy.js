/* Copy from the brief. The brief names a subject ("Akai", "the LATAM payroll webinar"), a message kind
   (launch, event, hiring, report, offer, quote, guide, feature, proof) and sometimes an audience, a date,
   an offer or a stat. This turns those into one coherent set of eyebrow, headline, subhead, body, CTA and
   stat without inventing facts. Quoted copy, "cta:" and "stat:" from the brief always win. Claude can
   rewrite the set later (Fill copy) when a key is set; this runs everywhere, including the published copy. */
const Copy = (() => {
  // Words that describe the layout request, not the thing being promoted.
  const PHRASES = ['image-led', 'image led', 'type-led', 'type led', 'text-led', 'text led', 'copy-led', 'full-bleed', 'full bleed', 'color block', 'colour block', 'color blocks', 'colour blocks', 'product shot', 'product shots', 'hero image', 'with a cta', 'with cta', 'add a cta', 'no cta', 'without cta', 'no button', 'no logo', 'without logo', 'no body', 'without body', 'no paragraph', 'headline only', 'just the headline', 'only headline', 'dark mode', 'white space', 'lots of space', 'breathing room', 'side by side', 'half and half', 'two halves', 'grid of images', 'image grid', 'long copy', 'more copy', 'lots of copy', 'full copy', 'data point', 'pure type', 'no image', 'no images', 'no photo', 'no photos', 'without images', 'call to action', 'in the style of', 'kind of', 'sort of', 'a bit', 'a lot of', 'lots of', 'a few', 'a couple of', 'a bunch of', 'a set of', 'a series of', 'social media', 'save the date', 'we are hiring', "we're hiring", 'join us', 'by the numbers', 'now available', 'brand new', 'in numbers'];
  const DROP = new Set(('square squares story stories linkedin twitter x slide slides portrait landscape poster posters banner banners post posts feed reel reels carousel carousels header thumbnail thumbnails tile tiles a4 letter instagram insta ig facebook fb tiktok youtube social socials ad ads advert adverts creative creatives asset assets graphic graphics visual visuals image images imagery photo photos photography picture pictures render renders deck decks presentation presentations template templates mockup mockups layout layouts design designs designed variation variations option options version versions idea ideas iteration iterations direction directions concept concepts route routes take takes set series campaign campaigns collection batch bunch lots lot few couple several some many more style styles look looks feel vibe vibes tone mood aesthetic format formats size sizes ' +
    'loud bold big huge massive punchy shout statement impact oversized quiet minimal minimalist calm subtle understated elegant refined whisper small dark night moody black light bright white airy clean paper sparse whitespace dense busy packed detailed informative wordy colorful colourful vibrant playful serious corporate fun ' +
    'hero overlay split half mosaic collage grid block blocks bauhaus geometric editorial magazine article typographic typography text type copy framed ' +
    'cta ctas button buttons logo logos stat stats number numbers figure figures metric metrics data headline headlines subhead tagline font fonts ' +
    'make making create creating generate generating give need needs want wants wanted show build draft produce get let lets please try do use using like love id wed im ' +
    'i me my mine we us our you your it its this that these those some something stuff things thing kind sort really very quite pretty super also too just only all every each any here there is are be am was were should would could can will going gonna ' +
    'introduce introducing announce announcing announcement announcements unveil unveiling promote promoting promotion celebrate celebrating featuring new now available ' +
    'about around regarding re of for with and or to in on at by from as into across per vs versus a an the').split(/\s+/));
  // Words that only name the message kind; dropped from the subject when that kind is detected.
  const KIND_DROP = {
    launch: 'launch launches launching launched release releasing released rollout debut', hiring: 'hiring recruiting careers career roles role openings vacancies',
    quote: 'quote quotes testimonial testimonials story stories case study studies customer customers', offer: 'promo promos discount discounts deal deals offer offers sale coupon pricing',
    guide: 'tips tip explainer', feature: 'feature features update updates shipped live', proof: 'proof milestone', event: '', report: '', generic: '',
  };
  // Connectors stay only when they sit between kept words ("payroll in LATAM").
  const JOIN = new Set('a an the of for in on at to with and or by from as into across per vs versus & + ×'.split(' '));
  const KINDS = [
    ['event', /\b(webinar|event|summit|conference|meetup|workshop|keynote|panel|fireside|live session|livestream|save the date|join us|register|roundtable|office hours|town ?hall|happy hour|demo day|launch party|ama)\b/i],
    ['report', /\b(report|research|survey|findings|benchmark\w*|whitepaper|white paper|ebook|e-book|state of|index|study)\b/i],
    ['hiring', /\b(hiring|we.?re hiring|join (the|our) team|careers?|open roles?|job openings?|recruit\w*|apply now|vacanc\w+)\b/i],
    ['offer', /\b(offer|discount|\d+ ?% off|free trial|free month|promo\w*|sale|deal|coupon|limited time)\b/i],
    ['quote', /\b(quote|testimonial|customer stor(y|ies)|case stud(y|ies)|success stor(y|ies)|in their words)\b/i],
    ['guide', /\b(how to|guide|tips?|lessons?|mistakes?|checklist|explainer|101|what is|ways to|steps to|playbook)\b/i],
    ['feature', /\b(feature|update|now supports?|improvement|integration|you can now|new in|just shipped|shipped|changelog|release notes|beta)\b/i],
    ['proof', /\b(milestone|results|growth|by the numbers|proof|record|customers)\b/i],
    ['launch', /\b(launch\w*|introduc\w*|announc\w*|unveil\w*|meet|now available|is here|release|rollout|roll out|debut|brand new|new)\b/i],
  ];
  const ROLE = /\b(engineers?|designers?|developers?|managers?|marketers?|recruiters?|accountants?|analysts?|leads?|specialists?|sales|writers?|interns?|researchers?|scientists?|architects?|consultants?|coordinators?|reps?|representatives?|directors?|heads?)\b/i;
  const AUD = /\b(?:for|to|aimed at|targeting)\s+((?:(?!for\b|to\b|with\b)[a-z][a-z-]*\s+){0,3}(?:teams?|leaders?|managers?|founders?|c[ef]os?|ctos?|coos?|heads of \w+|hr|people ops|people teams?|finance|payroll teams?|startups?|scale-?ups?|smbs?|enterprises?|companies|businesses|customers?|clients?|candidates?|employees?|contractors?|developers?|engineers?|recruiters?|marketers?|designers?|freelancers?|workers?|agencies|partners?|admins?|accountants?))\b/i;
  const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
  const DATE = new RegExp(`\\b(?:(?:mon|tue|tues|wed|wednes|thu|thur|thurs|fri|sat|satur|sun)(?:day)?,?\\s+)?(${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}(?:,?\\s+\\d{4})?|\\d{4}-\\d{2}-\\d{2})(?:,?\\s+(?:at\\s+)?(\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)(?:\\s*[a-z]{2,4})?))?`, 'i');
  const OFFER = /\b(\d+ ?% off|\$\d+ off|free (?:trial|month|year|for \w+ \w+)|buy one get one|\d+ months? free)\b/i;

  const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
  const titleish = s => s.split(' ').map(w => JOIN.has(w) ? w : cap(w)).join(' ');
  const clean = s => s.replace(/\s+/g, ' ').replace(/\s+([,.;:])/g, '$1').trim();

  // Subject: the longest useful phrase left after layout words, audience, date and offer are removed.
  function subjectOf(text, kit, kind = 'generic') {
    const drop = new Set([...DROP, ...(KIND_DROP[kind] || '').split(/\s+/).filter(Boolean)]);
    let t = ' ' + text + ' ';
    t = t.replace(/["“”][^"“”]*["“”]/g, ' ').replace(/'[^']{3,}'/g, ' ');
    t = t.replace(/\b(?:cta|button|stat(?:istic)?)\s*[:=]\s*[^,;.\n]*/gi, ' ');
    t = t.replace(DATE, ' ').replace(OFFER, ' ').replace(AUD, ' ');
    for (const p of PHRASES) t = t.replace(new RegExp(`(^|[^a-z])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[^a-z]|$)`, 'gi'), '$1 ');
    for (const c of (kit?.colors || [])) if (c.name && c.name.length > 2) t = t.replace(new RegExp(`(^|[^a-z])${c.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[^a-z]|$)`, 'gi'), '$1 ');
    t = t.replace(/\b\d{1,3}\s*(?:variations?|options?|layouts?|versions?|ideas?|iterations?|directions?|cards?|posts?|slides?|takes?|concepts?|routes?)\b/gi, ' ');
    t = t.replace(/\b\d{1,2}\s*[:x×]\s*\d{1,2}\b/g, ' ');
    const candidates = [];
    // Prepositional subject first ("posts for Akai", "launch of Akai", "about the LATAM webinar").
    const prep = /\b(?:for|about|on|around|promoting|announcing|introducing|launching|celebrating|featuring|covering|regarding)\s+(.+?)(?=\s*(?:,|;|\.|:|\n|$)|\s+(?:with|without|using|that|which|—|–)\s)/gi;
    let m; while ((m = prep.exec(t))) candidates.push(m[1]);
    const parts = t.split(/[,;:.\n]|\s[—–]\s|\s-\s/);
    const keep = c => {
      const words = c.split(/\s+/).map(w => w.replace(/^[^\w$&]+|[^\w%+&)]+$/g, '')).filter(Boolean);
      const kept = [];
      for (const w of words) {
        const lw = w.toLowerCase();
        if (JOIN.has(lw)) { if (kept.length) kept.push({ w, join: true }); continue; }
        if (drop.has(lw) || /^\d+$/.test(lw)) continue;
        kept.push({ w, join: false });
      }
      while (kept.length && kept[kept.length - 1].join) kept.pop();
      return kept;
    };
    // A prepositional phrase wins; otherwise the clause with the most content words.
    let best = null;
    for (const c of candidates) { const k = keep(c); if (k.length) { best = k; break; } }
    // "Akai, the AI assistant for HR teams": the name comes first, the description after the comma.
    if (!best && parts.length > 1 && /^\s*(?:a|an|the|our|your)\s/i.test(parts[1])) { const k = keep(parts[0]); if (k.length) best = k; }
    if (!best) for (const p of parts) { const k = keep(p); const n = k.filter(x => !x.join).length; if (n && (!best || n > best.filter(x => !x.join).length)) best = k; }
    if (!best) return null;
    let s = best.map(k => k.w).join(' ');
    if (s === s.toLowerCase() && !ROLE.test(s)) s = best.filter(k => !k.join).length <= 2 ? titleish(s) : cap(s);
    return s;
  }
  // "Akai, Deel's AI assistant that answers HR questions" → a subhead that states what it is.
  function descriptionOf(text, subject, brand) {
    const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const app = text.match(new RegExp(esc(subject) + "\\s*[,:—–-]\\s*((?:a|an|the|our|your|" + esc(brand) + "['’]?s?)\\s[^,.;\\n]{8,140})", 'i'));
    if (app) return cap(clean(app[1])) + '.';
    const rel = text.match(new RegExp(esc(subject) + "\\s+(?:that|which)\\s+([^,.;\\n]{8,140})", 'i'));
    if (rel) return cap(subject) + ' ' + clean(rel[1]) + '.';
    return '';
  }

  function kindOf(text, intent) {
    for (const [k, re] of KINDS) if (re.test(text)) return k;
    if (intent?.content?.stat) return 'proof';
    return 'generic';
  }

  // Template sets. Index i is one coherent phrasing; Rewrite moves to the next.
  function templates(kind, c) {
    const { s, S, brand, aud, date, offer } = c;
    const forAud = aud ? ` for ${aud}` : '';
    switch (kind) {
      case 'launch': return [
        { eyebrow: 'New', headline: `Meet ${s}`, subhead: `Now available${forAud} from ${brand}.`, body: `See what ${s} does, how it fits the way you already work, and how to get started today.`, cta: 'See it in action' },
        { eyebrow: 'Now available', headline: `${S} is here`, subhead: `The newest addition to ${brand}${aud ? `, built for ${aud}` : ''}.`, body: `We built ${s} with the people who use ${brand} every day. Here is what changes for you.`, cta: 'Take a look' },
        { eyebrow: 'Introducing', headline: `Introducing ${s}`, subhead: `A new way to work with ${brand}${aud ? `, made for ${aud}` : ''}.`, body: `${S} is rolling out now. Learn what it does and how to turn it on for your team.`, cta: 'Learn more' },
        { eyebrow: `New from ${brand}`, headline: `Say hello to ${s}`, subhead: `Now live in ${brand}.`, body: `Less setup, fewer handoffs, one place to see it all. Get started with ${s} in minutes.`, cta: 'Get started' },
      ];
      case 'event': return [
        { eyebrow: date ? `Live · ${date}` : 'Live event', headline: S, subhead: `${date ? date + '. ' : ''}Bring your questions${aud ? `, ${aud}` : ''}.`, body: `Hear what is working, what is not, and what to do next, from the people doing it.`, cta: 'Register now' },
        { eyebrow: date ? date : 'Join us', headline: `Join us: ${s}`, subhead: `Live${date ? ' on ' + date : ''}, with time for your questions.`, body: `We will walk through real examples, share what we have learned, and leave time for Q&A.`, cta: 'Save your seat' },
        { eyebrow: 'Webinar', headline: `${S}, live${date ? ' on ' + date : ''}`, subhead: `An hour with the team${forAud}.`, body: `Practical, specific, and short. Join live or get the recording afterwards.`, cta: 'Reserve a spot' },
        { eyebrow: date ? `Save the date · ${date}` : 'Save the date', headline: `Save your seat: ${s}`, subhead: `Free to attend. Recording for everyone who registers.`, body: `One session, the questions you actually have, and the people who can answer them.`, cta: 'Join the session' },
      ];
      case 'hiring': { const role = ROLE.test(s) && s.toLowerCase() !== brand.toLowerCase(); const team = aud && /\bteam\b/i.test(aud) ? aud : ''; const own = s.toLowerCase() === brand.toLowerCase(); return [
        { eyebrow: 'We are hiring', headline: role ? `We are hiring ${s}` : team ? `Join ${team}` : own ? `Come build with us` : `Come build ${s} with us`, subhead: team ? `Join ${team}, remote-first.` : `Remote-first roles${forAud}, open now.`, body: `See the open roles, how we work, and what to expect from the process.`, cta: 'See open roles' },
        { eyebrow: 'Careers', headline: role ? `${S}: come build with us` : team ? `${cap(team)} is growing` : own ? `Join the team behind ${brand}` : `Join the team behind ${s}`, subhead: `We are growing the team that makes ${brand} work.`, body: `Work from anywhere, with people who care about the craft.`, cta: 'View roles' },
        { eyebrow: `Careers at ${brand}`, headline: role ? `Calling all ${s}` : own ? `Help us build ${brand}` : `Help us build ${s}`, subhead: team ? `Open roles on ${team}.` : `Open roles across the company.`, body: `If you like hard problems and clear ownership, we would like to meet you.`, cta: 'Apply now' },
        { eyebrow: 'Open roles', headline: role ? `${brand} is hiring ${s}` : own ? `${brand} is hiring` : `${S} is hiring`, subhead: `Work from anywhere, with people who care about the craft.`, body: `See what we are building, who we are looking for, and how the process works.`, cta: 'Explore careers' },
      ]; }
      case 'report': return [
        { eyebrow: 'Report', headline: S, subhead: `The data${aud ? ` ${aud} need` : ''}, in one read.`, body: `We looked at the numbers behind ${s} and pulled out what matters. Read the findings and what they mean for your team.`, cta: 'Read the report' },
        { eyebrow: 'New research', headline: `${S}: what we found`, subhead: `What the numbers say, and what to do about it.`, body: `Fresh data, clear takeaways, and the trends to watch${forAud}.`, cta: 'Download the report' },
        { eyebrow: 'Data', headline: `New research: ${s}`, subhead: `Findings, trends, and takeaways${forAud}.`, body: `The full report covers what changed, why, and what leading teams are doing differently.`, cta: 'Get the findings' },
        { eyebrow: `${brand} research`, headline: `${S}, in numbers`, subhead: `Fresh data, clear takeaways.`, body: `Benchmarks, trends, and practical next steps, in one report.`, cta: 'Read the research' },
      ];
      case 'offer': return [
        { eyebrow: offer ? cap(offer) : 'Limited offer', headline: offer ? `${cap(offer)} ${s}` : `Save on ${s}`, subhead: `For a limited time${forAud}.`, body: `Get started with ${s} and see the difference in your first cycle.`, cta: 'Claim the offer' },
        { eyebrow: 'Offer', headline: `${S}, for less`, subhead: offer ? `${cap(offer)}, for a limited time.` : `A better deal, for a limited time.`, body: `Everything in ${s}, at a price that makes the decision easy.`, cta: 'Get the offer' },
        { eyebrow: 'Limited time', headline: offer ? `${S}: ${offer}` : `A better deal on ${s}`, subhead: `Start now, pay less${forAud}.`, body: `No long setup, no surprises. Start with ${s} today.`, cta: 'Start now' },
        { eyebrow: brand, headline: `Get started with ${s} today`, subhead: offer ? `${cap(offer)} when you start this month.` : `Simple pricing, no surprises.`, body: `See plans, compare what is included, and pick what fits.`, cta: 'See pricing' },
      ];
      case 'quote': return [
        { eyebrow: 'Customer story', headline: `What customers say about ${s}`, subhead: `Real teams, real results.`, body: `Read how teams use ${s} day to day, and what changed for them.`, cta: 'Read the story' },
        { eyebrow: 'In their words', headline: `In their words: ${s}`, subhead: `Why teams choose ${brand}.`, body: `Hear from the people who made the switch, in their own words.`, cta: 'Read their story' },
        { eyebrow: 'Case study', headline: `Why teams choose ${s}`, subhead: `The results, from the people who got them.`, body: `What they needed, what they tried, and what finally worked.`, cta: 'See the case study' },
        { eyebrow: brand, headline: `${S}, in their words`, subhead: `Stories from teams${forAud ? ' like yours' : ' using ' + brand}.`, body: `Honest accounts from customers on what ${s} changed for them.`, cta: 'Hear from customers' },
      ];
      case 'guide': { const asTitle = /^(how|why|what|when|where|which|who)\b/i.test(s); return [
        { eyebrow: 'Guide', headline: asTitle ? S : `How to get started with ${s}`, subhead: `A practical guide${forAud}.`, body: `Clear steps, common mistakes, and what good looks like.`, cta: 'Read the guide' },
        { eyebrow: 'How to', headline: asTitle ? S : `${S}: a practical guide`, subhead: `Everything you need to know, in one place.`, body: `From the basics to the details that trip people up${forAud}.`, cta: 'Get the guide' },
        { eyebrow: 'Explainer', headline: asTitle ? S : `${S}, explained`, subhead: `The short version${forAud}.`, body: `What it is, why it matters, and what to do next.`, cta: 'Read more' },
        { eyebrow: 'Playbook', headline: asTitle ? S : `What to know about ${s}`, subhead: `Lessons from teams who have done it.`, body: `The decisions that matter, in the order they come up.`, cta: 'Learn how' },
      ]; }
      case 'feature': return [
        { eyebrow: `New in ${brand}`, headline: `New in ${brand}: ${s}`, subhead: `Now live for every account${forAud}.`, body: `Here is what ${s} does, where to find it, and how to switch it on.`, cta: "See what's new" },
        { eyebrow: 'Product update', headline: `${S}, now in ${brand}`, subhead: `A small change with a big effect on your week.`, body: `Fewer clicks, fewer handoffs. See how ${s} works.`, cta: 'Try it now' },
        { eyebrow: 'Now live', headline: `Now live: ${s}`, subhead: `Rolling out to all customers${forAud}.`, body: `What it does, who it is for, and how to get started.`, cta: 'Read the update' },
        { eyebrow: 'Just shipped', headline: `${S} is now available`, subhead: `Built from your feedback.`, body: `We heard you. ${S} is here, with more on the way.`, cta: 'Learn more' },
      ];
      case 'proof': return [
        { eyebrow: 'By the numbers', headline: `${S}, by the numbers`, subhead: `Results from teams${forAud ? forAud : ' using ' + brand}.`, body: `The outcomes behind the headline, and how teams got there.`, cta: 'See how' },
        { eyebrow: 'Proof', headline: `Proof that ${s} works`, subhead: `Measured, not promised.`, body: `What changed, by how much, and what it took.`, cta: 'See the results' },
        { eyebrow: 'Milestone', headline: `The numbers behind ${s}`, subhead: `Where we are, and what comes next.`, body: `A look at the results so far and what they mean for your team.`, cta: 'Read the story' },
        { eyebrow: brand, headline: `${S}, measured`, subhead: `Real results${forAud}.`, body: `The data, the context, and the next step.`, cta: 'Learn more' },
      ];
      default: return [
        { eyebrow: brand, headline: S, subhead: `One place for ${s}${aud ? `, built for ${aud}` : ''}.`, body: `See how ${brand} helps with ${s}, from first setup to day to day.`, cta: 'Learn more' },
        { eyebrow: s, headline: `${S}, made simple`, subhead: `Everything ${s} needs, in one place.`, body: `A closer look at ${s}: what it covers, how it works, and where to start.`, cta: 'See how it works' },
        { eyebrow: brand, headline: `Rethink ${s}`, subhead: `Clear, fast, and built to scale with you.`, body: `Built with the teams who do this every day${forAud}.`, cta: 'Get started' },
        { eyebrow: `${brand} · ${s}`, headline: `${S}${aud ? ` for ${aud}` : ', done right'}`, subhead: `Start small, scale when ready.`, body: `What ${brand} brings to ${s}, and how to try it.`, cta: 'Talk to us' },
      ];
    }
  }

  // Does the kit's own copy already speak about this subject? Then the preset wins.
  function presetCovers(subject, kit) {
    const ownWords = new Set([kit.name, kit.content?.eyebrow, kit.deck?.title].filter(Boolean).join(' ').toLowerCase().split(/\s+/));
    const words = subject.toLowerCase().split(/\s+/).filter(w => !JOIN.has(w));
    return words.length > 0 && words.every(w => ownWords.has(w));
  }

  function draft(text, kit, { intent, variant = 0 } = {}) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    const content = intent?.content || {};
    const kind = kindOf(raw, intent);
    let subject = subjectOf(raw, kit, kind);
    const audM = raw.match(AUD); const aud = audM ? clean(audM[1]) : '';
    const dateM = raw.match(DATE); const date = dateM ? clean(dateM[1] + (dateM[2] ? ' · ' + dateM[2] : '')) : '';
    const offerM = raw.match(OFFER); const offer = offerM ? offerM[1].toLowerCase() : '';
    if (subject && aud && subject.toLowerCase() === aud) subject = null;
    if (subject && presetCovers(subject, kit) && ['generic', 'launch', 'proof'].includes(kind)) return null;
    if (!subject) { if (kind === 'generic' && !content.headline) return null; subject = kit.name; }
    const brand = kit.name;
    const description = subject === kit.name ? '' : descriptionOf(raw.replace(/\b(?:cta|button|stat(?:istic)?)\s*[:=]\s*[^,;.\n]*/gi, ' '), subject, brand);
    const c = { s: subject, S: cap(subject), brand, aud, date, offer };
    const sets = templates(kind, c);
    const t = sets[((variant % sets.length) + sets.length) % sets.length];
    const out = {
      eyebrow: clean(t.eyebrow), headline: clean(t.headline), subhead: clean(t.subhead), body: clean(t.body), cta: clean(t.cta),
      stat: content.stat || '', footer: kit.content?.footer || '',
    };
    if (content.headline) out.headline = content.headline;
    if (description) out.subhead = description;
    if (content.subhead) out.subhead = content.subhead;
    if (content.cta) out.cta = content.cta;
    if (content.eyebrow) out.eyebrow = content.eyebrow;
    if (content.body) out.body = content.body;
    if (kind === 'quote' && content.headline) { out.quote = content.headline; }
    if (kind === 'offer' && !out.stat && offer && /\d/.test(offer)) out.stat = offer.match(/\d+ ?%|\$\d+|\d+ months?/)?.[0] || '';
    const summary = [kind, subject].concat(aud ? ['for ' + aud] : [], date ? [date] : []).join(' · ');
    return { content: out, subject, kind, audience: aud, date, offer, variant: ((variant % sets.length) + sets.length) % sets.length, variants: sets.length, summary };
  }

  return { draft, subjectOf, kindOf };
})();
