/**
 * 用模拟数据填充语料库，验证存储与统计链路。
 * 不调用 API —— 目的是在拿到 key 之前就能证明这部分是通的。
 *
 *   pnpm demo --db data/demo.db
 */
import fs from 'node:fs';
import { open, saveCard, saveAttempt, saveReview, saveComposition, progress } from '../core/store.js';
import { scoreDifficulty } from '../core/difficulty.js';
import type { Card } from '../core/types.js';
import type { ReviewOut } from '../core/schema.js';
import { parseArgs } from './args.js';
import { C } from './render.js';

const args = parseArgs(process.argv.slice(2));
const file = typeof args.db === 'string' ? args.db : 'data/demo.db';
if (fs.existsSync(file)) fs.unlinkSync(file);
const db = open(file);

const TWEETS = [
  {
    id: 'd1',
    text: "It's about having fewer things to decide.",
    glossZh: '关键在于需要做的决定更少。',
    frames: [{ pattern: "It's about ___.", fn: '强调' as const, glossZh: '点出「关键在于什么」' }],
    chunks: [
      { text: 'be about X', fn: '强调' as const, glossZh: '关键在于 X', example: "It's about having fewer things to decide." },
      { text: 'fewer things', fn: '限定' as const, glossZh: '更少的（可数）事情', example: 'having fewer things to decide' },
    ],
  },
  {
    id: 'd2',
    text: "I'll take a boring codebase over a clever one any day.",
    glossZh: '让我选的话，我永远选无聊的代码库，不选炫技的。',
    frames: [{ pattern: "I'll take X over Y any day.", fn: '推荐' as const, glossZh: '强烈的二选一偏好' }],
    chunks: [
      { text: 'take X over Y', fn: '推荐' as const, glossZh: '宁可要 X 也不要 Y', example: "I'll take a boring codebase over a clever one" },
      { text: 'any day', fn: '强调' as const, glossZh: '任何时候都（加强语气）', example: 'over a clever one any day' },
    ],
  },
  {
    id: 'd3',
    text: "I'd push back on that a little. Small teams aren't faster because they're small.",
    glossZh: '这点我有点不同意。小团队快，不是因为人少。',
    frames: [{ pattern: "A isn't ___ because B.", fn: '因果' as const, glossZh: '纠正一个错误归因' }],
    chunks: [
      { text: "I'd push back on that", fn: '反对' as const, glossZh: '我对这点有不同看法（委婉反对）', example: "I'd push back on that a little." },
      { text: 'a little', fn: '限定' as const, glossZh: '稍微，把话说得不那么绝对', example: 'push back on that a little' },
    ],
  },
];

for (const t of TWEETS) {
  const card: Card = {
    id: `card_${t.id}`,
    tweet: { id: t.id, text: t.text, capturedAt: new Date().toISOString() },
    glossZh: t.glossZh,
    frames: t.frames,
    chunks: t.chunks,
    difficulty: scoreDifficulty(t.text),
    createdAt: new Date().toISOString(),
  };
  saveCard(db, card);
}

