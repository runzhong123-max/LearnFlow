import rehypeKatex from 'rehype-katex'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { remarkTeachingHighlights, type TeachingAffordances } from '../../../../packages/learning-client/src/teaching/affordances.ts'
import 'katex/dist/katex.min.css'

type Props = {
  content: string
  affordances?: TeachingAffordances
  teachingBusy?: boolean
  onTeachingQuestion?: (question: string) => void
  onTeachingQuote?: (quote: string) => void
}

export default function MarkdownContent({ content, affordances, teachingBusy, onTeachingQuestion, onTeachingQuote }: Props) {
  // Display-time rewrites must never move an annotation onto different text.
  const quotes = onTeachingQuote ? (affordances?.highlights || []).map(item => item.quote).filter(quote => content.indexOf(quote) >= 0 && content.indexOf(quote) === content.lastIndexOf(quote)) : []
  return (
    <>
      <div className="markdown-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath, [remarkTeachingHighlights, { quotes }]]}
          rehypePlugins={[rehypeKatex]}
          components={{
            a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
            img: ({ node: _node, ...props }) => <img {...props} loading="lazy" />,
            span: ({ node, ...props }) => {
              const quote = node?.properties?.['data-teaching-quote']
              return typeof quote === 'string' && quotes.includes(quote)
                ? <span role="button" tabIndex={teachingBusy ? -1 : 0} aria-disabled={teachingBusy || undefined} className="teaching-highlight" title="在引用纸张中展开"
                    onClick={() => { if (!teachingBusy) onTeachingQuote?.(quote) }}
                    onKeyDown={event => { if (!teachingBusy && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onTeachingQuote?.(quote) } }}
                  >{props.children}</span>
                : <span {...props} />
            },
          }}
        >{content}</ReactMarkdown>
      </div>
      {affordances?.followUps.length === 3 && onTeachingQuestion && <nav className="teaching-follow-ups" aria-label="继续探索">
        {affordances.followUps.map(question => <button key={question} type="button" disabled={teachingBusy} onClick={() => onTeachingQuestion(question)}>{question}</button>)}
      </nav>}
    </>
  )
}
