import { z } from 'zod';
import { CATEGORIES, FUNCTIONS, LEAKS, VERDICTS } from './taxonomy.js';

export const DiffItemSchema = z.object({
  mine: z.string().describe('学习者写的那一段，原样摘录'),
  native: z.string().describe('原推对应的那一段，原样摘录'),
  category: z.enum(CATEGORIES),
  verdict: z.enum(VERDICTS).describe('三分判定：wrong / unnatural / equal'),
  leak: z
    .enum(LEAKS)
    .nullable()
    .describe('category 为 leak 时必填的硬伤子类，否则为 null'),
  explainZh: z.string().describe('具体到可执行的中文解释，禁止写「不够地道」这类废话'),
  rule: z
    .string()
    .nullable()
    .describe('一句话的可复用规则；抽象不出规则时为 null'),
});

export const ReviewSchema = z.object({
  items: z.array(DiffItemSchema).describe('按原文阅读顺序排列的差异'),
  overlap: z
    .object({
      matched: z.number().int().describe('学习者命中的意义单元数'),
      total: z.number().int().describe('原文的意义单元总数'),
    })
    .describe('回译重合度，按词块计，不按单词计'),
  strengths: z.array(z.string()).describe('他具体做对了什么，中文，至少一条'),
  verdictZh: z.string().describe('一句话总评，中文'),
});

export const FrameSchema = z.object({
  pattern: z.string().describe('挖空后的骨架，用 X / Y / ___ 占位'),
  fn: z.enum(FUNCTIONS),
  glossZh: z.string().describe('这个骨架用来干什么，中文一句话'),
});

export const ChunkSchema = z.object({
  text: z.string().describe('词块本身'),
  fn: z.enum(FUNCTIONS),
  glossZh: z.string().describe('中文意思'),
  example: z.string().describe('它在原推里的实际用法，原样摘录'),
});

/**
 * 阶梯的一步。
 *
 * 一次性面对整段是初学者弃坑的主要原因 —— 认知负荷太高，
 * 还没开始产出就已经放弃了。拆成小步，每一步都是能完成的产出。
 */
export const StepSchema = z.object({
  glossZh: z.string().describe('这一步的中文，同样必须是自然中文'),
  en: z.string().describe('这一步对应的英文，从原推里原样摘录，拼起来要能还原全文'),
});

export const CardSchema = z.object({
  glossZh: z.string().describe('自然中文，不能是英文的逐字对译'),
  steps: z
    .array(StepSchema)
    .describe('把整条推文拆成 2-6 个递进小步，按原文顺序，拼起来能还原全文'),
  frames: z.array(FrameSchema),
  chunks: z.array(ChunkSchema),
});

export type ReviewOut = z.infer<typeof ReviewSchema>;
export type CardOut = z.infer<typeof CardSchema>;
