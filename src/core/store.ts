import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { Card, Attempt } from './types.js';
import type { ReviewOut } from './schema.js';
import type { Fn, Leak } from './taxonomy.js';

/**
 * 语料库 —— 按「功能」索引，不按话题索引。
 *
 * 写作时大脑发出的检索请求是「我现在想礼貌地表示不同意」，
 * 不是「我想找一个关于科技的词」。按话题建的库检索不到，等于坟场。
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tweets (
  id TEXT PRIMARY KEY, text TEXT NOT NULL, author TEXT, url TEXT, captured_at TEXT
);
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY, tweet_id TEXT NOT NULL, gloss_zh TEXT NOT NULL,
  level INTEGER, coverage REAL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL,
  idx INTEGER NOT NULL, gloss_zh TEXT NOT NULL, en TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS frames (
  id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL,
  pattern TEXT NOT NULL, fn TEXT NOT NULL, gloss_zh TEXT
);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL,
  text TEXT NOT NULL, fn TEXT NOT NULL, gloss_zh TEXT, example TEXT
);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY, card_id TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
  attempt_id TEXT PRIMARY KEY, matched INTEGER, total INTEGER,
  verdict_zh TEXT, strengths TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS diff_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL,
  mine TEXT, native TEXT, category TEXT NOT NULL, verdict TEXT NOT NULL,
  leak TEXT, explain_zh TEXT, rule TEXT
);
-- 步骤级练习进度。间隔重复的数据基础。
-- 原来 TRIES 只活在浏览器内存里，刷新就没 —— 于是「今天错三次的那一步，
-- 明后天再推给你」这件事根本无从谈起。
CREATE TABLE IF NOT EXISTS step_progress (
  card_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  box INTEGER NOT NULL DEFAULT 0,      -- Leitner 盒子，越高间隔越长
  due_at TEXT NOT NULL,
  last_tries INTEGER NOT NULL DEFAULT 0,
  last_at TEXT NOT NULL,
  total_attempts INTEGER NOT NULL DEFAULT 0,
  total_fails INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (card_id, idx)
);

-- 学习者自己写的推文（仿写）。铁律：每条至少复用 2 个词块
CREATE TABLE IF NOT EXISTS compositions (
  id TEXT PRIMARY KEY, text TEXT NOT NULL, posted INTEGER DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_steps_card ON steps(card_id, idx);
CREATE INDEX IF NOT EXISTS idx_progress_due ON step_progress(due_at);
CREATE INDEX IF NOT EXISTS idx_chunks_fn ON chunks(fn);
CREATE INDEX IF NOT EXISTS idx_frames_fn ON frames(fn);
CREATE INDEX IF NOT EXISTS idx_diff_leak ON diff_items(leak);
CREATE INDEX IF NOT EXISTS idx_diff_attempt ON diff_items(attempt_id);
`;

export const DEFAULT_DB = 'data/true-english.db';

export function open(file = DEFAULT_DB): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export function saveCard(db: DatabaseSync, card: Card): void {
  db.prepare(
    'INSERT OR REPLACE INTO tweets (id, text, author, url, captured_at) VALUES (?,?,?,?,?)',
  ).run(card.tweet.id, card.tweet.text, card.tweet.author ?? null, card.tweet.url ?? null, card.tweet.capturedAt);

  db.prepare(
    'INSERT OR REPLACE INTO cards (id, tweet_id, gloss_zh, level, coverage, created_at) VALUES (?,?,?,?,?,?)',
  ).run(card.id, card.tweet.id, card.glossZh, card.difficulty.level, card.difficulty.coverage, card.createdAt);

  db.prepare('DELETE FROM steps WHERE card_id = ?').run(card.id);
  const sIns = db.prepare('INSERT INTO steps (card_id, idx, gloss_zh, en) VALUES (?,?,?,?)');
  card.steps.forEach((st, i) => sIns.run(card.id, i, st.glossZh, st.en));

  db.prepare('DELETE FROM frames WHERE card_id = ?').run(card.id);
  db.prepare('DELETE FROM chunks WHERE card_id = ?').run(card.id);
  const fIns = db.prepare('INSERT INTO frames (card_id, pattern, fn, gloss_zh) VALUES (?,?,?,?)');
  for (const f of card.frames) fIns.run(card.id, f.pattern, f.fn, f.glossZh);
  const cIns = db.prepare('INSERT INTO chunks (card_id, text, fn, gloss_zh, example) VALUES (?,?,?,?,?)');
  for (const c of card.chunks) cIns.run(card.id, c.text, c.fn, c.glossZh, c.example);
}

export function stepsOf(db: DatabaseSync, cardId: string) {
  return db
    .prepare('SELECT idx, gloss_zh AS glossZh, en FROM steps WHERE card_id = ? ORDER BY idx')
    .all(cardId) as unknown as { idx: number; glossZh: string; en: string }[];
}

export function saveAttempt(db: DatabaseSync, a: Attempt): void {
  db.prepare('INSERT OR REPLACE INTO attempts (id, card_id, text, created_at) VALUES (?,?,?,?)').run(
    a.id, a.cardId, a.text, a.createdAt,
  );
}

export function saveReview(db: DatabaseSync, attemptId: string, r: ReviewOut): void {
  db.prepare(
    'INSERT OR REPLACE INTO reviews (attempt_id, matched, total, verdict_zh, strengths, created_at) VALUES (?,?,?,?,?,?)',
  ).run(attemptId, r.overlap.matched, r.overlap.total, r.verdictZh, JSON.stringify(r.strengths), new Date().toISOString());

  db.prepare('DELETE FROM diff_items WHERE attempt_id = ?').run(attemptId);
  const ins = db.prepare(
    'INSERT INTO diff_items (attempt_id, mine, native, category, verdict, leak, explain_zh, rule) VALUES (?,?,?,?,?,?,?,?)',
  );
  for (const it of r.items) {
    ins.run(attemptId, it.mine, it.native, it.category, it.verdict, it.leak ?? null, it.explainZh, it.rule ?? null);
  }
}

export interface StoredChunk {
  id: number;
  text: string;
  fn: Fn;
  gloss_zh: string;
  example: string;
}

/** 按功能检索词块 —— 这是语料库的主查询路径 */
export function chunksByFn(db: DatabaseSync, fn?: Fn): StoredChunk[] {
  const rows = fn
    ? db.prepare('SELECT id, text, fn, gloss_zh, example FROM chunks WHERE fn = ? ORDER BY id').all(fn)
    : db.prepare('SELECT id, text, fn, gloss_zh, example FROM chunks ORDER BY fn, id').all();
  return rows as unknown as StoredChunk[];
}

