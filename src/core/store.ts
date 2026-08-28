import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { Card, Attempt, DiffItem } from './types.js';
import type { ReviewOut, ComposeReviewOut } from './schema.js';
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
-- 学习者本人的已知词。
--
-- 通用词频表是从电影对白统计的，它不认识 empower、不认识 backend，
-- 而这些恰恰是目标读者天天见的词。我可以一直往 domain.txt 里加词，
-- 但那是**我在猜他的词汇量**，永远猜不准，而且每个人的还不一样。
-- 正确的做法是让他自己说：筛选结果里点一下生词就是「这个我认识」，
-- 下次同一个词不再算生词。过滤器该学这个人的词汇量，不是套一张固定表。
CREATE TABLE IF NOT EXISTS known_words (
  word TEXT PRIMARY KEY, added_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
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

-- 词块级掌握度。**整套系统的目的在这张表里**。
--
-- 原来词块只被 detectReuse 数过一次，数完就扔 —— 语料库有 60 个词块，
-- 系统不知道你哪个用过、哪个用对过、哪个该再推给你。回译那一侧有
-- 四级支架和间隔重复，仿写这一侧连「今天该用哪几个」都答不上来。
-- 这张表就是把 step_progress 那套调度搬到产出侧。
CREATE TABLE IF NOT EXISTS chunk_progress (
  chunk_id INTEGER PRIMARY KEY,
  box INTEGER NOT NULL DEFAULT 0,
  due_at TEXT NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,      -- 用对过几次
  misuses INTEGER NOT NULL DEFAULT 0,   -- 伸手去用但用错了几次
  verified INTEGER NOT NULL DEFAULT 0,  -- 有没有被批改确认过（不是只被字符串匹配到）
  last_at TEXT NOT NULL
);

-- 仿写批改。和回译批改分开存：没有 overlap（没有原文），
-- 多了 native_version（母语者会怎么写）和 clarity（意思传达出来了吗）。
CREATE TABLE IF NOT EXISTS composition_reviews (
  comp_id TEXT PRIMARY KEY,
  native_version TEXT NOT NULL,
  clarity TEXT NOT NULL, clarity_zh TEXT,
  verdict_zh TEXT, strengths TEXT, chunk_use TEXT,
  created_at TEXT NOT NULL
);

-- 仿写的差异条目。刻意**不并进 diff_items**：
-- 两边的来源不同（一个是还原别人的句子，一个是说自己的话），
-- 报告里要能分开看「回译时的漏点」和「自由写作时的漏点」——
-- 后者才是真实写作水平。但算个人漏点画像时两边合并，因为漏的是同一个人。
CREATE TABLE IF NOT EXISTS comp_diff_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, comp_id TEXT NOT NULL,
  mine TEXT, native TEXT, category TEXT NOT NULL, verdict TEXT NOT NULL,
  leak TEXT, explain_zh TEXT, rule TEXT
);
CREATE INDEX IF NOT EXISTS idx_steps_card ON steps(card_id, idx);
CREATE INDEX IF NOT EXISTS idx_progress_due ON step_progress(due_at);
CREATE INDEX IF NOT EXISTS idx_chunks_fn ON chunks(fn);
CREATE INDEX IF NOT EXISTS idx_frames_fn ON frames(fn);
CREATE INDEX IF NOT EXISTS idx_diff_leak ON diff_items(leak);
CREATE INDEX IF NOT EXISTS idx_diff_attempt ON diff_items(attempt_id);
CREATE INDEX IF NOT EXISTS idx_chunkprog_due ON chunk_progress(due_at);
CREATE INDEX IF NOT EXISTS idx_compdiff_comp ON comp_diff_items(comp_id);
CREATE INDEX IF NOT EXISTS idx_compdiff_leak ON comp_diff_items(leak);
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

/**
 * 删除一张卡片及其全部衍生数据。
 *
 * 连坐范围包括骨架和词块 —— 因为要删的通常是「生成错了的卡」，
 * 它的词块多半也是坏的，留着反而污染语料库。
 *
 * **不删 compositions**：那是学习者自己写的推文，是他的产出，
 * 不是这张卡的衍生物。卡可以错，他写过的东西不该跟着消失。
 */
