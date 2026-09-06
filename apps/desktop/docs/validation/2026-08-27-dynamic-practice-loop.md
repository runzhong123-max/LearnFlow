# 动态习题 Agent 闭环验收留痕（2026-08-27）

## 验收范围

- 正式项目关卡：`从零实现迷你 GPT / 自注意力：QKV 与张量形状流动`
- 正式学习任务：task `37`，checkpoint `36`，project `7`
- 验收边界：允许生成与打开练习文件，不提交学习者答案，不改变掌握状态。

## 真实浏览器闭环

1. 在正式关卡对话直接输入“重新生成 4 道自注意力 QKV 与张量形状检测题：单选、步骤排序、数值、代码输出各一题，并检查质量”。Tutor 自主读取五核、项目工作台和学习工作区，随后调用 `generate_dynamic_practice` 和 `inspect_practice_quality`。
2. 首次验收发现生成器错误沿用图解的固定 1,200-token 配额，推理模型没有留下可用输出；Agent 又用表面变化的参数重试，最终触发 105 秒客户端上限。修复后按题量给出有界输出预算，并按正式任务拦截同回合重复昂贵生成。
3. 修复后的真实工具卡持续显示读秒，动态生成在 57.0 秒完成；质量检查随后完成。后端完成 ownership、schema、target skill、确定性答案与重复项检查，生成：
   - `practice-set-ps-aefe29b2a98fe762f97d`
   - 题型：单选、Parsons/步骤排序、数值、代码输出。
   - 质量：4/4 `schema_valid`、`construct_declared`、`answer_deterministic`。
   - 测量边界：`psychometric_status=uncalibrated`、`mastery_inference=false`。
4. `practice_quality_inspector` 再读正式文件，返回 `valid=true`，不产生掌握证据。
5. 点击 ToolRun 上的“放到新纸上”，在练习工作台确认：
   - 提交前不返回答案和解释；
   - 排序题必须排满所有步骤才允许提交；
   - 代码输出题展示完整代码；
   - 可显式填写前置卡点和有效帮助，但不从普通答错推断人因。
6. 文件进入原关卡对话的纸张工作台；可删除、平铺，并进入关系树。
7. 关系树已验证：左列显示主对话逐条输入/输出缩略；这份练习锚定在产生 ToolRun 的第 5 条 Tutor 输出旁，子纸张继续按 `parentSheetId` 展开。

没有在此浏览器验收中提交答案；Knowledge / Practice / Structure / Human 的归约由隔离测试验证，避免把测试答案写入日常学习画像。

## 自动化结果

```text
backend: 193 passed
frontend npm test: search 9 / learning 38 / planning 6 / profile 9 / path 11 / formal 30，全部通过
frontend production build: 320 modules transformed, passed
```

针对性前端回归新增两条断言：四题生成获得 5,800-token 有界预算，以及同一 LearningTask 的表面参数变化不能触发第二次昂贵生成。

关键自动化断言包括：动态工具只在正式带领学习任务中暴露、ToolRun 的 started/completed 顺序、`text_delta` 流式顺序、候选题拒绝与幂等、答案安全、正式提交到 Knowledge/Practice、显式卡点到 Structure、显式有效帮助到 Human、自由态不误调用写工具。

## 已知测量边界

当前质量门是工程级静态检查，不是心理测量校准。自动题不能只凭一次答对提升稳定掌握；后续应在保留题目版本和 family ID 的前提下加入人工审题、试测统计、项目难度/区分度及漂移监测。
