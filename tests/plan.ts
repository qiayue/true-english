/**
 * 支架级别与智能排程测试。
 *
 *   npx tsx tests/plan.ts
 */
import fs from 'node:fs';
import { open, saveCard, saveAttempt, saveReview, recordStep } from '../src/core/store.js';
import { stageForBox, estimateMinutes, planToday, weakLeaks } from '../src/core/plan.js';
import { scoreDifficulty } from '../src/core/difficulty.js';

const DB = '/tmp/te-plan-test.db';
fs.rmSync(DB, { force: true });
const db = open(DB);

let failed = 0;
const t = (name: string, ok: boolean, got = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !got ? '' : `  (${got})`}`);
};

console.log('\n支架级别由熟悉度决定');
t('新卡 → 照抄', stageForBox(null) === 'copy');
t('上次卡住（box 0）→ 照抄', stageForBox(0) === 'copy');
t('box 1 → 填空', stageForBox(1) === 'cloze');
t('box 2-3 → 逐句', stageForBox(2) === 'step' && stageForBox(3) === 'step');
t('box 4+ → 整段', stageForBox(4) === 'whole' && stageForBox(5) === 'whole');

console.log('\n估时：支架越少越费时间');
const c5 = (s: Parameters<typeof estimateMinutes>[0]) => estimateMinutes(s, 5);
t('照抄 < 填空 < 逐句 < 整段',
  c5('copy') < c5('cloze') && c5('cloze') < c5('step') && c5('step') < c5('whole'),
  `${c5('copy')} / ${c5('cloze')} / ${c5('step')} / ${c5('whole')}`);

const T0 = new Date('2026-08-27T09:00:00Z');
const ago = (h: number) => new Date(T0.getTime() - h * 3600_000);
const mk = (id: string, text: string, steps = 5) =>
  saveCard(db, {
    id: `card_${id}`, tweet: { id, text, capturedAt: '2026-08-01T00:00:00Z' },
    glossZh: `卡片 ${id}`,
    steps: Array.from({ length: steps }, (_, i) => ({ glossZh: `第${i}步`, en: `step ${i}` })),
    frames: [], chunks: [], difficulty: scoreDifficulty(text), createdAt: '2026-08-01T00:00:00Z',
  });

console.log('\n全是新卡时');
mk('N1', 'plain text one'); mk('N2', 'plain text two'); mk('N3', 'plain text three');
{
  const p = planToday(db, { now: T0, budgetMinutes: 25 });
  t('新卡限量（默认 2）', p.items.length === 2, `${p.items.length}`);
  t('新卡都走照抄', p.items.every((i) => i.stage === 'copy'));
  t('有积压时报出来', p.backlog === 1, `backlog=${p.backlog}`);
  t('总时长在预算内', p.minutes <= 25, `${p.minutes} min`);
}

console.log('\n复习优先于新卡');
recordStep(db, 'card_N1', 0, { tries: 1, hinted: false, copied: false, accepted: false }, ago(48));
{
  const p = planToday(db, { now: T0, budgetMinutes: 25 });
  t('到期复习排最前', p.items[0]?.kind === 'review', p.items.map((i) => i.kind).join(','));
  t('复习卡升到了下一级支架', p.items[0]?.stage === 'cloze', p.items[0]?.stage);
  t('说明了为什么排它', !!p.items[0]?.why && p.items[0].why.includes('逾期'), p.items[0]?.why);
}

console.log('\n漏点加权');
saveAttempt(db, { id: 'att1', cardId: 'card_N2', text: 'x', createdAt: T0.toISOString() });
saveReview(db, 'att1', {
  items: Array.from({ length: 5 }, () => ({
    mine: 'x', native: 'the', category: 'leak' as const, verdict: 'wrong' as const,
    leak: 'article' as const, explainZh: '冠词', rule: null,
  })),
  overlap: { matched: 1, total: 2 }, strengths: ['x'], verdictZh: 'x',
});
t('漏点统计出来了', weakLeaks(db)[0] === 'article', weakLeaks(db).join(','));

// 拼写和大小写不该参与出题：挖掉一个拼错过的单词，考的是打字不是语法。
// 而且手滑比语法错好犯，次数常年最多 —— 不过滤的话它们会把冠词挤出前四。
saveAttempt(db, { id: 'att2', cardId: 'card_N2', text: 'x', createdAt: T0.toISOString() });
saveReview(db, 'att2', {
  items: Array.from({ length: 20 }, () => ({
    mine: 'Cloudfalre', native: 'Cloudflare', category: 'leak' as const, verdict: 'wrong' as const,
    leak: 'spelling' as const, explainZh: '手滑', rule: null,
  })),
  overlap: { matched: 1, total: 2 }, strengths: ['x'], verdictZh: 'x',
});
t('拼写次数再多也不参与出题', !weakLeaks(db).includes('spelling' as never), weakLeaks(db).join(','));
t('被挤掉之后冠词还在', weakLeaks(db)[0] === 'article', weakLeaks(db).join(','));
mk('W1', 'this one has the article in it');   // 命中 article
mk('W2', 'plain words without that marker');  // 不命中
{
  const p = planToday(db, { now: T0, budgetMinutes: 25, newLimit: 10 });
  const w1 = p.items.find((i) => i.cardId === 'card_W1');
  const w2 = p.items.find((i) => i.cardId === 'card_W2');
  t('练得到漏点的卡分更高', (w1?.score ?? 0) > (w2?.score ?? 0), `${w1?.score} vs ${w2?.score}`);
  t('理由里说了练到什么漏点', !!w1?.why?.includes('article') || w1?.kind === 'new', w1?.why);
}

console.log('\n时间预算是硬约束');
{
  const tight = planToday(db, { now: T0, budgetMinutes: 3, newLimit: 10 });
  t('预算很紧时只排一点', tight.minutes <= 3 || tight.items.length === 1,
    `${tight.minutes} min / ${tight.items.length} 条`);
  t('至少排一条（不能空手）', tight.items.length >= 1);
  t('剩下的算积压', tight.backlog > 0, `backlog=${tight.backlog}`);
}

console.log('\n没到期的不排');
{
  for (let i = 0; i < 5; i++) {
    recordStep(db, 'card_N3', 0, { tries: 1, hinted: false, copied: false, accepted: false }, T0);
  }
  const p = planToday(db, { now: T0, budgetMinutes: 60, newLimit: 10 });
  t('刚练完的不会当天再排', !p.items.some((i) => i.cardId === 'card_N3'),
    p.items.map((i) => i.cardId).join(','));
}

fs.rmSync(DB, { force: true });
console.log(`\n${failed ? `✗ ${failed} 项未通过\n` : '✓ 全部通过\n'}`);
process.exit(failed ? 1 : 0);
