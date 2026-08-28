import type { DatabaseSync } from 'node:sqlite';

/**
 * LLM 接入配置。
 *
 * 走 OpenAI 兼容协议（OpenRouter / 本地 Ollama / 任何兼容端点都行），
 * 而不是绑死某一家的 SDK —— 换供应商时不用动代码。
 *
 * 解析顺序：数据库设置 > 环境变量 > 默认值。
 * 数据库优先是因为它是用户在界面上改的，改了就该立刻生效，
 * 不该被启动时的环境变量盖掉。
 */

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

const KEYS = {
  baseUrl: 'llm.base_url',
  apiKey: 'llm.api_key',
  model: 'llm.model',
  modelReview: 'llm.model.review',
  modelCard: 'llm.model.card',
  modelsCache: 'llm.models_cache',
} as const;

function get(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value?.trim() || null;
}

export function set(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, new Date().toISOString());
}

export function loadConfig(db: DatabaseSync): LlmConfig {
  return {
    baseUrl: get(db, KEYS.baseUrl) ?? process.env.LLM_BASE_URL ?? DEFAULT_BASE_URL,
    apiKey: get(db, KEYS.apiKey) ?? process.env.LLM_API_KEY ?? '',
    model: get(db, KEYS.model) ?? process.env.LLM_MODEL ?? '',
  };
}

export interface SettingsPatch extends Partial<LlmConfig> {
  modelReview?: string;
  modelCard?: string;
}

export function saveConfig(db: DatabaseSync, patch: SettingsPatch): void {
  if (patch.baseUrl !== undefined) set(db, KEYS.baseUrl, patch.baseUrl.replace(/\/+$/, ''));
  // 空字符串表示「不动」，不是「清空」—— 界面上 key 是只写字段，
  // 不回填也不显示，用户不改它时提交的就是空串。
  if (patch.apiKey) set(db, KEYS.apiKey, patch.apiKey);
  if (patch.model !== undefined) set(db, KEYS.model, patch.model);
  // 任务级模型跟 key 相反：空字符串就是「清掉，回落到默认」。
  // get() 把空串当 null，所以直接存空串即可。
  if (patch.modelReview !== undefined) set(db, KEYS.modelReview, patch.modelReview);
  if (patch.modelCard !== undefined) set(db, KEYS.modelCard, patch.modelCard);
}

/**
 * 按任务解析模型。
 *
 * 两类调用的经济学不同，不该逼着用一个模型：
 *   review —— 批改（回译 + 仿写），每天跑很多次，被 prompt 和 schema
 *             约束得很死，中档模型大概率够（用 eval 验证，不要猜）
 *   card   —— 卡片生成，一张卡只跑一次，但质量会持续影响之后几天的练习
 *             （坏的拆步、坏的词块会一路污染下去），值得用贵的
 *
 * 没单独配的任务回落到默认模型。baseUrl 和 key 永远共用 ——
 * 按任务换端点是另一件事，真有需求再说，现在加只会让设置页看不懂。
 */
export type LlmTask = 'review' | 'card';

export function configFor(db: DatabaseSync, task: LlmTask): LlmConfig {
  const base = loadConfig(db);
  const override = get(db, task === 'card' ? KEYS.modelCard : KEYS.modelReview);
  return override ? { ...base, model: override } : base;
}

export function clearKey(db: DatabaseSync): void {
  set(db, KEYS.apiKey, '');
}

/** 给界面看的配置：**绝不回传 key 本身**，只说有没有、什么样 */
export function publicConfig(db: DatabaseSync) {
  const c = loadConfig(db);
  return {
    baseUrl: c.baseUrl,
    model: c.model,
    modelReview: get(db, KEYS.modelReview) ?? '',
    modelCard: get(db, KEYS.modelCard) ?? '',
    hasKey: c.apiKey.length > 0,
    keyHint: c.apiKey ? `${c.apiKey.slice(0, 6)}…${c.apiKey.slice(-4)}` : '',
    ready: c.apiKey.length > 0 && c.model.length > 0,
  };
}

// ─────────────────────────────────────────────
// 模型列表缓存
//
// 列表一天变不了几次，而每次打开设置都去拉一遍 300 多个模型，
// 慢不说，断网时设置页直接废掉。拉一次存起来，想更新就点「强制刷新」。
// 缓存跟着 baseUrl 走：换了端点，旧列表就是错的，等于没有。
// ─────────────────────────────────────────────

export interface CachedModel {
  id: string;
  name: string;
  structured: boolean;
}

export function saveModelCache(db: DatabaseSync, baseUrl: string, models: CachedModel[]): void {
  set(db, KEYS.modelsCache, JSON.stringify({ baseUrl, at: new Date().toISOString(), models }));
}

export function loadModelCache(
  db: DatabaseSync,
  baseUrl: string,
): { models: CachedModel[]; cachedAt: string } | null {
  const raw = get(db, KEYS.modelsCache);
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as { baseUrl?: string; at?: string; models?: CachedModel[] };
    if (j.baseUrl !== baseUrl || !Array.isArray(j.models)) return null;
    return { models: j.models, cachedAt: j.at ?? '' };
  } catch {
    return null;
  }
}
