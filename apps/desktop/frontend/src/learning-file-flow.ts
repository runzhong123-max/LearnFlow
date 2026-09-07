/** Pure projections of persisted file references; never infer learning evidence. */
export type LearningFileLink = { kind: 'lecture' | 'practice'; ref: string; title: string }
export function taskLearningFiles(task?: { artifact_refs?: Array<Record<string, unknown>> } | null): LearningFileLink[] {
  return (task?.artifact_refs || []).flatMap(item => {
    const title = String(item.title || item.logical_filename || '').replace(/\.lf(?:lecture|exercise)$/i, '')
    if (item.type === 'managed_lecture' && typeof item.id === 'number') return [{ kind: 'lecture' as const, ref: String(item.id), title: title || '讲义' }]
    if (item.type === 'managed_exercise' && typeof item.id === 'number') return [{ kind: 'practice' as const, ref: `exercise-${item.id}`, title: title || '练习' }]
    if ((item.kind === 'lecture' || item.kind === 'practice') && (typeof item.ref === 'number' || typeof item.ref === 'string' && item.ref.trim())) return [{ kind: item.kind, ref: String(item.ref), title: title || (item.kind === 'lecture' ? '讲义' : '练习') }]
    if (item.type === 'concept_question_set' && typeof item.checkpoint_id === 'number') return [{ kind: 'practice' as const, ref: `questions-${item.checkpoint_id}`, title: title || '练习' }]
    return []
  })
}
export function fileKindForStage(state?: string): 'lecture' | 'practice' {
  return state === 'practicing_in_file' || state === 'verification_ready' ? 'practice' : 'lecture'
}
export function fileProgressMessage(state: string): string {
  return ({
    reading_with_anchor: '讲义已准备好。从目录第一节开始阅读；遇到不清楚的段落可以选中追问。读完后点击“标记已读”，再打开配对练习。',
    practicing_in_file: '这次阅读已记录。接下来打开配对练习，在练习中正式提交答案；需要提示时可以回到对话。',
    verification_ready: '本轮已有正式作答记录。答错的题可以在题目内继续纠正，也可以开始独立验证。阅读和本次作答不代表稳定掌握。',
  } as Record<string, string>)[state] || ''
}
