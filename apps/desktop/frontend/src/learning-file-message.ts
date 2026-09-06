export type ConversationLearningFile = {
  kind: 'lecture' | 'practice'
  ref: string
  title: string
  questionCount?: number
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function humanizeLearningFileReferences(
  content: string,
  files: ConversationLearningFile[],
) {
  let next = content
  for (const file of files) {
    if (!file.ref || !file.title) continue
    const ref = escapeRegExp(file.ref)
    const title = escapeRegExp(file.title)
    next = next
      .replace(new RegExp(`\`${ref}\``, 'g'), `**${file.title}**`)
      .replace(new RegExp(`(?<![\\w-])${ref}(?![\\w-])`, 'g'), file.title)
      .replace(
        new RegExp(`(\\*\\*(?:练习文件|讲义文件)[：:]\\*\\*\\s*)\\*\\*${title}\\*\\*\\s*\\*\\*标题[：:]\\*\\*\\s*${title}`, 'g'),
        `$1**${file.title}**`,
      )
  }

  // Models often repeat “文件 ref + 标题” even though the file tool already
  // returned a typed artifact. Keep the student-facing sentence natural.
  return next.replace(
    /(练习文件|讲义文件)\s*[：:]\s*\*\*([^*]+)\*\*\s*(?:标题\s*[：:]\s*)?\2/g,
    '$1：**$2**',
  )
}

export function plainLearningFileExcerpt(value: string, limit = 180) {
  const plain = value
    .replace(/```[\s\S]*?```/g, ' 代码示例 ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > limit ? `${plain.slice(0, limit).trimEnd()}…` : plain
}
