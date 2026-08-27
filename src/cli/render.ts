import { CATEGORY_ZH, LEAK_ZH, VERDICT_ZH, type Verdict } from '../core/taxonomy.js';
import type { ReviewOut } from '../core/schema.js';
import type { Card, Difficulty } from '../core/types.js';

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

const VERDICT_COLOR: Record<Verdict, string> = {
  wrong: C.red,
  unnatural: C.yellow,
  equal: C.green,
};

/** CJK 字符占两列，换行时必须按显示宽度算，不能按字符数 */
function width(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    w +=
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
        ? 2
        : 1;
  }
  return w;
}

function wrap(text: string, max: number, indent: string): string[] {
  const out: string[] = [];
  let line = '';
  const flush = () => {
    if (line) out.push(indent + line);
    line = '';
  };
  // 中文按字断行，英文按词断行
  const parts = text.match(/[A-Za-z0-9'’.,;:!?()\-–—/]+|\s+|[^\s]/g) ?? [];
  for (const p of parts) {
    if (/^\s+$/.test(p)) {
      if (line) line += ' ';
      continue;
    }
    if (width(line) + width(p) > max) flush();
    line += p;
  }
  flush();
  return out;
}

const W = 76;

export function renderReview(r: ReviewOut, original: string, attempt: string): string {
  const L: string[] = [];
  const pct = r.overlap.total > 0 ? Math.round((r.overlap.matched / r.overlap.total) * 100) : 0;
  const pctColor = pct >= 70 ? C.green : pct >= 45 ? C.yellow : C.red;

  L.push('');
  L.push(`${C.bold}━━━ 批改结果 ━━━${C.reset}`);
  L.push('');
  L.push(`${C.gray}原文${C.reset}    ${C.cyan}${original}${C.reset}`);
  L.push(`${C.gray}你写的${C.reset}  ${C.red}${attempt}${C.reset}`);
  L.push('');
  L.push(
    `${C.gray}回译重合度${C.reset}  ${pctColor}${C.bold}${pct}%${C.reset}` +
      ` ${C.gray}(${r.overlap.matched}/${r.overlap.total} 意义单元)${C.reset}`,
  );

  // 硬伤汇总 —— 这是喂给个人错误模式统计的数据
  const leaks = new Map<string, number>();
  for (const it of r.items) {
    if (it.leak) leaks.set(it.leak, (leaks.get(it.leak) ?? 0) + 1);
  }
  if (leaks.size > 0) {
    const s = [...leaks.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${LEAK_ZH[k as keyof typeof LEAK_ZH]} ×${v}`)
      .join('  ');
    L.push(`${C.gray}硬伤${C.reset}        ${C.red}${s}${C.reset}`);
  }
  L.push('');

  r.items.forEach((it, i) => {
    const vc = VERDICT_COLOR[it.verdict];
    L.push(
      `${C.bold}${String(i + 1).padStart(2)}${C.reset}  ` +
        `${C.gray}${CATEGORY_ZH[it.category]}${C.reset}` +
        `${it.leak ? `${C.gray}·${LEAK_ZH[it.leak]}${C.reset}` : ''}` +
        `  ${vc}${VERDICT_ZH[it.verdict]}${C.reset}`,
    );
    L.push(`    ${C.gray}你 ${C.reset}${C.red}${it.mine}${C.reset}`);
    L.push(`    ${C.gray}原 ${C.reset}${C.cyan}${it.native}${C.reset}`);
    for (const ln of wrap(it.explainZh, W - 7, '       ')) L.push(`${C.dim}${ln}${C.reset}`);
    if (it.rule) {
      for (const ln of wrap(`规则 · ${it.rule}`, W - 7, '       ')) {
        L.push(`${C.yellow}${ln}${C.reset}`);
      }
    }
    L.push('');
  });

  if (r.strengths.length > 0) {
    L.push(`${C.green}${C.bold}✓ 做对的地方${C.reset}`);
    for (const s of r.strengths) {
      for (const ln of wrap(`· ${s}`, W - 4, '    ')) L.push(`${C.green}${ln}${C.reset}`);
    }
    L.push('');
  }

  L.push(`${C.bold}总评${C.reset}`);
  for (const ln of wrap(r.verdictZh, W - 4, '    ')) L.push(ln);
  L.push('');
  return L.join('\n');
}

export function renderDifficulty(text: string, d: Difficulty): string {
  const L: string[] = [];
  const mark = d.usable ? `${C.green}可用${C.reset}` : `${C.red}不可用${C.reset}`;
  L.push('');
  L.push(`${C.cyan}${text}${C.reset}`);
  L.push('');
  L.push(
    `${mark}  ${C.gray}L${d.level}  ${d.words} 词 / ${d.sentences} 句  ` +
      `已知词 ${(d.coverage * 100).toFixed(0)}%${C.reset}`,
  );
  if (d.rareWords.length > 0) {
    L.push(`${C.gray}生词  ${C.yellow}${d.rareWords.join(', ')}${C.reset}`);
  }
  for (const f of d.flags) L.push(`${C.red}⚠ ${f}${C.reset}`);
  L.push('');
  return L.join('\n');
}

export function renderCard(card: Card): string {
  const L: string[] = [];
  L.push('');
  L.push(`${C.bold}━━━ 今日卡片 ━━━${C.reset}`);
  L.push('');
  L.push(`${C.gray}中文意思（据此回译，先别看英文）${C.reset}`);
  for (const ln of wrap(card.glossZh, W - 4, '    ')) L.push(`${C.bold}${ln}${C.reset}`);
  L.push('');
  L.push(`${C.gray}——— 对答案后再看下面 ———${C.reset}`);
  L.push('');
  L.push(`${C.gray}原推${C.reset}`);
  for (const ln of wrap(card.tweet.text, W - 4, '    ')) L.push(`${C.cyan}${ln}${C.reset}`);
  L.push('');
  if (card.frames.length > 0) {
    L.push(`${C.bold}句型骨架${C.reset}`);
    for (const f of card.frames) {
      L.push(`    ${C.yellow}${f.pattern}${C.reset}`);
      L.push(`    ${C.gray}[${f.fn}] ${f.glossZh}${C.reset}`);
    }
    L.push('');
  }
  if (card.chunks.length > 0) {
    L.push(`${C.bold}词块${C.reset}`);
    for (const c of card.chunks) {
      L.push(`    ${C.green}${c.text}${C.reset}  ${C.gray}[${c.fn}] ${c.glossZh}${C.reset}`);
      L.push(`      ${C.dim}${c.example}${C.reset}`);
    }
    L.push('');
  }
  L.push(`${C.gray}${card.difficulty.reason}${C.reset}`);
  L.push('');
  return L.join('\n');
}

export { C };
