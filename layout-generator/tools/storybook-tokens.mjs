// A design system's theme, from its Storybook: the palette (every shade, per theme), the type scale, spacing and
// radius, read from the running theme object itself (the ThemeProvider's `theme` prop in the React tree), so the
// numbers are the ones the components use, not a copy. For MUI-style themes (@mui/material, emotion).
//
//   node tools/storybook-tokens.mjs --storybook https://storybook.example.com --story components-button--playground \
//     [--global theme --themes Light,Dark] [--out tokens.json]
//
// --global names the Storybook global that switches themes (its toolbar items are read when --themes is left out).
// Output: { themes: { light: { "primary.main": "#1b1b1b", … }, dark: { … } }, typography: { h1: {…}, … }, spacing, shape }.
// Token names are the theme paths with dots (palette.primary.main → primary.main). Feed the result to a brand kit as
// kit.tokens (see README: Components: instances, slots, tokens and themes). Needs Playwright.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const SB = String(arg('storybook', '')).replace(/\/(iframe\.html|index\.html)?$/, ''); const STORY = arg('story'); const GLOBAL = arg('global', 'theme');
const THEMES = arg('themes') ? String(arg('themes')).split(',').map(s => s.trim()).filter(Boolean) : null; const OUT = arg('out', 'tokens.json');
if (!SB || !STORY) { console.error('Usage: node tools/storybook-tokens.mjs --storybook <url> --story <story id> [--global theme] [--themes Light,Dark] [--out tokens.json]'); process.exit(1); }
const req = createRequire(import.meta.url);
let chromium; try { ({ chromium } = req('playwright')); } catch { try { ({ chromium } = await import('playwright')); } catch { console.error('Playwright is needed: npm i -g playwright'); process.exit(1); } }

// The theme object behind the story: the first ThemeProvider with a palette and typography.
const READ = () => {
  const root = document.getElementById('storybook-root'); if (!root) return null;
  const key = Object.keys(root).find(k => k.startsWith('__reactContainer$') || k.startsWith('__reactFiber$')); if (!key) return null;
  const seen = new Set(); const stack = [root[key]]; let theme = null;
  while (stack.length && seen.size < 300000) { const f = stack.pop(); if (!f || seen.has(f)) continue; seen.add(f); const t = f.memoizedProps && f.memoizedProps.theme; if (t && t.palette && t.typography) { theme = t; break; } if (f.child) stack.push(f.child); if (f.sibling) stack.push(f.sibling); }
  if (!theme) return null;
  const SKIP = new Set(['mode', 'contrastThreshold', 'tonalOffset', 'getContrastText', 'augmentColor', 'action', 'grey', 'common']);
  const flat = (o, pre, out) => { for (const [k, v] of Object.entries(o)) { if (typeof v === 'function' || (pre === '' && SKIP.has(k))) continue; const n = pre ? pre + '.' + k : k; if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, n, out); else if (typeof v === 'string' && /^(#|rgb|hsl|linear-gradient|transparent$)/.test(v.trim())) out[n] = v.trim(); } return out; };
  const palette = flat(theme.palette, '', {});
  const extra = {}; for (const k of ['grey', 'common', 'action']) if (theme.palette[k] && typeof theme.palette[k] === 'object') flat(theme.palette[k], k, extra);
  const T = theme.typography || {}; const typography = {};
  for (const [k, v] of Object.entries(T)) { if (v && typeof v === 'object' && (v.fontSize || v.fontFamily || v.fontWeight)) typography[k] = Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string' || typeof x === 'number')); }
  const fontFamily = T.fontFamily; const fonts = T.fonts && typeof T.fonts === 'object' ? Object.fromEntries(Object.entries(T.fonts).filter(([, x]) => typeof x === 'string')) : undefined;
  const spacing = typeof theme.spacing === 'function' ? (parseFloat(String(theme.spacing(1))) || null) : theme.spacing;
  return { mode: theme.palette.mode, palette, extra, typography, fontFamily, fonts, spacing, shape: theme.shape && { borderRadius: theme.shape.borderRadius }, breakpoints: theme.breakpoints && theme.breakpoints.values };
};

const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const open = async globals => { await page.goto(`${SB}/iframe.html?id=${encodeURIComponent(STORY)}&viewMode=story${globals ? '&globals=' + encodeURIComponent(globals) : ''}`, { waitUntil: 'networkidle', timeout: 90000 }); await page.waitForTimeout(2000); };
await open('');
let themes = THEMES;
if (!themes) {
  themes = await page.evaluate(g => { try { const gt = window.__STORYBOOK_PREVIEW__.storyStoreValue.projectAnnotations.globalTypes || {}; const t = gt[g]; const items = t && t.toolbar && t.toolbar.items; return items ? items.map(i => typeof i === 'string' ? i : i && i.value).filter(x => typeof x === 'string') : null; } catch { return null; } }, GLOBAL);
  if (!themes || !themes.length) themes = [null];
  console.log(`themes (global "${GLOBAL}"):`, themes.filter(Boolean).join(', ') || '(none; the default theme only)');
}
const out = { storybook: SB, story: STORY, global: GLOBAL, read: new Date().toISOString(), themes: {} };
for (const th of themes) {
  if (th) await open(`${GLOBAL}:${th}`);
  const r = await page.evaluate(READ);
  if (!r) { console.log(`${th || 'default'}: no theme found in the React tree`); continue; }
  const name = String(th || 'default').toLowerCase();
  out.themes[name] = r.palette; out.themeDetails = out.themeDetails || {}; out.themeDetails[name] = { mode: r.mode, extra: r.extra };
  if (!out.typography) { out.typography = r.typography; out.fontFamily = r.fontFamily; out.fonts = r.fonts; out.spacing = r.spacing; out.shape = r.shape; out.breakpoints = r.breakpoints; }
  console.log(`${name}: mode ${r.mode}, ${Object.keys(r.palette).length} colors, background.default ${r.palette['background.default'] || '-'}, text.primary ${r.palette['text.primary'] || '-'}`);
}
await browser.close();
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(`wrote ${OUT}: ${Object.keys(out.themes).length} theme${Object.keys(out.themes).length === 1 ? '' : 's'}, ${Object.keys(out.typography || {}).length} type styles, spacing ${out.spacing}, radius ${out.shape && out.shape.borderRadius}`);
