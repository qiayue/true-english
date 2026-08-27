import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { scoreDifficulty } from '../core/difficulty.js';
import { cleanPaste } from '../core/paste.js';
import { makeCard, review } from '../core/review.js';
import {
  saveCard, saveAttempt, saveReview, saveComposition,
  detectReuse, chunksByFn, framesByFn, progress, stepsOf,
  recordStep, todayView, deleteCard, type StepOutcome,
} from '../core/store.js';
import { wordDiff, hint, type HintLevel } from '../core/steps.js';
import { loadConfig, publicConfig, saveConfig, clearKey, type LlmConfig } from '../core/settings.js';
import { ping } from '../core/llm.js';
import { FUNCTIONS, type Fn } from '../core/taxonomy.js';
import type { Card } from '../core/types.js';

export class ApiError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export function hasCredentials(db: DatabaseSync): boolean {
  return publicConfig(db).ready;
}

// ─────────────────────────────────────────────
// LLM 接入设置
// ─────────────────────────────────────────────

export function getSettings(db: DatabaseSync) {
  return publicConfig(db);
}

export function putSettings(db: DatabaseSync, patch: Partial<LlmConfig>) {
  if (patch.baseUrl !== undefined && patch.baseUrl && !/^https?:\/\//.test(patch.baseUrl)) {
    throw new ApiError('API 地址要以 http:// 或 https:// 开头');
  }
  saveConfig(db, patch);
  return publicConfig(db);
}

export function dropKey(db: DatabaseSync) {
  clearKey(db);
  return publicConfig(db);
}

