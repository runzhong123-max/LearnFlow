import assert from 'node:assert/strict'
import test from 'node:test'
import { humanizeLearningFileReferences, plainLearningFileExcerpt } from '../src/learning-file-message.ts'

test('internal learning file refs become student-facing titles', () => {
  const content = '**练习文件：** `practice-set-private-ref` **标题：** 张量形状检测\n\n请打开 practice-set-private-ref 作答。'
  const rendered = humanizeLearningFileReferences(content, [{
    kind: 'practice', ref: 'practice-set-private-ref', title: '张量形状检测',
  }])
  assert.ok(!rendered.includes('practice-set-private-ref'))
  assert.ok(rendered.includes('**练习文件：** **张量形状检测**'))
  assert.ok(!rendered.includes('标题：'))
})

test('learning file excerpts remove markdown furniture and stay bounded', () => {
  const excerpt = plainLearningFileExcerpt('## 第一节\n\n这是 **关键定义**，参见 [来源](https://example.com)。`shape` 很重要。', 52)
  assert.equal(excerpt, '第一节 这是 关键定义，参见 来源。shape 很重要。')
  assert.ok(excerpt.length <= 52)
})
