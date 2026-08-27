/**
 * 灌入一个完整实例：2 张卡片 + 1 次批改。
 * 第一次打开就能看到整条链路长什么样，不用先自己练一轮。
 *
 *   npm run seed:example            （服务器需已启动）
 *   PORT=5300 npm run seed:example
 */
import fs from 'node:fs';

const PORT = process.env.PORT ?? '5173';
const B = `http://localhost:${PORT}`;
const TEXTS = [
  "I used to think shipping fast was about typing fast. It's not. It's about having fewer things to decide.",
  'Most of my best decisions looked boring at the time.',
];

async function post(path, body) {
  const res = await fetch(B + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

try {
  await post('/api/cards/import', {
    texts: TEXTS,
    json: fs.readFileSync('data/seed/example-cards.json', 'utf8'),
  });

  const { cards } = await (await fetch(B + '/api/cards')).json();
  const card = cards.find((c) => c.level === 3) ?? cards[0];

  await post('/api/reviews/import', {
    cardId: card.id,
    attempt: 'Before I think do thing fast is typing fast. No. Is you need make less decision.',
    json: fs.readFileSync('data/seed/example-review.json', 'utf8'),
  });

  console.log(`\n  已灌入 2 张卡片 + 1 次完整批改。`);
  console.log(`  打开 ${B} ，切到「练习」和「报告」看看。\n`);
} catch (e) {
  console.error(`\n  失败：${e.message}`);
  console.error(`  服务器起来了吗？先在另一个终端跑 npm run dev\n`);
  process.exit(1);
}
