import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

async function openPlain(page: Page) {
  await page.locator('[data-testid=preview-plain]').evaluate((d) => { (d as HTMLDetailsElement).open = true; });
}

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

test('draw a letter, see it in the grid and as a real font', async ({ page }) => {
  await page.locator('.chbtn[data-ch="l"]').click();
  await drawStroke(page, [[0.3, 0.75], [0.3, 0.25]]);
  await expect(page.locator('.drawtitle')).toContainText('1 strokes');
  await expect(page.locator('.cell[data-char="l"]')).not.toHaveClass(/empty/);
  await openPlain(page);
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
  const download = await exportOtf(page);
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
  await page.locator('.effects .addsel').first().selectOption('melt');
  const melt = page.locator('.fxlayer[data-type="melt"] .slider input');
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
  await page.waitForTimeout(1500);
  await page.reload();
  await expect(page.locator('.fontname')).toHaveValue('Roundtrip');
  await expect(page.locator('.cell[data-char="i"]')).not.toHaveClass(/empty/);
  await page.locator('[data-testid=menu-font]').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-testid=menu-export-json]').click()]);
  const file = path.join(test.info().outputDir, 'p.json');
  await download.saveAs(file);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(json.version).toBe(1);
  expect(json.glyphs.i.strokes.length).toBe(1);
});

test('trace a handwriting photo into seeds', async ({ page }) => {
  const fixture = path.resolve('tests/fixtures/handwriting.png');
  test.skip(!fs.existsSync(fixture), 'fixture missing');
  await pickFile(page, 'photo', fixture);
  await expect(page.locator('.modal .cellthumb')).toHaveCount(3, { timeout: 30000 });
  await page.locator('.modal .labels').fill('abc');
  await page.getByRole('button', { name: 'Add as seeds' }).click();
  await expect(page.locator('.cell[data-char="a"] .badge')).toHaveAttribute('data-source', 'traced');
  await expect(page.locator('.cell[data-char="c"] .badge')).toHaveAttribute('data-source', 'traced');
});

test('edit points: drag a node of a drawn letter and undo it', async ({ page }) => {
  await page.locator('.chbtn[data-ch="l"]').click();
  await drawStroke(page, [[0.3, 0.75], [0.3, 0.25]]);
  await expect(page.locator('.drawtitle')).toContainText('1 strokes');
  const before = await page.evaluate(() => JSON.stringify((window as any).__fontlab?.project?.glyphs?.l?.strokes ?? null));
  await page.locator('[data-testid=btn-edit-points]').click();
  await expect(page.locator('canvas.editor')).toHaveClass(/editing/);
  // select every node and nudge it right with the keyboard (position-independent)
  const canvas = page.locator('canvas.editor');
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.9, box.y + box.height * 0.9); // focus the canvas on empty space
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Shift+ArrowRight');
  const after = () => page.evaluate(() => JSON.stringify((window as any).__fontlab?.project?.glyphs?.l?.strokes ?? null));
  await expect.poll(after).not.toBe(before);
  await page.locator('[data-testid=btn-undo]').click();
  await expect.poll(after).toBe(before);
});

test('drawing on an imported letter adds to it; deleting a tile is undoable', async ({ page }) => {
  await pickFile(page, 'font', path.resolve('tests/fixtures/sample.woff2'));
  await expect(page.locator('.cell[data-char="A"] .badge')).toHaveAttribute('data-source', 'imported', { timeout: 60000 });
  // draw across the imported A: it keeps its contours and gains a stroke
  await page.locator('[data-testid=tab-draw]').click();
  await page.locator('.chbtn[data-ch="A"]').click();
  await expect(page.locator('.drawtitle')).toContainText('contours');
  const beforeTitle = await page.locator('.drawtitle small').innerText();
  const nContours = Number(/(\d+) contours/.exec(beforeTitle)![1]);
  await drawStroke(page, [[0.1, 0.5], [0.9, 0.5]]);
  await expect(page.locator('.drawtitle')).toContainText(`${nContours} contours + 1 stroke`);
  await expect(page.locator('.cell[data-char="A"] .badge')).toHaveAttribute('data-source', 'imported');
  // undo the stroke with the keyboard
  await page.mouse.click(5, 500); // blur any input
  await page.keyboard.press('Control+z');
  await expect(page.locator('.drawtitle')).toContainText(`${nContours} contours`);
  await expect(page.locator('.drawtitle')).not.toContainText('stroke');
  // delete a letter from the grid, then Undo brings it back
  const cell = page.locator('.cell[data-char="B"]');
  await cell.hover();
  await cell.locator('.celldel').click();
  await expect(cell).toHaveClass(/empty/);
  await page.locator('[data-testid=btn-undo]').click();
  await expect(cell).not.toHaveClass(/empty/);
  await expect(cell.locator('.badge')).toHaveAttribute('data-source', 'imported');
  await page.locator('[data-testid=btn-redo]').click();
  await expect(cell).toHaveClass(/empty/);
});

test('grid: Delete key, shift-select and the right-click menu remove letters (undoable)', async ({ page }) => {
  await pickFile(page, 'font', path.resolve('tests/fixtures/sample.woff2'));
  await expect(page.locator('.cell[data-char="A"] .badge')).toHaveAttribute('data-source', 'imported', { timeout: 60000 });
  const cell = (ch: string) => page.locator(`.cell[data-char="${ch}"]`);
  // single: click + Delete
  await cell('a').click();
  await page.keyboard.press('Delete');
  await expect(cell('a')).toHaveClass(/empty/);
  await page.keyboard.press('Control+z');
  await expect(cell('a')).not.toHaveClass(/empty/);
  // range: shift-click b..e, Delete, one Undo restores all
  await cell('b').click();
  await cell('e').click({ modifiers: ['Shift'] });
  await expect(cell('c')).toHaveClass(/multi/);
  await page.keyboard.press('Delete');
  for (const ch of 'bcde') await expect(cell(ch)).toHaveClass(/empty/);
  await expect(cell('f')).not.toHaveClass(/empty/);
  await page.keyboard.press('Control+z');
  for (const ch of 'bcde') await expect(cell(ch)).not.toHaveClass(/empty/);
  // right-click: remove all lowercase
  await cell('g').click({ button: 'right' });
  await page.locator('[data-testid=ctx-remove-lower]').click();
  for (const ch of 'agz') await expect(cell(ch)).toHaveClass(/empty/);
  await expect(cell('A')).not.toHaveClass(/empty/);
  await expect(cell('5')).not.toHaveClass(/empty/);
});

test('arrow keys move between letters; the intro shows once on a fresh profile', async ({ page }) => {
  await page.locator('.chbtn[data-ch="b"]').click();
  await page.mouse.click(5, 500);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.chbtn.selected')).toHaveAttribute('data-ch', 'c');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.chbtn.selected')).toHaveAttribute('data-ch', 'a');
  // fresh profile → intro overlay, click closes it and it stays closed after reload
  await page.evaluate(() => localStorage.removeItem('fontlab:welcomed'));
  await page.reload();
  await expect(page.locator('[data-testid=welcome]')).toBeVisible();
  await expect(page.locator('[data-testid=welcome]')).toContainText('Add letters');
  await page.locator('[data-testid=welcome]').click();
  await expect(page.locator('[data-testid=welcome]')).toHaveCount(0);
  await page.reload();
  await page.waitForTimeout(800);
  await expect(page.locator('[data-testid=welcome]')).toHaveCount(0);
  await page.locator('[data-testid=btn-intro]').click();
  await expect(page.locator('[data-testid=welcome]')).toBeVisible();
});
