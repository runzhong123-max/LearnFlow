# 浏览器工作区标签保存

顶部页面、当前页面、分屏与未发送文本使用按 learner 隔离的 `sessionStorage`（layout v1）。长期聊天缓存不再包含这些字段；服务端聊天与学习记录不受影响。

- 刷新恢复当前浏览器会话布局，关闭页面后不会从共享 localStorage 恢复。
- 新浏览器标签页打开 URL 指定页面，否则新对话。浏览器自身的“复制标签页”可能复制初始 sessionStorage，但之后各自独立。
- 主动退出成功后清除当前会话布局与草稿，下次登录新开对话。认证过期不执行此清除。
- 旧版 localStorage 中的布局不迁入新缓存，避免恢复过时页面；聊天内容保留。
- 恢复时过滤未知页面、缺少文件引用与不存在于本地聊天集合的标签，并按当前定义更新静态页及对话标题。服务端资源权限仍由原 API 校验，已删除远端文件可能显示原有不可用提示。

验证：`node --experimental-strip-types --test frontend/server/workspace-layout.test.ts`、前端 `test:auth` 与 `build`。

Contract impact：仅浏览器界面缓存，无五核、EvidenceEvent、API 或数据库契约变化。
