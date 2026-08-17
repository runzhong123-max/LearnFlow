import {
  ArrowLeft, ArrowRight, Braces, CheckCircle2, Clipboard, Download,
  ExternalLink, Loader2, Network, Sparkles,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { useWorkspaceTitle } from '../components/workspace/WorkspaceContext'
import {
  getPersonalizedLearningKnowledgeEntry,
  type PersonalizedLearningKnowledgeEntry,
} from '../services/api'

function errorMessage(error: any) {
  return error?.response?.data?.detail || error?.message || '个性化学习交接数据读取失败。'
}

function displaySituation(value: unknown) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  const item = value as Record<string, unknown>
  return String(item.description || item.name || item.title || '')
}

function buildGeneratorUrl(entry: PersonalizedLearningKnowledgeEntry) {
  const configured = String(import.meta.env.VITE_PERSONALIZED_LEARNING_GENERATOR_URL || '').trim()
  if (!configured) return ''
  const target = new URL(configured, window.location.origin)
  target.searchParams.set(
    'handoff_url',
    new URL(entry.navigation.handoff_json_path, window.location.origin).toString(),
  )
  target.searchParams.set('entry_id', entry.entry_id)
  target.searchParams.set('task_card_id', entry.source.task_card_id)
  target.searchParams.set('knowledge_id', entry.focus.knowledge_point.knowledge_id)
  target.searchParams.set(
    'return_url',
    new URL(entry.navigation.return_path, window.location.origin).toString(),
  )
  return target.toString()
}

