import assert from 'node:assert/strict'
import test from 'node:test'

import type { FormalMemoryModule } from '../src/formal-runtime.ts'
import {
  lastMemoryField,
  presentClaimText,
  presentEvidenceCount,
  presentModuleTitle,
  presentVerification,
} from '../src/profile-presentation.ts'

const projectModule: FormalMemoryModule = {
  id: 7,
  kernel: 'structure',
  subject_key: 'project:7',
  title: 'project:7',
  summary: 'active_checkpoint_id: 34；current_task: PyTorch 热身；path_position: {"project_name": "从零实现迷你 GPT"}；active_checkpoint_id: 35；current_task: 字符级文本数据管线',
  version: 8,
  revision_kind: 'refinement',
  evidence_fact_ids: [1, 2, 3, 4],
  claims: [{ id: 1, text: 'current_task: 字符级文本数据管线', status: 'active', confidence: .9, predicate: 'current_position', verification_status: 'supported' }],
}

test('technical structure memory becomes a learner-readable module and claim', () => {
  assert.equal(lastMemoryField(projectModule.summary, 'current_task'), '字符级文本数据管线')
  assert.equal(presentModuleTitle(projectModule), '项目：从零实现迷你 GPT')
  assert.equal(presentEvidenceCount(projectModule), '由 4 条事实依据凝练而成')
  assert.equal(
    presentClaimText(projectModule, projectModule.claims[0]),
    '你目前在“从零实现迷你 GPT”项目中学习“字符级文本数据管线”，下次可以从这里继续。',
  )
  assert.equal(presentVerification(projectModule.claims[0]), '有证据支持')
})

test('a global goal is rendered as one correctable learner statement', () => {
  const module: FormalMemoryModule = {
    ...projectModule,
    subject_key: 'global',
    summary: 'active_proposal_id: 3; proposal_status: active; current_goal: 理解并亲手实现 GPT 的完整训练与生成链路',
    version: 1,
    claims: [{ ...projectModule.claims[0], text: 'current_goal: 理解并亲手实现 GPT 的完整训练与生成链路' }],
  }
  assert.equal(presentModuleTitle(module), '整体学习位置与路线')
  assert.equal(presentClaimText(module, module.claims[0]), '你当前确认的学习目标是：理解并亲手实现 GPT 的完整训练与生成链路。')
})

test('human workload and value priority do not expose internal field names', () => {
  const humanModule: FormalMemoryModule = {
    ...projectModule,
    kernel: 'human',
    subject_key: 'preference:learning',
    summary: 'weekly_hours: 7',
    claims: [{ ...projectModule.claims[0], text: 'learning 的human动作已形成稳定片段：weekly_hours: 7' }],
  }
  assert.equal(presentModuleTitle(humanModule), '学习节奏与支持')
  assert.equal(
    presentClaimText(humanModule, humanModule.claims[0]),
    '你目前计划每周投入约 7 小时学习，Tutor 可以据此控制任务长度和节奏。',
  )

  const valueModule: FormalMemoryModule = {
    ...projectModule,
    kernel: 'value',
    subject_key: 'global',
    summary: 'focus_areas: ["AI", "强化学习"]；current_priority: 我想学习强化学习相关知识，如何入手；current_motivation: explicit',
    claims: [{ ...projectModule.claims[0], text: 'current_priority: 我想学习强化学习相关知识，如何入手' }],
  }
  assert.equal(
    presentClaimText(valueModule, valueModule.claims[0]),
    '你当前优先想学习：我想学习强化学习相关知识，如何入手。',
  )
})
