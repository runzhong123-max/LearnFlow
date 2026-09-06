import assert from 'node:assert/strict'
import test from 'node:test'
import { VISUAL_STORYBOARD_CASES } from './visual-storyboard-cases.ts'
import {
  applyAsciiStoryboardDesign,
  buildAsciiStoryboardDesignContext,
  compileVisualStoryboard,
  designAsciiStoryboard,
  validateVisualStoryboard,
} from './visual-storyboard-tool.ts'
import { parseV2Spec } from './visual-spec/validation.ts'

test('ten fixed storyboard contexts compile into replayable state-changing animations', () => {
  assert.equal(VISUAL_STORYBOARD_CASES.length, 10)
  for (const context of VISUAL_STORYBOARD_CASES) {
    const generated = compileVisualStoryboard(context)
    assert.equal(generated.spec.abstraction, 'semantic_scene', context.id)
    assert.equal(generated.artifact.kind, 'animation', context.id)
    assert.equal(generated.artifact.steps.length, context.frames.length + 1, context.id)
    assert.equal(generated.quality.status, 'passed', `${context.id}: ${generated.quality.issues.join(',')}`)
    assert.equal(generated.quality.replayable, true, context.id)
    assert.equal(generated.quality.semanticChanges, context.frames.length, context.id)
    const persisted = parseV2Spec(JSON.parse(JSON.stringify(generated.spec)), 'animation', JSON.stringify(context), { preserveMetadata: true })
    assert.equal(persisted.abstraction, 'semantic_scene', `${context.id}: persisted round trip`)
    assert.equal(generated.artifact.canvasFormat, 'ascii', context.id)
    generated.artifact.steps.forEach(step => {
      assert.ok(step.ascii?.trim(), context.id)
      assert.equal(step.svg, '', context.id)
      assert.doesNotMatch(step.ascii || '', /\u001b|<script|javascript:/i, context.id)
    })
  }
})

test('storyboard rejects dangling references before rendering', () => {
  const broken = structuredClone(VISUAL_STORYBOARD_CASES[0])
  broken.frames[0].operations.push({ op: 'focus', targetIds: ['missing_entity'] })
  assert.throws(() => validateVisualStoryboard(broken), /visual_storyboard_reference_invalid/)
})

test('storyboard rejects an asserted state that replay does not produce', () => {
  const broken = structuredClone(VISUAL_STORYBOARD_CASES[1])
  broken.frames[0].assertions.push({ type: 'visible', targetId: 'v5', equals: false })
  assert.throws(() => compileVisualStoryboard(broken), /visual_storyboard_assertion_failed/)
})

test('storyboard rejects an authored ASCII frame that omits a visible subject object', () => {
  const broken = structuredClone(VISUAL_STORYBOARD_CASES[3])
  broken.initial.asciiCanvas = '+---+\n| 客户端 |\n+---+'
  assert.throws(() => compileVisualStoryboard(broken), /visual_storyboard_ascii_objects_missing/)
})

test('storyboard accepts an Agent-authored ASCII frame and does not invoke SVG fallback', () => {
  const context = structuredClone(VISUAL_STORYBOARD_CASES[3])
  context.initial.asciiCanvas = '+----------+                       +----------+\n| 客户端   |                       | 服务端   |\n| CLOSED   |                       | LISTEN   |\n+----------+                       +----------+'
  const authored = [
    '+----------+       1. SYN          +----------+\n| 客户端   | -----------------------> | 服务端   |\n| SYN-SENT |                           | LISTEN   |\n+----------+                           +----------+',
    '+--------------+    2. SYN-ACK     +----------------+\n| 客户端       | <----------------- | 服务端         |\n| SYN-SENT     |                     | SYN-RECEIVED   |\n+--------------+                     +----------------+',
    '+---------------+     3. ACK       +---------------+\n| 客户端        | -----------------> | 服务端        |\n| ESTABLISHED   |                     | ESTABLISHED   |\n+---------------+                     +---------------+',
  ]
  context.frames.forEach((frame, index) => { frame.asciiCanvas = authored[index] })
  const generated = compileVisualStoryboard(context)
  assert.equal(generated.degraded, false)
  assert.equal(generated.artifact.fallbackUsed, false)
  assert.match(generated.artifact.steps[1].ascii || '', /1\. SYN/)
})

test('ASCII designer receives replayed complete states but cannot rewrite semantic operations', () => {
  const context = VISUAL_STORYBOARD_CASES[0]
  const designContext = buildAsciiStoryboardDesignContext(context)
  assert.equal(designContext.frames.length, context.frames.length)
  assert.deepEqual(designContext.frames.at(-1)?.visibleEntities.map(entity => entity.id).sort(), context.entities.map(entity => entity.id).sort())
  assert.equal(designContext.frames.at(-1)?.visibleRelations.length, context.relations.length)
  assert.equal('operations' in designContext.frames[0], false)

  const fallback = compileVisualStoryboard(context)
  const payload = {
    version: 'learnflow.ascii-storyboard-design.v1',
    initial: { asciiCanvas: fallback.artifact.steps[0].ascii },
    frames: context.frames.map((frame, index) => ({ id: frame.id, asciiCanvas: fallback.artifact.steps[index + 1].ascii })),
  }
  const designed = applyAsciiStoryboardDesign(context, JSON.stringify(payload))
  assert.deepEqual(designed.frames.map(frame => frame.operations), context.frames.map(frame => frame.operations))
})

test('ASCII design omission receives a disclosed generic state ledger instead of losing the object', () => {
  const context = VISUAL_STORYBOARD_CASES[3]
  const fallback = compileVisualStoryboard(context)
  const payload = {
    version: 'learnflow.ascii-storyboard-design.v1',
    initial: { asciiCanvas: '+-- client only --+\n| 客户端 |' },
    frames: context.frames.map((frame, index) => ({ id: frame.id, asciiCanvas: fallback.artifact.steps[index + 1].ascii })),
  }
  const designed = applyAsciiStoryboardDesign(context, JSON.stringify(payload))
  const generated = compileVisualStoryboard(designed)
  assert.equal(designed.initial.asciiSupplemented, true)
  assert.match(generated.artifact.steps[0].ascii || '', /仍在状态中的对象/)
  assert.match(generated.artifact.steps[0].ascii || '', /服务端/)
  assert.equal(generated.degraded, true)
  assert.ok(generated.quality.warnings.includes('ascii_object_ledger_supplemented'))
})

test('ASCII design and repair share one outer-owned time budget', async () => {
  const context = VISUAL_STORYBOARD_CASES[3]
  const fallback = compileVisualStoryboard(context)
  const validPayload = JSON.stringify({
    version: 'learnflow.ascii-storyboard-design.v1',
    initial: { asciiCanvas: fallback.artifact.steps[0].ascii },
    frames: context.frames.map((frame, index) => ({ id: frame.id, asciiCanvas: fallback.artifact.steps[index + 1].ascii })),
  })
  const timeouts: number[] = []
  let attempt = 0
  const designed = await designAsciiStoryboard(context, async (_instructions, _input, timeoutMs) => {
    timeouts.push(timeoutMs || 0)
    attempt += 1
    return attempt === 1 ? '{"version":"broken"}' : validPayload
  })
  assert.equal(designed.version, context.version)
  assert.equal(timeouts[0], 420_000)
  assert.ok(timeouts[1] > 0 && timeouts[1] <= 720_000)
})
