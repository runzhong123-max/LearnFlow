# LearnFlow shared learning core 0.1.0

唯一源码在 src/learnflow_core/。六个运行模块从已一致的 Web/桌面基线抽取；registry_core.py 保存共同的类型、三类 Agent、五核与基础 schema 声明。宿主 registry 继续登记真实可用的能力与绑定，不伪造端侧功能一致性。

这是依赖宿主 `app.models`、`app.services` 的共享内核，不是独立可启动服务。每个 Python 进程只加载一个宿主 app；两端在独立进程运行。旧 app.services 导入是共享模块的别名，因此内部函数、模块变量和 monkeypatch 仍引用同一对象。

从单仓源码启动时由 app/__init__.py 加载固定相对路径；外部分发可 `pip install ./packages/learning-core`。打包通过 PyInstaller --paths 与 --collect-submodules 纳入共享包。

修改后必须执行根 scripts/check_shared_contracts.py 和两端完整相关回归；禁止重新生成或复制回两个宿主。策略版本与数据库语义不因源码搬移而变化。
