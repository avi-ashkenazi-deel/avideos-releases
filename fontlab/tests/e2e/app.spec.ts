import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

async function drawStroke(page: Page, pts: [number, number][]) {
  const canvas = page.locator('canvas.editor');
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  const [x0, y0] = pts[0];
  await page.mouse.move(box.x + box.width * x0, box.y + box.height * y0);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(box.x + box.width * x, box.y + box.height * y, { steps: 8 });
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test('draw a letter, see it in the grid and as a real font', async ({ page }) => {
  await page.locator('.chbtn[data-ch="l"]').click();
  await drawStroke(page, [[0.3, 0.75], [0.3, 0.25]]);
  await expect(page.locator('.seeds h2')).toContainText('1 strokes');
  await expect(page.locator('.cell[data-char="l"]')).not.toHaveClass(/empty/);
  await page.locator('.preview-input').fill('lll');
  await expect.poll(() => page.evaluate(() => document.fonts.check('12px FunkyPreview')), { timeout: 15000 }).toBe(true);
});

test('generate the alphabet from seeds and export an OTF', async ({ page }) => {
  await page.locator('.chbtn[data-ch="o"]').click();
  await drawStroke(page, [[0.3, 0.5], [0.45, 0.4], [0.6, 0.5], [0.45, 0.7], [0.3, 0.5]]);
  await page.locator('.chbtn[data-ch="n"]').click();
  await drawStroke(page, [[0.3, 0.72], [0.3, 0.45], [0.5, 0.4], [0.6, 0.5], [0.6, 0.72]]);
  await page.getByRole('button', { name: /Generate the rest/ }).click();
  await expect(page.locator('.cell:not(.empty)')).toHaveCount(62, { timeout: 20000 });
  await expect.poll(() => page.locator('.status').textContent(), { timeout: 20000 }).toMatch(/built 62 glyphs/);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /Download \.otf/ }).click(),
  ]);
  const file = path.join(test.info().outputDir, 'out.otf');
  await download.saveAs(file);
  const buf = fs.readFileSync(file);
  expect(buf.length).toBeGreaterThan(2000);
  expect(buf.subarray(0, 4).toString('latin1')).toBe('OTTO');
});

test('DNA sliders visibly change the glyphs', async ({ page }) => {
  await page.locator('.chbtn[data-ch="H"]').click();
  await drawStroke(page, [[0.25, 0.7], [0.25, 0.25]]);
  await drawStroke(page, [[0.55, 0.7], [0.55, 0.25]]);
  await drawStroke(page, [[0.25, 0.48], [0.55, 0.48]]);
  await expect.poll(() => page.locator('.status').textContent()).toMatch(/built/);
  const before = await page.locator('.cell[data-char="H"] canvas').screenshot();
  const melt = page.locator('.dna .slider', { hasText: 'Melt' }).locator('input');
  await melt.fill('0.9');
  await melt.dispatchEvent('input');
  await page.waitForTimeout(800);
  const after = await page.locator('.cell[data-char="H"] canvas').screenshot();
  expect(Buffer.compare(before, after)).not.toBe(0);
});

test('project survives reload and JSON round-trip', async ({ page }) => {
  await page.locator('.chbtn[data-ch="i"]').click();
  await drawStroke(page, [[0.3, 0.72], [0.3, 0.45]]);
  await page.locator('.fontname').fill('Roundtrip');
  await page.locator('.fontname').dispatchEvent('change');
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(page.locator('.fontname')).toHaveValue('Roundtrip');
  await expect(page.locator('.cell[data-char="i"]')).not.toHaveClass(/empty/);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save .json' }).click()]);
  const file = path.join(test.info().outputDir, 'p.json');
  await download.saveAs(file);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(json.version).toBe(1);
  expect(json.glyphs.i.strokes.length).toBe(1);
});

test('trace a handwriting photo into seeds', async ({ page }) => {
  const fixture = path.resolve('tests/fixtures/handwriting.png');
  test.skip(!fs.existsSync(fixture), 'fixture missing');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Trace a photo/ }).click();
  await (await chooser).setFiles(fixture);
  await expect(page.locator('.modal .cellthumb')).toHaveCount(3, { timeout: 30000 });
  await page.locator('.modal .labels').fill('abc');
  await page.getByRole('button', { name: 'Add as seeds' }).click();
  await expect(page.locator('.cell[data-char="a"] .badge')).toHaveText('📷');
  await expect(page.locator('.cell[data-char="c"] .badge')).toHaveText('📷');
});
