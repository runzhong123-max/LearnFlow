import { useEffect, useRef, useState } from 'react'
import { isCloudDesktopRuntime, isDesktopRuntime } from './runtime-client'
import LocalAgentPanel from './LocalAgentPanel'
import { mergeWorkspaceRefresh } from './workspace-refresh'
import {
  confirmExperimentRun, linkProjectDirectory, listExperimentProfiles, listExperimentRuns,
  loadExperimentRun, loadWorkspaceTree, previewExperimentRun, readProjectFile, revealProjectFile,
  loadWorkspaceRecommendations, writeProjectFile, publishExperimentReport, publishFileReport, WorkbenchRequestError,
  type ArtifactReference, type ExperimentAction, type ExperimentProfile, type ExperimentRun,
  type WorkspaceFile, type WorkspaceNode, type WorkspaceTree, type StageAssistance, type WorkspaceRecommendations,
} from './project-workbench-api'

export type FileSelection = { path?: string; hash?: string; startLine?: number; endLine?: number; text: string; title: string }
type OpenFile = WorkspaceFile & { draft: string; conflict?: boolean }
type Props = {
  projectId: number; checkpointId?: number; openPaths: string[]; activePath?: string
  onLayout: (paths: string[], active: string) => void
  onAsk: (selection: FileSelection) => void
  onArtifact: (ref: ArtifactReference) => void
  onDirtyChange?: (dirty: boolean) => void
  starterFiles?: Array<{ path: string; content: string }>
  sessionId?: number
  engineeringContext?: string
  assistance?: StageAssistance
  assistanceAvailable?: boolean
}
const actions: Record<ExperimentAction, string> = { syntax: '检查语法', build: '构建', run: '运行', verify: '验证用例' }
const runningStatuses = new Set(['queued', 'running'])
const runLabels: Record<string, string> = { proposed: '等待确认', queued: '排队中', running: '运行中', completed: '已完成', failed: '失败', timed_out: '超时', output_limited: '输出达到上限', stale: '文件已变化', expired: '确认已过期', interrupted: '已中断' }

function allFiles(nodes: WorkspaceNode[]): string[] { return nodes.flatMap(node => node.is_directory ? allFiles(node.children || []) : node.kind === 'protected' ? [] : [node.path]) }

