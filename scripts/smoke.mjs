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

function summary() {
  console.log('');
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.ok || !r.detail ? '' : `\n      ${r.detail}`}`);
  }
  console.log(`\n  ${results.length - failed}/${results.length} 通过\n`);
}

/**
 * 流程中途炸了也要给人话。
 *
 * 断言失败会记进 results，但**元素等不到**是直接抛 TimeoutError ——
 * 顶层 await 里抛出来就是一坨 Playwright 堆栈，看不出跑到哪一步断的。
 * 而「按钮不见了 / 面板没显示」正是这个脚本最该抓的那类回归，
 * 它偏偏走的就是这条路径。
 *
 * 注意必须是 uncaughtException：ESM 顶层 await 的 rejection 走的是这个钩子，
 * 不是 unhandledRejection。而且装了这个钩子就等于把异常吞了 ——
 * 不显式 exit(1) 的话进程会以 0 退出，崩溃直接变成「通过」。
 */
let BROWSER = null;
const crashed = async (e) => {
  const sel = String(e).match(/locator\('([^']+)'\)/)?.[1];
  check(`流程中断${sel ? `：等不到 ${sel}` : ''}`, false,
    `最后通过的是「${results.filter((r) => r.ok).pop()?.name ?? '（没有）'}」　${String(e).split('\n')[0]}`);
  summary();
  try { await BROWSER?.close(); } catch { /* 已经死了就算了 */ }
  process.exit(1);
};
process.on('uncaughtException', crashed);
process.on('unhandledRejection', crashed);

/**
 * 点击覆盖率。
 *
 * 这个测试此前是**被动长出来的**：用户报一个 bug，我补一条断言。
 * 于是它永远只覆盖「已经坏过」的路径，从不覆盖「即将坏」的 ——
 * 照抄级的「再看一眼」点了没反应，就是这么漏出去的。
 *
 * 现在反过来：从 HTML 里枚举全部按钮，跑完断言每一个都被点过。
 * 点不到的必须在 EXEMPT 里写明理由，不能默默放过。
 */
const clicked = new Set();

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
BROWSER = b;
const ctx = await b.newContext({
  viewport: { width: 820, height: 1000 },
  permissions: ['clipboard-read', 'clipboard-write'],
});
const p = await ctx.newPage();

// 包一层，记录点过哪些按钮
const rawClick = p.click.bind(p);
p.click = async (sel, ...rest) => {
  const m = /#(btn-[\w-]+)/.exec(sel);
  if (m) clicked.add(m[1]);
  return rawClick(sel, ...rest);
};
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await p.goto(B); await p.waitForTimeout(400);

// ── 投料 ──
// 按真实粘贴的样子来：带用户名、时间、互动数
await p.fill('#raw', [
  'Cloudflare', '@Cloudflare', '·', '2h', TWEET, '1.2K', '340', 'Show more',
  '', 'BREAKING: FED HOLDS RATES STEADY AMID INFLATION CONCERNS',
].join('\n'));
await p.click('#btn-ingest'); await p.waitForTimeout(600);
const hint = await p.textContent('#ingest-hint');
check('投料筛选', hint.includes('1/2'), hint);
check('清掉了界面噪音', hint.includes('界面噪音'), hint);
check('通过的可勾选', (await p.locator('#raw ~ * .pick, #ingest-out .pick').count()) === 1);
await p.click('#btn-card-manual'); await p.waitForTimeout(400);
check('导出卡片请求', (await p.textContent('#card-payload')).length > 100);

// 复制按钮：确认真的写进了剪贴板，不是只换个文案
await p.click('#btn-copy-card'); await p.waitForTimeout(400);
const clipCard = await p.evaluate(() => navigator.clipboard.readText());
check('复制请求写进剪贴板', clipCard.length > 1000 && clipCard.includes('JSON 数组'),
  `${clipCard.length} 字`);
check('复制后按钮给了反馈', (await p.textContent('#btn-copy-card')).includes('已复制'),
  await p.textContent('#btn-copy-card'));

// ★ 从浏览器真正走一遍导入 —— 手工模式下这是每天的必经之路，
// 此前只在 API 层测过，界面这一段从没跑通过
await p.fill('#card-json', fs.readFileSync('/tmp/cf-card.json', 'utf8'));
await p.click('#btn-import-card'); await p.waitForTimeout(900);
const cardMsg = await p.textContent('#card-msg');
check('★ 界面上导入卡片能成功', cardMsg.includes('已导入'), cardMsg.slice(0, 60));

// ── 今日队列 ──
await p.click('nav button[data-tab="practice"]'); await p.waitForTimeout(700);
check('练习页落在「今天」', (await p.textContent('#pick-title')).includes('今天'));
const sub0 = await p.textContent('#pick-sub');
check('今日队列有新卡', sub0.includes('新卡'), sub0);
check('显示时间预算而非条数', sub0.includes('分钟') && sub0.includes('预算'), sub0);
await p.click('#btn-show-all'); await p.waitForTimeout(500);
check('可切到全部卡片', (await p.textContent('#pick-title')).includes('全部'));
await p.click('#btn-show-all'); await p.waitForTimeout(500);

// 用 locator 而不是 $$ 拿到的句柄：loadCards 是异步的，
// 列表重渲染后旧句柄指向已被替换的节点，点它等于没点。
// locator 在点击那一刻才解析，天然躲开这个竞态。
const list = p.locator('#card-list .item');
await list.first().waitFor({ state: 'visible', timeout: 10_000 });
check('卡片列表非空', (await list.count()) > 0);
await list.first().click();
await p.waitForTimeout(500);
check('新卡默认走照抄级', (await p.textContent('#stage-tag')).includes('照抄'),
  await p.textContent('#stage-tag'));

// ── 照抄级：看 → 遮 → 打 ──
await p.locator('#step-out').waitFor({ state: 'visible', timeout: 10_000 });
check('照抄级先给原文看', await p.isVisible('#step-out .ansbox .mono'));
check('照抄的主按钮是「遮住」', (await p.textContent('#btn-step-primary')).includes('遮住'));

// 「看」和「打」是同一个界面的两个状态，不是两个界面。
// 判据是**布局不动**：输入框一直在原位（只是锁着），
// 答案槽被盖住时高度不变，于是按钮不会上蹿。
check('看的时候输入框在原位但锁着',
  (await p.isVisible('#step-input')) && (await p.isDisabled('#step-input')));
const boxBefore = await p.locator('#step-out .ansbox').boundingBox();
const btnBefore = await p.locator('#btn-step-primary').boundingBox();

await p.click('#btn-step-primary'); await p.waitForTimeout(400);

check('遮住后读不到原文了', !(await p.isVisible('#step-out .ansbox .mono')));
check('遮住后可以打字', !(await p.isDisabled('#step-input')));
const boxAfter = await p.locator('#step-out .ansbox').boundingBox();
const btnAfter = await p.locator('#btn-step-primary').boundingBox();
check('★ 遮住前后答案槽高度不变',
  Math.abs(boxBefore.height - boxAfter.height) < 2,
  `${Math.round(boxBefore.height)} → ${Math.round(boxAfter.height)}`);
check('★ 遮住前后按钮不移位（一个界面，不是两个）',
  Math.abs(btnBefore.y - btnAfter.y) < 4,
  `y ${Math.round(btnBefore.y)} → ${Math.round(btnAfter.y)}`);

// 「再看一眼」在照抄级要能把原文重新拿出来 —— 这一级没有 diff 可渲染，
// 曾经因此点了没反应
check('遮住后有「再看一眼」', await p.isVisible('#btn-step-peek'));
await p.click('#btn-step-peek'); await p.waitForTimeout(400);
check('★ 再看一眼能重新显示原文', await p.isVisible('#step-out .ansbox .mono'));
await p.click('#btn-step-primary'); await p.waitForTimeout(350);
check('再遮住又能打字', !(await p.isDisabled('#step-input')));
await p.fill('#step-input', STEP_ANSWERS[0]);
await p.keyboard.press('Enter'); await p.waitForTimeout(500);
check('照抄打对了判过', (await p.textContent('#btn-step-primary')).includes('下一步'),
  await p.textContent('#btn-step-primary'));

// ── 提示阶梯：三级，且短句时不能泄底 ──
await p.click('#btn-mode-toggle'); await p.waitForTimeout(200);
await p.click('#mode-switch button[data-stage="step"]'); await p.waitForTimeout(600);
await p.locator('#step-input').waitFor({ state: 'visible', timeout: 10_000 });
await p.click('#btn-step-hint'); await p.waitForTimeout(500);
const h1 = await p.textContent('#step-out');
check('提示一级给骨架不给答案', h1.includes('骨架提示') && !h1.includes(STEP_ANSWERS[0]), h1.slice(0, 40));
await p.click('#btn-step-hint'); await p.waitForTimeout(500);
check('提示二级给词块或结构提示',
  /关键词块|没有能给的词块/.test(await p.textContent('#step-out')),
  (await p.textContent('#step-out')).slice(0, 40));
await p.click('#btn-step-hint'); await p.waitForTimeout(500);
check('提示三级才揭晓原文', (await p.textContent('#step-out')).includes(STEP_ANSWERS[0]));
await p.click('#btn-mode-toggle'); await p.waitForTimeout(200);
await p.click('#mode-switch button[data-stage="copy"]'); await p.waitForTimeout(600);

// ── 填空级：按漏点挖空，且不下发答案 ──
await p.click('#btn-mode-toggle'); await p.waitForTimeout(200);
await p.click('#mode-switch button[data-stage="cloze"]'); await p.waitForTimeout(700);
const blanks = await p.locator('#cloze-body input').count();
check('填空级有空位', blanks > 0, `${blanks} 个空`);
check('空位标了考哪类漏点', (await p.locator('#cloze-body .leaktag').count()) > 0);
// 先填错一个，确认判定与提示
await p.locator('#cloze-body input').first().fill('zzz');
await p.click('#btn-cloze-check'); await p.waitForTimeout(500);
check('填错了给出正解', (await p.textContent('#cloze-out')).includes('错了'),
  (await p.textContent('#cloze-out')).slice(0, 40));
const firstAnswer = await p.evaluate(() => {
  const m = document.querySelector('#cloze-out .mono.qing');
  return m ? m.textContent.trim() : '';
});
check('正解可读', firstAnswer.length > 0, firstAnswer);

// 切回逐句，把阶梯那段测完
await p.click('#btn-mode-toggle'); await p.waitForTimeout(200);
await p.click('#mode-switch button[data-stage="step"]'); await p.waitForTimeout(600);
await p.locator('#step-input').waitFor({ state: 'visible', timeout: 10_000 });

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
await p.click('#btn-copy-grade'); await p.waitForTimeout(400);
const clipGrade = await p.evaluate(() => navigator.clipboard.readText());
check('批改请求能复制', clipGrade.length > 1000 && clipGrade.includes('回译'),
  `${clipGrade.length} 字`);

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

// ── 收尾流程：出声 → 仿写（日循环的后半截）──
check('收尾流程出现', await p.isVisible('#finish'));
check('朗读区有原文', (await p.textContent('#finish')).includes('出声读三遍'));

// 一次只给一件事：读完三遍之前，第二步（写）不该冒出来。
// 批改结果本身就十几屏，后面再一口气堆五件事，人的反应是全都不做。
check('没读完之前不放出写作台', !(await p.isVisible('#compose')));
check('没读完之前第二步是藏着的', !(await p.isVisible('#finish-write')));
await p.check('#chk-read'); await p.waitForTimeout(700);
check('勾了读完三遍才放出第二步', await p.isVisible('#finish-write'));
check('勾完把原文收起来（读都读完了）', !(await p.isVisible('#read-aloud')));

// 写作台被搬到批改结果下面来了 —— 全应用只有一份，不是复制的
check('写作台搬到批改结果下面', await p.isVisible('#desk-slot'));
check('写作台确实在练习页里', await p.evaluate(
  () => document.querySelector('#p-practice #desk') !== null));
const chips = await p.$$('#desk-ctx .chip');
check('今天这条的骨架/词块可点击填入', chips.length > 0, `${chips.length} 个 chip`);
if (chips.length) {
  await chips[0].click(); await p.waitForTimeout(200);
  check('点 chip 填进输入框', (await p.inputValue('#compose')).length > 0);
}
check('推了今天该用的词块', (await p.textContent('#desk-due')).length > 0,
  (await p.textContent('#desk-due')).slice(0, 40));
check('全应用只有一份写作台',
  (await p.evaluate(() => document.querySelectorAll('#desk').length)) === 1,
  `${await p.evaluate(() => document.querySelectorAll('#desk').length)} 份`);

// 中途切走再切回来：草稿不能丢，写作台也不能留在别的页面回不来。
// 这条路径每天都会走 —— 写到一半想去语料库翻个词块。
await p.fill('#compose', 'half written draft 写到一半');
await p.click('nav button[data-tab="corpus"]'); await p.waitForTimeout(500);
check('切走时写作台回到自己的标签页',
  await p.evaluate(() => !!document.querySelector('#desk-home #desk')));
check('切走不丢正在写的内容', (await p.inputValue('#compose')) === 'half written draft 写到一半');
await p.click('nav button[data-tab="practice"]'); await p.waitForTimeout(500);
check('切回来写作台跟着回到批改结果下面',
  await p.evaluate(() => !!document.querySelector('#desk-slot #desk')));
check('切回来内容还在', (await p.inputValue('#compose')) === 'half written draft 写到一半');
check('搬来搬去之后仍然只有一份写作台',
  (await p.evaluate(() => document.querySelectorAll('#desk').length)) === 1);

await p.fill('#compose',
  'The whole thing runs on a new CMS built on Cloudflare Workers.');
await p.waitForTimeout(700);
check('实时词块提示措辞不夸大（碰到 ≠ 用对）',
  (await p.textContent('#reuse-live')).includes('碰到'),
  await p.textContent('#reuse-live'));

// ① 只存档不批改：必须明说这一条不算数
await p.click('#btn-compose'); await p.waitForTimeout(600);
const arch = await p.textContent('#compose-out');
check('只存档时明说没批改不算数', arch.includes('不算数'), arch.slice(0, 60));

// ② 批改（手工模式：导出请求 → 贴回 JSON）
await p.click('#btn-compose-grade'); await p.waitForTimeout(700);
check('仿写批改请求导出', await p.isVisible('#compose-manual'));
const cpay = await p.textContent('#compose-payload');
check('仿写批改请求有内容', cpay.length > 500 && cpay.includes('nativeVersion'), `${cpay.length} 字`);
await p.click('#btn-copy-compose'); await p.waitForTimeout(400);
const clipCompose = await p.evaluate(() => navigator.clipboard.readText());
check('仿写批改请求能复制', clipCompose.length > 1000, `${clipCompose.length} 字`);

await p.fill('#compose-json', JSON.stringify({
  nativeVersion: 'The whole thing runs on EmDash — a new CMS we built on Workers.',
  items: [{ mine: 'a new CMS built on Cloudflare Workers', native: 'a new CMS we built on Workers',
            category: 'structure', verdict: 'unnatural', leak: null,
            explainZh: '加上 we 把动作的人点出来，读起来更像推文而不是产品说明。', rule: null }],
  clarity: 'clear',
  clarityZh: '一遍就读懂了。',
  chunkUse: ['a new X built on Y'],
  strengths: ['runs on 用对了。'],
  verdictZh: '意思清楚，只差一点语气。',
}));
await p.click('#btn-import-compose'); await p.waitForTimeout(800);
const cout = await p.textContent('#compose-out');
check('仿写批改渲染出母语者版', cout.includes('母语者'), cout.slice(0, 60));
check('仿写批改渲染出清晰度', cout.includes('读懂了'), cout.slice(0, 60));
check('仿写批改判定了词块用对没有', cout.includes('用对了'), cout.slice(0, 120));
check('给出接下来该用的词块',
  cout.includes('下次试着用') || cout.includes('明天还会推给你'), cout.slice(0, 120));
await p.click('#btn-copy-native'); await p.waitForTimeout(300);
check('母语者版能复制', (await p.evaluate(() => navigator.clipboard.readText()))
  .includes('EmDash'));
await p.click('#btn-compose-again'); await p.waitForTimeout(400);
check('再写一条会清空', (await p.inputValue('#compose')) === '');

// ── 换一张 ──
await p.click('#btn-back'); await p.waitForTimeout(500);
check('换一张后写作台回到自己的标签页', await p.evaluate(
  () => document.querySelector('#desk-home #desk') !== null));
check('换一张回到列表', await p.isVisible('#pick'));
// 练完之后队列应该把它标成复习
const subAfter = await p.textContent('#pick-sub');
check('练完后给出完成状态而非空状态',
  subAfter.includes('今天练完了') || subAfter.includes('复习'), subAfter.slice(0, 40));



// ── 写作台（独立标签页）──
await p.click('nav button[data-tab="compose"]'); await p.waitForTimeout(700);
check('写作台在自己的标签页里可见', await p.isVisible('#compose'));
check('今天该用的词块有内容', (await p.textContent('#desk-due')).length > 10,
  (await p.textContent('#desk-due')).slice(0, 50));
await p.click('#btn-load-history'); await p.waitForTimeout(600);
const hist = await p.textContent('#history-out');
check('写过的能翻回来看', hist.includes('runs on'), hist.slice(0, 60));
check('历史里带上了母语者版', hist.includes('EmDash'), hist.slice(0, 80));

// ── 语料库 ──
await p.click('nav button[data-tab="corpus"]'); await p.waitForTimeout(600);
check('语料库列出词块', (await p.textContent('#corpus-out')).includes('词块'));

// ── 报告 ──
await p.click('nav button[data-tab="report"]'); await p.waitForTimeout(700);
const rep = await p.textContent('#report-out');
check('报告有数据', rep.includes('回译') && rep.includes('错误模式'), rep.slice(0, 60));

check('没有 JS 运行时错误', errors.length === 0, errors.join(' | ').slice(0, 200));

// ── 点击覆盖率 ──
// 点不到的必须写明理由。留空 = 有个按钮没人测过，那就是下一个事故。
const EXEMPT = {
  'btn-card-auto': '自动生成卡片需要配好 LLM，冒烟跑在手工模式下',
  'btn-fetch-models': '拉模型列表要连真实端点，出口代理挡着',
  'btn-test-settings': '同上，要连真实端点',
  'btn-clear-key': '会清掉配置，跑在共享库上有副作用',
  'btn-save-settings': '会写配置，跑在共享库上有副作用',
  'btn-step-copy': '要连错三次才出现，另有 tests 覆盖分支逻辑',
  'btn-del-x': '动态生成，另行断言',
  'btn-step-accept': '与 btn-step-peek 互斥分支，逻辑同源',
};
const allButtons = [...fs.readFileSync('src/server/app.html', 'utf8')
  .matchAll(/id="(btn-[\w-]+)"/g)].map((m) => m[1]);
const uncovered = [...new Set(allButtons)].filter((id) => !clicked.has(id) && !EXEMPT[id]);
check(`点击覆盖：${clicked.size}/${new Set(allButtons).size - Object.keys(EXEMPT).length} 个按钮被点过`,
  uncovered.length === 0, uncovered.length ? `没测到：${uncovered.join(', ')}` : '');

await b.close();
summary();
process.exit(failed ? 1 : 0);
