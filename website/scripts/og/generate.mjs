// Renders scripts/og/template.html to static/img/og-image.png.
// First-time setup: `npx playwright install chromium`.
// Run with: `yarn og:generate` (from the website/ directory).

import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(here, 'template.html');
const outputPath = path.join(here, '..', '..', 'static', 'img', 'og-image.png');

const WIDTH = 1200;
const HEIGHT = 630;

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 1,
});
const page = await context.newPage();

await page.goto(pathToFileURL(templatePath).href, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);

await page.screenshot({
  path: outputPath,
  clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
  omitBackground: false,
});

await browser.close();
console.log(`Wrote ${path.relative(process.cwd(), outputPath)}`);
