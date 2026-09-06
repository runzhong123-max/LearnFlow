import assert from 'node:assert/strict'
import test from 'node:test'

import {
  profilePacketToTutorContext,
  readFiveKernelProfile,
  SIMULATED_FIVE_KERNEL_PROFILE,
} from '../src/five-kernel-profile.ts'

test('the simulation contains only modules and claims and never claims course exposure is mastery', () => {
  assert.equal(SIMULATED_FIVE_KERNEL_PROFILE.authority, 'simulated_read_only_profile')
  assert.deepEqual(new Set(SIMULATED_FIVE_KERNEL_PROFILE.modules.map(module => module.kernel)), new Set([
    'structure', 'knowledge', 'human', 'value', 'practice',
  ]))
  assert.ok(SIMULATED_FIVE_KERNEL_PROFILE.modules.every(module => module.claims.length > 0))
  assert.ok(SIMULATED_FIVE_KERNEL_PROFILE.modules.flatMap(module => module.claims)
    .some(item => item.text.includes('不能从自述推断掌握')))
})

test('an explanation retrieves coordinated knowledge, human and structure context without dumping the profile', () => {
  const packet = readFiveKernelProfile({ message: '跟我讲讲什么是核方法', mode: 'simple_explain' })
  assert.ok(packet.manifest.kernels.includes('knowledge'))
  assert.ok(packet.manifest.kernels.includes('human'))
  assert.ok(packet.manifest.kernels.includes('structure'))
  assert.ok(packet.manifest.moduleCount <= 5)
  assert.ok(packet.manifest.claimCount <= 9)
  assert.ok(packet.manifest.omittedModuleCount > 0)
  assert.ok(packet.adaptationDirectives.some(item => item.includes('定义')))
  assert.ok(packet.adaptationDirectives.some(item => item.includes('视觉型学习者')))
})

test('a path request brings structure knowledge and simplified value into one packet', () => {
  const packet = readFiveKernelProfile({ message: '帮我规划机器学习、智能体和强化学习的路线', mode: 'free' })
  assert.deepEqual(packet.manifest.kernels.slice(0, 3), ['structure', 'knowledge', 'value'])
  assert.ok(packet.selectedModules.some(module => module.id === 'value-current-directions'))
  const context = profilePacketToTutorContext(packet)
  assert.match(context, /三条方向尚无固定优先级/)
  assert.match(context, /不必等待强化学习/)
})

test('project requests surface the practice evidence gap instead of inferring competence', () => {
  const packet = readFiveKernelProfile({ message: '带我做一个智能体工程项目并评估我的实践能力', mode: 'guided_learning' })
  assert.equal(packet.manifest.kernels[0], 'practice')
  assert.ok(packet.selectedModules.some(module => module.id === 'practice-project-competence'))
  assert.ok(packet.missingFacets.some(item => item.includes('真实项目产物')))
  const context = profilePacketToTutorContext(packet)
  assert.match(context, /不能用来宣布掌握/)
  assert.match(context, /证据不足，无法判断独立完成能力/)
  assert.match(context, /生成过的讲解、路线、题目.*不是学习者理解或实践能力证据/)
})

test('sensitive human claims become silent directives rather than raw model-facing claims', () => {
  const packet = readFiveKernelProfile({ message: '我还是不懂，慢一点解释并给我提示', mode: 'guided_learning' })
  const humanClaims = packet.selectedModules.filter(module => module.kernel === 'human').flatMap(module => module.claims)
  assert.equal(humanClaims.length, 0)
  assert.ok(packet.adaptationDirectives.some(item => item.includes('不推断稳定情绪')))
  assert.ok(!profilePacketToTutorContext(packet).includes('学习者明确偏好有解释作用的可视化内容'))
})

test('reader output is deterministic and bounded', () => {
  const input = { message: '我该怎么继续学强化学习', mode: 'free' as const, maxModules: 3, maxClaims: 4 }
  const first = readFiveKernelProfile(input)
  const second = readFiveKernelProfile(input)
  assert.equal(first.snapshotId, second.snapshotId)
  assert.ok(first.manifest.moduleCount <= 3)
  assert.ok(first.manifest.claimCount <= 4)
  assert.equal(first.manifest.noMasteryInference, true)
})
