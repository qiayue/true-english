import type { Leak } from './taxonomy.js';

/**
 * 填空题生成。
 *
 * **不随机挖空。** 随机挖掉 Cloudflare 只是在考拼写记忆，
 * 教不到任何系统性的东西。挖空点必须落在**这个学习者实际会错的位置**上 ——
 * 冠词、介词、过去分词、单复数。这些正是批改结果里 leak 统计出来的东西，
 * 于是整个系统自洽了：批改 → 错误统计 → 填空选点 → 再批改。
 *
 * 没有历史数据时（第一次用），退回到中文母语者的通用漏点：
 * 冠词和介词。这两类在中文里根本不存在对应的形态，谁都躲不过。
 */

const ARTICLES = new Set(['a', 'an', 'the']);
const PREPOSITIONS = new Set([
  'on', 'in', 'at', 'of', 'to', 'for', 'with', 'about', 'from', 'by',
  'over', 'under', 'into', 'onto', 'through', 'during', 'between', 'against',
]);
const COPULA = new Set(['is', 'are', 'was', 'were', 'be', 'been', 'am']);
const AUX = new Set(['has', 'have', 'had', 'does', 'do', 'did', 'will', 'would', 'can', 'could']);
const QUANTIFIER = new Set(['fewer', 'less', 'many', 'much', 'most', 'some', 'few', 'several']);

/**
 * 不规则过去分词。
 *
 * 规则的 -ed 好认，难的恰恰是这批 —— 而它们也正是中文母语者最容易写错的
 * （学习者写过 "write by us"、"base on"，两处都是分词位置填了原形）。
 * 只靠 /ed$/ 的话，built / written / made 这些一个都抓不到。
 */
const IRREGULAR_PARTICIPLES = new Set([
  'built', 'written', 'made', 'done', 'taken', 'given', 'driven', 'known', 'shown',
  'grown', 'thrown', 'seen', 'gone', 'held', 'kept', 'left', 'lost', 'met', 'paid',
  'sent', 'sold', 'spent', 'told', 'understood', 'won', 'brought', 'bought', 'caught',
  'taught', 'thought', 'found', 'gotten', 'heard', 'meant', 'chosen', 'broken',
  'spoken', 'stolen', 'forgotten', 'hidden', 'beaten', 'eaten', 'fallen', 'risen',
]);

export interface ClozeBlank {
  /** 在 tokens 里的下标 */
  index: number;
  answer: string;
  /** 这个空考的是哪类漏点，用来给提示语 */
  leak: Leak | null;
}

export interface Cloze {
  tokens: string[];
  blanks: ClozeBlank[];
}

const bare = (t: string) => t.toLowerCase().replace(/[^a-z']/g, '');

/** 这个词属于哪一类漏点；不属于任何一类返回 null */
function classify(token: string, prev: string | undefined): Leak | null {
  const w = bare(token);
  if (!w) return null;
  if (ARTICLES.has(w)) return 'article';
  if (PREPOSITIONS.has(w)) return 'preposition';
  if (COPULA.has(w)) return 'agreement';
  if (AUX.has(w)) return 'agreement';
  if (QUANTIFIER.has(w)) return 'number';
  // 过去分词 / 动名词。规则的 -ed/-ing 和不规则的都要抓 ——
  // 学习者在这个位置填过原形（write by us / base on），是真实漏点。
  if (IRREGULAR_PARTICIPLES.has(w) || /[a-z]{3,}(ed|ing)$/.test(w)) return 'wordform';
  // 复数：三个字母以上、以 s 结尾、且不是 -ss/-us
  if (/[a-z]{3,}s$/.test(w) && !/(ss|us|is)$/.test(w)) return 'number';
  return null;
}

/**
 * 挖空。
 *
 * @param en    目标英文
 * @param weak  学习者的漏点，按严重程度从高到低。空数组时用通用默认
 * @param max   最多挖几个空 —— 挖太多就从「填空」变成「默写」了，
 *              那是第三级的事，这一级的支架必须比它多
 */
export function makeCloze(en: string, weak: Leak[] = [], max = 5): Cloze {
  const tokens = en.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { tokens: [], blanks: [] };

  const priority: Leak[] = weak.length > 0 ? weak : ['article', 'preposition'];
  const rank = new Map(priority.map((l, i) => [l, i]));

  const candidates: ClozeBlank[] = [];
  tokens.forEach((tok, i) => {
    const leak = classify(tok, tokens[i - 1]);
    if (leak && rank.has(leak)) candidates.push({ index: i, answer: tok, leak });
  });

  // 按漏点严重程度排；同一类里保持原文顺序
  candidates.sort((a, b) => (rank.get(a.leak!)! - rank.get(b.leak!)!) || a.index - b.index);

  // 挖空上限同时受句子长度约束：短句挖两个就没剩什么了，
  // 支架撤得太快，这一级就失去意义
  const cap = Math.max(1, Math.min(max, Math.floor(tokens.length * 0.3)));
  const chosen = candidates.slice(0, cap).sort((a, b) => a.index - b.index);

  // 一个都没匹配上（比如句子里全是实词）→ 退而挖最长的那个实词，
  // 总比一个空都没有强
  if (chosen.length === 0) {
    let best = -1;
    let bestLen = 0;
    tokens.forEach((t, i) => {
      const w = bare(t);
      if (w.length > bestLen) { bestLen = w.length; best = i; }
    });
    if (best >= 0) chosen.push({ index: best, answer: tokens[best]!, leak: null });
  }

  return { tokens, blanks: chosen };
}

/** 判定填空作答。大小写和标点不计较 —— 这一级考的是选词，不是抄写。 */
export function checkCloze(
  cloze: Cloze,
  answers: string[],
): { results: { index: number; ok: boolean; got: string; answer: string; leak: Leak | null }[]; allOk: boolean } {
  const results = cloze.blanks.map((b, i) => {
    const got = (answers[i] ?? '').trim();
    return { index: b.index, ok: bare(got) === bare(b.answer) && bare(got).length > 0, got, answer: b.answer, leak: b.leak };
  });
  return { results, allOk: results.every((r) => r.ok) };
}
