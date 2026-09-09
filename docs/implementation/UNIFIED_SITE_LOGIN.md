# 比赛成果入口与统一网页登录（2026-09-08）

根域名 `learnflow.club` 登录后显示“岗课评教 比赛成果展示”，仅提供岗位、图谱、学习实践和教学图解入口。未登录时，根站、LearnFlow、Role Atlas、Graph Hub 的页面统一跳转到 `https://learn.learnflow.club/login`；登录完成回到原站点和路径。登录页不展示 LearnFlow、LF 或学习空间品牌元素。

## 实现边界

- Caddy 复用现有 `/api/auth/me` 校验业务页面和 API。页面未认证返回 302，业务 API 返回 401；认证服务故障不放行。登录页、登录资源、认证接口及无用户数据的健康/平台发现接口保留可访问。
- Role Atlas 的机器网关仅保留精确 `/api/integrations/learnflow/gateway` 例外，继续由既有签名和主体校验保护，不改为匿名业务接口。
- 四站通过同源 `/api/auth/*` 代理复用现有 Secure、HttpOnly、`.learnflow.club` Cookie；不创建第二套账号或把 token 放入浏览器存储。CSRF 和服务端会话撤销校验保持原实现。
- `frontend/public/site-session.js` 为四站唯一状态栏脚本，由前端静态服务提供。显示当前用户、成果首页入口和退出按钮；首次加载、回到标签页时检查会话，可见页面每 60 秒检查一次。账号改变刷新页面，退出后其他标签页在重新聚焦或下一次检查时返回登录页；服务端撤销即时生效。
- 登录回跳仅接受四个明确 HTTPS origin，拒绝外站、凭据 URL、非标准端口与登录循环。代理原始 URI 和客户端编码 URI 都保留查询参数。
- Web `/review` 不再自动进入演示账号；教学图解入口也包在 AuthGate 内。已有显式离线 demo 工具未修改。
- 本轮是展示与部署入口策略变更，无新增学习 capability、API schema、EvidenceEvent 或五核写入者，无数据库迁移。桌面包未重发。

## 验收证据

- Web `test:auth`：19 项通过，覆盖可信回跳、开放重定向拒绝、查询参数保留、状态栏身份读取和 CSRF 退出；TypeScript/Vite 构建通过。
- Atlas：249 项测试通过，typecheck、build 通过。首次测试受沙箱通信端口权限限制，允许正常运行后通过。
- 生产 Caddy validate 通过。匿名访问根站、settings、visualize、Role Atlas 和 Graph Hub 均 302 到同一登录页；匿名业务 API 为 401，登录页为 200。
- 临时账号实测四站同一 learner、共享 Secure 域 Cookie、页面包含统一状态栏；根页显示比赛成果标题；从 Role Atlas 带 CSRF 退出后四站均未认证。临时账号已停用并撤销所有会话。首次注册测试误用了不支持的教育阶段枚举，修正测试输入后通过。
- Safari 实际访问根站验证跳转、页面文案和未登录状态栏。未使用用户密码做 GUI 登录或退出；跨站已登录/退出链由隔离账号 HTTP 联调验证。
- 未执行后端全量或 seeded demo：没有修改后端运行实现及学习状态契约。构建仍有既有大 chunk 提示。

## 发布与回退

ECS `i-n4a084s5nh57syfytgfe` 的发布目录为 `/opt/ceg/releases/site-auth-20260908`，备份位于其 `backup/`：原前端 dist、Atlas layout、Caddyfile 和最后一层 Compose override。镜像为 `learnflow-frontend:site-auth-20260908`、`role-atlas:site-auth-20260908`，从线上 `6c90452` 基线构建，仅加入本次补丁。

发布采用先复制新 hash assets、再替换 HTML，保留旧 assets 供已有标签页加载；Atlas 更新布局，Caddy 热加载。没有停止容器或改动数据卷。现有最后一层 `/opt/ceg/releases/learnflow-hub-6c90452/visual.override.json` 已更新镜像指向，使后续重建保持新版本。运行容器的原始 image 标签仍反映创建时基线，当前内容通过热更新生效。

回退时恢复备份的 HTML/布局/Caddyfile 与 override，再校验和热加载 Caddy；不要删除账号、数据库或学习记录。域名变更时同时更新前端站点 allow-list 与 Caddy 环境配置，不扩大到任意子域。

## 公网入口补充检查

2026-09-08 再次从无 Cookie 请求确认：Role Atlas 首页及 `/projects`、Graph Hub `/hub` 和 `/registry`、学习站与根站都重定向中央登录页。新增 HTTP 80 catch-all，将公网 IP 与未匹配 HTTP Host 重定向同一登录页；不为未配置的 HTTPS 域名或 IP 伪造证书。

发现历史 `/opt/backend` 的独立 `backend.service` 监听 `0.0.0.0:8000`，没有经过网关。已安装 `deploy/guard-legacy-http-port.sh` 为 `/usr/local/sbin/learnflow-legacy-api-guard`，由同名 systemd oneshot 在启动时幂等应用 IPv4/IPv6 INPUT 规则：拒绝非 loopback 接口进入 8000。旧服务和数据保留，SSH、正式 80/443 及 Docker 内部服务不改变。规则由 comment `learnflow-legacy-api-guard` 标识，不覆盖已有防火墙配置；回退需先撤销该 oneshot 的开机启用，再逐条删除此 comment 对应规则。

已校验 Caddy 配置并热加载；公网 IP HTTP 返回 302；端口保护和旧服务均 active，本机 127.0.0.1:8000 仍正常响应。旧端口拒绝连接而不展示登录页面。登录资源和认证接口仍是必要例外，普通匿名 API 保持 401，签名机器网关继续使用自身认证。
