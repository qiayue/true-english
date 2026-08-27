/**
 * 入口薄壳：先验 Node 版本，再动态导入真正的服务器。
 *
 * 为什么必须拆开：node:sqlite 需要 Node >= 22.5。在更老的版本上，
 * `import ... from 'node:sqlite'` 在**模块链接阶段**就抛 ERR_UNKNOWN_BUILTIN_MODULE，
 * 早于任何模块体执行 —— 所以写在顶层的版本检查根本来不及跑，
 * 用户看到的只有一句没头没尾的 ERR_UNKNOWN_BUILTIN_MODULE。
 * 用动态 import() 把链接推迟到检查之后，才能给出人话错误。
 */

// node:sqlite 目前是实验特性，每次启动都打一行警告。
// 这是我们主动选择的依赖，不是意外，没必要每次都吓用户一跳。
const warn = process.emitWarning;
process.emitWarning = ((msg: unknown, ...rest: unknown[]) => {
  if (typeof msg === 'string' && msg.includes('SQLite is an experimental feature')) return;
  return (warn as (...a: unknown[]) => void)(msg, ...rest);
}) as typeof process.emitWarning;

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
const ok = major > 22 || (major === 22 && minor >= 5);

if (!ok) {
  console.error(`
  Node 版本太低：当前 ${process.versions.node}，需要 22.5 或更高。

  这个项目用 Node 内置的 node:sqlite 存数据（好处是零原生依赖，
  不用编译 better-sqlite3），但它是 22.5 才加进来的。

  升级方式：
    nvm install 22 && nvm use 22        （用 nvm）
    brew install node@22                 （macOS + Homebrew）
    https://nodejs.org                   （直接下载 LTS）
`);
  process.exit(1);
}

await import('./serve.js');

export {};
