import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 800, height: 900 }, deviceScaleFactor: 2 });
await p.goto('http://localhost:5173'); await p.waitForTimeout(300);
await p.click('nav button[data-tab="practice"]'); await p.waitForTimeout(500);
const cards = await p.$$('#card-list .item');
let t = cards[0];
for (const c of cards) if ((await c.innerText()).includes('L4')) { t = c; break; }
await t.click(); await p.waitForTimeout(400);

const answers = [
  'We redesigned the Cloudflare Blog',
  '— dark mode, cleaner UI, faster load times.',
  'What you might not know: the whole thing runs on EmDash,',
  'a new CMS built on Cloudflare Workers.',
  'We were Customer Zero.',
];
for (let i = 0; i < answers.length; i++) {
  const label = (await p.textContent('#step-label')).trim();
  await p.fill('#step-input', answers[i]);
  await p.keyboard.press('Enter'); await p.waitForTimeout(400);
  const ok = (await p.textContent('#btn-step-primary')).includes('下一步') ||
             (await p.textContent('#btn-step-primary')).includes('整条');
  console.log(`${ok ? '✓' : '✗'} ${label}  →  ${(await p.textContent('#btn-step-primary')).trim()}`);
  if (!ok) { console.log('   卡住了:', (await p.textContent('#step-out')).slice(0, 120)); break; }
  if (i === 3) await p.screenshot({ path: '/tmp/shots/16-ctx.png', fullPage: true });
  await p.click('#btn-step-primary'); await p.waitForTimeout(300);
}
console.log('走完阶梯后进入:', (await p.isVisible('#whole')) ? '整段模式 ✓' : '仍在阶梯 ✗');
await b.close();
