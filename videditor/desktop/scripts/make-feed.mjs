#!/usr/bin/env node
// Writes dist/latest.json, the update feed installed apps read:
//   node scripts/make-feed.mjs --base https://github.com/OWNER/REPO/releases/download/videditor-v0.4.0 --notes "• line\n• line"
// It lists, per chip, the zip electron-builder made, with its size and sha256.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const pkg = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'));
const dist = path.join(HERE, arg('--dist', 'dist')); const base = String(arg('--base', '')).replace(/\/$/, '');
if (!base) { console.error('make-feed: --base <url where the zips will be downloadable> is required'); process.exit(1); }
const files = {};
for (const a of ['arm64', 'x64']) {
  const name = `Videditor-${pkg.version}-${a}-mac.zip`; const f = path.join(dist, name);
  if (!fs.existsSync(f)) continue;
  files[a] = { url: `${base}/${encodeURIComponent(name)}`, sha256: crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'), size: fs.statSync(f).size };
}
if (!Object.keys(files).length) { console.error(`make-feed: no Videditor-${pkg.version}-*-mac.zip in ${dist}`); process.exit(1); }
const feed = { version: pkg.version, date: new Date().toISOString(), notes: String(arg('--notes', '')).replace(/\\n/g, '\n'), files };
fs.writeFileSync(path.join(dist, 'latest.json'), JSON.stringify(feed, null, 2));
console.log(`make-feed: dist/latest.json for ${pkg.version} (${Object.keys(files).join(', ')})`);
