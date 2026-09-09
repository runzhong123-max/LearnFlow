# 个人 API Key 签发台验收 · 2026-09-09

## 实现范围

Web 设置新增个人 API Key 小面板：签发、选择期限、再次复制、查看状态与撤销。新 Key AES-GCM 加密副本独立存表，原摘要继续用于鉴权；Cookie + CSRF + 账号密码复核后方可取出。API Key 身份不能自助签发其他 Key。旧 hash-only Key 不回填，仍可正常鉴权，界面提示重新签发以启用再次复制。

Contract impact：新增 `auth_api_key_secrets` 表、`copy_available` 元数据与 `/api/auth/api-keys/{id}/reveal`；registry `2026-09-09.5`，沿用 desktop-api-key.v1 稳定 ID。密码复核失败返回 403 保留 Cookie 登录。无三类 Agent、学习事件、五核语义变更；无日常数据库迁移或秘密提交。

## 已执行且通过

- Web 后端全量：1052 passed / 1 existing skipped（151.77s）。随后增加密钥接口错误输入隐藏后，认证/生产认证/registry 专项 50 passed / 1 existing skipped；CLI 元数据调整后密钥专项 11 passed。
- Web 前端完整测试：526 passed / 0 failed；包含 Node API Key/身份代理 29 项。
- Web 前端 `npm run build`：通过，保留已有大 chunk 提示。
- `git diff --check`：通过。
- 本机隔离数据库浏览器流程：注册新账号 → 设置 → 签发「办公室电脑」→ 复制 → 收起 → 再次验证密码并复制。输错密码仍停留设置页，正确密码后成功取出；刷新后仍可复制；最终确认撤销后复制按钮消失。截图不含明文 Key：`output/playwright/api-key-settings.png`（本机验收产物，不提交）。
- 加密专项：重复取出同一个 Key；列表不泄露原文/密文；跨账号读取拒绝；无 CSRF/API Key 身份管理拒绝；撤销与密码修改删除密文；旧 Key 鉴权兼容；错误/缺失 KEK 和交换密文失败关闭；校验错误不回显密码。

## 验收中遇到并处理

- 首次从仓库根调用 pytest，模块搜索路径不匹配；改用 backend 目录执行后通过。
- 初始测试 KEK 长度不正确，验证了未就绪时 503；修正为 32 字节测试材料后通过。
- Node 回环端口测试被沙箱拒绝；获准使用本机测试端口后通过。
- 隔离浏览器注册首轮 403：验收服务器未允许 4188 预览来源，补上测试来源后正常。未改生产来源策略。

## 发布状态与边界

因主 checkout 正在进行岗位包/课程任务修改，本任务在独立 worktree 和 `codex/api-key-console` 分支完成；主 checkout 的已有改动未覆盖或暂存。实际提交与推送以任务最终回复为准。

本次未部署生产、未重装桌面、未跑 seeded demo（不涉及学习闭环）、未跑桌面回归（未修改桌面或共享包）。当前 HTTPS 裸 IP 根路径仍不提供网页登录；不能把此签发台的源码完成当成公网入口已开放。生产启用前须有受保护的网页登录入口、稳定且备份过的 AUTH_API_KEY_KEK，并同时发布 Web 前后端。

回退可恢复旧代码并保留新表与 KEK，原哈希鉴权兼容。勿删除新表或直接更换 KEK，避免破坏再次复制能力。

## 后续生产发布

2026-09-09 已完成 main 集成及生产发布，独立 HTTPS IP 入口已开放。上述未部署状态属于初次源码验收时点；当前状态与生产证据见 [生产发布记录](2026-09-09-personal-api-key-production-release.md)。
