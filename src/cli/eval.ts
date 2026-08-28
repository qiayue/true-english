import './silence.js';
/**
 * 批改引擎评测。
 *
 * 这是判断两件事的唯一客观依据：
 *   1. prompt 改动是好是坏 —— 改之前跑一遍，改完再跑一遍，对比通过率
 *   2. **该用哪个模型** —— 同一套用例分别跑几个模型，让数字说话，
 *      不要拿单个翻译样本的观感做决定（知道价格再看质量，人是有偏的）
 *
 *   pnpm eval                                        用设置里的批改模型（没单配就是默认模型）
 *   pnpm eval -- --model anthropic/claude-sonnet-4.5 临时换一个模型
 *   pnpm eval -- --model a,b,c                       几个模型逐个跑，最后出对比表
 *   pnpm eval -- --only <case-id> --verbose
 */
import fs from 'node:fs';
import { review } from '../core/review.js';
import type { ReviewOut } from '../core/schema.js';
import { C } from './render.js';
import { parseArgs, die } from './args.js';
import { loadConfig, configFor } from '../core/settings.js';
import { open, DEFAULT_DB } from '../core/store.js';
import { ConfigError, type Usage } from '../core/llm.js';

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

// ─────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
const db = open(typeof args.db === 'string' ? args.db : DEFAULT_DB);
const CONFIG = loadConfig(db);
// 评测评的是批改，所以默认用「批改模型」（没单独配就是默认模型）
const REVIEW_MODEL = configFor(db, 'review').model;
const cases: Case[] = JSON.parse(fs.readFileSync('evals/cases.json', 'utf8'));
const todo = typeof args.only === 'string' ? cases.filter((c) => c.id === args.only) : cases;
if (todo.length === 0) die(`没有匹配的用例：${args.only}`);

const models = (typeof args.model === 'string' ? args.model.split(',') : [REVIEW_MODEL])
  .map((m) => m.trim())
  .filter(Boolean);
if (models.length === 0) {
  die('还没有选模型。打开「设置」配一个，或者 pnpm eval -- --model <模型ID>');
}

const limit = Number(args.concurrency ?? 4);

interface CaseResult {
  c: Case;
  fails: string[];
  warns: string[];
  err?: string;
  r?: ReviewOut;
  ms: number;
  usage: { prompt: number; completion: number; cost: number; hasCost: boolean };
}

interface SuiteStat {
  model: string;
  pass: number;
  total: number;
  warns: number;
  wallMs: number;
  avgMs: number;
  prompt: number;
  completion: number;
  cost: number;
  hasCost: boolean;
}

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const fmtCost = (has: boolean, c: number) => (has ? `$${c.toFixed(4)}` : '—');

