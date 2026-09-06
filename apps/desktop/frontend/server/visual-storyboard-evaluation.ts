import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildProviderRequest, textFromTutorProviderResponse } from '../src/tutor.ts'
import { VISUAL_STORYBOARD_CASES } from './visual-storyboard-cases.ts'
import { compileVisualStoryboard, designAsciiStoryboard } from './visual-storyboard-tool.ts'

type EvalRow = {
  id: string
  title: string
  frames: number
  quality: number
  deterministic: 'passed' | 'failed'
  liveMiMo: 'passed' | 'failed' | 'not_run'
  liveDurationMs?: number
  error?: string
}

function parseEnv(raw: string) {
  return Object.fromEntries(raw.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) return []
    return [[match[1], match[2].trim().replace(/^['"]|['"]$/g, '')]]
  }))
}

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

async function callMiMo(context: typeof VISUAL_STORYBOARD_CASES[number], env: Record<string, string>) {
  const baseUrl = env.LLM_BASE_URL || 'https://api.xiaomimimo.com/v1'
  const model = env.LLM_MODEL || 'mimo-v2.5-pro'
  const generate = async (instructions: string, input: string, timeoutMs = 360_000, maxTokens = 12_000) => {
    const request = buildProviderRequest({
      baseUrl, model,
      instructions,
      messages: [{ role: 'user', content: input }],
      maxTokens,
      responseFormat: 'json_object',
    })
    if (/api\.xiaomimimo\.com/i.test(baseUrl) && request.body && typeof request.body === 'object') {
      Object.assign(request.body, { thinking: { type: 'disabled' } })
    }
    const response = await fetch(request.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LLM_API_KEY}` },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) throw new Error(`provider_http_${response.status}`)
    const text = textFromTutorProviderResponse(payload)
    if (!text) {
      const first = payload && typeof payload === 'object' && Array.isArray((payload as { choices?: unknown[] }).choices)
        ? (payload as { choices: Array<Record<string, unknown>> }).choices[0]
        : undefined
      const message = first?.message && typeof first.message === 'object' ? first.message as Record<string, unknown> : undefined
      const reasoningLength = typeof message?.reasoning_content === 'string' ? message.reasoning_content.length : 0
      throw new Error(`provider_empty_output:finish_${String(first?.finish_reason || 'unknown')}:reasoning_chars_${reasoningLength}`)
    }
    return text
  }
  const designed = await designAsciiStoryboard(context, generate)
  return compileVisualStoryboard(designed)
}

async function main() {
  const outputDirectory = resolve(process.cwd(), 'output/visual-storyboard')
  await mkdir(outputDirectory, { recursive: true })
  const live = process.argv.includes('--live-mimo')
  const env = live ? parseEnv(await readFile(resolve(process.cwd(), '../backend/.env'), 'utf8')) : {}
  if (live && !env.LLM_API_KEY) throw new Error('LLM_API_KEY_not_configured')
  const evaluate = async (context: typeof VISUAL_STORYBOARD_CASES[number]) => {
    try {
      const generated = compileVisualStoryboard(context)
      let displayGenerated = generated
      let liveMiMo: EvalRow['liveMiMo'] = 'not_run'
      let liveDurationMs: number | undefined
      let liveError = ''
      if (live) {
        const started = Date.now()
        try {
          displayGenerated = await callMiMo(context, env)
          liveMiMo = 'passed'
        } catch (error) {
          liveMiMo = 'failed'
          liveError = error instanceof Error ? error.message.slice(0, 240) : 'live_mimo_failed'
        }
        liveDurationMs = Date.now() - started
      }
      const row: EvalRow = { id: context.id, title: context.title, frames: context.frames.length, quality: generated.quality.score, deterministic: 'passed', liveMiMo, liveDurationMs, ...(liveError ? { error: liveError } : {}) }
      console.error(`[visual-eval] ${context.id}: deterministic=passed live=${liveMiMo}${liveDurationMs ? ` duration_ms=${liveDurationMs}` : ''}`)
      return { row, section: `<section><h2>${escapeHtml(context.title)}</h2><p>${escapeHtml(context.learningGoal)}</p><p class="source">${liveMiMo === 'passed' ? 'MiMo 自由设计的 ASCII 画布' : 'Tool 通用文本布局兜底'}</p><div class="frames">${displayGenerated.artifact.steps.map((step, index) => `<article><h3>${index}. ${escapeHtml(step.title)}</h3><div class="canvas"><pre>${escapeHtml(step.ascii || '')}</pre></div><p>${escapeHtml(step.stateDescription || step.text)}</p></article>`).join('')}</div></section>` }
    } catch (error) {
      const row: EvalRow = { id: context.id, title: context.title, frames: context.frames.length, quality: 0, deterministic: 'failed', liveMiMo: 'not_run', error: error instanceof Error ? error.message : 'unknown' }
      console.error(`[visual-eval] ${context.id}: deterministic=failed`)
      return { row, section: '' }
    }
  }
  const caseFilter = process.argv.find(argument => argument.startsWith('--case='))?.slice('--case='.length)
  const selectedCases = caseFilter ? VISUAL_STORYBOARD_CASES.filter(context => context.id === caseFilter) : VISUAL_STORYBOARD_CASES
  if (!selectedCases.length) throw new Error(`visual_eval_case_not_found:${caseFilter}`)
  const results: Array<{ row: EvalRow; section: string }> = new Array(selectedCases.length)
  let nextIndex = 0
  const worker = async () => {
    while (nextIndex < selectedCases.length) {
      const index = nextIndex++
      results[index] = await evaluate(selectedCases[index])
    }
  }
  await Promise.all(Array.from({ length: live ? 2 : 1 }, worker))
  const rows = results.map(result => result.row)
  const sections = results.map(result => result.section).filter(Boolean)
  const report = { generatedAt: new Date().toISOString(), caseCount: rows.length, liveMiMo: live, rows }
  const reportName = live ? (caseFilter ? `live-report-${caseFilter}.json` : 'live-report.json') : 'report.json'
  await writeFile(resolve(outputDirectory, reportName), `${JSON.stringify(report, null, 2)}\n`)
  const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ASCII Storyboard v2 Eval</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#edf3ef;color:#18372b}header{padding:32px 4vw;background:#173b2d;color:white;position:sticky;top:0;z-index:2}section{margin:30px 3vw;padding:24px;background:white;border-radius:20px;box-shadow:0 12px 34px #153b2d14}.source{color:#60796e;font-weight:700}.frames{display:grid;grid-template-columns:repeat(auto-fit,minmax(520px,1fr));gap:20px}article{min-width:0;border:1px solid #d6e2db;border-radius:16px;padding:14px;background:#fbfdfc}.canvas{overflow:auto;border-radius:12px;background:#13241d}.canvas pre{width:max-content;min-width:calc(100% - 32px);margin:0;padding:16px;color:#dff5e8;font:600 13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre}h1,h2,h3{margin-top:0}p{line-height:1.6}</style></head><body><header><h1>ASCII Storyboard v2 · ${caseFilter ? escapeHtml(rows[0]?.title || caseFilter) : '十案例逐帧验收'}</h1><p>同一批语义上下文；Agent 负责文本画布设计，Tool 只验证语义、对象覆盖和时间状态。</p></header>${sections.join('')}</body></html>`
  await writeFile(resolve(outputDirectory, caseFilter ? `index-${caseFilter}.html` : 'index.html'), page)
  console.log(JSON.stringify(report))
  if (rows.some(row => row.deterministic === 'failed' || (live && row.liveMiMo === 'failed'))) process.exitCode = 1
}

await main()
