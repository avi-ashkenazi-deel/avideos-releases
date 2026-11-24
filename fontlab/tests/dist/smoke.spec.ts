import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

// The same build must work at the root of a host and inside any sub-folder.
const PLACES = ['/', '/sub/fontlab/'];

function watch(page: Page) {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => { if (!r.url().includes('cdn.jsdelivr.net') && !r.url().includes('peerjs')) problems.push(`failed: ${r.url()}`); });
  page.on('response', (r) => { if (r.status() >= 400 && r.url().startsWith('http://127.0.0.1')) problems.push(`${r.status()}: ${r.url()}`); });
  return problems;
}

for (const place of PLACES) {
  test(`built site works when served from ${place}`, async ({ page }) => {
    const problems = watch(page);
    await page.goto(place);
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('fontlab:welcomed', '1'); });
    await page.reload();
    // assets are relative: everything loaded from under this address
    await expect(page.locator('.fontname')).toBeVisible();
    expect((await page.request.get(`${place}fontlab.config.json`)).status()).toBe(200);

    // the build worker runs (its script is loaded relative to the page)
    await page.getByRole('button', { name: /Generate the rest/ }).click();
    await expect(page.locator('.cell:not(.empty)')).toHaveCount(62, { timeout: 60000 });
    await expect.poll(() => page.locator('.status').textContent(), { timeout: 60000 }).toMatch(/built [1-9]\d* glyphs/);
    await expect.poll(() => page.evaluate(() => (document as any).fonts.check('12px FunkyPreview')), { timeout: 20000 }).toBe(true);

    // font import decodes woff2 in its own worker
    await page.locator('[data-testid=tab-font]').click();
    const chooser = page.waitForEvent('filechooser');
    await page.locator('[data-testid=btn-font]').click();
    await (await chooser).setFiles(path.resolve('tests/fixtures/sample.woff2'));
    await expect(page.locator('.cell[data-char="A"] .badge')).toHaveAttribute('data-source', 'imported', { timeout: 60000 });

    // export
    await page.locator('[data-testid=menu-export]').click();
    const [otf] = await Promise.all([page.waitForEvent('download'), page.locator('[data-testid=menu-otf]').click()]);
    expect(fs.statSync(await otf.path() as string).size).toBeGreaterThan(2000);

    expect(problems, problems.join('\n')).toEqual([]);
  });
}

test('a shared session works on the built site, and its link keeps the sub-folder', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const host = await context.newPage();
  const problems = watch(host);
  await host.goto('/sub/fontlab/?via=local');
  await host.evaluate(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('fontlab:welcomed', '1'); });
  await host.reload();
  await host.getByRole('button', { name: /Generate the rest/ }).click();
  await expect(host.locator('.cell:not(.empty)')).toHaveCount(62, { timeout: 60000 });
  await host.locator('[data-testid=btn-share]').click();
  await host.locator('[data-testid=share-name]').fill('Hana');
  await host.locator('[data-testid=share-start]').click();
  const link = await host.locator('[data-testid=share-link]').inputValue();
  expect(link).toMatch(/^http:\/\/127\.0\.0\.1:5199\/sub\/fontlab\/\?join=[A-Za-z0-9_-]+&via=local$/);
  await host.locator('[data-testid=share-dialog]').getByRole('button', { name: 'Close' }).click();

  const guest = await context.newPage();
  await guest.goto(link);
  await guest.locator('[data-testid=join-name]').fill('Gus');
  await guest.locator('[data-testid=join-go]').click();
  await expect(guest.locator('.cell:not(.empty)')).toHaveCount(62, { timeout: 60000 });
  await expect(host.locator('[data-testid=avatars] .avatar')).toHaveCount(1);
  // a change by the guest reaches the host
  await guest.locator('.cell[data-char="q"]').click();
  await guest.keyboard.press('Delete');
  await expect(host.locator('.cell[data-char="q"]')).toHaveClass(/empty/, { timeout: 15000 });
  expect(problems, problems.join('\n')).toEqual([]);
  await context.close();
});
