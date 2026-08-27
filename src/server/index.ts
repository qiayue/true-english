import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from '../core/store.js';
import * as api from './api.js';
import { ApiError } from './api.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(here, 'app.html');

const PORT = Number(process.env.PORT ?? 5173);
const DB_FILE = process.env.TRUE_ENGLISH_DB ?? 'data/true-english.db';
const db = open(DB_FILE);

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
    return { hasKey: api.hasCredentials(), db: DB_FILE };
  }
  if (m === 'GET' && pathname === '/api/cards') return { cards: api.listCards(db) };
  if (m === 'GET' && pathname === '/api/corpus') {
    return api.corpus(db, url.searchParams.get('fn') ?? undefined);
  }
  if (m === 'GET' && pathname === '/api/progress') return api.report(db);

  const practice = pathname.match(/^\/api\/cards\/([\w-]+)\/practice$/);
  if (m === 'GET' && practice) return api.practiceCard(db, practice[1]!);

  if (m === 'POST') {
    const body = await readBody(req);

    if (pathname === '/api/ingest') return { tweets: api.ingest(str(body.text, 'text')) };

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

    const grade = pathname.match(/^\/api\/cards\/([\w-]+)\/grade-request$/);
    if (grade) return api.gradingRequest(db, grade[1]!, str(body.attempt, 'attempt'));

    const auto = pathname.match(/^\/api\/cards\/([\w-]+)\/review$/);
    if (auto) return api.submitAttempt(db, auto[1]!, str(body.attempt, 'attempt'));

    if (pathname === '/api/reviews/import') {
      return api.importReview(db, str(body.cardId, 'cardId'), str(body.attempt, 'attempt'), str(body.json, 'json'));
    }

    if (pathname === '/api/compose') {
      return api.compose(db, str(body.text, 'text'), body.posted === true);
    }
  }

  throw new ApiError('没有这个接口', 404);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

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

server.listen(PORT, () => {
  const mode = api.hasCredentials() ? '自动批改' : '手工批改（未检测到 API key）';
  console.log(`\n  true-english  ·  ${mode}`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  数据库 ${DB_FILE}\n`);
});
