> 2026-09-09 个人 Key 签发台部署增量：HTTPS `/account` 为独立账号页，`/account-api/auth/*` 仅允许列明的账号认证与 Key 管理接口，Cookie + CSRF + 密码复核，拒绝 Authorization。原 `/api/*` Key-only、根 404、HTTP 426 均保持。该条取代下文“所有非 API 路径 404”的旧描述。见 [账号台合同](../../docs/implementation/DESKTOP_IP_API_KEY.md)。

# 桌面专用 IP HTTPS API 入口

目标为既有 ECS `i-n4a084s5nh57syfytgfe`（cn-wuhan-lr）上的 `https://8.148.28.98`。本目录只提供待审阅的部署配置和脚本；此次开发没有上传文件、申请证书、加载配置或重启服务。

## 入口与依赖

- HTTPS `/api/*` 先由 `GET /api/auth/api-key/verify` 验证 LearnFlow API key。后端必须已经实现该入口：有效 key 返回 204，无效/撤销/过期 key 返回 401/403；浏览器 Cookie 不可替代 key。不得将模型供应商 API key 当作此账户凭据。
- `/api/tutor*` 转发到现有 Node 服务；其余 API（包括 SSE）直接到后端，两条代理均即时刷新输出。IP 下其他 HTTPS 路径返回 404，不提供浏览器登录或岗位页面。
- HTTP IP `/api`、`/api/*` 返回 426，不转发凭据、不重定向至域名。仅 `/.well-known/acme-challenge/*` 服务 Certbot 验证文件；其他 HTTP IP 路径返回 404。
- Caddy 仍为 2.9.1。Certbot 从官方固定版本镜像运行，脚本实际检查版本至少 5.4.0，不挂载 Docker socket，不传入应用密钥。默认 `certbot/certbot:v5.4.0`，发布时可在 `installation.json` 中固定已核验的官方镜像 digest；脚本禁止自动拉镜像。
- 私钥、ACME 账户及日志只留服务器。客户端始终校验证书链与 IP SAN，不使用 `verify=False`、不忽略证书错误、不经 HTTP 发送永久 key，也不自动跟随跨源认证重定向。

Let's Encrypt 已公开支持 IPv4/IPv6 IP 证书，必须采用 `shortlived` profile，有效约 160 小时；IP 验证支持 HTTP-01/TLS-ALPN-01，不使用 DNS-01。[官方公告](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability.html) Certbot 5.4 起支持 IP 的 webroot 验证，可在现有 Web 服务继续占用 80 端口时申请；证书加载与续期 hook 需另行安排。[官方 Certbot 指引](https://letsencrypt.org/2026/03/11/shorter-certs-certbot.html)

## 已查明的线上基线

2026-09-09 15:01—15:08（北京时间）只读核验：Caddy、Web 后端和 Node 前端均 running，restart count 0；后端 healthy，容器内 `/ready` 为 200。

域名 DNS 指向 `8.148.28.98`。从 ECS 使用域名 SNI 能通过 TLS 校验，`/api/auth/me` 匿名返回 401；`/api/health` 实际为 404，不能用作本系统健康探针。域名证书由 Let's Encrypt YE1 签发，有效至 2026-12-02，只有 DNS SAN，无 IP SAN；该学习域名叶证书 SHA-256 为 `92a1793870154692ac25574076810f1694d861755a91e6437eb71a3dc41d3db1`。现有存储中没有 IP 证书或本地 CA 根证书。

裸 IP TLS 握手在 ECS 和本机均返回 TLS alert internal error。现有 HTTP IP 请求 302 跳回域名登录页。本机域名 TLS 收到 connection reset，但 ECS 的同域名 TLS 正常，不能据此宣称证书过期或服务器停止服务；当前证据也不足以确定网络重置的具体设备或策略。

## 两阶段部署：正式执行前须获发布授权

### 一、只启用 HTTP 验证路径

