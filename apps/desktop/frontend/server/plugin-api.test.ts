import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import {
  defineLearnFlowPlugin,
  LEARNFLOW_PLUGIN_API_VERSION,
  LEARNFLOW_PLUGIN_OBJECT_VERSION,
  LearnFlowPluginRegistry,
  parsePluginObjectDragData,
  pluginObjectReferenceText,
} from '../src/plugin-api.ts'
import { runTutorAgentTurn } from './agent-runtime.ts'
import { createLearnFlowPluginRegistryProvider, loadLearnFlowPluginRegistry } from './plugin-loader.ts'
import {
  activeConversationPluginIds,
  lockedConversationPluginIds,
  stickyConversationPluginIds,
} from '../src/conversation-plugin-state.ts'

function fixturePlugin(options: { id?: string; defaultEnabled?: boolean } = {}) {
  const id = options.id || 'fixture_graph'
  return defineLearnFlowPlugin({
    manifest: {
      apiVersion: LEARNFLOW_PLUGIN_API_VERSION,
      id,
      name: 'Fixture Graph',
      version: '1.0.0',
      description: 'Exercises the generic extension points.',
      defaultEnabled: options.defaultEnabled,
      objects: [{
        type: 'node', title: 'Node', description: 'A graph node.', schemaVersion: 'fixture.node.v1',
        schema: { type: 'object', properties: { score: { type: 'number' } }, required: ['score'], additionalProperties: false },
        validate: value => typeof value === 'object' && value !== null && Number.isFinite((value as any).score) ? [] : ['score is required'],
      }],
      tools: [{
        id: 'read_graph', title: 'Read graph', description: 'Reads a bounded graph.',
        whenToUse: 'The learner asks about this graph.', whenNotToUse: 'The request needs a core-object write.',
        toolClass: 'perception', risk: 'read_only',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
        outputObjectTypes: ['node'], renderer: 'radar', availableInModes: ['free', 'simple_explain'],
      }],
      skills: [{
        id: 'graph_reading', title: 'Graph reading', description: 'Read before explaining.',
        whenToUse: 'A graph explanation is requested.', whenNotToUse: 'No graph is active.',
        instructions: 'Read the graph once, cite the returned object IDs, and do not infer mastery.',
        tools: ['read_graph'], objectTypes: ['node'],
      }],
      renderers: [{ id: 'radar', title: 'Radar', description: 'Renders node scores.' }],
    },
    handlers: {
      read_graph: async input => ({
        summary: `matched ${String(input.query)}`,
        objects: [{
          protocol: LEARNFLOW_PLUGIN_OBJECT_VERSION,
          pluginId: id,
          objectType: 'node', objectId: 'node:1', schemaVersion: 'fixture.node.v1', label: 'Node 1', value: { score: 0.8 },
        }],
        presentation: { renderer: 'radar', state: { selected: 'node:1' } },
      }),
    },
  })
}

test('development registry provider refreshes while production keeps one immutable catalog', async () => {
  let developmentLoads = 0
  const development = createLearnFlowPluginRegistryProvider({
    reload: true,
    load: async () => new LearnFlowPluginRegistry([fixturePlugin({ id: `dev_graph_${++developmentLoads}` })]),
  })
  assert.deepEqual((await development.get()).packages.map(item => item.manifest.id), ['dev_graph_1'])
  assert.deepEqual((await development.get()).packages.map(item => item.manifest.id), ['dev_graph_2'])

  let productionLoads = 0
  const production = createLearnFlowPluginRegistryProvider({
    reload: false,
    load: async () => {
      productionLoads += 1
      return new LearnFlowPluginRegistry([fixturePlugin({ id: 'production_graph' })])
    },
  })
  assert.equal(await production.get(), await production.get())
  assert.equal(productionLoads, 1)
})

test('plugin object drag payload stays versioned and produces an exact prompt reference', () => {
  const object = {
    protocol: LEARNFLOW_PLUGIN_OBJECT_VERSION,
    pluginId: 'fixture_graph',
    objectType: 'node',
    objectId: 'node:1/alpha',
    schemaVersion: 'fixture.node.v1',
    label: 'Node 1',
    value: { score: 0.8 },
  }
  assert.deepEqual(parsePluginObjectDragData(JSON.stringify(object)), object)
  assert.equal(
    pluginObjectReferenceText(object),
    '- Node 1（plugin-object://fixture_graph/node/node%3A1%2Falpha?schema=fixture.node.v1）',
  )
  assert.equal(parsePluginObjectDragData('{"pluginId":"fixture_graph"}'), undefined)
  assert.equal(parsePluginObjectDragData('not json'), undefined)
})

