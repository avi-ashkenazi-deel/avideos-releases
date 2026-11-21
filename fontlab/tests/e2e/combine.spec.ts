import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('fontlab:welcomed', '1'); });
  await page.reload();
});

test('combine Thin + Bold files into one variable font', async ({ page }) => {
  test.setTimeout(240_000);
  await page.locator('[data-testid=menu-export]').click();
  await page.locator('[data-testid=menu-combine]').click();
  const dlg = page.locator('[data-testid=combine-dialog]');
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole('button', { name: 'Build variable font' })).toBeDisabled();
  await page.locator('[data-testid=combine-files]').setInputFiles([
    path.resolve('tests/fixtures/combine-bold.ttf'),
    path.resolve('tests/fixtures/combine-thin.ttf'),
  ]);
  const rows = dlg.locator('[data-testid=combine-row]');
  await expect(rows).toHaveCount(2);
  // sorted by weight, read from OS/2
  await expect(rows.nth(0).locator('.cw-weight')).toHaveValue('100');
  await expect(rows.nth(1).locator('.cw-weight')).toHaveValue('700');
  await expect(rows.nth(0)).toContainText('TrueType');
  // duplicate weights block the build
  await rows.nth(1).locator('.cw-weight').fill('100');
  await rows.nth(1).locator('.cw-weight').dispatchEvent('change');
  await expect(dlg.getByRole('button', { name: 'Build variable font' })).toBeDisabled();
  await expect(dlg).toContainText('same weight');
  await rows.nth(1).locator('.cw-weight').fill('700');
  await rows.nth(1).locator('.cw-weight').dispatchEvent('change');
  const build = dlg.getByRole('button', { name: 'Build variable font' });
  await expect(build).toBeEnabled();
  if (process.env.FONTLAB_OFFLINE) return; // the build loads Python from the CDN
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 200_000 }), build.click()]);
  expect(download.suggestedFilename()).toMatch(/Variable\.ttf$/);
  const buf = fs.readFileSync(await download.path() as string);
  expect(buf.includes(Buffer.from('fvar'))).toBe(true);
  expect(buf.includes(Buffer.from('gvar'))).toBe(true);
  await expect(dlg.locator('.status')).toContainText('weight 100–700');
  // live preview follows the slider
  const word = dlg.locator('.combine-word');
  await expect(word).toBeVisible();
  const slider = dlg.locator('.combine-demo input[type=range]');
  await slider.fill('600');
  await expect(word).toHaveCSS('font-variation-settings', /"wght" 600/);
});
