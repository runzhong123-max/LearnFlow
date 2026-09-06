import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assessEvidenceCoverage,
  buildSearchPlan,
  extractRelevantExcerpt,
  isSafeWebUrl,
  rankSearchSources,
  readWebEvidence,
  redactSearchQuery,
  resetSearchRuntimeForTests,
  searchComputerKnowledge,
} from './computer-knowledge-search.ts'
import type { SearchSource } from '../src/tooling.ts'
import { auditSearchCitations, ensureSearchCitations } from '../src/tutor.ts'
import { runOfflineSearchEvaluation, SEARCH_EVALUATION_CASES } from './search-evaluation.ts'

function source(overrides: Partial<SearchSource>): SearchSource {
  return {
    title: 'Source',
    url: 'https://example.com/source',
    snippet: 'virtual memory definition mechanism example page table address translation',
    source: 'Example',
    quality: 'community',
    role: 'discussion',
    reason: 'test',
    ...overrides,
  }
}

test('explanation planning preserves the concept and asks for teaching evidence', () => {
  const plan = buildSearchPlan('跟我讲讲什么是虚拟内存')
  assert.equal(plan.intent, 'explanation')
  assert.equal(plan.topic, '虚拟内存')
  assert.match(plan.query, /virtual memory/)
  assert.deepEqual(plan.facets, ['准确定义', '核心机制', '最小例子', '边界与常见误区'])
  assert.ok(plan.trustedDomains.includes('pages.cs.wisc.edu'))
})

test('explanation planning removes formatting instructions from the topic', () => {
  const plan = buildSearchPlan('请联网搜索并讲解什么是虚拟内存：先给定义，再解释机制')
  assert.equal(plan.topic, '虚拟内存')
  assert.match(plan.query, /^virtual memory /)
})

test('canonical concepts add mechanism terms for source-page extraction', () => {
  assert.match(buildSearchPlan('解释 TCP 拥塞控制').query, /slow start/)
  assert.match(buildSearchPlan('什么是虚拟内存').query, /page table/)
  assert.match(buildSearchPlan('什么是 LoRA').query, /frozen weights/)
})

test('unknown Chinese and mixed technical terms are not discarded', () => {
  const plan = buildSearchPlan('解释一下 LoRA 低秩适配为什么有效')
  assert.match(plan.topic, /LoRA/)
  assert.match(plan.query, /lora/i)
  assert.match(plan.query, /low rank adaptation/i)
  assert.match(plan.query, /为什么有效/)
  assert.ok(plan.trustedDomains.includes('huggingface.co'))
})

test('query intent changes retrieval facets', () => {
  assert.equal(buildSearchPlan('Python asyncio 为什么报 event loop is closed').intent, 'troubleshooting')
  assert.equal(buildSearchPlan('B+树和红黑树有什么区别').intent, 'comparison')
  assert.equal(buildSearchPlan('找最新的 transformer 推理研究论文').intent, 'current')
  assert.equal(buildSearchPlan('用 Rust 实现一个线程池').intent, 'implementation')
})

test('production failure language and release changes are classified correctly', () => {
  assert.equal(buildSearchPlan('PyTorch DataLoader num_workers 在 macOS 上卡死').intent, 'troubleshooting')
  const react = buildSearchPlan('React 19 有什么变化')
  assert.equal(react.intent, 'current')
  assert.ok(react.trustedDomains.includes('react.dev'))
})

test('explicit comparison intent wins over a requested failure-boundary comparison', () => {
  const plan = buildSearchPlan('PPO 和 DQN 的关键差异、适用场景与失败边界')
  assert.equal(plan.intent, 'comparison')
})

test('search planning redacts credentials and local identity before external queries', () => {
  const redacted = redactSearchQuery('用 sk-abcdefghijklmnop 调试 /Users/ryan/demo，联系 ryan@example.com')
  assert.equal(redacted.redactionCount, 3)
  assert.doesNotMatch(redacted.query, /abcdefghijklmnop|\/Users\/ryan|ryan@example\.com/)
  const plan = buildSearchPlan('查 sk-abcdefghijklmnop 为什么失败')
  assert.equal(plan.privacy.redacted, true)
  assert.doesNotMatch(plan.query, /abcdefghijklmnop/)
})

test('depth controls bounded query, result, read, and research budgets', () => {
  const quick = buildSearchPlan('什么是虚拟内存', { depth: 'quick' })
  const deep = buildSearchPlan('系统研究 RAG 的方法与局限', { depth: 'deep' })
  assert.equal(quick.facetQueries.length, 2)
  assert.equal(quick.budgets.maxResearchRounds, 0)
  assert.ok(deep.facetQueries.length <= deep.budgets.maxQueries)
  assert.equal(deep.budgets.maxResults, 12)
  assert.equal(deep.budgets.maxResearchRounds, 1)
})

