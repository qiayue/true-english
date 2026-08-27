import { structured } from './llm.js';
import type { LlmConfig } from './settings.js';
import { REVIEW_SYSTEM, buildReviewPrompt } from './prompts/review.js';
import { CARD_SYSTEM, buildCardPrompt } from './prompts/card.js';
import { COMPOSE_SYSTEM, buildComposePrompt } from './prompts/compose.js';
import {
  CardSchema, ReviewSchema, ComposeReviewSchema,
  type CardOut, type ReviewOut, type ComposeReviewOut,
} from './schema.js';
import { scoreDifficulty } from './difficulty.js';
import type { Card, Tweet } from './types.js';

/** 批改一次回译 */
export function review(
  input: { original: string; attempt: string; glossZh?: string },
  config: LlmConfig,
): Promise<ReviewOut> {
  return structured(ReviewSchema, {
    system: REVIEW_SYSTEM,
    user: buildReviewPrompt(input),
  }, config);
}

/** 从一条推文生成每日卡片 */
export async function makeCard(tweet: Tweet, config: LlmConfig): Promise<Card> {
  const difficulty = scoreDifficulty(tweet.text);
  const out: CardOut = await structured(CardSchema, {
    system: CARD_SYSTEM,
    user: buildCardPrompt(tweet.text),
  }, config);
  return {
    id: `card_${tweet.id}`,
    tweet,
    glossZh: out.glossZh,
    steps: out.steps,
    frames: out.frames,
    chunks: out.chunks,
    difficulty,
    createdAt: new Date().toISOString(),
  };
}

/**
 * 批改一条学习者自己写的推文。
 *
 * 和 `review()` 是两个函数不是一个带 flag 的函数 —— 因为它们的产出结构
 * 根本不同：回译比的是「和原文差在哪」，仿写比的是「和母语者会怎么写
 * 差在哪」，而后者那个「母语者版本」得先由批改自己造出来。
 */
export function reviewComposition(
  input: { text: string; chunks: { text: string; glossZh: string }[] },
  config: LlmConfig,
): Promise<ComposeReviewOut> {
  return structured(ComposeReviewSchema, {
    system: COMPOSE_SYSTEM,
    user: buildComposePrompt(input),
  }, config);
}
