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

/** distinct strongly coloured pixels when "HH" is drawn with the preview font */
const colours = (page: Page) => page.evaluate(async () => {
  await (document as any).fonts.load('200px FunkyPreview', 'H');
  const cv = document.createElement('canvas'); cv.width = 500; cv.height = 300;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 500, 300);
  ctx.fillStyle = '#111'; ctx.font = '200px FunkyPreview'; ctx.fillText('HH', 20, 220);
  const d = ctx.getImageData(0, 0, 500, 300).data; const seen = new Set<string>();
  for (let i = 0; i < d.length; i += 4) {
    const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 90) seen.add(`${r >> 5},${g >> 5},${b >> 5}`);
  }
  return seen.size;
});

test('colour font: strokes get their own colours in the preview and COLR/CPAL in the export', async ({ page }) => {
  await page.locator('.chbtn[data-ch="H"]').click();
  await drawStroke(page, [[0.25, 0.7], [0.25, 0.25]]);
  await drawStroke(page, [[0.55, 0.7], [0.55, 0.25]]);
  await drawStroke(page, [[0.25, 0.48], [0.55, 0.48]]);
  await expect.poll(() => page.locator('.status').textContent(), { timeout: 60000 }).toMatch(/built [1-9]\d* glyphs/);
  expect(await colours(page)).toBe(0); // plain font: only the text colour

  await page.locator('[data-testid=chk-color]').check();
  await expect(page.locator('[data-testid=color-mode]')).toHaveValue('strokes');
  await expect.poll(() => page.evaluate(() => (window as any).__fontlab.built.H?.layers?.length ?? 0), { timeout: 30000 }).toBe(3);
  await expect.poll(() => colours(page), { timeout: 30000 }).toBeGreaterThanOrEqual(3);

  // another mode
  await page.locator('[data-testid=color-mode]').selectOption('shadow');
  await expect.poll(() => page.evaluate(() => (window as any).__fontlab.built.H?.layers?.length ?? 0), { timeout: 30000 }).toBe(2);

  await page.locator('[data-testid=menu-export]').click();
  const [otf] = await Promise.all([page.waitForEvent('download'), page.locator('[data-testid=menu-otf]').click()]);
  const buf = fs.readFileSync(await otf.path() as string);
  expect(buf.includes(Buffer.from('COLR'))).toBe(true);
  expect(buf.includes(Buffer.from('CPAL'))).toBe(true);

  // survives a reload (autosaved with the font)
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(page.locator('[data-testid=chk-color]')).toBeChecked();
  await expect(page.locator('[data-testid=color-mode]')).toHaveValue('shadow');
});
