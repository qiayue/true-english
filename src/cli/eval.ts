/**
 * 批改引擎评测。
 *
 * 这是判断 prompt 改动是好是坏的唯一客观依据。
 * 改 prompt 之前先跑一遍，改完再跑一遍，对比通过率。
 *
 *   pnpm eval [--only <case-id>] [--concurrency 4]
 */
import fs from 'node:fs';
import { review } from '../core/review.js';
import type { ReviewOut } from '../core/schema.js';
import { C } from './render.js';
import { parseArgs, die } from './args.js';
import { MissingKeyError } from '../core/llm.js';

interface Expect {
  categories?: string[];
  leaks?: string[];
  hasWrong?: boolean;
  noWrong?: boolean;
  hasEqual?: boolean;
}
interface Case {
  id: string;
  note: string;
  original: string;
  glossZh: string;
  attempt: string;
  expect: Expect;
}

/** 空话黑名单 —— 解释里出现这些说明 prompt 在往「正确的废话」漂移 */
const FILLER = ['不够地道', '表达生硬', '略显生硬', '建议使用更', '不太自然', '更为妥当'];

function check(c: Case, r: ReviewOut): { fails: string[]; warns: string[] } {
  const fails: string[] = [];
  const warns: string[] = [];
  const cats = new Set(r.items.map((i) => i.category));
  const leaks = new Set(r.items.map((i) => i.leak).filter(Boolean));
  const verdicts = r.items.map((i) => i.verdict);

  for (const want of c.expect.categories ?? []) {
    if (!cats.has(want as never)) fails.push(`没找到 ${want} 类差异`);
  }
  for (const want of c.expect.leaks ?? []) {
    if (!leaks.has(want as never)) fails.push(`没标出硬伤 ${want}`);
  }
  if (c.expect.hasWrong && !verdicts.includes('wrong')) fails.push('该判 wrong 却一条都没有');
  if (c.expect.noWrong && verdicts.includes('wrong')) {
    fails.push(`不该判 wrong 却判了 ${verdicts.filter((v) => v === 'wrong').length} 条`);
  }
  if (c.expect.hasEqual && !verdicts.includes('equal')) {
    fails.push('该敢给 equal 却一条都没有');
  }
  if (r.strengths.length === 0) fails.push('strengths 为空 —— 必须点名学习者做对了什么');

  for (const it of r.items) {
    for (const f of FILLER) {
      if (it.explainZh.includes(f)) warns.push(`解释里出现空话「${f}」: ${it.explainZh.slice(0, 40)}…`);
    }
  }
  return { fails, warns };
}

const args = parseArgs(process.argv.slice(2));
const cases: Case[] = JSON.parse(fs.readFileSync('evals/cases.json', 'utf8'));
const todo = typeof args.only === 'string' ? cases.filter((c) => c.id === args.only) : cases;
if (todo.length === 0) die(`没有匹配的用例：${args.only}`);

const limit = Number(args.concurrency ?? 4);
const results: { c: Case; fails: string[]; warns: string[]; err?: string; r?: ReviewOut }[] = [];

async function runOne(c: Case) {
  try {
    const r = await review({ original: c.original, attempt: c.attempt, glossZh: c.glossZh });
    results.push({ c, r, ...check(c, r) });
  } catch (e) {
    if (e instanceof MissingKeyError) throw e;
    results.push({ c, fails: [], warns: [], err: e instanceof Error ? e.message : String(e) });
  }
}

try {
  const queue = [...todo];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let c = queue.shift(); c; c = queue.shift()) await runOne(c);
    }),
  );
} catch (e) {
  if (e instanceof MissingKeyError) die(e.message);
  throw e;
}

results.sort((a, b) => todo.indexOf(a.c) - todo.indexOf(b.c));

let pass = 0;
let warnCount = 0;
console.log('');
for (const { c, fails, warns, err, r } of results) {
  if (err) {
    console.log(`${C.red}✗${C.reset} ${c.id}  ${C.red}${err}${C.reset}`);
    continue;
  }
  const ok = fails.length === 0;
  if (ok) pass++;
  warnCount += warns.length;
  console.log(
    `${ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`} ${C.bold}${c.id}${C.reset}` +
      `  ${C.gray}${c.note}${C.reset}`,
  );
  for (const f of fails) console.log(`   ${C.red}· ${f}${C.reset}`);
  for (const w of warns) console.log(`   ${C.yellow}⚠ ${w}${C.reset}`);
  if (r && (args.verbose || !ok)) {
    for (const it of r.items) {
      console.log(
        `   ${C.gray}[${it.category}${it.leak ? '/' + it.leak : ''}/${it.verdict}]${C.reset} ` +
          `${C.red}${it.mine}${C.reset} ${C.gray}→${C.reset} ${C.cyan}${it.native}${C.reset}`,
      );
    }
  }
}
console.log(
  `\n${C.bold}${pass}/${results.length}${C.reset} 通过` +
    (warnCount > 0 ? `  ${C.yellow}${warnCount} 条空话警告${C.reset}` : '') +
    '\n',
);
process.exit(pass === results.length ? 0 : 1);
