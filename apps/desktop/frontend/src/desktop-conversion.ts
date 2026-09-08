export type StarterFile = { path: string; content: string; sha256: string }
export type ConversionPreview = {
  schema_version: 'learnflow.work-task-conversion.v1'
  id: number
  learner_id: number
  root_hash: string
  candidate: { candidate_id: string; root_hash: string; project_mode: 'experiment' | 'practice'; title: string; summary: string; design?: { stages?: { title?: string; objective?: string }[] } }
  starter_files: StarterFile[]
  starter_manifest_hash: string
  expires_at: string
  project_id?: number
  consumed: boolean
}

export function validConversionTicket(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value)
}

export function conversionTicketFromUrl(value: string): string | undefined {
  const prefix = 'learnflow://conversion?ticket='
  const ticket = value.startsWith(prefix) ? value.slice(prefix.length) : ''
  return validConversionTicket(ticket) ? ticket : undefined
}

export async function validateConversionPreview(value: unknown, learnerId: number): Promise<ConversionPreview> {
  if (!value || typeof value !== 'object') throw new Error('交接方案格式无效，请更新客户端或返回网页重新发起。')
  const data = value as ConversionPreview
  if (data.schema_version !== 'learnflow.work-task-conversion.v1') throw new Error('此方案需要更新版本的 LearnFlow 客户端。')
  if (data.learner_id !== learnerId) throw new Error('请使用生成此方案时的网页账号登录客户端。')
  if (!/^[a-f0-9]{64}$/.test(data.root_hash) || !data.candidate
    || !['experiment', 'practice'].includes(data.candidate.project_mode)
    || typeof data.candidate.title !== 'string' || typeof data.candidate.summary !== 'string'
    || !Number.isFinite(Date.parse(data.expires_at))) throw new Error('交接方案不完整，请返回网页重新发起。')
  if (!data.consumed && Date.parse(data.expires_at) < Date.now()) throw new Error('交接已过期，请返回网页重新点击“在客户端开始”。')
  if (!Array.isArray(data.starter_files) || !data.starter_files.length || data.starter_files.length > 32) throw new Error('初始文件清单无效。')
  const encoder = new TextEncoder()
  const manifest: { path: string; sha256: string; size: number }[] = []
  let total = 0
  const paths = new Set<string>()
  const hash = async (bytes: Uint8Array<ArrayBuffer>) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
  for (const file of data.starter_files) {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)
      || file.path.length > 240 || file.path.includes('\\') || file.path.split('/').some(part => !part || part.startsWith('.') || /[:\u0000-\u001f]/.test(part))
      || paths.has(file.path.toLowerCase())) throw new Error('初始文件路径无效或重复。')
    paths.add(file.path.toLowerCase())
    const bytes = encoder.encode(file.content)
    total += bytes.length
    if (bytes.length > 256 * 1024 || total > 2 * 1024 * 1024 || await hash(bytes) !== file.sha256) throw new Error('初始文件校验失败，请返回网页重新生成交接。')
    // Python canonical JSON keys are alphabetically sorted.
    manifest.push({ path: file.path, sha256: file.sha256, size: bytes.length })
  }
  if (await hash(encoder.encode(JSON.stringify(manifest))) !== data.starter_manifest_hash) throw new Error('初始文件清单已变化，请重新预览。')
  return data
}

export async function importActionId(ticket: string, learnerId: number) {
  // Never persist the bearer ticket in a cloud idempotency key or device journal.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ticket))
  const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  return `desktop-${learnerId}-${fingerprint}`
}
