import { useMemo, useState } from 'react'
import {
  defineLearnFlowPluginClient,
  pluginObjectDragProps,
  type PluginToolRendererProps,
} from '../../src/PluginToolResultView.tsx'
import { LEARNING_TASK_CONVERSION_PLUGIN, LEARNING_TASK_RENDERERS } from './shared.ts'
import { LearningTaskIntakeRenderer } from './intake-client.tsx'
import './plugin.css'

type JsonRecord = Record<string, any>

function firstValue(props: PluginToolRendererProps): JsonRecord {
  return (props.objects[0]?.value || props.result.payload || {}) as JsonRecord
}

function candidateValue(props: PluginToolRendererProps): JsonRecord {
  const value = firstValue(props)
  return (value.candidate || value) as JsonRecord
}

function ActionBar({ props, candidate }: { props: PluginToolRendererProps; candidate: JsonRecord }) {
  const id = String(candidate.candidateId || '')
  const rootHash = String(candidate.sourceSnapshot?.rootHash || '')
  if (!props.onPrompt || !id) return null
  return <div className="ltc-actions" aria-label="候选后续操作">
    <button type="button" onClick={() => props.onPrompt?.(`请调用学习型任务转化插件检查候选 ${id} 的来源证据和 grounding 边界。`)}>检查来源</button>
    <button type="button" onClick={() => props.onPrompt?.(`请调用学习型任务转化插件审计候选 ${id}，只报告确定性校验结果。`)}>重新审计</button>
    <button type="button" onClick={() => props.onPrompt?.(`请调用学习型任务转化插件为候选 ${id} 准备 Tutor 审阅包并解释关键步骤；暂时不要创建正式 LearningTask。`)}>让 Tutor 审阅</button>
    {rootHash && <button className="primary" type="button" onClick={() => props.onPrompt?.(`我明确确认采用候选 ${id}（rootHash: ${rootHash}）。请立即调用 learning_task_conversion__confirm_learning_task_candidate，candidateId 使用 ${id}，expectedRootHash 使用 ${rootHash}，confirmed 设为 true；成功后返回正式学习任务入口。`)}>确认并创建正式任务</button>}
  </div>
}

function GroundingBadge({ status }: { status: string }) {
  const labels: Record<string, string> = {
    grounded: '来源已绑定',
    source_supplied_unverified: '来源已输入 · 引用待绑定',
    ungrounded: '无来源依据',
  }
  return <span className={`ltc-grounding ${status}`}>{labels[status] || status || '来源状态未知'}</span>
}