/** 模拟 10 次回译：重合度逐步上升，冠词是他最顽固的漏点 */
const SESSIONS: { cardId: string; attempt: string; r: ReviewOut }[] = [
  {
    cardId: 'card_d1',
    attempt: 'It is about have less thing to decide.',
    r: {
      items: [
        { mine: 'have', native: 'having', category: 'leak', verdict: 'wrong', leak: 'wordform', explainZh: 'about 是介词，后面接动名词 having，不是动词原形。', rule: 'about / of / at 等介词后面一律接 -ing 形式' },
        { mine: 'less thing', native: 'fewer things', category: 'leak', verdict: 'wrong', leak: 'number', explainZh: 'thing 可数，可数用 fewer 不用 less，且必须复数。', rule: '可数名词用 fewer + 复数，不可数才用 less' },
      ],
      overlap: { matched: 5, total: 9 },
      strengths: ['be about 这个词块你用对了，说明你抓住了「关键在于」的意思，没有直译成 is。'],
      verdictZh: '骨架抓住了，卡在可数不可数上。',
    },
  },
  {
    cardId: 'card_d2',
    attempt: 'I will choose boring codebase not clever one in any time.',
    r: {
      items: [
        { mine: 'boring codebase', native: 'a boring codebase', category: 'leak', verdict: 'wrong', leak: 'article', explainZh: '单数可数名词前必须有冠词，泛指用 a。', rule: '单数可数名词前不能裸奔，必须有 a / an / the' },
        { mine: 'choose X not Y', native: 'take X over Y', category: 'chunk', verdict: 'unnatural', leak: null, explainZh: '英文表达「宁可要 X 不要 Y」的固定词块是 take X over Y。', rule: 'take X over Y = 二选一时偏向 X' },
        { mine: 'in any time', native: 'any day', category: 'leak', verdict: 'wrong', leak: 'preposition', explainZh: 'any day 本身就是副词短语，不加介词。', rule: 'any day / any time 作副词时不加 in' },
      ],
      overlap: { matched: 4, total: 10 },
      strengths: ['句子的信息顺序和原文一致，先说选什么再说不选什么。'],
      verdictZh: '意思到了，三处硬伤都在中文没有的语法范畴上。',
    },
  },
  {
    cardId: 'card_d3',
    attempt: 'I disagree a little. Small team is not fast because they are small.',
    r: {
      items: [
        { mine: 'Small team is', native: "Small teams aren't", category: 'leak', verdict: 'wrong', leak: 'number', explainZh: '泛指一类事物用复数，且后文 they 也要求复数。', rule: '泛指一类人或物时用复数，不用单数' },
        { mine: 'I disagree', native: "I'd push back on that", category: 'chunk', verdict: 'unnatural', leak: null, explainZh: 'I disagree 太直，英文里表达委婉反对常用 push back on。', rule: '委婉反对用 I\'d push back on that，不用 I disagree' },
        { mine: 'is not fast', native: "aren't faster", category: 'tone', verdict: 'wrong', leak: null, explainZh: '原文是比较级 faster（比谁快），你写成了绝对判断 fast。', rule: '讨论「更快/更好」时必须用比较级' },
      ],
      overlap: { matched: 6, total: 11 },
      strengths: ['a little 这个 hedge 你保留下来了，语气拿捏对了。'],
      verdictZh: '语气对了，卡在单复数和比较级。',
    },
  },
  {
    cardId: 'card_d1',
    attempt: "It's about having fewer things to decide.",
    r: {
      items: [],
      overlap: { matched: 9, total: 9 },
      strengths: ['完全命中。上次错的 fewer things 和 having 这次都对了。'],
      verdictZh: '全对。',
    },
  },
  {
    cardId: 'card_d2',
    attempt: "I'd take a boring codebase over clever one any day.",
    r: {
      items: [
        { mine: 'over clever one', native: 'over a clever one', category: 'leak', verdict: 'wrong', leak: 'article', explainZh: 'one 在这里是代名词指代 codebase，前面同样需要冠词 a。', rule: '单数可数名词前不能裸奔，必须有 a / an / the' },
        { mine: "I'd take", native: "I'll take", category: 'chunk', verdict: 'equal', leak: null, explainZh: "I'd take 和 I'll take 在这里都地道，前者更委婉一点。", rule: null },
      ],
      overlap: { matched: 9, total: 10 },
      strengths: ['take X over Y 这个词块用对了，上次是 choose X not Y。'],
      verdictZh: '进步明显，只剩一个冠词。',
    },
  },
  {
    cardId: 'card_d3',
    attempt: "I'd push back on that a little. Small teams aren't faster because they are small.",
    r: {
      items: [
        { mine: 'they are small', native: "they're small", category: 'tone', verdict: 'equal', leak: null, explainZh: '两种都对，缩写在推特体里更常见一点。', rule: null },
      ],
      overlap: { matched: 10, total: 11 },
      strengths: ['三处上次的错误全部改对了：委婉反对的词块、复数、比较级。'],
      verdictZh: '几乎全对。',
    },
  },
];

let i = 0;
for (const s of SESSIONS) {
  const id = `att_${++i}`;
  const at = new Date(Date.UTC(2026, 7, 10 + i, 9, 0, 0)).toISOString();
  saveAttempt(db, { id, cardId: s.cardId, text: s.attempt, createdAt: at });
  saveReview(db, id, s.r);
  db.prepare('UPDATE reviews SET created_at = ? WHERE attempt_id = ?').run(at, id);
}

/** 模拟仿写：有的复用了词块，有的没有 */
const COMPS = [
  "I used to think learning English was about memorizing words. It's not. It's about having sentences ready before you need them.",
  "I'd push back on that a little. Most beginners don't fail from bad grammar, they fail from never writing anything.",
  "I'll take a slow habit over a fast plan any day.",
  'Today I write three sentence in English.',
  'Reading is easy but writing is hard for me.',
];
COMPS.forEach((t, n) => saveComposition(db, `comp_${n}`, t, n < 3));

const p = progress(db);
console.log('');
console.log(`${C.green}✓${C.reset} 已写入 ${file}`);
console.log(
  `  ${p.attempts} 次回译 · ${p.compositions} 条仿写 · ` +
    `${p.leaks.length} 类硬伤 · 词块复用率 ${Math.round(p.reuseRate * 100)}%`,
);
console.log('');
console.log(`${C.gray}接着跑：${C.reset}`);
console.log(`${C.gray}  npm run report -- --db ${file}${C.reset}`);
console.log(`${C.gray}  npm run corpus -- --db ${file} --fn 反对${C.reset}`);
console.log('');
