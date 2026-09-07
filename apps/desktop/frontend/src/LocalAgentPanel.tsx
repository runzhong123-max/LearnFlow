import { useEffect, useRef, useState } from 'react'
import {
  applyEngineeringRun, cancelEngineeringRun, confirmEngineeringRun, createEngineeringProfile,
  updateEngineeringProfile, listEngineeringProfiles, listEngineeringRuns, previewEngineeringRun, readEngineeringEvents, readEngineeringRun,
  type EngineeringEvent, type EngineeringProfile, type EngineeringRun, type EngineeringTaskKind,
} from './local-agent-api'
import type { FileSelection } from './ProjectFileWorkbench'

const presets: Array<{ label: string; task_type: EngineeringTaskKind; goal: string }> = [
  { label: '准备工程骨架', task_type: 'code_change', goal: '准备本阶段所需的最小可运行工程、目录与说明。保留学习者需要实现的 TODO，不完成目标任务的答案。' },
  { label: '调查构建失败', task_type: 'bug_fix', goal: '复现当前构建或运行失败，定位原因并提出最小修复。记录命令、退出码和仍待验证的问题。' },
  { label: '检查与补充测试', task_type: 'test', goal: '检查现有测试，补充接口与边界用例并实际运行。不要替学习者实现被测功能。' },
  { label: '整理复现与交接', task_type: 'documentation', goal: '基于当前文件和实际执行结果整理复现步骤、依赖、限制和交接说明。未执行的检查明确标记。' },
]
const labels: Record<string, string> = { proposed: '等待启动确认', queued: '排队中', running: '执行中', completed: '已完成 · 等待检查', applied: '改动已应用', failed: '执行失败', canceled: '已取消', interrupted: '运行已中断', stale: '文件版本已变化', expired: '确认已过期', timed_out: '执行超时', output_limited: '输出达到上限' }
const activeStates = new Set(['queued', 'running'])

