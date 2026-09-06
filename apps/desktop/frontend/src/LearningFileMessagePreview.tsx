import { useEffect, useState } from 'react'
import { loadLectureFile, loadPracticeFile } from './formal-runtime'
import { plainLearningFileExcerpt, type ConversationLearningFile } from './learning-file-message'
import PracticeFilePage from './PracticeFilePage'

type Props = {
  file: ConversationLearningFile
  onOpen: () => void
  onAttach: () => void
  conversationId?: string
}

type PreviewState = {
  eyebrow: string
  title: string
  lines: string[]
}

export default function LearningFileMessagePreview({ file, onOpen, onAttach, conversationId }: Props) {
  const [preview, setPreview] = useState<PreviewState>()
  const [failed, setFailed] = useState(false)
  const inlinePractice = file.kind === 'practice'
    && Number(file.questionCount) > 0
    && Number(file.questionCount) <= 4

  useEffect(() => {
    if (inlinePractice) return
    let alive = true
    setPreview(undefined)
    setFailed(false)
    const request = file.kind === 'practice'
      ? loadPracticeFile(file.ref).then(result => {
          const first = result.questions?.[0]
          const lines = first
            ? [
                `第 1 题　${plainLearningFileExcerpt(first.question, 170)}`,
                ...(first.options || []).slice(0, 2).map((option, index) => `${String.fromCharCode(65 + index)}　${plainLearningFileExcerpt(option, 105)}`),
              ]
            : [plainLearningFileExcerpt(result.description || '打开练习，查看题目并开始作答。', 190)]
          return {
            eyebrow: `练习 · ${result.questions?.length || 1} 题`,
            title: result.title || file.title,
            lines,
          }
        })
      : loadLectureFile(Number(file.ref)).then(result => {
          const first = result.sections?.[0]
          return {
            eyebrow: `讲义 · ${result.sections?.length || 1} 节`,
            title: result.title || file.title,
            lines: [
              first?.title || '开篇',
              plainLearningFileExcerpt(first?.content || '打开讲义，从第一节开始阅读。', 220),
            ],
          }
        })
    void request.then(result => {
      if (alive) setPreview(result)
    }).catch(() => {
      if (alive) setFailed(true)
    })
    return () => { alive = false }
  }, [file.kind, file.ref, file.title, inlinePractice])

  const display = preview || {
    eyebrow: file.kind === 'practice' ? '练习' : '讲义',
    title: file.title,
    lines: [failed ? '暂时无法读取预览，文件本身仍可打开。' : '正在读取文件开头…'],
  }
  if (inlinePractice) {
    return (
      <PracticeFilePage
        practiceRef={file.ref}
        inline
        conversationId={conversationId}
        sheetId="main"
        onOpenPaper={onAttach}
      />
    )
  }

  return (
    <div className={`learning-file-message-preview learning-file-message-preview-${file.kind}`}>
      <button type="button" className="learning-file-preview-paper" onClick={onOpen} aria-label={`打开${display.eyebrow}“${display.title}”`}>
        <span className="learning-file-preview-type">{display.eyebrow}</span>
        <strong>{display.title}</strong>
        <span className="learning-file-preview-lines">
          {display.lines.filter(Boolean).slice(0, 3).map((line, index) => <span key={`${index}-${line.slice(0, 18)}`}>{line}</span>)}
          <i aria-hidden="true" />
        </span>
        <small>打开{file.kind === 'practice' ? '作答' : '阅读'} <b aria-hidden="true">↗</b></small>
      </button>
      <button type="button" className="learning-file-preview-attach" onClick={onAttach}>放到新纸上</button>
    </div>
  )
}
