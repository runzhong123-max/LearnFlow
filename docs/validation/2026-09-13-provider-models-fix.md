# Web 模型列表 500 修复

线上 `GET /api/auth/model-credential/models` 日志确认 `NameError: account_model_provider_config is not defined`，位置为 `backend/app/api/auth.py:821`。模型列表仍使用旧账户凭据路径，而 Web 模型凭据已经由后台统一管理。

修复仅让 Web 列表请求使用 `settings.llm_api_key` 和 `settings.llm_base_url`，与现有后台运行时凭据策略一致。空值及占位密钥返回 503 和“后台模型服务尚未配置”。响应不包含密钥；原有登录依赖、服务商请求超时和错误处理保留。桌面账户凭据路径不改。

Contract impact：不新增能力，不修改五核、事件、数据库或成功响应 schema；未配置服务的错误由旧账户提示改为平台服务 503。

验证：在 backend 目录运行 `venv/bin/python -m pytest tests/test_provider_models.py tests/test_auth_production.py -q`，17 passed、1 skipped（既有旧账户密钥 CRUD 测试）；`git diff --check` 通过。初次从根目录运行测试因无法导入 app 收集失败，改用规定的 backend 工作目录后通过。未运行全量后端、前端及 demo：本次仅修复 Web 认证路由中的模型列表读取，已运行相关回归，无前端或学习链路改动。

本次仅本地修复，遵守根 AGENTS.md 第 12 节不推送、不部署的限制；生产尚需发布。未覆盖工作区其他已有改动。
