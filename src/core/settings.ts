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

export function saveConfig(db: DatabaseSync, patch: Partial<LlmConfig>): void {
  if (patch.baseUrl !== undefined) set(db, KEYS.baseUrl, patch.baseUrl.replace(/\/+$/, ''));
  // 空字符串表示「不动」，不是「清空」—— 界面上 key 是只写字段，
  // 不回填也不显示，用户不改它时提交的就是空串。
  if (patch.apiKey) set(db, KEYS.apiKey, patch.apiKey);
  if (patch.model !== undefined) set(db, KEYS.model, patch.model);
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
    hasKey: c.apiKey.length > 0,
    keyHint: c.apiKey ? `${c.apiKey.slice(0, 6)}…${c.apiKey.slice(-4)}` : '',
    ready: c.apiKey.length > 0 && c.model.length > 0,
  };
}
