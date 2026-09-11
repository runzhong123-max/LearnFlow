# Tavily 联网证据获取策略

## 目标

联网层负责发现、抽取和登记证据，不负责替代 Role Atlas 的事实编译、语义纪律或来源裁决。每个进入岗位包的公开来源必须能追踪到：研究查询、原始 URL、厂商请求、抓取时间、抽取方式、质量层级和正文分段。

## 能力路由

| Tavily 能力 | Role Atlas 使用时机 | 默认策略 |
| --- | --- | --- |
| Search | 来源未知、需要当前全网信息 | 冷启动必经；多个证据类别并行执行 |
| Extract | 已从 Search 选出 URL | 对去重和质量排序后的 URL 定向抽取 |
| Map | 确认某个权威站点重要，但不知道资料分布 | 先发现站点结构，不直接进入事实层 |
| Crawl | 同一权威站点存在多页连续资料且单页证据不足 | Map 后限定路径、深度和页面数再抓取 |
| Research | 用户需要独立的深度报告或比较结论 | 归入“主题深度研究”Skill，不作为冷启动底层事实默认来源 |

Search 与 Research 的边界尤其重要：Search 返回 URL 和内容供本系统自行去重、分段、绑定与审计；Research 返回厂商生成的综合结论。岗位快照冷启动必须优先保留前者的可追溯粒度。

## 当前冷启动流水线

1. 根据岗位、市场、用户关注点生成六类固定查询，并在岗位边界模糊时允许模型补充查询，但不能删除核心类别。
2. 以有界并发执行 Tavily Advanced Search：`chunks_per_source=3`、每查询最多 5 个结果，不启用厂商答案。
3. 技术变化与未来信号查询限定最近一年；中国市场使用 `country=china` 提升地域相关性。
4. 规范 URL，清除追踪参数，按 URL 与正文指纹去重。
5. 结合来源等级、Tavily 相关度、岗位词组三元重合和类别优先级排序；弱相关页面不能仅凭高厂商分数入选。
5.1 岗位边界过滤：标题明确指向其他职业（如架构师、安全工程师、培训讲师）且正文不以目标岗位为核心的页面，低等级层级（secondary/contextual）一律拒绝入选，审计记为 `foreign_occupation`；权威职业标准常合法地以相邻职业命名，只做降权不硬拒。正文以目标岗位为核心的对比材料保留但降权。
5.2 时效衰减：招聘市场、工作实践、未来信号、教学评价四类中发布时间早于参考年两年的来源按年降权（上限 0.16），防止旧资料挤占当前证据位。
6. 每个证据类别尽量保留至少一个合格来源，同时限制同域名数量，避免单站垄断。
7. 对最终入选 URL 按 Tavily 的单次 20 URL 上限批量调用 Extract：`chunks_per_source=5`、`extract_depth=basic`；当前默认最多入选 16 个来源，通常只产生一次抽取请求。
8. Extract 失败或正文乱码时保留可读 Search 片段，并在研究报告中登记失败数，不让单页失败中断整个冷启动。
9. 将全部来源编译为稳定分段并完整保留在来源层；模型侧按来源代表片段、来源等级、岗位相关性和总字符预算选择上下文，再交给语义图与事理森林两个分支并行抽取。上下文裁剪不删除来源索引。

## 追踪与来源索引

同一次冷启动的 Tavily 请求统一携带：

- `X-Project-ID`：岗位项目 ID；
- `X-Session-Id`：冷启动 run ID。

来源资产保存：

- `locator`、`domain`、`publisher`、`publishedAt`、`fetchedAt`；
- `sourceTier` 与 `retrievalScore`；
- `queryIds`、`searchCategories`；
- `providerRequestIds`；
- `extractionMethod`：`search_content`、`provider_extract` 或 `direct_fetch`。

研究报告另外保存逐查询的结果数、响应时间、请求 ID、credits，以及 Extract 请求数、成功数、失败数和总 credits。API Key 永不进入项目、事件、来源或版本包。

## Map 与 Crawl 的触发条件

只有同时满足以下条件才考虑站点级扩展：

1. 来源属于政府、职业标准、教学标准、企业官方文档等高价值站点；
2. Search/Extract 只得到目录页、摘要页或缺失关键附件；
3. 当前证据覆盖审计明确指出缺少的任务、流程或标准字段；
4. 可以限定域名、路径、深度和页面上限。

建议先 Map，再从 URL 结构中选取目标路径，最后以 `max_depth=1`、较小 breadth/limit 开始 Crawl。不得无边界爬取整站。

## Research 的后续位置

Tavily Research 适合复杂比较、趋势判断和决策报告，并支持 streaming/polling 与结构化输出；但成本和推断层级都高于 Search/Extract。后续“主题深度研究”Skill 应把它作为可选研究执行器，并将报告本身登记为“综合研究产物”，报告中的原始 sources 仍需单独进入来源索引。

## 官方依据

- [Agents 能力选择指南](https://docs.tavily.com/agents.md)
- [Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search.md)
- [Search 最佳实践](https://docs.tavily.com/documentation/best-practices/best-practices-search.md)
- [Extract API](https://docs.tavily.com/documentation/api-reference/endpoint/extract.md)
- [Extract 最佳实践](https://docs.tavily.com/documentation/best-practices/best-practices-extract.md)
- [Crawl 最佳实践](https://docs.tavily.com/documentation/best-practices/best-practices-crawl.md)
- [Research 最佳实践](https://docs.tavily.com/documentation/best-practices/best-practices-research.md)
- [Rate Limits](https://docs.tavily.com/documentation/rate-limits.md)
- [Credits](https://docs.tavily.com/documentation/api-credits.md)
