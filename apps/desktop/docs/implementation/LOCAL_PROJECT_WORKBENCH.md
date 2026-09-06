# 三类项目的本地工作台

更新日期：2026-09-05。本文描述本轮已经实现的本地能力与验收方法；产品长期目标见
[三类项目产品规格](../product/THREE_PROJECT_MODELS.md)。架构、确认与证据语义以
[架构权威](../ARCHITECTURE_AUTHORITY.md)、[Agent 架构指南](../AGENT_ARCHITECTURE_GUIDE.md)
及 `backend/app/services/architecture_registry.py` 为准。

## 1. 一个项目骨架，三种使用方式

项目保留 `project_kind="apprenticeship"`，以新增的 `project_mode` 区分 `learning`、
`experiment`、`practice`，旧项目默认 `learning`。`project_brief` 保存交付物、约束和成功标准。
三类项目仍共用 Project、Roadmap、Checkpoint、正式 Tutor Session 和每关唯一 LearningTask。

| 项目模式 | 本轮默认流程 | 必须核对的依据 |
| --- | --- | --- |
| 学习型 | 选择资料与目标 → 阅读、复述与问题 → 独立应用与复习 | 当前项目已处理的 SourceVersion、带位置的阅读记录、正式任务的独立验证与复习记录 |
| 实验型 | 明确交付与预测 → 实现、运行与解释失败 → 交付与下一步实验 | 真实文件、已确认的 C 运行快照、观察、解释、结论与下一步实验 |
| 实践型 | 澄清工作契约 → 初始批次实现 → 新批次复测与交接 | 固定版本教学案例、当前阶段材料、可确定的输出检查、帮助程度及交接说明 |

首次点击确认任务书时，Host 按模式生成默认三阶段路线，物化正式关卡与任务。已有非案例路线可接入
工作台，初始化不会覆盖它；个性化路线仍使用原项目 Tutor 的提案与确认链。已经初始化的案例不能被
另一个版本替换，案例路线不能通过普通路线编辑接口绕过阶段门。

## 2. 页面与恢复

`ProjectWorkspacePage` 提供共同工作台：左侧项目阶段，中央任务与交付、本地文件、学习材料和思考
纸张，右侧可收起的正式 Tutor。导师仍使用项目或当前关卡 Session，不另建聊天权威。

- **学习材料：**在工作台内打开来源、讲义和练习；来源版本、章节位置与阅读笔记可以保存，正式练习
  继续进入原学习文件播放器与任务运行时。
- **本地文件：**关联真实目录，显示文件树与多个文件标签，创建文件、轻量编辑、快捷保存、选区提问，
  并将固定文件版本加入交付。其他类型可通过系统应用打开。
- **外部编辑：**窗口重新获得焦点时重读文件状态；未修改的编辑器载入新磁盘版本，有未保存草稿时保留
  草稿并提示冲突。保存始终携带读取时的 SHA-256，后端拒绝覆盖已变化的文件。
- **思考纸：**支持笔记、问题、假设和复盘。假设纸提供“问题—预测—最小实验—观察—解释与下一步”
  模板，可以把内容交给当前导师讨论。删除纸张不会删除原文件或正式对话。
- **恢复：**活动关卡、材料位置、文件标签、活动纸张、纸张正文与尚未提交的阶段交付草稿保存在
  `ProjectWorkflowState`；交付草稿保留回答、产物引用与帮助程度，且只能引用本项目阶段。
  保存使用 `expected_revision` 和幂等请求 ID；冲突需要保留并合并草稿，不以最后写入覆盖全部状态。

思考纸是工作记录；对话分支纸继续属于原 Paper Workbench。普通文件以磁盘为权威，未保存代码草稿
不等于已保存文件。来源原件及处理缓存放在应用数据中，讲义/练习仍以数据库为权威。

## 3. 学习型项目闭环

