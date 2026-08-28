/**
 * 回译批改 —— 本项目的核心动作。
 *
 *   pnpm diff --original "..." --attempt "..." [--gloss "..."]
 *   pnpm diff --case evals/cases.json --index 0
 */
import './silence.js';
import fs from 'node:fs';
import { review } from '../core/review.js';
import { renderReview } from './render.js';
import { parseArgs, die } from './args.js';
import { loadConfig } from '../core/settings.js';
import { open, DEFAULT_DB } from '../core/store.js';
import { ConfigError } from '../core/llm.js';

const args = parseArgs(process.argv.slice(2));

let original = typeof args.original === 'string' ? args.original : '';
let attempt = typeof args.attempt === 'string' ? args.attempt : '';
let gloss = typeof args.gloss === 'string' ? args.gloss : undefined;

if (typeof args.case === 'string') {
  const cases = JSON.parse(fs.readFileSync(args.case, 'utf8')) as {
    original: string;
    attempt: string;
    glossZh?: string;
  }[];
  const i = Number(args.index ?? 0);
  const c = cases[i];
  if (!c) die(`case ${i} 不存在（共 ${cases.length} 条）`);
  ({ original, attempt } = c);
  gloss = c.glossZh;
}

if (!original || !attempt) {
  die('用法: pnpm diff --original "母语者原句" --attempt "你的回译" [--gloss "中文"]');
}

try {
  const r = await review({ original, attempt, glossZh: gloss }, loadConfig(open(String(args.db ?? DEFAULT_DB))));
  console.log(renderReview(r, original, attempt));
} catch (e) {
  if (e instanceof ConfigError) die(e.message);
  throw e;
}
