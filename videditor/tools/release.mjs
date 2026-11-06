#!/usr/bin/env node
// Publish a Videditor release.
//   node tools/release.mjs 0.4.0 "Run-through review" "Faster renders" [--push]
// Bumps the version (server and Mac app), adds the notes to CHANGELOG.md, commits, and creates the tag
// videditor-v0.4.0 whose message is the release notes. Pushing the tag (--push) makes GitHub build, sign
// and publish the Mac app (.github/workflows/videditor-mac.yml); installed apps then update themselves.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const TAG_PREFIX = 'videditor-v';
const parse = (v) => (String(v).match(/^(\d+)\.(\d+)\.(\d+)$/) || []).slice(1).map(Number);
const newer = (a, b) => { const x = parse(a), y = parse(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2); const push = argv.includes('--push');
const [version, ...notes] = argv.filter((a) => a !== '--push');
const die = (m) => { console.error(`release: ${m}`); process.exit(1); };
const git = (...a) => { const r = spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' }); if (r.status !== 0) die(`git ${a.join(' ')} failed: ${r.stderr.trim()}`); return r.stdout.trim(); };

if (!/^\d+\.\d+\.\d+$/.test(version || '')) die('usage: node tools/release.mjs <version, e.g. 0.3.0> "what changed" ["more"] [--push]');
if (!notes.length) die('add at least one line of release notes (people see them in the update notice)');
const pkgFile = path.join(ROOT, 'package.json'); const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
if (!newer(version, pkg.version)) die(`${version} must be newer than the current ${pkg.version}`);
if (git('status', '--porcelain', '--', '.')) die('commit or stash your changes in videditor/ first; a release must match what is committed');
const tag = `${TAG_PREFIX}${version}`;
if (git('tag', '-l', tag)) die(`${tag} already exists`);

pkg.version = version; fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
const appPkgFile = path.join(ROOT, 'desktop', 'package.json');
if (fs.existsSync(appPkgFile)) { const ap = JSON.parse(fs.readFileSync(appPkgFile, 'utf8')); ap.version = version; fs.writeFileSync(appPkgFile, JSON.stringify(ap, null, 2) + '\n'); }
const logFile = path.join(ROOT, 'CHANGELOG.md'); const prev = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').replace(/^# Changelog\n+/, '') : '';
fs.writeFileSync(logFile, `# Changelog\n\n## ${version} · ${new Date().toISOString().slice(0, 10)}\n${notes.map((n) => `- ${n}`).join('\n')}\n\n${prev}`);
git('add', 'package.json', 'CHANGELOG.md', 'desktop/package.json');
git('commit', '-q', '-m', `videditor v${version}`, '-m', notes.map((n) => `- ${n}`).join('\n'), ...(process.env.RELEASE_COMMIT_TRAILER ? ['-m', process.env.RELEASE_COMMIT_TRAILER] : []));
git('tag', '-a', tag, '-m', notes.map((n) => `• ${n}`).join('\n'));
console.log(`release: committed and tagged ${tag}`);
if (push) { git('push', '-q', 'origin', 'HEAD'); git('push', '-q', 'origin', tag); console.log('release: pushed. GitHub is now building the Mac app (Actions tab); installed apps update when it is published.'); }
else console.log(`release: not pushed yet. When ready:  git push origin HEAD && git push origin ${tag}`);
