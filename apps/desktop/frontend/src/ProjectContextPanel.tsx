import { useEffect, useMemo, useRef, useState } from 'react'
import {
  addFormalProjectUrl,
  createFormalProjectFreeSession,
  loadFormalProject,
  processFormalProjectSource,
  proposeFormalProjectKnowledgeBaseline,
  confirmFormalProjectKnowledgeBaseline,
  removeFormalProjectSource,
  updateFormalProjectSourceHealth,
  uploadFormalProjectFile,
} from './formal-runtime'
import type { FormalLearningFileRef, FormalLearningTask } from './formal-runtime'
import type { FormalProjectCheckpoint, FormalProjectWorkspace } from './project'

type PanelTab = 'checkpoints' | 'sources' | 'files'

export default function ProjectContextPanel({ projectId, onClose, onOpenCheckpoint, onOpenFree, onOpenFile, onGenerateFiles, onWorkspaceChange }: {
  projectId: number
  onClose: () => void
  onOpenCheckpoint: (workspace: FormalProjectWorkspace, checkpoint: FormalProjectCheckpoint) => void
  onOpenFree: (workspace: FormalProjectWorkspace, session: { session_id: number; title: string }) => void
  onOpenFile: (file: FormalLearningFileRef) => void
  onGenerateFiles: (task: FormalLearningTask) => Promise<void>
  onWorkspaceChange?: (workspace: FormalProjectWorkspace) => void
}) {
  const [workspace, setWorkspace] = useState<FormalProjectWorkspace>()
  const [activeTab, setActiveTab] = useState<PanelTab>('checkpoints')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [url, setUrl] = useState('')
  const [baselineProposal, setBaselineProposal] = useState<Record<string, any>>()
  const fileInput = useRef<HTMLInputElement>(null)

  const refresh = async () => {
    try {
      const next = await loadFormalProject(projectId)
      setWorkspace(next)
      onWorkspaceChange?.(next)
      setError('')
      return next
    }
    catch (failure) { setError(failure instanceof Error ? failure.message : '项目读取失败') }
  }
  useEffect(() => { void refresh() }, [projectId])

  const files = useMemo(() => workspace ? [...workspace.files.lectures, ...workspace.files.practices] : [], [workspace])

  const addUrl = async () => {
    if (!url.trim()) return
    setBusy('url')
    try {
      const pending = await addFormalProjectUrl(projectId, url.trim())
      await processFormalProjectSource(projectId, pending.id)
      setUrl('')
      await refresh()
    }
    catch (failure) { setError(failure instanceof Error ? failure.message : '来源添加失败') }
    finally { setBusy('') }
  }

  const upload = async (file?: File) => {
    if (!file) return
    setBusy('upload')
    try {
      const pending = await uploadFormalProjectFile(projectId, file)
      await processFormalProjectSource(projectId, pending.id)
      await refresh()
    }
    catch (failure) { setError(failure instanceof Error ? failure.message : '文件上传失败') }
    finally { setBusy(''); if (fileInput.current) fileInput.current.value = '' }
  }

  const mutateSource = async (sourceId: number, action: 'process' | 'remove') => {
    setBusy(`${action}:${sourceId}`)
    try {
      if (action === 'process') await processFormalProjectSource(projectId, sourceId)
      else await removeFormalProjectSource(projectId, sourceId)
      await refresh()
    } catch (failure) { setError(failure instanceof Error ? failure.message : '来源操作失败') }
    finally { setBusy('') }
  }

  const proposeBaseline = async () => {
    if (!workspace) return
    setBusy('baseline')
    try {
      const result = await proposeFormalProjectKnowledgeBaseline(
        projectId, workspace.sources.filter(source => source.status === 'processed').map(source => source.id),
        `${workspace.project.name} ${workspace.project.objective}`,
      )
      setBaselineProposal(result.proposal)
      setError('')
    } catch (failure) { setError(failure instanceof Error ? failure.message : '来源基线生成失败') }
    finally { setBusy('') }
  }

  const confirmBaseline = async () => {
    if (!baselineProposal?.id) return
    setBusy('baseline-confirm')
    try {
      await confirmFormalProjectKnowledgeBaseline(projectId, Number(baselineProposal.id))
      setBaselineProposal(undefined)
      await refresh()
    } catch (failure) { setError(failure instanceof Error ? failure.message : '来源基线确认失败') }
    finally { setBusy('') }
  }

  const changeSourceHealth = async (sourceId: number, action: 'quarantine' | 'restore' | 'mark_stale') => {
    setBusy(`health:${sourceId}`)
    try {
      await updateFormalProjectSourceHealth(projectId, sourceId, action, action === 'mark_stale' ? '学习者标记内容可能过时' : '')
      await refresh()
    } catch (failure) { setError(failure instanceof Error ? failure.message : '来源健康状态更新失败') }
    finally { setBusy('') }
  }

  const addFreeChat = async () => {
    if (!workspace) return
    setBusy('free')
    try {
      const session = await createFormalProjectFreeSession(projectId, `${workspace.project.name} · 自由对话`)
      const refreshed = await refresh()
      onOpenFree(refreshed || workspace, session)
    } catch (failure) { setError(failure instanceof Error ? failure.message : '对话创建失败') }
    finally { setBusy('') }
  }

  return (
    <aside className="project-context-panel" aria-label="项目面板">
      <header>
        <div><strong>{workspace?.project.name || '项目'}</strong><span>{workspace?.project.expected_outcome || '围绕真实产物推进'}</span></div>
        <button type="button" onClick={onClose} aria-label="关闭项目面板">×</button>
      </header>
      <nav>
        <button type="button" className={activeTab === 'checkpoints' ? 'active' : ''} onClick={() => setActiveTab('checkpoints')}>关卡</button>
        <button type="button" className={activeTab === 'sources' ? 'active' : ''} onClick={() => setActiveTab('sources')}>来源</button>
        <button type="button" className={activeTab === 'files' ? 'active' : ''} onClick={() => setActiveTab('files')}>讲义与练习</button>
      </nav>
      {error && <div className="project-panel-error">{error}</div>}
      {!workspace && <div className="page-loading">正在读取项目…</div>}
      {workspace && activeTab === 'checkpoints' && (
        <div className="project-drawer-body">
          <div className="project-drawer-section-title"><strong>关卡路线</strong><button type="button" onClick={() => void addFreeChat()} disabled={busy === 'free'}>＋ 自由对话</button></div>
          <p className="project-roadmap-boundary">未开始关卡可由项目 Tutor 调整；进入学习后即锁定。</p>
          <div className="project-drawer-list">
            {workspace.roadmap.checkpoints.map(checkpoint => <article key={checkpoint.id} className={`drawer-checkpoint drawer-checkpoint-${checkpoint.learning_status}`}>
              <span>{String(checkpoint.order).padStart(2, '0')}</span><div><strong>{checkpoint.title}</strong><p>{checkpoint.objective}</p><small>{checkpoint.editable ? '未开始 · 可调整' : '学习中/已完成 · 已锁定'}</small></div>
              <button type="button" onClick={() => onOpenCheckpoint(workspace, checkpoint)}>进入</button>
              {checkpoint.learning_task && <button type="button" className="drawer-file-action" onClick={() => void onGenerateFiles(checkpoint.learning_task!).then(refresh)}>生成文件</button>}
            </article>)}
            {!workspace.roadmap.checkpoints.length && <p className="project-drawer-empty">在当前对话中先确定目标、时间和产物，确认路线后关卡会出现在这里。</p>}
          </div>
          {workspace.free_sessions.length > 0 && <><div className="project-drawer-section-title"><strong>自由对话</strong></div><div className="project-free-list">{workspace.free_sessions.map(session => <button type="button" key={session.session_id} onClick={() => onOpenFree(workspace, session)}>{session.title}</button>)}</div></>}
        </div>
      )}
      {workspace && activeTab === 'sources' && (
        <div className="project-drawer-body">
          <section className="project-knowledge-baseline" aria-label="项目来源基线">
            <div className="project-drawer-section-title"><strong>来源基线</strong><button type="button" disabled={busy === 'baseline' || !workspace.sources.some(source => source.status === 'processed')} onClick={() => void proposeBaseline()}>{workspace.knowledge_baseline ? '重新核验' : '生成基线'}</button></div>
            {workspace.knowledge_baseline ? <p>状态 {String(workspace.knowledge_baseline.status)} · 覆盖 {Math.round(Number(workspace.knowledge_baseline.coverage?.ratio || 0) * 100)}% · {Array.isArray(workspace.knowledge_baseline.source_version_refs) ? workspace.knowledge_baseline.source_version_refs.length : 0} 个固定版本</p> : <p>确认后，项目 Tutor、路线与学习文件将共享这组版本化来源。</p>}
            {baselineProposal && <div className="project-baseline-proposal"><p>候选覆盖 {Math.round(Number(baselineProposal.coverage?.ratio || 0) * 100)}%；缺口：{(baselineProposal.unresolved_gaps || []).join('、') || '无'}</p><button type="button" disabled={busy === 'baseline-confirm' || String(baselineProposal.coverage?.gate_status || 'blocked') === 'blocked'} onClick={() => void confirmBaseline()}>{String(baselineProposal.coverage?.gate_status || 'blocked') === 'blocked' ? '需先补齐权威来源' : '确认作为项目基线'}</button></div>}
          </section>
          <div className="project-source-compact-add"><input value={url} onChange={event => setUrl(event.target.value)} placeholder="教材、文档或仓库 URL" /><button type="button" disabled={!url.trim() || busy === 'url'} onClick={() => void addUrl()}>添加</button></div>
          <button type="button" className="project-upload-compact" onClick={() => fileInput.current?.click()} disabled={busy === 'upload'}>＋ 上传本地文件</button>
          <input ref={fileInput} hidden type="file" onChange={event => void upload(event.target.files?.[0])} />
          <div className="project-drawer-list source-drawer-list">{workspace.sources.map(source => <article key={source.id}><div><strong>{source.name}</strong><span>{source.status === 'processed' ? `${source.chunk_count} 个版本化片段 · v${Number(source.active_version?.version || 1)} · ${String(source.active_version?.status || 'active')}` : source.status === 'quarantined' ? '已隔离，不参与新讲解' : '等待处理'}</span></div>{!['processed', 'quarantined'].includes(source.status) && <button type="button" disabled={busy.includes(String(source.id))} onClick={() => void mutateSource(source.id, 'process')}>处理</button>}{source.status === 'processed' && <button type="button" disabled={busy.includes(String(source.id))} onClick={() => void changeSourceHealth(source.id, 'mark_stale')}>标记过时</button>}{source.status === 'processed' && <button type="button" disabled={busy.includes(String(source.id))} onClick={() => void changeSourceHealth(source.id, 'quarantine')}>隔离</button>}{source.status === 'quarantined' && <button type="button" disabled={busy.includes(String(source.id))} onClick={() => void changeSourceHealth(source.id, 'restore')}>恢复</button>}<button type="button" className="drawer-remove" disabled={busy.includes(String(source.id))} onClick={() => { if (confirm(`移除来源“${source.name}”？`)) void mutateSource(source.id, 'remove') }}>移除</button></article>)}</div>
          {!workspace.sources.length && <p className="project-drawer-empty">还没有项目来源。上传文件或添加 URL 后，项目 Tutor 会优先使用它们。</p>}
        </div>
      )}
      {workspace && activeTab === 'files' && (
        <div className="project-drawer-body project-drawer-files">
          {files.map(file => <button type="button" key={`${file.kind}:${file.ref}`} onClick={() => onOpenFile(file)}><span>{file.kind === 'lecture' ? '讲义' : '练习'}</span><strong>{file.title}</strong><i>打开 ›</i></button>)}
          {!files.length && <p className="project-drawer-empty">关卡生成的讲义与练习会集中保存在这里。</p>}
        </div>
      )}
    </aside>
  )
}
