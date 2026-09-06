import { evidenceClauses, isDirectLearnerContext } from './self-report-evidence.ts'

export type HumanAdaptationSignalKind =
  | 'pace_adjustment'
  | 'format_request'
  | 'cognitive_load'
  | 'frustration'
  | 'support_need'

export type HumanAdaptationSignal = {
  signalKind: HumanAdaptationSignalKind
  value: string
  strength: number
  evidenceQuote: string
  explicit: true
}

type SignalRule = {
  kind: HumanAdaptationSignalKind
  value: string
  strength: number
  pattern: RegExp
}

// These rules intentionally require an explicit request or an explicit
// description of current load.  Ordinary mistakes, "I don't know", pauses and
// low scores are Knowledge/Practice evidence, not Human-kernel evidence.
const EXPLICIT_RULES: SignalRule[] = [
  { kind: 'pace_adjustment', value: 'slower', strength: 0.9, pattern: /(?:慢一点|讲慢(?:点|一些)|太快了|节奏太快|跟不上(?:这个|当前)?节奏|一步一步来)/i },
  { kind: 'pace_adjustment', value: 'faster', strength: 0.85, pattern: /(?:快一点|讲快(?:点|一些)|加快节奏|这些我会了.{0,8}(?:跳过|快进)|^(?:请)?快进$|不用铺垫)/i },
  { kind: 'format_request', value: 'visual', strength: 0.9, pattern: /(?:画(?:个|一张|张)?图|用图(?:示|解)?|可视化(?:一下|讲解)?|想看动画|动画演示)/i },
  { kind: 'format_request', value: 'code', strength: 0.9, pattern: /(?:给(?:我)?(?:一段|个)?代码|用代码(?:讲|演示|说明)|看(?:个|一下)?代码例子|代码(?:例子|示例)|可运行(?:的)?代码)/i },
  { kind: 'format_request', value: 'example', strength: 0.85, pattern: /(?:先给|给我|来)(?:一个|个)?(?:最小|具体|直接)?例子|用例子(?:讲|说明)|定义后.{0,8}(?:例子|示例)/i },
  { kind: 'format_request', value: 'steps', strength: 0.85, pattern: /(?:拆成步骤|分步骤|一步一步(?:讲|做)|按步骤(?:讲|来)|逐步演示)/i },
  { kind: 'format_request', value: 'concise', strength: 0.8, pattern: /(?:简短(?:一点|回答)|精简(?:一点)?|只说重点|别铺垫|不要展开)/i },
  { kind: 'format_request', value: 'alternative', strength: 0.9, pattern: /(?:换(?:一种|个)讲法|别再重复|这种讲法.{0,8}(?:不懂|没用|不适合)|用另一种方式)/i },
  { kind: 'cognitive_load', value: 'reduce_chunk_size', strength: 0.9, pattern: /(?:信息量太大|一下子太多|脑子(?:转不过来|装不下)|有点过载|内容太密|先少讲一点)/i },
  { kind: 'frustration', value: 'acknowledge_and_reduce_scope', strength: 0.9, pattern: /(?:我(?:有点|很)?(?:烦|崩溃|挫败)|越学越烦|完全乱了|学不下去了|被(?:这题|这里)卡得很难受)/i },
  { kind: 'support_need', value: 'repeat_key_point', strength: 0.8, pattern: /(?:再讲一遍|重复(?:一下|一遍)|把关键点再说一次|刚才那点再讲)/i },
]

function normalizedQuote(input: string): string {
  return input.replace(/\s+/g, ' ').trim().slice(0, 240)
}

export function detectHumanAdaptationSignals(input: string): HumanAdaptationSignal[] {
  if (!isDirectLearnerContext(input)) return []
  const quote = normalizedQuote(input)
  if (!quote) return []

  const signals: HumanAdaptationSignal[] = []
  const seen = new Set<string>()
  for (const rule of EXPLICIT_RULES) {
    const evidence = evidenceClauses(input).find(clause => {
      const match = clause.match(rule.pattern)
      if (!match || /(?:可能|也许|是否|能否|以前|过去|曾经|当时)/.test(clause)) return false
      // Negation belonging to the rule ("不要展开", "别再重复") is
      // intentional. Negation outside the matched request cancels it.
      const before = clause.slice(0, match.index)
      const after = clause.slice((match.index || 0) + match[0].length)
      return !/(?:不|没|未|别|无需|无须)/.test(before)
        && !/(?:不需要|没必要|就算了|不适合|不要了)/.test(after)
    })
    if (!evidence) continue
    const key = `${rule.kind}:${rule.value}`
    if (seen.has(key)) continue
    seen.add(key)
    signals.push({
      signalKind: rule.kind,
      value: rule.value,
      strength: rule.strength,
      evidenceQuote: normalizedQuote(evidence),
      explicit: true,
    })
    // Keep the adaptation packet compact. More than three simultaneous
    // directives would itself increase load and is rarely actionable.
    if (signals.length === 3) break
  }
  return signals
}
