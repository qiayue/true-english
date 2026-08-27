import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from '../core/store.js';
import * as api from './api.js';
import { ApiError } from './api.js';
import { AUTH_ON, BIND_HOST, LOGIN_PAGE, isAuthed, isLockedOut, login } from './auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(here, 'app.html');

const PORT = Number(process.env.PORT ?? 5173);
const DB_FILE = process.env.TRUE_ENGLISH_DB ?? 'data/true-english.db';
const db = open(DB_FILE);

function readRaw(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 2_000_000) {
        reject(new ApiError('请求过大', 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 2_000_000) {
        reject(new ApiError('请求过大', 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        reject(new ApiError('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function str(v: unknown, field: string): string {
  if (typeof v !== 'string') throw new ApiError(`缺少字段 ${field}`);
  return v;
}
function strArray(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new ApiError(`字段 ${field} 必须是字符串数组`);
  }
  return v as string[];
}

async function route(req: http.IncomingMessage, url: URL): Promise<unknown> {
  const { pathname } = url;
  const m = req.method ?? 'GET';

  if (m === 'GET' && pathname === '/api/health') {
    return { hasKey: api.hasCredentials(db), db: DB_FILE };
  }
  if (m === 'GET' && pathname === '/api/settings') return api.getSettings(db);
  if (m === 'GET' && pathname === '/api/cards') return { cards: api.listCards(db) };
  if (m === 'GET' && pathname === '/api/corpus') {
    return api.corpus(db, url.searchParams.get('fn') ?? undefined);
  }
  if (m === 'GET' && pathname === '/api/progress') return api.report(db);
  if (m === 'GET' && pathname === '/api/compose/deck') {
    const n = Number(url.searchParams.get('n') ?? '');
    return api.composeDeck(db, Number.isFinite(n) && n > 0 ? n : 3,
                           url.searchParams.get('not') ?? undefined);
  }
  if (m === 'GET' && pathname === '/api/compose/history') return api.composeHistory(db);
  if (m === 'GET' && pathname === '/api/today') {
    const b = Number(url.searchParams.get('budget') ?? '');
    return api.todayQueue(db, Number.isFinite(b) && b > 0 ? b : undefined);
  }

  const practice = pathname.match(/^\/api\/cards\/([\w-]+)\/practice$/);
  if (m === 'GET' && practice) {
    return api.practiceCard(db, practice[1]!, url.searchParams.get('stage') ?? undefined);
  }

  const copyM = pathname.match(/^\/api\/cards\/([\w-]+)\/steps\/(\d+)\/copy$/);
  if (m === 'GET' && copyM) return api.copyTarget(db, copyM[1]!, Number(copyM[2]));

  const clozeM = pathname.match(/^\/api\/cards\/([\w-]+)\/steps\/(\d+)\/cloze$/);
  if (m === 'GET' && clozeM) return api.clozeTarget(db, clozeM[1]!, Number(clozeM[2]));

  const hintM = pathname.match(/^\/api\/cards\/([\w-]+)\/steps\/(\d+)\/hint$/);
  if (m === 'GET' && hintM) {
    return api.stepHint(db, hintM[1]!, Number(hintM[2]), Number(url.searchParams.get('level') ?? 1));
  }

  if (m === 'POST') {
    const body = await readBody(req);

    if (pathname === '/api/settings') {
      return api.putSettings(db, {
        ...(typeof body.baseUrl === 'string' ? { baseUrl: body.baseUrl } : {}),
        ...(typeof body.apiKey === 'string' ? { apiKey: body.apiKey } : {}),
        ...(typeof body.model === 'string' ? { model: body.model } : {}),
      });
    }
    if (pathname === '/api/settings/test') return api.testSettings(db);
    if (pathname === '/api/settings/models') return api.listModels(db);
    if (pathname === '/api/settings/clear-key') return api.dropKey(db);

    if (pathname === '/api/ingest') return api.ingest(str(body.text, 'text'));

    if (pathname === '/api/cards/request') return api.cardRequest(strArray(body.texts, 'texts'));
    if (pathname === '/api/cards/import') {
      return { cards: api.importCards(db, strArray(body.texts, 'texts'), str(body.json, 'json')) };
    }
    if (pathname === '/api/cards/auto') {
      const texts = strArray(body.texts, 'texts');
      const cards = [];
      for (const t of texts) cards.push(await api.createCard(db, t));
      return { cards };
    }

    const stepM = pathname.match(/^\/api\/cards\/([\w-]+)\/steps\/(\d+)\/check$/);
    if (stepM) return api.checkStep(db, stepM[1]!, Number(stepM[2]), str(body.text, 'text'));

    const delM = pathname.match(/^\/api\/cards\/([\w-]+)\/delete$/);
    if (delM) return api.removeCard(db, delM[1]!);

    const clozeCk = pathname.match(/^\/api\/cards\/([\w-]+)\/steps\/(\d+)\/cloze$/);
    if (clozeCk) {
      const a = Array.isArray(body.answers) ? body.answers.map((x) => String(x)) : [];
      return api.clozeCheck(db, clozeCk[1]!, Number(clozeCk[2]), a);
    }

    const doneM = pathname.match(/^\/api\/cards\/([\w-]+)\/steps\/(\d+)\/done$/);
    if (doneM) {
      return api.finishStep(db, doneM[1]!, Number(doneM[2]), {
        tries: typeof body.tries === 'number' ? body.tries : 1,
        hinted: body.hinted === true,
        copied: body.copied === true,
        accepted: body.accepted === true,
      });
    }

    const grade = pathname.match(/^\/api\/cards\/([\w-]+)\/grade-request$/);
    if (grade) return api.gradingRequest(db, grade[1]!, str(body.attempt, 'attempt'));

    const auto = pathname.match(/^\/api\/cards\/([\w-]+)\/review$/);
    if (auto) return api.submitAttempt(db, auto[1]!, str(body.attempt, 'attempt'));

    if (pathname === '/api/reviews/import') {
      return api.importReview(db, str(body.cardId, 'cardId'), str(body.attempt, 'attempt'), str(body.json, 'json'));
    }

    if (pathname === '/api/reuse') return api.checkReuse(db, str(body.text, 'text'));

    if (pathname === '/api/compose') {
      return api.compose(
        db, str(body.text, 'text'), body.posted === true,
        typeof body.compId === 'string' ? body.compId : undefined,
      );
    }
    if (pathname === '/api/compose/review') {
      return api.submitComposition(
        db, str(body.text, 'text'), body.posted === true,
        typeof body.compId === 'string' ? body.compId : undefined,
      );
    }
    if (pathname === '/api/compose/grade-request') {
      return api.composeGradeRequest(db, str(body.text, 'text'));
    }
    if (pathname === '/api/compose/import') {
      return api.importComposeReview(
        db, str(body.text, 'text'), body.posted === true, str(body.json, 'json'),
        typeof body.compId === 'string' ? body.compId : undefined,
      );
    }
  }

  throw new ApiError('没有这个接口', 404);
}

function sendHtml(res: http.ServerResponse, body: string, status = 200, extra: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...extra });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // —— 登录 ——
  if (AUTH_ON && url.pathname === '/login') {
    if (req.method === 'GET') {
      sendHtml(res, LOGIN_PAGE.replace('__ERR__', ''));
      return;
    }
    if (req.method === 'POST') {
      if (isLockedOut(req)) {
        sendHtml(res, LOGIN_PAGE.replace('__ERR__', '尝试太多次了，15 分钟后再试。'), 429);
        return;
      }
      void readRaw(req)
        .then((raw) => {
          const token = new URLSearchParams(raw).get('token') ?? '';
          const cookie = login(req, token);
          if (!cookie) {
            sendHtml(res, LOGIN_PAGE.replace('__ERR__', '口令不对。'), 401);
            return;
          }
          res.writeHead(303, { location: '/', 'set-cookie': cookie });
          res.end();
        })
        .catch(() => sendHtml(res, LOGIN_PAGE.replace('__ERR__', '出错了，重试一下。'), 400));
      return;
    }
  }

  // —— 鉴权闸门：页面和 API 都走这里 ——
  if (!isAuthed(req)) {
    if (url.pathname.startsWith('/api/')) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '未登录' }));
    } else {
      res.writeHead(303, { location: '/login' });
      res.end();
    }
    return;
  }

  // 浏览器总会去要 favicon，没有路由就是一条 404。
  // 不是错误，但会污染日志、也会让冒烟测试的「无运行时错误」误报。
  if (url.pathname === '/favicon.ico') {
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=86400' });
    res.end(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
        '<rect width="32" height="32" rx="6" fill="#20252A"/>' +
        '<text x="16" y="23" font-size="19" font-family="serif" fill="#B23A28" ' +
        'text-anchor="middle">朱</text></svg>',
    );
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    fs.createReadStream(HTML).pipe(res);
    return;
  }

  void route(req, url)
    .then((data) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    })
    .catch((e: unknown) => {
      const status = e instanceof ApiError ? e.status : 500;
      const message = e instanceof Error ? e.message : String(e);
      if (status === 500) console.error(e);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: message }));
    });
});

// 5173 是 Vite 的默认端口，本机跑前端项目的人很容易撞上。
// 直接甩一个 EADDRINUSE 堆栈没人看得懂，给出人话和解法。
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`
  端口 ${PORT} 已被占用（5173 是 Vite 的默认端口，很容易撞上）。

  换一个端口：
    PORT=5300 npm run dev

  或者看看是谁占着：
    lsof -i :${PORT}          （macOS / Linux）
    netstat -ano | findstr ${PORT}   （Windows）
`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, BIND_HOST, () => {
  const mode = api.hasCredentials(db) ? '自动批改' : '手工批改（未配置 LLM）';
  console.log(`\n  true-english  ·  ${mode}`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  数据库 ${DB_FILE}`);
  if (AUTH_ON) {
    console.log(`  鉴权 已开启，监听 ${BIND_HOST}`);
  } else {
    console.log(`  鉴权 未开启 —— 只监听 127.0.0.1，公网访问不到`);
    console.log(`       要部署到公网，先设 TRUE_ENGLISH_TOKEN`);
  }
  console.log('');
});
