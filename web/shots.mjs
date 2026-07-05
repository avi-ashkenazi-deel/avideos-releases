import { chromium } from 'playwright';

const BASE = 'http://localhost:5191';
const args = ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({ args });

async function shot(file, path, { mobile = false, wait = 900, scrollTo } = {}) {
  const ctx = await browser.newContext(
    mobile
      ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
      : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 },
  );
  const page = await ctx.newPage();
  await page.goto(BASE + path, { waitUntil: 'load' }).catch(() => {});
  await page.waitForTimeout(wait);
  if (scrollTo != null) {
    await page.evaluate((y) => window.scrollTo(0, y === 'bottom' ? document.body.scrollHeight : y), scrollTo);
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: `/tmp/shots/${file}` });
  await ctx.close();
  console.log('shot', file);
}

await shot('s1-hero.png', '/');
await shot('s2-writing.png', '/', { scrollTo: 780 });
await shot('s3-projects.png', '/', { scrollTo: 2600 });
await shot('s4-footer.png', '/', { scrollTo: 'bottom' });
await shot('s5-gallery.png', '/gallery', { wait: 2600 });
await shot('m1-hero.png', '/', { mobile: true });
await shot('m2-writing.png', '/', { mobile: true, scrollTo: 620 });

await browser.close();
console.log('done');
