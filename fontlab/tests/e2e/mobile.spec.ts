import { test, expect, type Page, type CDPSession } from '@playwright/test';

// A phone held upright, with fingers instead of a mouse.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

type P = [number, number, number?];
/** Real multi-touch through the DevTools protocol: every call states where each finger is now. */
function fingers(cdp: CDPSession) {
  const send = (type: string, pts: P[]) => cdp.send('Input.dispatchTouchEvent', { type: type as 'touchStart', touchPoints: pts.map((p, i) => ({ x: p[0], y: p[1], id: p[2] ?? i })) });
  return {
    down: (pts: P[]) => send('touchStart', pts),
    move: (pts: P[]) => send('touchMove', pts),
    up: () => send('touchEnd', []),
    tap: async (x: number, y: number) => { await send('touchStart', [[x, y]]); await send('touchEnd', []); },
  };
}

async function start(page: Page) {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('fontlab:welcomed', '1'); });
  await page.reload();
  await expect(page.locator('[data-testid=m-shell]')).toBeVisible();
}

async function generate(page: Page) {
  await page.locator('[data-testid=m-add]').click();
  await page.locator('[data-testid=btn-generate]').click();
  await page.waitForFunction(() => Object.keys((window as any).__fontlab.built).length > 50, null, { timeout: 60000 });
}

/** the view of the draw canvas and the points of a stroke letter, to aim fingers at them */
async function letter(page: Page, ch: string) {
  const box = (await page.locator('canvas.editor').boundingBox())!;
  const st = await page.evaluate((c) => {
    const g = (window as any).__fontlab.project.glyphs[c];
    return { v: (window as any).__fontlabView() as { ox: number; oy: number; s: number }, pts: (g?.strokes ?? []).map((s: any) => s.points.map((p: any) => [p.x, p.y])) as [number, number][][], contours: g?.curves?.length ?? g?.contours?.length ?? 0 };
  }, ch);
  const at = (p: [number, number]): [number, number] => [box.x + st.v.ox + p[0] * st.v.s, box.y + st.v.oy - p[1] * st.v.s];
  return { ...st, box, at };
}

test('phone: the editor is the screen, everything else is a sheet', async ({ page }) => {
  await start(page);
  // the desktop columns are gone; the canvas fills the space between the bars
  await expect(page.locator('.layout')).toBeHidden();
  const canvas = (await page.locator('canvas.editor').boundingBox())!;
  expect(canvas.width).toBe(390);
  expect(canvas.height).toBeGreaterThan(420);
  const noScroll = await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight);
  expect(noScroll).toBe(true);

  // Add → Generate closes the sheet and the preview line shows the font
  await generate(page);
  await expect(page.locator('[data-testid=m-sheet]')).toBeHidden();
  await expect(page.locator('[data-testid=m-preview]')).toContainText('The quick');

  // Letters: pick one, the sheet closes and the canvas shows it
  await page.locator('[data-testid=m-letters]').click();
  await expect(page.locator('[data-testid=m-sheet]')).toBeVisible();
  await page.locator('.cell[data-char="n"]').click();
  await expect(page.locator('[data-testid=m-sheet]')).toBeHidden();
  await expect(page.locator('.m-label')).toContainText('n');
  // previous / next walk through the alphabet
  await page.locator('[data-testid=m-next]').click();
  await expect(page.locator('.m-label')).toContainText('o');
  await page.locator('[data-testid=m-prev]').click();
  await page.locator('[data-testid=m-prev]').click();
  await expect(page.locator('.m-label')).toContainText('m');

  // picking a tool names it
  await page.locator('[data-testid=btn-edit-points]').click();
  await expect(page.locator('[data-testid=m-said]')).toHaveText('Edit points');

  // the other sheets hold the same panels as the desktop
  await page.locator('[data-testid=m-effects]').click();
  await expect(page.locator('[data-testid=m-sheet] .effects')).toBeVisible();
  await page.locator('[data-testid=m-sheet-close]').click();
  await page.locator('[data-testid=m-more]').click();
  await expect(page.locator('[data-testid=m-sheet] .fontname')).toBeVisible();
  await expect(page.locator('[data-testid=m-sheet] [data-testid=menu-export]')).toBeVisible();
  await page.locator('.m-backdrop').click({ position: { x: 20, y: 20 } });
  await expect(page.locator('[data-testid=m-sheet]')).toBeHidden();

  // the preview line can be hidden; the canvas takes the space
  await page.locator('[data-testid=m-preview-toggle]').click();
  await expect(page.locator('[data-testid=m-preview]')).toBeHidden();
  expect((await page.locator('canvas.editor').boundingBox())!.height).toBeGreaterThan(canvas.height + 40);

  // turning the screen into a wide one puts everything back
  await page.setViewportSize({ width: 1400, height: 1000 });
  await expect(page.locator('.layout')).toBeVisible();
  await expect(page.locator('.seeds canvas.editor')).toBeVisible();
  await expect(page.locator('.seeds .toolstrip')).toBeVisible();
  await expect(page.locator('[data-testid=m-shell]')).toBeHidden();
});