export function deleteCard(db: DatabaseSync, cardId: string): { deleted: Record<string, number> } {
  const row = db.prepare('SELECT tweet_id FROM cards WHERE id = ?').get(cardId) as
    | { tweet_id: string }
    | undefined;
  if (!row) throw new Error('卡片不存在');

  const attemptIds = (
    db.prepare('SELECT id FROM attempts WHERE card_id = ?').all(cardId) as unknown as { id: string }[]
  ).map((a) => a.id);

  const deleted: Record<string, number> = {};
  const run = (label: string, sql: string, ...args: unknown[]) => {
    const r = db.prepare(sql).run(...(args as never[]));
    deleted[label] = Number(r.changes ?? 0);
  };

  for (const id of attemptIds) db.prepare('DELETE FROM diff_items WHERE attempt_id = ?').run(id);
  for (const id of attemptIds) db.prepare('DELETE FROM reviews WHERE attempt_id = ?').run(id);
  deleted['批改'] = attemptIds.length;

  run('回译', 'DELETE FROM attempts WHERE card_id = ?', cardId);
  run('练习进度', 'DELETE FROM step_progress WHERE card_id = ?', cardId);
  run('步骤', 'DELETE FROM steps WHERE card_id = ?', cardId);
  run('骨架', 'DELETE FROM frames WHERE card_id = ?', cardId);
  // 先清词块进度再删词块 —— 反过来就找不到该清哪些了，留下一堆孤儿行，
  // 而 chunk_id 是自增主键，将来会被新词块复用，孤儿进度会张冠李戴。
  db.prepare('DELETE FROM chunk_progress WHERE chunk_id IN (SELECT id FROM chunks WHERE card_id = ?)').run(cardId);
  run('词块', 'DELETE FROM chunks WHERE card_id = ?', cardId);
  run('卡片', 'DELETE FROM cards WHERE id = ?', cardId);

  // 推文只在没有别的卡片引用它时才删
  const still = db.prepare('SELECT COUNT(*) AS n FROM cards WHERE tweet_id = ?').get(row.tweet_id) as { n: number };
  if (still.n === 0) run('推文', 'DELETE FROM tweets WHERE id = ?', row.tweet_id);

  return { deleted };
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
  /** 其中有多少次是在**自己写的**句子里犯的。这个数字比 count 重要：
   *  回译时漏冠词，可能只是没记住原文；自由写作时漏冠词，才是真的不会。 */
  free: number;
  share: number;
  samples: { mine: string; native: string; explain: string; free: boolean }[];
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
  /** 词块的三档状态。坟场率就在这里：库里有多少，真正用过多少 */
  chunks: { total: number; used: number; verified: number; misused: number; due: number };
  /** 批改过的仿写数，以及清晰度分布 —— 写作的第一目标是被读懂 */
  composeReviews: number;
  clarity: { clear: number; fuzzy: number; unclear: number };
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
    .prepare(
      `SELECT leak, SUM(n) AS n, SUM(free) AS free FROM (
         SELECT leak, COUNT(*) AS n, 0 AS free FROM diff_items WHERE leak IS NOT NULL GROUP BY leak
         UNION ALL
         SELECT leak, COUNT(*) AS n, COUNT(*) AS free FROM comp_diff_items WHERE leak IS NOT NULL GROUP BY leak
       ) GROUP BY leak ORDER BY n DESC`,
    )
    .all() as unknown as { leak: Leak; n: number; free: number }[];
  const leakTotal = leakRows.reduce((s, r) => s + r.n, 0);
  // 样本两边都取。自由写作里的那处排前面 —— 同一个漏点，
  // 在自己写的句子里犯的那次比在回译里犯的那次说明的问题严重得多。
  const sampleStmt = db.prepare(
    `SELECT mine, native, explain_zh, free FROM (
       SELECT id, mine, native, explain_zh, 0 AS free FROM diff_items WHERE leak = ?1
       UNION ALL
       SELECT id, mine, native, explain_zh, 1 AS free FROM comp_diff_items WHERE leak = ?1
     ) ORDER BY free DESC, id DESC LIMIT 4`,
  );
  const leaks: LeakStat[] = leakRows.map((r) => ({
    leak: r.leak,
    count: r.n,
    free: r.free,
    share: leakTotal > 0 ? r.n / leakTotal : 0,
    samples: (
      sampleStmt.all(r.leak) as unknown as { mine: string; native: string; explain_zh: string; free: number }[]
    ).map((s) => ({ mine: s.mine, native: s.native, explain: s.explain_zh, free: !!s.free })),
  }));

  const categories = db
    .prepare(
      `SELECT category, SUM(c) AS count FROM (
         SELECT category, COUNT(*) AS c FROM diff_items GROUP BY category
         UNION ALL SELECT category, COUNT(*) AS c FROM comp_diff_items GROUP BY category
       ) GROUP BY category ORDER BY count DESC`,
    )
    .all() as unknown as { category: string; count: number }[];
  const verdicts = db
    .prepare(
      `SELECT verdict, SUM(c) AS count FROM (
         SELECT verdict, COUNT(*) AS c FROM diff_items GROUP BY verdict
         UNION ALL SELECT verdict, COUNT(*) AS c FROM comp_diff_items GROUP BY verdict
       ) GROUP BY verdict ORDER BY count DESC`,
    )
    .all() as unknown as { verdict: string; count: number }[];

  const comps = db.prepare('SELECT id, text FROM compositions').all() as unknown as { id: string; text: string }[];
  const withReuse = comps.filter((c) => detectReuse(db, c.text).length >= 2).length;

  const clarityRows = db
    .prepare('SELECT clarity, COUNT(*) AS n FROM composition_reviews GROUP BY clarity')
    .all() as unknown as { clarity: string; n: number }[];
  const clarity = { clear: 0, fuzzy: 0, unclear: 0 };
  for (const c of clarityRows) {
    if (c.clarity in clarity) clarity[c.clarity as keyof typeof clarity] = c.n;
  }

  const topRules = db
    .prepare(
      `SELECT rule, SUM(count) AS count FROM (
         SELECT rule, COUNT(*) AS count FROM diff_items
           WHERE rule IS NOT NULL AND rule <> '' GROUP BY rule
         UNION ALL
         SELECT rule, COUNT(*) AS count FROM comp_diff_items
           WHERE rule IS NOT NULL AND rule <> '' GROUP BY rule
       ) GROUP BY rule ORDER BY count DESC LIMIT 5`,
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
    chunks: chunkStats(db),
    composeReviews: clarityRows.reduce((n, c) => n + c.n, 0),
    clarity,
  };
}

