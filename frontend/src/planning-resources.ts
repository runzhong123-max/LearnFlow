import type { SearchSource, TutorToolRun } from './tooling.ts'

export function resourceCandidates(runs: TutorToolRun[]): SearchSource[] {
  const candidates = new Map<string, SearchSource>()
  for (const run of runs) {
    if (run.status !== 'completed') continue
    for (const source of run.sources || []) {
      try {
        const url = new URL(source.url)
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue
        url.hash = ''
        candidates.set(url.href, { ...source, url: url.href })
      } catch { /* Invalid links cannot be selected. */ }
    }
  }
  return [...candidates.values()].slice(-24)
}

export function planningResourcePrompt(topic: string, project: boolean, stage: 'sources' | 'roadmap' | 'schedule') {
  const scope = project ? '围绕当前已绑定项目及其已有目标' : '围绕当前学习方向，不假定已有项目'
  if (stage === 'sources') return `${scope}“${topic}”，先推荐适合系统学习的开放教材、开源书籍、官方文档和开源仓库。请先读取已有资料，再检索并核验候选链接，按基础、语言、阅读负担、章节覆盖及开源许可是否已核验解释取舍。优先给一本主教材与一个配套仓库，不要只给概念介绍网页；在资料工作台选择或上传后再细化关卡、长期计划和实验。`
  if (stage === 'roadmap') return `${scope}“${topic}”，基于已选择并处理的资料，提出关卡草案：每关关联实际章节或文件、先修知识、学习目标、预计用时及可检查的练习。未读到的章节明确标为待核验。${project ? '复用当前项目路线工具生成需要我确认的关卡，不创建重复项目。' : '先给阶段建议，不自动创建项目或关卡。'}`
  return `${scope}“${topic}”，基于已有资料和关卡，给出长期学习计划草案。优先使用已知时间投入，不清楚时只问每周可用时间；说明每周阅读、复习、练习和检查点，标明假设并保留调整余量。正式保存需使用现有路线提案与确认流程。最后再提出与资料对应的实验和实践方案。`
}

export function planningSourceType(raw: string): 'github' | 'url' {
  const url = new URL(raw)
  return url.hostname === 'github.com' && /^\/[^/]+\/[^/]+\/?$/.test(url.pathname) ? 'github' : 'url'
}
