import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

async function drawStroke(page: Page, pts: [number, number][]) {
  const canvas = page.locator('canvas.editor');
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * pts[0][0], box.y + box.height * pts[0][1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(box.x + box.width * x, box.y + box.height * y, { steps: 8 });
  await page.mouse.up();
}
const builtStatus = (page: Page) => expect.poll(() => page.locator('.status').textContent(), { timeout: 60000 }).toMatch(/built \d+ glyphs/);
const thumb = (page: Page, ch: string) => page.locator(`.cell[data-char="${ch}"] canvas`).screenshot();

async function seedH(page: Page) {
  await page.locator('.chbtn[data-ch="H"]').click();
  await drawStroke(page, [[0.25, 0.7], [0.25, 0.25]]);
  await drawStroke(page, [[0.55, 0.7], [0.55, 0.25]]);
  await drawStroke(page, [[0.25, 0.48], [0.55, 0.48]]);
  await builtStatus(page);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test('presets and a subtract group change the glyph; layers reorder', async ({ page }) => {
  await seedH(page);
  const plain = await thumb(page, 'H');
  await page.getByRole('button', { name: 'Hollow', exact: true }).click();
  await expect(page.locator('.fxlayer[data-type="hollow"]')).toBeVisible();
  await expect.poll(async () => Buffer.compare(plain, await thumb(page, 'H')), { timeout: 20000 }).not.toBe(0);
  const hollow = await thumb(page, 'H');
  // reorder: move hollow above weight → different result
  await page.locator('.fxlayer[data-type="hollow"] button', { hasText: '▲' }).click();
  await expect(page.locator('.fxlayer').first()).toHaveAttribute('data-type', 'hollow');
  await expect.poll(async () => Buffer.compare(hollow, await thumb(page, 'H')), { timeout: 20000 }).not.toBe(0);
  // Halo preset = two groups with subtract
  await page.getByRole('button', { name: 'Halo', exact: true }).click();
  await expect(page.locator('.fxgroup')).toHaveCount(2);
  await expect(page.locator('.fxgroup').nth(1).locator('.opsel')).toHaveValue('subtract');
  await builtStatus(page);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download \.otf/ }).click()]);
  const buf = fs.readFileSync(await download.path() as string);
  expect(buf.subarray(0, 4).toString('latin1')).toBe('OTTO');
});

test('texture effects run: pixel preset and reaction-diffusion finish', async ({ page }) => {
  await seedH(page);
  const plain = await thumb(page, 'H');
  await page.getByRole('button', { name: 'Pixel', exact: true }).click();
  await expect.poll(async () => Buffer.compare(plain, await thumb(page, 'H')), { timeout: 30000 }).not.toBe(0);
  await page.getByRole('button', { name: 'Coral', exact: true }).click();
  await expect(page.locator('.fxlayer[data-type="reactionDiffusion"]')).toBeVisible();
  await builtStatus(page);
  await expect(page.locator('.cell[data-char="H"]')).not.toHaveClass(/empty/);
});

test('living mode drifts the preview and stops', async ({ page }) => {
  await seedH(page);
  await page.locator('.preview-input').fill('HHHH');
  await page.getByRole('button', { name: 'Ink', exact: true }).click();
  await builtStatus(page);
  await page.getByRole('button', { name: /Living: off/ }).click();
  await expect(page.getByRole('button', { name: /Living: on/ })).toBeVisible();
  await expect.poll(() => page.locator('.status').textContent(), { timeout: 20000 }).toMatch(/living · [\d.]+ fps/);
  const before = await page.locator('.preview-out').screenshot();
  await expect.poll(async () => Buffer.compare(before, await page.locator('.preview-out').screenshot()), { timeout: 15000 }).not.toBe(0);
  await page.getByRole('button', { name: /Living: on/ }).click();
  await expect(page.getByRole('button', { name: /Living: off/ })).toBeVisible();
  await builtStatus(page);
});

test('import a font as strokes, then HTML type tester downloads', async ({ page }) => {
  // make a font with the app itself first
  await seedH(page);
  const [otf] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download \.otf/ }).click()]);
  const otfPath = path.join(test.info().outputDir, 'seed.otf');
  await otf.saveAs(otfPath);
  await page.getByRole('button', { name: 'New' }).click().catch(() => {});
  page.on('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'New' }).click();
  await page.locator('.sources .toggle input').check(); // convert to strokes (opt-in)
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Remix an existing font/ }).click();
  await (await chooser).setFiles(otfPath);
  await expect(page.locator('.cell[data-char="H"] .badge')).toHaveText('⬇', { timeout: 30000 });
  await page.locator('.chbtn[data-ch="H"]').click();
  await expect(page.locator('.seeds h2')).toContainText('strokes');
  await builtStatus(page);
  const [html] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Tester \.html/ }).click()]);
  const text = fs.readFileSync(await html.path() as string, 'utf8');
  expect(text).toContain('@font-face');
  expect(text).toContain('font/otf;base64,');
});

test('import shows the original; crisp preset keeps corners; in-app type tester edits live', async ({ page }) => {
  await page.getByRole('button', { name: 'Chonky', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Remix an existing font/ }).click();
  await (await chooser).setFiles(path.resolve('tests/fixtures/sample.woff2'));
  await expect(page.locator('.cell[data-char="H"] .badge')).toHaveText('⬇', { timeout: 60000 });
  await expect(page.locator('#bypassfx')).toBeChecked();
  await builtStatus(page);
  const original = await thumb(page, 'H');
  await page.locator('#bypassfx').uncheck();
  await expect.poll(async () => Buffer.compare(original, await thumb(page, 'H')), { timeout: 30000 }).not.toBe(0);
  await page.getByRole('button', { name: 'Chiselled', exact: true }).click();
  await expect(page.locator('.fxlayer[data-type="chamfer"] .tag.crisp')).toBeVisible();
  await builtStatus(page);
  // in-app tester
  await page.getByRole('button', { name: '🧪 Type tester' }).click();
  const free = page.locator('.modal.tester .tblock').first();
  await free.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('HaHa');
  await expect(page.locator('.modal.tester .wline').first()).toContainText('HaHa');
  await page.getByRole('button', { name: '☾ Dark' }).click();
  await expect(page.locator('.modal.tester')).toHaveClass(/dark/);
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.preview-out')).toHaveText('HaHa');
  await expect(page.locator('.preview-input')).toHaveValue('HaHa');
});