1. 固定已审阅提交。先部署并验收后端 API-key verifier；本配置不提供绕过验证的临时通道。记录当前 Caddy 容器、镜像、启动命令、挂载、Compose project/working directory、**该容器自己的完整 Compose 文件链及顺序**。其他服务的配置链不能替代它。
2. 在服务器私有发布目录备份当前生效的 Caddyfile，并核验其哈希。无需读取、打印或复制应用环境密钥到开发机。使用以下命令在新的空目录准备安装：

```sh
python3 deploy/ip-api/ip_api_tls.py initialize \
  --root /opt/ceg/ip-api \
  --original-caddyfile /absolute/path/to/current/active/Caddyfile
```

`initialize` 不运行 Docker。它逐字节保存旧域名配置，顶部加入 `default_sni 8.148.28.98`，末尾添加 IP snippet import；默认只放入 `10-http.caddy`，HTTPS 文件留在 `available/`。若原文件已经有全局 options block，会停止并要求显式合并 `default_sni`，不会擅自重写已有 options。标准 IP 客户端常不发送 SNI，此默认值只解决无 SNI 的选证书问题，不改变携带正常域名 SNI 的选择。[Caddy default_sni](https://caddyserver.com/docs/caddyfile/options#default-sni)

3. 将 `compose.ip-api.yaml` 追加到当前 Caddy 的完整 Compose 链。先验证渲染结果只有预期的四个只读挂载变化，现有镜像、环境、端口、网络、其他挂载及启动命令一致。不要无差别运行整个项目的 `compose up`，不要删除重复的历史 override。
4. 在隔离配置检查通过后，由获授权发布步骤仅重建 `caddy` 以附加新挂载：`up -d --no-deps --no-build --pull never caddy`。**首次附加挂载会短暂影响所有经 Caddy 的公开入口**；后端、worker、Node、Role Atlas 和代理容器均不重启。webroot 申请/续期本身不停止或抢占 80 端口。
5. 验证现有域名行为保持；使用无凭据请求确认 HTTP IP `/api/auth/me` 返回 426、根路径 404，并在 webroot 放置非秘密的一次性探针验证 challenge URL 从公网可访问。撤除探针。证书目录此时为空仍可正常启动 Caddy，因为 HTTPS snippet 尚未启用。

### 二、取得受信任 IP 证书后启用 HTTPS

先由发布操作显式拉取并核验官方 Certbot 镜像；脚本使用 `--pull=never`，避免后台续期时隐式更换软件。可先申请 staging 证书测试挑战链路，其账户、证书及日志保存在独立 `staging/` 子目录，永不被生产 Caddy 加载：

```sh
python3 /opt/ceg/ip-api/bin/ip_api_tls.py issue --root /opt/ceg/ip-api \
  --email ADMIN_CONTACT --staging
```

然后显式申请生产短期证书（默认 production）：

```sh
python3 /opt/ceg/ip-api/bin/ip_api_tls.py issue --root /opt/ceg/ip-api \
  --email ADMIN_CONTACT
python3 /opt/ceg/ip-api/bin/ip_api_tls.py enable-https --root /opt/ceg/ip-api
```

替换 `ADMIN_CONTACT` 为管理员联系邮箱。如本轮明确不提供联系邮箱，使用 `--without-email` 替代 `--email ADMIN_CONTACT`，例如：

```sh
python3 /opt/ceg/ip-api/bin/ip_api_tls.py issue --root /opt/ceg/ip-api \
  --without-email --staging
python3 /opt/ceg/ip-api/bin/ip_api_tls.py issue --root /opt/ceg/ip-api \
  --without-email
```

`issue` 必须明确选择 `--email` 或 `--without-email`，两者互斥；缺少选择会在访问安装状态前报错。原有邮箱调用方式保持兼容。无邮箱选项传入 Certbot 官方的 `--register-unsafely-without-email`，不读取或修改旧 Caddy ACME 账户，不虚构邮箱；新账户没有邮件联系地址，无法接收账户联系邮件。它不降低 TLS 安全要求：公信链、IP SAN、有效期和公私钥匹配校验、短期证书与自动续期均不变。该选择不是跳过证书校验。[官方 Certbot 5.4 注册逻辑](https://github.com/certbot/certbot/blob/v5.4.0/certbot/src/certbot/_internal/main.py#L688-L693)

脚本先确认 Caddy 的安装目录和四个只读挂载与本次 root 一致，才允许申请。启用时要求 OpenSSL 验证公信链、IP SAN、至少一小时剩余有效期和公私钥匹配，再放入 HTTPS snippet、`caddy validate`、`caddy reload --force`。新 snippet 首次启用失败时移回 bootstrap 状态，不重启服务器。

必须使用保持 TLS 校验的客户端实测裸 IP：无 key/仅 Cookie/错误 key 返回 401 或 403；有效 key 的只读 API 正常，Tutor stream 与其他 SSE 都能逐段到达；IP 根路径和非 API 路径为 404。不要将 key 写进 shell 参数、日志或验证报告；使用桌面应用凭据存储进行带认证验收。还需确认网络中间设备未阻断裸 IP TLS。当前开发没有真实 IP 证书，不能把语法检查称为此验收通过。

## 自动续期与故障重试

首次启用后先运行 staging dry-run，脚本不会加载测试证书：

```sh
python3 /opt/ceg/ip-api/bin/ip_api_tls.py renew --root /opt/ceg/ip-api --dry-run
```

获授权后把本目录的 `.service`、`.timer` 安装到 `/etc/systemd/system/`，执行 `systemctl daemon-reload` 和 `systemctl enable --now learnflow-ip-certificate.timer`。如更改默认安装目录，须同步 unit 的 ExecStart/ConditionPathExists。timer 每天检查四次，并补跑错过的触发；Certbot 只在到期窗口内续期。[Certbot 续期说明](https://eff-certbot.readthedocs.io/en/stable/using.html#renewing-certificates)

每次只处理固定 IP lineage。证书整个 store 挂载到 Caddy，保证 `live/` 到 `archive/` 的 symlink 更新可见。新证书与 `loaded-certificate.json` 不同时才验证并强制 reload；只有 reload 成功才更新该记录，因此失败后下一次 timer 即使没有重新签证也会重试。所有操作受同一文件锁控制。查看 systemd unit 状态和私有 Certbot 日志，并对持续失败或剩余有效期少于 48 小时告警；短期证书不能依赖人工偶尔续期。

## 回退及私有 CA 比较

HTTPS 功能回退可在停用 renewal timer、确认没有正在执行的证书操作后，将本次 HTTPS snippet 移出 `enabled/` 并验证/reload；HTTP 仍拒绝 IP key 请求。完整撤销新增挂载时，恢复当前已核验的原 Caddy 配置链并只重建 Caddy。不得用旧整体 Compose 快照覆盖其他任务的更新。证书和回滚文件保留在服务器；无数据库迁移，不删除业务数据。

若公网 CA 的 IP 挑战在该网络确实不可用，可另行审批专用私有 CA。它需要服务器签发包含 `IP:8.148.28.98` 的证书，并让桌面端明确导入/核验该 CA 公钥指纹，只在该服务的 TLS context 信任它；私钥不离开服务器，不能静默扩大系统信任。此方案维护和分发成本更高，也不能解决 TCP/网络阻断。本实现未采用或生成私有 CA，仍优先公信 IP 证书。

## 开发验证

```sh
python3 -m unittest discover -s deploy/ip-api/tests -v
python3 deploy/ip-api/verify_adapted_routes.py /path/to/caddy-adapt-output.json
```

16 项离线测试已通过，包括邮箱方式兼容、无邮箱显式选择、互斥/缺参拒绝和 TLS 参数保留；候选 snippets 连同 `default_sni` 在现有 Caddy 2.9.1 使用 stdin **仅 adapt** 成功，其真实适配 JSON 通过 API-key gate 顺序、Tutor/Backend 分流、stream flush、HTTP 拒绝与 404 检查。没有加载配置、申请证书、迁移数据库或重启生产容器。没有真实 IP 证书，因此完整 `validate`、公信 IP TLS、续期与 reload 的生产验收尚未执行。

Contract impact：新增部署入口消费后端 API-key verifier，不改变既有域名路由、三类 Agent、五核或 EvidenceEvent 语义。无数据库 schema 变化。
