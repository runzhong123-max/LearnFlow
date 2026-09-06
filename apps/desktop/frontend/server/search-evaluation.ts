import { pathToFileURL } from 'node:url'

import {
  buildSearchPlan,
  isSafeWebUrl,
  rankSearchSources,
  redactSearchQuery,
  type SearchIntent,
} from './computer-knowledge-search.ts'
import type { SearchSource } from '../src/tooling.ts'

export type SearchEvaluationCase = {
  id: string
  query: string
  expectedIntent?: SearchIntent
  expectedDomain?: string
  containsSensitiveData?: boolean
  unsafeUrl?: boolean
}

const intentCases: Record<SearchIntent, string[]> = {
  explanation: [
    '什么是虚拟内存', '解释一下朴素贝叶斯分类器', '跟我讲讲核方法', '什么是 TCP 三次握手',
    '如何理解 Python 生成器', '介绍一下数据库事务', '什么是哈希表', '解释 Transformer 自注意力',
    '什么是操作系统进程', '讲讲 B+ 树', '如何理解反向传播', '什么是 Rust 所有权',
    '解释一下 DNS 递归解析', '什么是 Git 三棵树', '讲讲 Kubernetes Pod',
  ],
  comparison: [
    '进程和线程有什么区别', 'B+ 树 vs 红黑树', 'TCP 与 UDP 对比', 'REST 和 RPC 的差异',
    'SVM 与逻辑回归怎么选', 'CNN 和 Transformer 有什么区别', '协程和线程对比', 'PostgreSQL MVCC 与锁的差异',
    'Docker 容器和虚拟机区别', '堆和栈有什么区别', 'DFS vs BFS', '监督学习与自监督学习比较',
    'React CSR 和 SSR 的差异', 'Raft 和 Paxos 有什么区别', '静态类型和动态类型的权衡',
  ],
  troubleshooting: [
    'PyTorch DataLoader num_workers 在 macOS 上卡死', 'Python asyncio 报 event loop is closed',
    '为什么 Docker 容器启动后立刻退出', 'React useEffect 为什么无限循环', 'Git push 被 rejected 怎么排查',
    'Kubernetes Pod 一直 CrashLoopBackOff', 'PostgreSQL 查询突然变慢怎么定位', 'C 指针访问导致 segmentation fault',
    'npm install 超时怎么排查', 'TCP 连接频繁 reset 是什么原因', 'CUDA out of memory 如何诊断',
    'Java deadlock 怎么复现和定位', 'DNS 能 ping IP 但域名解析失败', 'Rust borrow checker 报生命周期错误',
    '训练 loss 变成 NaN 怎么检查',
  ],
  implementation: [
    '用 Rust 实现一个线程池', 'Python 写一个最小 LRU cache', '如何实现 WebSocket 心跳',
    '用 PyTorch 实现 SelfAttention', '写一个 SQL 二分查找示例', '如何实现 JWT 鉴权中间件',
    '用 C 实现链表反转', '如何搭建最小 RAG pipeline', '实现一个 React 无限滚动列表',
    '如何写 Kubernetes Deployment', '用 Go 实现 worker pool', '实现一个简化版 Raft 日志复制',
    '如何给 FastAPI 加集成测试', '实现 Transformer causal mask', '如何设计 REST API 分页',
  ],
  research: [
    '研究 RAG 评测方法与局限', '找强化学习离线策略评估论文', '调研 Agent memory benchmark',
    '研究大模型幻觉检测方法', '综述图神经网络过平滑问题', '调研代码生成模型评测',
    '研究联邦学习隐私攻击', '找多模态检索代表论文', '研究长上下文模型位置编码',
    '调研软件工程 Agent benchmark', '研究扩散模型采样加速', '找数据库 learned index 论文',
    '研究自动课程规划方法', '调研知识追踪模型', '研究可解释机器学习评测',
  ],
  current: [
    'React 19 有什么变化', 'Python 当前稳定版本的新特性', '最新 Kubernetes release 有哪些迁移影响',
    'PyTorch 现在的 DataLoader 文档怎么说', '2026 年 RAG 评测有哪些进展', '最近的 TypeScript 版本变化',
    '当前 HTTP 语义规范是什么', 'PostgreSQL 最新版本升级注意什么', 'Rust 近期 edition 变化',
    '现在 Node.js LTS 有哪些 breaking changes', 'Docker Compose 当前规范更新', '最新 CUDA 版本兼容性',
    '当前 React Server Components 状态', '近期 Agent benchmark 有什么更新', '2025 年后的 LoRA 变体研究',
  ],
}

const catalogCases: Array<[string, string]> = [
  ['什么是虚拟内存', 'pages.cs.wisc.edu'], ['解释 Python 生成器', 'docs.python.org'],
  ['React 19 有什么变化', 'react.dev'], ['PyTorch DataLoader num_workers 卡死', 'pytorch.org'],
  ['什么是 TCP 拥塞控制', 'www.rfc-editor.org'], ['解释朴素贝叶斯', 'scikit-learn.org'],
  ['什么是 LoRA', 'huggingface.co'], ['讲讲数据库事务', 'www.postgresql.org'],
  ['Rust 所有权是什么', 'doc.rust-lang.org'], ['Kubernetes Pod 是什么', 'kubernetes.io'],
]

