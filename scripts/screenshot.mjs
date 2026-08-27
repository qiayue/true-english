import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 760, height: 900 }, deviceScaleFactor: 2 });
await p.goto(process.env.BASE ?? 'http://localhost:5173'); await p.waitForTimeout(300);
await p.click('nav button[data-tab="practice"]'); await p.waitForTimeout(500);
const cards = await p.$$('#card-list .item');
let t = cards[0];
for (const c of cards) if ((await c.innerText()).includes('L3')) { t = c; break; }
await t.click(); await p.waitForTimeout(400);

const vis = async (s) => p.isVisible(s).catch(() => false);
const snap = async (name) => ({
  name,
  cue: (await p.textContent('#step-cue')).trim().replace(/\s+/g, ' '),
  primary: (await p.textContent('#btn-step-primary')).trim(),
  原文可见: (await p.textContent('#step-out')).includes('used to think'),
  输入框: await vis('#step-input'),
  链接: (await Promise.all(['hint','accept','peek','copy'].map(async (k) =>
    (await vis('#btn-step-' + k)) ? k : null))).filter(Boolean).join(','),
});

const log = [];
log.push(await snap('① 盲写'));
await p.fill('#step-input', 'Before I think do thing fast is typing fast.');
await p.keyboard.press('Enter'); await p.waitForTimeout(450);
log.push(await snap('② 写错 → 看差异'));
await p.screenshot({ path: '/tmp/shots/12-study.png', fullPage: true });

await p.click('#btn-step-primary'); await p.waitForTimeout(300);
log.push(await snap('③ 遮住 → 默写'));
await p.screenshot({ path: '/tmp/shots/13-recall.png', fullPage: true });

await p.click('#btn-step-peek'); await p.waitForTimeout(300);
log.push(await snap('④ 再看一眼'));

await p.click('#btn-step-primary'); await p.waitForTimeout(250);
await p.fill('#step-input', 'I used to think shipping fast was about typing fast.');
await p.keyboard.press('Enter'); await p.waitForTimeout(450);
log.push(await snap('⑤ 默写对了'));
await p.screenshot({ path: '/tmp/shots/14-hit.png', fullPage: true });

console.log(JSON.stringify(log, null, 1));
await b.close();
