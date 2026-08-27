/**
 * 阶梯练习的机械支撑：逐词对照 + 提示阶梯。
 *
 * **这里刻意不做判定，只做对照。**
 * 机械逐词比对分不出「错」和「一样好」—— 学习者写了个同义的好说法，
 * 逐词比对一样会标成差异。硬给判定就违背了三分原则（错 / 可以但不自然 / 一样好），
 * 而那条原则是整套系统赖以成立的东西。
 * 所以步骤级的产出叫「对照」：这是原文的写法，你的和它差在这里，自己看。
 * 真正的判定只在最后拼整句时由完整批改给出。
 */

export type Op = { type: 'equal' | 'add' | 'del'; text: string };

/** 比对用的规范化：忽略大小写和标点，但保留原样文本用于显示 */
function key(tok: string): string {
  return tok.toLowerCase().replace(/[^a-z0-9']/g, '');
}

function tokenize(s: string): string[] {
  return s.trim().split(/\s+/).filter(Boolean);
}

/**
 * 逐词对照。步骤都很短（通常 < 20 词），O(n·m) 的 LCS 完全够用。
 */
export function wordDiff(mine: string, ref: string): {
  ops: Op[];
  hit: number;
  total: number;
} {
  const a = tokenize(mine);
  const b = tokenize(ref);
  const ka = a.map(key);
  const kb = b.map(key);

  // LCS 长度表
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j]! = ka[i] === kb[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  let hit = 0;
  while (i < a.length && j < b.length) {
    if (ka[i] === kb[j]) {
      ops.push({ type: 'equal', text: b[j]! });
      hit++;
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ type: 'del', text: a[i]! });
      i++;
    } else {
      ops.push({ type: 'add', text: b[j]! });
      j++;
    }
  }
  while (i < a.length) ops.push({ type: 'del', text: a[i++]! });
  while (j < b.length) ops.push({ type: 'add', text: b[j++]! });

  // 空词（纯标点）不计入分母，否则短句的命中率会被标点稀释
  const total = kb.filter((k) => k.length > 0).length;
  return { ops, hit, total };
}

/**
 * 首字母骨架。卡住时的第一级提示 —— 给出词数和每个词的首字母，
 * 但不给答案。这一级往往就够把人从「完全想不起来」推到「哦对」。
 *
 *   We redesigned the Cloudflare Blog
 *   → W_ r_________ t__ C_________ B___
 */
export function skeleton(ref: string): string {
  return tokenize(ref)
    .map((w) => {
      const letters = w.replace(/[^A-Za-z']/g, '');
      if (letters.length === 0) return w;
      const head = w.slice(0, w.indexOf(letters[0]!) + 1);
      const tailPunct = w.slice(w.indexOf(letters[0]!) + letters.length);
      return head + '_'.repeat(Math.max(0, letters.length - 1)) + tailPunct;
    })
    .join(' ');
}

/**
 * 提示阶梯。
 *
 * 「写不出来就卡死」是难度问题的另一半 —— 直接揭晓答案会让这一步白练。
 * 分级给，让学习者尽量停在能自己憋出来的那一级。
 */
export type HintLevel = 1 | 2 | 3;

export function hint(
  level: HintLevel,
  ref: string,
  chunks: { text: string; glossZh: string }[],
): { label: string; body: string } {
  if (level === 1) {
    const n = tokenize(ref).length;
    return { label: `骨架提示 · ${n} 个词`, body: skeleton(ref) };
  }
  if (level === 2) {
    const norm = (x: string) =>
      x.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const hay = norm(ref);
    const refWords = tokenize(ref).length;

    // 系动词在词块里是以词典形写的（be about X），实际原文是屈折形（It's about / was about）。
    // 拿 be 去字面匹配必然落空，所以匹配时把系动词剔掉，只看实义词。
    const COPULA = new Set(['be', 'is', 'are', 'was', 'were', 'am', 'been']);

    const contentWords = (chunkText: string) =>
      norm(chunkText.replace(/\b[XYZxyz]\b|___+/g, ''))
        .split(' ')
        .filter((w) => w.length > 1 && !COPULA.has(w));

    const relevant = chunks.filter((c) => {
      const words = contentWords(c.text);
      if (words.length === 0) return false;
      // 子串匹配，顺带兜住屈折：run → runs、decide → decides
      if (!words.every((w) => hay.includes(w))) return false;
      // 词块几乎就是整步答案时不能给 —— 二级提示会退化成直接揭晓，这一步就白练了。
      // 「其实不是。→ It's not.」正好撞上这种情况。
      return words.length / Math.max(1, refWords) <= 0.7;
    });

    if (relevant.length > 0) {
      return { label: '关键词块', body: relevant.map((c) => `${c.text}  —  ${c.glossZh}`).join('\n') };
    }
    return {
      label: '没有能给的词块',
      body:
        refWords <= 3
          ? '这一步太短了，给任何词块都等于直接把答案告诉你。\n换个角度想：这句中文的语气是什么？英文里表达同样的语气，句子该怎么搭？'
          : '这一步没有对应的词块，考的是结构不是用词。\n先问自己两件事：谁在做这个动作（主语放句首）？几个动作之间靠什么连起来？',
    };
  }
  return { label: '原文', body: ref };
}
