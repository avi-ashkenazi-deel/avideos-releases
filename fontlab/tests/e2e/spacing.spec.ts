import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';

const built = (page: Page) => expect.poll(() => page.locator('.status').textContent(), { timeout: 60000 }).toMatch(/built [1-9]\d* glyphs/);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('fontlab:welcomed', '1'); });
  await page.reload();
});

test('auto spacing, auto kerning and a hand-set pair reach the font', async ({ page }) => {
  // a whole alphabet to work with
  await page.getByRole('button', { name: /Generate the rest/ }).click();
  await expect(page.locator('.cell:not(.empty)')).toHaveCount(62, { timeout: 60000 });
  await built(page);
  const width = (text: string, kern: 'normal' | 'none') => page.evaluate(([t, k]) => {
    const el = document.createElement('span');
    el.style.cssText = `font: 200px FunkyPreview; font-kerning: ${k}; position: absolute; white-space: nowrap; visibility: hidden`;
    el.textContent = t; document.body.append(el);
    const w = el.getBoundingClientRect().width; el.remove(); return w;
  }, [text, kern]);
  const advanceBefore = await page.evaluate(() => (window as any).__fontlab.project.glyphs.o.advance);

  await page.locator('[data-testid=btn-spacing]').click();
  const dlg = page.locator('[data-testid=spacing-dialog]');
  await dlg.locator('[data-testid=btn-autospace]').click();
  await expect.poll(() => page.evaluate(() => (window as any).__fontlab.project.glyphs.o.advance)).not.toBe(advanceBefore);
  // round letters sit closer than straight ones after auto spacing
  const sb = await page.evaluate(() => { const g = (window as any).__fontlab.project.glyphs; return { o: g.o.advance, n: g.n.advance }; });
  expect(sb.o).toBeGreaterThan(100);

  await dlg.locator('[data-testid=chk-autokern]').check();
  await expect(dlg.locator('[data-testid=kern-stats]')).toContainText(/\d+ kerning pairs? in the font/, { timeout: 30000 });
  await expect.poll(() => page.evaluate(() => (window as any).__fontlab.kerning.AV ?? 0), { timeout: 30000 }).toBeLessThan(0);
  const auto = await page.evaluate(() => (window as any).__fontlab.kerning);
  expect(auto.HH ?? 0).toBe(0);
  // the browser applies it: AV is narrower with kerning than without, by the pair value
  await expect.poll(async () => (await width('AV', 'none')) - (await width('AV', 'normal')), { timeout: 20000 }).toBeCloseTo(-auto.AV * 0.2, 0);

  // hand-set pair wins over the automatic value
  await dlg.locator('[data-testid=pair-input]').fill('HH');
  await dlg.locator('[data-testid=pair-value]').fill('-60');
  await dlg.locator('[data-testid=pair-value]').press('Tab');
  await expect.poll(() => page.evaluate(() => (window as any).__fontlab.kerning.HH), { timeout: 20000 }).toBe(-60);
  await expect(dlg.locator('[data-testid=manual-pairs]')).toContainText('-60');
  await dlg.getByRole('button', { name: 'Close' }).click();

  // exported OTF carries GPOS; the UFO carries kerning.plist
  await page.locator('[data-testid=menu-export]').click();
  const [otf] = await Promise.all([page.waitForEvent('download'), page.locator('[data-testid=menu-otf]').click()]);
  expect(fs.readFileSync(await otf.path() as string).includes(Buffer.from('GPOS'))).toBe(true);
  await page.locator('[data-testid=menu-export]').click();
  const [ufo] = await Promise.all([page.waitForEvent('download'), page.locator('[data-testid=menu-ufo]').click()]);
  expect(fs.readFileSync(await ufo.path() as string).includes(Buffer.from('kerning.plist'))).toBe(true);

  // undo history covers kerning: Ctrl+Z removes the hand-set pair
  await page.mouse.click(5, 500);
  await page.keyboard.press('Control+z');
  await expect.poll(() => page.evaluate(() => (window as any).__fontlab.project.kerning.pairs.HH)).toBeUndefined();
});