test('development reload invalidates a plugin dependency graph atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'learnflow-plugin-reload-'))
  const directory = join(root, 'reload_graph')
  await mkdir(directory)
  const pluginApiUrl = pathToFileURL(resolve(process.cwd(), 'src/plugin-api.ts')).href
  await writeFile(join(directory, 'server.mjs'), `
    import { defineLearnFlowPlugin, LEARNFLOW_PLUGIN_API_VERSION, versionedPluginModuleUrl } from ${JSON.stringify(pluginApiUrl)}
    const { rendererId } = await import(versionedPluginModuleUrl('./shared.mjs', import.meta.url))
    export default defineLearnFlowPlugin({
      manifest: {
        apiVersion: LEARNFLOW_PLUGIN_API_VERSION, id: 'reload_graph', name: 'Reload Graph', version: '1.0.0', description: 'Reload fixture.',
        objects: [], tools: [], skills: [], renderers: [{ id: rendererId, title: 'Renderer', description: 'Reload fixture renderer.' }],
      }, handlers: {},
    })
  `)
  try {
    await writeFile(join(directory, 'shared.mjs'), `export const rendererId = 'radar_first'\n`)
    const first = await loadLearnFlowPluginRegistry(root)
    assert.deepEqual(first.packages[0].manifest.renderers.map(item => item.id), ['radar_first'])

    await writeFile(join(directory, 'shared.mjs'), `export const rendererId = 'radar_second_version'\n`)
    const second = await loadLearnFlowPluginRegistry(root)
    assert.deepEqual(second.packages[0].manifest.renderers.map(item => item.id), ['radar_second_version'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('plugin contributions are namespaced and inactive packages expose no tools or skills', () => {
  const registry = new LearnFlowPluginRegistry([fixturePlugin()])
  const inactive = { mode: 'free' as const }
  assert.deepEqual(registry.toolDefinitions(inactive), [])
  assert.equal(registry.skillInstructions(inactive), '')
  const active = { mode: 'free' as const, activePluginIds: ['fixture_graph'] }
  assert.deepEqual(registry.toolDefinitions(active).map(item => item.name), ['fixture_graph__read_graph'])
  assert.match(registry.skillInstructions(active), /fixture_graph__read_graph/)
  assert.match(registry.skillInstructions(active), /必须在形成回答或追问前至少调用该插件的一个可用工具/)
  assert.match(registry.toolDefinitions(active)[0].description, /不要用于/)
})

test('a plugin becomes conversation-sticky after its first tool run without plugin-specific state', () => {
  const completed = {
    id: 'used-plugin', kind: 'plugin' as const, status: 'completed' as const, title: 'Read graph', detail: 'matched', durationMs: 1,
    toolName: 'fixture_graph__read_graph', plugin: { pluginId: 'fixture_graph', toolId: 'read_graph', result: { summary: 'matched' } },
  }
  const failed = {
    id: 'failed-plugin', kind: 'plugin' as const, status: 'failed' as const, title: 'Read graph', detail: 'failed', durationMs: 1,
    toolName: 'another_graph__read_graph',
  }
  const conversation = { pluginIds: [], messages: [{ toolRuns: [completed] }], sheets: [{ messages: [{ toolRuns: [failed] }] }] }
  assert.deepEqual(lockedConversationPluginIds(conversation), ['fixture_graph', 'another_graph'])
  assert.deepEqual(activeConversationPluginIds(conversation), ['fixture_graph', 'another_graph'])
  assert.deepEqual(stickyConversationPluginIds([], ['fixture_graph']), ['fixture_graph'])
})

test('Tutor keeps a previously used plugin active when the caller omits it from the next selection', async () => {
  const registry = new LearnFlowPluginRegistry([fixturePlugin()])
  const requests: any[] = []
  await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions', model: 'test-model', mode: 'simple_explain', toolChoice: 'auto',
    pluginRegistry: registry, activePluginIds: [], generate: async () => 'unused',
    messages: [
      { role: 'assistant', content: '图谱结果。', toolRuns: [{
        id: 'prior-plugin-run', kind: 'plugin', status: 'completed', title: 'Read graph', detail: 'matched', durationMs: 1,
        toolName: 'fixture_graph__read_graph', plugin: { pluginId: 'fixture_graph', toolId: 'read_graph', result: { summary: 'matched' } },
      }] },
      { role: 'user', content: '继续' },
    ],
    invokeProvider: async request => {
      requests.push(request)
      return { choices: [{ message: { content: '继续。' } }] }
    },
  })
  const body = JSON.stringify(requests[0].body)
  assert.match(body, /fixture_graph__read_graph/)
  assert.match(body, /Read the graph once/)
})

test('tool execution validates input, object ownership and renderer declaration', async () => {
  const registry = new LearnFlowPluginRegistry([fixturePlugin({ defaultEnabled: true })])
  const context = { mode: 'free' as const, scope: { mode: 'free' as const }, signal: AbortSignal.timeout(1_000) }
  await assert.rejects(() => registry.execute('fixture_graph__read_graph', { query: 'x', extra: true }, context), /unknown fields/)
  await assert.rejects(() => registry.execute('fixture_graph__read_graph', { query: 42 }, context), /must be string/)
  const execution = await registry.execute('fixture_graph__read_graph', { query: 'x' }, context)
  assert.equal(execution.result.objects?.[0].objectId, 'node:1')
  assert.equal(execution.result.presentation?.renderer, 'fixture_graph:radar')
})

test('a plugin handler cannot hold the Tutor turn beyond the host signal', async () => {
  const plugin = fixturePlugin({ defaultEnabled: true })
  plugin.handlers.read_graph = async () => new Promise(() => undefined)
  const registry = new LearnFlowPluginRegistry([plugin])
  await assert.rejects(() => registry.execute('fixture_graph__read_graph', { query: 'x' }, {
    mode: 'free', scope: { mode: 'free' }, signal: AbortSignal.timeout(10),
  }), /plugin_tool_timeout/)
})

test('duplicate plugin ids and cross-plugin object forgery are rejected', async () => {
  assert.throws(() => new LearnFlowPluginRegistry([fixturePlugin(), fixturePlugin()]), /duplicate ids/)
  const forged = fixturePlugin({ id: 'forged_graph', defaultEnabled: true })
  forged.handlers.read_graph = async () => ({
    summary: 'forged',
    objects: [{
      protocol: LEARNFLOW_PLUGIN_OBJECT_VERSION,
      pluginId: 'another_plugin', objectType: 'node', objectId: 'node:1', schemaVersion: 'fixture.node.v1', label: 'Node', value: { score: 1 },
    }],
  })
  const registry = new LearnFlowPluginRegistry([forged])
  await assert.rejects(() => registry.execute('forged_graph__read_graph', { query: 'x' }, {
    mode: 'free', scope: { mode: 'free' }, signal: AbortSignal.timeout(1_000),
  }), /owned by another plugin/)
})

test('Tutor discovers plugin tools, applies plugin Skill instructions and returns renderer metadata without plugin branches', async () => {
  const registry = new LearnFlowPluginRegistry([fixturePlugin()])
  const requests: any[] = []
  let round = 0
  const result = await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions', model: 'test-model', mode: 'simple_explain',
    messages: [{ role: 'user', content: '解释当前图谱节点' }], toolChoice: 'auto',
    pluginRegistry: registry, activePluginIds: ['fixture_graph'], generate: async () => 'unused',
    invokeProvider: async request => {
      requests.push(request)
      round += 1
      if (round === 1) return { choices: [{ message: { content: null, tool_calls: [{
        id: 'plugin-call', type: 'function', function: { name: 'fixture_graph__read_graph', arguments: '{"query":"当前节点"}' },
      }] } }] }
      return { choices: [{ message: { content: '当前节点的结构化分数是 0.8；这只是插件对象，不表示学习者掌握。' } }] }
    },
  })
  assert.equal(requests[0].body.tools[0].function?.name, 'fixture_graph__read_graph')
  assert.match(JSON.stringify(requests[0].body), /Read the graph once/)
  assert.equal(result.toolRuns[0].kind, 'plugin')
  assert.equal(result.toolRuns[0].plugin?.pluginId, 'fixture_graph')
  assert.equal(result.toolRuns[0].plugin?.result.presentation?.renderer, 'fixture_graph:radar')
  assert.match(result.reply, /0\.8/)
})

