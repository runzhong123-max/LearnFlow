import './ai-content-notice.css'
import { AI_CONTENT_NOTICE } from './ai-content-export.ts'

/** Presentation only: never appended to model context or learning evidence. */
export default function AiContentNotice() {
  return <p className="lf-ai-content-notice">{AI_CONTENT_NOTICE}</p>
}