export function framesByFn(db: DatabaseSync, fn?: Fn) {
  const rows = fn
    ? db.prepare('SELECT id, pattern, fn, gloss_zh FROM frames WHERE fn = ? ORDER BY id').all(fn)
    : db.prepare('SELECT id, pattern, fn, gloss_zh FROM frames ORDER BY fn, id').all();
  return rows as unknown as { id: number; pattern: string; fn: Fn; gloss_zh: string }[];
}

/**
 * Leitner 盒子的间隔阶梯（小时）。
 *
 * 第 0 格是「当天再来一次」—— 刚栽过跟头的东西，隔一天就太久了。
 * 往上按大致翻倍走到 35 天。这不是精确的记忆曲线模型，
 * 但对一个每天练一条的人来说，精确到小时没有意义，能把
 * 「错得多的更早回来」这件事做对就够了。
 */
const BOX_HOURS = [8, 24, 72, 168, 384, 840];
export const MAX_BOX = BOX_HOURS.length - 1;

export interface StepOutcome {
  /** 这一步一共写了几次才对 */
  tries: number;
  /** 用过提示 */
  hinted: boolean;
  /** 用过「看着原文抄一遍」 */
  copied: boolean;
  /** 用「我这么写也对」跳过的 */
  accepted: boolean;
}

/**
 * 记一次步骤练习，并算出下次该什么时候回来。
 *
 * 升降级规则刻意简单：
 * - 一次就对、且没用提示 → 升一格
 * - 用了提示、或写了两三次才对 → 原地不动（记住了，但不牢）
 * - 抄过原文、或写了四次以上 → 打回第 0 格，当天再来
 * 「我也对」跳过的不参与升降 —— 那处到底算不算对还没判定，
 * 拿它去调间隔是在用没验证的信号做决策。
 */
