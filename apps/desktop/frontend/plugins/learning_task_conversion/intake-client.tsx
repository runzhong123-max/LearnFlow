import {
  pluginObjectDragProps,
  type PluginToolRendererProps,
} from '../../src/PluginToolResultView.tsx'
import type { LearningTaskConversionIntakeEnvelope } from './intake-runtime.ts'
import { learningTaskDraftConfirmationPrompt } from './intake.ts'
import './intake.css'

function intakeValue(props: PluginToolRendererProps) {
  return (props.objects[0]?.value || props.result.payload || {}) as unknown as LearningTaskConversionIntakeEnvelope
}

function sourceLabel(source: string) {
  if (source === 'role_package') return '岗位包依据'
  if (source === 'project_source') return '项目来源'
  return '模型建议 · 待确认'
}

function kindLabel(kind: LearningTaskConversionIntakeEnvelope['inputKind']) {
  return {
    role: '岗位输入',
    role_or_direction: '岗位方向',
    work_task: '企业工作任务',
    learning_topic: '学习方向',
    ambiguous: '含义待明确',
  }[kind] || kind
}

export function LearningTaskIntakeRenderer(props: PluginToolRendererProps) {
  const intake = intakeValue(props)
  const object = props.objects.find(item => item.objectType === 'learning_task_intake')
  const ready = intake.status === 'ready_for_confirmation'
  const contract = intake.taskContract || { title: '', description: '', action: '', workObject: '' }
  const modelVerified = intake.preflight?.method === 'semantic_model'
  return <section className="ltci-plan" aria-label="学习型任务转化准备单">
    <header className="ltci-header" {...(object ? pluginObjectDragProps(object) : {})}>
      <div className="ltci-symbol">策</div>
      <div>
        <span>LEARNING TASK CONVERSION · PLAN</span>
        <h3>{ready ? contract.title : '先锁定企业真实工作任务'}</h3>
        <p>{modelVerified
          ? `已由 ${intake.preflight.model || '独立语义模型'} 完成真实预检，并通过本地锚点校验；确认前不会调用讯飞。`
          : '当前只完成本地理解、消歧和任务锁定；确认前不会调用讯飞生成任务。'}</p>
      </div>
      <b className={ready ? 'ready' : 'waiting'}>{ready ? '等待确认' : kindLabel(intake.inputKind)}</b>
    </header>

    <ol className="ltci-progress" aria-label="任务转化阶段">
      <li className="done"><i>1</i><span>{modelVerified ? '模型预检' : '理解输入'}</span></li>
      <li className={intake.inputKind === 'ambiguous' ? 'active' : 'done'}><i>2</i><span>判断层级</span></li>
      <li className={ready ? 'done' : 'active'}><i>3</i><span>锁定任务</span></li>
      <li className={ready ? 'active' : ''}><i>4</i><span>确认生成</span></li>
      <li><i>5</i><span>结构校验</span></li>
    </ol>

    <div className="ltci-anchor">
      <span>用户原文</span>
      <blockquote>{intake.originalInput}</blockquote>
      <div>{(intake.lockedTerms || []).map(term => <code key={term}>{term}</code>)}</div>
      <small>核心词保持锁定，不会静默替换成相似岗位、热门方向或上下游任务。</small>
      {modelVerified && <small className="ltci-model-check">
        独立语义预检 · 置信度 {Math.round(Number(intake.preflight.confidence || 0) * 100)}%
        {intake.preflight.rationale ? ` · ${intake.preflight.rationale}` : ''}
      </small>}
    </div>

    {ready ? <div className="ltci-contract">
      <article><span>任务名称</span><strong>{contract.title}</strong></article>
      <article><span>操作动作</span><strong>{contract.action || '待来源补充'}</strong></article>
      <article><span>工作对象</span><strong>{contract.workObject || '待来源补充'}</strong></article>
      <article className="wide"><span>已有描述</span><p>{contract.description || '当前只锁定任务名称；工作情境、产物和验收点由后续来源与讯飞工作流补充。'}</p></article>
    </div> : <div className="ltci-selection">
      <header><span>下一步只补一个关键信息</span><h4>{intake.nextQuestion}</h4></header>
      {(intake.candidateTasks || []).length > 0 && <div className="ltci-candidates">
        {intake.candidateTasks.map(candidate => <button
          type="button"
          key={candidate.id}
          onClick={() => props.onPrompt?.(
            `生成学习型任务：“${candidate.title}”（来源于“${intake.originalInput}”的已选任务候选）`,
          )}
        >
          <span>{sourceLabel(candidate.source)}</span>
          <strong>{candidate.title}</strong>
          {candidate.description && <p>{candidate.description}</p>}
          <i>选择此任务 →</i>
        </button>)}
      </div>}
    </div>}

    {(intake.warnings || []).length > 0 && <div className="ltci-warnings">
      {intake.warnings.map(item => <p key={item.code}><strong>{item.code}</strong>{item.message}</p>)}
    </div>}

    <footer className="ltci-actions">
      <span>准备单 {intake.intakeId}</span>
      {ready && props.onPrompt && <button type="button" onClick={() => props.onPrompt?.(
        learningTaskDraftConfirmationPrompt(intake),
      )}>确认并开始生成</button>}
    </footer>
  </section>
}