test('phone: fingers drag points, two at once, and pinch to zoom', async ({ page, context }) => {
  await start(page);
  await generate(page);
  await page.locator('[data-testid=m-letters]').click();
  await page.locator('.cell[data-char="n"]').click();
  await page.locator('[data-testid=btn-edit-points]').click();
  const f = fingers(await context.newCDPSession(page));

  // one finger drags a point; the magnifier shows what the finger hides
  let L = await letter(page, 'n');
  const p0 = L.pts[0][0], a = L.at(p0);
  await f.down([[a[0], a[1]]]);
  for (let i = 1; i <= 6; i++) await f.move([[a[0] - 8 * i, a[1] + 5 * i]]);
  await expect(page.locator('.loupe')).toBeVisible();
  await f.up();
  await expect(page.locator('.loupe')).toBeHidden();
  let after = await letter(page, 'n');
  expect(after.pts[0][0][0] - p0[0]).toBeCloseTo(-48 / L.v.s, 0);
  expect(after.pts[0][0][1] - p0[1]).toBeCloseTo(-30 / L.v.s, 0);

  // two fingers, each on its own point
  L = after;
  const last = L.pts[0].length - 1;
  const qa = L.pts[0][0], qb = L.pts[0][last], sa = L.at(qa), sb = L.at(qb);
  await f.down([[sa[0], sa[1], 1]]);
  await f.down([[sa[0], sa[1], 1], [sb[0], sb[1], 2]]);
  for (let i = 1; i <= 5; i++) await f.move([[sa[0] - 6 * i, sa[1], 1], [sb[0] + 6 * i, sb[1] - 4 * i, 2]]);
  await f.up();
  after = await letter(page, 'n');
  expect(after.pts[0][0][0] - qa[0]).toBeCloseTo(-30 / L.v.s, 0);
  expect(after.pts[0][0][1] - qa[1]).toBeCloseTo(0, 0);
  expect(after.pts[0][last][0] - qb[0]).toBeCloseTo(30 / L.v.s, 0);
  expect(after.pts[0][last][1] - qb[1]).toBeCloseTo(20 / L.v.s, 0);
  // that was one gesture: one Undo takes both back
  await page.locator('[data-testid=m-undo]').click();
  after = await letter(page, 'n');
  expect(after.pts[0][0][0]).toBeCloseTo(qa[0], 0);
  expect(after.pts[0][last][0]).toBeCloseTo(qb[0], 0);

  // two fingers on empty space zoom, and change nothing in the letter
  const before = JSON.stringify(after.pts);
  const cx = L.box.x + L.box.width * 0.78, cy = L.box.y + L.box.height * 0.16;
  await f.down([[cx - 20, cy, 1]]);
  await f.down([[cx - 20, cy, 1], [cx + 20, cy, 2]]);
  for (let i = 1; i <= 8; i++) await f.move([[cx - 20 - 6 * i, cy, 1], [cx + 20 + 6 * i, cy, 2]]);
  await f.up();
  const zoomed = await letter(page, 'n');
  expect(zoomed.v.s / L.v.s).toBeGreaterThan(3);
  expect(JSON.stringify(zoomed.pts)).toBe(before);
  await expect(page.locator('[data-testid=m-fit]')).toBeVisible();
  await page.locator('[data-testid=m-fit]').click();
  expect((await letter(page, 'n')).v.s).toBeCloseTo(L.v.s, 6);
  await expect(page.locator('[data-testid=m-fit]')).toBeHidden();

  // snapping: a point dropped near the baseline lands on it
  await page.locator('[data-testid=m-snap]').click();
  await expect(page.locator('[data-testid=m-said]')).toHaveText('Snapping on');
  L = await letter(page, 'n');
  const s0 = L.pts[0][0], from = L.at(s0);
  const target = L.at([s0[0] - 150, 14]); // 14 units above the baseline: about 4 px away
  await f.down([[from[0], from[1]]]);
  for (let i = 1; i <= 6; i++) await f.move([[from[0] + ((target[0] - from[0]) * i) / 6, from[1] + ((target[1] - from[1]) * i) / 6]]);
  await f.up();
  expect((await letter(page, 'n')).pts[0][0][1]).toBe(0);

  // the bin removes the selected point
  const count = (await letter(page, 'n')).pts[0].length;
  await page.locator('[data-testid=m-delete]').click();
  expect((await letter(page, 'n')).pts[0].length).toBe(count - 1);
});

