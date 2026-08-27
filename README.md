# true-english

**用真实老外的推文，训练中文母语者写英文。**

## 核心主张

推文不是阅读材料，推文是**标准答案**。

理解是接收能力，写作是产出能力。看懂一万条推文不会让你多写出一句地道英文。
唯一有效的用法是：先制造出「我想说这句话」的处境，自己写一遍，
再拿母语者的原句对答案 —— **你写的和他写的之间那个 diff，就是全部的课程内容。**

## 用法

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...

# 难度筛选（90% 法则，不调 API）
npm run score -- "I'll take a boring codebase over a clever one any day."
npm run score -- --file data/seed/tweets.json

# 生成每日卡片：中文 gloss + 句型骨架 + 词块
npm run card -- --file data/seed/tweets.json --index 0

# 批改一次回译 —— 核心动作
npm run diff -- \
  --original "Most of my slow days aren't slow because the code is hard." \
  --attempt  "My slow day is not because code is difficult."

# 跑评测集（改 prompt 前后各跑一次，对比通过率）
npm run eval
```

不需要 API key 的部分：

```bash
# 灌入模拟数据，看整条链路长什么样
npm run demo -- --db data/demo.db

# 学习报告：个人错误模式分析
npm run report -- --db data/demo.db

# 语料库：按功能检索，不按话题
npm run corpus -- --db data/demo.db --fn 反对

# 检查一条仿写复用了哪些词块（铁律：至少 2 个）
npm run corpus -- --db data/demo.db --check "I'd push back on that a little."
```

## 文档

- [方法论](docs/method.md) — 为什么这么学，以及完整的日/周循环、三阶段路线
- [项目规划](docs/plan.md) — 里程碑、目录结构、设计结论