1. 创建学习型项目，写清学习目标，添加并处理资料。
2. 确认任务书，或先与项目 Tutor 确认针对资料的路线，再接入工作台。
3. 首阶段提交目标并引用本项目已处理的来源版本。
4. 在材料页阅读、选区追问、保存位置与笔记，提交复述、问题与应用想法。
5. 在最后阶段进入正式关卡任务完成独立验证并建立复习安排，再提交反思。

最后阶段会读取正式 `LearningTask` 的 `successful_verifications` 与 `review_items`；仅提交文字
或勾选不能替代独立验证和复习。资料导入、阅读位置、纸张保存与交付接受不自动改变掌握。

阅读记录固定 SourceVersion 与位置标识；页面按来源 ID 恢复显示位置，尚不提供跨版本的自动语义
重定位与旧版阅读界面恢复。默认三阶段任务书也不等同于自动从整本书生成完整目录；需要具体章节
路线时继续使用已存在的 Tutor 规划能力。

## 4. C 实验的运行边界

实验执行只存在于桌面 sidecar。每个接口同时要求当前登录、项目归属和本次启动的桌面令牌；涉及关卡
的请求还校验关卡属于该项目。Web 部署返回不可用，不能通过传入一个路径获得本地运行能力。

固定 Profile 为 `c11`，自动查找本机 `clang` 或 `gcc`；不自动安装编译器或依赖。

| 操作 | 实际动作 | 成功含义 |
| --- | --- | --- |
| 语法检查 | 固定 C11 编译参数与 `-fsyntax-only` | 编译器接受本次源码 |
| 构建 | 固定参数编译所选 C 源码及头文件 | 生成可执行文件 |
| 运行 | 构建后启动该可执行文件，提供有界 stdin/参数 | 此次进程在限制内正常结束 |
| 验证用例 | 构建后对可见输入逐项运行，精确比较 stdout，统一 CRLF | 此次可见样例符合预期；不是隐藏独立测评 |

每次操作分两步：

1. **预览：**选择 `.c`、`.h` 及允许的数据文件，复制安全快照，展示文件 manifest、hash、操作和
   trusted-local 说明。此时不会启动编译器或程序。
2. **确认：**用户点击“确认在本机执行”，提交对应 `snapshot_hash` 与明确确认字段。Host 核对目录、
   当前源码及副本；任何变化或 15 分钟预览过期都需要重新预览。执行前再核对排队期间的副本。

快照复制拒绝绝对路径、越界路径、符号链接、重解析点、受管目录及凭据文件。输入最多 64 个文件，
单文件 512 KiB，总计 4 MiB。固定编译超时 20 秒、每次运行 5 秒，每步保留最多 32 KiB 输出；后端
最多接收 8 个可见测试样例，当前页面提供一组输入与预期输出。程序使用参数数组启动，不经过 Shell，
不运行 Makefile、安装脚本或任意命令模板。

**这是一种明确授权的本机执行能力。** 编译器和生成的程序拥有本机用户权限，可能访问或修改其他
文件、联网或读取凭据。快照与环境变量白名单不构成文件系统、网络或凭据隔离，超时与输出上限不限制
内存和磁盘写入。只应确认运行自己信任的代码；不能把这套执行器当成公共服务处理陌生代码的沙箱。

构建产物放在应用 runtime 的 `experiments/` 下，宿主不会自动将快照或产物写回源目录。
`ExperimentRun` 保存原始配置、manifest/hash、确认时间、逐步命令与输出、结束状态。重复确认不会
重复执行；sidecar 重启将未完成操作标记为 `interrupted`，不会自动重跑程序。

## 5. 本地启动与最小 C 验收

完整依赖说明见 [桌面构建说明](../../desktop/README.md)。准备好项目 Python 环境、Node、Rust 和
Tauri 平台依赖后，在仓库根运行：

```bash
source backend/venv/bin/activate
npm --prefix frontend ci
npm --prefix desktop ci
npm --prefix desktop run build:sidecar
npm --prefix desktop run dev
```