test('phone: brush with one finger, pen with taps and a tick', async ({ page, context }) => {
  await start(page);
  const f = fingers(await context.newCDPSession(page));
  const box = (await page.locator('canvas.editor').boundingBox())!;
  const at = (x: number, y: number): P => [box.x + box.width * x, box.y + box.height * y];
  const strokes = () => page.evaluate(() => (window as any).__fontlab.project.glyphs.a?.strokes?.length ?? 0);

  // a second finger turns a stroke into a pinch: nothing is drawn
  await f.down([[...at(0.5, 0.3), 1] as P]);
  await f.move([[...at(0.5, 0.4), 1] as P]);
  await f.down([[...at(0.5, 0.4), 1] as P, [...at(0.2, 0.4), 2] as P]);
  await f.move([[...at(0.55, 0.4), 1] as P, [...at(0.15, 0.4), 2] as P]);
  await f.up();
  expect(await strokes()).toBe(0);
  await page.locator('[data-testid=m-fit]').click();

  // one finger draws
  const s = at(0.3, 0.35);
  await f.down([s]);
  for (let i = 1; i <= 8; i++) await f.move([[s[0] + i * 6, s[1] + i * 22]]);
  await f.up();
  await expect.poll(strokes).toBe(1);

  // pen: three taps, then the tick closes the shape
  await page.locator('[data-testid=btn-pen]').click();
  await expect(page.locator('[data-testid=m-pen-close]')).toBeHidden();
  await f.tap(...(at(0.55, 0.3).slice(0, 2) as [number, number]));
  await expect(page.locator('[data-testid=m-pen-close]')).toBeVisible();
  await expect(page.locator('[data-testid=m-pen-close]')).toBeDisabled();
  await f.tap(...(at(0.85, 0.3).slice(0, 2) as [number, number]));
  await f.tap(...(at(0.7, 0.55).slice(0, 2) as [number, number]));
  await expect(page.locator('[data-testid=m-pen-close]')).toBeEnabled();
  await page.locator('[data-testid=m-pen-close]').click();
  await expect.poll(() => page.evaluate(() => (window as any).__fontlab.project.glyphs.a?.curves?.length ?? 0)).toBe(1);
  await expect(page.locator('[data-testid=m-pen-close]')).toBeHidden();

  // a started shape can be dropped with the cross
  await f.tap(...(at(0.2, 0.7).slice(0, 2) as [number, number]));
  await page.locator('[data-testid=m-pen-cancel]').click();
  await expect(page.locator('[data-testid=m-pen-cancel]')).toBeHidden();
  expect(await page.evaluate(() => (window as any).__fontlab.project.glyphs.a?.curves?.length ?? 0)).toBe(1);
});