function CandidateRenderer(props: PluginToolRendererProps) {
  const candidate = candidateValue(props)
  const task = (candidate.task || {}) as JsonRecord
  const steps = Array.isArray(task.steps) ? task.steps as JsonRecord[] : []
  const [selectedId, setSelectedId] = useState(String(steps[0]?.id || ''))
  const selected = steps.find(step => String(step.id) === selectedId) || steps[0]
  const knowledge = new Map((candidate.mappings?.knowledgeTargets || []).map((item: JsonRecord) => [String(item.id), item]))
  const skills = new Map((candidate.mappings?.skillTargets || []).map((item: JsonRecord) => [String(item.id), item]))
  const selectedKnowledge = (selected?.knowledgeTargetIds || []).map((id: string) => knowledge.get(String(id))).filter(Boolean) as JsonRecord[]
  const selectedSkills = (selected?.skillTargetIds || []).map((id: string) => skills.get(String(id))).filter(Boolean) as JsonRecord[]
  const warnings = Array.isArray(candidate.warnings) ? candidate.warnings as JsonRecord[] : []
  const candidateObject = props.objects.find(item => item.objectType === 'learning_task_candidate')
  const stepLabels = new Map(steps.map((step, index) => [
    String(step.id),
    `步骤 ${String(index + 1).padStart(2, '0')}：${String(step.title || '未命名步骤')}`,
  ]))
  const selectedStepLabel = selected
    ? stepLabels.get(String(selected.id)) || `当前步骤：${String(selected.title || '未命名步骤')}`
    : '当前步骤'
  const derivationLabel = (value: unknown) => ({
    pedagogical_transformation: '由任务步骤转化得到',
    provider_supplied: '由讯飞工作流提供',
    source_grounded: '由来源材料支持',
    local_order_derivation: '由步骤顺序推导',
  }[String(value)] || '由任务设计生成')

  return <section className="ltc-workbench" aria-label="学习型任务候选工作台">
    <header className="ltc-hero" {...(candidateObject ? pluginObjectDragProps(candidateObject) : {})}>
      <div className="ltc-mark">转</div>
      <div>
        <span>学习型任务候选 · 未提交</span>
        <h3>{String(task.title || '学习型任务候选')}</h3>
        <p>{String(task.learningObjective || '')}</p>
      </div>
      <div className="ltc-hero-meta">
        <GroundingBadge status={String(candidate.groundingStatus || '')} />
        <strong>{steps.length} 个步骤</strong>
        <small>{candidate.candidateId ? `候选编号：${String(candidate.candidateId)}` : ''}</small>
      </div>
    </header>

    <div className="ltc-boundaries">
      <span>候选成果</span><i>≠</i><span>正式学习任务</span><i>≠</i><span>掌握证据</span>
    </div>

    <div className="ltc-task-context">
      <article><span>工作情境</span><p>{String(task.workContext || '未提供')}</p></article>
      <article><span>资源与设备</span><p>{(task.resources || []).join(' · ') || '未提供'}</p></article>
      <article><span>安全与总体验收</span><p>{[...(task.safetyRequirements || []), ...(task.successCriteria || [])].slice(0, 5).join('；') || '未提供'}</p></article>
    </div>

    <div className="ltc-body">
      <nav className="ltc-step-list" aria-label="任务步骤">
        <header><span>工作步骤</span><strong>按真实作业先后展开</strong></header>
        {steps.map((step, index) => <button
          key={String(step.id)}
          type="button"
          className={String(step.id) === String(selected?.id) ? 'selected' : ''}
          onClick={() => setSelectedId(String(step.id))}
        >
          <b>{String(index + 1).padStart(2, '0')}</b>
          <span><strong>{String(step.title || '')}</strong><small>{String(step.deliverables?.[0] || '')}</small></span>
          <i>→</i>
        </button>)}
        <footer>{steps.length} 个步骤 · 依赖图已校验</footer>
      </nav>

      {selected && <main className="ltc-step-detail">
        <header>
          <span>第 {String(selected.order || '').padStart(2, '0')} 步 · 工作步骤</span>
          <h4>{String(selected.title || '')}</h4>
          <p>按真实作业顺序执行，本步骤完成后留下可检查产物。</p>
        </header>
        <section className="ltc-operation">
          <span>具体操作</span>
          <p>{String(selected.action || '')}</p>
        </section>
        <div className="ltc-check-grid">
          <article><span>步骤产物</span><strong>{(selected.deliverables || []).join('；')}</strong></article>
          <article><span>验收依据</span><strong>{(selected.successCriteria || []).join('；')}</strong></article>
        </div>
        <section className="ltc-dependency">
          <span>前置与依赖</span>
          <div>{(selected.prerequisiteStepIds || []).length
            ? (selected.prerequisiteStepIds || []).map((id: string) => <code key={id}>{stepLabels.get(String(id)) || '前置步骤'}</code>)
            : <code>任务契约与环境已就绪</code>}
            <b>→</b><code className="current">{selectedStepLabel}</code><b>→</b><code>{String(selected.deliverables?.[0] || '可检查产物')}</code>
          </div>
          {selected.dependencyDerivation === 'local_order_derivation' && <small>该前置关系由 LearnFlow 根据讯飞返回的步骤顺序推导，供你核对。</small>}
        </section>
        {(selected.safetyRequirements || []).length > 0 && <section className="ltc-safety"><span>安全要求</span><p>{selected.safetyRequirements.join('；')}</p></section>}
      </main>}

      <aside className="ltc-mapping">
        <header><span>步骤映射</span><strong>本步骤知识与技能</strong></header>
        <section>
          <span className="kind">知 · 知识点</span>
          {selectedKnowledge.length ? selectedKnowledge.map(item => <article key={String(item.id)}>
            <strong>{String(item.title || '')}</strong><p>{String(item.description || '')}</p>
            <small>{item.citationIds?.length ? `${item.citationIds.length} 条来源引用` : '教学设计候选 · 无直接来源引用'}</small>
          </article>) : <p className="empty">本步骤没有知识点映射。</p>}
        </section>
        <section>
          <span className="kind">技 · 技能点</span>
          {selectedSkills.length ? selectedSkills.map(item => <article key={String(item.id)}>
            <strong>{String(item.title || '')}</strong><p>{String(item.description || '')}</p>
            <small>{derivationLabel(item.derivationKind)}</small>
          </article>) : <p className="empty">本步骤没有技能点映射。</p>}
        </section>
        {(selected.resources || []).length > 0 && <section>
          <span className="kind">资 · 学习资源</span>
          {selected.resources.map((resource: JsonRecord) => <a key={String(resource.id)} href={String(resource.url)} target="_blank" rel="noreferrer">{String(resource.title || resource.url)} ↗</a>)}
        </section>}
      </aside>
    </div>

    {warnings.length > 0 && <details className="ltc-warnings">
      <summary>{warnings.length} 条来源或覆盖提醒</summary>
      <ul>{warnings.map((warning, index) => <li key={`${warning.code}-${index}`}><strong>{String(warning.code || 'warning')}</strong>{String(warning.message || '')}</li>)}</ul>
    </details>}
    <ActionBar props={props} candidate={candidate} />
  </section>
}

