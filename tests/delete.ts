/**
 * 删除卡片的连坐范围测试。
 *
 * 连坐删错了是数据事故，而且不可逆 —— 必须逐张表确认删到了什么、
 * 又保住了什么。特别是 compositions：那是学习者自己写的推文，
 * 卡可以删错，他写过的东西不该跟着消失。
 *
 *   npx tsx tests/delete.ts
 */
import fs from 'node:fs';
import {
  open, saveCard, saveAttempt, saveReview, saveComposition,
  recordStep, deleteCard, chunksByFn, framesByFn, stepsOf,
} from '../src/core/store.js';
import { scoreDifficulty } from '../src/core/difficulty.js';

const DB = '/tmp/te-delete-test.db';
fs.rmSync(DB, { force: true });
const db = open(DB);

let failed = 0;
const t = (name: string, ok: boolean, got = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !got ? '' : `  (${got})`}`);
};
const count = (sql: string, ...a: unknown[]) =>
  (db.prepare(sql).get(...(a as never[])) as { n: number }).n;

const mk = (id: string) =>
  saveCard(db, {
    id: `card_${id}`,
    tweet: { id, text: `tweet ${id} text here`, capturedAt: '2026-08-27T00:00:00Z' },
    glossZh: `卡片 ${id}`,
    steps: [{ glossZh: '第一步', en: 'step one' }, { glossZh: '第二步', en: 'step two' }],
    frames: [{ pattern: `X ${id} Y`, fn: '强调', glossZh: '骨架' }],
    chunks: [{ text: `chunk ${id}`, fn: '叙事', glossZh: '词块', example: 'ex' }],
    difficulty: scoreDifficulty('x'),
    createdAt: '2026-08-27T00:00:00Z',
  });

mk('A'); mk('B');
for (const c of ['card_A', 'card_B']) {
  saveAttempt(db, { id: `att_${c}`, cardId: c, text: 'my attempt', createdAt: '2026-08-27T01:00:00Z' });
  saveReview(db, `att_${c}`, {
    items: [{ mine: 'a', native: 'b', category: 'leak', verdict: 'wrong', leak: 'article',
              explainZh: '冠词', rule: null }],
    overlap: { matched: 1, total: 2 }, strengths: ['好'], verdictZh: '总评',
  });
  recordStep(db, c, 0, { tries: 1, hinted: false, copied: false, accepted: false });
}
saveComposition(db, 'comp_1', 'This is my own tweet, I wrote it.', true);

console.log('\n删除前');
t('两张卡', count('SELECT COUNT(*) AS n FROM cards') === 2);
t('两条推文', count('SELECT COUNT(*) AS n FROM tweets') === 2);

const r = deleteCard(db, 'card_A');
console.log('\n删除 card_A —— 连坐范围');
console.log('  ', JSON.stringify(r.deleted));
t('卡片没了', count('SELECT COUNT(*) AS n FROM cards WHERE id = ?', 'card_A') === 0);
t('步骤没了', stepsOf(db, 'card_A').length === 0);
t('练习进度没了', count('SELECT COUNT(*) AS n FROM step_progress WHERE card_id = ?', 'card_A') === 0);
t('骨架没了', framesByFn(db).filter((f) => f.pattern.includes('A')).length === 0);
t('词块没了', chunksByFn(db).filter((c) => c.text.includes('A')).length === 0);
t('回译没了', count('SELECT COUNT(*) AS n FROM attempts WHERE card_id = ?', 'card_A') === 0);
t('批改没了', count('SELECT COUNT(*) AS n FROM reviews WHERE attempt_id = ?', 'att_card_A') === 0);
t('差异条目没了', count('SELECT COUNT(*) AS n FROM diff_items WHERE attempt_id = ?', 'att_card_A') === 0);
t('推文没了（没有别的卡引用它）', count('SELECT COUNT(*) AS n FROM tweets WHERE id = ?', 'A') === 0);

console.log('\n不该被波及的');
t('另一张卡完好', count('SELECT COUNT(*) AS n FROM cards WHERE id = ?', 'card_B') === 1);
t('另一张卡的步骤还在', stepsOf(db, 'card_B').length === 2);
t('另一张卡的词块还在', chunksByFn(db).filter((c) => c.text.includes('B')).length === 1);
t('另一张卡的批改还在', count('SELECT COUNT(*) AS n FROM reviews WHERE attempt_id = ?', 'att_card_B') === 1);
t('★ 自己写的仿写不受影响', count('SELECT COUNT(*) AS n FROM compositions') === 1);

console.log('\n边界');
try { deleteCard(db, 'card_NOPE'); t('删不存在的卡要报错', false); }
catch { t('删不存在的卡要报错', true); }
t('重复删同一张也不炸', (() => { try { deleteCard(db, 'card_A'); return false; } catch { return true; } })());

fs.rmSync(DB, { force: true });
console.log(`\n${failed ? `✗ ${failed} 项未通过\n` : '✓ 全部通过\n'}`);
process.exit(failed ? 1 : 0);