export default function LocalAgentPanel({ projectId, checkpointId, sessionId, context, blocked = false, onAsk, onApplied }: {
  projectId: number; checkpointId?: number; sessionId?: number; context?: string
  blocked?: boolean; onAsk: (selection: FileSelection) => void; onApplied: () => Promise<void>
}) {
  const [profiles, setProfiles] = useState<EngineeringProfile[]>([])
  const [runs, setRuns] = useState<EngineeringRun[]>([])
  const [run, setRun] = useState<EngineeringRun>()
  const [events, setEvents] = useState<EngineeringEvent[]>([])
  const [goal, setGoal] = useState(presets[0].goal)
  const [taskType, setTaskType] = useState<EngineeringTaskKind>('code_change')
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [deletions, setDeletions] = useState<string[]>([])
  const [moves, setMoves] = useState<string[]>([])
  const sequence = useRef(0)
  const epoch = useRef(0)
  const update = (next: EngineeringRun) => { setRun(next); setRuns(previous => [next, ...previous.filter(item => item.id !== next.id)]) }
  const act = async (name: string, work: () => Promise<void>) => {
    const current = epoch.current; setBusy(name); setError('')
    if (blocked && ['preview', 'start', 'apply'].includes(name)) { setError('请先保存文件编辑，再预览、执行或应用工程改动。'); setBusy(''); return }
    try { await work() } catch (failure) { if (current === epoch.current) setError(failure instanceof Error ? failure.message : '工程助手操作失败') }
    finally { if (current === epoch.current) setBusy('') }
  }
  useEffect(() => {
    const current = ++epoch.current
    setRun(undefined); setRuns([]); setEvents([]); sequence.current = 0; setError('')
    void Promise.all([listEngineeringProfiles(projectId), listEngineeringRuns(projectId)]).then(([p, r]) => {
      if (current !== epoch.current) return
      setProfiles(p.profiles); setRuns(r.runs); setRun(r.runs[0])
    }).catch(failure => { if (current === epoch.current) setError(failure.message) })
    return () => { epoch.current++ }
  }, [projectId])
  useEffect(() => { setEvents([]); sequence.current = 0; setDeletions([]); setMoves([]) }, [run?.id])
  useEffect(() => {
    if (!run) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const [next, output] = await Promise.all([readEngineeringRun(projectId, run.id), readEngineeringEvents(projectId, run.id, sequence.current)])
        if (stopped) return
        const fresh = output.events.filter(event => event.sequence > sequence.current)
        sequence.current = Math.max(sequence.current, output.next_sequence)
        setEvents(previous => [...previous, ...fresh].slice(-150)); update(next)
        if (activeStates.has(next.status)) timer = setTimeout(refresh, 1200)
      } catch (failure) { if (!stopped) setError(failure instanceof Error ? failure.message : '运行状态读取失败') }
    }
    void refresh()
    return () => { stopped = true; clearTimeout(timer) }
  }, [projectId, run?.id, activeStates.has(run?.status || '')])
  const configuredProfile = profiles[0]
  const enabled = profiles.some(profile => profile.enabled && profile.last_probe?.available && profile.last_probe?.authenticated)
  const deleted = run?.changed_files.filter(file => ['deleted', 'delete'].includes(file.operation || file.change || file.kind || file.status || '')) || []
  const moved = run?.changed_files.filter(file => ['moved', 'move', 'renamed', 'rename'].includes(file.operation || file.change || file.kind || file.status || '')) || []
  const toggle = (values: string[], name: string) => values.includes(name) ? values.filter(value => value !== name) : [...values, name]
  const discuss = () => {
    if (!run) return
    onAsk({ title: `工程助手 · ${labels[run.status] || run.status}`, text: [
      `工程运行 #${run.id}，项目 ${projectId}，阶段 ${run.checkpoint_id || '项目范围'}。`,
      `目标：${run.goal}`, `状态：${run.status}`, `快照：${run.snapshot_hash}`,
      `摘要：${JSON.stringify(run.result ?? {}).slice(0, 1400)}`,
      '这是工程助手的辅助成果，不是我的独立学习证据。请解释改动依据、尚未验证的风险，以及下一步我应亲自完成的检查。',
    ].join('\n') })
  }
  return <section className="pw-engineering" aria-label="项目工程助手">
    <header><div><span>工程助手</span><h3>让导师的计划落到文件与运行</h3><p>在项目副本中读写文件、构建和执行 bash；结果经你检查后写回。</p></div></header>
    {error && <p className="pw-error" role="alert">{error}</p>}
    <details className="pw-engineering-setup" open={!enabled || undefined}><summary>{enabled ? '工程助手连接设置' : '连接工程助手'}</summary><p>使用本机已安装并登录的 Codex CLI。凭据仍由 CLI 管理。</p>{configuredProfile && <p>状态：{configuredProfile.last_probe?.available ? configuredProfile.last_probe.authenticated ? '已连接' : 'CLI 尚未登录' : '未找到可用 CLI'}{configuredProfile.last_probe?.message ? ` · ${configuredProfile.last_probe.message}` : ''}</p>}<label>可执行文件路径（留空自动查找）<input value={path} onChange={event => setPath(event.target.value)} placeholder="codex" /></label><button disabled={!!busy} onClick={() => void act('profile', async () => { if (configuredProfile) await updateEngineeringProfile(projectId, configuredProfile, path); else await createEngineeringProfile(projectId, path); setProfiles((await listEngineeringProfiles(projectId)).profiles) })}>{configuredProfile ? '保存并重新检查连接' : '连接工程助手'}</button></details>
    <div className="pw-engineering-presets">{presets.map(preset => <button key={preset.task_type} disabled={!!busy} onClick={() => { setGoal(preset.goal); setTaskType(preset.task_type) }}>{preset.label}</button>)}</div>
    <label>本次委派目标<textarea value={goal} maxLength={2000} onChange={event => setGoal(event.target.value)} /></label>
    <p>当前范围：{checkpointId ? `阶段 #${checkpointId}` : '项目准备'}。助手产生的代码和修复作为辅助成果留存。</p>
    <div className="pw-engineering-actions"><button disabled={!!busy || !goal.trim()} onClick={() => onAsk({ title: '准备工程委派', text: `${context || ''}\n我想委派工程助手：${goal}\n请先检查任务范围、保留给我完成的部分，以及应运行的验证。` })}>先和当前导师讨论</button><button className="pw-primary" disabled={!!busy || !enabled || !goal.trim()} onClick={() => void act('preview', async () => update(await previewEngineeringRun(projectId, { goal, task_type: taskType, checkpoint_id: checkpointId, session_id: sessionId, constraints: [(context || '围绕当前学习项目').slice(0, 500), '不得替学习者完成当前独立考核；保留学习者需要动手的部分。', '只报告实际运行过的命令和测试，未验证的内容明确标注。'] }))) }>预览委派与文件范围</button></div>
    <p className="pw-engineering-boundary">使用隔离副本；网络和同主机读取边界未受管。执行结果不自动通过学习关卡。</p>
    {!!runs.length && <label>恢复运行<select value={run?.id || ''} onChange={event => setRun(runs.find(item => item.id === Number(event.target.value)))}>{runs.map(item => <option value={item.id} key={item.id}>#{item.id} · {labels[item.status] || item.status} · {item.goal.slice(0, 35)}</option>)}</select></label>}
    {run && <article className="pw-engineering-run"><h4>#{run.id} · {labels[run.status] || run.status}</h4><p>{run.goal}</p>
      {run.status === 'proposed' && <><details><summary>包含的文件（{Object.keys(run.manifest?.included || {}).length}）</summary><ul>{Object.keys(run.manifest?.included || {}).map(path => <li key={path}>{path}</li>)}</ul></details><button className="pw-primary" disabled={!!busy} onClick={() => void act('start', async () => update(await confirmEngineeringRun(projectId, run)))}>确认在副本中执行</button></>}
      {activeStates.has(run.status) && <button disabled={!!busy} onClick={() => void act('cancel', async () => update(await cancelEngineeringRun(projectId, run)))}>停止本次执行</button>}
      {!!events.length && <details open={activeStates.has(run.status)}><summary>操作与输出（最近 {events.length} 条）</summary><pre>{events.map(event => `${event.sequence} ${event.event_type}\n${JSON.stringify(event.payload, null, 2)}`).join('\n')}</pre></details>}
      {run.diff_text && <details open><summary>文件改动预览</summary><pre>{run.diff_text}</pre></details>}
      {run.status === 'completed' && <>{deleted.map(file => <label key={file.path}><input type="checkbox" checked={deletions.includes(file.path)} onChange={() => setDeletions(toggle(deletions, file.path))} />确认删除 {file.path}</label>)}{moved.map(file => <label key={file.path}><input type="checkbox" checked={moves.includes(file.path)} onChange={() => setMoves(toggle(moves, file.path))} />确认移动 {file.path} → {file.destination_path || file.path}</label>)}<button className="pw-primary" disabled={!!busy || !run.result_hash || deletions.length !== deleted.length || moves.length !== moved.length} onClick={() => void act('apply', async () => { update(await applyEngineeringRun(projectId, run, deletions, moves)); await onApplied() })}>确认应用这份改动</button></>}
      {!activeStates.has(run.status) && run.status !== 'proposed' && <button onClick={discuss}>把结果交给当前导师复盘</button>}
    </article>}
  </section>
}
