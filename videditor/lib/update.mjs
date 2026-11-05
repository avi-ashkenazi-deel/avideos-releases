// Updates for installed copies. Releases are git tags `videditor-v<semver>` in the app's repo; the
// installer cloned the repo (sparse: videditor/ only) and checked out the newest tag. Checking = fetch
// tags; updating = check out the newer tag (+ npm install when dependencies changed), then restart.
// A developer checkout (no .install.json) never updates itself: it reports mode 'dev'.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, INSTALLED } from './paths.mjs';

export const TAG_PREFIX = 'videditor-v';
const REPO = path.resolve(ROOT, '..');
const parse = (v) => (String(v).replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)$/) || []).slice(1).map(Number);
export const newer = (a, b) => { const x = parse(a), y = parse(b); if (x.length < 3 || y.length < 3) return false; for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; } return false; };
export const currentVersion = () => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; } };

function run(cmd, args, { cwd = REPO, timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let out = '', err = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { p.kill('SIGKILL'); err += '\ntimed out'; }, timeout);
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: e.message }); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out: out.trim(), err: err.trim() }); });
  });
}

let cache = null; // { at, result }
/** { mode: 'installed'|'dev', current, latest?, tag?, notes?, available, checkedAt, error? } */
export async function checkForUpdate({ force = false, fetch = true } = {}) {
  const current = currentVersion();
  if (!INSTALLED) return { mode: 'dev', current, available: false };
  if (!force && cache && Date.now() - cache.at < 30 * 60 * 1000) return cache.result;
  let error = null;
  if (fetch) { const f = await run('git', ['fetch', '--quiet', '--force', '--tags', 'origin'], { timeout: 30000 }); if (f.code !== 0) error = f.err.split('\n').pop() || 'could not reach the update server'; }
  const tags = (await run('git', ['tag', '-l', `${TAG_PREFIX}*`])).out.split('\n').map((s) => s.trim()).filter((t) => parse(t.slice(TAG_PREFIX.length)).length === 3);
  let best = null; for (const t of tags) { const v = t.slice(TAG_PREFIX.length); if (!best || newer(v, best.version)) best = { version: v, tag: t }; }
  const result = { mode: 'installed', current, checkedAt: new Date().toISOString(), available: !!best && newer(best.version, current), ...(best || {}), error };
  if (best) result.notes = (await run('git', ['tag', '-l', '--format=%(contents)', best.tag])).out.replace(/-----BEGIN PGP[\s\S]*$/, '').trim();
  cache = { at: Date.now(), result };
  return result;
}

/** Switch the installed copy to `tag` (must be a known release tag). Returns { ok, version, log }. */
export async function applyUpdate(tag) {
  if (!INSTALLED) return { ok: false, log: 'This is a developer checkout; update it with git pull.' };
  if (!new RegExp(`^${TAG_PREFIX}\\d+\\.\\d+\\.\\d+$`).test(String(tag))) return { ok: false, log: 'Not a release tag.' };
  const known = (await run('git', ['tag', '-l', tag])).out === tag; if (!known) return { ok: false, log: `Unknown release ${tag}.` };
  const before = (await run('git', ['rev-parse', 'HEAD'])).out;
  const co = await run('git', ['checkout', '--quiet', '--force', tag]);
  if (co.code !== 0) return { ok: false, log: co.err };
  const depsChanged = (await run('git', ['diff', '--quiet', before, tag, '--', 'videditor/package.json'])).code !== 0;
  let log = `checked out ${tag}`;
  if (depsChanged) {
    const npm = await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: ROOT, timeout: 10 * 60 * 1000 });
    if (npm.code !== 0) { await run('git', ['checkout', '--quiet', '--force', before]); return { ok: false, log: `npm install failed, stayed on the previous version: ${npm.err.split('\n').slice(-3).join(' ')}` }; }
    log += '; dependencies updated';
  }
  cache = null;
  return { ok: true, version: tag.slice(TAG_PREFIX.length), log };
}
