import { chromium } from 'playwright';

const BASE = 'http://localhost:5188';
const args = ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'];

const browser = await chromium.launch({ args });

async function shot(file, path, { mobile = false, wait = 1200, action } = {}) {
  const ctx = await browser.newContext(
    mobile
      ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
      : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
  );
  const page = await ctx.newPage();
  await page.goto(BASE + path, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(wait);
  if (action) await action(page);
  await page.screenshot({ path: `/tmp/shots/${file}` });
  await ctx.close();
  console.log('shot', file);
}

await shot('01-home-desktop.png', '/', { wait: 1800 });
await shot('02-writing-desktop.png', '/writing');
await shot('03-projects-desktop.png', '/projects');
await shot('04-about-desktop.png', '/about');
await shot('05-gallery-desktop.png', '/gallery', { wait: 2600 });
await shot('06-home-mobile.png', '/', { mobile: true, wait: 1800 });
await shot('07-writing-mobile.png', '/writing', { mobile: true });
await shot('08-menu-mobile.png', '/', {
  mobile: true,
  wait: 1400,
  action: async (page) => {
    await page.getByRole('button', { name: 'Menu' }).click().catch(() => {});
    await page.waitForTimeout(800);
  },
});
await shot('09-gallery-mobile.png', '/gallery', { mobile: true, wait: 2600 });

await browser.close();
console.log('done');