export function recordStep(
  db: DatabaseSync,
  cardId: string,
  idx: number,
  o: StepOutcome,
  now = new Date(),
): { box: number; dueAt: string } {
  const prev = db
    .prepare('SELECT box, total_attempts AS a, total_fails AS f FROM step_progress WHERE card_id = ? AND idx = ?')
    .get(cardId, idx) as unknown as { box: number; a: number; f: number } | undefined;

  const oldBox = prev?.box ?? 0;
  let box: number;
  if (o.accepted) box = oldBox;
  else if (o.copied || o.tries >= 4) box = 0;
  else if (o.hinted || o.tries >= 2) box = oldBox;
  else box = Math.min(MAX_BOX, oldBox + 1);

  const dueAt = new Date(now.getTime() + BOX_HOURS[box]! * 3600_000).toISOString();
  db.prepare(
    `INSERT INTO step_progress (card_id, idx, box, due_at, last_tries, last_at, total_attempts, total_fails)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(card_id, idx) DO UPDATE SET
       box = excluded.box, due_at = excluded.due_at, last_tries = excluded.last_tries,
       last_at = excluded.last_at, total_attempts = excluded.total_attempts,
       total_fails = excluded.total_fails`,
  ).run(
    cardId, idx, box, dueAt, o.tries, now.toISOString(),
    (prev?.a ?? 0) + 1,
    (prev?.f ?? 0) + (o.tries > 1 || o.copied ? 1 : 0),
  );
  return { box, dueAt };
}

export interface TodayItem {
  cardId: string;
  glossZh: string;
  level: number;
  kind: 'review' | 'new';
  dueSteps: number;
  totalSteps: number;
  weakestBox: number | null;
}

/**
 * 今日队列：到期的复习 + 还没练过的新卡。
 *
 * 复习排在新卡前面。方法论里「回译重合度从 40% 涨到 70%」这个核心指标，
 * 只能靠重复同一批材料才涨得起来 —— 一直喂新卡，重合度永远停在第一次的水平。
 */
export interface TodayView {
  items: TodayItem[];
  /** 有卡片，但今天都不到期 —— 这是「练完了」，不是「出错了」 */
  cleared: boolean;
  /** 下一批复习什么时候到期 */
  nextDueAt: string | null;
  totalCards: number;
}

export function today(db: DatabaseSync, now = new Date(), newLimit = 3): TodayItem[] {
  const iso = now.toISOString();
  const rows = db
    .prepare(
      `SELECT c.id AS cardId, c.gloss_zh AS glossZh, c.level,
              (SELECT COUNT(*) FROM steps s WHERE s.card_id = c.id) AS totalSteps,
              (SELECT COUNT(*) FROM step_progress g WHERE g.card_id = c.id) AS practiced,
              (SELECT COUNT(*) FROM step_progress g WHERE g.card_id = c.id AND g.due_at <= ?) AS dueSteps,
              (SELECT MIN(box) FROM step_progress g WHERE g.card_id = c.id) AS weakestBox
       FROM cards c ORDER BY c.created_at DESC`,
    )
    .all(iso) as unknown as {
      cardId: string; glossZh: string; level: number;
      totalSteps: number; practiced: number; dueSteps: number; weakestBox: number | null;
    }[];

  const review: TodayItem[] = [];
  const fresh: TodayItem[] = [];
  for (const r of rows) {
    const base = { cardId: r.cardId, glossZh: r.glossZh, level: r.level,
                   totalSteps: r.totalSteps, weakestBox: r.weakestBox };
    if (r.practiced === 0) fresh.push({ ...base, kind: 'new', dueSteps: r.totalSteps });
    else if (r.dueSteps > 0) review.push({ ...base, kind: 'review', dueSteps: r.dueSteps });
  }
  // 最弱的先复习
  review.sort((a, b) => (a.weakestBox ?? 0) - (b.weakestBox ?? 0));
  return [...review, ...fresh.slice(0, newLimit)];
}

/**
 * 今日视图。
 *
 * 区分「还没有卡片」和「今天练完了」很重要 —— 后者是成就，前者是待办。
 * 两种都显示成一句灰色的「没有内容」，会把唯一一个值得庆祝的时刻抹掉。
 */
export function todayView(db: DatabaseSync, now = new Date(), newLimit = 3): TodayView {
  const items = today(db, now, newLimit);
  const totalCards = (db.prepare('SELECT COUNT(*) AS n FROM cards').get() as { n: number }).n;
  const next = db
    .prepare('SELECT MIN(due_at) AS d FROM step_progress WHERE due_at > ?')
    .get(now.toISOString()) as unknown as { d: string | null };
  return {
    items,
    cleared: items.length === 0 && totalCards > 0,
    nextDueAt: next?.d ?? null,
    totalCards,
  };
}

