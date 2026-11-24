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
const strokes = (page: Page, ch: string) => page.evaluate((c) => (window as any).__fontlab.project.glyphs[c]?.strokes?.length ?? 0, ch);
const cell = (page: Page, ch: string) => page.locator(`.cell[data-char="${ch}"]`);

test('two people share a font: join by link, edits flow both ways, one person per letter, watch-only with notes', async ({ browser }) => {
  test.setTimeout(120_000);
  // two tabs of one browser, connected through the same-browser transport (?via=local)
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const host = await context.newPage();
  await host.goto('/?via=local');
  await host.evaluate(() => { localStorage.clear(); localStorage.setItem('fontlab:welcomed', '1'); });
  await host.reload();

  // the host draws a letter, names the font and starts a session
  await host.locator('.chbtn[data-ch="l"]').click();
  await drawStroke(host, [[0.3, 0.75], [0.3, 0.25]]);
  await expect(cell(host, 'l')).not.toHaveClass(/empty/);
  await host.locator('.fontname').fill('Shared Sans');
  await host.locator('.fontname').press('Tab');
  await host.locator('[data-testid=btn-share]').click();
  await host.locator('[data-testid=share-name]').fill('Hana');
  await host.locator('[data-testid=share-start]').click();
  const link = await host.locator('[data-testid=share-link]').inputValue();
  expect(link).toMatch(/[?&]join=[A-Za-z0-9_-]+/);
  await host.locator('[data-testid=share-dialog]').getByRole('button', { name: 'Close' }).click();
  await expect(host.locator('[data-testid=btn-share]')).toContainText('Sharing');

  // the guest opens the link and gets the host's font
  const guest = await context.newPage();
  await guest.goto(link);
  await guest.locator('[data-testid=join-name]').fill('Gus');
  await guest.locator('[data-testid=join-go]').click();
  await expect(guest.locator('[data-testid=join-dialog]')).toHaveCount(0);
  await expect(guest.locator('.fontname')).toHaveValue('Shared Sans');
  await expect(cell(guest, 'l')).not.toHaveClass(/empty/);
  await expect(host.locator('[data-testid=avatars] .avatar')).toHaveCount(1);
  await expect(guest.locator('[data-testid=avatars] .avatar')).toHaveCount(1);

  // host → guest
  await host.locator('.chbtn[data-ch="i"]').click();
  await drawStroke(host, [[0.4, 0.7], [0.4, 0.45]]);
  await expect(cell(guest, 'i')).not.toHaveClass(/empty/);
  // guest → host, and the host sees where the guest is
  await guest.locator('.chbtn[data-ch="o"]').click();
  await drawStroke(guest, [[0.3, 0.55], [0.45, 0.45], [0.6, 0.55], [0.45, 0.72], [0.3, 0.55]]);
  await expect(cell(host, 'o')).not.toHaveClass(/empty/);
  await expect(cell(host, 'o')).toHaveClass(/peer/);

  // one person per letter: the host is on "i", so the guest can look but not change it
  await guest.locator('.chbtn[data-ch="i"]').click();
  await expect(guest.locator('[data-testid=hold-banner]')).toContainText('Hana is working on');
  await drawStroke(guest, [[0.6, 0.7], [0.6, 0.3]]);
  await expect.poll(() => strokes(guest, 'i')).toBe(1);
  expect(await strokes(host, 'i')).toBe(1);
  // …until the host moves on
  await host.locator('.chbtn[data-ch="l"]').click();
  await expect(guest.locator('[data-testid=hold-banner]')).toBeHidden();
  await drawStroke(guest, [[0.6, 0.7], [0.6, 0.3]]);
  await expect.poll(() => strokes(host, 'i')).toBe(2);

  // effects are shared too
  await host.locator('#preset').selectOption('Chonky');
  await expect.poll(() => guest.evaluate(() => (window as any).__fontlab.project.fx.groups[0].layers.length)).toBeGreaterThan(0);

  // watch-only: the guest's drawing is taken back, but notes go through
  await host.locator('[data-testid=btn-share]').click();
  await host.locator('[data-testid=share-canedit]').uncheck();
  await host.locator('[data-testid=share-dialog]').getByRole('button', { name: 'Close' }).click();
  await expect(guest.locator('[data-testid=hold-banner]')).toContainText('You are watching');
  await drawStroke(guest, [[0.7, 0.7], [0.7, 0.3]]);
  await expect.poll(() => strokes(guest, 'i')).toBe(2);
  expect(await strokes(host, 'i')).toBe(2);
  await guest.mouse.click(5, 500);
  await guest.keyboard.press('n');
  const box = (await guest.locator('canvas.editor').boundingBox())!;
  await guest.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.4);
  await guest.locator('[data-testid=note-text]').fill('stem looks heavy');
  await guest.locator('[data-testid=note-text]').press('Enter');
  await expect.poll(() => host.evaluate(() => (window as any).__fontlab.project.notes.map((n: any) => n.text))).toEqual(['stem looks heavy']);

  // the host ends the session; the guest goes back to their own font
  guest.once('dialog', (d) => d.dismiss());
  await host.locator('[data-testid=btn-share]').click();
  await host.locator('[data-testid=share-dialog]').getByRole('button', { name: 'End session' }).click();
  await expect(guest.locator('[data-testid=btn-share]')).toHaveText('Share', { timeout: 15000 });
  await expect(host.locator('[data-testid=btn-share]')).toHaveText('Share');
  await context.close();
});

