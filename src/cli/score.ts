/**
 * 难度打分 —— 纯机械计算，不调用 API。
 *
 *   pnpm score "the tweet text"
 *   pnpm score --file data/seed/tweets.json
 */
import fs from 'node:fs';
import { scoreDifficulty } from '../core/difficulty.js';
import { renderDifficulty, C } from './render.js';
import { parseArgs, die } from './args.js';

const args = parseArgs(process.argv.slice(2));

if (typeof args.file === 'string') {
  const items: { id: string; text: string }[] = JSON.parse(fs.readFileSync(args.file, 'utf8'));
  let usable = 0;
  for (const t of items) {
    const d = scoreDifficulty(t.text);
    if (d.usable) usable++;
    const mark = d.usable ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
    // 显示生词个数而不是百分比：判定用的就是个数，
    // 摆一个不参与判定的百分比在这里，看的人只会去对不上号
    const n = d.rareWords.length;
    console.log(
      `${mark} ${C.gray}L${d.level}${C.reset} ${String(n).padStart(2)} 生词  ` +
        `${t.text.slice(0, 56).replace(/\n/g, ' ')}${t.text.length > 56 ? '…' : ''}`,
    );
    if (!d.usable) console.log(`     ${C.gray}${d.reason}${C.reset}`);
  }
  console.log(`\n${C.bold}${usable}/${items.length}${C.reset} 条可用\n`);
} else {
  const text = typeof args._ === 'string' ? args._ : '';
  if (!text) die('用法: pnpm score "tweet text"  |  pnpm score --file <json>');
  console.log(renderDifficulty(text, scoreDifficulty(text)));
}
