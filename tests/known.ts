/**
 * 生词额度与个人已知词。
 *
 * 这一支最容易出的错是**规则名和实际行为对不上**：文档和界面都说
 * 「90% 法则」，而实现里 9 词的句子必须一个生词都没有 ——
 * 使用者不会去读源码，他只会觉得「这系统怎么什么都不让我练」。
 *
 *   npx tsx tests/known.ts
 */
import fs from 'node:fs';
import { scoreDifficulty } from '../src/core/difficulty.js';
import { open, addKnownWord, removeKnownWord, knownWords } from '../src/core/store.js';

let failed = 0;
const t = (name: string, ok: boolean, got = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !got ? '' : `  (${got})`}`);
};

console.log('\n短句：一个生词不该毙掉整句');

// 用户实际遇到的那一句。empower 现在进了领域词表，所以它一个生词都没有 ——
// 但这一句本身仍然要留着当回归样本：修表容易，把规则修回去也容易。
const REAL = 'Join our mission to empower the world to design.';
t('用户报的那一句现在可用', scoreDifficulty(REAL).usable, scoreDifficulty(REAL).reason);

// 规则本身用生造词来验，免得哪天往词表里加了词，测的就不是规则了
const SHORT = 'Join our mission to zorbulate the world to design.';
const d = scoreDifficulty(SHORT);
t('9 词 1 生词判为可用', d.usable, d.reason);
t('生词点出来了', d.rareWords.join(',') === 'zorbulate', d.rareWords.join(','));
t('分级按生词个数走，不掉到 L5', d.level <= 2, `L${d.level}`);
t('比例仍然如实报出来（89%）', Math.round(d.coverage * 100) === 89, `${d.coverage}`);

// 但额度只有一个 —— 两个生词的短句还是该拦下来，
// 否则「放宽」就变成了「不筛了」
const TWO = 'Join our mission to zorbulate the quindral world.';
const d2 = scoreDifficulty(TWO);
t('同样长度但两个生词就拦下', !d2.usable, d2.reason);
t('拦下时说清楚额度是多少', d2.reason.includes('最多'), d2.reason);

console.log('\n长文本：额度就是 10%，和原来的 90% 法则同一条线');

// 词表里查不到的生造词，保证被判成生词
const RARE = ['zorbulate', 'quindral', 'flembic', 'vurnathy', 'plexorid', 'thranquil'];
const mk = (n: number, k: number) =>
  Array.from({ length: n }, (_, i) => (i < k ? RARE[i]! : 'the')).join(' ') + '.';
t('20 词 2 生词（正好 90%）通过', scoreDifficulty(mk(20, 2)).usable, scoreDifficulty(mk(20, 2)).reason);
t('20 词 3 生词（85%）拦下', !scoreDifficulty(mk(20, 3)).usable);
t('50 词 5 生词（90%）通过', scoreDifficulty(mk(50, 5)).usable);
t('50 词 6 生词（88%）拦下', !scoreDifficulty(mk(50, 6)).usable);

console.log('\n重复的生词只算一个');

// 同一个生词出现三次，学一次就够了，不该按三次吃掉额度 ——
// 额度算的是「要学几个新词」，不是「读到几次不认识的字」
const REPEAT = 'The zorbulate tool and the zorbulate app and the zorbulate site are here now.';
t('重复生词只占一个额度', scoreDifficulty(REPEAT).usable, scoreDifficulty(REPEAT).reason);

console.log('\n目标读者的常识词不该算生词');
for (const w of ['app', 'ui', 'github', 'blog', 'prompt', 'empower', 'download']) {
  const r = scoreDifficulty(`I really like the ${w} thing here today.`);
  t(`${w} 不算生词`, !r.rareWords.includes(w), r.rareWords.join(','));
}

console.log('\n个人已知词');

const DB = '/tmp/te-known-test.db';
fs.rmSync(DB, { force: true });
const db = open(DB);

t('还没标过时是空的', knownWords(db).size === 0);
t('标记会归一化（大小写、标点）', addKnownWord(db, 'Zorbulate,') === 'zorbulate');
t('存进去了', knownWords(db).has('zorbulate'));
t('重复标记不报错', addKnownWord(db, 'zorbulate') === 'zorbulate' && knownWords(db).size === 1);
t('标点碎片不收', addKnownWord(db, '—') === null);

const after = scoreDifficulty(SHORT, { extraKnown: knownWords(db) });
t('标过之后就不算生词了', after.rareWords.length === 0, after.rareWords.join(','));
t('标过之后升到 L1', after.level === 1, `L${after.level}`);

// 标错了必须能撤回 —— 一次手滑不该永久放宽筛选
t('可以撤回', removeKnownWord(db, 'zorbulate') && knownWords(db).size === 0);
t('撤回后又算生词', scoreDifficulty(SHORT, { extraKnown: knownWords(db) }).rareWords.length === 1);
t('撤回不存在的词不报错', removeKnownWord(db, 'nonexistent') === false);

db.close();
fs.rmSync(DB, { force: true });
console.log(failed ? `\n  ${failed} 项未通过\n` : '\n  全部通过\n');
process.exit(failed ? 1 : 0);
