import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyLearningTaskInput,
  prepareLearningTaskIntake,
  suggestLearningTaskStepCount,
} from '../plugins/learning_task_conversion/intake.ts'
import {
  assertConfirmedLearningTaskIntake,
  prepareLearningTaskIntakeEnvelope,
} from '../plugins/learning_task_conversion/intake-runtime.ts'
import {
  parseLearningTaskPreflightResult,
  preflightResultToIntakeInput,
} from '../plugins/learning_task_conversion/preflight-model.ts'

test('classifies the user examples without silently changing domains', () => {
  assert.equal(classifyLearningTaskInput('我想当网络工程师'), 'role')
  assert.equal(classifyLearningTaskInput('我想学习计算机网络'), 'learning_topic')
  assert.equal(classifyLearningTaskInput('linux系统开发'), 'role_or_direction')
  assert.equal(classifyLearningTaskInput('新能源汽车电池安装'), 'work_task')
  assert.equal(classifyLearningTaskInput('电脑Windows系统安装'), 'work_task')
  assert.equal(classifyLearningTaskInput('unity摄像机的放置与2D视角跟随'), 'work_task')
  assert.equal(classifyLearningTaskInput('Windows 11'), 'ambiguous')
  assert.equal(
    classifyLearningTaskInput('Unity游戏客户端第三人称摄像机跟随与遮挡修正模块开发及验收'),
    'work_task',
  )
})

test('a concrete task is prepared but never confirmed automatically', () => {
  const intake = prepareLearningTaskIntake({ rawInput: '新能源汽车电池安装' })
  assert.equal(intake.status, 'ready_for_confirmation')
  assert.equal(intake.taskContract.title, '新能源汽车电池安装')
  assert.equal(intake.taskContract.action, '安装')
  assert.match(intake.taskContract.workObject, /新能源汽车电池/)
  assert.equal(intake.confirmed, false)
  assert.equal('targetStepCount' in intake, false)
})

test('step planning hint follows the confirmed task complexity instead of a fixed template', () => {
  const simple = suggestLearningTaskStepCount('REST API 接口调试')
  const compound = suggestLearningTaskStepCount('Unity第三人称摄像机跟随与遮挡修正模块开发及验收')
  assert.ok(simple >= 4 && simple <= 9)
  assert.ok(compound >= 4 && compound <= 9)
  assert.ok(compound > simple)
})

test('a role produces a task selection gate instead of a provider call', () => {
  const intake = prepareLearningTaskIntake({
    rawInput: '我想当网络工程师',
    candidateTasks: [
      { title: '园区交换机 VLAN 配置与连通性验收', source: 'role_package', sourceRef: 'role://network/task-1' },
      { title: '企业无线网络覆盖检测与故障排查', source: 'role_package', sourceRef: 'role://network/task-2' },
    ],
  })
  assert.equal(intake.inputKind, 'role')
  assert.equal(intake.status, 'needs_task_selection')
  assert.equal(intake.candidateTasks.length, 2)
  assert.match(intake.nextQuestion, /请选择/)
})

test('a source-backed selected role task becomes ready for explicit confirmation', () => {
  const intake = prepareLearningTaskIntake({
    rawInput: '我想当网络工程师',
    candidateTasks: [
      { title: '园区交换机 VLAN 配置与连通性验收', source: 'role_package', sourceRef: 'role://network/task-1' },
    ],
    selectedTaskTitle: '园区交换机 VLAN 配置与连通性验收',
  })
  assert.equal(intake.status, 'ready_for_confirmation')
  assert.equal(intake.taskContract.action, '配置')
  assert.equal(intake.confirmed, false)
})

test('an ungrounded replacement that drops the original anchor is rejected', () => {
  const intake = prepareLearningTaskIntake({
    rawInput: 'linux系统开发',
    selectedTaskTitle: 'RAG知识库开发与调试',
  })
  assert.notEqual(intake.status, 'ready_for_confirmation')
  assert.ok(intake.warnings.some(item => item.code === 'semantic_anchor_changed'))
})

test('a learning topic asks for a real work task and does not become cybersecurity', () => {
  const intake = prepareLearningTaskIntake({ rawInput: '我想学习计算机网络' })
  assert.equal(intake.inputKind, 'learning_topic')
  assert.equal(intake.status, 'needs_task_selection')
  assert.deepEqual(intake.candidateTasks, [])
  assert.match(intake.nextQuestion, /实际工作任务/)
  assert.doesNotMatch(JSON.stringify(intake), /网络安全/)
})

