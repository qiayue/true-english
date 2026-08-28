/**
 * OpenAI 兼容客户端的协议测试。
 *
 * 真实端点（OpenRouter）在开发环境里被出口代理挡着，所以用本地 mock
 * 把三层降级逻辑逐条走一遍。这些分支恰恰是最容易写错又最难发现的：
 * 平时跑的都是happy path，等到换了个不支持 response_format 的模型
 * 才炸，而那时候人已经在用了。
 *
 *   npx tsx tests/llm.ts
 */
import http from 'node:http';
import { z } from 'zod';
import { structured, ping, ConfigError, LlmError } from '../src/core/llm.js';

const Schema = z.object({ answer: z.string(), n: z.number().int() });

let failed = 0;
const t = (name: string, ok: boolean, got = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !got ? '' : `  (${got})`}`);
};

/** 起一个可编程的 mock 端点，返回它的地址和收到的请求 */
function mock(handler: (req: Record<string, unknown>, n: number) => { status?: number; body: unknown }) {
  const seen: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      seen.push(body);
      const out = handler(body, seen.length);
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  return new Promise<{ url: string; seen: typeof seen; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}`, seen, close: () => server.close() });
    });
  });
}
const reply = (content: string) => ({ body: { choices: [{ message: { content } }] } });
const cfg = (url: string) => ({ baseUrl: url, apiKey: 'test-key', model: 'test/model' });

console.log('\n配置校验');
try { await structured(Schema, { system: 's', user: 'u' }, { baseUrl: 'x', apiKey: '', model: 'm' }); t('缺 key 要报 ConfigError', false); }
catch (e) { t('缺 key 要报 ConfigError', e instanceof ConfigError, (e as Error).message.slice(0, 30)); }
try { await structured(Schema, { system: 's', user: 'u' }, { baseUrl: 'http://x', apiKey: 'k', model: '' }); t('缺模型要报 ConfigError', false); }
catch (e) { t('缺模型要报 ConfigError', e instanceof ConfigError); }

console.log('\n① 正常路径');
{
  const m = await mock(() => reply('{"answer":"hi","n":1}'));
  const r = await structured(Schema, { system: 's', user: 'u' }, cfg(m.url));
  t('拿到结构化结果', r.answer === 'hi' && r.n === 1);
  t('请求里带了 response_format', !!(m.seen[0] as any).response_format);
  t('json_schema 是 strict 的', (m.seen[0] as any).response_format.json_schema.strict === true);
  t('带上了模型 ID', (m.seen[0] as any).model === 'test/model');
  m.close();
}

console.log('\n② 端点不支持 response_format → 降级把 schema 写进 prompt');
{
  const m = await mock((_b, n) =>
    n === 1
      ? { status: 400, body: { error: { message: 'response_format is not supported by this model' } } }
      : reply('{"answer":"fallback","n":2}'));
  const r = await structured(Schema, { system: 's', user: 'u' }, cfg(m.url));
  t('降级后仍拿到结果', r.answer === 'fallback');
  t('第二次不再带 response_format', !(m.seen[1] as any).response_format);
  t('schema 被写进了 prompt', JSON.stringify(m.seen[1]).includes('JSON Schema'));
  m.close();
}

console.log('\n③ 模型加了 ``` 围栏和寒暄');
{
  const m = await mock(() => reply('好的，这是结果：\n```json\n{"answer":"fenced","n":3}\n```\n希望有帮助！'));
  const r = await structured(Schema, { system: 's', user: 'u' }, cfg(m.url));
  t('能从围栏和废话里抠出 JSON', r.answer === 'fenced');
  m.close();
}

console.log('\n④ 结构不符 → 回喂校验错误重试');
{
  const m = await mock((_b, n) =>
    n === 1 ? reply('{"answer":"bad","n":"不是数字"}') : reply('{"answer":"fixed","n":4}'));
  const r = await structured(Schema, { system: 's', user: 'u' }, cfg(m.url));
  t('重试后修正成功', r.answer === 'fixed');
  const retry = JSON.stringify(m.seen[1]);
  t('把具体的校验错误回喂给了模型', retry.includes('不符合 schema') && retry.includes('n'));
  m.close();
}

console.log('\n⑤ 一直不符 → 报错并带上模型实际输出');
{
  const m = await mock(() => reply('{"answer":"still bad"}'));
  try {
    await structured(Schema, { system: 's', user: 'u', retries: 1 }, cfg(m.url));
    t('应该抛错', false);
  } catch (e) {
    const msg = (e as Error).message;
    t('抛 LlmError', e instanceof LlmError);
    t('错误里带了模型实际返回的内容', msg.includes('still bad'), msg.slice(0, 60));
  }
  m.close();
}

