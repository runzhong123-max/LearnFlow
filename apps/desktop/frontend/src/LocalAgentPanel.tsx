import { useEffect, useRef, useState } from 'react'
import {
  applyEngineeringRun, cancelEngineeringRun, confirmEngineeringRun, createEngineeringProfile,
  updateEngineeringProfile, listEngineeringProfiles, listEngineeringRuns, previewEngineeringRun, readEngineeringEvents, readEngineeringRun,
  type EngineeringEvent, type EngineeringProfile, type EngineeringRun, type EngineeringTaskKind,
} from './local-agent-api'
import { assistanceLabel } from './StageSupport'
import type { StageAssistance } from './project-workbench-api'
import type { FileSelection } from './ProjectFileWorkbench'

const presets: Array<{ label: string; task_type: EngineeringTaskKind; goal: string }> = [
  { label: '准备工程骨架', task_type: 'code_change', goal: '准备本阶段所需的最小可运行工程、目录与说明。保留学习者需要实现的 TODO，不完成目标任务的答案。' },
  { label: '调查构建失败', task_type: 'bug_fix', goal: '复现当前构建或运行失败，定位原因并提出最小修复。记录命令、退出码和仍待验证的问题。' },
  { label: '检查与补充测试', task_type: 'test', goal: '检查现有测试，补充接口与边界用例并实际运行。不要替学习者实现被测功能。' },
  { label: '整理复现与交接', task_type: 'documentation', goal: '基于当前文件和实际执行结果整理复现步骤、依赖、限制和交接说明。未执行的检查明确标记。' },
]
const readOnlyGoals: Record<EngineeringTaskKind, string> = {
  code_change: '阅读本阶段相关文件，指出需要由我实现的部分、起点与验收方式。只给当前帮助档位允许的指导，不修改文件。',
  bug_fix: '只读检查当前代码与已有错误记录，定位最可能的原因并告诉我下一步如何验证，不修改文件。',
  test: '阅读现有代码和测试，指出缺少的边界场景与我需要编写的用例，不修改文件。',
  documentation: '阅读现有工程，说明文件之间的关系与交接要点，让我自己整理复现说明，不修改文件。',
}
const labels: Record<string, string> = { proposed: '等待启动确认', queued: '排队中', running: '执行中', completed: '已完成 · 等待检查', applied: '改动已应用', failed: '执行失败', canceled: '已取消', interrupted: '运行已中断', stale: '文件版本已变化', expired: '确认已过期', timed_out: '执行超时', output_limited: '输出达到上限' }
const activeStates = new Set(['queued', 'running'])