// ─────────────────────────────────────────────────────────────
// 词块调度 —— 产出侧的间隔重复
//
// 回译那一侧解决的是「能不能还原别人的句子」，词块这一侧解决的是
// 「能不能在说自己的话时把它调出来」。后者才是这个项目的目标。
// 两者的记忆机制不同：回译是再认，用词块是提取。所以要分开调度。
// ─────────────────────────────────────────────────────────────

export interface ChunkOutcome {
  /** 用对了 */
  correct: boolean;
  /**
   * 这个判定是不是批改确认过的。
   *
   * 字符串匹配到 ≠ 用对了。"be about to" 出现在句子里，可能是
   * "I be about to go"。只凭匹配就升级，等于系统自己骗自己：
   * 复习间隔被拉长，那个错误从此没人再纠正。
   */
  verified: boolean;
}

/** 没经过批改确认的「用过」，最多只能升到这一格 */
const UNVERIFIED_CAP = 1;

/**
 * 记一次词块使用。
 *
 * - 用对了 + 批改确认 → 升一格
 * - 用对了 + 只是匹配到 → 最多升到第 1 格（够了「别天天推给我」，不够称「掌握」）
 * - 用错了 → 打回第 0 格。这是最强的信号：他伸手去用了，而且用错了，
 *   说明他以为自己会 —— 这种错比没用过危险得多，必须马上回来。
 */