console.log('\n⑥ 端点错误要原样带回');
{
  const m = await mock(() => ({ status: 401, body: { error: { message: 'No auth credentials found' } } }));
  try { await structured(Schema, { system: 's', user: 'u' }, cfg(m.url)); t('应该抛错', false); }
  catch (e) { t('401 的原因原样带回', (e as Error).message.includes('No auth credentials')); }
  m.close();
}

console.log('\n⑦ 连通性自检');
{
  const m = await mock(() => reply('OK'));
  const r = await ping(cfg(m.url));
  t('ping 通', r.ok && r.reply === 'OK');
  t('ping 不带 response_format', !(m.seen[0] as any).response_format);
  m.close();
}

console.log('\n⑧ 超时：挂死的端点必须在限时内报错');
{
  // 一个永远不回话的端点。没有超时的话这个测试自己就会挂住 ——
  // 这正是修它的原因：eval 跑到一半停在那儿，分不清是慢还是死。
  const server = (await import('node:http')).createServer(() => { /* 收下请求，永不响应 */ });
  const url = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    });
  });
  const t0 = Date.now();
  try {
    await ping(cfg(url), 400);
    t('应该超时报错', false);
  } catch (e) {
    t('超时抛 LlmError', e instanceof LlmError, String(e));
    t('错误说清了是超时', (e as Error).message.includes('超时'), (e as Error).message.slice(0, 50));
    t('确实在限时附近放弃（< 3s）', Date.now() - t0 < 3000, `${Date.now() - t0}ms`);
  }
  server.close();
  server.closeAllConnections?.();
}

console.log('\n⑨ 用量回调：每次真实调用各触发一次，重试也算钱');
{
  const usage = { prompt_tokens: 100, completion_tokens: 50, cost: 0.001 };
  const m = await mock((_b, n) =>
    n === 1
      ? { body: { choices: [{ message: { content: '{"answer":"bad","n":"str"}' } }], usage } }
      : { body: { choices: [{ message: { content: '{"answer":"ok","n":9}' } }], usage } });
  const got: { prompt: number; completion: number; cost?: number }[] = [];
  const r = await structured(Schema, { system: 's', user: 'u', onUsage: (u) => got.push(u) }, cfg(m.url));
  t('结果正常返回', r.answer === 'ok');
  t('重试的那次也计入用量（2 次）', got.length === 2, `${got.length} 次`);
  t('token 数如实转达', got[0]?.prompt === 100 && got[0]?.completion === 50);
  t('cost 有就带上', got[0]?.cost === 0.001);
  m.close();
}

console.log('\n⑩ OpenRouter 才发用量记账字段，别的端点不发');
{
  const m1 = await mock(() => reply('{"answer":"a","n":1}'));
  await structured(Schema, { system: 's', user: 'u' }, cfg(m1.url));
  t('普通端点不带 usage 字段', !('usage' in (m1.seen[0] as object)));
  m1.close();

  // baseUrl 里带 openrouter 就该带上记账字段 —— 用路径伪装一个
  const m2 = await mock(() => reply('{"answer":"b","n":2}'));
  await structured(Schema, { system: 's', user: 'u' }, { ...cfg(m2.url), baseUrl: `${m2.url}/openrouter` });
  t('OpenRouter 端点带 usage:{include:true}',
    JSON.stringify((m2.seen[0] as any).usage) === '{"include":true}');
  m2.close();
}

console.log('\n⑪ 空响应自动重试一次');
{
  // 上游打嗝：第一次给回 200 但正文为空，第二次正常 —— 用户那次
  // be-about 的「模型没有返回任何内容」就是这种一次性失败
  const m = await mock((_b, n) =>
    n === 1
      ? { body: { choices: [{ message: { content: '' }, finish_reason: 'stop' }] } }
      : reply('{"answer":"recovered","n":7}'));
  const r = await structured(Schema, { system: 's', user: 'u' }, cfg(m.url));
  t('第二次拿到结果', r.answer === 'recovered');
  t('确实重试了（发了 2 次请求）', m.seen.length === 2, `${m.seen.length} 次`);
  m.close();
}

console.log('\n⑫ 连续空响应 → 报错要能排查');
{
  const m = await mock(() => ({
    body: { choices: [{ message: { content: '' }, finish_reason: 'length' }],
            usage: { prompt_tokens: 100, completion_tokens: 7900 } },
  }));
  try {
    await structured(Schema, { system: 's', user: 'u' }, cfg(m.url));
    t('应该抛错', false);
  } catch (e) {
    const msg = (e as Error).message;
    t('说清了 token 花在了哪', msg.includes('7900') && msg.includes('finish_reason'), msg.slice(0, 70));
    t('给了能执行的建议', msg.includes('LLM_MAX_TOKENS'), msg.slice(0, 90));
  }
  t('只重试一次，不无限打钱', m.seen.length === 2, `${m.seen.length} 次`);
  m.close();
}

console.log(`\n${failed ? `✗ ${failed} 项未通过\n` : '✓ 全部通过\n'}`);
process.exit(failed ? 1 : 0);