function EvidenceRenderer(props: PluginToolRendererProps) {
  const evidence = firstValue(props)
  const citations = Array.isArray(evidence.citations) ? evidence.citations as JsonRecord[] : []
  return <section className="ltc-panel">
    <header><div className="ltc-mark">据</div><div><span>SOURCE BINDING</span><h3>候选来源与引用</h3></div><GroundingBadge status={String(evidence.groundingStatus || '')} /></header>
    <div className="ltc-metrics">
      <span><strong>{evidence.sourceBindings?.length || 0}</strong><small>固定来源版本</small></span>
      <span><strong>{citations.length}</strong><small>已绑定引用</small></span>
      <span><strong>{evidence.coverage?.omittedSegmentCount || 0}</strong><small>省略片段</small></span>
    </div>
    <div className="ltc-citations">{citations.length ? citations.map(item => <article key={String(item.citationId)}>
      <code>{String(item.citationId)}</code><blockquote>{String(item.excerpt || '')}</blockquote><small>SourceVersion {String(item.sourceVersionId)} · Chunk {String(item.chunkId)}</small>
    </article>) : <p>当前候选没有 provider 可核验的 citation 绑定，不能表述为直接岗位来源事实。</p>}</div>
    <footer>来源只支撑候选内容边界，不构成学习者掌握证据。</footer>
  </section>
}

function AuditRenderer(props: PluginToolRendererProps) {
  const audit = firstValue(props)
  const validation = (audit.validation || {}) as JsonRecord
  return <section className="ltc-panel">
    <header><div className="ltc-mark">审</div><div><span>DETERMINISTIC AUDIT</span><h3>候选确定性审计</h3></div><b className={validation.valid ? 'pass' : 'fail'}>{validation.valid ? '通过' : '未通过'}</b></header>
    <div className="ltc-metrics">
      <span><strong>{validation.issues?.length || 0}</strong><small>结构问题</small></span>
      <span><strong>{audit.warnings?.length || 0}</strong><small>提醒</small></span>
      <span><strong>{audit.kernelWrites || 0}</strong><small>内核写入</small></span>
    </div>
    <ul className="ltc-issue-list">{(validation.issues || []).map((item: JsonRecord, index: number) => <li key={index}><code>{String(item.path)}</code>{String(item.reason)}</li>)}</ul>
    <footer>校验通过只代表候选结构可审阅，不代表用户确认、评分或掌握。</footer>
  </section>
}

