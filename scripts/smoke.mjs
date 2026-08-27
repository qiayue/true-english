/**
 * 全流程冒烟测试。
 *
 * 存在的理由：我曾经在重写练习状态机时，用「从 X 替换到 Y」的大范围改写
 * 连带删掉了三个按钮的 handler。页面照常渲染、JS 语法照常通过、
 * 原来的截图脚本照常绿 —— 因为它只走了阶梯，从没点过「提交批改」。
 * 用户点了才发现按钮是死的。
 *
 * 所以这个脚本的要求是：**每一条用户真的会走的路径都要走一遍**。
 * 只覆盖一半的测试比没有测试更危险，因为它给人「测过了」的错觉。
 *
 *   node scripts/smoke.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const B = process.env.BASE ?? 'http://localhost:5173';
const results = [];
let failed = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failed++;
}

const TWEET =
  "We redesigned the Cloudflare Blog — dark mode, cleaner UI, faster load times. " +
  "What you might not know: the whole thing runs on EmDash, a new CMS built on Cloudflare Workers. " +
  "We were Customer Zero.";
const STEP_ANSWERS = [
  'We redesigned the Cloudflare Blog',
  '— dark mode, cleaner UI, faster load times.',
  'What you might not know: the whole thing runs on EmDash,',
  'a new CMS built on Cloudflare Workers.',
  'We were Customer Zero.',
];

const post = (path, body) =>
  fetch(B + path, { method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(body) }).then((r) => r.json());

await post('/api/cards/import', { texts: [TWEET], json: fs.readFileSync('/tmp/cf-card.json', 'utf8') })
  .catch(() => {});

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 820, height: 1000 } });
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await p.goto(B); await p.waitForTimeout(400);

// ── 投料 ──
await p.fill('#raw', TWEET + '\n\nBREAKING: FED HOLDS RATES STEADY AMID INFLATION CONCERNS');
await p.click('#btn-ingest'); await p.waitForTimeout(600);
check('投料筛选', (await p.textContent('#ingest-hint')).includes('1/2'));
check('导出卡片请求', await p.click('#btn-card-manual').then(() => p.waitForTimeout(400))
  .then(async () => (await p.textContent('#card-payload')).length > 100));

// ── 练习：阶梯 ──
await p.click('nav button[data-tab="practice"]'); await p.waitForTimeout(600);
const cards = await p.$$('#card-list .item');
check('卡片列表非空', cards.length > 0);
let target = cards[0];
for (const c of cards) if ((await c.innerText()).includes('L4')) { target = c; break; }
await target.click(); await p.waitForTimeout(400);

for (let i = 0; i < STEP_ANSWERS.length; i++) {
  await p.fill('#step-input', STEP_ANSWERS[i]);
  await p.keyboard.press('Enter'); await p.waitForTimeout(400);
  const label = (await p.textContent('#btn-step-primary')).trim();
  check(`阶梯第 ${i + 1} 步判定为写对`, label.includes('下一步') || label.includes('整条'), label);
  await p.click('#btn-step-primary'); await p.waitForTimeout(300);
}
check('阶梯走完进入整段模式', await p.isVisible('#whole'));

// ── 整段：提交批改（就是漏测的那条路径）──
await p.fill('#attempt', 'Wr redesigned Cloudflare blog, dark mode, cleaner ui, faster load times.');
await p.click('#btn-submit'); await p.waitForTimeout(700);
check('提交批改有反应', await p.isVisible('#grade-manual'), '手工模式应弹出导出请求');
check('批改请求有内容', (await p.textContent('#grade-payload')).length > 500);

await p.fill('#grade-json', JSON.stringify({
  items: [{ mine: 'Wr', native: 'We', category: 'leak', verdict: 'wrong', leak: 'wordform',
            explainZh: '拼写手滑，We 打成了 Wr。', rule: null },
          { mine: 'Cloudflare blog', native: 'the Cloudflare Blog', category: 'leak',
            verdict: 'wrong', leak: 'article', explainZh: '特指自家那个博客，要用定冠词 the。',
            rule: '特指某个具体事物时用 the' },
          { mine: 'ui', native: 'UI', category: 'chunk', verdict: 'unnatural', leak: null,
            explainZh: '缩写要大写。', rule: null }],
  overlap: { matched: 8, total: 12 },
  strengths: ['破折号后直接甩列举的结构你复现出来了。'],
  verdictZh: '结构对了，卡在冠词和大小写。',
}));
await p.click('#btn-import-grade'); await p.waitForTimeout(700);
const res = await p.textContent('#result');
check('批改结果渲染', res.includes('回译重合度') && res.includes('做对的地方'), res.slice(0, 60));
check('三分判定文案', res.includes('错') && res.includes('母语者不会这么说'));

// ── 收尾流程：出声 → 仿写 → 存档（日循环的后半截）──
check('收尾流程出现', await p.isVisible('#finish'));
check('朗读区有原文', (await p.textContent('#finish')).includes('出声读三遍'));
const chips = await p.$$('#finish .chip');
check('骨架/词块可点击填入', chips.length > 0, `${chips.length} 个 chip`);
if (chips.length) {
  await chips[0].click(); await p.waitForTimeout(200);
  check('点 chip 填进输入框', (await p.inputValue('#mine-tweet')).length > 0);
}
await p.fill('#mine-tweet',
  'The whole thing runs on a new CMS built on Cloudflare Workers.');
await p.waitForTimeout(700);
check('实时复用计数', (await p.textContent('#reuse-live')).includes('复用'),
  await p.textContent('#reuse-live'));
await p.click('#btn-archive'); await p.waitForTimeout(700);
const arch = await p.textContent('#archive-out');
check('仿写存档', arch.includes('存好了') || arch.includes('还差'), arch.slice(0, 50));
check('存档后给下一步出口', await p.isVisible('#btn-next-card') || arch.includes('还差'));

// ── 换一张 ──
await p.click('#btn-back'); await p.waitForTimeout(500);
check('换一张回到列表', await p.isVisible('#card-list'));

// ── 语料库 ──
await p.click('nav button[data-tab="corpus"]'); await p.waitForTimeout(600);
await p.fill('#compose', 'The whole thing runs on a new CMS built on Cloudflare Workers.');
await p.click('#btn-compose'); await p.waitForTimeout(600);
check('词块复用检测', (await p.textContent('#compose-out')).includes('复用'));

// ── 报告 ──
await p.click('nav button[data-tab="report"]'); await p.waitForTimeout(700);
const rep = await p.textContent('#report-out');
check('报告有数据', rep.includes('回译') && rep.includes('错误模式'), rep.slice(0, 60));

check('没有 JS 运行时错误', errors.length === 0, errors.join(' | ').slice(0, 200));

await b.close();

console.log('');
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.ok || !r.detail ? '' : `\n      ${r.detail}`}`);
}
console.log(`\n  ${results.length - failed}/${results.length} 通过\n`);
process.exit(failed ? 1 : 0);
