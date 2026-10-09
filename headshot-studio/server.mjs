#!/usr/bin/env node
// Serves the app plus the AI regeneration endpoint. The API key stays here,
// on the server; the browser never sees it.
//
//   GEMINI_API_KEY=...  node headshot-studio/server.mjs   Google Gemini image model
//   OPENAI_API_KEY=...  node headshot-studio/server.mjs   OpenAI GPT Image
//   HEADSHOT_PROVIDER=local node headshot-studio/server.mjs  self-hosted open-source model (tools/local_inpaint.py)
//   HEADSHOT_PROVIDER=mock node headshot-studio/server.mjs   test mode: returns the photo unchanged
//
// Optional: GEMINI_IMAGE_MODEL, OPENAI_IMAGE_MODEL, HEADSHOT_PYTHON (for local), PORT (default 8080).

import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrompt, buildLocalPrompt } from './js/prompt.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const MAX_BODY = 12 * 1024 * 1024;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};

function provider() {
  const forced = process.env.HEADSHOT_PROVIDER;
  if (forced) return forced;
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return null;
}

function modelName(p) {
  if (p === 'gemini') return process.env.GEMINI_IMAGE_MODEL || 'gemini-nano-banana-2.1';
  if (p === 'openai') return process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
  if (p === 'local') return (process.env.HEADSHOT_LOCAL_MODEL || 'Lykon/dreamshaper-8-inpainting') + ' (self-hosted)';
  return p;
}

// Finds the first image payload in a model response, whatever its exact shape.
function findImage(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'image' && typeof node.data === 'string') return { data: node.data, mime: node.mime_type || 'image/jpeg' };
  const inline = node.inlineData || node.inline_data;
  if (inline?.data) return { data: inline.data, mime: inline.mimeType || inline.mime_type || 'image/png' };
  if (node.output_image?.data) return { data: node.output_image.data, mime: node.output_image.mime_type || 'image/jpeg' };
  for (const v of Object.values(node)) {
    const hit = findImage(v);
    if (hit) return hit;
  }
  return null;
}

async function gemini(image, prompt) {
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelName('gemini'),
      input: [
        { type: 'text', text: prompt },
        { type: 'image', mime_type: image.mime, data: image.data },
      ],
      response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '4:5', image_size: '1K' },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const hit = findImage(await res.json());
  if (!hit) throw new Error('Gemini returned no image');
  return hit;
}

async function openai(image, prompt, n) {
  const model = modelName('openai');
  const form = new FormData();
  form.append('model', model);
  form.append('image', new Blob([Buffer.from(image.data, 'base64')], { type: image.mime }), image.mime === 'image/png' ? 'photo.png' : 'photo.jpg');
  form.append('prompt', prompt);
  form.append('n', String(n));
  form.append('size', '1024x1536');
  form.append('quality', 'high');
  if (/^gpt-image-1/.test(model)) form.append('input_fidelity', 'high');
  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return (json.data || []).filter((d) => d.b64_json).map((d) => ({ data: d.b64_json, mime: 'image/png' }));
}

// Self-hosted: the browser fills hidden clothing in (mirrored from the
// visible side); the model only blends that patch. Everything else is kept.
async function local(image, keep, policy, n, clothing) {
  const dir = await mkdtemp(join(tmpdir(), 'headshot-'));
  try {
    await writeFile(join(dir, 'photo.png'), Buffer.from(image.data, 'base64'));
    await writeFile(join(dir, 'keep.png'), Buffer.from(keep, 'base64'));
    await writeFile(join(dir, 'job.json'), JSON.stringify({ ...buildLocalPrompt(policy, clothing), n, strength: 0.7 }));
    await new Promise((resolve, reject) => {
      const py = spawn(process.env.HEADSHOT_PYTHON || 'python3', [join(ROOT, 'tools', 'local_inpaint.py'), dir], { stdio: ['ignore', 'inherit', 'pipe'] });
      let err = '';
      py.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
      py.on('error', reject);
      py.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Local model failed: ${err.trim().split('\n').pop()}`))));
    });
    const files = (await readdir(dir)).filter((f) => /^out-\d+\.png$/.test(f)).sort();
    return Promise.all(files.map(async (f) => ({ data: (await readFile(join(dir, f))).toString('base64'), mime: 'image/png' })));
  } finally {
    rm(dir, { recursive: true, force: true });
  }
}

async function generate({ image, filled, keep, clothing, policy, n }) {
  const p = provider();
  if (!p) throw Object.assign(new Error('No image model is configured on the server.'), { status: 503 });
  const m = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(image || '');
  if (!m) throw Object.assign(new Error('Send the photo as a JPEG or PNG data URL.'), { status: 400 });
  const input = { mime: m[1], data: m[2] };
  const count = Math.max(1, Math.min(4, Number(n) || 1));
  const prompt = buildPrompt(policy || {});

  let images;
  if (p === 'mock') {
    images = Array.from({ length: count }, () => input);
  } else if (p === 'gemini') {
    // One image per call; run the variations in parallel.
    const results = await Promise.allSettled(Array.from({ length: count }, () => gemini(input, prompt)));
    images = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (!images.length) throw results[0].reason;
  } else if (p === 'openai') {
    images = await openai(input, prompt, count);
  } else if (p === 'local') {
    const k = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(keep || '');
    const f = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(filled || '');
    if (!k || !f) throw Object.assign(new Error('The self-hosted model needs the filled photo and keep mask.'), { status: 400 });
    images = await local({ mime: 'image/png', data: f[1] }, k[1], policy || {}, count, clothing);
  } else {
    throw Object.assign(new Error(`Unknown HEADSHOT_PROVIDER "${p}"`), { status: 500 });
  }
  return { provider: p, model: modelName(p), mock: p === 'mock', images: images.map((i) => `data:${i.mime};base64,${i.data}`) };
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Photo is too large.'), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/status') {
      const p = provider();
      return send(res, 200, { provider: p, model: p ? modelName(p) : null, mock: p === 'mock' });
    }
    if (url.pathname === '/api/generate') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
      const out = await generate(await readJson(req));
      return send(res, 200, out);
    }
    // Static files
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '') || 'index.html';
    const file = join(ROOT, rel);
    if (!file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) return send(res, 403, 'Forbidden', 'text/plain');
    if (/^(server|tests|tools)/.test(rel)) return send(res, 404, 'Not found', 'text/plain');
    const body = await readFile(file);
    return send(res, 200, body, TYPES[extname(file)] || 'application/octet-stream');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') return send(res, 404, 'Not found', 'text/plain');
    console.error(err);
    return send(res, err.status || 502, { error: err.message || 'Generation failed' });
  }
});

server.listen(PORT, () => {
  const p = provider();
  console.log(`Headshot Studio on http://localhost:${PORT}  ·  image model: ${p ? `${p} (${modelName(p)})` : 'none (set GEMINI_API_KEY or OPENAI_API_KEY)'}`);
});
