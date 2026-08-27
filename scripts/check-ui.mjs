/**
 * 界面完整性检查。
 *
 * 存在的理由是两次真实事故，都是同一个动作造成的：
 * 用「从 X 替换到 Y」的大范围改写重写一段 JS，没检查那个区间里还有什么。
 *
 *   第一次 —— 吞掉了 btn-submit / btn-back / btn-copy-grade / btn-import-grade
 *            四个 handler 和 renderReview 函数。按钮点了没反应。
 *   第二次 —— 吞掉了 let STEP / USED_HINT / DONE_EN 三行声明。
 *            openCard 一进来就 ReferenceError，卡片根本打不开。
 *
 * 两次都是：页面照常渲染、JS 语法照常通过、tsc 照常干净 ——
 * 因为这些都是运行时才炸的。静态检查挡不住所有问题，
 * 但挡住这两类的成本几乎为零。
 *
 *   node scripts/check-ui.mjs
 */
import fs from 'node:fs';

const html = fs.readFileSync('src/server/app.html', 'utf8');
const body = html.match(/<script type="module">([\s\S]*)<\/script>/)?.[1] ?? '';
const errs = [];

if (!body) errs.push('找不到 <script type="module"> 块');

// ① 每个 id="btn-*" 都必须绑上 handler。
// 两种写法都算：直接 $('#x').onclick，以及动态生成后先取到变量再绑
// （const nb = $('#x'); if (nb) nb.onclick = ...）。
// 后者在动态插入的节点上是正常写法，不该为了迁就检查器把代码写歪。
const ids = [...html.matchAll(/id="(btn-[\w-]+)"/g)].map((m) => m[1]);
for (const id of new Set(ids)) {
  if (html.includes(`$('#${id}').onclick`)) continue;
  const at = html.indexOf(`$('#${id}')`);
  if (at >= 0 && html.slice(at, at + 240).includes('onclick')) continue;
  errs.push(`按钮 ${id} 没有 handler`);
}

// ② JS 里引用的每个 $('#x') 都必须在 HTML 里真的存在
const refs = [...html.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]);
for (const id of new Set(refs)) {
  if (!new RegExp(`id="${id}"`).test(html)) errs.push(`JS 引用了不存在的元素 #${id}`);
}

// ③ 被调用的函数都得有定义
for (const fn of ['renderReview', 'renderFinish', 'renderStep', 'renderDiff',
                  'setMode', 'setPhase', 'loadCards', 'openCard', 'reportStep']) {
  if (!new RegExp(`function ${fn}\\b`).test(body)) errs.push(`函数 ${fn} 不见了`);
}

// ④ 模块级状态变量必须有声明。
// 约定：模块级状态用 UPPER_SNAKE 命名，逐个查它们有没有被 let/const/var 声明过。
const assigned = [...body.matchAll(/^\s*([A-Z][A-Z0-9_]{1,})\s*=[^=]/gm)].map((m) => m[1]);
for (const name of new Set(assigned)) {
  if (!new RegExp(`\\b(let|const|var)\\s+[^;\\n]*\\b${name}\\b`).test(body)) {
    errs.push(`变量 ${name} 被赋值但从未声明（大范围改写时最容易连带删掉）`);
  }
}

// ⑤ 语法
try { new Function(body); } catch (e) { errs.push(`JS 语法错误: ${e.message}`); }

if (errs.length) {
  console.error('\n界面检查未通过：');
  for (const e of errs) console.error('  ✗ ' + e);
  console.error('');
  process.exit(1);
}
console.log(`✓ 界面检查通过（${new Set(ids).size} 个按钮、${new Set(refs).size} 个元素引用、${new Set(assigned).size} 个状态变量）`);
