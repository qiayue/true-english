/**
 * 填空生成测试。
 *
 * 核心断言只有一条：**挖空点必须落在学习者的漏点上**。
 * 随机挖空看起来也能跑，但教不到东西 —— 这个测试就是防止哪天
 * 有人图省事把它改成随机。
 *
 *   npx tsx tests/cloze.ts
 */
import { makeCloze, checkCloze } from '../src/core/cloze.js';

let failed = 0;
const t = (name: string, ok: boolean, got = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !got ? '' : `  (${got})`}`);
};
const show = (c: ReturnType<typeof makeCloze>) =>
  c.tokens.map((tk, i) => (c.blanks.some((b) => b.index === i) ? '___' : tk)).join(' ');
const answers = (c: ReturnType<typeof makeCloze>) => c.blanks.map((b) => `${b.answer}(${b.leak})`);

const EN = 'a new CMS built on Cloudflare Workers.';

console.log('\n按漏点挖空');
{
  const c = makeCloze(EN, ['article']);
  t('冠词是漏点 → 挖冠词', c.blanks.every((b) => b.leak === 'article'), answers(c).join(' '));
  console.log('   ', show(c));
}
{
  const c = makeCloze(EN, ['preposition']);
  t('介词是漏点 → 挖介词', c.blanks.some((b) => b.answer === 'on'), answers(c).join(' '));
  console.log('   ', show(c));
}
{
  const c = makeCloze(EN, ['wordform']);
  t('词形是漏点 → 挖过去分词 built', c.blanks.some((b) => b.answer === 'built'), answers(c).join(' '));
  console.log('   ', show(c));
}

console.log('\n漏点有先后');
{
  const c = makeCloze(EN, ['wordform', 'article'], 1);
  t('最严重的漏点优先挖', c.blanks[0]?.leak === 'wordform', answers(c).join(' '));
}

console.log('\n没有历史数据时');
{
  const c = makeCloze(EN, []);
  t('退回通用漏点：冠词/介词',
    c.blanks.length > 0 && c.blanks.every((b) => b.leak === 'article' || b.leak === 'preposition'),
    answers(c).join(' '));
}

console.log('\n数量约束');
{
  const short = makeCloze('It\'s not.', ['article', 'preposition', 'agreement']);
  t('短句不能挖成筛子', short.blanks.length <= 1, `挖了 ${short.blanks.length} 个 / 共 ${short.tokens.length} 词`);
  const long = makeCloze(
    'What you might not know: the whole thing runs on EmDash, a new CMS built on Cloudflare Workers.',
    ['article', 'preposition', 'wordform', 'number'], 5);
  t('长句最多挖 5 个', long.blanks.length <= 5, `${long.blanks.length}`);
  t('挖空点按原文顺序排', long.blanks.every((b, i) => i === 0 || b.index > long.blanks[i - 1]!.index));
  console.log('   ', show(long));
}

console.log('\n实在没得挖时');
{
  const c = makeCloze('Kittens purr loudly', ['article']);
  t('也要给一个空，不能空手', c.blanks.length === 1, show(c));
}

console.log('\n判定');
{
  const c = makeCloze(EN, ['article', 'preposition']);
  const right = c.blanks.map((b) => b.answer);
  t('全对', checkCloze(c, right).allOk);
  t('大小写不计较', checkCloze(c, right.map((x) => x.toUpperCase())).allOk);
  t('标点不计较', checkCloze(c, right.map((x) => x + ',')).allOk);
  t('空着算错', !checkCloze(c, right.map(() => '')).allOk);
  const one = [...right]; one[0] = 'zzz';
  const r = checkCloze(c, one);
  t('错一个就不算全对', !r.allOk && r.results[0]?.ok === false);
}

console.log('\n边界');
t('空输入不炸', makeCloze('', ['article']).blanks.length === 0);

console.log(`\n${failed ? `✗ ${failed} 项未通过\n` : '✓ 全部通过\n'}`);
process.exit(failed ? 1 : 0);