编译器必须已安装并能由桌面进程查找到。Profile 显示不可用时应先解决工具链，不能将禁用按钮或假输出
当成构建成功。模型讲解使用应用已有模型设置；固定文件、运行和案例校验本身不需要模型生成结果。

手动验收使用新建的空目录，避免执行不明项目材料。在工作台创建并保存 `main.c`：

```c
#include <stdio.h>

int main(void) {
    int value;
    if (scanf("%d", &value) != 1) return 1;
    printf("%d\n", value * 2);
    return 0;
}
```

1. 创建实验型项目，确认任务书并关联该目录。
2. 首阶段写下产物与预测，进入实现阶段。勾选 `main.c`，依次预览并确认语法检查、构建。
3. 输入 `4`，预期输出填写 `8` 并保留末尾换行；点击验证，核对确认清单、运行输出与结果。
4. 将成功运行记录加入当前阶段交付，写观察与解释。纯语法检查或构建记录不能满足运行交付门。
5. 在外部编辑器修改文件，再尝试确认旧预览或保存旧草稿，必须出现版本变化或冲突提示。
6. 保存一张假设纸，重开项目检查文件标签、纸张、关卡与正式 Tutor 的恢复。

## 6. 实践型项目与插件

当前内置案例为 `support-ticket-import@1.0.0`，内容是“接手客服工单导入工具”，明确标注为
LearnFlow 独立编写的教学案例，不声称来自企业内部工作区。

学生先查看来源与版本，Host 核对案例 ID、版本和 root hash，确认后才物化路线。流程依次要求澄清
去重、状态与邮箱规则，提交初始 CSV 的处理结果，再处理后续新批次并完成交接。服务端按确定性 JSON
合同检查结果；后续材料与字段只有在前置交付通过后才公开，参考期望输出保留在服务端 evaluator。

每次交付记录回答、产物引用、检查结果及 `independent/hint/together/demonstrated` 帮助程度。
文字是否填写与结果是否符合合同可以确定检查；解释和设计质量仍显示需要评审。学生提交的 JSON
不自动证明它由自己的程序生成，也不证明独立完成。

当前未完成且已开放的阶段提供两级提示：“给我一个方向”和“帮我拆成小步骤”。Host 校验前置条件，
拒绝获取未来或已通过阶段的提示，保存已经使用的提示并在恢复后继续显示。使用提示后，即使交付时
选择“独立完成”，服务端记录的实际帮助程度也至少为 `hint`。提示、帮助和结果通过均不升级掌握；
桌面正式 Tutor 与关卡上下文读取同一份裁剪后的工作流投影。

`learning_task_conversion` 插件新增本地案例目录、固定版本候选校验和候选展示。完整案例由 Host
保留并按阶段投影，不塞入旧外部转换流程的 500 字符输入。插件返回未确认候选，正式创建仍由工作台
确认入口负责；桌面可直接通过同一 Host API 选择案例。此能力不代表全部第三方 TypeScript 插件已经
在桌面运行，也不代表企业连接器已完成。

案例 starter 提供 `README.md`、`input.csv` 与带明确 TODO 的 `importer.c`，可在案例页查看初始
文件，再通过桌面文件操作准备工程。选择 `importer.c`，将 CSV 正文粘贴到标准输入，使用本工作台
的 C11 Profile 编译运行，再将 JSON 输出提交。教学输入限定为不含引号内逗号的简单 CSV；starter
只提供可编译结构，默认空结果不能通过案例交付校验，学生仍需实现规范化、去重、拒绝与排序。

## 7. 操作进度与学习证据分开

