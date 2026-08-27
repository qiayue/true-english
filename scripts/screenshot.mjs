import { chromium } from 'playwright';
import fs from 'node:fs';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 780, height: 1100 }, deviceScaleFactor: 2 });
const B = process.env.BASE ?? 'http://localhost:5173';

await p.goto(B); await p.waitForTimeout(300);
await p.click('nav button[data-tab="practice"]'); await p.waitForTimeout(500);
const cards = await p.$$('#card-list .item');
let target = cards[0];
for (const c of cards) { if ((await c.innerText()).includes('L3')) { target = c; break; } }
await target.click(); await p.waitForTimeout(500);

// ① 阶梯第一步（默认模式）
await p.screenshot({ path: '/tmp/shots/5-ladder.png', fullPage: true });

// ② 对照结果
await p.fill('#step-input', 'Before I think do thing fast is typing fast.');
await p.click('#btn-step-check'); await p.waitForTimeout(500);
await p.screenshot({ path: '/tmp/shots/6-step-check.png', fullPage: true });

// ③ 提示阶梯第一级
await p.click('#btn-step-next'); await p.waitForTimeout(300);
await p.click('#btn-step-hint'); await p.waitForTimeout(400);
await p.click('#btn-step-hint'); await p.waitForTimeout(400);
await p.screenshot({ path: '/tmp/shots/7-hint.png', fullPage: true });

await b.close();
console.log('ok');