export function recordChunkUse(
  db: DatabaseSync,
  chunkId: number,
  o: ChunkOutcome,
  now = new Date(),
): { box: number; dueAt: string } {
  const prev = db
    .prepare('SELECT box, uses, misuses, verified FROM chunk_progress WHERE chunk_id = ?')
    .get(chunkId) as unknown as { box: number; uses: number; misuses: number; verified: number } | undefined;

  const oldBox = prev?.box ?? 0;
  let box: number;
  if (!o.correct) box = 0;
  else if (o.verified) box = Math.min(MAX_BOX, oldBox + 1);
  else box = Math.max(oldBox, Math.min(oldBox + 1, UNVERIFIED_CAP));

  const dueAt = new Date(now.getTime() + BOX_HOURS[box]! * 3600_000).toISOString();
  db.prepare(
    `INSERT INTO chunk_progress (chunk_id, box, due_at, uses, misuses, verified, last_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(chunk_id) DO UPDATE SET
       box = excluded.box, due_at = excluded.due_at, uses = excluded.uses,
       misuses = excluded.misuses, verified = excluded.verified, last_at = excluded.last_at`,
  ).run(
    chunkId, box, dueAt,
    (prev?.uses ?? 0) + (o.correct ? 1 : 0),
    (prev?.misuses ?? 0) + (o.correct ? 0 : 1),
    (prev?.verified ?? 0) || (o.correct && o.verified ? 1 : 0),
    now.toISOString(),
  );
  return { box, dueAt };
}

export interface DueChunk extends StoredChunk {
  box: number | null;
  uses: number;
  misuses: number;
  verified: boolean;
  /** 为什么推这个 —— 界面上要说人话 */
  why: string;
}

/**
 * 今天该试着用的词块。
 *
 * 三类，按这个优先级：
 *
 * 1. **用错过的**（misuses > 0 且到期）—— 最紧急。他以为自己会。
 * 2. **从没用过的**（没有进度行）—— 方法论的铁律是「当天必须用它说
 *    3 件你自己的事，不许『以后再用』」。刚入库的词块最该马上用掉。
 * 3. **到期复习的** —— 上次用对了，该验证是不是真的留下了。
 *
 * 只给 3 个。给多了就变成待办清单，而清单是用来焦虑的，不是用来写作的。
 * 一条推文塞 8 个词块也不是写作，是造句练习。
 */
export function dueChunks(
  db: DatabaseSync, limit = 3, now = new Date(), excludeCardId?: string,
): DueChunk[] {
  const iso = now.toISOString();
  // excludeCardId：刚练完那张卡的词块已经单独钉在输入框上方了，
  // 再在「今天该用的」里列一遍，同一个词块在一屏里出现两次 —— 那不是强调，是噪音。
  const rows = db
    .prepare(
      `SELECT c.id, c.text, c.fn, c.gloss_zh, c.example,
              p.box, p.due_at AS dueAt, p.uses, p.misuses, p.verified,
              (SELECT created_at FROM cards WHERE id = c.card_id) AS cardAt
       FROM chunks c LEFT JOIN chunk_progress p ON p.chunk_id = c.id
       WHERE (p.chunk_id IS NULL OR p.due_at <= ?1)
         AND (?2 IS NULL OR c.card_id <> ?2)`,
    )
    .all(iso, excludeCardId ?? null) as unknown as (StoredChunk & {
      box: number | null; dueAt: string | null; uses: number | null;
      misuses: number | null; verified: number | null; cardAt: string | null;
    })[];

  const scored = rows.map((r) => {
    const fresh = r.box === null;
    const misused = (r.misuses ?? 0) > 0;
    // 逾期越久越靠前，封顶 3 天，免得陈年积压把新词块永远挤掉
    const overdueDays = r.dueAt
      ? Math.min(3, Math.max(0, (now.getTime() - new Date(r.dueAt).getTime()) / 86_400_000))
      : 0;
    // 用错过的压过所有其他情况（6 > 新词块的 3 + 最多 2 分新鲜度加成）。
    // 「他伸手去用了，而且用错了」是这套系统能拿到的最强信号 ——
    // 说明他以为自己会。这种错比从没用过危险得多，该排在最前面看见。
    const score =
      (misused ? 6 : 0) +
      (fresh ? 3 : 0) +
      overdueDays +
      (fresh && r.cardAt ? recencyBonus(r.cardAt, now) : 0);
    const why = misused
      ? `上次用错了（${r.misuses} 次）—— 你以为自己会`
      : fresh
        ? '刚入库，还没用过'
        : '上次用对了，该再用一次看看是不是真留下了';
    return {
      id: r.id, text: r.text, fn: r.fn, gloss_zh: r.gloss_zh, example: r.example,
      box: r.box, uses: r.uses ?? 0, misuses: r.misuses ?? 0, verified: !!r.verified,
      why, score,
    };
  });

  scored.sort((a, b) => b.score - a.score || a.id - b.id);
  return scored.slice(0, limit).map(({ score: _score, ...c }) => c);
}

