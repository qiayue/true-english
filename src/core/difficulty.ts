import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Difficulty } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FREQ_PATH = path.resolve(here, '../../data/freq/en_top25k.txt');
const DOMAIN_PATH = path.resolve(here, '../../data/freq/domain.txt');

let rankCache: Map<string, number> | null = null;
let domainCache: Set<string> | null = null;

function ranks(): Map<string, number> {
  if (rankCache) return rankCache;
  const m = new Map<string, number>();
  const lines = fs.readFileSync(FREQ_PATH, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const w = lines[i]?.trim();
    if (w) m.set(w, i + 1);
  }
  rankCache = m;
  return m;
}

/**
 * 领域补充词表。
 *
 * 通用词频表是从电影对白统计的，覆盖不到本项目刻意选取的推文题材
 * （工作 / 软件 / 产品 / 想法）。纯靠词频秩无法分离：
 * productive 秩 11269（学习者认识）和 inflation 秩 14466（学习者未必认识）
 * 是交错的，抬高阈值只会同时放进两者。所以必须分层。
 */
function domain(): Set<string> {
  if (domainCache) return domainCache;
  const s = new Set<string>();
  for (const line of fs.readFileSync(DOMAIN_PATH, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    for (const w of t.split(/\s+/)) s.add(w.toLowerCase());
  }
  domainCache = s;
  return s;
}

/**
 * 「已知词」的词频秩阈值。
 *
 * 8000 是对这份对白语料校准出来的基线，不是通用真理。
 * 真正正确的做法是**按学习者本人**来定 —— 见 ScoreOptions.extraKnown：
 * app 记录他实际点开查词的那些词，反过来精修他的个人已知词集合。
 * 难度过滤器应该学习这个人的词汇量，而不是套一张固定表。
 */
const DEFAULT_KNOWN_RANK = 8000;

export interface ScoreOptions {
  /** 覆盖默认词频秩阈值 */
  knownRank?: number;
  /** 该学习者的个人已知词（未来由 app 的查词记录反推得出） */
  extraKnown?: Set<string>;
}

const CONTRACTION_TAILS = new Set([
  's', 't', 're', 've', 'll', 'd', 'm',
]);

/** 切词：小写、去标点，缩写按整体和词干双重尝试 */
function tokenize(text: string): string[] {
  return text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[""'']/g, "'")
    .split(/[^A-Za-z'’-]+/)
    .map((t) => t.replace(/^['-]+|['-]+$/g, '').toLowerCase())
    .filter((t) => t.length > 0);
}

function isKnown(
  token: string,
  r: Map<string, number>,
  limit: number,
  extra: Set<string>,
): boolean {
  if (extra.has(token) || domain().has(token)) return true;
  const rank = r.get(token);
  if (rank !== undefined && rank <= limit) return true;

  // 缩写：don't / I'm / they're —— 词表里可能只收了词干
  if (token.includes("'")) {
    const [stem, tail] = token.split("'");
    if (stem && CONTRACTION_TAILS.has(tail ?? '')) {
      if (extra.has(stem) || domain().has(stem)) return true;
      const sr = r.get(stem);
      if (sr !== undefined && sr <= limit) return true;
    }
  }

  // 常见派生前缀：rewriting -> writing -> write
  for (const prefix of ['re', 'un', 'over', 'under', 'mis', 'pre'] as const) {
    if (token.length > prefix.length + 3 && token.startsWith(prefix)) {
      if (isKnown(token.slice(prefix.length), r, limit, extra)) return true;
    }
  }

  // 规则屈折：复数 / 过去式 / 进行式 / 比较级，词干在表内就算认识
  for (const [suffix, cut] of [
    ['ies', 3], ['es', 2], ['s', 1],
    ['ing', 3], ['ed', 2], ['er', 2], ['est', 3], ['ly', 2],
  ] as const) {
    if (token.length > cut + 2 && token.endsWith(suffix)) {
      const bases = [token.slice(0, -cut)];
      if (suffix === 'ies') bases.push(token.slice(0, -3) + 'y');
      if (suffix === 'ing' || suffix === 'ed') bases.push(token.slice(0, -cut) + 'e');
      for (const b of bases) {
        if (extra.has(b) || domain().has(b)) return true;
        const br = r.get(b);
        if (br !== undefined && br <= limit) return true;
      }
    }
  }
  return false;
}

/** 专有名词不算词汇负担 —— 人名地名品牌名不影响读懂句子结构 */
function properNouns(text: string): Set<string> {
  const out = new Set<string>();
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    const words = s.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const w = words[i]?.replace(/[^A-Za-z']/g, '') ?? '';
      // 句首首字母大写不算证据，句中才算
      if (i > 0 && /^[A-Z][a-z]+$/.test(w)) out.add(w.toLowerCase());
    }
  }
  return out;
}

function countSentences(text: string): number {
  const n = text.split(/[.!?]+[\s"')\]]|[.!?]+$/).filter((s) => s.trim().length > 0).length;
  return Math.max(1, n);
}

/**
 * 结构性排除项 —— 这些推文无论多简单都不该拿来练。
 * 选材失败是学习者弃坑的头号原因，宁可漏掉好材料，不要放进坏材料。
 */
function structuralFlags(text: string): string[] {
  const flags: string[] = [];
  const words = text.trim().split(/\s+/);

  if (/https?:\/\//.test(text)) flags.push('含链接：内容依赖打不开的外部语境');
  if (/^@\w/.test(text.trim())) flags.push('回复推：缺少上文');
  if ((text.match(/@\w+/g) ?? []).length >= 2) flags.push('多个 @ 提及：可能是圈内对话');
  if ((text.match(/#\w+/g) ?? []).length >= 3) flags.push('话题标签过多');

  const emoji = (text.match(/\p{Extended_Pictographic}/gu) ?? []).length;
  if (emoji >= 4 || (words.length > 0 && emoji / words.length > 0.2)) {
    flags.push('emoji 占比过高');
  }

  const caps = words.filter((w) => /^[A-Z]{3,}$/.test(w.replace(/[^A-Za-z]/g, '')));
  if (caps.length >= 2) flags.push('大量全大写：可能是标题体或强喊话');

  // 开头就用外指代词，指向的是引用的那条推，不是自己
  if (/^(this|that|these|those|it)\b/i.test(text.trim()) && countSentences(text) <= 1) {
    flags.push('以外指代词开头：多半在评论另一条推');
  }

  if (words.length < 5) flags.push('太短：不足以构成完整表达单元');
  if (words.length > 90) flags.push('太长：超出单条卡片的处理量');

  return flags;
}

/**
 * 90% 法则打分器。纯机械计算，不调用 LLM。
 *
 * 核心判定：不查词典能看懂 90% 的推文才可用。
 * 初学者的直觉是反的 —— 总想挑「看起来高级」的句子，
 * 但学写作要的是能立刻据为己有的句子，不是能仰望的句子。
 */
export function scoreDifficulty(text: string, opts: ScoreOptions = {}): Difficulty {
  const limit = opts.knownRank ?? DEFAULT_KNOWN_RANK;
  const extra = opts.extraKnown ?? new Set<string>();
  const r = ranks();
  const proper = properNouns(text);
  const tokens = tokenize(text);

  const rare: string[] = [];
  let known = 0;
  for (const t of tokens) {
    if (/^\d+$/.test(t) || proper.has(t) || isKnown(t, r, limit, extra)) known++;
    else rare.push(t);
  }

  const words = tokens.length;
  const coverage = words === 0 ? 0 : known / words;
  const sentences = countSentences(text);
  const flags = structuralFlags(text);

  let level: Difficulty['level'];
  if (words <= 15 && sentences <= 1 && coverage >= 0.98) level = 1;
  else if (words <= 30 && sentences <= 2 && coverage >= 0.95) level = 2;
  else if (words <= 50 && sentences <= 4 && coverage >= 0.92) level = 3;
  else if (words <= 80 && coverage >= 0.9) level = 4;
  else level = 5;

  const belowRule = coverage < 0.9;
  const usable = !belowRule && flags.length === 0;

  const problems: string[] = [];
  if (belowRule) {
    problems.push(
      `生词率过高（已知词 ${(coverage * 100).toFixed(0)}% < 90%）：` +
        `${[...new Set(rare)].slice(0, 6).join(', ')}`,
    );
  }
  problems.push(...flags);

  const reason =
    problems.length > 0
      ? problems.join('；')
      : `可用 · L${level} · ${words} 词 / ${sentences} 句 / 已知词 ${(coverage * 100).toFixed(0)}%`;

  return {
    level,
    words,
    sentences,
    coverage: Number(coverage.toFixed(4)),
    rareWords: [...new Set(rare)],
    flags,
    usable,
    reason,
  };
}

/** 按学习阶段筛选：阶段一只用单句，阶段二 3-4 句，阶段三 thread */
export function fitsStage(d: Difficulty, stage: 1 | 2 | 3): boolean {
  if (!d.usable) return false;
  if (stage === 1) return d.sentences <= 1 && d.level <= 2;
  if (stage === 2) return d.sentences >= 2 && d.sentences <= 4 && d.level <= 3;
  return d.level <= 4;
}
