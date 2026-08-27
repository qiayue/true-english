import type { Category, Fn, Leak, Verdict } from './taxonomy.js';

/** 一条原始推文 */
export interface Tweet {
  id: string;
  text: string;
  author?: string;
  url?: string;
  capturedAt: string;
}

/** 难度评估结果 —— 服务于「90% 法则」 */
export interface Difficulty {
  level: 1 | 2 | 3 | 4 | 5;
  words: number;
  sentences: number;
  /** 已知词占比。90% 法则：低于 0.9 直接判为不可用 */
  coverage: number;
  /** 超出词频阈值的生词 */
  rareWords: string[];
  /** 结构性问题：需要外部语境、标题体、meme、俚语过重等 */
  flags: string[];
  usable: boolean;
  reason: string;
}

/** 句型骨架 —— 把内容挖空只留结构 */
export interface Frame {
  pattern: string;
  fn: Fn;
  glossZh: string;
}

/** 词块 —— 语料库的最小单位。记词块，不记单词 */
export interface Chunk {
  text: string;
  fn: Fn;
  glossZh: string;
  /** 该词块在原推文里的实际用法 */
  example: string;
}

/** 每日卡片 */
export interface Card {
  id: string;
  tweet: Tweet;
  /** 中文意思 —— 学习者据此回译，看不到英文原文 */
  glossZh: string;
  frames: Frame[];
  chunks: Chunk[];
  difficulty: Difficulty;
  createdAt: string;
}

/** 学习者的回译 */
export interface Attempt {
  id: string;
  cardId: string;
  text: string;
  createdAt: string;
}

/** 一处差异 */
export interface DiffItem {
  mine: string;
  native: string;
  category: Category;
  verdict: Verdict;
  leak?: Leak;
  explainZh: string;
  /** 一句话的可复用规则 —— 这才是能带走的资产 */
  rule?: string;
}

/** 批改结果 */
export interface Review {
  attemptId: string;
  items: DiffItem[];
  /** 回译重合度：命中的意义单元 / 原文总意义单元 */
  overlap: { matched: number; total: number };
  leaks: Partial<Record<Leak, number>>;
  /** 写对的地方。必须有 —— 学习者需要知道什么该继续保持 */
  strengths: string[];
  verdictZh: string;
}
