/**
 * 静音 node:sqlite 的实验特性警告。
 *
 * 必须作为**第一个 import** 引入：ESM 按 import 顺序深度优先执行，
 * 这个模块要赶在任何 `open()` 触发警告之前把 emitWarning 换掉。
 * 服务端入口（server/index.ts）自己内联了同样的逻辑 —— 它是动态 import
 * 的薄壳，不能依赖这里。
 *
 * 这是我们主动选择的依赖，不是意外，没必要每条命令都吓用户一跳。
 */
const warn = process.emitWarning;
process.emitWarning = ((msg: unknown, ...rest: unknown[]) => {
  if (typeof msg === 'string' && msg.includes('SQLite is an experimental feature')) return;
  return (warn as (...a: unknown[]) => void)(msg, ...rest);
}) as typeof process.emitWarning;

export {};
