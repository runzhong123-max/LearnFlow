import { EvidenceInspector } from '../../../../packages/learning-client/src/memory/EvidenceInspector'
import { createEvidenceReader } from '../../../../packages/learning-client/src/memory/evidence'
import { runtimeFetch } from './runtime-client'

const reader = createEvidenceReader(runtimeFetch)
export function MemoryEvidencePanel(props: { scopeKey: string; nodeId?: number; reviewScheduleId?: number; label?: string }) {
  return <EvidenceInspector {...props} reader={reader} />
}
