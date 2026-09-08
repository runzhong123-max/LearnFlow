# 数据来源与版本

## 计算机专业群

本仓原创合成数据 `evals/computing_learner_profile/`，版本 `computing-learner-profile-dataset.v1`。数据manifest SHA-256为 `57f01d56473fcb683a1d2d9adaaaf04760fdd81a9db3c5e157fd5168f6f80873`。72任务族、216题、1,584轨迹；没有真实学生、没有教师已审标签。答案校验与课程来源详见该目录的VALIDATION.md与SOURCES.md。

## LoCoMo

Maharana, Lee, Tulyakov, Bansal, Barbieri, Fang，*Evaluating Very Long-Term Conversational Memory of LLM Agents*，ACL 2024。

- [官方仓库](https://github.com/snap-research/locomo)
- [固定版本数据](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/data/locomo10.json)
- [固定版本说明](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/README.MD)
- [上游许可证：CC BY-NC 4.0](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/LICENSE.txt)

实际下载日期：2026-09-08。Git commit `3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376`；blob `d95b872480b413d935821fdc3c84f8a8f5f29e73`；长度2,805,274字节；SHA-256 `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`。完整文件解析得到10段对话、1,986个QA，原始category计数为1:282、2:321、3:96、4:841、5:446。

仅conversation中的原始文字、说话者、会话时间进入本轮读取投影。QA、answer、evidence、session_summary、event_summary和observation不供检索器使用；不下载或推断图像内容。原始语料与含对话文字的完整运行trace保留本地，仓库交付下载脚本、数据身份和不含对话正文的指标。不可将该外部语料标为LearnFlow原创、真实学生数据或可不受限制商用的数据。

本轮测量证据定位与正文交付，未运行官方QA生成/评分脚本，不能称LoCoMo官方准确率。投影适配也不证明LearnFlow已具有通用会话的原生自动写入接口。

## 参考但未运行

[LongMemEval官方仓库](https://github.com/xiaowu0162/LongMemEval)列出信息抽取、跨会话推理、知识更新、时序推理与拒答能力，并区分完整历史和只保留支持会话的oracle数据。此分类用于核对能力覆盖；没有把oracle候选集当长历史检索测试。Hugging Face元信息直连实际超时，本轮选择可以固定并完整校验的LoCoMo，不宣称运行LongMemEval。

联网路径记录：agent-reach/Exa不可用后，使用web工具核对官方来源；raw GitHub传输中断后改用GitHub官方blob API，按Git blob身份、长度及SHA-256验证完整文件。实验本身不联网。
