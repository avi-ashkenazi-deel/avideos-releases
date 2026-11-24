#!/usr/bin/env node
// Minimal static server for the built site, to check it the way a real host serves it:
// plain files, no dev server. Serves dist/ at the root AND under a sub-folder
// (default /sub/fontlab/) so both kinds of deployment can be tested with one build.
//   node scripts/serve-dist.mjs [--port 5199] [--base /sub/fontlab/] [--dir dist]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const port = Number(arg('port', 5199));
const base = arg('base', '/sub/fontlab/').replace(/\/?$/, '/');
const root = resolve(arg('dir', 'dist'));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === base.slice(0, -1)) { res.writeHead(301, { location: base }); res.end(); return; }
    if (path.startsWith(base)) path = '/' + path.slice(base.length);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(root, path));
    if (!file.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
    await stat(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(await readFile(file));
  } catch { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); }
}).listen(port, '127.0.0.1', () => console.log(`dist served at http://127.0.0.1:${port}/ and http://127.0.0.1:${port}${base}`));
