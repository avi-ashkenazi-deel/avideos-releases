import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

async function openPlain(page: Page) {
  await page.locator('[data-testid=preview-plain]').evaluate((d) => { (d as HTMLDetailsElement).open = true; });
}

async function drawStroke(page: Page, pts: [number, number][]) {
  const canvas = page.locator('canvas.editor');
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * pts[0][0], box.y + box.height * pts[0][1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(box.x + box.width * x, box.y + box.height * y, { steps: 8 });
  await page.mouse.up();
}
const builtStatus = (page: Page) => expect.poll(() => page.locator('.status').textContent(), { timeout: 60000 }).toMatch(/built [1-9]\d* glyphs/);
const thumb = (page: Page, ch: string) => page.locator(`.cell[data-char="${ch}"] canvas`).screenshot();

async function seedH(page: Page) {
  await page.locator('.chbtn[data-ch="H"]').click();
  await drawStroke(page, [[0.25, 0.7], [0.25, 0.25]]);
  await drawStroke(page, [[0.55, 0.7], [0.55, 0.25]]);
  await drawStroke(page, [[0.25, 0.48], [0.55, 0.48]]);
  await builtStatus(page);
}


async function exportOtf(page: Page) {
  await page.locator('[data-testid=menu-export]').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-testid=menu-otf]').click()]);
  return download;
}
async function pickFile(page: Page, tab: 'photo' | 'font', file: string) {
  await page.locator(`[data-testid=tab-${tab}]`).click();
  const chooser = page.waitForEvent('filechooser');
  await page.locator(`[data-testid=btn-${tab}]`).click();
  await (await chooser).setFiles(file);
}
const preset = (page: Page, name: string) => page.locator('#preset').selectOption(name);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('fontlab:welcomed', '1'); });
  await page.reload();
});

test('presets and a subtract group change the glyph; layers reorder', async ({ page }) => {
  await seedH(page);
  const plain = await thumb(page, 'H');
  await preset(page, 'Hollow');
  await expect(page.locator('.fxlayer[data-type="hollow"]')).toBeVisible();
  await expect.poll(async () => Buffer.compare(plain, await thumb(page, 'H')), { timeout: 20000 }).not.toBe(0);
  const hollow = await thumb(page, 'H');
  // reorder: move hollow above weight → different result
  await page.locator('.fxlayer[data-type="hollow"]').getByRole('button', { name: 'Move up' }).click();
  await expect(page.locator('.fxlayer').first()).toHaveAttribute('data-type', 'hollow');
  await expect.poll(async () => Buffer.compare(hollow, await thumb(page, 'H')), { timeout: 20000 }).not.toBe(0);
  // Halo preset = two groups with subtract
  await preset(page, 'Halo');
  await expect(page.locator('.fxgroup')).toHaveCount(2);
  await expect(page.locator('.fxgroup').nth(1).locator('.opsel')).toHaveValue('subtract');
  await builtStatus(page);
  const download = await exportOtf(page);
  const buf = fs.readFileSync(await download.path() as string);
  expect(buf.subarray(0, 4).toString('latin1')).toBe('OTTO');
});

test('texture effects run: pixel preset and reaction-diffusion finish', async ({ page }) => {
  await seedH(page);
  const plain = await thumb(page, 'H');
  await preset(page, 'Pixel');
  await expect.poll(async () => Buffer.compare(plain, await thumb(page, 'H')), { timeout: 30000 }).not.toBe(0);
  await preset(page, 'Coral');
  await expect(page.locator('.fxlayer[data-type="reactionDiffusion"]')).toBeVisible();
  await builtStatus(page);
  await expect(page.locator('.cell[data-char="H"]')).not.toHaveClass(/empty/);
});

