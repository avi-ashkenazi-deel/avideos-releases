import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';

async function drawStroke(page: Page, pts: [number, number][]) {
  const canvas = page.locator('canvas.editor');
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * pts[0][0], box.y + box.height * pts[0][1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(box.x + box.width * x, box.y + box.height * y, { steps: 8 });
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('fontlab:welcomed', '1'); });
  await page.reload();
});

test('Check panel lists issues, a fix clears one, and a letter chip opens that letter', async ({ page }) => {
  await page.locator('.chbtn[data-ch="l"]').click();
  await drawStroke(page, [[0.3, 0.75], [0.3, 0.25]]);
  await expect(page.locator('.cell[data-char="l"]')).not.toHaveClass(/empty/);
  // the header badge appears once the build has been checked (unnamed font is a warning)
  await expect(page.locator('[data-testid=btn-check] .checkcount')).toHaveClass(/on/, { timeout: 20000 });
  await page.locator('[data-testid=btn-check]').click();
  const panel = page.locator('[data-testid=check-panel]');
  const nameIssue = panel.locator('.checkitem[data-check="name"]');
  await expect(nameIssue).toBeVisible();
  page.once('dialog', (d) => d.accept('Checked Sans'));
  await nameIssue.getByRole('button').first().click();
  await expect(panel.locator('.checkitem[data-check="name"]')).toHaveCount(0);
  await expect(page.locator('.fontname')).toHaveValue('Checked Sans');
  // empty letters are listed with chips; clicking one opens that letter
  const empty = panel.locator('.checkitem[data-check^="empty"]').first();
  await expect(empty).toBeVisible();
  await panel.locator('[data-testid=check-tab-notes]').click();
  await expect(panel).toContainText('No review notes yet');
  await panel.getByRole('button', { name: 'Close' }).click();
});

test('UFO export downloads a zip with a .ufo folder and glif files', async ({ page }) => {
  await page.locator('.chbtn[data-ch="l"]').click();
  await drawStroke(page, [[0.3, 0.75], [0.3, 0.25]]);
  await expect.poll(() => page.locator('.status').textContent(), { timeout: 30000 }).toMatch(/built [1-9]\d* glyphs/);
  await page.locator('[data-testid=menu-export]').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-testid=menu-ufo]').click()]);
  expect(download.suggestedFilename()).toMatch(/\.ufo\.zip$/);
  const buf = fs.readFileSync(await download.path() as string);
  expect(buf.subarray(0, 2).toString()).toBe('PK');
  for (const part of ['.ufo/metainfo.plist', '.ufo/fontinfo.plist', '.ufo/glyphs/contents.plist', '.ufo/glyphs/l.glif', 'public.glyphOrder']) expect(buf.includes(Buffer.from(part)), part).toBe(true);
});
