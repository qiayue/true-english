/**
 * 卡片生成。
 *
 *   pnpm card "the tweet text"
 *   pnpm card --file data/seed/tweets.json --index 0
 */
import fs from 'node:fs';
import { makeCard } from '../core/review.js';
import { scoreDifficulty } from '../core/difficulty.js';
import { renderCard, renderDifficulty, C } from './render.js';
import { parseArgs, die } from './args.js';
import { loadConfig } from '../core/settings.js';
import { open, DEFAULT_DB } from '../core/store.js';
import { ConfigError } from '../core/llm.js';

const args = parseArgs(process.argv.slice(2));

let text = typeof args._ === 'string' ? args._ : '';
let id = 'adhoc';
let author: string | undefined;

if (typeof args.file === 'string') {
  const items = JSON.parse(fs.readFileSync(args.file, 'utf8')) as {
    id: string;
    text: string;
    author?: string;
  }[];
  const i = Number(args.index ?? 0);
  const t = items[i];
  if (!t) die(`第 ${i} 条不存在（共 ${items.length} 条）`);
  text = t.text;
  id = t.id;
  author = t.author;
}

if (!text) die('用法: pnpm card "tweet text"  |  pnpm card --file <json> --index <n>');

const d = scoreDifficulty(text);
if (!d.usable && !args.force) {
  console.log(renderDifficulty(text, d));
  die('这条推文没通过 90% 法则筛选。要强制生成加 --force');
}

try {
  const card = await makeCard(
    { id, text, author, capturedAt: new Date().toISOString() },
    loadConfig(open(String(args.db ?? DEFAULT_DB))),
  );
  console.log(renderCard(card));
  if (args.json) {
    fs.writeFileSync(String(args.json), JSON.stringify(card, null, 2));
    console.log(`${C.gray}已写入 ${args.json}${C.reset}\n`);
  }
} catch (e) {
  if (e instanceof ConfigError) die(e.message);
  throw e;
}
