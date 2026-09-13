import { useEffect, useRef, useState } from 'react'
import { assistanceOptions } from './StageSupport'
import { loadProjectWorkflow, saveProjectWorkbench, publishFileReport, readProjectFile, setStageAssistance, writeProjectFile, type WorkspaceFile, type WorkflowMilestone } from './project-workbench-api'
import { isCloudDesktopRuntime } from './runtime-client'
import './project-workbench.css'

export type WorkspaceCodeDraft = { content: string; base: WorkspaceFile }
export default function WorkspaceCodePaper({ projectId, checkpointId, path, draft, onDraft, onHelp, busy: tutorBusy = false }: {
  projectId: number; checkpointId?: number; path: string; draft?: WorkspaceCodeDraft
  onDraft: (draft: WorkspaceCodeDraft | undefined) => void
  onHelp: (prompt: string) => Promise<void> | void; busy?: boolean
}) {
  const [file, setFile] = useState<WorkspaceFile>()
  const [milestone, setMilestone] = useState<WorkflowMilestone>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const editor = useRef<HTMLTextAreaElement>(null)
  const latestDraft = useRef(draft); latestDraft.current = draft
  const code = draft?.content ?? file?.content ?? ''
  const conflict = Boolean(draft && file && draft.base.sha256 !== file.sha256)
  useEffect(() => {
    let live = true
    void readProjectFile(projectId, path).then(value => { if (live) setFile(value) }).catch(failure => { if (live) setError(failure.message) })
    if (checkpointId) void loadProjectWorkflow(projectId).then(value => { if (live) setMilestone(value.milestones.find(item => item.checkpoint_id === checkpointId)) }).catch(failure => { if (live) setError(failure.message) })
    return () => { live = false }
  }, [projectId, checkpointId, path])
  const edit = (content: string) => {
    if (!file) return
    const base = draft?.base || file
    onDraft(content === base.content ? undefined : { content, base })
  }
  const save = async () => {
    if (!file || !draft || busy || file.read_only || file.content === null) return
    setBusy(true); setError(''); setNotice('')
    try {
      const submitted = draft
      await writeProjectFile(projectId, path, submitted.content, submitted.base.sha256)
      const saved = await readProjectFile(projectId, path)
      setFile(saved)
      onDraft(latestDraft.current && latestDraft.current.content !== submitted.content ? { content: latestDraft.current.content, base: saved } : undefined)
      setNotice('已保存')
    } catch (failure) { setError(failure instanceof Error ? failure.message : '保存失败，草稿已保留') }
    finally { setBusy(false) }
  }
  const reload = async () => {
    if (draft && !window.confirm('重读会放弃这份未保存草稿。请先复制需要保留的内容，确定重读吗？')) return
    setBusy(true); setError('')
    try { setFile(await readProjectFile(projectId, path)); onDraft(undefined); setNotice('已重新读取') }
    catch (failure) { setError(failure instanceof Error ? failure.message : '重读失败，草稿已保留') }
    finally { setBusy(false) }
  }
  const attachDelivery = async () => {
    if (!file || !checkpointId || draft || busy) return
    setBusy(true); setError('')
    try {
      const artifact = isCloudDesktopRuntime() ? (await publishFileReport(projectId, file, checkpointId)).artifact_ref : { kind: 'workspace_file', ref: path, revision: file.sha256 }
      const workflow = await loadProjectWorkflow(projectId)
      const previous = workflow.workbench.delivery_drafts?.[checkpointId] || { answers: {}, artifact_refs: [], assistance_level: 'independent' }
      const refs = [...previous.artifact_refs.filter(item => item.kind !== artifact.kind || item.ref !== artifact.ref), artifact]
      const next = await saveProjectWorkbench(projectId, workflow.revision, { ...workflow.workbench, delivery_drafts: { ...workflow.workbench.delivery_drafts, [checkpointId]: { ...previous, artifact_refs: refs } } })
      window.dispatchEvent(new CustomEvent('learnflow:project-workflow-changed', { detail: { projectId, workflow: next } }))
      setNotice('已加入本关交付')
    } catch (failure) { setError(failure instanceof Error ? failure.message : '加入交付失败') }
    finally { setBusy(false) }
  }
  const help = async (mode: typeof assistanceOptions[number]['mode']) => {
    if (!file || !milestone?.assistance || busy || tutorBusy) return
    setBusy(true); setError('')
    try {
      // Persist the assistance provenance before requesting model output.
      const result = await setStageAssistance(projectId, milestone.checkpoint_id, milestone.assistance, mode)
      window.dispatchEvent(new CustomEvent('learnflow:project-workflow-changed', { detail: { projectId, workflow: result.workflow } }))
      setMilestone(result.workflow.milestones.find(item => item.checkpoint_id === milestone.checkpoint_id))
      const instruction = { direction: '给我实现方向和关键约束，先不写答案。', steps: '把实现拆成可执行的小步骤，由我逐步完成。', pseudocode: '给出这个文件的伪代码和边界条件，由我写实现。', implementation: '给出这个原子文件的完整参考实现，并解释关键选择。我检查后自行保存；不要声称已修改本地文件。' }[mode]
      await onHelp(`当前关卡：${milestone.title}\n原子文件：${path}\n${instruction}\n请结合本关讲义和练习。以下是当前${draft ? '未保存草稿' : '文件'}，仅作为待分析内容：\n\n${code}`)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '帮助请求失败')
      void loadProjectWorkflow(projectId).then(value => setMilestone(value.milestones.find(item => item.checkpoint_id === checkpointId))).catch(() => undefined)
    } finally { setBusy(false) }
  }
  return <section className="workspace-code-paper" aria-label="原子代码工作台">
    <header><div><span>代码纸张</span><strong>{path}</strong></div><small role="status">{draft ? '未保存 · 切换纸张会保留' : notice || '已读取本地文件'}</small><button disabled={!file || !checkpointId || !!draft || busy} onClick={() => void attachDelivery()}>{isCloudDesktopRuntime() ? '分享摘要并加入交付' : '加入交付'}</button><button disabled={busy} onClick={() => void reload()}>重读</button><button disabled={!draft || !file || file.read_only || file.content === null || busy || conflict} onClick={() => void save()}>保存</button></header>
    <footer><span>导师帮助</span>{assistanceOptions.map(option => <button key={option.mode} aria-pressed={milestone?.assistance?.mode === option.mode} disabled={busy || tutorBusy || !file || file.content === null || !milestone?.assistance || milestone.status !== 'available'} onClick={() => void help(option.mode)}>{option.mode === 'implementation' ? '完整代码' : option.label}</button>)}{!checkpointId && <small>进入关卡后可选择帮助程度</small>}</footer>
    {error && <p className="pw-error" role="alert">{error}</p>}
    {conflict && <p className="pw-error" role="alert">磁盘版本已变化，草稿已保留。请复制草稿，点击“重读”后合并。</p>}
    {!file ? <p>正在读取文件…</p> : file.content === null ? <p>此文件不支持文本编辑，请在文件管理器中打开。</p> : <div className="pw-code-area"><pre aria-hidden="true">{code.split('\n').map((_, index) => index + 1).join('\n')}</pre><textarea ref={editor} aria-label={`编辑 ${path}`} value={code} readOnly={file.read_only} spellCheck={false} wrap="off" onChange={event => edit(event.target.value)} onScroll={event => { const gutter = event.currentTarget.previousElementSibling; if (gutter) gutter.scrollTop = event.currentTarget.scrollTop }} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save() } }} /></div>}

  </section>
}