/** 连通性自检。把失败原因原样带回去 —— 配错了不给具体原因就只能瞎猜。 */
export async function testSettings(db: DatabaseSync) {
  try {
    const r = await ping(loadConfig(db));
    return { ok: true as const, reply: r.reply };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 拉端点上可用的模型列表。
 *
 * OpenAI 兼容端点都有 GET /models。OpenRouter 还会在每个模型上带
 * supported_parameters，能看出它支不支持 structured_outputs ——
 * 不支持也能用（会降级成把 schema 写进 prompt），但支持的更稳，
 * 所以要在界面上标出来让用户自己权衡。
 */
export async function listModels(db: DatabaseSync) {
  const c = loadConfig(db);
  if (!/^https?:\/\//.test(c.baseUrl)) throw new ApiError('API 地址不对');
  const res = await fetch(`${c.baseUrl}/models`, {
    headers: c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {},
  });
  if (!res.ok) throw new ApiError(`拉取模型列表失败：${res.status} ${res.statusText}`);
  const json = (await res.json()) as {
    data?: { id?: string; name?: string; supported_parameters?: string[] }[];
  };
  const models = (json.data ?? [])
    .filter((m) => typeof m.id === 'string')
    .map((m) => ({
      id: m.id!,
      name: m.name ?? m.id!,
      structured: (m.supported_parameters ?? []).includes('structured_outputs'),
    }));
  return { models, total: models.length };
}

/** 投料：切分 + 90% 法则筛选。不调 LLM，粘贴后立刻出结果。 */
export function ingest(raw: string) {
  const { tweets, removed } = cleanPaste(raw);
  if (tweets.length === 0) {
    throw new ApiError(
      removed > 0
        ? `清掉 ${removed} 行界面噪音之后什么都不剩了。是不是只复制到了用户名和互动数？`
        : '没有解析出任何推文。',
    );
  }
  return { removed, tweets: tweets.map((text) => ({ text, difficulty: scoreDifficulty(text) })) };
}

/** 生成卡片并入库。需要 LLM。 */
export async function createCard(db: DatabaseSync, text: string, author?: string): Promise<Card> {
  const card = await makeCard(
    { id: randomUUID().slice(0, 8), text, author, capturedAt: new Date().toISOString() },
    loadConfig(db),
  );
  saveCard(db, card);
  return card;
}

export interface CardListItem {
  id: string;
  glossZh: string;
  level: number;
  attempts: number;
  bestPct: number | null;
}

export function listCards(db: DatabaseSync): CardListItem[] {
  return db
    .prepare(
      `SELECT c.id, c.gloss_zh AS glossZh, c.level,
              COUNT(DISTINCT a.id) AS attempts,
              MAX(CASE WHEN r.total > 0 THEN CAST(r.matched AS REAL) * 100 / r.total END) AS bestPct
       FROM cards c
       LEFT JOIN attempts a ON a.card_id = c.id
       LEFT JOIN reviews  r ON r.attempt_id = a.id
       GROUP BY c.id ORDER BY c.created_at DESC`,
    )
    .all() as unknown as CardListItem[];
}

/**
 * 取练习用的卡片 —— **只返回中文，不返回英文原文**。
 *
 * 这不是小事。整套方法的价值全部来自「先产出，再看答案」，
 * 如果英文躺在页面的 DOM 里，偷看的成本就是零，练习立刻退化成抄写。
 * 服务端不发，才是真的不发。
 */
export function practiceCard(db: DatabaseSync, id: string) {
  const row = db
    .prepare('SELECT id, gloss_zh AS glossZh, level FROM cards WHERE id = ?')
    .get(id) as unknown as { id: string; glossZh: string; level: number } | undefined;
  if (!row) throw new ApiError('卡片不存在', 404);
  // 阶梯同样只下发中文。en 留在服务端，对照时才逐步放出。
  const steps = stepsOf(db, id).map((s) => ({ idx: s.idx, glossZh: s.glossZh }));
  return { ...row, steps };
}

function stepAt(db: DatabaseSync, cardId: string, idx: number) {
  const st = stepsOf(db, cardId).find((s) => s.idx === idx);
  if (!st) throw new ApiError('这一步不存在', 404);
  return st;
}

/**
 * 阶梯的一步：机械逐词对照，**不调 LLM**。
 *
 * 两个理由。工程上：手工批改模式下一张卡 5 步就是 5 次复制粘贴往返，
 * 不可接受。教学上：小步的作用是建立手感和降低起步门槛，
 * 真正产生洞察的地方是最后把整条拼起来那一次 —— 那一次才走完整批改。
 *
 * 注意返回的是「对照」不是「判定」：逐词比对分不出「错」和「一样好」。
 */
export function checkStep(db: DatabaseSync, cardId: string, idx: number, text: string) {
  const st = stepAt(db, cardId, idx);
  const t = text.trim();
  if (!t) throw new ApiError('这一步还没写');
  const d = wordDiff(t, st.en);
  return { idx, en: st.en, ...d };
}

/** 一步练成了，记进度并算出下次该什么时候回来 */
export function finishStep(db: DatabaseSync, cardId: string, idx: number, o: Partial<StepOutcome>) {
  stepAt(db, cardId, idx); // 不存在就报 404
  return recordStep(db, cardId, idx, {
    tries: Math.max(1, Number(o.tries ?? 1)),
    hinted: !!o.hinted,
    copied: !!o.copied,
    accepted: !!o.accepted,
  });
}

export function todayQueue(db: DatabaseSync) {
  const v = todayView(db);
  return {
    ...v,
    review: v.items.filter((i) => i.kind === 'review').length,
    fresh: v.items.filter((i) => i.kind === 'new').length,
  };
}

export function stepHint(db: DatabaseSync, cardId: string, idx: number, level: number) {
  const st = stepAt(db, cardId, idx);
  const lv = (level >= 1 && level <= 3 ? level : 1) as HintLevel;
  const chunks = chunksByFn(db)
    .filter((c) => cardOwns(db, cardId, 'chunks', c.id))
    .map((c) => ({ text: c.text, glossZh: c.gloss_zh }));
  return { idx, level: lv, ...hint(lv, st.en, chunks) };
}

/** 提交回译 → 批改 → 入库。批改完成后英文原文、骨架、词块才一并放出。 */
export async function submitAttempt(db: DatabaseSync, cardId: string, attemptText: string) {
  const card = db
    .prepare(
      `SELECT c.id, c.gloss_zh AS glossZh, t.text AS original
       FROM cards c JOIN tweets t ON t.id = c.tweet_id WHERE c.id = ?`,
    )
    .get(cardId) as unknown as { id: string; glossZh: string; original: string } | undefined;
  if (!card) throw new ApiError('卡片不存在', 404);

  const text = attemptText.trim();
  if (!text) throw new ApiError('回译内容为空');

  const attemptId = `att_${randomUUID().slice(0, 8)}`;
  saveAttempt(db, { id: attemptId, cardId, text, createdAt: new Date().toISOString() });

  const r = await review(
    { original: card.original, attempt: text, glossZh: card.glossZh },
    loadConfig(db),
  );
  saveReview(db, attemptId, r);

  return {
    attemptId,
    review: r,
    original: card.original,
    frames: framesByFn(db).filter((f) => cardOwns(db, cardId, 'frames', f.id)),
    chunks: chunksByFn(db).filter((c) => cardOwns(db, cardId, 'chunks', c.id)),
  };
}

function cardOwns(db: DatabaseSync, cardId: string, table: 'frames' | 'chunks', id: number): boolean {
  const row = db.prepare(`SELECT card_id FROM ${table} WHERE id = ?`).get(id) as unknown as
    | { card_id: string }
    | undefined;
  return row?.card_id === cardId;
}

/**
 * 只查复用、不入库。给仿写台做实时反馈用。
 *
 * 和 compose 分开是因为语义不同：边打字边看「用了几个词块」是**查询**，
 * 点「存档」才是**写入**。混在一起会让每次按键都往库里塞一条草稿。
 */
export function checkReuse(db: DatabaseSync, text: string) {
  const t = text.trim();
  if (!t) return { hits: [], ok: false, need: 2 };
  const hits = detectReuse(db, t);
  return { hits, ok: hits.length >= 2, need: Math.max(0, 2 - hits.length) };
}

/** 仿写入库 + 词块复用检测（纯机械，不调 LLM） */
export function compose(db: DatabaseSync, text: string, posted: boolean) {
  const t = text.trim();
  if (!t) throw new ApiError('仿写内容为空');
  const hits = detectReuse(db, t);
  saveComposition(db, `comp_${randomUUID().slice(0, 8)}`, t, posted);
  return { hits, ok: hits.length >= 2, need: Math.max(0, 2 - hits.length) };
}

export function removeCard(db: DatabaseSync, cardId: string) {
  try {
    return deleteCard(db, cardId);
  } catch (e) {
    throw new ApiError(e instanceof Error ? e.message : '删除失败', 404);
  }
}

export function corpus(db: DatabaseSync, fn?: string) {
  const f = fn && FUNCTIONS.includes(fn as Fn) ? (fn as Fn) : undefined;
  return { chunks: chunksByFn(db, f), frames: framesByFn(db, f), functions: FUNCTIONS };
}

export function report(db: DatabaseSync) {
  return progress(db);
}

// ─────────────────────────────────────────────────────────────
// 手工批改模式
//
// 没有 API key 时的正式路径，不是临时补丁：
// 系统导出一份完整的批改请求（system prompt + 原文 + 回译），
// 你把它交给任何一个 Claude 会话，把返回的 JSON 贴回来。
//
// 这条路径同时也是 prompt 的调试通道 —— 你能看到引擎实际被喂了什么。
// ─────────────────────────────────────────────────────────────

import { REVIEW_SYSTEM, buildReviewPrompt } from '../core/prompts/review.js';
import { ReviewSchema } from '../core/schema.js';
import { z } from 'zod';

/**
 * 导出可复制的批改请求。
 *
 * 刻意**不落库**：导出和导入之间用户可能中断（关掉页面、忘了贴回来）。
 * 如果这一步就写 attempt，那些永远等不到批改的孤儿记录会让
 * 「回译次数」和「重合度趋势」全部虚高。改成无状态 —— 回译内容
 * 随导入请求一起回来，届时和批改结果一次性原子写入。
 */
export function gradingRequest(db: DatabaseSync, cardId: string, attemptText: string) {
  const card = db
    .prepare(
      `SELECT c.id, c.gloss_zh AS glossZh, t.text AS original
       FROM cards c JOIN tweets t ON t.id = c.tweet_id WHERE c.id = ?`,
    )
    .get(cardId) as unknown as { id: string; glossZh: string; original: string } | undefined;
  if (!card) throw new ApiError('卡片不存在', 404);

  const text = attemptText.trim();
  if (!text) throw new ApiError('回译内容为空');

  const schemaHint = JSON.stringify(z.toJSONSchema(ReviewSchema), null, 2);

  return {
    cardId,
    attempt: text,
    payload: [
      REVIEW_SYSTEM,
      '',
      '───────────────────────────────',
      '',
      buildReviewPrompt({ original: card.original, attempt: text, glossZh: card.glossZh }),
      '',
      '严格按下面这个 JSON Schema 输出，只输出 JSON，不要任何其他文字：',
      '',
      schemaHint,
    ].join('\n'),
  };
}

/** 把手工批改的 JSON 贴回来。回译和批改结果一次性原子写入。 */
export function importReview(db: DatabaseSync, cardId: string, attemptText: string, raw: string) {
  const card = db
    .prepare(
      `SELECT c.id, t.text AS original FROM cards c
       JOIN tweets t ON t.id = c.tweet_id WHERE c.id = ?`,
    )
    .get(cardId) as unknown as { id: string; original: string } | undefined;
  if (!card) throw new ApiError('卡片不存在', 404);

  const text = attemptText.trim();
  if (!text) throw new ApiError('回译内容为空');

  let obj: unknown;
  try {
    // 容忍粘贴时带上 ```json 围栏
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    obj = JSON.parse(cleaned);
  } catch {
    throw new ApiError('不是合法的 JSON。请确认复制完整，且没有多余文字。');
  }

  const parsed = ReviewSchema.safeParse(obj);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 4).map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new ApiError(`JSON 结构不符合要求：\n${issues.join('\n')}`);
  }

  assertReviewMatchesCard(parsed.data.items, card.original);

  const attemptId = `att_${randomUUID().slice(0, 8)}`;
  saveAttempt(db, { id: attemptId, cardId, text, createdAt: new Date().toISOString() });
  saveReview(db, attemptId, parsed.data);

  return {
    attemptId,
    review: parsed.data,
    original: card.original,
    frames: framesByFn(db).filter((f) => cardOwns(db, cardId, 'frames', f.id)),
    chunks: chunksByFn(db).filter((c) => cardOwns(db, cardId, 'chunks', c.id)),
  };
}

import { CARD_SYSTEM, buildCardPrompt } from '../core/prompts/card.js';
import { CardSchema } from '../core/schema.js';

/** 导出卡片生成请求。支持一次多条 —— 一次往返换 N 张卡片。 */
export function cardRequest(texts: string[]) {
  const usable = texts.map((t) => t.trim()).filter(Boolean);
  if (usable.length === 0) throw new ApiError('没有可用的推文');

  const schemaHint = JSON.stringify(z.toJSONSchema(CardSchema), null, 2);
  return {
    count: usable.length,
    payload: [
      CARD_SYSTEM,
      '',
      '───────────────────────────────',
      '',
      `下面有 ${usable.length} 条推文。请**逐条**制作卡片。`,
      '',
      ...usable.map((t, i) => `<推文 index="${i}">\n${t}\n</推文>`),
      '',
      '输出一个 JSON 数组，第 i 项对应第 i 条推文，每一项的结构是：',
      '',
      schemaHint,
      '',
      '只输出 JSON 数组，不要任何其他文字。',
    ].join('\n'),
  };
}

/** 导入手工生成的卡片。texts 必须与导出时的顺序一致。 */
export function importCards(db: DatabaseSync, texts: string[], raw: string): Card[] {
  let obj: unknown;
  try {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    obj = JSON.parse(cleaned);
  } catch {
    throw new ApiError('不是合法的 JSON。请确认复制完整，且没有多余文字。');
  }

  const parsed = z.array(CardSchema).safeParse(obj);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 4).map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new ApiError(`JSON 结构不符合要求：\n${issues.join('\n')}`);
  }
  if (parsed.data.length !== texts.length) {
    throw new ApiError(`数量对不上：粘贴了 ${texts.length} 条推文，但 JSON 里有 ${parsed.data.length} 张卡片`);
  }

  const out: Card[] = [];
  parsed.data.forEach((c, i) => {
    const text = texts[i]!;
    const id = randomUUID().slice(0, 8);
    const card: Card = {
      id: `card_${id}`,
      tweet: { id, text, capturedAt: new Date().toISOString() },
      glossZh: c.glossZh,
      steps: c.steps,
      frames: c.frames,
      chunks: c.chunks,
      difficulty: scoreDifficulty(text),
      createdAt: new Date().toISOString(),
    };
    saveCard(db, card);
    out.push(card);
  });
  return out;
}