test('ranking prefers standards and textbooks over community discussions', () => {
  const plan = buildSearchPlan('什么是 TCP 拥塞控制')
  const ranked = rankSearchSources(plan, [
    source({ title: 'A discussion', url: 'https://stackoverflow.com/questions/1/a', source: 'Stack Overflow' }),
    source({ title: 'RFC congestion control', url: 'https://www.rfc-editor.org/rfc/rfc5681', quality: 'official', role: 'standard', source: 'RFC Editor' }),
    source({ title: 'Networking textbook', url: 'https://www.computer-networking.info/congestion', quality: 'official', role: 'textbook', source: 'Open textbook' }),
  ])
  assert.equal(ranked[0].url, 'https://www.rfc-editor.org/rfc/rfc5681')
  assert.equal(ranked.at(-1)?.source, 'Stack Overflow')
})

test('ranking canonicalizes duplicates and limits one domain from flooding results', () => {
  const plan = buildSearchPlan('解释一下哈希表')
  const ranked = rankSearchSources(plan, [
    source({ title: 'A', url: 'https://example.com/a?utm_source=test' }),
    source({ title: 'A duplicate', url: 'https://example.com/a/' }),
    source({ title: 'B', url: 'https://example.com/b' }),
    source({ title: 'C', url: 'https://example.com/c' }),
    source({ title: 'D', url: 'https://another.example/d' }),
  ], 8)
  assert.equal(ranked.filter(item => new URL(item.url).hostname === 'example.com').length, 2)
  assert.equal(ranked.filter(item => new URL(item.url).pathname === '/a').length, 1)
  assert.equal(ranked.length, 3)
})

test('hybrid rerank rewards freshness for current questions and diversifies facets', () => {
  const plan = buildSearchPlan('React 19 有什么变化')
  const ranked = rankSearchSources(plan, [
    source({ title: 'Old React notes', url: 'https://old.example/react', quality: 'community', role: 'discussion', publishedAt: '2018-01-01', facetIds: ['changes'] }),
    source({ title: 'React 19 upgrade', url: 'https://react.dev/blog/react-19', quality: 'official', role: 'reference', publishedAt: new Date().toISOString(), facetIds: ['changes', 'migration'] }),
    source({ title: 'React 19 release', url: 'https://another.example/react-19', quality: 'academic', role: 'research', publishedAt: new Date().toISOString(), facetIds: ['date'] }),
  ])
  assert.match(ranked[0].url, /react\.dev/)
  assert.ok(new Set(ranked.flatMap(item => item.facetIds || [])).size >= 3)
})

test('coverage audit exposes missing teaching facets instead of hiding them', () => {
  const plan = buildSearchPlan('什么是虚拟内存')
  const coverage = assessEvidenceCoverage(plan, [source({ facetIds: ['definition', 'mechanism'] })])
  assert.equal(coverage.covered, 2)
  assert.ok(coverage.gaps.includes('最小例子'))
  assert.ok(coverage.ratio < 1)
})

test('a searched answer deterministically receives exact source links when the model omits them', () => {
  const answer = ensureSearchCitations('虚拟内存通过页表进行地址转换。', [{
    id: 'tool-1', kind: 'search', status: 'completed', title: '计算机知识搜索', detail: '', durationMs: 1,
    sources: [source({
      title: 'OSTEP: Address Spaces',
      url: 'https://pages.cs.wisc.edu/~remzi/OSTEP/vm-intro.pdf',
      quality: 'official', role: 'textbook', source: 'OSTEP',
    })],
  }])
  assert.match(answer, /\[OSTEP: Address Spaces\]\(https:\/\/pages\.cs\.wisc\.edu\/~remzi\/OSTEP\/vm-intro\.pdf\)/)
  assert.equal(ensureSearchCitations(answer, []), answer)
})

test('citation audit rejects invented links and requires search gaps to stay visible', () => {
  const run = {
    id: 'search-audit', kind: 'search' as const, status: 'completed' as const,
    title: '搜索', detail: '', durationMs: 1,
    sources: [source({ title: 'React guide', url: 'https://react.dev/guide' })],
    searchMeta: { intent: 'current', status: 'partial', coverageGaps: ['发布日期'] },
  }
  const bad = auditSearchCitations('React 已更新。[来源](https://invented.example/post)', [run])
  assert.equal(bad.valid, false)
  assert.deepEqual(bad.citationLikeUnknownUrls, ['https://invented.example/post'])
  const good = auditSearchCitations('现有证据未覆盖发布日期。[React guide](https://react.dev/guide)', [run])
  assert.equal(good.valid, true)
})

