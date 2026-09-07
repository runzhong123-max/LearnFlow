# GLM 检索与可选资料输入

## 官方服务与接入选择

本次查阅智谱官方[网络搜索 API](https://docs.bigmodel.cn/api-reference/工具-api/网络搜索)及[使用说明](https://docs.bigmodel.cn/cn/guide/tools/web-search)。独立搜索接口直接返回网页结果，适合复用 Role Atlas 已有的查询规划、来源筛选和证据绑定，不需要让聊天模型再决定一次搜索意图。

- 使用 `POST https://open.bigmodel.cn/api/paas/v4/web_search`，Bearer API Key。
- 默认 `search_pro`；可通过服务端配置选择 `search_std`、`search_pro_sogou`、`search_pro_quark`。
- 官方声明 Pro 改善召回与空结果率；这不是本项目岗位样本上的实测结论。
- 查询限制为 70 字符；适配器按 Unicode 字符截取，`search_intent=false`。默认请求 10 条，夸克引擎不发送不支持的 count。
- 保存 title、link、content、media、publish_date 和 request_id，继续执行现有去重、质量筛选和正文抽取。搜索摘要不是经过审核的事实，仍需生成后把关。
- 空结果、鉴权失败和业务错误分开处理，不会悄悄切回旧厂商。

## 配置与兼容

服务端配置：`ROLE_ATLAS_SEARCH_PROVIDER=glm`、`ROLE_ATLAS_SEARCH_ENGINE=search_pro`、`GLM_API_KEY`。兼容 `ZHIPU_API_KEY`。不要把密钥写入文档、代码或浏览器配置。`.env.example` 与 cohost 模板已同步；已有明确的旧厂商环境变量仍有效，需要上线时一起改成 glm。

本轮没有配置真实密钥，完成模拟协议、错误分支及本地验证，不声称已验证真实召回、费用、限流或完成生产切换。后续配置密钥后，应以网络运维、软件测试、云计算、Agent 应用等相同岗位输入做实际对比，记录有效来源、低质/空结果、失败次数与耗时。

## 可选资料

新建岗位与快照迭代复用同一输入组件，支持：

1. 附件：拖动或选择 PDF、DOCX、TXT、MD、CSV、JSON；浏览器提取文字，原始文件不上传保存。扫描 PDF 不做 OCR，提示先识别。
2. URL：服务端读取公开 HTTPS 文字网页；不读取登录页面、内网和非标准端口。PDF/Word 链接请下载后作为附件添加。
3. 文本：直接粘贴 JD、岗位标准或脱敏工作记录，点击添加。

每轮最多 20 份，每份不超过 5 MB、60000 字符，PDF 最多 100 页。不自动截断正文；失败提示保留，批量附件中成功项仍可使用。读取期间禁用生成，资料清单支持文字预览和移除。三种输入统一沿用 `SourceInput`，随本轮进入现有证据摄取流程。

URL 每次跳转均校验 HTTPS、域名和解析地址。Node 运行时固定已验证的公网 IPv4 后连接；Workers 使用平台 HTTPS fetch 与公网出口边界，不使用不兼容的自定义 TLS/lookup 选项。受网站防爬、网络或动态渲染影响时，会提示改用附件或文本。不得把该接口部署到允许任意私网出口的 Worker 代理环境。

## 验收与契约影响

回归覆盖 GLM 请求格式、来源追溯、错误分支、服务端密钥隔离，以及附件解析、空/超限资料和 URL 地址校验。浏览器验证资料添加和拖动；不需要消耗真实生成额度。

Contract impact：仅 Role Atlas 搜索适配与资料输入表达；沿用现有 `SourceInput` 和候选图谱证据链，不新增 LearnFlow 主 Agent、五核事件或学习状态写入。

测试员文稿只要求生成后检查雷达图、简介卡、事理图谱；另记录展示不清晰、重复生成失败和低质量结果。内部运行检查不作为测试员操作门槛。