export default function ProjectFileWorkbench({ projectId, checkpointId, openPaths, activePath, onLayout, onAsk, onArtifact, onDirtyChange, starterFiles = [], sessionId, engineeringContext, assistance, assistanceAvailable }: Props) {
  const [tree, setTree] = useState<WorkspaceTree>()
  const [recommendations, setRecommendations] = useState<WorkspaceRecommendations>()
  const [recommendationError, setRecommendationError] = useState('')
  const [fileView, setFileView] = useState<'related' | 'all'>('related')
  const [scanRevision, setScanRevision] = useState(0)
  const [files, setFiles] = useState<OpenFile[]>([])
  const [active, setActive] = useState(activePath || '')
  const [root, setRoot] = useState('')
  const [createDir, setCreateDir] = useState(false)
  const [newPath, setNewPath] = useState('')
  const [selectedFiles, setSelectedFiles] = useState<string[]>([])
  const [profiles, setProfiles] = useState<ExperimentProfile[]>([])
  const [profileId, setProfileId] = useState('c11')
  const [stdin, setStdin] = useState('')
  const [expected, setExpected] = useState('')
  const [runs, setRuns] = useState<ExperimentRun[]>([])
  const [currentRun, setCurrentRun] = useState<ExperimentRun>()
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [unlinked, setUnlinked] = useState(false)
  const editor = useRef<HTMLTextAreaElement>(null)
  const state = useRef(files); state.current = files
  const current = files.find(file => file.path === active)
  const dirty = files.some(file => file.draft !== file.content)
  const desktop = isDesktopRuntime()
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false) }, [dirty, onDirtyChange])

  const refresh = async () => {
    try {
      const next = await loadWorkspaceTree(projectId)
      setTree(next); setUnlinked(false); setScanRevision(previous => previous + 1)
      setSelectedFiles(previous => previous.length ? previous.filter(path => allFiles(next.nodes).includes(path)) : allFiles(next.nodes).filter(path => /\.(c|h)$/i.test(path)).slice(0, 64))
      setError('')
    } catch (failure) {
      if (failure instanceof WorkbenchRequestError && failure.status === 404) setUnlinked(true)
      else setError(failure instanceof Error ? failure.message : '目录读取失败')
    }
  }
  useEffect(() => {
    if (!desktop) return
    let live = true
    void refresh()
    void listExperimentProfiles(projectId).then(result => live && setProfiles(result.profiles)).catch(failure => live && setError(failure.message))
    void listExperimentRuns(projectId).then(result => { if (live) { setRuns(result.runs); setCurrentRun(result.runs[0]) } }).catch(failure => live && setError(failure.message))
    void Promise.all(openPaths.map(path => readProjectFile(projectId, path).catch(() => undefined))).then(result => {
      if (!live) return
      const opened = result.filter((file): file is WorkspaceFile => !!file).map(file => ({ ...file, draft: file.content || '' }))
      setFiles(opened); setActive(opened.some(file => file.path === activePath) ? activePath! : opened[0]?.path || '')
    })
    return () => { live = false }
  }, [projectId, desktop])
  useEffect(() => {
    let live = true
    setRecommendations(undefined); setRecommendationError('')
    if (!desktop || !tree || !checkpointId || assistanceAvailable === false) return
    void loadWorkspaceRecommendations(projectId, checkpointId).then(result => { if (live) setRecommendations(result) })
      .catch(failure => { if (live) setRecommendationError(failure instanceof Error ? failure.message : '推荐暂不可用') })
    return () => { live = false }
  }, [projectId, checkpointId, desktop, tree?.workspace_id, scanRevision, assistanceAvailable])
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', protect)
    return () => window.removeEventListener('beforeunload', protect)
  }, [dirty])
  useEffect(() => {
    if (!desktop || !tree) return
    const checkExternal = async () => {
      await refresh()
      for (const open of state.current) {
        try {
          const latest = await readProjectFile(projectId, open.path)
          if (latest.sha256 === open.sha256) continue
          setFiles(previous => previous.map(file => file.path !== open.path || file.sha256 !== open.sha256 ? file : file.draft !== file.content ? { ...file, conflict: true } : { ...latest, draft: latest.content || '' }))
        } catch { /* A deleted or inaccessible file is reported on save/reload; preserve the draft. */ }
      }
    }
    window.addEventListener('focus', checkExternal)
    return () => window.removeEventListener('focus', checkExternal)
  }, [desktop, tree?.workspace_id, projectId])
  useEffect(() => {
    if (!currentRun || !runningStatuses.has(currentRun.status)) return
    let live = true
    const timer = window.setTimeout(() => {
      void loadExperimentRun(projectId, currentRun.id).then(next => {
        if (!live) return
        setCurrentRun(next); setRuns(previous => [next, ...previous.filter(run => run.id !== next.id)])
      }).catch(failure => live && setError(failure.message))
    }, 900)
    return () => { live = false; window.clearTimeout(timer) }
  }, [projectId, currentRun])

  const runAction = async (key: string, action: () => Promise<void>) => {
    setBusy(key); setError(''); setNotice('')
    try { await action() } catch (failure) { setError(failure instanceof Error ? failure.message : '操作失败') } finally { setBusy('') }
  }
  const open = async (path: string) => {
    if (!files.some(file => file.path === path)) {
      const loaded = await readProjectFile(projectId, path)
      const next = [...files, { ...loaded, draft: loaded.content || '' }]
      setFiles(next); onLayout(next.map(file => file.path), path)
    } else onLayout(files.map(file => file.path), path)
    setActive(path)
  }
  const close = (file: OpenFile) => {
    if (file.draft !== file.content && !confirm(`“${file.path}”尚未保存。关闭并放弃这次编辑？`)) return
    const next = files.filter(item => item.path !== file.path)
    const nextActive = active === file.path ? next[0]?.path || '' : active
    setFiles(next); setActive(nextActive); onLayout(next.map(item => item.path), nextActive)
  }
  const save = async () => {
    if (!current || current.content === null || current.read_only) return
    try {
      const submittedDraft = current.draft
      await writeProjectFile(projectId, current.path, submittedDraft, current.sha256 || null)
      const saved = await readProjectFile(projectId, current.path)
      setFiles(previous => previous.map(file => file.path === saved.path ? { ...saved, draft: file.draft === submittedDraft ? saved.content || '' : file.draft } : file))
      setNotice('已保存到本地文件。'); await refresh()
    } catch (failure) {
      if (failure instanceof WorkbenchRequestError && failure.status === 409) setFiles(previous => previous.map(file => file.path === current.path ? { ...file, conflict: true } : file))
      throw failure
    }
  }
  const reload = async () => {
    if (!current || (current.draft !== current.content && !confirm('重新读取磁盘版本会放弃当前编辑，是否继续？'))) return
    const latest = await readProjectFile(projectId, current.path)
    setFiles(previous => previous.map(file => file.path === latest.path ? { ...latest, draft: latest.content || '' } : file))
  }
  const ask = () => {
    if (!current || !editor.current) return
    const { selectionStart, selectionEnd } = editor.current
    const text = current.draft.slice(selectionStart, selectionEnd)
    if (!text.trim()) { setNotice('先选中代码，再打开提问纸。'); return }
    onAsk({ path: current.path, hash: current.draft === current.content ? current.sha256 : undefined, startLine: current.draft.slice(0, selectionStart).split('\n').length, endLine: current.draft.slice(0, selectionEnd).split('\n').length, text, title: `${current.path}${current.draft !== current.content ? ' · 未保存选区' : ''}` })
  }
  const preview = async (action: ExperimentAction) => {
    if (dirty) throw new Error('请先保存文件。运行使用磁盘中的固定版本。')
    const next = await previewExperimentRun(projectId, { profile_id: profileId, action, files: selectedFiles, stdin, args: [], test_cases: action === 'verify' ? [{ name: '预期输出用例', stdin, expected_stdout: expected }] : [], checkpoint_id: checkpointId })
    setCurrentRun(next); setRuns(previous => [next, ...previous.filter(run => run.id !== next.id)])
  }
  const attachRun = async (run: ExperimentRun) => {
    if (isCloudDesktopRuntime()) {
      if (!checkpointId) throw new Error('先选择项目阶段，再把运行摘要加入交付。')
      const report = await publishExperimentReport(projectId, run.id, checkpointId)
      onArtifact(report.artifact_ref)
      setNotice('已将运行摘要与文件摘要加入云端交付；源代码和完整日志仍在本机。报告包含已有工程助手辅助来源。')
    } else onArtifact({ kind: 'experiment_run', ref: String(run.id), revision: run.snapshot_hash })
  }
  const attachFile = async (file: WorkspaceFile) => {
    if (isCloudDesktopRuntime()) {
      if (!checkpointId) throw new Error('先选择项目阶段，再把文件摘要加入交付。')
      const report = await publishFileReport(projectId, file, checkpointId)
      onArtifact(report.artifact_ref)
      setNotice('已将文件路径和版本哈希加入云端交付；文件正文仍在本机。报告包含已有工程助手辅助来源。')
    } else onArtifact({ kind: 'workspace_file', ref: file.path, revision: file.sha256 })
  }
  const renderTree = (nodes: WorkspaceNode[]) => nodes.map(node => node.is_directory ? <details key={node.path} open><summary>{node.name}</summary><div>{renderTree(node.children || [])}</div></details> : <div className={`pw-tree-file ${active === node.path ? 'active' : ''}`} key={node.path}><input type="checkbox" aria-label={`运行包含 ${node.path}`} checked={selectedFiles.includes(node.path)} disabled={node.kind === 'protected'} onChange={event => setSelectedFiles(previous => event.target.checked ? [...previous, node.path] : previous.filter(path => path !== node.path))} /><button type="button" disabled={node.kind === 'protected'} title={node.path} onClick={() => void runAction('open', () => open(node.path))}>{node.name}{files.find(file => file.path === node.path && file.draft !== file.content) ? ' •' : ''}</button></div>)

  if (!desktop) return <div className="pw-empty"><span>LOCAL WORKSPACE</span><h2>把实验带到你的电脑上</h2><p>用 LearnFlow 桌面端打开这个项目，就能关联真实工程、编辑代码、构建和运行。你现在可以继续规划、读资料、写假设和整理交付。</p></div>
  return <div className="pw-file-workbench">
    {error && <div className="pw-error" role="alert">{error}</div>}{notice && <div className="pw-notice" role="status">{notice}</div>}
    {unlinked || !tree ? <div className="pw-directory-link"><h2>关联你的实验目录</h2><p>项目使用真实文件。可以继续在熟悉的 IDE 中编辑，回到这里和导师讨论。</p><label>本地绝对路径<input value={root} onChange={event => setRoot(event.target.value)} placeholder="/Users/you/projects/sat-lab" /></label><label className="pw-checkbox"><input type="checkbox" checked={createDir} onChange={event => setCreateDir(event.target.checked)} />目录不存在时创建</label><button disabled={!root.trim() || !!busy} onClick={() => void runAction('link', async () => { await linkProjectDirectory(projectId, root.trim(), createDir); await refresh() })}>关联目录</button>{!unlinked && <p>正在读取目录…</p>}</div> : <>
      {starterFiles.length > 0 && <div className="pw-starter-files"><strong>案例初始工程</strong><p>{starterFiles.map(file => file.path).join(' · ')}</p><button disabled={!!busy} onClick={() => void runAction('starter', async () => { let created = 0; const skipped: string[] = []; for (const file of starterFiles) { let exists = true; try { await readProjectFile(projectId, file.path) } catch (failure) { if (failure instanceof WorkbenchRequestError && failure.status === 404) exists = false; else throw failure } if (exists) { skipped.push(file.path); continue } await writeProjectFile(projectId, file.path, file.content, null); created++ } await refresh(); setNotice(`已准备 ${created} 个初始文件${skipped.length ? `；已存在的 ${skipped.join('、')} 保持原样` : ''}。`) })}>准备初始文件</button></div>}
      {isCloudDesktopRuntime() && <details className="pw-share-scope"><summary>加入云端交付会分享文件摘要与工程助手辅助来源 · 查看范围</summary><p>点击“加入云端交付”会将所选文件的路径、版本摘要、运行摘要，以及已有工程助手辅助来源（运行编号、阶段、文件摘要）发送到当前登录账号的这个云项目，供导师核对。文件正文和完整日志留在本机。</p></details>}
      <div className="pw-files-top"><strong>{tree.root_name}</strong><span>真实文件 · {selectedFiles.length} 个文件进入运行快照</span><button disabled={!!busy} onClick={() => void runAction('refresh', refresh)}>刷新</button><button onClick={() => void runAction('reveal', async () => { await revealProjectFile(projectId, current?.path || '.') })}>在文件管理器中显示</button></div>
      <div className="pw-editor-layout"><aside className="pw-file-tree" aria-label="实验文件">
        <div className="pw-file-view-switch" aria-label="文件导航"><button aria-pressed={fileView === 'related'} onClick={() => setFileView('related')}>相关文件</button><button aria-pressed={fileView === 'all'} onClick={() => setFileView('all')}>全部</button></div>
        {fileView === 'related' ? <div className="pw-recommended-files">
          <p>先从这些文件看起</p>
          {recommendations?.items.map(item => <button key={item.path} className={active === item.path ? 'active' : ''} onClick={() => void runAction('open', () => open(item.path))}><strong>{item.path}</strong><span>{item.reason}</span></button>)}
          {!recommendations?.items.length && <p role="status">{recommendationError || (!checkpointId ? '选择一个阶段后，查看相关文件。' : assistanceAvailable === false ? '本阶段暂无推荐。' : recommendations ? '暂无明确匹配，可展开全部文件。' : '正在查找本阶段文件…')}</p>}
          {recommendations?.truncated && <small>这里是部分结果，可从全部文件继续查找。</small>}
        </div> : <div>{renderTree(tree.nodes)}</div>}
        <details className="pw-new-file"><summary>新建文件</summary><form onSubmit={event => { event.preventDefault(); if (newPath.trim()) void runAction('create', async () => { await writeProjectFile(projectId, newPath.trim(), '', null); await refresh(); await open(newPath.trim()); setNewPath('') }) }}><input aria-label="新建文件路径" placeholder="新文件，如 src/main.c" value={newPath} onChange={event => setNewPath(event.target.value)} /><button disabled={!newPath.trim() || !!busy}>创建</button></form></details></aside>
        <section className="pw-editor-main"><nav className="pw-file-tabs" aria-label="打开的文件">{files.map(file => <div className={active === file.path ? 'active' : ''} key={file.path}><button onClick={() => { setActive(file.path); onLayout(files.map(item => item.path), file.path) }}>{file.path.split('/').pop()}{file.draft !== file.content ? ' •' : ''}</button><button aria-label={`关闭 ${file.path}`} onClick={() => close(file)}>×</button></div>)}</nav>
          {current ? <><div className="pw-editor-toolbar"><code title={current.path}>{current.path}</code><button onMouseDown={event => event.preventDefault()} onClick={ask} disabled={current.content === null}>选区提问</button><button disabled={!!busy || current.content === null || current.draft !== current.content} onClick={() => void runAction('file-report', () => attachFile(current))}>{isCloudDesktopRuntime() ? '加入云端交付' : '加入交付'}</button><button disabled={!!busy || current.content === null || current.read_only || current.draft === current.content} onClick={() => void runAction('save', save)}>保存 ⌘/Ctrl S</button><button onClick={() => void runAction('reload', reload)}>重读</button></div>
          {current.conflict && <div className="pw-error">磁盘文件已被其他编辑器修改，当前草稿已保留。请复制需要保留的内容后重读磁盘版本，再合并保存。</div>}
          {current.content === null ? <div className="pw-empty"><p>此文件不支持文本编辑。</p><button onClick={() => void runAction('external', async () => { await revealProjectFile(projectId, current.path, true) })}>用系统应用打开</button></div> : <div className="pw-code-area"><pre aria-hidden="true">{current.draft.split('\n').map((_, index) => index + 1).join('\n')}</pre><textarea ref={editor} aria-label={`编辑 ${current.path}`} spellCheck={false} wrap="off" value={current.draft} readOnly={current.read_only} onChange={event => { const draft = event.target.value; setFiles(previous => previous.map(file => file.path === current.path ? { ...file, draft } : file)) }} onScroll={event => { const gutter = event.currentTarget.previousElementSibling; if (gutter) gutter.scrollTop = event.currentTarget.scrollTop }} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void runAction('save', save) } if (event.key === 'Tab') { event.preventDefault(); const input = event.currentTarget; const start = input.selectionStart; const end = input.selectionEnd; const draft = current.draft.slice(0, start) + '  ' + current.draft.slice(end); setFiles(previous => previous.map(file => file.path === current.path ? { ...file, draft } : file)); requestAnimationFrame(() => { input.selectionStart = input.selectionEnd = start + 2 }) } }} /></div>}</> : <div className="pw-empty"><h3>从左侧打开文件</h3><p>先写下预测，再动手验证。勾选的文件会一同进入运行快照。</p></div>}
        </section>
      </div>
      <section className="pw-run-panel" aria-label="构建与运行"><header><strong>实验台</strong><select aria-label="运行环境" value={profileId} onChange={event => setProfileId(event.target.value)}>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}{!profile.available ? ' · 编译器不可用' : ''}</option>)}</select>{(['syntax', 'build', 'run', 'verify'] as ExperimentAction[]).map(action => <button key={action} disabled={!!busy || !selectedFiles.length || !profiles.find(profile => profile.id === profileId)?.available || !!currentRun && runningStatuses.has(currentRun.status)} onClick={() => void runAction(action, () => preview(action))}>{actions[action]}</button>)}</header>
        <details className="pw-run-input"><summary>输入与预期输出</summary><div><label>标准输入<textarea maxLength={8192} value={stdin} onChange={event => setStdin(event.target.value)} placeholder="程序通过 stdin 读取的内容" /></label><label>预期标准输出（验证用例）<textarea maxLength={8192} value={expected} onChange={event => setExpected(event.target.value)} placeholder="填写本次预测，再运行对比" /></label></div></details>
        {currentRun?.status === 'proposed' && <div className="pw-run-confirm"><strong>确认运行固定快照</strong><p>{currentRun.manifest.length} 个文件 · {actions[currentRun.action]} · {currentRun.snapshot_hash.slice(0, 12)}</p><p>{currentRun.result.warning || profiles.find(profile => profile.id === profileId)?.warning || '这是本机进程运行；文件系统、网络和密钥不受沙箱隔离。请仅运行你信任的工程。'}</p><button disabled={!!busy} onClick={() => void runAction('confirm-run', async () => { const next = await confirmExperimentRun(projectId, currentRun); setCurrentRun(next); setRuns(previous => [next, ...previous.filter(run => run.id !== next.id)]) })}>确认在本机执行</button><button onClick={() => setCurrentRun(undefined)}>暂不运行</button></div>}
        {currentRun && <div className="pw-run-output"><header><strong>#{currentRun.id} · {actions[currentRun.action]} · {runLabels[currentRun.status] || currentRun.status}</strong><span>{currentRun.result.passed === true ? '用例通过' : currentRun.result.passed === false ? '用例未通过' : ''}</span><button onClick={() => onAsk({ title: `运行 #${currentRun.id}`, text: JSON.stringify({ run_id: currentRun.id, snapshot_hash: currentRun.snapshot_hash, action: currentRun.action, status: currentRun.status, result: currentRun.result }, null, 2) })}>请导师解释</button><button disabled={!['completed', 'failed', 'timed_out', 'output_limited'].includes(currentRun.status)} onClick={() => void runAction('report', () => attachRun(currentRun))}>{isCloudDesktopRuntime() ? '加入云端交付' : '加入交付'}</button></header>{currentRun.result.error && <p className="pw-error">{currentRun.result.error}</p>}{currentRun.result.steps?.map((step, index) => <div key={index}><small>{step.name} · exit {step.exit_code}{step.timed_out ? ' · 超时' : ''}</small><pre>{step.stdout || ''}{step.stderr ? `\n${step.stderr}` : ''}{!step.stdout && !step.stderr ? '（无输出）' : ''}</pre></div>)}{runningStatuses.has(currentRun.status) && <p role="status">执行中，输出完成后自动更新…</p>}</div>}
        {runs.length > 0 && <details className="pw-run-history"><summary>运行历史（{runs.length}）</summary>{runs.map(run => <button key={run.id} onClick={() => setCurrentRun(run)}>#{run.id} {actions[run.action]} · {runLabels[run.status] || run.status}</button>)}</details>}
        <small className="pw-boundary">运行记录用于观察与复现。正式练习和独立验证会另外记录学习证据。</small>
      </section>
      {isCloudDesktopRuntime() && <LocalAgentPanel key={`${projectId}:${checkpointId || 0}`} projectId={projectId} checkpointId={checkpointId} sessionId={sessionId} context={engineeringContext} assistance={assistance} assistanceAvailable={assistanceAvailable} blocked={dirty} onAsk={onAsk} onApplied={async () => {
        await refresh()
        const opened = await Promise.all(state.current.map(file => readProjectFile(projectId, file.path).catch(() => undefined)))
        setFiles(previous => mergeWorkspaceRefresh(previous, opened))
        setNotice('工程改动已应用；期间新增的编辑已保留。请检查冲突与结果，再和当前导师复盘。')
      }} />}
    </>}
  </div>
}
