// End-to-end: drives the real UI against a server on VIDEDITOR_URL (default :8787).
//   node videditor/server.mjs &  node videditor/tests/e2e.cjs
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const BASE = process.env.VIDEDITOR_URL || 'http://localhost:8787';

async function cleanup() {
  // Remove anything an E2E run created (also from earlier failed runs) so the demo stays tidy.
  const state = await (await fetch(BASE + '/api/state')).json();
  for (const p of state.projects.filter((p) => /^E2E /.test(p.name))) { await fetch(`${BASE}/api/projects/${p.id}`, { method: 'DELETE' }); if (p.dir && /\/projects\//.test(p.dir)) require('fs').rmSync(p.dir, { recursive: true, force: true }); }
  const demo = state.projects.find((p) => p.name.includes('demo')); if (!demo) return;
  // Agent runs (ours or the user's) may have changed the demo composition; the test needs the known one.
  if (demo.dir && /launch-demo$/.test(demo.dir)) { const fs = require('fs'), path = require('path'); fs.copyFileSync(path.resolve(__dirname, '..', 'examples', 'launch', 'index.html'), path.join(demo.dir, 'index.html')); }
  for (const v of demo.versions.filter((v) => v.notes === 'E2E agent version')) await fetch(`${BASE}/api/versions/${v.id}`, { method: 'DELETE' });
  const fb = await (await fetch(`${BASE}/api/feedback?projectId=${demo.id}`)).json();
  for (const f of fb.filter((f) => /^E2E/.test(f.body) && !f.replyTo)) await fetch(`${BASE}/api/feedback/${f.id}`, { method: 'DELETE' });
}

(async () => {
  await cleanup();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, permissions: [] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(() => localStorage.setItem('videditor.author', 'E2E Bot'));

  // Library
  await page.goto(BASE + '/#/');
  await page.waitForSelector('.card:has-text("demo")');
  const name = await page.textContent('.card:has-text("demo") .name');
  console.log('library ok:', name.trim());
  // Review the first version (the one with the seeded notes), whatever else was rendered since.
  const demo0 = (await (await fetch(BASE + '/api/state')).json()).projects.find((p) => p.name.includes('demo'));
  await page.goto(`${BASE}/#/p/${demo0.id}?v=${demo0.versions[0].id}`);

  // Review loads, timeline lanes from the HyperFrames composition
  await page.waitForSelector('.review video');
  await page.waitForFunction(() => document.querySelector('.review video').readyState >= 1);
  await page.waitForSelector('.lanes .clip');
  const laneClips = await page.$$eval('.lanes .clip', (els) => els.map((e) => e.textContent));
  assert.ok(laneClips.some((t) => t.includes('#title')), 'composition lane shows #title');
  console.log('lanes ok:', laneClips.length, 'clips');

  // Seek by clicking a clip, step frames with keyboard
  await page.click('.lanes .clip:has-text("#title")');
  await page.waitForTimeout(300);
  let t = await page.$eval('video', (v) => v.currentTime);
  const titleStart = (await (await fetch(`${BASE}/api/projects/${demo0.id}/composition`)).json()).clips.find((c) => c.id === 'title').start;
  assert.ok(Math.abs(t - titleStart) < 0.2, `seeked to the title clip (got ${t}, clip starts ${titleStart})`);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(200);
  const t2 = await page.$eval('video', (v) => v.currentTime);
  assert.ok(t2 > t, 'frame step advanced');

  // Existing demo feedback shows, selecting one shows the drawing ghost
  const cards = await page.$$('.fb');
  console.log('feedback cards:', cards.length);
  await page.click('.fb:has-text("Avi")');
  await page.waitForTimeout(300);
  const hasGhost = await page.evaluate(() => { const c = document.querySelector('canvas.overlay'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true; return false; });
  assert.ok(hasGhost, 'selected note draws its annotation on the overlay');

  // Draw a rectangle and post a text note at the playhead
  await page.keyboard.press('Escape');
  await page.click('button[title="Rectangle"]');
  const box = await page.$eval('canvas.overlay', (c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  await page.mouse.move(box.x + box.w * 0.2, box.y + box.h * 0.2); await page.mouse.down();
  await page.mouse.move(box.x + box.w * 0.6, box.y + box.h * 0.6, { steps: 5 }); await page.mouse.up();
  await page.fill('.composer textarea', 'E2E make this box bigger');
  await page.click('.composer .btn.primary');
  await page.waitForSelector('.fb:has-text("E2E make this box bigger")');
  const posted = await page.locator('.fb', { hasText: 'E2E make this box bigger' }).locator('.media img').count();
  assert.ok(posted > 0, 'annotated frame attached to the posted note');
  const onScreen = await page.locator('.fb', { hasText: 'E2E make this box bigger' }).locator('.ctx').textContent();
  assert.ok(onScreen.includes('On screen'), 'note has HyperFrames clip context');
  console.log('posted note with frame; context:', onScreen.trim());

  // Reply, mark done, filter
  console.log('step: reply');
  await page.click('.fb:has-text("E2E make this box bigger")');
  await page.fill('.fb.selected .replybox input', 'E2E reply');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.fb .reply:has-text("E2E reply")');
  const note = page.locator('.fb', { hasText: 'E2E make this box bigger' });
  await note.locator('button', { hasText: 'Done' }).click();
  await page.waitForSelector('.fb.done:has-text("E2E make this box bigger")');
  await page.click('.filters button:has-text("Open")');
  assert.equal(await note.count(), 0, 'done note hidden by Open filter');

  console.log('step: copy prompt');
  // Copy prompt modal contains the brief
  await page.click('.topbar button:has-text("Copy prompt")');
  await page.waitForSelector('.modal pre');
  const brief = await page.textContent('.modal pre');
  assert.ok(brief.includes('# Video review brief'), 'brief rendered');
  assert.ok(brief.includes('On screen at'), 'brief includes clip context');
  await page.keyboard.press('Escape');

  console.log('step: agent api');
  // Agent-side API: register a version via the JSON endpoint and see it in the UI poll
  const state = await (await fetch(BASE + '/api/state')).json();
  const prj = state.projects.find((p) => p.name.includes('demo'));
  const r = await fetch(`${BASE}/api/projects/${prj.id}/versions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: prj.versions[0].filePath, notes: 'E2E agent version', postedByAgent: true }) });
  assert.equal(r.status, 201, 'agent version registered');
  const v3 = await r.json();
  await page.goto(`${BASE}/#/p/${prj.id}?v=${v3.id}`); await page.waitForTimeout(500);
  await page.waitForSelector('.topbar select');
  const selected = await page.$eval('.topbar select', (s) => s.options[s.selectedIndex].text);
  assert.ok(selected.startsWith(v3.label) && selected.includes('agent'), `agent version selected (${selected})`);

  console.log('step: context');
  // Context tab shows the HyperFrames project and files; Versions tab lists versions
  await page.click('.tab:has-text("Context")');
  await page.waitForSelector('.cliplist .c');
  await page.waitForSelector('.files .f');
  await page.click('.tab:has-text("Versions")');
  const versions = await page.$$('.version-row');
  assert.ok(versions.length >= 2, 'demo + agent version listed');

  console.log('step: compare');
  // Compare view syncs playback
  await page.click('.topbar button:has-text("Compare")');
  await page.waitForSelector('.compare video.a');
  await page.waitForFunction(() => document.querySelectorAll('.compare video').length === 2 && [...document.querySelectorAll('.compare video')].every((v) => v.readyState >= 1));
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(300);
  const [ta, tb] = await page.$$eval('.compare video', (vs) => vs.map((v) => v.currentTime));
  assert.ok(Math.abs(ta - tb) < 0.1 && ta > 0, `compare videos synced (${ta} vs ${tb})`);
  console.log('compare ok');

  console.log('step: new project');
  // "Review an existing render" with a composition folder → opens Studio
  await page.goto(BASE + '/#/');
  await page.click('.card.new');
  await page.click('.modal .tab:has-text("Review an existing render")');
  await page.fill('.modal input[placeholder*="Product launch"]', 'E2E project');
  await page.fill('.modal input[placeholder*="/path/to"]', require('path').resolve(__dirname, '..', 'examples', 'launch'));
  await page.waitForSelector('.modal .hint:has-text("Composition found")');
  await page.click('.modal .actions button:has-text("Create")');
  await page.waitForSelector('.studio .tl .tclip', { timeout: 20000 });
  console.log('new project (review tab) → studio ok');

  // "Make a new video" → blank composition in Studio; timeline drag edits index.html
  await page.goto(BASE + '/#/'); await page.click('.card.new');
  await page.fill('.modal input[placeholder*="Product launch"]', 'E2E studio');
  await page.click('.modal .actions button:has-text("Create")');
  await page.waitForSelector('.studio .tl .tclip[data-id="title"]', { timeout: 20000 });
  const st = await (await fetch(BASE + '/api/state')).json(); const sp = st.projects.find((p) => p.name === 'E2E studio');
  const clip = await page.$('.tclip[data-id="title"]'); const cb = await clip.boundingBox();
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2); await page.mouse.down(); await page.mouse.move(cb.x + cb.width / 2 + 80, cb.y + cb.height / 2, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(1500);
  const comp = await (await fetch(`${BASE}/api/projects/${sp.id}/composition`)).json();
  assert.ok(comp.clips.find((c) => c.id === 'title').start > 0.5, 'drag moved the clip start in index.html');
  await page.keyboard.press('Home'); await page.waitForTimeout(200); await page.keyboard.press('ArrowRight'); await page.waitForTimeout(400);
  assert.match(await page.textContent('.transport .time'), /0:00\.01/, 'frame step moved the stage time by one frame');
  console.log('studio ok');

  // Studio chat: send a message through the real UI and expect the agent's reply (needs Claude Code on PATH).
  const caps = await (await fetch(BASE + '/api/capabilities')).json();
  if (caps.claude) {
    await page.fill('.chat .compose textarea', 'Reply with exactly: e2e ok. Do not edit files.');
    await page.click('.chat .compose .btn.primary');
    await page.waitForSelector('.chat .msg.user', { timeout: 5000 });
    await page.waitForFunction(() => [...document.querySelectorAll('.chat .msg.agent .bubble')].some((b) => /e2e ok/i.test(b.textContent)), null, { timeout: 180000 });
    assert.ok(!(await page.$$eval('.chat .msg.agent', (els) => els.slice(-1)[0]?.querySelector('.bubble.err'))), 'no error on the agent reply');
    console.log('studio chat ok');
  } else console.log('studio chat skipped (no claude on PATH)');

  await cleanup();

  assert.deepEqual(errors.filter((e) => !/favicon|ERR_|net::/.test(e)), [], 'no page errors');
  await browser.close();
  console.log('E2E PASSED');
})().catch((e) => { console.error('E2E FAILED:', e); process.exit(1); });
