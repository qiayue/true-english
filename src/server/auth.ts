import crypto from 'node:crypto';
import type http from 'node:http';

/**
 * 单人共享口令鉴权。
 *
 * 威胁模型：这是一个自用工具，部署在公网上。要防的是「别人拿到 URL
 * 就能读写我的数据、烧我的 API 额度」，不是要防定向攻击。
 * 所以一个足够长的共享口令 + HttpOnly cookie + 登录限速就够了。
 *
 * **失败安全设计**：没设 TRUE_ENGLISH_TOKEN 时，服务器只绑 127.0.0.1。
 * 这样「忘了配口令」的后果是本地能用、公网连不上，
 * 而不是「无鉴权的实例裸奔在公网上」—— 后者是不可接受的失败模式。
 */
const TOKEN = process.env.TRUE_ENGLISH_TOKEN ?? '';
export const AUTH_ON = TOKEN.length > 0;
export const BIND_HOST = AUTH_ON ? '0.0.0.0' : '127.0.0.1';
export const COOKIE = 'te_session';

if (AUTH_ON && TOKEN.length < 16) {
  console.error('\n  TRUE_ENGLISH_TOKEN 太短了（至少 16 个字符）。');
  console.error('  生成一个：  node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'base64url\'))"\n');
  process.exit(1);
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest();
/** cookie 里存口令的哈希，而不是口令本身 —— cookie 泄漏时不至于连带交出口令 */
const EXPECTED = AUTH_ON ? sha(TOKEN).toString('hex') : '';

function safeEqual(a: string, b: string): boolean {
  // 先哈希再比，保证长度一致，timingSafeEqual 才不会因长度不同直接抛错
  return crypto.timingSafeEqual(sha(a), sha(b));
}

// —— 登录限速：防口令被暴力猜 ——
const MAX_FAILS = 8;
const WINDOW_MS = 15 * 60 * 1000;
const fails = new Map<string, { n: number; until: number }>();

function clientIp(req: http.IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0];
  return (first ?? req.socket.remoteAddress ?? 'unknown').trim();
}

export function isLockedOut(req: http.IncomingMessage): boolean {
  const rec = fails.get(clientIp(req));
  if (!rec) return false;
  if (Date.now() > rec.until) {
    fails.delete(clientIp(req));
    return false;
  }
  return rec.n >= MAX_FAILS;
}

function noteFail(req: http.IncomingMessage): void {
  const ip = clientIp(req);
  const rec = fails.get(ip);
  if (rec && Date.now() <= rec.until) rec.n++;
  else fails.set(ip, { n: 1, until: Date.now() + WINDOW_MS });
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function isAuthed(req: http.IncomingMessage): boolean {
  if (!AUTH_ON) return true;
  const c = parseCookies(req.headers.cookie)[COOKIE];
  if (!c || c.length !== EXPECTED.length) return false;
  return safeEqual(c, EXPECTED);
}

/** 校验口令。成功返回要下发的 Set-Cookie，失败返回 null 并计入限速。 */
export function login(req: http.IncomingMessage, candidate: string): string | null {
  if (!AUTH_ON) return null;
  if (!safeEqual(candidate, TOKEN)) {
    noteFail(req);
    return null;
  }
  fails.delete(clientIp(req));
  // 反代后面看 x-forwarded-proto 判断是否 HTTPS；本地 http 调试不能加 Secure，否则 cookie 不落地
  const https = req.headers['x-forwarded-proto'] === 'https';
  return [
    `${COOKIE}=${EXPECTED}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=' + 60 * 60 * 24 * 90,
    ...(https ? ['Secure'] : []),
  ].join('; ');
}

export const LOGIN_PAGE = `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>true-english</title><style>
:root{--paper:#EBEEE9;--surface:#F6F7F4;--ink:#20252A;--faint:#818C93;--rule:#D2D8CF;--zhu:#B23A28;--qing:#1E5F58}
@media(prefers-color-scheme:dark){:root{--paper:#15181A;--surface:#1C2124;--ink:#E3E7E2;--faint:#7B858A;--rule:#2C3336;--zhu:#E37963;--qing:#63B5A6}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--paper);color:var(--ink);
font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;padding:1.5rem}
form{width:100%;max-width:20rem;display:flex;flex-direction:column;gap:.75rem}
h1{font-size:1.1rem;margin:0 0 .3rem;letter-spacing:.02em}
p{margin:0;color:var(--faint);font-size:.85rem}
input{width:100%;font-family:ui-monospace,Menlo,monospace;font-size:.9rem;padding:.6rem .75rem;
background:var(--surface);color:var(--ink);border:1px solid var(--rule);border-radius:3px}
input:focus{outline:2px solid var(--qing);outline-offset:-1px;border-color:transparent}
button{font:inherit;font-size:.9rem;padding:.55rem 1rem;border-radius:3px;cursor:pointer;
background:var(--ink);color:var(--paper);border:1px solid var(--ink)}
.err{color:var(--zhu);font-size:.85rem;min-height:1.2em}
</style></head><body>
<form method="POST" action="/login">
<h1>true-english</h1>
<p>输入访问口令</p>
<input type="password" name="token" autofocus autocomplete="current-password" required>
<button type="submit">进入</button>
<div class="err">__ERR__</div>
</form></body></html>`;
