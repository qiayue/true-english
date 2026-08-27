import { chromium } from 'playwright';
import fs from 'node:fs';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 780, height: 1200 }, deviceScaleFactor: 2 });
const B = 'http://localhost:5173';

// ① 投料：粘贴 4 条，其中 2 条应被筛掉
await p.goto(B); await p.waitForTimeout(400);
await p.fill('#raw', `I used to think shipping fast was about typing fast. It's not. It's about having fewer things to decide.

Most of my best decisions looked boring at the time.

BREAKING: FED HOLDS RATES STEADY AMID INFLATION CONCERNS

@someone @another lol no, you're thinking of the other one`);
await p.click('#btn-ingest'); await p.waitForTimeout(600);
await p.screenshot({ path: '/tmp/shots/1-ingest.png', fullPage: true });

// 导入卡片（走 node 直连，别绕页面 —— fetch 返回 4xx 不会让 evaluate 抛错，
// 上一版就是因此静默失败、卡片列表为空）
const TEXTS = [
  "I used to think shipping fast was about typing fast. It's not. It's about having fewer things to decide.",
  "Most of my best decisions looked boring at the time.",
];
const imp = await fetch(B + '/api/cards/import', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ texts: TEXTS, json: fs.readFileSync('/tmp/cards.json', 'utf8') }),
});
if (!imp.ok) throw new Error('卡片导入失败: ' + (await imp.text()));

// ② 练习：只给中文。选 L3 那张（批改 JSON 对应的那条）
await p.click('nav button[data-tab="practice"]'); await p.waitForTimeout(500);
const cards = await p.$$('#card-list .item');
let target = cards[0];
for (const c of cards) { if ((await c.innerText()).includes('L3')) { target = c; break; } }
await target.click(); await p.waitForTimeout(400);
await p.fill('#attempt', 'Before I think do thing fast is typing fast. No. Is you need make less decision.');
await p.screenshot({ path: '/tmp/shots/2-drill.png', fullPage: true });

// ③ 批改结果
await p.click('#btn-submit'); await p.waitForTimeout(500);
await p.fill('#grade-json', fs.readFileSync('/tmp/review.json', 'utf8'));
await p.click('#btn-import-grade'); await p.waitForTimeout(800);
await p.screenshot({ path: '/tmp/shots/3-review.png', fullPage: true });

// ④ 报告
await p.click('nav button[data-tab="report"]'); await p.waitForTimeout(700);
await p.screenshot({ path: '/tmp/shots/4-report.png', fullPage: true });

await b.close();
console.log('ok');
