import { structured } from './llm.js';
import { REVIEW_SYSTEM, buildReviewPrompt } from './prompts/review.js';
import { CARD_SYSTEM, buildCardPrompt } from './prompts/card.js';
import { CardSchema, ReviewSchema, type CardOut, type ReviewOut } from './schema.js';
import { scoreDifficulty } from './difficulty.js';
import type { Card, Tweet } from './types.js';

/** 批改一次回译 */
export function review(input: {
  original: string;
  attempt: string;
  glossZh?: string;
}): Promise<ReviewOut> {
  return structured(ReviewSchema, {
    system: REVIEW_SYSTEM,
    user: buildReviewPrompt(input),
  });
}

/** 从一条推文生成每日卡片 */
export async function makeCard(tweet: Tweet): Promise<Card> {
  const difficulty = scoreDifficulty(tweet.text);
  const out: CardOut = await structured(CardSchema, {
    system: CARD_SYSTEM,
    user: buildCardPrompt(tweet.text),
  });
  return {
    id: `card_${tweet.id}`,
    tweet,
    glossZh: out.glossZh,
    frames: out.frames,
    chunks: out.chunks,
    difficulty,
    createdAt: new Date().toISOString(),
  };
}