/** Host with one drawn letter and a running session, plus a guest who has joined. */
async function pair(browser: import('@playwright/test').Browser, config?: object) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  if (config) await context.route('**/fontlab.config.json', (r) => r.fulfill({ json: config }));
  const host = await context.newPage();
  await host.goto('/?via=local');
  await host.evaluate(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('fontlab:welcomed', '1'); });
  await host.reload();
  await host.locator('.chbtn[data-ch="l"]').click();
  await drawStroke(host, [[0.3, 0.75], [0.3, 0.25]]);
  await expect(cell(host, 'l')).not.toHaveClass(/empty/);
  await host.locator('[data-testid=btn-share]').click();
  await host.locator('[data-testid=share-name]').fill('Hana');
  await host.locator('[data-testid=share-start]').click();
  const link = await host.locator('[data-testid=share-link]').inputValue();
  await host.locator('[data-testid=share-dialog]').getByRole('button', { name: 'Close' }).click();
  const guest = await context.newPage();
  await guest.goto(link);
  await guest.locator('[data-testid=join-name]').fill('Gus');
  await guest.locator('[data-testid=join-go]').click();
  await expect(cell(guest, 'l')).not.toHaveClass(/empty/);
  await expect(host.locator('[data-testid=avatars] .avatar')).toHaveCount(1);
  return { context, host, guest, link };
}

test('a session survives reloads: the host keeps the same link, guests reconnect by themselves', async ({ browser }) => {
  test.setTimeout(150_000);
  const { context, host, guest, link } = await pair(browser);

  // the host reloads: the session comes back on the same link and the guest rejoins without doing anything
  await host.waitForTimeout(1000); // let the autosave write the font
  await host.reload();
  await expect(host.locator('[data-testid=btn-share]')).toContainText('Sharing', { timeout: 30000 });
  await host.locator('[data-testid=btn-share]').click();
  expect(await host.locator('[data-testid=share-link]').inputValue()).toBe(link);
  await host.locator('[data-testid=share-dialog]').getByRole('button', { name: 'Close' }).click();
  await expect(guest.locator('[data-testid=btn-share]')).toContainText('In session', { timeout: 40000 });
  await expect(host.locator('[data-testid=avatars] .avatar')).toHaveCount(1, { timeout: 20000 });
  await host.locator('.chbtn[data-ch="i"]').click();
  await drawStroke(host, [[0.4, 0.7], [0.4, 0.45]]);
  await expect(cell(guest, 'i')).not.toHaveClass(/empty/, { timeout: 15000 });

  // the guest reloads: back in the session with the shared font, no dialog
  await guest.reload();
  await expect(guest.locator('[data-testid=btn-share]')).toContainText('In session', { timeout: 30000 });
  await expect(cell(guest, 'i')).not.toHaveClass(/empty/);
  await guest.locator('.chbtn[data-ch="o"]').click();
  await drawStroke(guest, [[0.3, 0.55], [0.45, 0.45], [0.6, 0.55], [0.45, 0.72], [0.3, 0.55]]);
  await expect(cell(host, 'o')).not.toHaveClass(/empty/, { timeout: 15000 });

  // a guest who leaves goes back to their own font and stays out after a reload
  guest.once('dialog', (d) => d.dismiss());
  await guest.locator('[data-testid=btn-share]').click();
  await guest.locator('[data-testid=share-dialog]').getByRole('button', { name: 'Leave session' }).click();
  await expect(guest.locator('[data-testid=btn-share]')).toHaveText('Share');
  await guest.reload();
  await guest.waitForTimeout(1500);
  await expect(guest.locator('[data-testid=btn-share]')).toHaveText('Share');
  await expect(host.locator('[data-testid=avatars] .avatar')).toHaveCount(0, { timeout: 15000 });
  await context.close();
});

test('an idle person lets go of their letter', async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, host, guest } = await pair(browser, { collab: { maxIdleSeconds: 10 } });
  // the host has "l" open; the guest opens it too and is told to wait
  await guest.locator('.chbtn[data-ch="l"]').click();
  await expect(guest.locator('[data-testid=hold-banner]')).toContainText('Hana is working on');
  // the host does nothing; the guest keeps moving. After the idle time the letter is free.
  const box = (await guest.locator('canvas.editor').boundingBox())!;
  await expect.poll(async () => {
    await guest.mouse.move(box.x + 20 + Math.random() * 50, box.y + 20);
    return guest.locator('[data-testid=hold-banner]').isHidden();
  }, { timeout: 40000, intervals: [1500] }).toBe(true);
  await drawStroke(guest, [[0.6, 0.7], [0.6, 0.3]]);
  await expect.poll(() => strokes(host, 'l'), { timeout: 15000 }).toBe(2);
  // when the host comes back they see the guest has it now
  const hb = (await host.locator('canvas.editor').boundingBox())!;
  await host.mouse.move(hb.x + 30, hb.y + 30);
  await expect(host.locator('[data-testid=hold-banner]')).toContainText('Gus is working on', { timeout: 15000 });
  await context.close();
});
