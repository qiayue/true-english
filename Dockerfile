FROM node:22-slim

WORKDIR /app

# 先只拷清单，让依赖层能被缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production \
    PORT=8080 \
    TRUE_ENGLISH_DB=/data/true-english.db

EXPOSE 8080

# 不做 TypeScript 构建步骤：tsx 直接跑源码。
# 启动慢约 1 秒，换来的是少一套构建产物和资源拷贝逻辑 ——
# 单人自用工具，这个交换是划算的。
CMD ["npx", "tsx", "src/server/index.ts"]
