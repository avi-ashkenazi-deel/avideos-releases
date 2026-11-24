import { test, expect, type Page } from '@playwright/test';

async function drawStroke(page: Page, pts: [number, number][]) {
  const canvas = page.locator('canvas.editor');
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * pts[0][0], box.y + box.height * pts[0][1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(box.x + box.width * x, box.y + box.height * y, { steps: 8 });
  await page.mouse.up();
}
const openVersions = async (page: Page) => { await page.locator('[data-testid=menu-font]').click(); await page.locator('[data-testid=menu-versions]').click(); };

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    localStorage.clear(); localStorage.setItem('fontlab:welcomed', '1');
    await new Promise((r) => { const q = indexedDB.deleteDatabase('fontlab-versions'); q.onsuccess = q.onerror = q.onblocked = () => r(null); });
  });
  await page.reload();
});

test('versions: save, compare, restore (with an automatic safety version) and survive a reload', async ({ page }) => {
  await page.locator('.chbtn[data-ch="l"]').click();
  await drawStroke(page, [[0.3, 0.75], [0.3, 0.25]]);
  await expect(page.locator('.cell[data-char="l"]')).not.toHaveClass(/empty/);
  await openVersions(page);
  const dlg = page.locator('[data-testid=versions-dialog]');
  await expect(dlg).toContainText('No versions yet');
  await page.locator('[data-testid=version-name]').fill('Only l');
  await page.locator('[data-testid=version-save]').click();
  await expect(dlg.locator('[data-testid=version-row]')).toHaveCount(1);
  await dlg.getByRole('button', { name: 'Close' }).click();

  // change the font: add a second letter
  await page.locator('.chbtn[data-ch="i"]').click();
  await drawStroke(page, [[0.4, 0.7], [0.4, 0.45]]);
  await expect(page.locator('.cell[data-char="i"]')).not.toHaveClass(/empty/);

  await openVersions(page);
  await dlg.locator('[data-testid=version-row]').first().getByRole('button', { name: 'Compare' }).click();
  await expect(dlg.locator('[data-testid=version-diff]')).toContainText('Added since: i');
  page.once('dialog', (d) => d.accept());
  await dlg.locator('[data-testid=version-row]').first().getByRole('button', { name: 'Restore' }).click();
  await expect(dlg).toHaveCount(0);
  await expect(page.locator('.cell[data-char="i"]')).toHaveClass(/empty/);
  await expect(page.locator('.cell[data-char="l"]')).not.toHaveClass(/empty/);

  // the state before the restore was kept automatically, and versions persist
  await page.waitForTimeout(900);
  await page.reload();
  await openVersions(page);
  await expect(dlg.locator('[data-testid=version-row]')).toHaveCount(2);
  await expect(dlg).toContainText('Before restoring');
  await expect(dlg).toContainText('automatic');
});
