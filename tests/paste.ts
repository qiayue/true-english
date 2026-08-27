/**
 * 粘贴清洗测试。
 *
 *   npx tsx tests/paste.ts
 */
import { cleanPaste } from '../src/core/paste.js';

let failed = 0;
const t = (name: string, ok: boolean, got = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !got ? '' : `\n      ${got}`}`);
};

console.log('\n从推特网页整块复制');
{
  const r = cleanPaste(`Cloudflare
@Cloudflare
·
2h
We redesigned the Cloudflare Blog — dark mode, cleaner UI, faster load times.
1.2K
340
89
Show more`);
  t('只剩下正文一条', r.tweets.length === 1, JSON.stringify(r.tweets));
  t('正文完整', r.tweets[0] === 'We redesigned the Cloudflare Blog — dark mode, cleaner UI, faster load times.');
  t('报告清掉了几行', r.removed === 8, `removed=${r.removed}`);
}

console.log('\n一次粘多条（空行分隔）');
{
  const r = cleanPaste(`Julia Evans
@b0rk
·
5h
Reading code is a skill. We just never practice it on purpose.
82
1.4K

Paul Graham
@paulg
·
1d
Most of my best decisions looked boring at the time.
3.2K`);
  t('切出两条', r.tweets.length === 2, JSON.stringify(r.tweets));
  t('第一条对', !!r.tweets[0]?.startsWith('Reading code is a skill'));
  t('第二条对', !!r.tweets[1]?.startsWith('Most of my best decisions'));
}

console.log('\n推文内部的软换行不该被当成分隔');
{
  const r = cleanPaste(`I used to think shipping fast was about typing fast.
It's not.
It's about having fewer things to decide.`);
  t('拼成一条', r.tweets.length === 1, JSON.stringify(r.tweets));
  t('句子之间有空格', !!r.tweets[0]?.includes("typing fast. It's not. It's about"));
}

console.log('\n中文界面');
{
  const r = cleanPaste(`某人
@someone
·
3小时前
This is the actual tweet text here.
1.2万
显示更多
翻译帖子`);
  t('中文噪音也清掉', r.tweets.length === 1 && r.tweets[0] === 'This is the actual tweet text here.',
    JSON.stringify(r.tweets));
}

console.log('\n干净的输入不该被破坏');
{
  const r = cleanPaste(`We were Customer Zero.

Most of my best decisions looked boring at the time.`);
  t('两条都留着', r.tweets.length === 2);
  t('一行没清', r.removed === 0, `removed=${r.removed}`);
}

console.log('\n边界');
{
  t('空输入', cleanPaste('').tweets.length === 0);
  t('全是噪音', cleanPaste('@bork\n·\n2h\n1.2K').tweets.length === 0);
  const keep = cleanPaste('It costs 340 dollars.');
  t('正文里的数字不受影响', keep.tweets[0] === 'It costs 340 dollars.', JSON.stringify(keep.tweets));
}

console.log(`\n${failed ? `✗ ${failed} 项未通过\n` : '✓ 全部通过\n'}`);
process.exit(failed ? 1 : 0);