test('provider execution requires the exact user-confirmed intake hash', () => {
  const intake = prepareLearningTaskIntakeEnvelope({ rawInput: '新能源汽车电池安装' })
  const confirmed = assertConfirmedLearningTaskIntake({
    originalInput: intake.originalInput,
    intakeId: intake.intakeId,
    intakeRootHash: intake.intakeRootHash,
    intakeConfirmed: true,
    taskTitle: intake.taskContract.title,
    taskDescription: intake.taskContract.description,
    taskSource: 'user_explicit',
  })
  assert.equal(confirmed.intakeRootHash, intake.intakeRootHash)
  assert.throws(() => assertConfirmedLearningTaskIntake({
    originalInput: intake.originalInput,
    intakeId: intake.intakeId,
    intakeRootHash: '0'.repeat(64),
    intakeConfirmed: true,
    taskTitle: intake.taskContract.title,
    taskSource: 'user_explicit',
  }), /hash_mismatch/)
  assert.throws(() => assertConfirmedLearningTaskIntake({
    originalInput: intake.originalInput,
    intakeId: intake.intakeId,
    intakeRootHash: intake.intakeRootHash,
    intakeConfirmed: false,
    taskTitle: intake.taskContract.title,
    taskSource: 'user_explicit',
  }), /confirmation_required/)
})

test('semantic preflight metadata is visible but does not break the confirmed task hash', () => {
  const intake = prepareLearningTaskIntakeEnvelope({
    rawInput: 'Windows 11系统安装与驱动配置',
    modelAssessment: {
      schemaVersion: 'learning-task-intake-model.v1',
      model: 'deepseek-chat',
      assessedKind: 'work_task',
      confidence: 0.97,
      rationale: '动作、对象与可验收结果已明确。',
      nextQuestion: '',
    },
  })
  assert.equal(intake.preflight.method, 'semantic_model')
  assert.doesNotThrow(() => assertConfirmedLearningTaskIntake({
    originalInput: intake.originalInput,
    intakeId: intake.intakeId,
    intakeRootHash: intake.intakeRootHash,
    intakeConfirmed: true,
    taskTitle: intake.taskContract.title,
    taskDescription: intake.taskContract.description,
    taskSource: intake.taskContract.source,
  }))
})

test('a model-proposed role task must preserve the original domain anchor', () => {
  const prepared = prepareLearningTaskIntakeEnvelope({
    rawInput: '我想从事风力发电运维工程师',
    candidateTasks: [{
      title: '风力发电机组日常巡检与异常记录',
      source: 'model_proposed',
    }],
    selectedTaskTitle: '风力发电机组日常巡检与异常记录',
  })
  assert.equal(prepared.status, 'ready_for_confirmation')
  assert.equal(prepared.taskContract.source, 'model_proposed')
})

test('real semantic preflight proposes executable tasks for a role without silently selecting one', () => {
  const result = parseLearningTaskPreflightResult(JSON.stringify({
    schema_version: 'learning-task-intake-model.v1',
    original_input: 'Unity游戏客户端开发工程师',
    input_kind: 'role',
    role_name: 'Unity游戏客户端开发工程师',
    selected_task: null,
    candidate_tasks: [
      { title: 'Unity第三人称角色移动模块开发与验收', description: '实现移动、转向并完成场景验收。' },
      { title: 'Unity摄像机跟随与遮挡修正模块开发', description: '实现跟随和遮挡修正并保留测试记录。' },
      { title: 'Unity场景切换与加载状态模块开发', description: '实现异步切换并验收加载状态。' },
    ],
    confidence: 0.94,
    rationale: '这是岗位而非单个工作任务。',
    next_question: '请选择一个具体工作任务。',
  }), 'Unity游戏客户端开发工程师')
  const intake = prepareLearningTaskIntakeEnvelope(preflightResultToIntakeInput(
    result,
    '生成学习型任务：Unity游戏客户端开发工程师',
    'deepseek-chat',
  ))
  assert.equal(intake.status, 'needs_task_selection')
  assert.equal(intake.candidateTasks.length, 3)
  assert.equal(intake.preflight.method, 'semantic_model')
  assert.equal(intake.preflight.model, 'deepseek-chat')
  assert.equal(intake.preflight.confidence, 0.94)
})