| 记录 | 权威与用途 | 是否自动形成掌握 |
| --- | --- | --- |
| 文件保存、读取、hash | 磁盘与 WorkspaceOperation | 否 |
| C 构建、运行、可见用例结果 | ExperimentRun 与操作事件 | 否 |
| 阅读位置、纸张与交付记录 | ProjectWorkflowState / ProjectWorkflowSubmission | 否 |
| 交付接受与后续材料解锁 | 当前案例/流程的确定性门 | 否；不自行完成 LearningTask |
| 正式练习、独立验证与复习 | 原 LearningAttempt、任务运行时、EvidenceEvent 与 reducer | 按原正式证据合同判断 |

本轮新增 `project_workflow_initialized`、`project_workbench_saved`、`project_delivery_submitted`、
`project_reading_recorded`、`project_assistance_requested`、`experiment_run_started` 和
`experiment_run_completed` 均为零 kernel target。初始化路线复用 `roadmap_applied`，只承担既有
结构导航语义。运行成功、生成内容、帮助后成功与稳定掌握不相互替代。

## 8. 验证与实现入口

在安装了本仓依赖的 Python 环境中运行：

```bash
cd backend
python -m pytest tests/test_experiment_runner.py tests/test_project_workflows.py tests/test_architecture_registry.py -q
```

前端验证：

```bash
cd frontend
npm run build
```

实验回归使用测试自行创建的可信 C 样例，覆盖多文件语法检查/构建/运行、可见样例通过与不匹配、
编译失败、超时、输出上限、路径和链接边界、hash 冲突、权限、幂等、源码保留、操作事件零 kernel、
重启不重跑。没有编译器时真实编译用例明确跳过，不能宣称完成了本机 C 验证。

| 接口组 | 入口 |
| --- | --- |
| 模式、任务书、阅读、工作台与交付 | `backend/app/api/project_workflows.py`、`backend/app/services/project_workflows.py` |
| 固定案例、来源说明与确定性校验 | `backend/app/services/practice_cases.py` |
| C Profile、快照与运行记录 | `backend/app/api/experiments.py`、`backend/app/services/experiment_runner.py` |
| 三类工作台与文件编辑 | `frontend/src/ProjectWorkspacePage.tsx`、`frontend/src/ProjectFileWorkbench.tsx` |
| 插件案例候选 | `frontend/plugins/learning_task_conversion/work-case.ts` |

当前边界：没有云端与桌面项目同步，没有企业工作区在线采集，没有通用案例包上传/角色扮演引擎，
没有通用 Shell/多语言执行或 OS 沙箱；思考纸与来源位置也不是跨版本自动合并系统。已有源码和学习
对象可在本地继续使用，新增能力应沿登记过的 Profile、案例、评估和事件合同逐步扩展。

### 本次验收记录（2026-09-05）

- Python 3.12、仓库固定依赖、独立测试数据库：完整后端测试 **434 passed**，包含真实可信 C 样例与架构漂移检查。
- 前端构建通过；插件套件 **68 passed**；最终 Agent 上下文与纸张套件 **61 passed**，正式任务相关套件 **10 passed**。
- 浏览器检查三种入口、案例确认与阶段开放、纸张和交付草稿刷新恢复、资料阅读位置与笔记恢复。
- 桌面文件验证使用浏览器模拟桌面桥接，连接本次打包的真实 sidecar：创建和保存 `main.c`，确认固定快照，输入 `4` 得到 `8`，编译和用例均 exit 0，真实记录加入交付并通过操作检查，解释仍标记需导师评审。该检查不等同于真实 Tauri WebView 手工验收。
- macOS ARM64 `.app` 构建及本地 ad-hoc 签名完整性检查通过。源码中的 Tauri 启动器将 `RUNTIME_DIR` 固定在应用数据目录，运行快照不留在 PyInstaller 的临时解包目录。
- 截图保存在本机 `output/playwright/`。未执行用户的 SAT 工程、未调用付费模型、未改动日常账户数据库；没有安装或替换用户已有的应用。默认 DMG 包装未成功，本次交付可直接使用的 `.app`。

课程实践库调研与引导设计见[计算机课程实践库调研](../research/CS_PRACTICE_LIBRARY_GUIDANCE.md)。
