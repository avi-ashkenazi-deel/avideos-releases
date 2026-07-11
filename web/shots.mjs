import { chromium } from 'playwright';

const BASE = 'http://localhost:5191';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});

async function shot(file, path, { mobile = false, wait = 900, toId } = {}) {
  const ctx = await browser.newContext(
    mobile
      ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
      : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 },
  );
  const page = await ctx.newPage();
  await page.goto(BASE + path, { waitUntil: 'load' }).catch(() => {});
  await page.waitForTimeout(wait);
  if (toId) {
    await page.evaluate((id) => document.getElementById(id)?.scrollIntoView({ block: 'start' }), toId);
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: `/tmp/shots/${file}` });
  await ctx.close();
  console.log('shot', file);
}

await shot('p1-projects.png', '/', { toId: 'projects' });
await shot('p2-about-footer.png', '/', { toId: 'about' });
await shot('p3-projects-mobile.png', '/', { mobile: true, toId: 'projects' });

await browser.close();
console.log('done');