export default function PersonalizedLearningEntryPage() {
  const { taskCardId = '', knowledgeId = '' } = useParams()
  const location = useLocation()
  const initialEntry = (location.state as { entry?: PersonalizedLearningKnowledgeEntry } | null)?.entry
  const loadRequestRef = useRef(0)
  const activeEntryKeyRef = useRef(`${taskCardId}:${knowledgeId}`)
  const loadedEntryKeyRef = useRef(initialEntry ? `${taskCardId}:${knowledgeId}` : '')
  const [entry, setEntry] = useState<PersonalizedLearningKnowledgeEntry | null>(initialEntry || null)
  const [loading, setLoading] = useState(!initialEntry)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  useWorkspaceTitle(entry?.focus.knowledge_point.name || '个性化学习交接', { kind: 'wf03' })

  const load = useCallback(async () => {
    if (!taskCardId || !knowledgeId) return
    const entryKey = `${taskCardId}:${knowledgeId}`
    activeEntryKeyRef.current = entryKey
    const requestId = ++loadRequestRef.current
    setLoading(true)
    if (loadedEntryKeyRef.current !== entryKey) setError('')
    try {
      const nextEntry = await getPersonalizedLearningKnowledgeEntry(taskCardId, knowledgeId)
      if (activeEntryKeyRef.current !== entryKey) return
      loadedEntryKeyRef.current = entryKey
      setEntry(nextEntry)
      setError('')
      setLoading(false)
    } catch (failure) {
      if (
        requestId !== loadRequestRef.current
        || activeEntryKeyRef.current !== entryKey
        || loadedEntryKeyRef.current === entryKey
      ) return
      setError(errorMessage(failure))
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false)
    }
  }, [knowledgeId, taskCardId])

  useEffect(() => {
    if (!initialEntry) load()
  }, [initialEntry, load])

  const generatorUrl = useMemo(() => entry ? buildGeneratorUrl(entry) : '', [entry])

  const copyJsonUrl = async () => {
    if (!entry) return
    const url = new URL(entry.navigation.handoff_json_path, window.location.origin).toString()
    await navigator.clipboard.writeText(url)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const downloadJson = () => {
    if (!entry) return
    const blob = new Blob([JSON.stringify(entry, null, 2)], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${entry.source.task_card_id}-${entry.focus.knowledge_point.knowledge_id}-personalized-learning.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  if (loading) {
    return <div className="flex h-full items-center justify-center bg-slate-50 text-sm text-slate-500"><Loader2 size={18} className="mr-2 animate-spin text-indigo-600" />正在准备知识点交接 JSON…</div>
  }

  if (!entry) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-50 p-8">
        <div className="max-w-md border border-red-200 bg-white p-6 text-center shadow-sm">
          <p className="text-sm font-semibold text-slate-900">个性化学习入口无法打开</p>
          <p className="mt-2 text-xs leading-5 text-red-600">{error}</p>
          <button type="button" onClick={load} className="mt-4 bg-slate-900 px-4 py-2 text-xs font-semibold text-white">重新读取</button>
        </div>
      </div>
    )
  }

  const knowledge = entry.focus.knowledge_point
  return (
    <main className="h-full overflow-y-auto bg-slate-100 px-5 py-6 sm:px-8">
      <div className="mx-auto max-w-5xl pb-16">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Link to={entry.navigation.return_path} className="inline-flex h-9 items-center gap-1.5 border border-slate-200 bg-white px-3 text-xs font-medium text-slate-600 hover:border-slate-400">
            <ArrowLeft size={13} /> 返回学习型任务
          </Link>
          <button type="button" onClick={copyJsonUrl} className="inline-flex h-9 items-center gap-1.5 border border-slate-200 bg-white px-3 text-xs font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-700">
            <Clipboard size={13} /> {copied ? '已复制 JSON 接口' : '复制 JSON 接口'}
          </button>
          <button type="button" onClick={downloadJson} className="inline-flex h-9 items-center gap-1.5 border border-slate-200 bg-white px-3 text-xs font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-700">
            <Download size={13} /> 下载本知识点 JSON
          </button>
          {entry.source.full_handoff_json_url && (
            <a href={entry.source.full_handoff_json_url} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-1.5 border border-slate-200 bg-white px-3 text-xs font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-700">
              <ExternalLink size={13} /> 查看完整任务 JSON
            </a>
          )}
        </div>

        <header className="border border-indigo-200 bg-white p-7 shadow-sm sm:p-9">
          <div className="flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em]">
            <span className="bg-indigo-50 px-2 py-1 text-indigo-700">个性化学习生成入口</span>
            <span className="bg-emerald-50 px-2 py-1 text-emerald-700"><CheckCircle2 size={11} className="mr-1 inline" />JSON 已校验</span>
            <span className="font-mono text-slate-400">{entry.entry_id}</span>
          </div>
          <h1 className="mt-4 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">{knowledge.name}</h1>
          <p className="mt-3 text-sm leading-7 text-slate-600">{knowledge.scope || knowledge.description || '本知识点由学习型任务的已校验步骤显式引用。'}</p>
          <div className="mt-5 border-l-2 border-indigo-500 pl-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-400">来源任务</p>
            <p className="mt-1 text-sm font-semibold text-slate-800">{entry.task_context.enterprise_task_name}</p>
            <p className="mt-1 text-xs leading-5 text-slate-500">{entry.task_context.enterprise_task_description}</p>
          </div>
          {generatorUrl ? (
            <a href={generatorUrl} className="mt-6 inline-flex h-11 items-center gap-2 bg-indigo-600 px-5 text-sm font-semibold text-white hover:bg-indigo-700">
              <Sparkles size={16} /> 开始生成个性化学习 <ArrowRight size={15} />
            </a>
          ) : (
            <div className="mt-6 border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800">
              交接 JSON 已就绪。个性化学习功能接入后，配置 <code className="font-mono">VITE_PERSONALIZED_LEARNING_GENERATOR_URL</code> 即可由此直接进入生成页，不需要改动任务转化接口。
            </div>
          )}
        </header>

        <section className="mt-5 grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-center gap-2"><Network size={16} className="text-indigo-600" /><h2 className="text-sm font-bold text-slate-900">知识—步骤—技能强关系</h2></div>
            <div className="mt-4 space-y-3">
              {entry.focus.source_steps.map((step, index) => (
                <article key={step.step_id} className="border border-slate-200 bg-slate-50 p-4">
                  <p className="text-[10px] font-semibold text-indigo-600">来源步骤 {String(index + 1).padStart(2, '0')}</p>
                  <h3 className="mt-1 text-sm font-semibold text-slate-900">{step.name}</h3>
                  <p className="mt-2 text-xs leading-6 text-slate-600">{step.action}</p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <div className="border-l-2 border-sky-400 bg-white px-3 py-2 text-[11px] leading-5 text-slate-600"><b className="text-slate-800">产物：</b>{step.deliverable}</div>
                    <div className="border-l-2 border-emerald-500 bg-white px-3 py-2 text-[11px] leading-5 text-slate-600"><b className="text-slate-800">检查：</b>{step.check}</div>
                  </div>
                </article>
              ))}
            </div>
          </div>

          <aside className="space-y-5">
            <section className="border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="text-sm font-bold text-slate-900">强相关技能</h2>
              <div className="mt-3 space-y-2">
                {entry.focus.strongly_related_skills.map(skill => (
                  <div key={skill.skill_id} className="border border-amber-200 bg-amber-50 px-3 py-3">
                    <p className="text-xs font-semibold text-amber-900">{skill.name}</p>
                    <p className="mt-1 text-[11px] leading-5 text-amber-800">{skill.observable_action || skill.description || '通过对应任务产物验证。'}</p>
                  </div>
                ))}
              </div>
            </section>
            <section className="border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-center gap-2"><Braces size={15} className="text-slate-500" /><h2 className="text-sm font-bold text-slate-900">生成边界</h2></div>
              <p className="mt-3 text-xs leading-6 text-slate-600">{entry.generation_contract.purpose}</p>
              <p className="mt-3 text-[11px] leading-5 text-slate-500">下游可生成学习目标、内容、顺序、练习和评价；不得改写企业任务、作业步骤和强关系。</p>
            </section>
          </aside>
        </section>

        {displaySituation(entry.task_context.work_situation) && (
          <section className="mt-5 border border-slate-200 bg-white p-5 text-xs leading-6 text-slate-600 shadow-sm">
            <b className="text-slate-900">工作情境：</b>{displaySituation(entry.task_context.work_situation)}
          </section>
        )}
      </div>
    </main>
  )
}
