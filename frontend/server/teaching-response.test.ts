import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { systemPrompt, buildTutorInstructions } from '../src/tutor.ts'
import { TEACHING_RESPONSE_VERSION, teachingResponsePrompt } from '../src/teaching-response.ts'
import { runTutorAgentTurn } from './agent-runtime.ts'
import cases from '../../backend/tests/fixtures/teaching_response_cases.json' with { type: 'json' }

// These test transport/formatting, not the semantic quality of a mocked model.
for (const mode of ['free', 'simple_explain', 'guided_learning', 'learning_plan'] as const) {
  test(`shared expression policy reaches ${mode} without replacing mode authority`, () => {
    const prompt = systemPrompt(mode)
    assert.ok(prompt.includes(teachingResponsePrompt()))
    assert.equal(prompt.split(TEACHING_RESPONSE_VERSION).length - 1, 1)
    assert.match(prompt, /正式 SkillRun.*服从当前动作/)
    assert.match(prompt, /只在学生明确请求对应视觉形式且宿主允许/)
    assert.doesNotMatch(prompt, /按需组织为：直观认识、核心机制/)
    const withContext = buildTutorInstructions({ mode, selectionContext: '本轮选中内容：EXACT_SELECTION_MARKER' })
    assert.ok(withContext.includes('EXACT_SELECTION_MARKER'))
    assert.ok(!teachingResponsePrompt().includes('EXACT_SELECTION_MARKER'))
  })
}

for (const endpoint of ['chat/completions', 'responses']) {
  for (const item of cases.cases) {
    test(`${endpoint}: reference ${item.id} preserves history and Markdown through the real turn runtime`, async () => {
      const captured: any[] = []
      const messages = item.messages.map(message => ({ ...message, role: message.role as 'user' | 'assistant' }))
      const result = await runTutorAgentTurn({
        baseUrl: `https://provider.example/v1/${endpoint}`, model: 'test-model', mode: 'simple_explain',
        messages, toolChoice: 'auto', generate: async () => { throw new Error('no visual tool requested') },
        invokeProvider: async request => {
          captured.push(request.body)
          return endpoint === 'responses'
            ? { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: item.referenceAnswer }] }] }
            : { choices: [{ finish_reason: 'stop', message: { content: item.referenceAnswer } }] }
        },
      })
      assert.equal(result.reply, item.referenceAnswer)
      assert.equal(result.trace.toolCalls, 0)
      assert.equal(captured.length, 1)
      const body = captured[0]
      const instructions = body.instructions || body.messages.find((message: any) => message.role === 'system')?.content
      assert.ok(instructions.includes(teachingResponsePrompt()))
      const sent = body.input || body.messages
      for (const message of messages) {
        assert.ok(sent.some((entry: any) => entry.role === message.role && entry.content === message.content))
      }
    })
  }
}

test('supported Markdown renders code, math and comparisons without treating code as math', () => {
  const content = '一次更新使用 $w=0.6$。\n\n$$\nw_{\\mathrm{new}}=w-\\eta L^{\\prime}(w)\n$$\n\n```python\nfor x in range(3):\n    print("$x$")\n```\n\n| 参数 | 数值 |\n| --- | --- |\n| 学习率 | 0.1 |'
  const rendered = renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm, remarkMath], rehypePlugins: [rehypeKatex], children: content,
  }))
  assert.match(rendered, /class="katex"/)
  assert.match(rendered, /katex-display/)
  assert.doesNotMatch(rendered, /katex-error/)
  assert.match(rendered, /<code class="language-python">/)
  assert.ok(rendered.includes('    print(&quot;$x$&quot;)'))
  assert.match(rendered, /<table>/)
})
