# LearnFlow + Role Atlas + Graph Hub 单机部署

这个配置把 LearnFlow、Role Atlas 作为两个一级产品部署，把 Graph Hub 作为独立域名的共享发现入口。Graph Hub 首版复用 Role Atlas 的只读 `/hub` 页面与发布数据，但不改变产品归属；后续可以独立拆服务而不改变岗位包交接协议。

## 上线前

以下命令均在本仓库 `apps/role-atlas/deploy/cohost/` 中执行。`LEARNFLOW_REPO_PATH` 默认为 `../../../..`，即同仓 LearnFlow 根目录，不再要求另一个 checkout；目录不同时可以用环境变量覆盖。源码同仓不合并进程、数据库与密钥配置，推送也不会自动部署或迁移数据。

1. 复制 `.env.example` 为 `.env`，填写三个同根域名。`AUTH_COOKIE_DOMAIN` 必须是共同父域，例如 `.example.com`。
2. 生成三个独立密钥：`AUTH_RUNTIME_BRIDGE_TOKEN` 至少 32 字符；`AUTH_API_KEY_KEK` 是 32 随机字节的 URL-safe Base64；`ROLE_PACKAGE_LAUNCH_SECRET` 至少 32 字节并由两产品共享。
3. 把 DNS 的三个域名都指向服务器。Caddy 会自动申请 HTTPS 证书。
4. 确认 Role Atlas `packages/` 中含 LearnFlow 要读取的已发布岗位包；公共 Graph Hub 目录应导出到 `output/graph-hub/catalogs/public.json`。个人未审核目录放在 `output/graph-hub/subjects/<sha256(learnflow:learner:<id>)>/catalog.json`，由 Graph Hub 用该主体执行 `export-view` 生成；LearnFlow 会按当前正式 learner id 确定性选择目录，不接受模型传 owner。新 Release 发布后，先通过 `/api/releases/<releaseId>/export?format=json` 下载，再执行 LearnFlow 的 `npm run role:import-file -- --file <文件> --root <role-agent/packages>`，随后重启 `learnflow-frontend`；这样生产进程会重新建立不可变岗位包索引。

## 从现有本地环境迁移数据

停掉本地写入后，把下面内容复制到服务器临时目录（例如 `/opt/ceg/migration`）：

- LearnFlow `backend/learnflow.db`；
- LearnFlow `backend/data/`（资料缓存与上传原件）；
- LearnFlow `backend/runtime/workspaces/`（若需要保留练习工作区）；不要迁移本机
  `runtime/learnflow-runtime` 虚拟环境，macOS 环境不能在 Linux 容器中复用；
- Role Atlas `.wrangler/`（本地 D1/Miniflare 状态）；
- Role Atlas `output/graph-hub/`（若已经生成目录）；
- 两产品原有密钥。迁移已有账号的加密模型密钥时，必须继续使用原来的 `AUTH_API_KEY_KEK`。

先构建并创建容器和卷，不启动对外服务：

```bash
mkdir -p ../../output/graph-hub
docker compose --env-file .env build
docker compose --env-file .env create
```

然后通过 Compose 服务把备份恢复到它们实际使用的卷，避免依赖 Docker 自动生成的卷名：

```bash
docker compose --env-file .env run --rm --no-deps \
  -v /opt/ceg/migration/learnflow:/migration:ro \
  learnflow-backend sh -c \
  'cp /migration/learnflow.db /data/learnflow.db && cp -a /migration/data/. /data/ && mkdir -p /data/runtime/workspaces && cp -a /migration/workspaces/. /data/runtime/workspaces/'

docker compose --env-file .env run --rm --no-deps \
  -v /opt/ceg/migration/role-wrangler:/migration:ro \
  role-atlas sh -c 'cp -a /migration/. /app/.wrangler/'
```

如果某个可选目录不存在，就从对应命令中删除那一段 `cp`。恢复完成后再执行下面的启动命令。

## 启动

```bash
docker compose --env-file .env up -d --build
```

验证 `https://learn.example.com`、`https://roles.example.com` 和 `https://graphs.example.com/hub`。在 LearnFlow 登录后，三个子域共享同一 HttpOnly 会话；Graph Hub 的“在 LearnFlow 中使用”会签发最多 15 分钟且绑定当前学习者的令牌，在 LearnFlow 创建新对话并固定岗位包插件引用。

## 当前单机边界

引用代理使用 Node HTTP/HTTPS 请求读取上游，明确保留目录请求的 `Host: localhost`，与 Caddy 的 Atlas 转发一致。不要换成忽略自定义 Host 的 Node `fetch`，否则内部 `role-atlas` 主机会被 Vite 拒绝（403），用户收到 `ROLE_ATLAS_REGISTRY_UNAVAILABLE`。上游请求保留 10 秒空闲超时、不自动跟随重定向；没有放宽 Vite 主机白名单或改变主体绑定签名契约。回归入口：`tests/cohost-launch-proxy.test.ts`。

Role Atlas 当前继续使用其 Cloudflare/Miniflare D1 兼容存储，状态保存在 `role-atlas-state` volume；这是首发单机配置，不是多副本数据库方案。扩成多实例前，应把 D1/R2 接到正式 Cloudflare 资源或实现 PostgreSQL/对象存储适配，并把公共与个人 Graph Hub 目录改为服务端按主体实时导出。
