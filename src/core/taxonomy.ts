/**
 * 语料库的主索引轴 —— 按「功能」分类，不按话题分类。
 *
 * 理由：写作时大脑发出的检索请求是「我现在想礼貌地表示不同意」，
 * 而不是「我想找一个关于科技的词」。按话题建的库检索不到，等于坟场。
 */
export const FUNCTIONS = [
  '赞同',
  '反对',
  '怀疑',
  '让步',
  '举例',
  '转折',
  '强调',
  '限定',
  '因果',
  '对比',
  '观点转变',
  '自嘲',
  '推荐',
  '认错',
  '提问',
  '叙事',
] as const;
export type Fn = (typeof FUNCTIONS)[number];

/**
 * 四类「硬伤」—— 中文里根本不存在的语法范畴，因此是终身漏点。
 * 这些错误的特点是：学习者自己看不出来，母语者一眼看到。
 * 必须靠机械统计来抓，不能靠「感觉」。
 */
export const LEAKS = [
  'article',      // 冠词：a / an / the / 零冠词
  'tense',        // 时态与时态一致
  'number',       // 单复数
  'preposition',  // 介词搭配
  'agreement',    // 主谓一致
  'wordform',     // 词性 / 词形（-ing / -ed / 名词化）
  // 下面两类不是语法问题，但必须单独立项。
  //
  // 没有它们的时候，拼错的 Cloudfalre 和大小写错的 cms 只能硬塞进 wordform，
  // 于是报告首页写着「你的头号问题是词形 2 次」，点开一看两个样本
  // 全是手滑打错的单词 —— 这会让人去补根本没问题的构词法，
  // 而真正该修的冠词排到了第三。**报告是这套系统最值钱的产出，
  // 分类错了等于把人往错的方向推。**
  'spelling',     // 拼写手滑（不是不会，是打错）
  'casing',       // 大小写（缩写、专有名词、句首）
] as const;
export type Leak = (typeof LEAKS)[number];

/**
 * 能拿来出题的漏点。
 *
 * 填空级挖空、排程给卡片加权，都只看这几类 —— 因为它们能对应到句子里的
 * 一个**语法位置**：冠词在名词前，介词在名词短语前，分词在助动词后。
 *
 * 拼写和大小写不在其中：挖掉一个拼错过的单词，考的是打字不是语法，
 * 而且它们在报告里的次数往往最多（手滑比语法错好犯），
 * 放进来会把冠词、介词这些真正该练的挤出前四。
 * 它们的价值全部在报告里 —— 让人看见「我的错有一半只是手滑」。
 */
export const DRILLABLE_LEAKS = [
  'article', 'tense', 'number', 'preposition', 'agreement', 'wordform',
] as const;
export type DrillableLeak = (typeof DRILLABLE_LEAKS)[number];

export function isDrillable(l: Leak): l is DrillableLeak {
  return (DRILLABLE_LEAKS as readonly string[]).includes(l);
}

export const LEAK_ZH: Record<Leak, string> = {
  article: '冠词',
  tense: '时态',
  number: '单复数',
  preposition: '介词',
  agreement: '主谓一致',
  wordform: '词形',
  spelling: '拼写',
  casing: '大小写',
};

/** diff 的四个类别 */
export const CATEGORIES = ['chunk', 'structure', 'tone', 'leak'] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_ZH: Record<Category, string> = {
  chunk: '词块',
  structure: '结构',
  tone: '语气',
  leak: '硬伤',
};

/**
 * 三分判定。
 *
 * 这是整个批改系统最重要的约束：同一个意思本来就有多种正确写法。
 * 把学习者所有不同于原文的地方都标成「错」，既让人崩溃，也不诚实。
 */
export const VERDICTS = ['wrong', 'unnatural', 'equal'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const VERDICT_ZH: Record<Verdict, string> = {
  wrong: '错',
  unnatural: '可以，但母语者不会这么说',
  equal: '一样好',
};

/**
 * 中文母语者写英文的四个结构性障碍。
 * 写进 prompt，让批改器专门去找这些 —— 这是本项目区别于通用语法检查的地方。
 */
export const L1_OBSTACLES = [
  {
    id: 'topic-prominent',
    zh: '话题优先 → 主语优先',
    detail:
      '中文是话题优先语言（「这个功能我们下周做」），英文是主语优先。' +
      '学习者会写出 "This feature we will do next week."，应为 "We\'ll ship this feature next week."',
  },
  {
    id: 'parataxis',
    zh: '意合 → 形合',
    detail:
      '中文靠语义连接，逗号一路串下去；英文必须有明确的连接手段。' +
      '学习者会写出逗号粘连句 "It\'s cold, I don\'t want to go out."，' +
      '英文需要 so / because / 破折号 / 从句 / 或干脆断句。',
  },
  {
    id: 'serial-verbs',
    zh: '连动 → 一句一个主动词',
    detail:
      '中文可以连动（「我去买个咖啡回来喝」），英文一句只能有一个主要动词，' +
      '其余动作降级成介词短语或分词：I grabbed a coffee on my way back.',
  },
  {
    id: 'no-morphology',
    zh: '无形态标记 → 冠词·时态·单复数·介词',
    detail:
      '中文没有这四个语法范畴的形态标记，所以它们不是「学一遍就好」的知识，' +
      '而是会跟随学习者很久的漏点。要逐个标记并累积统计。',
  },
] as const;
