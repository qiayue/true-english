/**
 * 语料库浏览 —— 按功能检索，不按话题。
 *
 *   pnpm corpus                    列出全部
 *   pnpm corpus --fn 反对          按功能筛选
 *   pnpm corpus --check "你写的英文"  检查这条仿写复用了哪些词块
 *   pnpm corpus --add "你写的英文"    存一条仿写
 */
import './silence.js';
import { open, chunksByFn, framesByFn, detectReuse, saveComposition } from '../core/store.js';
import { FUNCTIONS, type Fn } from '../core/taxonomy.js';
import { C } from './render.js';
import { parseArgs, die } from './args.js';

const args = parseArgs(process.argv.slice(2));
const db = open(typeof args.db === 'string' ? args.db : undefined);

if (typeof args.check === 'string' || typeof args.add === 'string') {
  const text = String(args.check ?? args.add);
  const hits = detectReuse(db, text);
  console.log('');
  console.log(`${C.cyan}${text}${C.reset}`);
  console.log('');
  if (hits.length === 0) {
    console.log(`${C.red}没有复用任何库里的词块${C.reset}`);
    console.log(`${C.gray}铁律：每条自己写的推文，至少复用 2 个词块。不复用的语料库是坟场。${C.reset}`);
  } else {
    const col = hits.length >= 2 ? C.green : C.yellow;
    console.log(`${col}复用了 ${hits.length} 个词块${hits.length >= 2 ? ' ✓' : '（还差 ' + (2 - hits.length) + ' 个）'}${C.reset}`);
    for (const h of hits) console.log(`  ${C.green}${h.text}${C.reset}  ${C.gray}[${h.fn}]${C.reset}`);
  }
  if (typeof args.add === 'string') {
    saveComposition(db, `comp_${Date.now()}`, text, !!args.posted);
    console.log(`\n${C.gray}已存入语料库${C.reset}`);
  }
  console.log('');
  process.exit(0);
}

const fn = typeof args.fn === 'string' ? (args.fn as Fn) : undefined;
if (fn && !FUNCTIONS.includes(fn)) {
  die(`未知功能「${fn}」。可选：${FUNCTIONS.join(' / ')}`);
}

const chunks = chunksByFn(db, fn);
const frames = framesByFn(db, fn);

console.log('');
if (frames.length > 0) {
  console.log(`${C.bold}句型骨架${C.reset} ${C.gray}${frames.length}${C.reset}`);
  let cur = '';
  for (const f of frames) {
    if (f.fn !== cur) {
      cur = f.fn;
      console.log(`\n  ${C.gray}── ${cur} ──${C.reset}`);
    }
    console.log(`  ${C.yellow}${f.pattern}${C.reset}`);
    console.log(`    ${C.gray}${f.gloss_zh}${C.reset}`);
  }
  console.log('');
}
if (chunks.length > 0) {
  console.log(`${C.bold}词块${C.reset} ${C.gray}${chunks.length}${C.reset}`);
  let cur = '';
  for (const c of chunks) {
    if (c.fn !== cur) {
      cur = c.fn;
      console.log(`\n  ${C.gray}── ${cur} ──${C.reset}`);
    }
    console.log(`  ${C.green}${c.text}${C.reset}  ${C.gray}${c.gloss_zh}${C.reset}`);
    console.log(`    ${C.dim}${c.example}${C.reset}`);
  }
  console.log('');
}
if (chunks.length === 0 && frames.length === 0) {
  console.log(`${C.gray}语料库是空的。先生成几张卡片：npm run card -- --file data/seed/tweets.json --index 0${C.reset}\n`);
}
