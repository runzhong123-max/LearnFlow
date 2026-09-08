# Visual Hub：用户自带模型创作

Hub 的「＋ 新建作品 / 创作与我的作品」复用 `educational_visuals` 的 `createVisualWork / resumeVisualWork / iterateVisualWork`，不增加主 Agent 或另建生成工作流。Web `/visualize` 与桌面 Hub 消费同一个页面。

## 用户流程

1. 填写要解释的机制、例子与交互要求，选择动画或图解；默认从零生成，也可允许检索复用。
2. 在「我的模型配置」填写 HTTPS Base URL、模型名称和自己的 API Key。支持 OpenAI Chat Completions 兼容协议，根地址自动补 `/chat/completions`，也可直接填写完整端点；不支持原生 Anthropic / Responses 协议。密钥和配置仅留在页面内存，刷新或离开页面后需重新填写。
3. 可先测试连接（一次少量 token 请求）。点击生成后按已有工作流检索能力、生成候选、实际编译、有限修复并保存；失败显示具体模型配置/额度/网络原因。没有配置时不能调用模型，也不回退至网站后台 Key。
4. 作品、版本和未完成进度进入当前账号的「我的作品」，支持重新打开、停止并保留进度、恢复与取消。恢复时需要重新提供模型配置。改编保留原版本，生成结果不自动进入维护库；看图不是掌握证据。

页面关闭会中止当前模型请求；已经写入的检查点可恢复。这不是关掉浏览器后仍持续运行的后台任务。模型请求不自动重试；停止与网络中断并不保证提供商不会计入已经发生的 token 消耗。单状态图解与数值动画仍由已有构建器决定交互能力，新增任意 HTML/JS 生成不在本次范围。

## 凭据与网络

`POST /api/visuals/user-model` 接受 `operation=test|generate` 与当次 `config={base_url,model,api_key}`；生成另带 `job_id,prompt`。主体来自当前认证，生成必须绑定同主体的 running Job。此请求与 workspace 操作分开，配置不进入工作流 context、源规格、检查点、审计或公共检索；无凭据数据库字段。

- 既有登录/CSRF 不变，响应 no-store。网页身份变更以 learner key 重新挂载 Hub；pagehide 清空密钥并中断请求。
- 只允许公网 HTTPS，拒绝 URL 用户信息、查询参数、片段与内网地址；每次连接检查全部 DNS 地址并把选中的数值 IP 固定到 socket，保留原 TLS SNI/证书校验。禁用重定向、环境代理、重试及平台密钥回退。
- 每个服务进程内同一 learner 同时一个模型请求；这不是跨进程全局配额。测试总时限25秒、生成120秒、连接10秒；输出字节/字符/上游 token 均有上限。客户端断开时取消上游 task。
- 提供商错误正文、异常栈、URL 或 Authorization 不返回或写入 workspace。错误以固定中文原因与稳定 code 显示；若提供商把当次 key 回显到模型文本则丢弃响应。
- `httpcore==1.0.9` 显式锁定供数值地址连接 adapter 使用。此边界只允许公网提供商，不能配置本机 Ollama 或内网网关。

普通聊天的后台统一模型策略保持原样；此次用户明确要求的 BYOK 只应用于 Hub 创作。

## 接口与兼容性

Contract impact：注册表 Web `2026-09-08.3` / Desktop `2026-09-08.3-desktop`，在既有 educational_visual_plugin 中绑定 user-model API；visual_hub 声明复用生成与 manage_visual_workspace 能力。零新主 Agent、capability、EvidenceEvent、五核语义或数据库表；既有 visual_workspace_changed 仍审计私有作品重要操作。旧聊天与维护库继续使用原接口。

验收中同时修复 SVGStory 请求/响应反向边标签重叠（render runtime 1.0.1，source v1兼容，已存运行不改写），窄屏画面保留可读宽度并可横移。Hub 不显示没有 Tutor 接口的追问控件，改编仍通过原版本引用执行。

## 验证

使用临时数据库、合成 key 和可控模型响应；不读取生产用户凭据，不以平台 key 代替用户配置。

- 两端后端 BYOK、私有作品生命周期与 registry 回归；覆盖未登录拒绝、缺配置无回退、跨用户拒绝、发布后不可再调用、私有作品不进维护库、凭据不进 Job/Revision、失败释放请求槽。
- 网络单测覆盖 DNS 数值 IP 固定、混合公私地址拒绝、URL 规范化、重定向拒绝、上游错误脱敏、返回体上限及密钥回显丢弃。
- 既有共享 workflow 黄金与跨端契约检查；两个前端构建。
- 本地真实浏览器验收配置缺失、错误 key、连接测试、从零生成、单步、停止/恢复、刷新后密钥清空、私有作品重开和 390/1200px 布局。

真实供应商生成质量与计费连接没有使用用户密钥测试，须由用户填好配置后运行；本次不宣称所有兼容服务的模型 ID 和额外参数均已验收。

2026-09-08 实测：Web 相关后端 43 项通过，桌面后端 42 项通过；共享 workflow 7 项通过；shared contracts 与两个前端生产构建通过。浏览器在隔离数据库验证恢复构建成功、播放至末帧、390px 页面无横向溢出（画面自身可横移），无不可用的 Tutor 追问按钮。未运行无关后端全套、桌面安装包或线上真实供应商调用。