test('living mode drifts the preview and stops', async ({ page }) => {
  await seedH(page);
  await openPlain(page);
  await page.locator('.preview-input').fill('HHHH');
  await preset(page, 'Ink');
  await builtStatus(page);
  await page.getByRole('button', { name: 'Drift' }).click();
  await expect(page.getByRole('button', { name: 'Drift' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.locator('.status').textContent(), { timeout: 20000 }).toMatch(/living · [\d.]+ fps/);
  const before = await page.locator('.preview-out').screenshot();
  await expect.poll(async () => Buffer.compare(before, await page.locator('.preview-out').screenshot()), { timeout: 15000 }).not.toBe(0);
  await page.getByRole('button', { name: 'Drift' }).click();
  await expect(page.getByRole('button', { name: 'Drift' })).toHaveAttribute('aria-pressed', 'false');
  await builtStatus(page);
});

test('import a font as strokes, then HTML type tester downloads', async ({ page }) => {
  // make a font with the app itself first
  await seedH(page);
  const otf = await exportOtf(page);
  const otfPath = path.join(test.info().outputDir, 'seed.otf');
  await otf.saveAs(otfPath);
  page.on('dialog', (d) => d.dismiss()); // "save before reset?" → discard
  await page.locator('[data-testid=menu-font]').click();
  await page.locator('[data-testid=menu-reset]').click();
  await page.locator('[data-testid=tab-font]').click();
  await page.locator('[data-testid=chk-strokes]').check(); // convert to strokes (opt-in)
  const chooser = page.waitForEvent('filechooser');
  await page.locator('[data-testid=btn-font]').click();
  await (await chooser).setFiles(otfPath);
  await expect(page.locator('.cell[data-char="H"] .badge')).toHaveAttribute('data-source', 'imported', { timeout: 30000 });
  await page.locator('[data-testid=tab-draw]').click();
  await page.locator('.chbtn[data-ch="H"]').click();
  await expect(page.locator('.drawtitle')).toContainText('strokes');
  await builtStatus(page);
  await page.locator('[data-testid=menu-export]').click();
  const [html] = await Promise.all([page.waitForEvent('download'), page.locator('[data-testid=menu-html]').click()]);
  const text = fs.readFileSync(await html.path() as string, 'utf8');
  expect(text).toContain('@font-face');
  expect(text).toContain('font/otf;base64,');
  // Allo-style specimen site sections
  for (const id of ['hero', 'tester', 'glyphs', 'download']) expect(text).toContain(`id="${id}"`);
});

test('import shows the original; crisp preset keeps corners; in-app type tester edits live', async ({ page }) => {
  await preset(page, 'Chonky');
  await pickFile(page, 'font', path.resolve('tests/fixtures/sample.woff2'));
  await expect(page.locator('.cell[data-char="H"] .badge')).toHaveAttribute('data-source', 'imported', { timeout: 60000 });
  await expect(page.locator('#bypassfx')).toBeChecked();
  await builtStatus(page);
  const original = await thumb(page, 'H');
  await page.locator('#bypassfx').uncheck();
  await expect.poll(async () => Buffer.compare(original, await thumb(page, 'H')), { timeout: 30000 }).not.toBe(0);
  await preset(page, 'Chiselled');
  await expect(page.locator('.fxlayer[data-type="chamfer"] .tag.crisp')).toBeVisible();
  await builtStatus(page);
  // in-app tester
  await page.locator('[data-testid=btn-test]').click();
  const free = page.locator('.modal.tester .tblock').first();
  await free.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('HaHa');
  await expect(page.locator('.modal.tester .wline').first()).toContainText('HaHa');
  await page.getByRole('button', { name: 'Dark / light' }).click();
  await expect(page.locator('.modal.tester')).toHaveClass(/dark/);
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.preview-out')).toHaveText('HaHa');
  await expect(page.locator('.preview-input')).toHaveValue('HaHa');
});

test('Randomize fills the stack, Back restores it, SVG glyphs export one group per letter', async ({ page }) => {
  await seedH(page);
  await expect(page.locator('.fxlayer')).toHaveCount(0);
  await page.locator('[data-testid=btn-randomize]').click();
  const n = await page.locator('.fxlayer').count();
  expect(n).toBeGreaterThanOrEqual(2); expect(n).toBeLessThanOrEqual(4);
  await builtStatus(page);
  const download = await exportOtf(page);
  expect(fs.statSync(await download.path() as string).size).toBeGreaterThan(500);
  await page.locator('[data-testid=btn-fx-back]').click();
  await expect(page.locator('.fxlayer')).toHaveCount(0);
  await preset(page, 'Echoes');
  await expect(page.locator('.fxlayer[data-type="echo"]')).toBeVisible();
  await builtStatus(page);
  await page.locator('[data-testid=menu-export]').click();
  const [svg] = await Promise.all([page.waitForEvent('download'), page.locator('[data-testid=menu-svg-glyphs]').click()]);
  const text = fs.readFileSync(await svg.path() as string, 'utf8');
  expect(text).toContain('id="glyph-H"');
  expect(text).toContain('<g ');
});

test('XY pad: dragging changes two effect settings and keeps the sliders in sync', async ({ page }) => {
  await seedH(page);
  await preset(page, 'Twisted');
  await page.locator('.fxlayer[data-type="twist"]').waitFor();
  await page.locator('#preset').selectOption('');
  // add a second slider effect so Y has something to drive
  await page.locator('.addsel').first().selectOption('pinch');
  await page.locator('[data-testid=btn-pad]').click();
  await expect(page.locator('[data-testid=xypad]')).toBeVisible();
  await expect(page.locator('[data-testid=pad-x] option')).toHaveCount(2);
  const before = await page.evaluate(() => JSON.stringify((window as any).__fontlab.project.fx.groups[0].layers.map((l: any) => l.params)));
  const pad = page.locator('[data-testid=pad]');
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.1, { steps: 12 });
  await page.mouse.up();
  const after = await page.evaluate(() => (window as any).__fontlab.project.fx.groups[0].layers.map((l: any) => l.params));
  expect(JSON.stringify(after)).not.toBe(before);
  expect(after[0].degrees).toBeGreaterThan(100); // x at 90 % of −180..180
  expect(after[1].amount).toBeGreaterThan(0.5); // y at 90 % of −1..1
  await expect(page.locator('.fxlayer[data-type="twist"] .slider[data-key="degrees"] .val')).toHaveText(String(after[0].degrees));
  await builtStatus(page);
});

test('Keep as alternate adds ss01 to the font; the preview chip toggles it; inspector shows U+ code', async ({ page }) => {
  await seedH(page);
  await expect(page.locator('.drawtitle .ucode')).toHaveText('U+0048');
  await page.locator('[data-testid=chk-points]').check();
  await page.locator('[data-testid=btn-keep-alt]').click();
  await expect(page.locator('.cell[data-char="H"]')).toHaveClass(/hasalts/);
  await expect(page.locator('.drawtitle')).toContainText('1 alternate');
  const chip = page.locator('[data-testid=feature-chips] .chip[data-feature="ss01"]');
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.preview-out')).toHaveCSS('font-feature-settings', /ss01/);
  await builtStatus(page);
  const download = await exportOtf(page);
  const buf = fs.readFileSync(await download.path() as string);
  expect(buf.includes(Buffer.from('GSUB'))).toBe(true);
  expect(buf.includes(Buffer.from('ss01'))).toBe(true);
  // undo removes the alternate again
  await page.mouse.click(5, 500);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.cell[data-char="H"]')).not.toHaveClass(/hasalts/);
});

test('Write on: the preview writes itself on a canvas overlay, then hands back the text', async ({ page }) => {
  await seedH(page);
  await openPlain(page);
  await page.locator('.preview-input').fill('HH');
  const btn = page.locator('[data-testid=btn-writeon]');
  await expect(btn).toBeEnabled();
  await btn.click();
  await expect(page.locator('canvas.writeon-canvas')).toBeVisible();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.preview-out')).toHaveCSS('visibility', 'hidden');
  await expect(page.locator('canvas.writeon-canvas')).toHaveCount(0, { timeout: 10000 });
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.preview-out')).toHaveCSS('visibility', 'visible');
  // Escape stops early
  await btn.click();
  await expect(page.locator('canvas.writeon-canvas')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('canvas.writeon-canvas')).toHaveCount(0);
});

test('Animate dialog defaults to Write on and exports an animated SVG', async ({ page }) => {
  await seedH(page);
  await page.locator('[data-testid=menu-export]').click();
  await page.locator('[data-testid=menu-animate]').click();
  const sel = page.locator('[data-testid=animate-sweep]');
  await expect(sel).toHaveValue('writeon');
  await page.locator('.modal input.labels').fill('HH');
  await page.getByRole('button', { name: 'Preview frames' }).click();
  await expect(page.locator('.modal .status')).toContainText('frames');
  const [svg] = await Promise.all([page.waitForEvent('download'), page.locator('[data-testid=btn-writeon-svg]').click()]);
  expect(svg.suggestedFilename()).toMatch(/-write-on\.svg$/);
  const text = fs.readFileSync(await svg.path() as string, 'utf8');
  expect(text).toContain('stroke-dashoffset');
  expect(text).toContain('<mask');
  // other sweep modes still work and hide the SVG button
  await sel.selectOption('seed');
  await expect(page.locator('[data-testid=btn-writeon-svg]')).toBeHidden();
  await page.getByRole('button', { name: 'Preview frames' }).click();
  await expect(page.locator('.modal .status')).toHaveText('Previewed last frame', { timeout: 30000 });
});
