import { performance } from 'node:perf_hooks'

import { searchComputerKnowledge, type SearchDepth } from './computer-knowledge-search.ts'

const cases: Array<{ id: string; query: string; depth: SearchDepth }> = [
  { id: 'concept-authority', query: '跟我讲讲什么是虚拟内存', depth: 'standard' },
  { id: 'troubleshooting', query: 'PyTorch DataLoader num_workers 在 macOS 上卡死，官方行为和排查步骤是什么', depth: 'standard' },
  { id: 'current-version', query: 'React 19 有什么变化和迁移影响', depth: 'standard' },
  { id: 'comparison', query: 'PPO 和 DQN 的关键差异、适用场景与失败边界', depth: 'standard' },
  { id: 'implementation', query: '如何用 PyTorch 实现最小 SelfAttention，并说明张量形状', depth: 'standard' },
  { id: 'deep-research', query: '系统调研 RAG 评测方法、代表框架、实验结论与局限', depth: 'deep' },
]

const configuration = {
  exaApiKey: process.env.EXA_API_KEY,
  tavilyApiKey: process.env.TAVILY_API_KEY,
  jinaApiKey: process.env.JINA_API_KEY,
}

const rows = []
for (const item of cases) {
  const startedAt = performance.now()
  try {
    const result = await searchComputerKnowledge(item.query, configuration, { depth: item.depth, bypassCache: true })
    rows.push({
      id: item.id,
      status: result.status,
      intent: result.plan.intent,
      resultCount: result.results.length,
      officialOrAcademic: result.results.filter(source => source.quality === 'official' || source.quality === 'academic').length,
      domains: new Set(result.results.map(source => new URL(source.url).hostname)).size,
      coverageRatio: result.coverage.ratio,
      coverageGaps: result.coverage.gaps,
      providers: result.providers,
      researchRounds: result.researchRounds,
      hasResearchBrief: Boolean(result.researchBrief),
      latencyMs: Math.round(performance.now() - startedAt),
    })
  } catch (error) {
    rows.push({
      id: item.id,
      status: 'infrastructure_error',
      error: error instanceof Error ? error.message : String(error),
      latencyMs: Math.round(performance.now() - startedAt),
    })
  }
}

const successful = rows.filter(row => row.status === 'ok' || row.status === 'partial') as Array<Record<string, any>>
const report = {
  schemaVersion: 'learnflow.search-live-eval.v1',
  generatedAt: new Date().toISOString(),
  backend: configuration.exaApiKey ? 'Exa' : configuration.tavilyApiKey ? 'Tavily' : 'Jina/public adapters',
  cases: rows,
  aggregate: {
    completed: successful.length,
    total: rows.length,
    nonEmptyRate: successful.length / rows.length,
    meanCoverage: successful.length
      ? successful.reduce((sum, row) => sum + Number(row.coverageRatio || 0), 0) / successful.length
      : 0,
    meanLatencyMs: rows.reduce((sum, row) => sum + Number(row.latencyMs || 0), 0) / rows.length,
  },
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