test('authority-page extraction prefers explanatory prose over a table of contents', () => {
  const plan = buildSearchPlan('什么是 TCP 拥塞控制')
  const excerpt = extractRelevantExcerpt(`
    <p>3. Congestion Control Algorithms ................................... 4</p>
    <p>TCP congestion control uses a congestion window to govern the amount of outstanding data in the network.</p>
    <p>When congestion is detected, the sender reduces that window instead of continuing to inject packets at the same rate.</p>
  `, plan)
  assert.doesNotMatch(excerpt, /\.{4,}/)
  assert.match(excerpt, /congestion window/)
  assert.match(excerpt, /reduces that window/)
})

test('web evidence reader only opens allow-listed safe search URLs', async () => {
  resetSearchRuntimeForTests()
  assert.equal(isSafeWebUrl('https://127.0.0.1/private'), false)
  await assert.rejects(() => readWebEvidence({
    url: 'https://example.com/not-allowed', query: 'virtual memory', allowedUrls: [],
  }), /url_not_returned_by_current_search/)
  const html = `<html><head><title>Virtual Memory Guide</title><meta name="datePublished" content="2026-08-01"></head><body>
    <p>Virtual memory defines a process address space that is translated through page tables.</p>
    <p>Address translation lets the operating system map virtual pages to physical frames and handle page faults.</p>
    <p>A minimal example follows one virtual address through a page-table entry into a physical frame.</p>
  </body></html>`
  const page = await readWebEvidence({
    url: 'https://example.com/virtual-memory', query: 'virtual memory address translation',
    allowedUrls: ['https://example.com/virtual-memory'],
    configuration: { fetchImpl: async () => new Response(html, { headers: { 'content-type': 'text/html' } }) },
  })
  assert.equal(page.authority, 'untrusted_web_evidence_page')
  assert.match(page.excerpt, /page tables/)
  assert.equal(page.publishedAt, '2026-08-01')
})

test('query results are cached without masking their cache status', async () => {
  resetSearchRuntimeForTests()
  let calls = 0
  const fetchImpl: typeof fetch = async request => {
    calls += 1
    const url = String(request)
    if (url.includes('wikipedia.org')) return new Response(JSON.stringify({ query: { pages: {} } }), { headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify([]), { headers: { 'content-type': 'application/json' } })
  }
  const first = await searchComputerKnowledge('解释 foobarblatz', { fetchImpl }, { depth: 'quick' })
  const afterFirst = calls
  const second = await searchComputerKnowledge('解释 foobarblatz', { fetchImpl }, { depth: 'quick' })
  assert.ok(afterFirst > 0)
  assert.equal(calls, afterFirst)
  assert.equal(first.cache.hit, false)
  assert.equal(second.cache.hit, true)
})

test('provider circuit opens only after repeated transient failures and is reported explicitly', async () => {
  resetSearchRuntimeForTests()
  let now = 1_000
  const configuration = {
    now: () => now,
    fetchImpl: (async () => { throw new TypeError('fetch failed') }) as typeof fetch,
  }
  const first = await searchComputerKnowledge('解释 transient-alpha', configuration, { depth: 'quick', bypassCache: true })
  assert.ok(first.providers.some(provider => provider.name === 'Jina Search' && provider.status === 'failed'))
  now += 10
  const second = await searchComputerKnowledge('解释 transient-beta', configuration, { depth: 'quick', bypassCache: true })
  assert.ok(second.providers.some(provider => provider.name === 'Jina Search' && provider.status === 'failed'))
  now += 10
  const third = await searchComputerKnowledge('解释 transient-gamma', configuration, { depth: 'quick', bypassCache: true })
  assert.ok(third.providers.some(provider => provider.name === 'Jina Search' && provider.status === 'circuit_open'))
})

test('the 120-case offline production benchmark clears release thresholds', () => {
  const evaluation = runOfflineSearchEvaluation()
  assert.equal(SEARCH_EVALUATION_CASES.length, 120)
  assert.ok(evaluation.metrics.intentAccuracy >= 0.95)
  assert.equal(evaluation.metrics.boundedPlanRate, 1)
  assert.equal(evaluation.metrics.privacyRedactionRate, 1)
  assert.equal(evaluation.metrics.unsafeUrlBlockRate, 1)
  assert.ok(evaluation.metrics.catalogDomainRecall >= 0.9)
  assert.equal(evaluation.metrics.authorityTop1Rate, 1)
})