/**
 * 校验粘回来的批改确实属于这条推文。
 *
 * 手工模式下同时开着多张卡片、复制粘贴串行，是很容易发生的。
 * 串了之后系统会照单全收，把 A 卡的错误算到 B 卡头上 ——
 * 错误模式统计会被污染，而这套系统最值钱的产出恰恰就是那份统计。
 *
 * 判据：批改里的 native 片段应当出自原文。允许母语者原文被省略改写
 * （比如 "having ... to decide" 这种带省略号的引用），所以只要求
 * 至少有一处对得上，而不是全部对得上。
 */
function assertReviewMatchesCard(
  items: { native: string }[],
  original: string,
): void {
  if (items.length < 3) return; // 样本太少，判不准，放行

  const hay = original.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ');
  const matched = items.filter((it) => {
    const needle = it.native.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (needle.length < 3) return false;
    // 带省略的引用切成片段逐段找
    return needle
      .split(/\s+\.\.\.\s+|\s{2,}/)
      .map((sg) => sg.trim())
      .filter((sg) => sg.length >= 3)
      .some((sg) => hay.includes(sg));
  }).length;

  if (matched === 0) {
    throw new ApiError(
      '这份批改看起来不是这条推文的 —— 里面引用的英文原句在本卡片里一句都找不到。\n' +
        '多半是复制的时候串卡了，检查一下是不是贴错了 JSON。',
    );
  }
}
