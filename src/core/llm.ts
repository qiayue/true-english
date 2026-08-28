import { z, type ZodType, type infer as ZodInfer } from 'zod';
import type { LlmConfig } from './settings.js';

/**
 * OpenAI 兼容的 chat/completions 客户端。
 *
 * 刻意不绑任何一家的 SDK：OpenRouter、本地 Ollama、任何兼容端点都是
 * 同一套协议，换供应商只改配置不改代码。代价是拿不到 Anthropic SDK
 * 那种「schema 直接进 SDK、自动解析」的便利，得自己处理三件事：
 * 结构化输出的降级、JSON 的提取、以及校验失败后的重试。
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class LlmError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: string) {
    super(message);
    this.name = 'LlmError';
  }
}

/** 一次 HTTP 调用的用量。cost 只有 OpenRouter 会给（美元）。 */
export interface Usage {
  prompt: number;
  completion: number;
  cost?: number;
}

export interface CompleteOptions {
  system: string;
  user: string;
  maxTokens?: number;
  /** 结构化输出失败后重试几次 */
  retries?: number;
  /**
   * 每次真实 HTTP 调用的用量回调。注意是**每次调用**：降级和重试
   * 也会各自触发一次 —— 那些也是花出去的钱，评测算成本时不能漏。
   */
  onUsage?: (u: Usage) => void;
}

interface ChatResponse {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string; code?: string | number };
}

function assertConfigured(c: LlmConfig): void {
  if (!c.apiKey) throw new ConfigError('还没有配置 API Key。打开「设置」填一个，或设环境变量 LLM_API_KEY。');
  if (!c.model) throw new ConfigError('还没有选模型。打开「设置」填一个模型 ID，比如 anthropic/claude-sonnet-4.5。');
  if (!/^https?:\/\//.test(c.baseUrl)) throw new ConfigError(`API 地址看起来不对：${c.baseUrl}`);
}

/** 从返回文本里抠出 JSON —— 模型爱加 ```json 围栏和前后寒暄 */
function extractJson(raw: string): unknown {
  const t = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(t);
  } catch {
    // 退而求其次：抓第一个 { 到最后一个 }（或 [ ... ]）
    for (const [open, close] of [['{', '}'], ['[', ']']] as const) {
      const a = t.indexOf(open);
      const b = t.lastIndexOf(close);
      if (a >= 0 && b > a) {
        try { return JSON.parse(t.slice(a, b + 1)); } catch { /* 继续试 */ }
      }
    }
    throw new LlmError(`模型返回的不是合法 JSON：\n${t.slice(0, 300)}`);
  }
}

/** 默认三分钟。批改一条推文远用不了这么久 —— 超过它基本是端点挂了。 */
const DEFAULT_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 180_000);

/**
 * 空响应单独立一类，因为它值得**自动重试一次**：
 * 上游打嗝、推理型模型把预算烧在思考上，都会给回一个 200 但正文为空 ——
 * 这类失败重试一次多半就过了，直接判死会把一次网络抖动变成「批改失败」。
 */
class EmptyResponseError extends LlmError {}

interface CallOpts {
  jsonSchema: { name: string; schema: unknown } | null;
  maxTokens: number;
  onUsage?: (u: Usage) => void;
  timeoutMs?: number;
}

async function callChat(
  c: LlmConfig,
  messages: { role: string; content: string }[],
  o: CallOpts,
): Promise<string> {
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetch(`${c.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${c.apiKey}`,
        // OpenRouter 用这两个头做来源署名，其他端点会忽略
        'HTTP-Referer': 'https://github.com/qiayue/true-english',
        'X-Title': 'true-english',
      },
      // 没有超时的 fetch 会把整个调用方挂死：批改页面转圈到天荒地老，
      // eval 跑到一半停在那里，谁都分不清是慢还是死。
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model: c.model,
        max_tokens: o.maxTokens,
        messages,
        // OpenRouter 的用量记账：带上这个才会在响应里给 usage.cost（美元）。
        // 只对 OpenRouter 发 —— 别的端点没见过这个字段，严格的会直接拒收。
        ...(c.baseUrl.includes('openrouter') ? { usage: { include: true } } : {}),
        ...(o.jsonSchema
          ? { response_format: { type: 'json_schema', json_schema: { ...o.jsonSchema, strict: true } } }
          : {}),
      }),
    });
  } catch (e) {
    const name = (e as Error)?.name ?? '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new LlmError(
        `请求超时（${Math.round(timeoutMs / 1000)}s 没有响应）。` +
          '模型确实很慢的话，用环境变量 LLM_TIMEOUT_MS 放宽。',
      );
    }
    throw e;
  }

  const text = await res.text();
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = JSON.parse(text) as ChatResponse;
      if (j.error?.message) msg = j.error.message;
    } catch { /* 用原始状态码 */ }
    throw new LlmError(msg, res.status, text.slice(0, 500));
  }

  let json: ChatResponse;
  try { json = JSON.parse(text) as ChatResponse; }
  catch { throw new LlmError(`端点返回的不是 JSON：${text.slice(0, 200)}`); }

  if (json.error?.message) throw new LlmError(json.error.message);

  if (o.onUsage && json.usage) {
    o.onUsage({
      prompt: Number(json.usage.prompt_tokens ?? 0),
      completion: Number(json.usage.completion_tokens ?? 0),
      ...(typeof json.usage.cost === 'number' ? { cost: json.usage.cost } : {}),
    });
  }

  const choice = json.choices?.[0];
  const content = choice?.message?.content;
  if (!content) {
    const fr = choice?.finish_reason;
    const burned = Number(json.usage?.completion_tokens ?? 0);
    // 说清楚到底发生了什么 —— 「没有返回任何内容」这句话没法排查
    if (fr === 'length' || burned > 0) {
      throw new EmptyResponseError(
        `模型产出了 ${burned} 个 token 但正文是空的（finish_reason: ${fr ?? '?'}）。` +
          '推理型模型把预算全花在思考上时会这样 —— 可以设 LLM_MAX_TOKENS 加大预算，或换个模型。',
      );
    }
    throw new EmptyResponseError(
      `模型没有返回任何内容${fr ? `（finish_reason: ${fr}）` : ''}。` +
        '可能是上游打了个嗝、被安全策略拦了，或模型 ID 不对。',
    );
  }
  return content;
}

