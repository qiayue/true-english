import type { DatabaseSync } from 'node:sqlite';
import type { Leak } from './taxonomy.js';

/**
 * 支架的四级，以及「今天练什么」的排程。
 */

export const STAGES = ['copy', 'cloze', 'step', 'whole'] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_ZH: Record<Stage, string> = {
  copy: '照抄',
  cloze: '填空',
  step: '逐句',
  whole: '整段',
};

export const STAGE_HINT: Record<Stage, string> = {
  copy: '看一眼，遮住，打出来 —— 不是照着抄，中间那个记忆缺口才是有用的部分',
  cloze: '只填你容易错的那几个位置：冠词、介词、分词、单复数',
  step: '只看中文，一句一句写出来',
  whole: '只看中文，把整条连起来写一遍',
};

/**
 * 支架级别由熟悉度决定，不是每天都从头走一遍。
 *
 * 四级 × 五步 × 重复，一条推文能磨掉一小时 —— 方法论里写的是每天 25 分钟，
 * 而且明确说了「贪多是误区」。全套走一遍，第三天就不想打开它了。
 *
 * 所以：**同一条推文，每次只停在它当前该在的那一级**，练成了升一格，
 * 下次自动少一层支架。这就是支架渐撤的字面实现，时间也自然收敛。
 */
export function stageForBox(box: number | null | undefined): Stage {
  if (box === null || box === undefined || box <= 0) return 'copy';
  if (box === 1) return 'cloze';
  if (box <= 3) return 'step';
  return 'whole';
}

/**
 * 各级支架的估时（分钟）。
 *
 * 整段那一级不是「写完就完」：它后面挂着完整的收尾流程 ——
 * 读批改结果、出声读三遍、用今天的骨架写一条自己的推文。
 * 只算「写整段」那几分钟会严重低估，排程就会把一天塞爆。
 * 固定成本 4 分钟（批改 + 朗读 + 仿写）+ 随推文长度增长的写作时间。
 */
const COST_PER_STEP: Record<Stage, number> = { copy: 0.4, cloze: 0.5, step: 1.2, whole: 0.8 };
const WHOLE_OVERHEAD = 4;

export function estimateMinutes(stage: Stage, steps: number): number {
  const n = Math.max(1, steps);
  if (stage === 'whole') return WHOLE_OVERHEAD + COST_PER_STEP.whole * n;
  return Math.max(0.5, COST_PER_STEP[stage] * n);
}

/** 学习者的漏点，按出现次数从高到低 */
export function weakLeaks(db: DatabaseSync, limit = 4): Leak[] {
  const rows = db
    .prepare(
      `SELECT leak, COUNT(*) AS n FROM diff_items
       WHERE leak IS NOT NULL GROUP BY leak ORDER BY n DESC LIMIT ?`,
    )
    .all(limit) as unknown as { leak: Leak; n: number }[];
  return rows.map((r) => r.leak);
}

export interface PlanItem {
  cardId: string;
  glossZh: string;
  level: number;
  stage: Stage;
  box: number | null;
  totalSteps: number;
  estMinutes: number;
  kind: 'review' | 'new';
  /** 为什么排在这里 —— 界面上要说人话，不能只给个顺序 */
  why: string;
  score: number;
}

export interface Plan {
  items: PlanItem[];
  minutes: number;
  budget: number;
  /** 没排进今天的 —— 明确告诉用户有积压，而不是默默截断 */
  backlog: number;
  weak: Leak[];
}

interface Row {
  cardId: string; glossZh: string; level: number; totalSteps: number;
  practiced: number; dueSteps: number; minBox: number | null;
  earliestDue: string | null; textLower: string;
}

const LEAK_MARKERS: Record<Leak, RegExp> = {
  article: /\b(a|an|the)\b/,
  preposition: /\b(on|in|at|of|to|for|with|about|from|by)\b/,
  tense: /\b(was|were|had|did)\b|\b\w+ed\b/,
  number: /\b\w+s\b|\b(fewer|less|many|much)\b/,
  agreement: /\b(is|are|was|were|has|have|does|do)\b/,
  wordform: /\b\w+(ed|ing)\b|\b(built|written|made|taken|given|done)\b/,
};