export default function LocalAgentPanel({ projectId, checkpointId, sessionId, context, assistance, assistanceAvailable, blocked = false, onAsk, onApplied }: {
  projectId: number; checkpointId?: number; sessionId?: number; context?: string
  assistance?: StageAssistance; assistanceAvailable?: boolean
  blocked?: boolean; onAsk: (selection: FileSelection) => void; onApplied: () => Promise<void>
}) {
  const readOnly = assistance ? assistance.execution_mode !== 'workspace_write' : assistanceAvailable === false
  const unavailable = assistanceAvailable === false
  const [profiles, setProfiles] = useState<EngineeringProfile[]>([])
  const [runs, setRuns] = useState<EngineeringRun[]>([])
  const [run, setRun] = useState<EngineeringRun>()
  const [events, setEvents] = useState<EngineeringEvent[]>([])
  const [goal, setGoal] = useState(readOnly ? readOnlyGoals.code_change : presets[0].goal)
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
  useEffect(() => {
    const defaults = [...presets.map(item => item.goal), ...Object.values(readOnlyGoals)]
    setGoal(previous => !previous.trim() || defaults.includes(previous) ? readOnly ? readOnlyGoals[taskType] : presets.find(item => item.task_type === taskType)!.goal : previous)
  }, [assistance?.mode, taskType])
  const stalePolicy = !!run && !!assistance && (run.checkpoint_id !== checkpointId || run.assistance_policy?.revision !== assistance.revision || run.assistance_policy?.mode !== assistance.mode)
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
      `帮助档位：${assistanceLabel(run.assistance_policy?.mode)}`,
      `分析：${(run.advice || '').slice(0, 6000)}`, `摘要：${JSON.stringify(run.result ?? {}).slice(0, 1400)}`,
      '这是工程助手的辅助成果，不是我的独立学习证据。请解释改动依据、尚未验证的风险，以及下一步我应亲自完成的检查。',
    ].join('\n') })
  }
  return <details className="pw-engineering" aria-label="项目工程助手">
    <summary><span><strong>需要工程助手看看？</strong><small>{readOnly ? '读取工程，帮你定位和理解' : '在副本中提出改动，检查后再写回'}</small></span><span className="pw-permission-pill">{readOnly ? '只读分析' : '可提议修改'}</span></summary>
    <div className="pw-engineering-body">
      {error && <p className="pw-error" role="alert">{error}</p>}
      {unavailable && <p role="status">请选择一个进行中的阶段，再请工程助手帮忙。</p>}
      <details className="pw-engineering-setup"><summary>{enabled ? '已连接 · 连接设置' : '先连接本机工程助手'}</summary><p>使用本机已安装并登录的 Codex CLI。</p>
        {configuredProfile && <p>{configuredProfile.last_probe?.message || (enabled ? '连接可用' : '请检查 CLI 安装和登录状态')}</p>}
        <label>程序路径（留空自动查找）<input value={path} onChange={event => setPath(event.target.value)} placeholder="codex" /></label>
        <button disabled={!!busy} onClick={() => void act('profile', async () => { if (configuredProfile) await updateEngineeringProfile(projectId, configuredProfile, path); else await createEngineeringProfile(projectId, path); setProfiles((await listEngineeringProfiles(projectId)).profiles) })}>{configuredProfile ? '保存并检查连接' : '连接工程助手'}</button>
      </details>
      <label>这次需要什么帮助<select value={taskType} onChange={event => setTaskType(event.target.value as EngineeringTaskKind)}><option value="code_change">{readOnly ? '找实现起点' : '准备工程骨架'}</option><option value="bug_fix">调查失败原因</option><option value="test">{readOnly ? '检查测试思路' : '检查与补充测试'}</option><option value="documentation">{readOnly ? '理解工程与交接' : '整理复现与交接'}</option></select></label>
      <label>具体卡在哪里<textarea value={goal} maxLength={2000} onChange={event => setGoal(event.target.value)} /></label>
      <div className="pw-engineering-actions"><button className="pw-primary" disabled={!!busy || unavailable || !enabled || !goal.trim() || blocked} onClick={() => void act('preview', async () => update(await previewEngineeringRun(projectId, { goal, task_type: taskType, checkpoint_id: checkpointId, session_id: sessionId, constraints: [(context || '围绕当前学习项目').slice(0, 500), '不得替学习者完成当前独立考核；保留学习者需要动手的部分。', '只报告实际执行的检查，未验证的内容明确标注。'] }))) }>{busy === 'preview' ? '正在准备…' : readOnly ? '预览只读分析' : '预览修改任务'}</button><button disabled={!!busy || !goal.trim()} onClick={() => onAsk({ title: '工程问题', text: `${context || ''}\n我的工程问题：${goal}\n请按当前「${assistanceLabel(assistance?.mode)}」档位帮助我。` })}>先问导师</button></div>
      {blocked && <p role="status">先保存当前文件编辑，再让助手读取这一版工程。</p>}
      <details className="pw-engineering-boundary"><summary>执行范围与运行历史{runs.length ? `（${runs.length}）` : ''}</summary><p>在隔离副本中运行。网络和同主机读取边界未受管；结果用于工程复盘，不自动通过学习关卡。</p>{!!runs.length && <label>查看历史运行<select value={run?.id || ''} onChange={event => setRun(runs.find(item => item.id === Number(event.target.value)))}>{runs.map(item => <option value={item.id} key={item.id}>#{item.id} · {labels[item.status] || item.status} · {item.goal.slice(0, 35)}</option>)}</select></label>}</details>
      {run && <article className="pw-engineering-run"><h4>#{run.id} · {labels[run.status] || run.status}</h4><p>{run.goal}</p>
        {stalePolicy && <p className="pw-notice" role="status">帮助档位或阶段已变化。要继续执行或写回，请重新预览任务。</p>}
        {run.status === 'proposed' && <><details><summary>本次读取的文件（{Object.keys(run.manifest?.included || {}).length}）</summary><ul>{Object.keys(run.manifest?.included || {}).map(path => <li key={path}>{path}</li>)}</ul></details><p>{run.assistance_policy?.execution_mode === 'read_only' ? '只读分析，不产生可写回的改动。' : '先在副本中工作；完成后由你检查改动。'}</p><button className="pw-primary" disabled={!!busy || stalePolicy || unavailable || blocked} onClick={() => void act('start', async () => update(await confirmEngineeringRun(projectId, run)))}>{run.assistance_policy?.execution_mode === 'read_only' ? '确认开始只读分析' : '确认在副本中执行'}</button></>}
        {activeStates.has(run.status) && <button disabled={!!busy} onClick={() => void act('cancel', async () => update(await cancelEngineeringRun(projectId, run)))}>停止本次执行</button>}
        {run.advice && <div className="pw-agent-advice"><strong>助手的分析</strong><pre>{run.advice}</pre></div>}
        {!!events.length && <details><summary>操作记录（最近 {events.length} 条）</summary><pre>{events.map(event => `${event.sequence} ${event.event_type}\n${JSON.stringify(event.payload, null, 2)}`).join('\n')}</pre></details>}
        {run.diff_text && <details><summary>检查文件改动（{run.changed_files.length}）</summary><pre>{run.diff_text}</pre></details>}
        {run.status === 'completed' && run.can_apply === true && <>{deleted.map(file => <label key={file.path}><input type="checkbox" checked={deletions.includes(file.path)} onChange={() => setDeletions(toggle(deletions, file.path))} />确认删除 {file.path}</label>)}{moved.map(file => <label key={file.path}><input type="checkbox" checked={moves.includes(file.path)} onChange={() => setMoves(toggle(moves, file.path))} />确认移动 {file.path} → {file.destination_path || file.path}</label>)}<button className="pw-primary" disabled={!!busy || stalePolicy || unavailable || blocked || !run.result_hash || deletions.length !== deleted.length || moves.length !== moved.length} onClick={() => void act('apply', async () => { update(await applyEngineeringRun(projectId, run, deletions, moves)); await onApplied() })}>确认应用这份改动</button></>}
        {!activeStates.has(run.status) && run.status !== 'proposed' && <button onClick={discuss}>交给导师复盘</button>}
      </article>}
    </div>
  </details>
}
