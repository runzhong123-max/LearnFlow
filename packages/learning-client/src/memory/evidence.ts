export type EvidenceSource = {
  node_id: number; event_id: number; mutation_id: number; predicate: string
  source_path: string; source_format: string; source_sha256: string
  qualifier_spans_omitted: number; text: string; ranges: number[][]; truncated: boolean; occurred_at: string | null; status: string
  qualifiers: { evidence_grade: string; assistance_level: string; question_form: string; independent: boolean | null; outcome: string }
}
export type EvidenceLink = { id: number; title: string; kind: string; kernel: string; status: string; relation: string; direction: 'in' | 'out' }
export type EvidenceCard = {
  schema_version: 'learnflow.memory-evidence.v1'; id: number; title: string; kind: string; kernel: string
  statement: string; status: string; availability: string; occurred_at: string | null
  scope: { project_id: number | null; checkpoint_id: number | null; session_id: number | null }
  qualification: { eligibility: string; evidence_ids: number[]; historical_evidence_ids: number[]; invalidated_by_event_id: number | null } | null
  sources: EvidenceSource[]; links: EvidenceLink[]
  coverage: { source_total: number; source_returned: number; sources_truncated: boolean; links_truncated: boolean; complete: boolean }
  correction: { claim_id: number | null; allowed: boolean; formal_assessment_editable: false }
}
export type EvidencePage = { schema_version: 'learnflow.memory-evidence.v1'; cards: EvidenceCard[]; next_before_id: number | null }
export type EvidenceRequest = { nodeId?: number; reviewScheduleId?: number; beforeId?: number; projectId?: number | null; checkpointId?: number | null }
export function evidenceUrl(input: EvidenceRequest): string {
  const query = new URLSearchParams()
  for (const [key, value] of [['review_schedule_id', input.reviewScheduleId], ['before_id', input.beforeId], ['project_id', input.projectId], ['checkpoint_id', input.checkpointId]] as const) {
    if (value == null) continue
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('学习依据编号无效')
    query.set(key, String(value))
  }
  if (input.nodeId != null && (!Number.isSafeInteger(input.nodeId) || input.nodeId <= 0)) throw new Error('学习依据编号无效')
  const path = input.nodeId == null ? '/api/memory/evidence' : `/api/memory/evidence/${input.nodeId}`
  return `${path}${query.size ? `?${query}` : ''}`
}
export function createEvidenceReader(fetcher: (url: string, init?: RequestInit) => Promise<Response>) {
  return async (input: EvidenceRequest, signal?: AbortSignal): Promise<EvidencePage> => {
    const response = await fetcher(evidenceUrl(input), { signal, credentials: 'include' })
    if (!response.ok) throw new Error(response.status === 404 ? '这条学习依据不存在或已不可访问' : '暂时无法读取学习依据，请重试')
    const data = await response.json()
    if (data?.schema_version !== 'learnflow.memory-evidence.v1') throw new Error('学习依据格式已变化，请刷新页面')
    return input.nodeId == null ? data : { schema_version: data.schema_version, cards: [data], next_before_id: null }
  }
}
export function qualificationLabel(card: Pick<EvidenceCard, 'availability' | 'qualification'>): string {
  if (card.availability === 'historical') return '历史依据 · 已被后续记录更新'
  if (card.availability === 'expired') return '适用期限已过'
  if (card.qualification?.eligibility === 'invalidated' || card.availability === 'invalidated') return '当前需重新验证 · 历史成功保留'
  if (card.qualification?.eligibility === 'current') return '当前满足间隔复习规则'
  return '学习记录 · 以具体证据等级为准'
}