/**
 * 排今天的练习。
 *
 * 三个设计取舍：
 *
 * 1. **按时间预算排，不按条数。** 20 条复习同时到期是 SRS 用户流失的
 *    经典场景 —— 打开一看 20 条，直接关掉。条数不是负担的度量，时间才是，
 *    而不同支架级别的耗时差好几倍（照抄两分钟，整段五分钟）。
 *
 * 2. **权重不只看盒子。** 逾期越久越急；盒子越低越急；
 *    还要加上「这张卡能不能练到你当前最严重的漏点」—— 同样是复习，
 *    练到冠词的那张比练不到的更值得排进来。
 *
 * 3. **超预算就明说有积压，不默默截断。** 用户需要知道系统替他做了取舍，
 *    否则他会以为「今天就这么点」，而积压在暗处越滚越大。
 */
export function planToday(
  db: DatabaseSync,
  opts: { budgetMinutes?: number; now?: Date; newLimit?: number } = {},
): Plan {
  const budget = opts.budgetMinutes ?? 25;
  const now = opts.now ?? new Date();
  const newLimit = opts.newLimit ?? 2;
  const iso = now.toISOString();
  const weak = weakLeaks(db);

  const rows = db
    .prepare(
      `SELECT c.id AS cardId, c.gloss_zh AS glossZh, c.level,
              LOWER(t.text) AS textLower,
              (SELECT COUNT(*) FROM steps s WHERE s.card_id = c.id) AS totalSteps,
              (SELECT COUNT(*) FROM step_progress g WHERE g.card_id = c.id) AS practiced,
              (SELECT COUNT(*) FROM step_progress g WHERE g.card_id = c.id AND g.due_at <= ?) AS dueSteps,
              (SELECT MIN(box) FROM step_progress g WHERE g.card_id = c.id) AS minBox,
              (SELECT MIN(due_at) FROM step_progress g WHERE g.card_id = c.id) AS earliestDue
       FROM cards c JOIN tweets t ON t.id = c.tweet_id
       ORDER BY c.created_at DESC`,
    )
    .all(iso) as unknown as Row[];

  const candidates: PlanItem[] = [];
  for (const r of rows) {
    const isNew = r.practiced === 0;
    if (!isNew && r.dueSteps === 0) continue; // 还没到期

    const stage = stageForBox(isNew ? null : r.minBox);
    const est = estimateMinutes(stage, r.totalSteps);

    // 逾期程度：越久越急，封顶避免陈年积压把新内容全挤掉
    const overdueH = r.earliestDue
      ? Math.max(0, (now.getTime() - new Date(r.earliestDue).getTime()) / 3600_000)
      : 0;
    const overdueScore = Math.min(3, overdueH / 24);

    // 盒子越低越急
    const boxScore = isNew ? 1.5 : Math.max(0, 3 - (r.minBox ?? 0));

    // 能练到当前最严重的漏点就加权 —— 同样是复习，练到冠词的那张更值得排
    const hitWeak = weak.filter((l) => LEAK_MARKERS[l]?.test(r.textLower));
    const leakScore = hitWeak.length > 0 ? 1.5 - weak.indexOf(hitWeak[0]!) * 0.3 : 0;

    const score = overdueScore * 2 + boxScore + Math.max(0, leakScore) + (isNew ? -1 : 0);

    const why = isNew
      ? '新卡'
      : [
          overdueH >= 24 ? `逾期 ${Math.floor(overdueH / 24)} 天` : '今天到期',
          (r.minBox ?? 0) === 0 ? '上次卡住了' : '',
          hitWeak.length ? `练得到你的${hitWeak[0]}漏点` : '',
        ].filter(Boolean).join(' · ');

    candidates.push({
      cardId: r.cardId, glossZh: r.glossZh, level: r.level, stage,
      box: isNew ? null : r.minBox, totalSteps: r.totalSteps,
      estMinutes: Number(est.toFixed(1)), kind: isNew ? 'new' : 'review',
      why, score: Number(score.toFixed(2)),
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  const items: PlanItem[] = [];
  let minutes = 0;
  let newCount = 0;
  for (const c of candidates) {
    if (c.kind === 'new' && newCount >= newLimit) continue;
    if (minutes + c.estMinutes > budget && items.length > 0) continue;
    items.push(c);
    minutes += c.estMinutes;
    if (c.kind === 'new') newCount++;
  }

  return {
    items,
    minutes: Number(minutes.toFixed(1)),
    budget,
    backlog: candidates.length - items.length,
    weak,
  };
}
