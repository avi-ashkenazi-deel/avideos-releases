import { chromium } from 'playwright';

const BASE = 'http://localhost:5190';
const args = ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'];
const browser = await chromium.launch({ args });

async function shot(file, path, { mobile = false, wait = 1200, scrollTo, action } = {}) {
  const ctx = await browser.newContext(
    mobile
      ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
      : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 },
  );
  const page = await ctx.newPage();
  await page.goto(BASE + path, { waitUntil: 'load' }).catch(() => {});
  await page.waitForTimeout(wait);
  if (scrollTo) {
    await page.evaluate((id) => {
      const el = id === 'bottom' ? document.querySelector('footer') : document.getElementById(id);
      el?.scrollIntoView({ block: id === 'bottom' ? 'end' : 'start' });
    }, scrollTo);
    await page.waitForTimeout(600);
  }
  if (action) await action(page);
  await page.screenshot({ path: `/tmp/shots/${file}` });
  await ctx.close();
  console.log('shot', file);
}

await shot('d1-hero.png', '/', { wait: 1800 });
await shot('d2-writing.png', '/', { scrollTo: 'writing' });
await shot('d4-footer.png', '/', { scrollTo: 'bottom' });
await shot('d5-gallery.png', '/gallery', { wait: 2400 });
await shot('m2-menu.png', '/', {
  mobile: true,
  wait: 1400,
  action: async (p) => { await p.getByRole('button', { name: 'Menu' }).click().catch(() => {}); await p.waitForTimeout(800); },
});

await browser.close();
console.log('done');
