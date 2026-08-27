/**
 * 间隔重复的调度规则测试。
 *
 * 这套规则以后一定会调（间隔太长/太短、升降级条件），
 * 没有测试就是在盲改 —— 而调错了不会报错，只会让人在错误的时间
 * 复习到错误的东西，几周后才察觉。
 *
 *   npx tsx tests/schedule.ts
 */
import fs from 'node:fs';
import { open, saveCard, recordStep, today, MAX_BOX } from '../src/core/store.js';
import { scoreDifficulty } from '../src/core/difficulty.js';

const DB = '/tmp/te-schedule-test.db';
fs.rmSync(DB, { force: true });
const db = open(DB);

let failed = 0;
const t = (name: string, ok: boolean, got = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !got ? '' : `  (${got})`}`);
};

const mk = (id: string, n: number) =>
  saveCard(db, {
    id: `card_${id}`,
    tweet: { id, text: 'x '.repeat(n), capturedAt: '2026-08-27T00:00:00Z' },
    glossZh: `卡片 ${id}`,
    steps: Array.from({ length: n }, (_, i) => ({ glossZh: `第${i}步`, en: `step ${i}` })),
    frames: [], chunks: [],
    difficulty: scoreDifficulty('x'),
    createdAt: '2026-08-27T00:00:00Z',
  });
mk('A', 3);
mk('B', 2);

const T0 = new Date('2026-08-27T09:00:00Z');
const hrs = (h: number) => new Date(T0.getTime() + h * 3600_000);
const rec = (card: string, idx: number, o: Partial<Parameters<typeof recordStep>[3]>, at = T0) =>
  recordStep(db, card, idx, { tries: 1, hinted: false, copied: false, accepted: false, ...o }, at);

console.log('\n升降级');
t('一次就对、没用提示 → 升一格', rec('card_A', 0, {}).box === 1);
t('一次对但用了提示 → 原地不动', rec('card_A', 0, { hinted: true }).box === 1);
t('写了三次才对 → 原地不动', rec('card_A', 0, { tries: 3 }).box === 1);
t('抄过原文 → 打回第 0 格', rec('card_A', 0, { tries: 5, copied: true }).box === 0);
t('「我也对」跳过 → 不参与升降', rec('card_A', 0, { accepted: true }).box === 0);

console.log('\n爬升与封顶');
let box = 0;
for (let i = 0; i < 8; i++) box = rec('card_A', 1, {}).box;
t(`连对 8 次封顶在 ${MAX_BOX}`, box === MAX_BOX, `box=${box}`);

console.log('\n到期');
rec('card_A', 2, {});
t('4 小时后第 0 格还没到期', !today(db, hrs(4)).some((i) => i.cardId === 'card_A'));
const at10 = today(db, hrs(10)).find((i) => i.cardId === 'card_A');
t('10 小时后只有第 0 格那一步到期', at10?.dueSteps === 1, `dueSteps=${at10?.dueSteps}`);
t('到期卡标记为 review', at10?.kind === 'review');

console.log('\n队列排序');
const q = today(db, hrs(10));
t('复习排在新卡前面', q[0]?.kind === 'review', q.map((i) => i.kind).join(','));
t('没练过的算新卡', q.find((i) => i.cardId === 'card_B')?.kind === 'new');
t('最弱的（box 最低）排最前', (q[0]?.weakestBox ?? 9) === 0);

fs.rmSync(DB, { force: true });
console.log(`\n${failed ? `✗ ${failed} 项未通过\n` : '✓ 全部通过\n'}`);
process.exit(failed ? 1 : 0);
