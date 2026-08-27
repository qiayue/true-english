/**
 * 截取主要界面。
 *
 * 之前这个文件每次要截图都被重写一遍 —— 那不是脚本，是草稿纸，
 * 而且改动会混进 git 状态里。现在固定几个场景，按需选。
 *
 *   node scripts/screenshot.mjs            截全部
 *   node scripts/screenshot.mjs today      只截某一个
 *
 * 场景：today / write / retry / recall / review / finish
 * 输出到 /tmp/shots/
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const B = process.env.BASE ?? 'http://localhost:5173';
const OUT = process.env.OUT ?? '/tmp/shots';
const only = process.argv[2];
fs.mkdirSync(OUT, { recursive: true });

const WRONG = 'Before I think do thing fast is typing fast.';
const RIGHT = 'We redesigned the Cloudflare Blog';

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 800, height: 900 }, deviceScaleFactor: 2 });
const shot = async (name) => {
  if (only && only !== name) return;
  await p.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log(`  ${OUT}/${name}.png`);
};

await p.goto(B); await p.waitForTimeout(400);
await p.click('nav button[data-tab="practice"]'); await p.waitForTimeout(800);
await shot('today');

const list = p.locator('#card-list .item');
if ((await list.count()) === 0) {
  console.log('  队列是空的 —— 先 npm run seed:example 或导入卡片');
  await b.close(); process.exit(0);
}
await list.first().click();
await p.locator('#step-input').waitFor({ state: 'visible', timeout: 10_000 });
await shot('write');

await p.fill('#step-input', WRONG);
await p.keyboard.press('Enter'); await p.waitForTimeout(500);
await shot('retry');

await p.click('#btn-step-primary'); await p.waitForTimeout(350);
await shot('recall');

// 走完阶梯 → 整段 → 批改结果 + 收尾
await p.click('#btn-step-peek'); await p.waitForTimeout(250);
await p.click('#btn-step-primary'); await p.waitForTimeout(250);
await p.fill('#step-input', RIGHT);
await p.keyboard.press('Enter'); await p.waitForTimeout(450);
await p.click('#btn-mode-toggle'); await p.waitForTimeout(200);
await p.click('#mode-switch button[data-mode="whole"]'); await p.waitForTimeout(300);
await p.fill('#attempt', 'We redesigned the Cloudfalre Blog, darm mode, cleaner UI, faster load times.');
await p.click('#btn-submit'); await p.waitForTimeout(500);
if (fs.existsSync('/tmp/rev2.json')) {
  await p.fill('#grade-json', fs.readFileSync('/tmp/rev2.json', 'utf8'));
  await p.click('#btn-import-grade'); await p.waitForTimeout(800);
  await shot('review');
  await p.evaluate(() => document.querySelector('#finish')?.scrollIntoView());
  await p.waitForTimeout(300);
  await shot('finish');
}

await b.close();
console.log('done');
