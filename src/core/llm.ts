import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { ZodType, infer as ZodInfer } from 'zod';

export const MODEL = 'claude-opus-5';

export class MissingKeyError extends Error {
  constructor() {
    super(
      '缺少 Anthropic API key。\n\n' +
        '  export ANTHROPIC_API_KEY=sk-ant-...\n\n' +
        '或者用 `ant auth login` 登录后直接运行（SDK 会自动读取 profile）。',
    );
    this.name = 'MissingKeyError';
  }
}

let client: Anthropic | null = null;

export function getClient(): Anthropic {
  if (client) return client;
  const hasEnvCredential =
    !!process.env.ANTHROPIC_API_KEY || !!process.env.ANTHROPIC_AUTH_TOKEN;
  const hasProfile = !!process.env.ANTHROPIC_PROFILE;
  if (!hasEnvCredential && !hasProfile) {
    // SDK 也能读 `ant auth login` 落盘的默认 profile，所以这里不硬拦，
    // 只是把最常见的失败原因提前讲清楚。
    if (!process.env.TRUE_ENGLISH_ASSUME_PROFILE) throw new MissingKeyError();
  }
  client = new Anthropic();
  return client;
}

export interface CompleteOptions {
  system: string;
  user: string;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/**
 * 走结构化输出的一次调用。
 * 批改和卡片生成都是「一次输入、一次结构化输出」，不需要工具循环。
 */
export async function structured<S extends ZodType>(
  schema: S,
  opts: CompleteOptions,
): Promise<ZodInfer<S>> {
  const res = await getClient().messages.parse({
    model: MODEL,
    max_tokens: opts.maxTokens ?? 16000,
    // 批改是推理任务：判断「错 / 不自然 / 一样好」需要真的比较，不是模式匹配
    thinking: { type: 'adaptive' },
    output_config: {
      format: zodOutputFormat(schema),
      ...(opts.effort ? { effort: opts.effort } : {}),
    },
    system: opts.system,
    messages: [{ role: 'user', content: opts.user }],
  });

  if (res.stop_reason === 'refusal') {
    throw new Error(`模型拒绝了这次请求：${res.stop_details?.explanation ?? '未说明原因'}`);
  }
  if (!res.parsed_output) {
    throw new Error('结构化输出解析失败，没有拿到 parsed_output');
  }
  return res.parsed_output as ZodInfer<S>;
}