/** 逐条即时输出 —— 十几个网络请求要跑好几分钟，攒到最后一起打等于假死 */
function printCase(x: CaseResult, verbose: boolean) {
  const meta =
    `${C.gray}${(x.ms / 1000).toFixed(1)}s` +
    `  ${fmtTokens(x.usage.prompt)}→${fmtTokens(x.usage.completion)}` +
    (x.usage.hasCost ? `  $${x.usage.cost.toFixed(4)}` : '') +
    C.reset;
  if (x.err) {
    console.log(`${C.red}✗${C.reset} ${C.bold}${x.c.id}${C.reset}  ${meta}  ${C.red}${x.err}${C.reset}`);
    return;
  }
  const ok = x.fails.length === 0;
  console.log(
    `${ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`} ${C.bold}${x.c.id}${C.reset}` +
      `  ${meta}  ${C.gray}${x.c.note}${C.reset}`,
  );
  for (const f of x.fails) console.log(`   ${C.red}· ${f}${C.reset}`);
  for (const w of x.warns) console.log(`   ${C.yellow}⚠ ${w}${C.reset}`);
  if (x.r && (verbose || !ok)) {
    for (const it of x.r.items) {
      console.log(
        `   ${C.gray}[${it.category}${it.leak ? '/' + it.leak : ''}/${it.verdict}]${C.reset} ` +
          `${C.red}${it.mine}${C.reset} ${C.gray}→${C.reset} ${C.cyan}${it.native}${C.reset}`,
      );
    }
  }
}

async function runSuite(model: string): Promise<SuiteStat> {
  const config = { ...CONFIG, model };
  const results: CaseResult[] = [];
  const t0 = Date.now();

  async function runOne(c: Case) {
    const usage = { prompt: 0, completion: 0, cost: 0, hasCost: false };
    const onUsage = (u: Usage) => {
      usage.prompt += u.prompt;
      usage.completion += u.completion;
      if (typeof u.cost === 'number') { usage.cost += u.cost; usage.hasCost = true; }
    };
    const start = Date.now();
    let x: CaseResult;
    try {
      const r = await review({ original: c.original, attempt: c.attempt, glossZh: c.glossZh }, config, onUsage);
      x = { c, r, ms: Date.now() - start, usage, ...check(c, r) };
    } catch (e) {
      if (e instanceof ConfigError) throw e;
      x = { c, fails: [], warns: [], ms: Date.now() - start, usage,
            err: e instanceof Error ? e.message : String(e) };
    }
    results.push(x);
    printCase(x, args.verbose === true);
  }

  const queue = [...todo];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let c = queue.shift(); c; c = queue.shift()) await runOne(c);
    }),
  );

  const pass = results.filter((x) => !x.err && x.fails.length === 0).length;
  return {
    model,
    pass,
    total: results.length,
    warns: results.reduce((n, x) => n + x.warns.length, 0),
    wallMs: Date.now() - t0,
    avgMs: results.reduce((n, x) => n + x.ms, 0) / Math.max(1, results.length),
    prompt: results.reduce((n, x) => n + x.usage.prompt, 0),
    completion: results.reduce((n, x) => n + x.usage.completion, 0),
    cost: results.reduce((n, x) => n + x.usage.cost, 0),
    hasCost: results.some((x) => x.usage.hasCost),
  };
}

console.log(`\n${C.bold}批改引擎评测${C.reset}  ${C.gray}${todo.length} 条用例 · ${CONFIG.baseUrl} · 并发 ${limit}${C.reset}`);

const stats: SuiteStat[] = [];
try {
  for (const model of models) {
    console.log(`\n${C.cyan}── ${model} ──${C.reset}`);
    stats.push(await runSuite(model));
    const s = stats[stats.length - 1]!;
    console.log(
      `\n${C.bold}${s.pass}/${s.total}${C.reset} 通过` +
        (s.warns > 0 ? `  ${C.yellow}${s.warns} 条空话警告${C.reset}` : '') +
        `  ${C.gray}${(s.wallMs / 1000).toFixed(0)}s · ${fmtTokens(s.prompt)}→${fmtTokens(s.completion)} tokens` +
        (s.hasCost ? ` · 共 $${s.cost.toFixed(4)}` : '') + C.reset,
    );
  }
} catch (e) {
  if (e instanceof ConfigError) die(e.message);
  throw e;
}

// 多模型对比表 —— 这一张表就是「该用哪个」的答案
if (stats.length > 1) {
  const w = Math.max(...stats.map((s) => s.model.length)) + 2;
  console.log(`\n${C.bold}模型对比${C.reset}`);
  console.log(C.gray + '模型'.padEnd(w) + '通过     空话   秒/条    tokens/条      整套费用' + C.reset);
  for (const s of stats) {
    const perP = Math.round(s.prompt / Math.max(1, s.total));
    const perC = Math.round(s.completion / Math.max(1, s.total));
    console.log(
      s.model.padEnd(w) +
        `${s.pass}/${s.total}`.padEnd(9) +
        String(s.warns).padEnd(7) +
        (s.avgMs / 1000).toFixed(1).padEnd(9) +
        `${fmtTokens(perP)}→${fmtTokens(perC)}`.padEnd(15) +
        fmtCost(s.hasCost, s.cost),
    );
  }
  console.log(`${C.gray}通过率同档时，选便宜的那个 —— 批改是天天跑的。${C.reset}`);
}

console.log('');
process.exit(stats.every((s) => s.pass === s.total) ? 0 : 1);
