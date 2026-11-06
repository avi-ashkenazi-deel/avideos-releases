// Videditor's updater. A release feed (latest.json) says which version is newest, with notes and, per
// chip, a zip URL + sha256:
//   { "version": "0.4.0", "notes": "• …", "date": "…", "files": { "arm64": { "url": "…", "sha256": "…", "size": 1 }, "x64": { … } } }
// Flow: check on launch and every 4 hours → download in the background (when auto-update is on) →
// verify the sha256 → unzip next to the app → verify the code signature matches the running app's
// (signed builds) → swap the app bundle and relaunch on "Restart to update", or swap quietly on quit.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

let A = null; // { app, log, getWindow, beforeInstall }
let auto = true; let timer = null;
const S = { status: 'idle', current: null, version: null, notes: null, progress: 0, error: null, ready: null, feed: null, checkedAt: null, auto: true };

const feedUrl = () => process.env.VIDEDITOR_UPDATE_FEED || (() => { try { return require('./package.json').videditor?.updateFeed || ''; } catch { return ''; } })();
const parse = (v) => (String(v).replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)$/) || []).slice(1).map(Number);
const newer = (a, b) => { const x = parse(a), y = parse(b); if (x.length < 3 || y.length < 3) return false; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
const arch = () => (process.arch === 'arm64' ? 'arm64' : 'x64');
const cacheDir = () => path.join(os.homedir(), 'Library', 'Caches', 'Videditor', 'updates');
function emit() { S.auto = auto; const w = A?.getWindow?.(); try { w?.webContents.send('update:state', state()); } catch {} }
function state() { return { ...S, current: A?.app.getVersion(), feedConfigured: !!feedUrl(), ready: S.ready ? { version: S.ready.version } : null }; }
function set(p) { Object.assign(S, p); emit(); }

function get(url, { json = false, to = null, onProgress } = {}, hops = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : url.startsWith('http:') ? http : null;
    if (!lib) { // file:// (local testing)
      try { const p = decodeURIComponent(new URL(url).pathname); if (to) { fs.copyFileSync(p, to); return resolve(to); } const b = fs.readFileSync(p); return resolve(json ? JSON.parse(b) : b); } catch (e) { return reject(e); }
    }
    const req = lib.get(url, { headers: { 'User-Agent': 'Videditor-Updater', Accept: json ? 'application/json' : '*/*' }, timeout: 30000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 6) { res.resume(); return resolve(get(new URL(res.headers.location, url).toString(), { json, to, onProgress }, hops + 1)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      const total = Number(res.headers['content-length']) || 0; let got = 0;
      if (to) { const f = fs.createWriteStream(to); res.on('data', (c) => { got += c.length; onProgress?.(total ? got / total : 0); }); res.pipe(f); f.on('finish', () => f.close(() => resolve(to))); f.on('error', reject); return; }
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => { const b = Buffer.concat(chunks); try { resolve(json ? JSON.parse(b.toString('utf8')) : b); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timed out'))); req.on('error', reject);
  });
}
const sha256 = (file) => new Promise((res, rej) => { const h = crypto.createHash('sha256'); fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => res(h.digest('hex'))).on('error', rej); });

// The running app bundle (…/Videditor.app) when packaged on macOS.
function appBundle() { const p = A.app.getPath('exe'); const i = p.indexOf('.app/'); return i > 0 ? p.slice(0, i + 4) : null; }
function teamId(bundle) { if (process.platform !== 'darwin') return null; const r = spawnSync('codesign', ['-dv', '--verbose=2', bundle], { encoding: 'utf8' }); const m = /TeamIdentifier=(\S+)/.exec(r.stderr || ''); return m && m[1] !== 'not' ? m[1] : null; }

async function check({ interactive = false } = {}) {
  const url = feedUrl();
  if (!url) { set({ status: 'idle', error: null }); if (interactive) info('Updates are not set up for this build', 'This copy of Videditor was built without an update feed.'); return state(); }
  if (S.status === 'downloading') return state();
  set({ status: 'checking', error: null });
  try {
    const feed = await get(url, { json: true });
    const file = feed.files?.[arch()];
    S.checkedAt = new Date().toISOString();
    if (!feed.version || !newer(feed.version, A.app.getVersion()) || !file?.url || !/^[a-f0-9]{64}$/.test(file.sha256 || '')) {
      set({ status: S.ready ? 'ready' : 'idle', version: feed.version || null, notes: feed.notes || null, feed: null });
      if (interactive) info('Videditor is up to date', `You have the newest version, ${A.app.getVersion()}.`);
      return state();
    }
    set({ status: S.ready?.version === feed.version ? 'ready' : 'available', version: feed.version, notes: feed.notes || '', feed });
    if (S.status === 'available' && (auto || interactive)) download().catch(() => {});
  } catch (e) { set({ status: S.ready ? 'ready' : 'idle', error: e.message }); A.log?.(`update check failed: ${e.message}`); if (interactive) info('Could not check for updates', e.message); }
  return state();
}

async function download() {
  const feed = S.feed; if (!feed) return state();
  const file = feed.files[arch()];
  set({ status: 'downloading', progress: 0, error: null });
  const dir = path.join(cacheDir(), feed.version); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, `Videditor-${feed.version}-${arch()}.zip`);
  try {
    await get(file.url, { to: zip, onProgress: (p) => { if (p - S.progress > 0.02 || p === 1) set({ progress: p }); } });
    const sum = await sha256(zip);
    if (sum !== file.sha256) throw new Error('the download is damaged (checksum mismatch)');
    const out = path.join(dir, 'app'); fs.mkdirSync(out, { recursive: true });
    const unzip = process.platform === 'darwin' ? spawnSync('ditto', ['-x', '-k', zip, out]) : spawnSync('unzip', ['-q', zip, '-d', out]);
    if (unzip.status !== 0) throw new Error(`could not unpack the update: ${(unzip.stderr || '').toString().trim()}`);
    const bundle = fs.readdirSync(out).find((n) => n.endsWith('.app'));
    if (!bundle) throw new Error('the update does not contain Videditor.app');
    const newApp = path.join(out, bundle);
    // Locked down: a signed app only accepts an update signed by the same developer team.
    const cur = appBundle(); const mine = cur ? teamId(cur) : null;
    if (mine) {
      const v = spawnSync('codesign', ['--verify', '--deep', '--strict', newApp]);
      if (v.status !== 0) throw new Error('the update is not correctly signed');
      if (teamId(newApp) !== mine) throw new Error('the update is signed by a different developer');
    }
    S.ready = { version: feed.version, app: newApp, notes: feed.notes };
    set({ status: 'ready', progress: 1 });
    A.log?.(`update ${feed.version} downloaded and verified`);
  } catch (e) { set({ status: 'available', error: e.message }); A.log?.(`update download failed: ${e.message}`); throw e; }
  return state();
}

// Replace the app bundle after we exit, then optionally reopen it. Runs as a detached shell script.
function swap({ relaunch }) {
  const cur = appBundle(); const ready = S.ready;
  if (!ready || !cur) return false;
  const script = path.join(cacheDir(), 'install.sh');
  fs.writeFileSync(script, `#!/bin/sh
# Wait for Videditor (pid ${process.pid}) to quit, then swap in the new version.
while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done
old="${cur}.old-$$"
mv "${cur}" "$old" || exit 1
if mv "${ready.app}" "${cur}"; then rm -rf "$old"; else mv "$old" "${cur}"; fi
xattr -dr com.apple.quarantine "${cur}" 2>/dev/null
${relaunch ? `open "${cur}"` : ''}
rm -rf "${path.dirname(path.dirname(ready.app))}"
`, { mode: 0o755 });
  spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref();
  A.log?.(`installing ${ready.version} (${relaunch ? 'restart' : 'on quit'})`);
  return true;
}
let installing = false;
function install({ relaunch = true } = {}) {
  if (!S.ready || installing) return state();
  if (!appBundle()) { info('Restart to update', 'Updates install only into the packaged Mac app.'); return state(); }
  installing = true; A.beforeInstall?.(); swap({ relaunch }); setTimeout(() => A.app.quit(), 100);
  return state();
}
function installOnQuit() { if (S.ready && !installing && appBundle()) { installing = true; swap({ relaunch: false }); } }

function info(title, message) { const { dialog } = require('electron'); const w = A?.getWindow?.(); dialog.showMessageBox(w || undefined, { type: 'info', message: title, detail: message, buttons: ['OK'] }).catch(() => {}); }
function configure({ auto: a }) { if (typeof a === 'boolean') { auto = a; emit(); if (auto && S.status === 'available') download().catch(() => {}); } }
function init(opts) { A = opts; auto = opts.auto !== false; S.current = opts.app.getVersion(); setTimeout(() => check().catch(() => {}), 3000); clearInterval(timer); timer = setInterval(() => check().catch(() => {}), 4 * 60 * 60 * 1000); }

module.exports = { init, check, download, install, installOnQuit, configure, state: () => state(), _newer: newer };
