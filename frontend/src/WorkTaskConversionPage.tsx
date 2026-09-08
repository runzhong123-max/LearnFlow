import SharedWorkTaskConversionPage from '../../packages/learning-client/src/work-task-conversion/WorkTaskConversionPage.tsx'
import { runtimeFetch } from './runtime-client.ts'
import type { AuthGateSession } from './AuthGate.tsx'

export default function WorkTaskConversionPage({auth}: {auth:AuthGateSession}) {
  return <SharedWorkTaskConversionPage fetcher={runtimeFetch} onSignOut={()=>void auth.signOut()}/>
}
