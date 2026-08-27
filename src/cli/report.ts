/**
 * 学习报告 —— 个人错误模式分析。
 *
 * 这是整套系统里教材给不了的东西。每个人的错误只有 3-5 个固定模式，
 * 但学习者自己看不见它们，只有累积统计才能把它们显出来。
 *
 *   pnpm report [--db data/true-english.db]
 */
import { open, progress } from '../core/store.js';
import { LEAK_ZH, VERDICT_ZH, CATEGORY_ZH, type Leak, type Verdict, type Category } from '../core/taxonomy.js';
import { C } from './render.js';
import { parseArgs } from './args.js';

const SPARK = '▁▂▃▄▅▆▇█';
function sparkline(vals: number[]): string {
  if (vals.length === 0) return '';
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  return vals
    .map((v) => SPARK[Math.min(SPARK.length - 1, Math.floor(((v - lo) / span) * (SPARK.length - 1)))])
    .join('');
}

function bar(share: number, width = 24): string {
  return '█'.repeat(Math.max(1, Math.round(share * width)));
}

const args = parseArgs(process.argv.slice(2));
const db = open(typeof args.db === 'string' ? args.db : undefined);
const p = progress(db);

console.log('');
console.log(`${C.bold}━━━ 学习报告 ━━━${C.reset}`);
console.log('');

if (p.attempts === 0) {
  console.log(`${C.gray}还没有数据。先做几次回译：${C.reset}`);
  console.log(`${C.gray}  npm run diff -- --original "..." --attempt "..."${C.reset}\n`);
  process.exit(0);
}

console.log(`${C.bold}${p.attempts}${C.reset} 次回译  ${C.gray}·${C.reset}  ${C.bold}${p.compositions}${C.reset} 条仿写`);
console.log('');

// —— 指标一：回译重合度 ——
if (p.overlapTrend.length > 0) {
  const pcts = p.overlapTrend.map((t) => t.pct);
  const first = pcts[0]!;
  const last = pcts[pcts.length - 1]!;
  const avg = Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length);
  const arrow = last > first ? `${C.green}↗${C.reset}` : last < first ? `${C.red}↘${C.reset}` : '→';
  console.log(`${C.bold}回译重合度${C.reset}`);
  console.log(
    `  ${first}% ${arrow} ${last}%   ${C.gray}均值 ${avg}%${C.reset}   ${C.cyan}${sparkline(pcts)}${C.reset}`,
  );
  console.log(`  ${C.gray}阶段目标：从 ~40% 涨到 ~70%${C.reset}`);
  console.log('');
}

// —— 指标二：个人错误模式（核心）——
if (p.leaks.length > 0) {
  console.log(`${C.bold}你的错误模式${C.reset}  ${C.gray}修掉前 3 个，比背 500 个新词有用${C.reset}`);
  console.log('');
  p.leaks.slice(0, 5).forEach((l, i) => {
    const name = LEAK_ZH[l.leak as Leak] ?? l.leak;
    console.log(
      `  ${C.bold}${i + 1}. ${name}${C.reset}  ${C.gray}${l.count} 次${C.reset}  ` +
        `${C.red}${String(Math.round(l.share * 100)).padStart(3)}%${C.reset} ${C.red}${bar(l.share)}${C.reset}`,
    );
    for (const s of l.samples.slice(0, 3)) {
      console.log(`     ${C.red}${s.mine}${C.reset} ${C.gray}→${C.reset} ${C.cyan}${s.native}${C.reset}`);
    }
    console.log('');
  });
}

// —— 判定分布：反过来监控批改器有没有全盘标红 ——
if (p.verdicts.length > 0) {
  const total = p.verdicts.reduce((s, v) => s + v.count, 0);
  const parts = p.verdicts.map((v) => {
    const name = VERDICT_ZH[v.verdict as Verdict] ?? v.verdict;
    const col = v.verdict === 'wrong' ? C.red : v.verdict === 'unnatural' ? C.yellow : C.green;
    return `${col}${name} ${v.count}${C.reset}`;
  });
  console.log(`${C.bold}判定分布${C.reset}  ${parts.join(`  ${C.gray}·${C.reset}  `)}`);
  const equal = p.verdicts.find((v) => v.verdict === 'equal')?.count ?? 0;
  if (total > 12 && equal === 0) {
    console.log(`  ${C.yellow}⚠ 一条 equal 都没有 —— 批改器可能在把「不同」误判成「错」${C.reset}`);
  }
  console.log('');
}

if (p.categories.length > 0) {
  const parts = p.categories.map((c) => `${CATEGORY_ZH[c.category as Category] ?? c.category} ${c.count}`);
  console.log(`${C.bold}差异类别${C.reset}  ${C.gray}${parts.join('  ·  ')}${C.reset}`);
  console.log('');
}

// —— 指标三：词块复用率 ——
if (p.compositions > 0) {
  const pct = Math.round(p.reuseRate * 100);
  const col = pct >= 70 ? C.green : pct >= 40 ? C.yellow : C.red;
  console.log(`${C.bold}词块复用率${C.reset}  ${col}${pct}%${C.reset} ${C.gray}的仿写用上了 ≥2 个库里的词块${C.reset}`);
  if (pct < 70) console.log(`  ${C.gray}铁律：不复用的语料库是坟场。每条仿写至少用 2 个。${C.reset}`);
  console.log('');
}

if (p.topRules.length > 0) {
  console.log(`${C.bold}反复踩的规则${C.reset}`);
  for (const r of p.topRules) {
    console.log(`  ${C.yellow}×${r.count}${C.reset}  ${r.rule}`);
  }
  console.log('');
}
