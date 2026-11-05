#!/usr/bin/env node
// Videditor launcher: what the Mac app and the `videditor` command run.
//  1. Already running? Open it in the browser and stop.
//  2. Installed copy with auto-update on: install the newest release first (skipped if offline).
//  3. Start the server in the background (logs in ~/Videditor/logs) and open the browser.
// Flags: --no-open (do not open a browser), --no-update, --stop (stop a running server).
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { ROOT, INSTALLED, LOGS, HOME, readSettings } from './lib/paths.mjs';
import { checkForUpdate, applyUpdate, currentVersion } from './lib/update.mjs';

const PORT = Number(process.env.VIDEDITOR_PORT || process.env.PORT || 8787);
const URL_ = `http://localhost:${PORT}`;
const args = new Set(process.argv.slice(2));
const say = (m) => console.log(`[videditor] ${m}`);

// Apps started from Finder get a bare PATH: add the usual places for node, ffmpeg, git and claude.
const extra = [path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', path.join(process.env.HOME || '', '.local/bin'), path.join(process.env.HOME || '', '.npm-global/bin'), '/usr/bin', '/bin'];
process.env.PATH = [...new Set([...extra, ...(process.env.PATH || '').split(':')].filter(Boolean))].join(':');

const ping = () => new Promise((res) => { const r = http.get(`${URL_}/api/state`, { timeout: 1500 }, (x) => { x.resume(); res(x.statusCode === 200); }); r.on('error', () => res(false)); r.on('timeout', () => { r.destroy(); res(false); }); });
const openBrowser = () => { if (args.has('--no-open')) return; const [cmd, a] = process.platform === 'darwin' ? ['open', [URL_]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', URL_]] : ['xdg-open', [URL_]]; try { spawn(cmd, a, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); } catch {} };

if (args.has('--stop')) {
  const pidFile = path.join(LOGS, 'server.pid');
  try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM'); say('stopped'); } catch { say('not running'); }
  process.exit(0);
}

if (await ping()) { say(`already running at ${URL_}`); openBrowser(); process.exit(0); }

if (INSTALLED && !args.has('--no-update') && readSettings().autoUpdate !== false) {
  const u = await Promise.race([checkForUpdate({ force: true }), new Promise((r) => setTimeout(() => r(null), 15000))]);
  if (u?.available) {
    say(`updating ${currentVersion()} → ${u.version}…`);
    const r = await applyUpdate(u.tag);
    say(r.ok ? `updated to ${r.version}` : `update skipped: ${r.log}`);
    if (r.ok) { // run the new launcher code too
      const again = spawn(process.execPath, [path.join(ROOT, 'launcher.mjs'), '--no-update', ...process.argv.slice(2)], { stdio: 'inherit' });
      again.on('exit', (code) => process.exit(code ?? 0));
      await new Promise(() => {});
    }
  } else if (u?.error) say(`could not check for updates (${u.error}); starting the installed version`);
}

fs.mkdirSync(LOGS, { recursive: true });
const log = fs.openSync(path.join(LOGS, 'server.log'), 'a');
const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { cwd: ROOT, env: process.env, detached: true, stdio: ['ignore', log, log] });
fs.writeFileSync(path.join(LOGS, 'server.pid'), String(child.pid));
child.unref();
for (let i = 0; i < 60; i++) { if (await ping()) { say(`v${currentVersion()} running at ${URL_} (your work: ${HOME})`); openBrowser(); process.exit(0); } await new Promise((r) => setTimeout(r, 500)); }
say(`the server did not start. Log: ${path.join(LOGS, 'server.log')}`);
process.exit(1);
