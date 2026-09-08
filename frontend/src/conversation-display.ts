type DisplayMessage = { role: string; content: string; createdAt: number; hiddenFromTranscript?: boolean }
export function conversationTitle(title: string, messages: DisplayMessage[]) {
  if (title.trim() && title !== '新对话') return title
  const first = messages.find(message => message.role === 'user' && !message.hiddenFromTranscript && message.content.trim())
  return first ? first.content.replace(/\s+/g, ' ').trim().slice(0, 28) : '新对话'
}
export function conversationActivity(conversation: { updatedAt: number; messages: DisplayMessage[] }) {
  const times = conversation.messages.filter(message => (message.role === 'user' || message.role === 'assistant') && !message.hiddenFromTranscript).map(message => message.createdAt).filter(Number.isFinite)
  return times.length ? Math.max(...times) : conversation.updatedAt
}
export function recentConversations<T extends { id: string; updatedAt: number; messages: DisplayMessage[] }>(conversations: T[]) {
  return [...conversations].sort((a,b) => conversationActivity(b) - conversationActivity(a) || a.id.localeCompare(b.id))
}
