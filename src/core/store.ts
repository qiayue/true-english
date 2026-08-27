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
-- 学习者自己写的推文（仿写）。铁律：每条至少复用 2 个词块
CREATE TABLE IF NOT EXISTS compositions (
  id TEXT PRIMARY KEY, text TEXT NOT NULL, posted INTEGER DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_steps_card ON steps(card_id, idx);
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
