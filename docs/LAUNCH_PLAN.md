# 最短上线计划

当前范围：桌面 0.2.0 主窗口默认使用网页同一云端账号、项目、Tutor 和网关；云项目可以绑定本机目录并运行经确认的 C 实验。旧本地工作区保留为明确选择的兼容模式。完整离线合并和自动文件同步尚未实现，见[连接契约](../apps/desktop/docs/implementation/DESKTOP_CLOUD_CONNECTION.md)。

## 1. 准备一台 Linux 服务器和域名

安装 Docker + Compose。将根域名及 `learn`、`roles`、`graphs` 三个子域解析到服务器，开放 80/443。首次使用单实例 API、一个 Memory Worker 与持久数据卷；先不引入 Kubernetes、Redis 或额外对象存储。

Role Atlas 的 Docker 构建同样使用单仓根作为上下文：`docker build -f apps/role-atlas/Dockerfile .`。容器工作目录为 `/app/apps/role-atlas`，共享路径契约位于 `/app/frontend/src`；不要继续使用旧的独立仓构建命令。已有部署升级时，保留原 `role-atlas-state` 卷，将其挂载目标调整为 `/app/apps/role-atlas/.wrangler`，图谱目录对应 `/app/apps/role-atlas/output/graph-hub`。Dockerfile 专属 ignore 文件排除凭据、数据库与本地构建目录。

当前 Role Atlas Compose 仍使用 vinext dev 运行 Cloudflare 本地绑定。这是首发运维限制，不应据此宣称已获得完整生产运行时或高可用；切换到生产运行方式前需验证 D1 持久化与 Worker 绑定。

## 2. 配置并启动

在服务器克隆本仓、进入根目录：

```bash
python3 scripts/prepare_launch.py --domain your-domain.com
# 编辑 apps/role-atlas/deploy/cohost/.env：填写 LearnFlow/Role Atlas 模型密钥、模型名和搜索密钥。
# 默认提供商下，两个模型密钥字段可使用同一把密钥；不要修改已经在用的加密与签名密钥。
bash scripts/launch.sh check
bash scripts/launch.sh up
```

准备脚本以 0600 权限新建配置，自动生成互不相同的签名/邀请密钥和 32 字节加密密钥；已存在配置会拒绝覆盖。检查只显示缺失字段，不打印密钥。Role Atlas 签名网关使用 `https://roles.<域名>`，因此 DNS 与 HTTPS 必须可用。

已有服务器升级时使用原 `.env` 和数据卷，先备份数据库、文件卷及密钥，补齐新增 ROLE_ATLAS_GATEWAY_SECRET，再执行 check/up。不要重新生成 AUTH_API_KEY_KEK，不自动迁移旧桌面数据库。

## 3. 通过上线门槛，再发桌面包

- `https://learn.<域名>/api/platform` 显示 `learning_platform`、共享核心 `0.2.0`、external worker；`/api/architecture/validate` 为 valid。
- 新账号完成一次对话、学习任务、判题与复习；刷新后数据保留，换账号无法读取前一人的项目。
- 岗位页面与 Graph Hub 可访问，固定版本岗位包能交接到同一平台学习账号；模型和搜索凭据不下发客户端。
- `bash scripts/launch.sh status` 检查服务，确认独立 memory worker 运行；停止再启动后数据仍保留。

桌面包构建时固定自己的在线域名：

```bash
npm run build:desktop-sidecar
LEARNFLOW_PLATFORM_URL=https://learn.your-domain.com npm run build:desktop
```

直接在桌面主窗口使用网页账号登录，核对同一项目与复习记录，验证 Tutor 流式回复和岗位网关。在云项目内绑定本机目录，预览并确认实验；确认切换账号后不能访问原账号的目录绑定。云 Cookie 保留在 sidecar 内存，远程网页不能直接调用本地 IPC。重启应用需要重新登录。随后先发给少量内测用户。

## 4. 扩展首发之后的能力

按顺序补：有租约的通用长任务队列 → 离线命令/证据重放 → 选择性文件同步 → 班级课程与作业权限。每一步单独定义幂等、冲突、ownership 和验收，再决定是否扩大公开范围。

2026-09-06 已按后续授权完成服务器部署；桌面 0.2.0 已使用临时测试账号验证真实云端登录、同一项目、本机文件、C 实验、网关和安装包后端的 Tutor 流式调用。发布证据见桌面连接验收记录；未自动替换用户已安装应用。
