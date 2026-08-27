/**
 * 界面完整性检查。
 *
 * 存在的理由：我曾经用「从 X 替换到 Y」的大范围改写重写状态机，
 * 没检查那个区间里还有什么，连带删掉了三个按钮的 handler 和一个渲染函数。
 * 页面照常渲染、JS 语法照常通过、截图测试照常绿 —— 因为那条路径根本没被走到。
 * 用户点了才发现按钮是死的。
 *
 * 静态检查挡不住所有问题，但能挡住「按钮没接线」这一类，成本几乎为零。
 */
import fs from 'node:fs';

const html = fs.readFileSync('src/server/app.html', 'utf8');
const errs = [];

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

// ③ 被调用的函数都得有定义（漏删函数体是同一类事故）
for (const fn of ['renderReview', 'renderStep', 'renderDiff', 'setMode', 'setPhase', 'loadCards', 'openCard']) {
  if (!new RegExp(`function ${fn}\\b`).test(html)) errs.push(`函数 ${fn} 不见了`);
}

// ④ 语法
const body = html.match(/<script type="module">([\s\S]*)<\/script>/)?.[1] ?? '';
try { new Function(body); } catch (e) { errs.push(`JS 语法错误: ${e.message}`); }

if (errs.length) {
  console.error('\n界面检查未通过：');
  for (const e of errs) console.error('  ✗ ' + e);
  console.error('');
  process.exit(1);
}
console.log(`✓ 界面检查通过（${new Set(ids).size} 个按钮、${new Set(refs).size} 个元素引用）`);
