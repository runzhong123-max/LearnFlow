# 桌面兼容入口

正式桌面源代码已迁入 `../apps/desktop/`，包括独立前端、FastAPI sidecar 和 Tauri shell。
根目录 `desktop/` 仅转发既有 npm 命令，不再编译根目录网页前端。

```bash
npm --prefix desktop run build:sidecar
npm --prefix desktop run build
```

安装脚本：`bash apps/desktop/desktop/scripts/install_macos_app.sh`。
旧位置的未跟踪构建输出没有删除；正式新输出在 `apps/desktop/desktop/src-tauri/target/`。
