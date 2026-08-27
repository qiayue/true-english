#!/usr/bin/env bash
#
# 完整验收：起一个干净的服务，跑冒烟 + 交互审计，跑完收摊。
#
# 用独立端口和独立数据库（5174 / /tmp/te-verify.db），两个理由：
#
#  1. 冒烟测试会往库里导卡片。以前 verify 直接打 5173，等于每验收一次
#     就往你自己的库里塞一张 Cloudflare 测试卡，还会把练习进度搅乱。
#  2. 你开着 npm run dev 在用的时候也能验收，两边互不影响。
#
set -eu
PORT=5174
DB=/tmp/te-verify.db

rm -f "$DB"
PORT="$PORT" TRUE_ENGLISH_DB="$DB" bash "$(dirname "$0")/restart.sh"
cleanup() { for pid in $(fuser -n tcp "$PORT" 2>/dev/null); do kill -9 "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT

BASE="http://localhost:$PORT" node "$(dirname "$0")/smoke.mjs"
BASE="http://localhost:$PORT" node "$(dirname "$0")/audit.mjs"