/** 刚做完的那张卡，它的词块今天最该被用掉 */
function recencyBonus(cardAt: string, now: Date): number {
  const days = (now.getTime() - new Date(cardAt).getTime()) / 86_400_000;
  return days <= 1 ? 2 : days <= 3 ? 1 : 0;
}

export function chunkStats(db: DatabaseSync): {
  total: number; used: number; verified: number; misused: number; due: number;
} {
  const q = (sql: string) => (db.prepare(sql).get(new Date().toISOString()) as { n: number }).n;
  return {
    total: (db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n,
    used: (db.prepare('SELECT COUNT(*) AS n FROM chunk_progress WHERE uses > 0').get() as { n: number }).n,
    verified: (db.prepare('SELECT COUNT(*) AS n FROM chunk_progress WHERE verified = 1').get() as { n: number }).n,
    misused: (db.prepare('SELECT COUNT(*) AS n FROM chunk_progress WHERE misuses > 0').get() as { n: number }).n,
    due: q(
      `SELECT COUNT(*) AS n FROM chunks c LEFT JOIN chunk_progress p ON p.chunk_id = c.id
       WHERE p.chunk_id IS NULL OR p.due_at <= ?`,
    ),
  };
}

// ─────────────────────────────────────────────────────────────
// 仿写批改
// ─────────────────────────────────────────────────────────────

export interface StoredComposition {
  id: string;
  text: string;
  posted: boolean;
  createdAt: string;
  review: {
    nativeVersion: string;
    clarity: string;
    clarityZh: string;
    verdictZh: string;
    strengths: string[];
    chunkUse: string[];
    items: DiffItem[];
  } | null;
}

/**
 * 存一次仿写批改，并顺手更新词块掌握度。
 *
 * 两件事必须一起做，这正是 M9 要补的那个环：
 *
 *   仿写批改 → 判定他有没有真的用对词块 → 更新词块熟悉度 → 下次推该用的给他
 *
 * `attempted` 是机械匹配「他伸手去用了哪些」，`chunkUse` 是批改确认
 * 「哪些真的用对了」。两者的差集就是**用错了**的 —— 这是整套系统里
 * 唯一能拿到的「他以为自己会但其实不会」的信号，必须落库。
 */
/**
 * 这条仿写「伸手去用了」哪些词块。
 *
 * 两个来源合并，缺一不可：
 * - `detectReuse` 的字符串匹配 —— 抓到他试图用、但可能用错的
 * - 批改点名的 `chunkUse` —— 抓到他用了变体形态、字符串匹配漏掉的
 *
 * 只用前者会把「用对了但换了个形态」判成没用；只用后者会把
 * 「用错了」的直接漏掉，而用错恰恰是最该记的那种。
 */
export function attemptedChunks(db: DatabaseSync, text: string, chunkUse: string[] = []): StoredChunk[] {
  const byId = new Map<number, StoredChunk>();
  for (const c of detectReuse(db, text)) byId.set(c.id, c);
  if (chunkUse.length > 0) {
    const named = chunkUse.map(normalize).filter(Boolean);
    for (const c of chunksByFn(db)) {
      if (namesChunk(named, c.text)) byId.set(c.id, c);
    }
  }
  return [...byId.values()];
}

export function saveCompositionReview(
  db: DatabaseSync,
  compId: string,
  r: ComposeReviewOut,
  attempted: StoredChunk[],
  now = new Date(),
): { used: StoredChunk[]; misused: StoredChunk[] } {
  db.prepare(
    `INSERT OR REPLACE INTO composition_reviews
       (comp_id, native_version, clarity, clarity_zh, verdict_zh, strengths, chunk_use, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    compId, r.nativeVersion, r.clarity, r.clarityZh, r.verdictZh,
    JSON.stringify(r.strengths), JSON.stringify(r.chunkUse), now.toISOString(),
  );

  db.prepare('DELETE FROM comp_diff_items WHERE comp_id = ?').run(compId);
  const ins = db.prepare(
    `INSERT INTO comp_diff_items (comp_id, mine, native, category, verdict, leak, explain_zh, rule)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  for (const it of r.items) {
    ins.run(compId, it.mine, it.native, it.category, it.verdict, it.leak ?? null, it.explainZh, it.rule ?? null);
  }

  const named = r.chunkUse.map(normalize).filter(Boolean);
  const used: StoredChunk[] = [];
  const misused: StoredChunk[] = [];
  for (const c of attempted) {
    const correct = namesChunk(named, c.text);
    recordChunkUse(db, c.id, { correct, verified: true }, now);
    (correct ? used : misused).push(c);
  }
  // 判定原样返回，不让调用方自己再判一次 —— 判两次迟早判出两个答案，
  // 于是界面说「用对了」而复习间隔按「用错了」走。
  return { used, misused };
}

/**
 * 批改点名的词块，是不是指的这一个。
 *
 * 不能只做字符串相等。批改被要求原样照抄词块文本，但实际上它经常只报
 * 用到的那一截 —— 库里是 `a new X built on Y`，它回 `built on`。
 * 严格相等的话，一次**完全正确**的使用会被判成用错，然后打回第 0 格。
 * 罚对了的人比放过错了的人伤害大得多：他会不知道自己错在哪，
 * 而系统还在一遍遍把这个词块推回来。
 *
 * 所以放宽到互为子串（长度 ≥ 4，避免 `on`、`the` 这种碰瓷）。
 */
function namesChunk(named: string[], chunkText: string): boolean {
  const target = normalize(chunkText);
  if (!target) return false;
  return named.some((n) =>
    n === target || (n.length >= 4 && (target.includes(n) || n.includes(target))));
}

export function compositions(db: DatabaseSync, limit = 30): StoredComposition[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.text, c.posted, c.created_at AS createdAt,
              r.native_version AS nativeVersion, r.clarity, r.clarity_zh AS clarityZh,
              r.verdict_zh AS verdictZh, r.strengths, r.chunk_use AS chunkUse
       FROM compositions c LEFT JOIN composition_reviews r ON r.comp_id = c.id
       ORDER BY c.created_at DESC LIMIT ?`,
    )
    .all(limit) as unknown as {
      id: string; text: string; posted: number; createdAt: string;
      nativeVersion: string | null; clarity: string | null; clarityZh: string | null;
      verdictZh: string | null; strengths: string | null; chunkUse: string | null;
    }[];

  const itemStmt = db.prepare(
    `SELECT mine, native, category, verdict, leak, explain_zh AS explainZh, rule
     FROM comp_diff_items WHERE comp_id = ? ORDER BY id`,
  );

  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    posted: !!r.posted,
    createdAt: r.createdAt,
    review: r.nativeVersion
      ? {
          nativeVersion: r.nativeVersion,
          clarity: r.clarity ?? 'clear',
          clarityZh: r.clarityZh ?? '',
          verdictZh: r.verdictZh ?? '',
          strengths: safeParse(r.strengths),
          chunkUse: safeParse(r.chunkUse),
          items: itemStmt.all(r.id) as unknown as DiffItem[],
        }
      : null,
  }));
}

function safeParse(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function compositionById(db: DatabaseSync, id: string): StoredComposition | undefined {
  return compositions(db, 1000).find((c) => c.id === id);
}

// ─────────────────────────────────────────────
// 学习者本人的已知词
// ─────────────────────────────────────────────

export function knownWords(db: DatabaseSync): Set<string> {
  const rows = db.prepare('SELECT word FROM known_words').all() as unknown as { word: string }[];
  return new Set(rows.map((r) => r.word));
}

/** 标记「这个词我认识」。归一化成小写，标点去掉。 */
export function addKnownWord(db: DatabaseSync, word: string): string | null {
  const w = word.toLowerCase().replace(/[^a-z'-]/g, '').replace(/^['-]+|['-]+$/g, '');
  if (w.length < 2) return null;
  db.prepare('INSERT OR IGNORE INTO known_words (word, added_at) VALUES (?,?)')
    .run(w, new Date().toISOString());
  return w;
}

/** 标错了要能撤回 —— 不然一次手滑就永久放宽了筛选 */
export function removeKnownWord(db: DatabaseSync, word: string): boolean {
  const r = db.prepare('DELETE FROM known_words WHERE word = ?').run(word.toLowerCase());
  return Number(r.changes ?? 0) > 0;
}

export function knownWordList(db: DatabaseSync): { word: string; addedAt: string }[] {
  return db
    .prepare('SELECT word, added_at AS addedAt FROM known_words ORDER BY added_at DESC')
    .all() as unknown as { word: string; addedAt: string }[];
}