/** callChat + 对空响应重试一次。所有出站调用都走这里。 */
async function callChatRetry(
  c: LlmConfig,
  messages: { role: string; content: string }[],
  o: CallOpts,
): Promise<string> {
  try {
    return await callChat(c, messages, o);
  } catch (e) {
    if (!(e instanceof EmptyResponseError)) throw e;
    return callChat(c, messages, o);
  }
}

/** 这个错是不是在说「我不支持 response_format」 */
function looksLikeSchemaUnsupported(e: unknown): boolean {
  if (!(e instanceof LlmError)) return false;
  const s = `${e.message} ${e.body ?? ''}`.toLowerCase();
  return (
    (e.status === 400 || e.status === 404 || e.status === 422) &&
    /response_format|json_schema|structured|schema|not supported|unsupported/.test(s)
  );
}

/**
 * 要一份符合 schema 的结构化输出。
 *
 * OpenRouter 上只有一部分模型支持 response_format，所以是三层保险：
 *   1. 先按 json_schema 要
 *   2. 端点说不支持 → 去掉 response_format，把 schema 写进 prompt 再要一次
 *   3. 拿到东西但校验不过 → 把校验错误回喂给模型，让它自己改
 * 三层都失败才抛错，并且把模型实际吐出来的东西带上 —— 不然没法排查。
 */
export async function structured<S extends ZodType>(
  schema: S,
  opts: CompleteOptions,
  config: LlmConfig,
): Promise<ZodInfer<S>> {
  assertConfigured(config);

  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  // 推理型模型的思考 token 也算在 max_tokens 里，8000 可能不够正文用 ——
  // 遇到「产出了 N 个 token 但正文是空的」就把 LLM_MAX_TOKENS 调大
  const maxTokens = opts.maxTokens ?? Number(process.env.LLM_MAX_TOKENS ?? 8000);
  const schemaText =
    '\n\n严格按下面这个 JSON Schema 输出，只输出 JSON，不要任何其他文字：\n\n' +
    JSON.stringify(jsonSchema, null, 2);

  const base = [
    { role: 'system', content: opts.system },
    { role: 'user', content: opts.user },
  ];

  const call = (
    msgs: { role: string; content: string }[],
    js: { name: string; schema: unknown } | null,
  ) => callChatRetry(config, msgs, { jsonSchema: js, maxTokens, onUsage: opts.onUsage });

  let raw: string;
  try {
    raw = await call(base, { name: 'result', schema: jsonSchema });
  } catch (e) {
    if (!looksLikeSchemaUnsupported(e)) throw e;
    // 这个模型不吃 response_format，把 schema 塞进 prompt
    raw = await call([base[0]!, { role: 'user', content: opts.user + schemaText }], null);
  }

  let attempt = 0;
  const maxRetries = opts.retries ?? 1;
  for (;;) {
    const parsed = schema.safeParse(extractJson(raw));
    if (parsed.success) return parsed.data as ZodInfer<S>;

    const issues = parsed.error.issues
      .slice(0, 6)
      .map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`)
      .join('\n');

    if (attempt++ >= maxRetries) {
      throw new LlmError(
        `模型返回的结构不符合要求（已重试 ${attempt - 1} 次）：\n${issues}\n\n` +
          `它实际返回的是：\n${raw.slice(0, 400)}`,
      );
    }

    raw = await call(
      [
        base[0]!,
        { role: 'user', content: opts.user + schemaText },
        { role: 'assistant', content: raw },
        { role: 'user', content: `上面的输出不符合 schema：\n${issues}\n\n请只输出修正后的完整 JSON。` },
      ],
      null,
    );
  }
}

/** 连通性自检：不走 schema，只确认地址、key、模型三样能通 */
export async function ping(config: LlmConfig, timeoutMs = 30_000): Promise<{ ok: true; reply: string }> {
  assertConfigured(config);
  // 连通性自检给 30s 就够 —— 它要回答的问题是「配置通不通」，
  // 等三分钟才告诉人「不通」，那这个自检本身就是坏的。
  const reply = await callChatRetry(
    config,
    [
      { role: 'system', content: 'You are a connectivity test. Reply with exactly: OK' },
      { role: 'user', content: 'ping' },
    ],
    { jsonSchema: null, maxTokens: 32, timeoutMs },
  );
  return { ok: true, reply: reply.trim().slice(0, 80) };
}