function HandoffRenderer(props: PluginToolRendererProps) {
  const handoff = firstValue(props)
  const candidate = (handoff.candidate || {}) as JsonRecord
  return <section className="ltc-panel ltc-handoff">
    <header><div className="ltc-mark">交</div><div><span>TUTOR REVIEW CANDIDATE</span><h3>{String(candidate.task?.title || 'Tutor 审阅候选包')}</h3></div><b className="pending">等待确认</b></header>
    <p>{String(handoff.instruction || '')}</p>
    <div className="ltc-boundaries"><span>Tutor 可解释</span><i>·</i><span>用户需确认</span><i>·</i><span>正式任务未创建</span></div>
    <ActionBar props={props} candidate={candidate} />
  </section>
}

function ConfirmationRenderer(props: PluginToolRendererProps) {
  const confirmation = firstValue(props)
  const task = (confirmation.learningTask || {}) as JsonRecord
  const navigation = (confirmation.navigation || confirmation.managementNavigation || {}) as JsonRecord
  const href = String(navigation.path || '')
  const taskId = Number(task.id || 0)
  return <section className="ltc-panel ltc-confirmation">
    <header><div className="ltc-mark">启</div><div><span>FORMAL LEARNING TASK</span><h3>{String(task.title || '正式学习任务')}</h3></div><b className="pass">已确认</b></header>
    <p>{String(task.objective || '候选已由 LearnFlow 重新校验并创建为正式学习任务。')}</p>
    <div className="ltc-metrics">
      <span><strong>{task.plan?.work_steps?.length || 0}</strong><small>真实工作步骤</small></span>
      <span><strong>{task.plan?.phases?.length || 0}</strong><small>学习运行阶段</small></span>
      <span><strong>0</strong><small>本次掌握写入</small></span>
    </div>
    <div className="ltc-boundaries"><span>用户已确认</span><i>→</i><span>LearnFlow 正式任务</span><i>→</i><span>个性化学习与确定性验收</span></div>
    {taskId > 0 && props.onOpenLearningTask
      ? <button type="button" className="ltc-enter-learning" onClick={() => props.onOpenLearningTask?.(taskId)}>进入个性化学习 →</button>
      : href ? <a className="ltc-enter-learning" href={href}>进入个性化学习 →</a> : <p>正式任务已创建，可从“学习任务”中打开。</p>}
    <footer>正式任务创建不代表已经掌握；只有后续正式作答和验收证据可更新学习状态。</footer>
  </section>
}

function WorkCaseCandidateRenderer(props: PluginToolRendererProps) {
  const candidate = firstValue(props)
  return <section className="ltc-panel">
    <header><div className="ltc-mark">实</div><div><span>工作案例候选</span><h3>{String(candidate.title || '本地工作案例')}</h3></div><b className="pending">等待确认</b></header>
    <p>{String(candidate.summary || '')}</p>
    <p>版本 {String(candidate.case_version || '')} · {String(candidate.case_root_hash || '').slice(0, 12)}</p>
    <p>请从项目工作台选择这份案例并确认开始。导师会随阶段获得相应材料，正式任务由 LearnFlow 保存。</p>
    <footer>来源等级请查看案例说明；教学模拟不代表真实企业经历，生成候选不代表掌握。</footer>
  </section>
}

export default defineLearnFlowPluginClient({
  pluginId: LEARNING_TASK_CONVERSION_PLUGIN.id,
  name: LEARNING_TASK_CONVERSION_PLUGIN.name,
  description: LEARNING_TASK_CONVERSION_PLUGIN.description,
  icon: LEARNING_TASK_CONVERSION_PLUGIN.icon,
  renderers: {
    work_case_candidate: WorkCaseCandidateRenderer,
    [LEARNING_TASK_RENDERERS.intake]: LearningTaskIntakeRenderer,
    [LEARNING_TASK_RENDERERS.candidate]: CandidateRenderer,
    [LEARNING_TASK_RENDERERS.evidence]: EvidenceRenderer,
    [LEARNING_TASK_RENDERERS.audit]: AuditRenderer,
    [LEARNING_TASK_RENDERERS.handoff]: HandoffRenderer,
    [LEARNING_TASK_RENDERERS.confirmation]: ConfirmationRenderer,
  },
})
