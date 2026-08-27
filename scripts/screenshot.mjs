import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 800, height: 1000 }, deviceScaleFactor: 2 });
await p.goto('http://localhost:5173'); await p.waitForTimeout(300);
await p.click('nav button[data-tab="practice"]'); await p.waitForTimeout(500);
const cards = await p.$$('#card-list .item');
let t = cards[0];
for (const c of cards) if ((await c.innerText()).includes('L4')) { t = c; break; }
await t.click(); await p.waitForTimeout(400);
await p.click('#btn-mode-toggle'); await p.waitForTimeout(200);
await p.click('#mode-switch button[data-mode="whole"]'); await p.waitForTimeout(300);
await p.fill('#attempt',
  'We redesigned the Cloudfalre Blog, darm mode, cleaner UI, faster load times. What you might not know: the whole thing runs on EmDash, a new cms built on Cloudflare Workers. We wear Customer Zero.');
await p.click('#btn-submit'); await p.waitForTimeout(500);
await p.fill('#grade-json', await (await import('node:fs')).promises.readFile('/tmp/rev2.json', 'utf8'));
await p.click('#btn-import-grade'); await p.waitForTimeout(800);
await p.evaluate(() => document.querySelector('#finish').scrollIntoView());
await p.waitForTimeout(300);
const box = await p.locator('#finish').boundingBox();
await p.screenshot({ path: '/tmp/shots/17-finish.png',
  clip: { x: 0, y: box.y - 20, width: 800, height: Math.min(1400, box.height + 40) } });
console.log('ok');
await b.close();
