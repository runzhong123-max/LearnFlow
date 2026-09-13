# Demo 2：Kubernetes 服务自动伸缩

## 个性化学习者

| 字段 | 值 |
| --- | --- |
| 用户名 | `xiaoz_k8s` |
| 显示名称 | 李（平台工程方向） |
| 学习阶段 | 工作中 |
| 每周学习小时 | 8 |
| 当前背景 | 使用过 Docker 和 Linux，能写简单 Deployment，但没有独立配置过 Kubernetes 自动伸缩。 |
| 偏好方式 | 先画架构图，再通过指标实验验证 |
| 职业目标 | 云平台/DevOps 工程师 |

## 项目字段

- 项目类型：`做一个作品或实验`
- 项目主题：`Kubernetes Web 服务：基于 CPU 与并发压力的自动伸缩实验`
- 学习目标：理解 Pod、Deployment、Service、Metrics Server 和 HorizontalPodAutoscaler 的关系；能够通过压力测试观察副本数变化，并解释扩容、缩容和稳定窗口。
- 预期产物：一套可运行的 Kubernetes YAML、压力测试脚本、扩缩容观测记录、资源与稳定性分析报告。

## 主题资料与 URL

主题资料建议围绕以下要点整理后上传：Deployment/Service 基础、资源 requests/limits、Metrics Server、HPA 的 minReplicas/maxReplicas/target 指标、扩缩容观察方法。

官方 URL：<https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/>

录入后点击重新核验，确认 `ready`、`覆盖 100%`、`缺口：无`，再设为项目基线。

## 第一次初始对话

```text
我想做一个 Kubernetes 自动伸缩实验。请先根据我的基础安排学习，不要直接给完整 YAML。

我用过 Docker、Linux 和简单的 Deployment，但还分不清 Service、Metrics Server 与 HPA 各自负责什么，也不知道 CPU 使用率变化为什么会影响副本数。

请先问我 3 个简短问题，分别判断：容器和 Pod 的关系、requests/limits 与伸缩指标的关系、一次压力升高时 HPA 如何决定扩容。根据回答只安排第一步实验，暂时不要直接给答案。
```

