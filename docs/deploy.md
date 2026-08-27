# 部署

## 先理解三个约束

**① 没设 `TRUE_ENGLISH_TOKEN` 就只绑 127.0.0.1。**
这是故意的失败安全设计：「忘了配口令」的后果是公网连不上，
而不是「无鉴权实例裸奔在公网上」。后者是不可接受的失败模式 ——
任何人拿到 URL 就能读写你的数据，还能烧你的 API 额度。

**② 必须有持久磁盘。**
`node:sqlite` 写本地文件。Vercel / Cloudflare Workers 这类无状态 serverless
每次冷启动都是干净文件系统，数据会丢。必须是带持久卷的容器平台或 VPS。

**③ 现在是单人应用。**
表里没有 `user_id`。将来多用户最省事的路径是**一个用户一个 SQLite 文件**
（`store.open(file)` 已经接受路径参数，按用户路由即可），schema 一行都不用改。

---

## 方案 A：Fly.io（推荐，单人使用基本零成本）

闲置自动停机、有请求再拉起，一个月大概率在免费额度内。

```bash
# 1. 装 flyctl 并登录
curl -L https://fly.io/install.sh | sh
fly auth login

# 2. 起个全局唯一的 app 名（true-english 多半被占了）
fly apps create your-true-english

# 3. 把 fly.toml 里的 app 名和区域改掉
#    app = "your-true-english"
#    primary_region = "nrt"   # nrt 东京 / sin 新加坡 / hkg 香港 / lax 洛杉矶

# 4. 建持久卷（region 要和 primary_region 一致）
fly volumes create true_english_data --size 1 --region nrt

# 5. 设访问口令 —— 这一步不能跳
fly secrets set TRUE_ENGLISH_TOKEN="$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")"

# 想要自动批改再加这个（不加就用手工批改模式）
# fly secrets set ANTHROPIC_API_KEY=sk-ant-...

# 6. 部署
fly deploy
```

口令看这里：`fly secrets list` 只显示摘要，看不到原文 ——
所以第 5 步生成的时候就存好。或者自己指定一个：
`fly secrets set TRUE_ENGLISH_TOKEN="你自己定的长口令"`（至少 16 位，短了服务器会拒绝启动）。

**更新**：`fly deploy`
**看日志**：`fly logs`
**备份数据库**：`fly ssh sftp get /data/true-english.db ./backup.db`

---

## 方案 B：自己的 VPS

```bash
git clone <repo> && cd true-english
npm ci --omit=dev

# 用 systemd 或 pm2 常驻，前面套 Caddy/nginx 做 HTTPS
TRUE_ENGLISH_TOKEN="长口令" \
TRUE_ENGLISH_DB=/var/lib/true-english/db.sqlite \
PORT=8080 npm start
```

**HTTPS 不是可选项。** 口令是明文发过去的，没有 HTTPS 等于公开。
Caddy 两行配置就能自动签证书：

```
your-domain.com {
    reverse_proxy localhost:8080
}
```

反代要透传 `X-Forwarded-Proto`（Caddy 默认就传），
否则登录 cookie 不会带 `Secure` 标记。

---

## 方案 C：本机跑（最简单，先自己用就选这个）

```bash
npm install
npm run dev          # → http://localhost:5173
```

**要 Node 22.5+**（`node:sqlite` 是 22.5 才加的）。版本不够会被拦下并给出升级指引。

不用配任何东西。没设 `TRUE_ENGLISH_TOKEN` 时只绑 `127.0.0.1` ——
本机能用、公网连不到，正是本机自用想要的。

- 端口撞了（5173 是 Vite 默认端口）：`PORT=5300 npm run dev`
- 想先看效果：另开终端跑 `npm run seed:example`
- 数据在 `data/true-english.db`，删掉就是重来
- 备份：把那个文件拷走就行

**想在手机上用**：装 Tailscale，手机和电脑连同一个 tailnet，
用电脑的 tailnet IP 访问。但注意 —— 这时服务器还是只绑 `127.0.0.1`，
Tailscale 访问不到。要么设一个 `TRUE_ENGLISH_TOKEN`（会改绑 `0.0.0.0`，
但 Tailscale 网络本身已经是私有的），要么用 `tailscale serve` 做本地转发。

---

## 我没能验证的部分

这个开发环境里没有 docker daemon，也没有 Fly 账号，所以**镜像构建和实际部署我没跑过**。
我验证到的是：按 `.dockerignore` 的文件集合 + `npm ci --omit=dev` 之后，
应用能正常启动、鉴权正常、难度打分器能读到资源文件、绝对路径持久卷能建库。

第一次 `fly deploy` 如果失败，把 `fly logs` 贴给我。
