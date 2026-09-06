import assert from 'node:assert/strict'
import test from 'node:test'

import { detectHumanAdaptationSignals } from '../src/human-adaptation.ts'

test('explicit pace and format requests become bounded typed directives', () => {
  const signals = detectHumanAdaptationSignals('这里讲得太快了，请慢一点，再用图示和一个最小代码例子。')
  assert.deepEqual(signals.map(item => [item.signalKind, item.value]), [
    ['pace_adjustment', 'slower'],
    ['format_request', 'visual'],
    ['format_request', 'code'],
  ])
  assert.ok(signals.every(item => item.explicit && item.evidenceQuote.length <= 240))
})

test('ordinary uncertainty and incorrectness do not infer Human state', () => {
  for (const input of ['我不会这道题', '我不懂反向传播', '答案是 B 吗？', '为什么这里要转置？']) {
    assert.deepEqual(detectHumanAdaptationSignals(input), [], input)
  }
})

test('current load and frustration stay typed instead of becoming diagnoses', () => {
  const signals = detectHumanAdaptationSignals('一下子信息量太大，我完全乱了，能把关键点再讲一遍吗？')
  assert.deepEqual(signals.map(item => [item.signalKind, item.value]), [
    ['cognitive_load', 'reduce_chunk_size'],
    ['frustration', 'acknowledge_and_reduce_scope'],
    ['support_need', 'repeat_key_point'],
  ])
  assert.ok(signals.every(item => !/人格|能力|医学|学习风格/.test(item.value)))
})

test('implicit trait language is not converted into a fixed learning style', () => {
  assert.deepEqual(detectHumanAdaptationSignals('我可能是视觉型学习者'), [])
  assert.deepEqual(detectHumanAdaptationSignals('我数学天赋不行'), [])
})

test('every supported current-context operation has an explicit trigger', () => {
  const cases = [
    ['这些我会了，快进', 'pace_adjustment', 'faster'],
    ['给我一个最小例子', 'format_request', 'example'],
    ['拆成步骤讲', 'format_request', 'steps'],
    ['只说重点', 'format_request', 'concise'],
    ['换一种讲法', 'format_request', 'alternative'],
    ['内容太密，先少讲一点', 'cognitive_load', 'reduce_chunk_size'],
    ['我很挫败，先缩小一点任务', 'frustration', 'acknowledge_and_reduce_scope'],
    ['把关键点再说一次', 'support_need', 'repeat_key_point'],
  ] as const
  for (const [input, kind, value] of cases) {
    assert.ok(
      detectHumanAdaptationSignals(input).some(item => item.signalKind === kind && item.value === value),
      input,
    )
  }
})

test('adaptation extraction deduplicates and caps simultaneous directives', () => {
  const signals = detectHumanAdaptationSignals(
    '太快了，慢一点，一步一步来，画个图，给我代码，来个例子，再讲一遍。',
  )
  assert.equal(signals.length, 3)
  assert.equal(new Set(signals.map(item => `${item.signalKind}:${item.value}`)).size, signals.length)
})

test('negated and attributed requests do not reverse learner preferences', () => {
  for (const input of [
    '不要给我代码例子，先讲原理', '不用画图', '不需要慢一点',
    '我朋友说给我代码例子', '假如我说给我代码例子',
    '这是测试，请慢一点', '老师说“给我代码例子”',
    '以前我想看动画', '给我代码例子就算了',
  ]) assert.deepEqual(detectHumanAdaptationSignals(input), [], input)
  assert.deepEqual(detectHumanAdaptationSignals('不要给我代码例子，请用图示').map(item => item.value), ['visual'])
  assert.deepEqual(detectHumanAdaptationSignals('不要展开，别再重复').map(item => item.value), ['concise', 'alternative'])
})

test('adaptation evidence is the supporting clause, including requests after long context', () => {
  const signals = detectHumanAdaptationSignals(`${'这是学习背景。'.repeat(80)}请慢一点。`)
  assert.equal(signals.length, 1)
  assert.equal(signals[0].evidenceQuote, '请慢一点')
})