test('semantic work-task judgment is not blocked by a local keyword miss', () => {
  const intake = prepareLearningTaskIntakeEnvelope({
    rawInput: '为客户机下发公司根证书',
    modelAssessment: {
      schemaVersion: 'learning-task-intake-model.v1',
      model: 'deepseek-chat',
      assessedKind: 'work_task',
      confidence: 0.73,
      rationale: '这是带有动作、对象和可检查结果的单个任务。',
      nextQuestion: '',
    },
  })
  assert.equal(intake.inputKind, 'work_task')
  assert.equal(intake.status, 'ready_for_confirmation')
  assert.equal(intake.taskContract.title, '为客户机下发公司根证书')
  assert.equal(intake.taskContract.action, '执行')
  assert.ok(intake.warnings.some(item => item.code === 'semantic_contract_used'))
  assert.doesNotThrow(() => assertConfirmedLearningTaskIntake({
    originalInput: intake.originalInput,
    intakeId: intake.intakeId,
    intakeRootHash: intake.intakeRootHash,
    intakeConfirmed: true,
    taskTitle: intake.taskContract.title,
    taskDescription: intake.taskContract.description,
    taskSource: intake.taskContract.source,
  }))
})

test('a learner-selected semantic candidate is not rejected by the local action vocabulary', () => {
  const intake = prepareLearningTaskIntakeEnvelope({
    rawInput: 'unity摄像机放置与2D视角的跟随（类似于马里奥的摄像机）',
    candidateTasks: [{
      title: '2D 横版项目主摄像机的添加、摆放与马里奥式横向跟随',
      description: '在 Unity 2D 横版平台场景中完成主摄像机添加、正交摆放和横向跟随。',
      source: 'model_proposed',
      sourceRef: 'semantic-preflight',
    }],
    selectedTaskTitle: '2D 横版项目主摄像机的添加、摆放与马里奥式横向跟随',
  })

  assert.equal(intake.status, 'ready_for_confirmation')
  assert.equal(intake.taskContract.action, '添加')
  assert.equal(intake.taskContract.workObject, '2D 横版项目主摄像机 摆放 马里奥式横向跟随')
  assert.ok(!intake.warnings.some(item => item.code === 'semantic_selected_contract_used'))
  assert.ok(!intake.warnings.some(item => item.code === 'selected_task_not_executable'))
})

test('local structure guard corrects a model that mistakes a role for one work task', () => {
  const intake = prepareLearningTaskIntakeEnvelope({
    rawInput: '风力发电运维工程师',
    modelAssessment: {
      schemaVersion: 'learning-task-intake-model.v1',
      model: 'deepseek-chat',
      assessedKind: 'work_task',
      confidence: 0.73,
      rationale: '误把岗位中的运维识别为动作。',
      nextQuestion: '',
    },
  })
  assert.equal(intake.inputKind, 'role')
  assert.equal(intake.status, 'needs_task_selection')
  assert.ok(intake.warnings.some(item => item.code === 'model_task_kind_corrected'))
})

test('semantic preflight restores the host-owned original input and local anchor checks still reject domain replacement', () => {
  const result = parseLearningTaskPreflightResult(JSON.stringify({
    schema_version: 'learning-task-intake-model.v1',
    original_input: 'RAG知识库开发',
    input_kind: 'work_task',
    role_name: '',
    selected_task: { title: 'RAG知识库开发', description: '错误替换。' },
    candidate_tasks: [],
    confidence: 0.99,
    rationale: '错误替换。',
    next_question: '',
  }), 'Linux系统开发')
  assert.equal(result.original_input, 'Linux系统开发')
  const intake = prepareLearningTaskIntakeEnvelope(preflightResultToIntakeInput(
    result,
    'Linux系统开发',
    'deepseek-chat',
  ))
  assert.equal(intake.status, 'needs_task_selection')
  assert.equal(intake.originalInput, 'Linux系统开发')
  assert.doesNotMatch(JSON.stringify(intake.taskContract), /RAG/)
})

test('semantic preflight cannot choose a task on behalf of a broad direction', () => {
  assert.throws(() => parseLearningTaskPreflightResult(JSON.stringify({
    schema_version: 'learning-task-intake-model.v1',
    original_input: '我想学计算机网络',
    input_kind: 'learning_topic',
    role_name: '',
    selected_task: { title: '交换机 VLAN 配置与验收', description: '不应自动选中。' },
    candidate_tasks: [],
    confidence: 0.8,
    rationale: '学习主题。',
    next_question: '',
  }), '我想学计算机网络'), /selection_invalid/)
})
