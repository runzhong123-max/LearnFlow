# LearnFlow

本应用已迁入 LearnFlow 单仓；当前根目录为 `apps/desktop/`。下文相对命令在本目录执行。共享包、首次安装、测试与打包以 [单仓说明](../../docs/MONOREPO.md) 为准。原 edagent 仓库保留为历史恢复点。


LearnFlow 是面向计算机学习的 Tutor 工作空间。产品以连续对话为主界面，在同一学习现场连接原子学习任务、项目关卡、讲义与练习、复习、学习路径和五核学习者状态。

仓库现在只有一套产品前端：`frontend/`。原来的 vNext 已成为正式 LearnFlow，不再维护旧前端或第二套页面逻辑。

## 运行

要求 Python 3.11+、Node.js 20.19+。

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env

cd ../frontend
npm install
cp .env.example .env.local
# 在 .env.local 配置 LEARNFLOW_API_KEY、模型地址和模型名称

cd ..
bash start.sh
```

- 页面：<http://127.0.0.1:4174>
- 后端：<http://127.0.0.1:8010>
- 停止：`bash start.sh stop`
- 隔离的离线验收：`bash start.sh demo`，入口为 `/review`

也可以在 `frontend/` 执行 `npm run dev`，它会检查并启动正式后端；只启动页面时使用 `npm run dev:web`。

## 桌面安装包

桌面端安装包发布在 GitHub 的 [Releases](https://github.com/killoppen/edagent/releases) 页面。维护者推送 `v*` 标签后，GitHub Actions 会在 Windows 和 macOS runner 上构建并上传安装包；也可以在 `Desktop release` workflow 中手动选择已有的 `v*` 标签重新发布。

本地构建桌面安装包时，先完成 `desktop/README.md` 中的 Rust、Tauri、Python 和 Node.js 依赖安装，然后执行：

```bash
cd desktop
npm install
npm run build:sidecar
npm run build
```

生成的安装包位于 `desktop/src-tauri/target/release/bundle/`，Windows 通常包含 `nsis/*.exe` 和 `msi/*.msi`。

## 目录

```text
frontend/   唯一 React + TypeScript 产品前端，以及本地 Tutor Turn Graph
backend/    FastAPI、三类 Agent 契约、学习对象、证据链与五核
desktop/    Tauri 壳与本地 FastAPI sidecar
docs/       架构、产品逻辑、运行手册与验证记录
```

运行时权威不是浏览器缓存：对话以 `AgentSession + AgentMessage` 保存，学习状态只允许通过
`EvidenceEvent -> five_kernel_reducer -> KernelMutation -> Memory Graph` 更新。五核不是五个 Agent；主责任接口仍只有 Tutor、Learning Design 和 Practice 三类。

## 验证

```bash
make verify
```

`make verify-layout` 会单独检查唯一前端边界：受 Git 管理的旧 `vnext/`、
`legacy-frontend/`、`frontend-old/`、旧 5173 运行入口或缺失的正式入口都会使检查失败。

架构权威见 [docs/ARCHITECTURE_AUTHORITY.md](docs/ARCHITECTURE_AUTHORITY.md)，Agent 工程约束见
[docs/AGENT_ARCHITECTURE_GUIDE.md](docs/AGENT_ARCHITECTURE_GUIDE.md)，一分钟产品逻辑见
[docs/product/LOGIC.md](docs/product/LOGIC.md)。仓库维护规则见 [AGENTS.md](AGENTS.md)。

桌面项目与上线规划见 [三类学习项目产品规格](docs/product/THREE_PROJECT_MODELS.md) 和
[产品上线部署与数据归属](docs/implementation/PRODUCT_DEPLOYMENT_AND_DATA_OWNERSHIP.md)。两份文档区分当前实现与待实现建议，
覆盖资料学习、本地实验、工作案例实践，以及 Web、Desktop、Role Atlas 和 Graph Hub 的职责与数据边界。

本地实现与启动见 [三类项目工作台](docs/implementation/LOCAL_PROJECT_WORKBENCH.md)。课程库与实验指导的参考、
思考引导设计见 [计算机课程实践库调研](docs/research/CS_PRACTICE_LIBRARY_GUIDANCE.md)。