export function saveComposition(db: DatabaseSync, id: string, text: string, posted = false): void {
  db.prepare('INSERT OR REPLACE INTO compositions (id, text, posted, created_at) VALUES (?,?,?,?)').run(
    id, text, posted ? 1 : 0, new Date().toISOString(),
  );
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[""'']/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 检测一条仿写用上了库里哪些词块。纯机械匹配，不调 LLM。
 *
 * 词块里的占位符（X / Y / ___ / someone）当通配处理，
 * 因为 "I'd push back on that" 这类词块在实际使用时会被填入不同内容。
 */
export function detectReuse(db: DatabaseSync, text: string): StoredChunk[] {
  const hay = normalize(text);
  const hits: StoredChunk[] = [];
  for (const c of chunksByFn(db)) {
    const pat = normalize(c.text);
    if (!pat) continue;
    const placeholder = /\b(x|y|z|sth|something|someone|___+)\b/;
    if (placeholder.test(pat)) {
      // 占位符切成片段，片段全部出现就算命中
      const segs = pat.split(placeholder).map((s) => s.trim()).filter((s) => s.length >= 3);
      if (segs.length > 0 && segs.every((s) => hay.includes(s))) hits.push(c);
    } else if (hay.includes(pat)) {
      hits.push(c);
    }
  }
  return hits;
}

export interface LeakStat {
  leak: Leak;
  count: number;
  share: number;
  samples: { mine: string; native: string; explain: string }[];
}

export interface Progress {
  attempts: number;
  overlapTrend: { attemptId: string; pct: number; at: string }[];
  leaks: LeakStat[];
  categories: { category: string; count: number }[];
  verdicts: { verdict: string; count: number }[];
  compositions: number;
  reuseRate: number;
  topRules: { rule: string; count: number }[];
}

/**
 * 个人错误模式统计。
 *
 * 这是整套系统里教材给不了的东西：每个人的错误只有 3-5 个固定模式，
 * 修掉这几个比背 500 个新词有用得多。但学习者自己看不见这些模式，
 * 只有累积统计才能把它们显出来。
 */
export function progress(db: DatabaseSync): Progress {
  // 只统计已批改的回译。没有批改结果的 attempt 不算完成一次练习，
  // 计入的话「回译次数」和重合度趋势都会虚高。
  const attempts = (
    db
      .prepare('SELECT COUNT(*) AS n FROM attempts a JOIN reviews r ON r.attempt_id = a.id')
      .get() as { n: number }
  ).n;

  const overlapTrend = (
    db
      .prepare(
        `SELECT r.attempt_id AS attemptId, r.matched, r.total, r.created_at AS at
         FROM reviews r ORDER BY r.created_at`,
      )
      .all() as unknown as { attemptId: string; matched: number; total: number; at: string }[]
  ).map((r) => ({ attemptId: r.attemptId, pct: r.total > 0 ? Math.round((r.matched / r.total) * 100) : 0, at: r.at }));

  const leakRows = db
    .prepare('SELECT leak, COUNT(*) AS n FROM diff_items WHERE leak IS NOT NULL GROUP BY leak ORDER BY n DESC')
    .all() as unknown as { leak: Leak; n: number }[];
  const leakTotal = leakRows.reduce((s, r) => s + r.n, 0);
  const sampleStmt = db.prepare(
    'SELECT mine, native, explain_zh FROM diff_items WHERE leak = ? ORDER BY id DESC LIMIT 4',
  );
  const leaks: LeakStat[] = leakRows.map((r) => ({
    leak: r.leak,
    count: r.n,
    share: leakTotal > 0 ? r.n / leakTotal : 0,
    samples: (sampleStmt.all(r.leak) as unknown as { mine: string; native: string; explain_zh: string }[]).map((s) => ({
      mine: s.mine, native: s.native, explain: s.explain_zh,
    })),
  }));

  const categories = db
    .prepare('SELECT category, COUNT(*) AS count FROM diff_items GROUP BY category ORDER BY count DESC')
    .all() as unknown as { category: string; count: number }[];
  const verdicts = db
    .prepare('SELECT verdict, COUNT(*) AS count FROM diff_items GROUP BY verdict ORDER BY count DESC')
    .all() as unknown as { verdict: string; count: number }[];

  const comps = db.prepare('SELECT id, text FROM compositions').all() as unknown as { id: string; text: string }[];
  const withReuse = comps.filter((c) => detectReuse(db, c.text).length >= 2).length;

  const topRules = db
    .prepare(
      `SELECT rule, COUNT(*) AS count FROM diff_items
       WHERE rule IS NOT NULL AND rule <> '' GROUP BY rule ORDER BY count DESC LIMIT 5`,
    )
    .all() as unknown as { rule: string; count: number }[];

  return {
    attempts,
    overlapTrend,
    leaks,
    categories,
    verdicts,
    compositions: comps.length,
    reuseRate: comps.length > 0 ? withReuse / comps.length : 0,
    topRules,
  };
}
