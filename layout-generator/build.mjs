// Bundle the app into one self-contained HTML fragment for publishing (no build tools needed elsewhere).
// Usage: node build.mjs  -> dist/layout-engine.html (fragment: <title> + <style> + markup + inline scripts)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(root, 'index.html'), 'utf8');
const css = readFileSync(join(root, 'css/app.css'), 'utf8');
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
const js = scripts.map(p => `/* ${p} */\n` + readFileSync(join(root, p), 'utf8')).join('\n');
const title = html.match(/<title>([^<]*)<\/title>/)[1];
const desc = html.match(/<meta name="description" content="([^"]*)">/)[1];
const fonts = html.match(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/)[0];
const body = html.slice(html.indexOf('<!--APP-->') + '<!--APP-->'.length, html.indexOf('<!--/APP-->'));
const out = `<title>${title}</title>\n<meta name="description" content="${desc}">\n${fonts}\n<style>\n${css}\n</style>\n${body}\n<script>\n${js.replace(/<\/script>/g, '<\\/script>')}\n</script>\n`;
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/layout-engine.html'), out);
// Also a standalone full document for opening from disk.
const full = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<title>${title}</title>\n<meta name="description" content="${desc}">\n${fonts}\n<style>\n${css}\n</style>\n</head>\n<body>\n${body}\n<script>\n${js.replace(/<\/script>/g, '<\\/script>')}\n</script>\n</body>\n</html>\n`;
writeFileSync(join(root, 'dist/layout-engine.standalone.html'), full);
console.log('built dist/layout-engine.html', (out.length / 1024).toFixed(0) + ' KB');
