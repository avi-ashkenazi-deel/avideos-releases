#!/usr/bin/env node
// Videditor doctor: checks the server, the agent and the Studio chat in a real browser,
// and prints a report you can paste to whoever is helping you.
//   node videditor/tools/doctor.mjs            (uses the most recently updated project)
//   node videditor/tools/doctor.mjs "VS"       (project by name)
// The server must be running (node videditor/server.mjs). Env: VIDEDITOR_URL
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.VIDEDITOR_URL || 'http://localhost:8787').replace(/\/$/, '');
const here = path.dirname(fileURLToPath(import.meta.url));
const out = []; const log = (...a) => { const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); out.push(line); console.log(line); };
const j = async (p, init) => { const r = await fetch(BASE + p, init); const t = await r.text(); try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t.slice(0, 400) }; } };

(async () => {
  log(`# Videditor doctor ${new Date().toISOString()}`);
  log(`node ${process.version} on ${process.platform}; server ${BASE}`);
  let state; try { state = (await j('/api/state')).body; } catch (e) { log(`! Server not reachable at ${BASE}: ${e.message}. Start it with: node videditor/server.mjs`); process.exit(1); }
  log('capabilities:', (await j('/api/capabilities')).body);
  const name = process.argv[2];
  const project = name ? state.projects.find((p) => p.name.toLowerCase() === name.toLowerCase()) : state.projects[0];
  if (!project) { log(`! No project ${name ? `named "${name}"` : 'found'}. Projects: ${state.projects.map((p) => p.name).join(', ')}`); process.exit(1); }
  log(`project: ${project.name} (${project.id}) dir=${project.dir} assets=${project.assetsDir || '-'} versions=${project.versions.length}`);
  const chat = (await j(`/api/projects/${project.id}/chat`)).body;
  log(`chat: ${chat.chat?.length ?? '?'} entries, running=${chat.running}, session=${chat.sessionId}, claude=${chat.claude}`);
  if (chat.chat?.length) for (const m of chat.chat.slice(-4)) log(`  [${m.role}] ${(m.text || '').slice(0, 120).replace(/\n/g, ' ')}${m.error ? `  ERROR: ${m.error.slice(0, 300).replace(/\n/g, ' ')}` : ''}`);
  if (chat.running) { log('! An agent run is still marked as running; cancelling it.'); log('  cancel →', (await j(`/api/projects/${project.id}/agent/cancel`, { method: 'POST' })).body); }

  log('\n## 1. Claude Code smoke test from the server');
  const diag = (await j(`/api/agent/diagnose?projectId=${project.id}`)).body;
  log(`claude: ${diag.bin} version=${diag.version?.stdout || diag.version?.error} test exit=${diag.test?.code} result=${JSON.stringify(diag.test?.result)}`);
  if (diag.test?.stderr) log('stderr:', diag.test.stderr.slice(-600));
  if (diag.test?.code !== 0 && diag.test?.stdout) log('stdout:', diag.test.stdout.slice(-600));

  log('\n## 2. Agent message through the API');
  const start = await j(`/api/projects/${project.id}/agent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Reply with exactly: doctor ok. Do not edit files.', author: 'doctor', fresh: true }) });
  log('POST /agent →', start.status, start.body);
  if (start.body?.jobId) {
    let job; for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 2000)); job = (await j(`/api/jobs/${start.body.jobId}`)).body; if (job.done) break; }
    log(`job done=${job?.done} ok=${job?.ok} after ${job?.lines?.length} events`);
    for (const l of job?.lines || []) log(`  ${l.type}: ${(l.text || l.message || (l.name ? l.name + ' ' + (l.detail || '') : '') || '').slice(0, 300).replace(/\n/g, ' | ')}`);
  }

  log('\n## 3. Studio in a real browser');
  let pw = null; try { pw = createRequire(path.join(here, '..', 'package.json'))('playwright-core'); } catch { try { pw = createRequire(import.meta.url)('playwright'); } catch {} }
  if (!pw) { log('! playwright-core not installed; run: npm install   (inside videditor/)'); }
  else {
    let browser; try { browser = await pw.chromium.launch({ channel: 'chrome', headless: true }); } catch (e) { log(`! Could not launch Chrome: ${e.message}`); }
    if (browser) {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      const problems = [];
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`console.${m.type()}: ${m.text().slice(0, 300)}`); });
      page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`); });
      page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()} ${r.failure()?.errorText}`));
      await page.addInitScript(() => localStorage.setItem('videditor.author', 'doctor'));
      await page.goto(`${BASE}/#/studio/${project.id}`, { waitUntil: 'load' });
      const loaded = await page.waitForSelector('.studio', { timeout: 20000 }).then(() => true).catch(() => false);
      log(`studio loaded: ${loaded}; stage ready: ${await page.$('.stage-wrap iframe') ? 'iframe present' : 'NO iframe'}`);
      await page.waitForTimeout(1500);
      const sendBtn = await page.$('.chat .compose .btn.primary');
      log(`send button: ${sendBtn ? (await sendBtn.isDisabled()) ? 'present but DISABLED' : 'present, enabled' : 'MISSING'}; stop visible: ${await page.$eval('.chat .compose .btn.danger', (b) => !b.classList.contains('hidden')).catch(() => 'n/a')}`);
      await page.fill('.chat .compose textarea', 'Reply with exactly: browser ok. Do not edit files.');
      await page.click('.chat .compose .btn.primary');
      await page.waitForTimeout(1500);
      log('toasts after click:', await page.$$eval('.toast', (t) => t.map((x) => x.textContent)));
      await page.waitForFunction(() => !document.querySelector('.msg .thinking'), null, { timeout: 120000 }).catch(() => log('! agent still "thinking" after 120s'));
      const msgs = await page.$$eval('.chat .msg', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').slice(0, 200)));
      log(`chat messages (${msgs.length}):`); for (const m of msgs.slice(-4)) log('  ' + m);
      const shot = path.join(here, 'doctor.png'); await page.screenshot({ path: shot }); log(`screenshot: ${shot}`);
      log(problems.length ? `browser problems (${problems.length}):` : 'browser problems: none'); for (const p of problems.slice(0, 20)) log('  ' + p);
      await browser.close();
    }
  }
  const report = path.join(here, 'doctor-report.txt'); fs.writeFileSync(report, out.join('\n')); log(`\nreport saved: ${report}`);
})().catch((e) => { log('! doctor crashed:', e.stack || e.message); process.exit(1); });
