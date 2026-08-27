#!/usr/bin/env bash
# 可靠重启：tsx 会 fork 子进程，只杀 wrapper 会留下占着端口的孤儿，
# 于是新进程 EADDRINUSE 启动失败，而请求继续打在旧代码上 —— 静默的假测试。
# 按端口杀才靠谱。
set -u
PORT="${PORT:-5173}"
DB="${TRUE_ENGLISH_DB:-data/true-english.db}"

for pid in $(fuser -n tcp "$PORT" 2>/dev/null); do kill -9 "$pid" 2>/dev/null; done
sleep 0.6

TRUE_ENGLISH_DB="$DB" PORT="$PORT" nohup npx tsx src/server/index.ts > /tmp/srv.log 2>&1 &
for _ in $(seq 1 40); do
  curl -sf -m 2 "http://localhost:$PORT/api/health" >/dev/null 2>&1 && { echo "已启动 :$PORT ($DB)"; exit 0; }
  sleep 0.5
done
echo "启动失败："; tail -20 /tmp/srv.log; exit 1
