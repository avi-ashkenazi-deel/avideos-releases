// End-to-end smoke test with a fake webcam.
//
//   npx http-server headshot-studio -p 8080 &
//   FAKE_VIDEO=/path/to/face.y4m OUT_DIR=/tmp/shots NODE_PATH=$(npm root -g) node headshot-studio/tests/e2e.cjs
//
// FAKE_VIDEO is a .y4m clip of a person facing the camera (Chromium loops it
// as the webcam). Make one from a photo with:
//   ffmpeg -loop 1 -i face.png -t 2 -r 10 -pix_fmt yuv420p face.y4m

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://localhost:8080/';
const VIDEO = process.env.FAKE_VIDEO;
const OUT = process.env.OUT_DIR || path.join(__dirname, 'out');

(async () => {
  if (!VIDEO) throw new Error('Set FAKE_VIDEO to a .y4m file');
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${VIDEO}`,
      '--enable-unsafe-swiftshader',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  // MediaPipe logs its own INFO lines through console.error; ignore those.
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('INFO:')) errors.push('console: ' + m.text()); });

  await page.goto(BASE + '#capture');
  await page.waitForSelector('#start-camera');
  await page.waitForSelector('#style-avatar canvas', { timeout: 30000 });
  await page.screenshot({ path: path.join(OUT, '1-intro.png') });

  await page.fill('#hs-name', 'Test Person');
  await page.click('#start-camera');
  await page.waitForSelector('.check', { timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, '2-camera.png') });
  const hint = await page.textContent('#hint-text');
  const checks = await page.$$eval('.check', (els) => els.map((e) => e.dataset.status + ' ' + e.innerText.replace(/\s+/g, ' ')));
  console.log('hint:', hint);
  console.log('checks:', checks.join(' | '));

  // Auto capture should fire on its own when everything is right; otherwise press the shutter.
  const t0capture = Date.now();
  try {
    await page.waitForSelector('.processing, .retouch', { timeout: 15000 });
    console.log('auto capture: fired after ms', Date.now() - t0capture);
  } catch {
    console.log('auto capture: did not fire, pressing shutter');
    await page.click('#shutter', { timeout: 2000 }).catch(() => {});
  }
  const t0proc = Date.now();
  await page.waitForSelector('.retouch', { timeout: 120000 });
  console.log('processing ms:', Date.now() - t0proc);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, '3-retouch.png'), fullPage: true });
  const notes = await page.$$eval('.notes li', (els) => els.map((e) => e.innerText));
  console.log('notes:', notes.join(' | '));

  // Move a few sliders and time the re-render.
  const t0 = Date.now();
  for (const [id, v] of [['#sl-smoothing', '60'], ['#sl-eyeBright', '60'], ['#sl-lipColor', '50'], ['#sl-skinTone', '20']]) {
    const max = await page.$eval(id, (e) => e.max).catch(() => null);
    if (max === null) continue;
    await page.$eval(id, (e, val) => { e.value = String(Math.min(Number(val), Number(e.max))); e.dispatchEvent(new Event('input', { bubbles: true })); }, v);
    await page.waitForTimeout(80);
  }
  console.log('slider round trip ms:', Date.now() - t0);
  await page.screenshot({ path: path.join(OUT, '4-retouch-edited.png'), fullPage: true });

  await page.click('#continue');
  await page.waitForSelector('#final-avatar canvas');
  await page.click('#submit');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, '5-done.png'), fullPage: true });

  // Admin: switch to black & white on Deel blue with a ring.
  await page.goto(BASE + '#admin');
  await page.waitForSelector('#preview-avatar canvas', { timeout: 30000 });
  await page.click('[data-preset="deel-blue"]');
  await page.click('[data-treatment="bw"]');
  await page.check('#ring');
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, '6-admin.png'), fullPage: true });
  const rows = await page.$$eval('tbody tr', (els) => els.length);
  console.log('submissions rows:', rows);

  // Phone width layout check.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  console.log('phone horizontal overflow px:', overflow);
  await page.screenshot({ path: path.join(OUT, '7-admin-phone.png'), fullPage: true });

  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
