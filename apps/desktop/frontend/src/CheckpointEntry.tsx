import type { CheckpointEntryPreset } from '../../../../packages/learning-client/src/project-guidance/checkpoint-presets'
import type { FormalLearningFileRef } from './formal-runtime'

const labels: Record<CheckpointEntryPreset['kind'], string> = {
  knowledge: '知识递进', overview: '工作综述', setup: '环境与准备', implementation: '动手实现',
  workflow: '工作流程', deployment: '部署交付', review: '验证与复盘',
}
export default function CheckpointEntry({ preset, locked, busy, files, onGenerate, onOpenFile, onPrepareFile, onPlanFiles, onOpenPet }: {
  preset: CheckpointEntryPreset; locked: boolean; busy: boolean; files: FormalLearningFileRef[]
  onGenerate: (kinds: Array<'lecture' | 'practice'>) => void
  onOpenFile: (file: FormalLearningFileRef) => void; onPrepareFile: (path: string) => void
  onPlanFiles: () => void; onOpenPet?: () => void
}) {
  if (locked) return <div className="checkpoint-entry locked">完成前置关卡后，开放本关材料与待完成文件。</div>
  return <section className="checkpoint-entry" aria-label="本关学习安排">
    <div className="checkpoint-entry-line"><span className="checkpoint-entry-kind">{labels[preset.kind]}</span>
      <span className="checkpoint-entry-objective">{preset.workflow_step || preset.lecture_focus}</span>
      {onOpenPet && preset.desktop_guidance && <button disabled={busy} onClick={onOpenPet}>桌宠陪我操作 ↗</button>}
    </div>
    <div className="checkpoint-entry-files">
      {preset.file_kinds.map(kind => {
        const matches = files.filter(file => file.kind === kind)
        return matches.length ? matches.map(file => <button key={`${file.kind}:${file.ref}`} disabled={busy} onClick={() => onOpenFile(file)} title={file.title}>{kind === 'lecture' ? '▤ 讲义' : '☑ 习题'} · {file.title}</button>)
          : <button key={kind} disabled={busy} onClick={() => onGenerate([kind])}>{kind === 'lecture' ? `＋ ${preset.kind === 'overview' ? '总纲讲义' : '本关讲义'}` : `＋ ${preset.kind === 'overview' ? '综述小练习' : '一份习题'}`}</button>
      })}
      {!!preset.required_files.length && <details><summary>待完成文件 · {preset.required_files.length}</summary><div className="checkpoint-entry-artifacts">{preset.required_files.map(file => <div key={file.path}><div><code>{file.path}</code><p>{file.purpose}</p></div><button disabled={busy} onClick={() => onPrepareFile(file.path)} title="已有文件添加到对话；不存在时创建空文件">准备文件</button></div>)}<small>打开文件卡进入代码纸，在纸内选择导师帮助。</small></div></details>}
      {preset.needs_file_plan && <button disabled={busy} onClick={onPlanFiles}>和导师明确本关文件</button>}
      <details className="checkpoint-entry-plan"><summary>本关安排</summary><p>{preset.lecture_focus}</p>{preset.overview_outline && <p>{preset.overview_outline}</p>}{preset.practice_focus && <p>{preset.practice_focus}</p>}</details>
    </div>
  </section>
}