test('Tutor keeps bounded plugin snapshot state and object references for the next turn', async () => {
  const registry = new LearnFlowPluginRegistry([fixturePlugin()])
  const requests: any[] = []
  await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions', model: 'test-model', mode: 'simple_explain', toolChoice: 'auto',
    pluginRegistry: registry, activePluginIds: ['fixture_graph'], generate: async () => 'unused',
    messages: [
      { role: 'user', content: '解释当前图谱节点' },
      { role: 'assistant', content: '节点一。', toolRuns: [{
        id: 'prior-plugin-run', kind: 'plugin', status: 'completed', title: 'Read graph', detail: 'matched', durationMs: 1,
        toolName: 'fixture_graph__read_graph', observationSummary: 'matched',
        plugin: {
          pluginId: 'fixture_graph', toolId: 'read_graph',
          result: {
            summary: 'matched',
            objects: [{
              protocol: LEARNFLOW_PLUGIN_OBJECT_VERSION, pluginId: 'fixture_graph', objectType: 'node', objectId: 'node:1',
              schemaVersion: 'fixture.node.v1', label: 'Node 1', value: { score: 0.8 },
            }],
            presentation: { renderer: 'fixture_graph:radar', state: { snapshotId: 'snapshot:fixture', focusObjectIds: ['node:1'] } },
          },
        },
      }] },
      { role: 'user', content: '这个节点呢？' },
    ],
    invokeProvider: async request => {
      requests.push(request)
      return { choices: [{ message: { content: '继续解释 Node 1。' } }] }
    },
  })
  const body = JSON.stringify(requests[0].body)
  assert.match(body, /snapshot:fixture/)
  assert.match(body, /node:1/)
  assert.match(body, /fixture_graph/)
})
