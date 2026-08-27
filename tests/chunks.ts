/**
 * 词块调度与仿写批改的测试（M9）。
 *
 * 这一环最容易出的错是**判定过宽**：把「字符串匹配到」当成「用对了」。
 * 一旦这么判，系统会把复习间隔往后拉，那个用错的词块从此再没人纠正 ——
 * 表面上进度条更好看，实际上是在帮倒忙。所以下面的断言里，
 * 「不该升级的场景」比「该升级的场景」更多。
 *
 *   npx tsx tests/chunks.ts
 */
import fs from 'node:fs';
import {
  open, saveCard, saveComposition, saveCompositionReview, attemptedChunks,
  recordChunkUse, dueChunks, chunksByFn, chunkStats, compositions,
  deleteCard, progress,
} from '../src/core/store.js';
import { weakLeaks } from '../src/core/plan.js';
import { scoreDifficulty } from '../src/core/difficulty.js';
import type { ComposeReviewOut } from '../src/core/schema.js';

const DB = '/tmp/te-chunks-test.db';
fs.rmSync(DB, { force: true });
const db = open(DB);

let failed = 0;
const t = (name: string, ok: boolean, got = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !got ? '' : `  (${got})`}`);
};
const at = (iso: string) => new Date(iso);
const T0 = at('2026-08-01T09:00:00Z');

saveCard(db, {
  id: 'card_a',
  tweet: { id: 'a', text: 'We shipped a new CMS built on Cloudflare Workers.', capturedAt: T0.toISOString() },
  glossZh: '卡片 A',
  steps: [{ glossZh: '一', en: 'We shipped a new CMS' }],
  frames: [{ pattern: 'X built on Y', fn: '叙事', glossZh: '骨架' }],
  chunks: [
    { text: 'built on', fn: '叙事', glossZh: '基于……搭的', example: 'a new CMS built on Cloudflare Workers' },
    { text: 'shipped', fn: '叙事', glossZh: '上线了', example: 'We shipped a new CMS' },
    { text: 'push back on', fn: '反对', glossZh: '反驳', example: "I'd push back on that" },
  ],
  difficulty: scoreDifficulty('We shipped a new CMS built on Cloudflare Workers.'),
  createdAt: T0.toISOString(),
});

const all = chunksByFn(db);
const byText = (s: string) => all.find((c) => c.text === s)!;
const BUILT = byText('built on').id;
const SHIP = byText('shipped').id;
const PUSH = byText('push back on').id;

console.log('\nrecordChunkUse —— 升降级规则');

t('批改确认用对了 → 升一格', recordChunkUse(db, BUILT, { correct: true, verified: true }, T0).box === 1);
t('再用对一次 → 再升一格', recordChunkUse(db, BUILT, { correct: true, verified: true }, T0).box === 2);

// 这一条是整个 M9 的防线：只被字符串匹配到，不能当成掌握
const un = recordChunkUse(db, SHIP, { correct: true, verified: false }, T0);
t('只匹配到（没批改确认）→ 最多升到第 1 格', un.box === 1, `box=${un.box}`);
const un2 = recordChunkUse(db, SHIP, { correct: true, verified: false }, T0);
t('再匹配到多少次也还是第 1 格', un2.box === 1, `box=${un2.box}`);

// 但也不能反过来把已经确认过的打下来
const keep = recordChunkUse(db, BUILT, { correct: true, verified: false }, T0);
t('未确认的使用不会把高格打下来', keep.box === 2, `box=${keep.box}`);

const bad = recordChunkUse(db, BUILT, { correct: false, verified: true }, T0);
t('用错了 → 直接打回第 0 格', bad.box === 0, `box=${bad.box}`);
t('用错了 → 8 小时后就回来', new Date(bad.dueAt).getTime() - T0.getTime() === 8 * 3600_000);

const st = chunkStats(db);
t('统计：用对过 2 个', st.used === 2, JSON.stringify(st));
t('统计：批改确认过 1 个', st.verified === 1, JSON.stringify(st));
t('统计：用错过 1 个', st.misused === 1, JSON.stringify(st));

console.log('\ndueChunks —— 今天该用哪几个');

const due = dueChunks(db, 3, T0);
t('从没用过的进队列', due.some((c) => c.id === PUSH));
t('每条都给了为什么', due.every((c) => c.why.length > 0));
t('刚升到第 1 格的不在今天的队列里', !due.some((c) => c.id === SHIP), due.map((c) => c.text).join(','));
// 刚用错的那个不该立刻又推回来 —— 他几秒钟前才看过这处批改。
// 第 0 格是 8 小时，也就是「今天晚些或者明天」。
t('刚打回第 0 格的当场不重复推送', !due.some((c) => c.id === BUILT), due.map((c) => c.text).join(','));
t('limit 生效', dueChunks(db, 1, T0).length === 1);

// 8 小时后打回重来的那个到期，而且要排在新词块前面：
// 「他以为自己会」是最该先看见的
const later = dueChunks(db, 5, at('2026-08-01T18:00:00Z'));
t('到期后重新进队列', later.some((c) => c.id === BUILT));
t('用错过的排在新词块前面', later[0]!.id === BUILT, later.map((c) => c.text).join(','));
t('用错过的说明点出了用错', later[0]!.why.includes('用错'), later[0]!.why);

console.log('\nattemptedChunks —— 他伸手去用了哪些');

const text = 'Our whole site is now built on Workers, and I would push back on that idea.';
const mech = attemptedChunks(db, text);
t('字符串匹配抓到 built on', mech.some((c) => c.id === BUILT));
t('形态变了的（push back on ≠ would push back on）也能抓到', mech.some((c) => c.id === PUSH));

// 批改点名了一个字符串匹配不到的（他用了变体形态）
const withNamed = attemptedChunks(db, 'Our site ships weekly now.', ['shipped']);
t('批改点名的词块会被并进来', withNamed.some((c) => c.id === SHIP), withNamed.map((c) => c.text).join(','));

console.log('\nsaveCompositionReview —— 批改 → 词块熟悉度');

const review: ComposeReviewOut = {
  nativeVersion: 'Our whole site now runs on Workers — though I\'d push back on that framing.',
  items: [
    { mine: 'is now built on', native: 'now runs on', category: 'chunk', verdict: 'unnatural',
      leak: null, explainZh: '网站「跑在」某个平台上用 run on，built on 说的是搭建时用了什么。', rule: null },
    { mine: 'that idea', native: 'that framing', category: 'leak', verdict: 'wrong',
      leak: 'article', explainZh: '这里指的是前文那个说法。', rule: null },
  ],
  clarity: 'clear',
  clarityZh: '意思清楚。',
  chunkUse: ['push back on'],   // built on 出现了，但批改没认它 —— 也就是用错了
  strengths: ['破折号补充说明用对了。'],
  verdictZh: '结构没问题。',
};

saveComposition(db, 'comp_1', text, false);
const res = saveCompositionReview(db, 'comp_1', review, attemptedChunks(db, text, review.chunkUse), T0);
t('用对的升级了 1 个', res.used.length === 1, res.used.map((c) => c.text).join(','));
t('用对的是 push back on', res.used[0]?.id === PUSH);
t('伸手去用但没被认可的降级了 1 个', res.misused.length === 1, res.misused.map((c) => c.text).join(','));

const after = db.prepare('SELECT box, uses, misuses, verified FROM chunk_progress WHERE chunk_id = ?')
  .get(PUSH) as unknown as { box: number; uses: number; verified: number };
t('push back on 升到第 1 格且标记为已确认', after.box === 1 && after.verified === 1, JSON.stringify(after));

const builtAfter = db.prepare('SELECT box, misuses FROM chunk_progress WHERE chunk_id = ?')
  .get(BUILT) as unknown as { box: number; misuses: number };
t('built on 被打回第 0 格，用错次数 +1', builtAfter.box === 0 && builtAfter.misuses === 2,
  JSON.stringify(builtAfter));

console.log('\n仿写批改读得回来');

const list = compositions(db);
t('列表里有这一条', list.length === 1);
t('母语者版存下来了', list[0]!.review?.nativeVersion === review.nativeVersion);
t('差异条目存下来了', list[0]!.review?.items.length === 2);
t('清晰度存下来了', list[0]!.review?.clarity === 'clear');
t('做对的地方存下来了', list[0]!.review?.strengths.length === 1);

console.log('\n漏点画像：自由写作里的错按双倍计');

// 只有仿写里的一处 article 漏点，没有回译数据
t('仿写的漏点进得了画像', weakLeaks(db).includes('article'), weakLeaks(db).join(','));
const p = progress(db);
t('报告里能看到这个漏点', p.leaks.some((l) => l.leak === 'article'));
t('报告标出了它是自由写作时犯的', p.leaks.find((l) => l.leak === 'article')!.free === 1);
t('报告带上了词块统计', p.chunks.total === 3, JSON.stringify(p.chunks));
t('报告带上了清晰度分布', p.clarity.clear === 1 && p.composeReviews === 1, JSON.stringify(p.clarity));

console.log('\n批改只报半截词块时的容错');

// 批改经常只报用到的那一截：库里是 `a new X built on Y`，它回 `built on`。
// 严格相等的话，一次完全正确的使用会被判成用错、打回第 0 格 ——
// 罚对了的人比放过错了的人伤害大得多。
saveComposition(db, 'comp_partial', 'We shipped it last week.');
const partial = saveCompositionReview(
  db, 'comp_partial',
  { ...review, chunkUse: ['shipped it'] },      // 只报了半截
  attemptedChunks(db, 'We shipped it last week.', ['shipped it']),
  at('2026-08-02T09:00:00Z'),
);
t('批改只报了半截词块，也认得出是哪一个',
  partial.used.some((c) => c.id === SHIP), partial.used.map((c) => c.text).join(','));
t('半截匹配不会把无关词块也算进来', partial.misused.length === 0,
  partial.misused.map((c) => c.text).join(','));


console.log('\n删卡片要连坐词块进度，但不碰仿写');

const before = compositions(db).length;
deleteCard(db, 'card_a');
const orphans = (db.prepare('SELECT COUNT(*) AS n FROM chunk_progress').get() as { n: number }).n;
t('词块进度跟着删干净了', orphans === 0, `${orphans} 行残留`);
t('仿写正文一条都没少', compositions(db).length === before, `${before} → ${compositions(db).length}`);
t('仿写批改也保住了', compositions(db).every((c) => c.review !== null));

db.close();
console.log(failed ? `\n  ${failed} 项未通过\n` : '\n  全部通过\n');
process.exit(failed ? 1 : 0);
