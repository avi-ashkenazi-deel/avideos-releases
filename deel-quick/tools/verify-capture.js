#!/usr/bin/env node
/*
 * Deel Quick — capture verifier.
 * Lints a capture file for artifact-readiness: self-containment (the artifact
 * CSP blocks every external request), sanitization, structure, and size.
 * Zero dependencies; regex-based on purpose so it runs anywhere Node runs.
 *
 * Usage: node tools/verify-capture.js <path/to/*-capture.html>
 * Exit code 0 = PASS, 1 = FAIL, 2 = usage/read error.
 * Last stdout line is machine-parsable: "RESULT: PASS" or "RESULT: FAIL (<n> findings)"
 */
'use strict';

const fs = require('fs');

const FLAG_BYTES = 14 * 1024 * 1024;
const CEILING_BYTES = 16 * 1024 * 1024;

const args = process.argv.slice(2);
if (args.length !== 1) {
  console.error('usage: node tools/verify-capture.js <capture.html>');
  process.exit(2);
}

let html;
try {
  html = fs.readFileSync(args[0], 'utf8');
} catch (err) {
  console.error(`cannot read ${args[0]}: ${err.message}`);
  process.exit(2);
}

const findings = [];
const notes = [];
const add = (msg) => findings.push(msg);

// ---- Structure ---------------------------------------------------------------

if (!/^<!doctype html>/i.test(html.trimStart())) add('missing <!doctype html> at the top');

const metaComment = html.match(/<!--\s*\n?\s*deel-quick capture[\s\S]*?-->/);
if (!metaComment) {
  add('missing the deel-quick metadata comment');
} else {
  if (!/changelog:/.test(metaComment[0])) add('metadata comment has no "changelog:" line');
}

if (!/<\/html>\s*$/i.test(html)) add('file does not end with </html> — possibly truncated');

// Strip the metadata comment before content checks so its source URL doesn't
// trip the external-reference scan.
const body = metaComment ? html.replace(metaComment[0], '') : html;

// ---- Sanitization --------------------------------------------------------------

const scriptTags = body.match(/<script\b/gi) || [];
// Inline scripts are allowed only when the skill added them (marked data-dq-inline).
const allowedScripts = body.match(/<script\b[^>]*data-dq-inline/gi) || [];
if (scriptTags.length > allowedScripts.length) {
  add(`${scriptTags.length - allowedScripts.length} <script> tag(s) present (only data-dq-inline scripts added by the skill are allowed)`);
}
if (/<noscript\b/i.test(body)) add('<noscript> element present');

const onAttrs = body.match(/\s(on[a-z]+)\s*=\s*["']/gi) || [];
if (onAttrs.length) add(`${onAttrs.length} inline on* event handler attribute(s) present`);

if (/\shref\s*=\s*["']\s*javascript:/i.test(body)) add('javascript: URL present in an href');

if (/<meta[^>]+http-equiv\s*=\s*["'](content-security-policy|refresh)["']/i.test(body)) {
  add('CSP or refresh <meta http-equiv> present');
}
if (/<base\b/i.test(body)) add('<base> element present');

const liveIframes = body.match(/<iframe\b[^>]*\ssrc\s*=\s*["']https?:/gi) || [];
if (liveIframes.length) add(`${liveIframes.length} <iframe> with a live http(s) src (should be placeholders)`);

// ---- Self-containment ----------------------------------------------------------
// Any http(s) URL that the browser would fetch is a hole under the artifact CSP.
// Allowed: data-orig-href (inert), <a href> to claude.ai artifacts, plain text.

const externalRefs = [];

// Attributes that trigger fetches.
const FETCH_ATTR_RE = /\s(src|srcset|poster|data|href)\s*=\s*["'](https?:\/\/[^"']+)["']/gi;
let m;
while ((m = FETCH_ATTR_RE.exec(body)) !== null) {
  const [full, attr, url] = m;
  if (attr.toLowerCase() === 'href') {
    // Find the tag this href belongs to; <a>/<area> navigation is CSP-safe,
    // and claude.ai links are the multi-screen convention. <link href> is a fetch.
    const tagStart = body.lastIndexOf('<', m.index);
    const tag = (body.slice(tagStart + 1, tagStart + 10).match(/^[a-z0-9]+/i) || [''])[0].toLowerCase();
    if (tag === 'a' || tag === 'area') {
      if (!/^https:\/\/claude\.ai\//.test(url)) {
        notes.push(`note: <a href> to a non-artifact URL (navigates viewers away): ${url.slice(0, 100)}`);
      }
      continue;
    }
    externalRefs.push(`<${tag} href> ${url.slice(0, 120)}`);
  } else {
    externalRefs.push(`${attr} ${url.slice(0, 120)}`);
  }
}

// CSS fetches: url(...) and @import, in <style> blocks and style attributes.
const CSS_FETCH_RE = /url\(\s*["']?(https?:\/\/[^"')]+)["']?\s*\)|@import\s+["'(]?\s*(https?:\/\/[^"')\s;]+)/gi;
while ((m = CSS_FETCH_RE.exec(body)) !== null) {
  externalRefs.push(`css ${(m[1] || m[2]).slice(0, 120)}`);
}

if (externalRefs.length) {
  add(`${externalRefs.length} external http(s) reference(s) the artifact CSP will block:`);
  externalRefs.slice(0, 10).forEach((r) => add(`  - ${r}`));
  if (externalRefs.length > 10) add(`  ... and ${externalRefs.length - 10} more`);
}

// ---- Size -----------------------------------------------------------------------

const totalBytes = Buffer.byteLength(html, 'utf8');
const mb = (n) => (n / 1048576).toFixed(1) + 'MB';
if (totalBytes > CEILING_BYTES) {
  add(`file is ${mb(totalBytes)} — OVER the 16MB artifact ceiling`);
} else if (totalBytes > FLAG_BYTES) {
  add(`file is ${mb(totalBytes)} — over the 14MB budget (16MB ceiling); run the size playbook`);
} else {
  notes.push(`size: ${mb(totalBytes)} (under the 14MB budget)`);
}

// Rough category split from data URIs, for comparison with the metadata ledger.
const split = { fonts: 0, images: 0 };
const DATA_URI_RE = /data:(font|application\/font|image)[^"'()\s]*/g;
while ((m = DATA_URI_RE.exec(html)) !== null) {
  split[m[1] === 'image' ? 'images' : 'fonts'] += m[0].length;
}
notes.push(`data-URI payload: fonts ~${mb(split.fonts)}, images ~${mb(split.images)}`);

// ---- Report ----------------------------------------------------------------------

console.log(`deel-quick capture verifier — ${args[0]}`);
notes.forEach((n) => console.log(`  ${n}`));
if (findings.length) {
  console.log('findings:');
  findings.forEach((f, i) => console.log(f.startsWith('  ') ? f : `  ${i + 1}. ${f}`));
  console.log(`RESULT: FAIL (${findings.filter((f) => !f.startsWith('  ')).length} findings)`);
  process.exit(1);
} else {
  console.log('RESULT: PASS');
  process.exit(0);
}
