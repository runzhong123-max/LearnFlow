import test from 'node:test'
import assert from 'node:assert/strict'
import { conversionMessagePresentation } from './presentation.ts'

test('handoff transcript is readable while original structured provider context remains lossless',()=>{
  const context = {schema_version:'learnflow.work-task-conversion.v1',root_hash:'private-machine-ref',brief:{task_title:'库存数据导入',work_context:'仓库',deliverable:'报告',acceptance_criteria:['重复输入结果一致'],constraints:['离线']},candidate:{learning_candidate:{task:{steps:[{id:'s1',title:'清洗数据',action:'核对异常记录'}]}}},source_refs:[{type:'role_task',role_title:'数据工程师',package_ref:{packageVersion:'1.2',rootHash:'fixed-hash'},task_ref:{label:'导入数据'}}]}
  const original=JSON.stringify(context)
  const display=conversionMessagePresentation(context)!
  assert.match(display,/清洗数据/);assert.match(display,/重复输入结果一致/);assert.match(display,/岗位包 1.2/)
  assert.doesNotMatch(display,/root_hash|fixed-hash|private-machine-ref|"steps"/)
  assert.equal(JSON.stringify(context),original)
  assert.equal(conversionMessagePresentation({schema_version:'other',brief:{},candidate:{}}),undefined)
})
