/**
 * 交互质量审计。
 *
 * 和 smoke 分工不同：smoke 查「功能对不对」，这个查「用起来会不会出事」——
 * 横向溢出、重复提交、键盘走不通、空状态没提示。
 * 这些不会让断言变红，但会让人用得难受，而且我自己不主动查就永远发现不了。
 *
 * 每条检查都必须是**行为验证**，不是静态查源码。
 * 我为此返过一次工：先写成「查 handler 里有没有 disabled」，
 * 而防重是在 onclick 赋值处统一拦的，源码里根本看不到 —— 于是全员误报。
 * 每加一条新检查，都要摘掉对应的实现确认它真的会红。
 *
 *   node scripts/audit.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
const B = 'http://localhost:5173';
const found = [];
const note = (sev, what) => found.push(`${sev} ${what}`);

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

// ① 手机宽度
{
  const p = await b.newPage({ viewport: { width: 375, height: 700 } });
  await p.goto(B); await p.waitForTimeout(400);
  const overflow = await p.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 2) note('✗', `手机宽度(375) 横向溢出 ${overflow}px`);
  await p.click('nav button[data-tab="settings"]'); await p.waitForTimeout(400);
  const o2 = await p.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (o2 > 2) note('✗', `设置页手机宽度横向溢出 ${o2}px`);
  // 触摸目标大小
  const small = await p.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll('button:not(.hidden)')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.height < 32) bad.push(`${el.id || el.className}:${Math.round(r.height)}px`);
    }
    return bad;
  });
  if (small.length) note('△', `触摸目标偏小(<32px)：${small.slice(0, 4).join(', ')}`);
  await p.close();
}

// ② 异步按钮的重复点击保护 —— 验证真实行为，不看源码
// （静态查 handler 里有没有 disabled 会误报：防重是在 onclick 赋值处
//   统一拦的，源码里根本看不到。行为测试才作数。）
{
  const p = await b.newPage();
  const hits = [];
  p.on('request', (r) => { if (r.url().includes('/api/')) hits.push(r.url()); });
  await p.goto(B); await p.waitForTimeout(400);
  await p.fill('#raw', 'Most of my best decisions looked boring at the time.');
  hits.length = 0;
  // 同一个事件循环里连点三次 —— 这才是真正的双击/手抖场景。
  // 用 Playwright 的三次 click 是串行的，本地 5ms 就跑完一次，
  // 测不出防重，只会测出「点三次发三次请求」这个正常现象。
  await p.evaluate(() => {
    const el = document.querySelector('#btn-ingest');
    el.click(); el.click(); el.click();
  });
  await p.waitForTimeout(900);
  const ingestCalls = hits.filter((u) => u.includes('/api/ingest')).length;
  if (ingestCalls > 1) note('✗', `连点三次「筛选」发出了 ${ingestCalls} 次请求，没防住重复提交`);
  await p.close();
}

// ③ 整段模式的键盘提交
{
  const p = await b.newPage();
  await p.goto(B); await p.waitForTimeout(300);
  const hasCtrlEnter = await p.evaluate(() => {
    const src = [...document.scripts].map((s) => s.textContent).join('\n');
    return /#attempt.*addEventListener\('keydown'/s.test(src) ||
           src.includes("$('#attempt').addEventListener('keydown'");
  });
  if (!hasCtrlEnter) note('✗', '整段模式没有键盘提交（只能点鼠标）');
  await p.close();
}

// ④ 空状态
{
  const p = await b.newPage();
  await p.goto(B); await p.waitForTimeout(300);
  for (const [tab, sel] of [['corpus', '#corpus-out'], ['report', '#report-out']]) {
    await p.click(`nav button[data-tab="${tab}"]`); await p.waitForTimeout(600);
    const txt = (await p.textContent(sel)).trim();
    if (!txt) note('✗', `${tab} 标签页空状态什么都不显示`);
  }
  await p.close();
}

// ⑤ 焦点可见性（键盘导航）
{
  const p = await b.newPage();
  await p.goto(B); await p.waitForTimeout(300);
  const noFocus = await p.evaluate(() => {
    const src = [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules].map((r) => r.cssText); } catch { return []; } }).join('\n');
    return !src.includes(':focus-visible');
  });
  if (noFocus) note('△', 'CSS 里没有 :focus-visible 样式，键盘导航看不见焦点');
  await p.close();
}

await b.close();
const blocking = found.filter((f) => f.startsWith('✗'));
console.log(found.length ? '\n交互审计：\n  ' + found.join('\n  ') + '\n' : '\n✓ 交互审计通过\n');
process.exit(blocking.length ? 1 : 0);
