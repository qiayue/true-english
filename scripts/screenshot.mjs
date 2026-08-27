/**
 * 截取主要界面。
 *
 * 之前这个文件每次要截图都被重写一遍 —— 那不是脚本，是草稿纸，
 * 而且改动会混进 git 状态里。现在固定几个场景，按需选。
 *
 *   node scripts/screenshot.mjs            截全部
 *   node scripts/screenshot.mjs today      只截某一个
 *
 * 场景：settings / today / copy / cloze / write / retry / recall / review /
 *       finish / compose / composed / report
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

// 批改结果内嵌在脚本里，不再依赖 /tmp 下某个手工留下的文件 ——
// 那种依赖会让截图脚本在别人机器上静默少截几张。
const REVIEW = JSON.stringify({
  items: [
    { mine: 'Cloudfalre', native: 'Cloudflare', category: 'leak', verdict: 'wrong',
      leak: 'wordform', explainZh: '拼写手滑，字母顺序反了。', rule: null },
    { mine: 'the Cloudfalre Blog, darm mode', native: 'the Cloudflare Blog — dark mode',
      category: 'structure', verdict: 'unnatural', leak: null,
      explainZh: '原文用破折号引出列举，逗号会让人以为还在同一个句子里往下说。',
      rule: '甩一串补充说明时用破折号，不用逗号' },
    { mine: 'darm mode', native: 'dark mode', category: 'leak', verdict: 'wrong',
      leak: 'wordform', explainZh: '拼写手滑。', rule: null },
  ],
  overlap: { matched: 8, total: 12 },
  strengths: ['三项并列的顺序和原文一致，节奏抓住了。'],
  verdictZh: '结构对了，卡在拼写和标点。',
});

const COMPOSE_REVIEW = JSON.stringify({
  nativeVersion: "Spent the weekend moving my blog onto Workers — turns out the hard part wasn't the code, it was the redirects.",
  items: [
    { mine: 'I spend my weekend to move', native: 'Spent the weekend moving',
      category: 'leak', verdict: 'wrong', leak: 'tense',
      explainZh: '说的是已经做完的事，要用过去时 spent；而且 spend time doing 用动名词，不用 to do。',
      rule: 'spend + 时间 + doing，不是 to do' },
    { mine: 'the difficult thing is not code', native: "the hard part wasn't the code",
      category: 'leak', verdict: 'wrong', leak: 'article',
      explainZh: '这里特指「这次搬站要写的那些代码」，要加 the。',
      rule: '特指具体的那一个时用 the' },
    { mine: 'onto Workers', native: 'onto Workers', category: 'chunk', verdict: 'equal',
      leak: null, explainZh: '这个介词你用对了，和母语者的选择一致。', rule: null },
  ],
  clarity: 'clear',
  clarityZh: '意思一遍就读懂了 —— 周末搬站，难点在重定向不在代码。',
  chunkUse: ['a new X built on Y'],
  strengths: ['把「难点其实是另一件事」这个转折说出来了，这是推文最常见的钩子。'],
  verdictZh: '意思清楚，钩子也在，剩下的全是时态和冠词这类硬伤 —— 正是你的老问题。',
});

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 800, height: 900 }, deviceScaleFactor: 2 });
const shot = async (name) => {
  if (only && only !== name) return;
  await p.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log(`  ${OUT}/${name}.png`);
};

await p.goto(B); await p.waitForTimeout(400);
await p.click('nav button[data-tab="settings"]'); await p.waitForTimeout(600);
await shot('settings');
await p.click('nav button[data-tab="practice"]'); await p.waitForTimeout(800);
await shot('today');

const list = p.locator('#card-list .item');
if ((await list.count()) === 0) {
  console.log('  队列是空的 —— 先 npm run seed:example 或导入卡片');
  await b.close(); process.exit(0);
}
await list.first().click();
// 新卡默认落在照抄级，那一级「看」的时候输入框是收起来的 ——
// 等 #ladder 而不是等 #step-input，否则这里必然超时
await p.locator('#ladder').waitFor({ state: 'visible', timeout: 10_000 });
await p.waitForTimeout(500);
await shot('copy');
await p.click('#btn-mode-toggle').catch(()=>{}); await p.waitForTimeout(200);
await p.click('#mode-switch button[data-stage="cloze"]').catch(()=>{}); await p.waitForTimeout(700);
await shot('cloze');
await p.click('#btn-mode-toggle').catch(()=>{}); await p.waitForTimeout(200);
await p.click('#mode-switch button[data-stage="step"]').catch(()=>{}); await p.waitForTimeout(600);
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
await p.click('#mode-switch button[data-stage="whole"]'); await p.waitForTimeout(400);
await p.locator('#attempt').waitFor({ state: 'visible', timeout: 10_000 });
await p.fill('#attempt', 'We redesigned the Cloudfalre Blog, darm mode, cleaner UI, faster load times.');
await p.click('#btn-submit'); await p.waitForTimeout(500);
await p.fill('#grade-json', REVIEW);
await p.click('#btn-import-grade'); await p.waitForTimeout(900);
await shot('review');
await p.evaluate(() => document.querySelector('#finish')?.scrollIntoView());
await p.waitForTimeout(300);
await shot('finish');

// ── 仿写：写作台 + 批改结果 ──
// 第二步藏在「读完三遍」后面 —— 一次只给一件事
await p.check('#chk-read'); await p.waitForTimeout(700);
await p.fill('#compose',
  "I spend my weekend to move my blog onto a new CMS built on Workers, the difficult thing is not code, is the redirect.");
await p.waitForTimeout(600);
await shot('compose');

await p.click('#btn-compose-grade'); await p.waitForTimeout(700);
await p.fill('#compose-json', COMPOSE_REVIEW);
await p.click('#btn-import-compose'); await p.waitForTimeout(1000);
await p.evaluate(() => document.querySelector('#compose-out')?.scrollIntoView());
await p.waitForTimeout(300);
await shot('composed');

await p.click('nav button[data-tab="report"]'); await p.waitForTimeout(900);
await shot('report');

await b.close();
console.log('done');
