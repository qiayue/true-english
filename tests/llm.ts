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

console.log(`\n${failed ? `✗ ${failed} 项未通过\n` : '✓ 全部通过\n'}`);
process.exit(failed ? 1 : 0);