const sensitiveCases = [
  'sk-abcdefghijklmnop 为什么不可用', '我的邮箱 ryan@example.com 收不到回调',
  '读取 /Users/ryan/private/app.log 的报错', '服务器 192.168.1.15 连接失败',
  'ghp_abcdefghijklmnopqrstuvwxyz123456 泄漏了怎么办', '联系 test.user+dev@example.org 排查登录',
  'C:\\Users\\alice\\project 构建失败', '127.0.0.1 上的模型为什么不响应',
  'xoxb_abcdefghijklmnopqrstuvwxyz webhook 报错', 'hf_abcdefghijklmnopqrstuvwxyz 模型下载失败',
  'sk-1234567890abcdefghijklmn API 429', '访问 /Users/bob/secret/config.yaml 失败',
  '内网 10.0.0.8 的数据库超时', '邮箱 foo.bar@example.cn 在日志里出现',
  'github_pat_abcdefghijklmnopqrstuvwxyz123456 无权限',
]

const unsafeUrls = [
  'http://example.com', 'https://127.0.0.1/admin', 'https://localhost/private', 'https://10.0.0.1',
  'https://192.168.1.2', 'https://172.16.0.2', 'https://172.31.255.1', 'https://169.254.169.254/latest/meta-data',
  'file:///etc/passwd', 'javascript:alert(1)', 'https://service.local/api', 'https://host.internal/api',
  'https://[::1]/', 'https://[fd00::1]/', 'ftp://example.com/file',
]

export const SEARCH_EVALUATION_CASES: SearchEvaluationCase[] = [
  ...Object.entries(intentCases).flatMap(([intent, queries]) => queries.map((query, index) => ({
    id: `${intent}-${String(index + 1).padStart(2, '0')}`,
    query,
    expectedIntent: intent as SearchIntent,
  }))),
  ...sensitiveCases.map((query, index) => ({ id: `privacy-${index + 1}`, query, containsSensitiveData: true })),
  ...unsafeUrls.map((query, index) => ({ id: `unsafe-url-${index + 1}`, query, unsafeUrl: true })),
]

function fixtureSource(overrides: Partial<SearchSource>): SearchSource {
  return {
    title: 'General discussion', url: 'https://example.com/discussion',
    snippet: 'general discussion without authoritative detail', source: 'Example',
    quality: 'community', role: 'discussion', reason: 'fixture', ...overrides,
  }
}

export function runOfflineSearchEvaluation() {
  const intentEvaluated = SEARCH_EVALUATION_CASES.filter(item => item.expectedIntent)
  const intentPassed = intentEvaluated.filter(item => buildSearchPlan(item.query).intent === item.expectedIntent).length
  const boundedPassed = intentEvaluated.filter(item => {
    const plan = buildSearchPlan(item.query, { depth: 'deep' })
    return plan.facetQueries.length <= plan.budgets.maxQueries
      && plan.budgets.maxResearchRounds <= 1
      && plan.budgets.maxResults <= 12
      && plan.budgets.maxReadPages <= 6
  }).length
  const privacyPassed = SEARCH_EVALUATION_CASES.filter(item => item.containsSensitiveData).filter(item => {
    const redacted = redactSearchQuery(item.query)
    return redacted.redacted && !/sk-[A-Za-z0-9_-]{12,}|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\/Users\/[^\s/]+|\\Users\\[^\s\\]+/i.test(redacted.query)
  }).length
  const unsafePassed = SEARCH_EVALUATION_CASES.filter(item => item.unsafeUrl).filter(item => !isSafeWebUrl(item.query)).length
  const catalogPassed = catalogCases.filter(([query, domain]) => buildSearchPlan(query).trustedDomains.includes(domain)).length

  const rankingScenarios = intentEvaluated.slice(0, 30).map((item, index) => {
    const plan = buildSearchPlan(item.query)
    const authoritative = fixtureSource({
      title: `${item.query} official documentation`,
      url: `https://docs.example.edu/${index}`,
      snippet: `${plan.query} definition mechanism expected behavior example`,
      source: 'Official docs', quality: 'official', role: 'reference',
      facetIds: [plan.facetQueries[0]?.id || 'definition'],
    })
    const ranked = rankSearchSources(plan, [
      fixtureSource({ url: `https://forum.example.com/${index}`, title: `Forum ${item.query}` }),
      authoritative,
      fixtureSource({ url: `https://blog.example.com/${index}`, title: `Blog ${item.query}` }),
    ])
    return ranked[0]?.url === authoritative.url
  })
  const rankingPassed = rankingScenarios.filter(Boolean).length

  return {
    schemaVersion: 'learnflow.search-eval.v1',
    generatedAt: new Date().toISOString(),
    cases: SEARCH_EVALUATION_CASES.length,
    metrics: {
      intentAccuracy: intentPassed / intentEvaluated.length,
      boundedPlanRate: boundedPassed / intentEvaluated.length,
      privacyRedactionRate: privacyPassed / sensitiveCases.length,
      unsafeUrlBlockRate: unsafePassed / unsafeUrls.length,
      catalogDomainRecall: catalogPassed / catalogCases.length,
      authorityTop1Rate: rankingPassed / rankingScenarios.length,
    },
    counts: {
      intent: { passed: intentPassed, total: intentEvaluated.length },
      bounded: { passed: boundedPassed, total: intentEvaluated.length },
      privacy: { passed: privacyPassed, total: sensitiveCases.length },
      unsafeUrl: { passed: unsafePassed, total: unsafeUrls.length },
      catalog: { passed: catalogPassed, total: catalogCases.length },
      authorityTop1: { passed: rankingPassed, total: rankingScenarios.length },
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(runOfflineSearchEvaluation(), null, 2)}\n`)
}
