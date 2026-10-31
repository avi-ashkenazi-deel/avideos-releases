import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

async function drawStroke(page: Page, pts: [number, number][]) {
  await page.locator('canvas.editor').scrollIntoViewIfNeeded();
  const box = (await page.locator('canvas.editor').boundingBox())!;
  const [x0, y0] = pts[0];
  await page.mouse.move(box.x + box.width * x0, box.y + box.height * y0);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(box.x + box.width * x, box.y + box.height * y, { steps: 8 });
  await page.mouse.up();
}
const waitBuilt = (page: Page, n: number) => expect.poll(() => page.locator('.status').textContent(), { timeout: 60000 }).toMatch(new RegExp(`built ${n} glyphs`));


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

test('Cyrillic + Hebrew blocks generate and render in the preview', async ({ page }) => {
  await page.locator('.chbtn[data-ch="o"]').click();
  await drawStroke(page, [[0.3, 0.55], [0.45, 0.45], [0.6, 0.55], [0.45, 0.72], [0.3, 0.55]]);
  await page.locator('.charset label', { hasText: 'Cyrillic' }).locator('input').check();
  await page.locator('.charset label', { hasText: 'Hebrew' }).locator('input').check();
  await expect(page.locator('.grid-group', { hasText: 'Hebrew' })).toBeVisible();
  await page.getByRole('button', { name: /Generate the rest/ }).click();
  const expected = 62 + 64 + 12 + 27; // latin + А..я + ЁёЄєІіЇїҐґЈј + hebrew
  await expect(page.locator('.cell:not(.empty)')).toHaveCount(expected, { timeout: 60000 });
  await waitBuilt(page, expected);
  await page.getByRole('button', { name: /sample text/i }).click();
  await expect(page.locator('.preview-input')).toHaveValue(/Съешь/);
  await expect(page.locator('.preview-input')).toHaveValue(/דג/);
  await expect.poll(() => page.evaluate(() => document.fonts.check('12px FunkyPreview', 'Жש')), { timeout: 20000 }).toBe(true);
  // the Cyrillic о is a clone of the drawn o
  await expect(page.locator('.cell[data-char="о"] .badge')).toHaveAttribute('data-source', 'generated');
});

test('accented letters follow the drawn base letter', async ({ page }) => {
  await page.locator('.charset label', { hasText: 'Latin accents' }).locator('input').check();
  await page.locator('.chbtn[data-ch="e"]').click();
  await drawStroke(page, [[0.3, 0.58], [0.6, 0.58], [0.58, 0.45], [0.45, 0.42], [0.32, 0.5], [0.33, 0.66], [0.45, 0.72], [0.6, 0.68]]);
  await page.getByRole('button', { name: /Generate the rest/ }).click();
  await expect(page.locator('.cell[data-char="é"]')).not.toHaveClass(/empty/, { timeout: 60000 });
  await expect.poll(() => page.locator('.status').textContent(), { timeout: 60000 }).toMatch(/built \d+ glyphs/);
  const before = await page.locator('.cell[data-char="é"] canvas').screenshot();
  // draw over e again: é must update
  await page.locator('.chbtn[data-ch="e"]').click();
  await drawStroke(page, [[0.3, 0.3], [0.6, 0.3]]);
  await expect.poll(async () => Buffer.compare(before, await page.locator('.cell[data-char="é"] canvas').screenshot()), { timeout: 30000 }).not.toBe(0);
});

test('custom characters can be added, drawn and exported', async ({ page }) => {
  await page.locator('.charset input[type=text]').fill('★');
  await page.locator('.charset').getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('.chbtn[data-ch="★"]')).toBeVisible();
  await page.locator('.chbtn[data-ch="★"]').click();
  await drawStroke(page, [[0.3, 0.7], [0.45, 0.3], [0.6, 0.7], [0.25, 0.45], [0.65, 0.45], [0.3, 0.7]]);
  await expect(page.locator('.cell[data-char="★"]')).not.toHaveClass(/empty/);
  await expect.poll(() => page.locator('.status').textContent(), { timeout: 20000 }).toMatch(/built 1 glyphs/);
  const download = await exportOtf(page);
  const file = path.join(test.info().outputDir, 'star.otf');
  await download.saveAs(file);
  const ot = await import('opentype.js');
  const buf = fs.readFileSync(file);
  const font = ((ot as any).default?.parse ?? (ot as any).parse)(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const g = font.charToGlyph('★');
  expect(g.index).toBeGreaterThan(0);
  expect(g.name).toBe('uni2605');
});

test('dense specimen sheet: frame removed, letters split, labels previewed, mismatch blocked', async ({ page }) => {
  await pickFile(page, 'photo', path.resolve('tests/fixtures/sheet.png'));
  await expect(page.locator('.modal .cellwrap')).toHaveCount(32, { timeout: 60000 });
  await expect(page.locator('.modal p').first()).toContainText('32 letter cells on 4 lines');
  const labels = page.locator('.modal .labels');
  await labels.fill('abcdefghijklmnopqrstuvwxyz0123');
  await expect(page.locator('.modal .cellwrap').first().locator('.celllabel')).toHaveValue('a');
  await expect(page.getByRole('button', { name: 'Add 30 of 32' })).toBeEnabled();
  await labels.fill('abcdefghijklmnopqrstuvwxyz01234567');
  await expect(page.getByRole('button', { name: 'Add as seeds' })).toBeDisabled();
  await expect(page.locator('.modal .status')).toContainText('2 more letters typed than tiles');
  // skip the first cell → labels shift
  await labels.fill('abcdefghijklmnopqrstuvwxyz01234');
  await page.locator('.modal .cellwrap').first().click();
  await expect(page.locator('.modal .cellwrap').first()).toHaveClass(/skipped/);
  await expect(page.locator('.modal .cellwrap').nth(1).locator('.celllabel')).toHaveValue('a');
  await page.getByRole('button', { name: 'Add as seeds' }).click();
  await expect(page.locator('.cell[data-char="a"] .badge')).toHaveAttribute('data-source', 'traced');
  await expect(page.locator('.cell[data-char="4"] .badge')).toHaveAttribute('data-source', 'traced');
});

test('remix a .woff2 font (decoded in the browser)', async ({ page }) => {
  await pickFile(page, 'font', path.resolve('tests/fixtures/sample.woff2'));
  await expect(page.locator('.cell[data-char="A"] .badge')).toHaveAttribute('data-source', 'imported', { timeout: 60000 });
  await expect(page.locator('.cell[data-char="z"] .badge')).toHaveAttribute('data-source', 'imported');
  await expect(page.locator('.fontname')).toHaveValue(/Sample Funk/);
});
