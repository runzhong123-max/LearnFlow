import { useEffect, useRef, useState } from 'react'
import { isCloudDesktopRuntime, isDesktopRuntime, runtimeFetch, switchDesktopWorkspace } from './runtime-client.ts'
import { importActionId, validConversionTicket, validateConversionPreview, type ConversionPreview } from './desktop-conversion.ts'
import './desktop-conversion.css'

async function readResponse(response: Response) {
  const value = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = typeof value.detail === 'string' ? value.detail : value.detail?.message
    const fallback = [403, 404].includes(response.status) ? '此交接不可用或不属于当前账号，请用网页同一账号登录。'
      : response.status === 410 ? '交接已过期，请回到网页重新点击“在客户端开始”。'
      : response.status === 401 ? '请重新登录网页使用的云端账号，登录后将继续此交接。'
      : '交接暂时不可用，请检查连接后重试。'
    throw new Error(detail || fallback)
  }
  return value
}

export default function DesktopConversionImport({ learnerId, onImported }: {
  learnerId: number
  onImported: (projectId: number, title: string) => void
}) {
  const [ticket, setTicket] = useState('')
  const [preview, setPreview] = useState<ConversionPreview>()
  const [parent, setParent] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const dialogRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!ticket) return
    const previous = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    return () => previous?.focus()
  }, [ticket])

  useEffect(() => {
    if (!isDesktopRuntime()) return
    let active = true
    let unlisten: (() => void) | undefined
    void Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]).then(async ([{ invoke }, { listen }]) => {
      const read = async () => {
        const pending = await invoke<unknown>('desktop_pending_conversion')
        if (active) setTicket(validConversionTicket(pending) ? pending : '')
      }
      unlisten = await listen('learnflow:conversion-pending', () => { void read() })
      if (!active) { unlisten(); return }
      await read() // Rust retains cold-launch and logged-out tickets until explicit completion.
    }).catch(() => { /* Older shells have no native import support. */ })
    return () => { active = false; unlisten?.() }
  }, [])

  useEffect(() => {
    setPreview(undefined)
    setError('')
    setParent('')
    if (!ticket || !isCloudDesktopRuntime()) return
    let active = true
    setBusy(true)
    void runtimeFetch(`/api/work-task-conversions/handoff/${ticket}`)
      .then(readResponse).then(value => validateConversionPreview(value, learnerId))
      .then(value => { if (active) setPreview(value) })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : '方案读取失败。') })
      .finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [ticket, learnerId, refresh])

  if (!ticket) return null

  const dismiss = async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('clear_desktop_pending_conversion', { ticket })
    const pending = await invoke<unknown>('desktop_pending_conversion')
    setTicket(validConversionTicket(pending) ? pending : '')
  }
  const chooseParent = async () => {
    setError('')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const choice = await invoke<string | null>('choose_conversion_parent')
      if (choice) setParent(choice)
    } catch { setError('目录选择不可用，请更新客户端后重试。') }
  }
  const start = async () => {
    if (!preview || !parent || busy) return
    setBusy(true)
    setError('')
    try {
      const result = await runtimeFetch(`/api/desktop/conversions/${ticket}/import`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_action_id: await importActionId(ticket, learnerId), expected_root_hash: preview.root_hash, confirmed: true, parent_path: parent }),
      }).then(readResponse)
      if (!Number.isSafeInteger(result.project_id) || result.project_id <= 0 || result.status !== 'imported') throw new Error('项目导入响应无效，请重试同一交接。')
      onImported(result.project_id, preview.candidate.title)
      await dismiss()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '导入失败。交接已保留，可以重试。')
    } finally { setBusy(false) }
  }

  return <div className="conversion-import-backdrop"><section ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="conversion-import-title" className="conversion-import-dialog" onKeyDown={event => {
    if (event.key === 'Escape' && !busy) { event.preventDefault(); void dismiss(); return }
    if (event.key !== 'Tab') return
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), summary, a[href], input:not(:disabled), [tabindex="0"]'))
    const first = controls[0], last = controls[controls.length - 1]
    if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }}>
    <header><span>网页 → 本机项目</span><button type="button" disabled={busy} onClick={() => void dismiss()}>取消交接</button></header>
    <h2 id="conversion-import-title">{preview?.candidate.title || '接续工作任务方案'}</h2>
    {!isCloudDesktopRuntime() ? <><p>此方案归属于你的云端账号。切换后使用网页同一账号登录，交接会继续保留。</p><button type="button" onClick={() => switchDesktopWorkspace(true)}>切换到云端账号</button></> : <>
      {preview && <>
        <p className="conversion-import-kind">{preview.candidate.project_mode === 'experiment' ? '实验项目' : '实践带教项目'} · {preview.starter_files.length} 份初始材料</p>
        <p>{preview.candidate.summary}</p>
        {Array.isArray(preview.candidate.design?.stages) && <ol>{preview.candidate.design.stages.map((stage, index) => <li key={index}><strong>{stage.title}</strong>{stage.objective && <p>{stage.objective}</p>}</li>)}</ol>}
        <h3>即将导入的材料</h3>
        <div className="conversion-import-files">{preview.starter_files.map(file => <details key={file.path}><summary>{file.path}</summary><pre>{file.content}</pre></details>)}</div>
        <p>选择父目录后将创建新的 LearnFlow 项目文件夹，保留已有文件。材料导入后，由你在工作台选择运行和提交。</p>
        {preview.consumed && <p>此方案已创建项目。重复导入会恢复同一项目；已绑定目录的文件会保留。</p>}
        <button type="button" disabled={busy} onClick={() => void chooseParent()}>选择父目录</button>
        {parent && <p className="conversion-import-path">{parent} / LearnFlow-project-项目编号</p>}
      </>}
      {error && <p role="alert" className="conversion-import-error">{error}</p>}
      <footer>{!preview && <button type="button" disabled={busy} onClick={() => setRefresh(value => value + 1)}>重新读取方案</button>}
        <button type="button" disabled={busy || !preview || !parent} onClick={() => void start()}>{busy ? '正在处理…' : '确认方案并导入项目'}</button></footer>
    </>}
  </section></div>
}
