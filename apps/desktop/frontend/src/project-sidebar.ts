import type { FormalProjectCheckpoint, FormalProjectWorkspace } from './project'

export type LocalProjectConversationRef = {
  id: string
  title: string
  formalSessionId?: number
  projectRole?: 'tutor' | 'checkpoint' | 'free'
  checkpointId?: number
}

export type ProjectSidebarChat<T extends LocalProjectConversationRef = LocalProjectConversationRef> = {
  key: string
  role: 'tutor' | 'checkpoint' | 'free'
  title: string
  conversation?: T
  checkpoint?: FormalProjectCheckpoint
  session?: { session_id: number; title: string }
}

export function projectSidebarChats<T extends LocalProjectConversationRef>(
  projectWorkspace: FormalProjectWorkspace | undefined,
  localConversations: T[],
): ProjectSidebarChat<T>[] {
  if (!projectWorkspace) {
    return localConversations.map(conversation => ({
      key: `local:${conversation.id}`,
      role: conversation.projectRole || 'free',
      title: conversation.title,
      conversation,
    }))
  }
  const descriptors: ProjectSidebarChat<T>[] = [
    {
      key: `session:${projectWorkspace.project_tutor.session_id}`,
      role: 'tutor',
      title: projectWorkspace.project_tutor.title,
      session: projectWorkspace.project_tutor,
    },
    ...projectWorkspace.roadmap.checkpoints.map(checkpoint => ({
      key: `session:${checkpoint.session_id}`,
      role: 'checkpoint' as const,
      title: checkpoint.title,
      checkpoint,
    })),
    ...projectWorkspace.free_sessions.map(session => ({
      key: `session:${session.session_id}`,
      role: 'free' as const,
      title: session.title,
      session,
    })),
  ]
  const matched = new Set<string>()
  const formalEntries = descriptors.map(descriptor => {
    const conversation = localConversations.find(item => (
      item.formalSessionId === descriptor.session?.session_id
      || item.formalSessionId === descriptor.checkpoint?.session_id
      || (!item.formalSessionId && item.projectRole === descriptor.role
        && (descriptor.role !== 'checkpoint' || item.checkpointId === descriptor.checkpoint?.id)
        && item.title === descriptor.title)
    ))
    if (conversation) matched.add(conversation.id)
    return { ...descriptor, conversation }
  })
  return [
    ...formalEntries,
    ...localConversations.filter(item => !matched.has(item.id)).map(conversation => ({
      key: `local:${conversation.id}`,
      role: conversation.projectRole || 'free',
      title: conversation.title,
      conversation,
    })),
  ]
}
