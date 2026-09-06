import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CORE_TOOL_CAPABILITIES,
  visibleToolCapabilities,
} from '../src/tool-capability-catalog.ts'

test('tool capability catalog exposes broad core functions instead of individual tool ids', () => {
  const capabilities = visibleToolCapabilities([], [])
  assert.equal(capabilities.length, 6)
  assert.deepEqual(capabilities.map(item => item.id), CORE_TOOL_CAPABILITIES.map(item => item.id))
  assert.ok(capabilities.every(item => item.source === 'core'))
  assert.ok(capabilities.every(item => !item.label.includes('_') && !item.purpose.includes('__')))
})

test('only enabled plugins appear as one functional capability each', () => {
  const capabilities = visibleToolCapabilities(
    ['role_capability_graph'],
    [
      {
        pluginId: 'role_capability_graph',
        name: '岗位能力图谱',
        description: '读取岗位、任务、能力与学习对象之间的有据关系。',
        icon: '岗',
      },
      { pluginId: 'disabled_plugin', name: '未启用插件' },
    ],
  )
  const plugins = capabilities.filter(item => item.source === 'plugin')
  assert.deepEqual(plugins, [{
    id: 'plugin:role_capability_graph',
    label: '岗位能力图谱',
    purpose: '读取岗位、任务、能力与学习对象之间的有据关系。',
    glyph: '岗',
    status: '插件已启用',
    source: 'plugin',
  }])
})
