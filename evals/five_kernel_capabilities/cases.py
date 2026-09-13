"""Predeclared examples and invariants; no imports from product decision code."""
import json
from pathlib import Path


def control(text, hour=11, minute=0, name='input'):
    return {'id': name, 'op': 'control', 'at': f'2026-09-01T{hour:02}:{minute:02}:00Z', 'text': text}


def check(path, op, value=None):
    return {'path': path, 'op': op, 'value': value}


def cases():
    rows=[]
    def add(kernel, name, steps, assertions):
        rows.append({'case_id':kernel+'-'+name,'kernel':kernel,'at':'2026-09-01T12:00:00Z',
                     'steps':steps,'assertions':assertions})
    eq=lambda p,v:check(p,'eq',v)
    has=lambda p,v:check(p,'contains',v)
    absent=lambda p:check(p,'absent')
    C='/observation/compiled/'
    P='/observation/plan/'
    add('structure','anchor_active',[control('先回到递归基础定义。')],
        [has(C+'return_anchor','递归基础定义'),has(P+'phases/0/purpose','递归基础定义')])
    add('structure','anchor_expired',[control('先回到递归基础定义。',hour=3)],
        [absent(C+'return_anchor'),check(P+'phases/0/purpose','not_contains','递归基础定义')])
    add('structure','path_confirmed',[{'id':'confirm','op':'path_commit','at':'2026-09-01T11:00:00Z','revision':1}],
        [eq('/observation/path_overlay/active_plan_id','capability-path'),
         eq('/lens/path_status','active'),eq('/lens/goal_status','confirmed'),eq('/lens/path_revision',1),
         eq('/lens/route',['python-programming','machine-learning','agent-engineering']),
         has('/lens/learning_plan_packet_text','capability-path')])
    gap='我不懂递归的终止条件。'
    gap_step={'id':'gap','op':'gap','text':gap,'at':'2026-09-01T11:00:00Z'}
    add('knowledge','gap',[gap_step],[eq(C+'blocker','current_gap'),has(C+'blocker_detail',gap),
                                  eq('/lens/knowledge_gap_fact',gap)])
    add('knowledge','resolved',[gap_step,control('这个问题已经解决了',minute=40,name='resolve')],
        [eq(C+'blocker','resolved'),has('/lens/actions','verify_reported_resolution'),
         check(P+'phases/0/purpose','not_contains',gap)])
    def grade(name='answer',correct=True,assistance='none',minute=0):
        return {'id':name,'op':'grade','at':f'2026-09-01T11:{minute:02}:00Z','item':'q1',
                'correct':correct,'assistance':assistance}
    add('knowledge','evaluated_error',[grade(correct=False)],
        [eq('/lens/concept_statuses',['needs_review']),eq(C+'practice_feedback','evaluated_error'),
         eq('/lens/grade_correct',[False]),eq('/lens/grade_human_value_mutations',0)])
    add('human','minutes',[control('本次只有8分钟。')],
        [eq(C+'max_minutes',8),eq(P+'estimated_minutes',8)])
    add('human','support_cap',[control('本次只有25分钟。'),control('请拆成小步，每次只处理一个问题。',minute=40,name='support')],
        [eq(C+'max_minutes',20),eq(C+'small_steps',True),eq(P+'estimated_minutes',20),
         eq(P+'phases/2/required',True),has(P+'phases/2/purpose','无提示独立')])
    add('human','expired',[control('本次只有8分钟。',hour=3),control('请拆成小步，每次只处理一个问题。',hour=3,minute=1,name='support')],
        [absent(C+'max_minutes'),absent(C+'small_steps'),eq(P+'estimated_minutes',35)])
    add('value','priority_updated',[control('本次优先：递归基础定义。'),control('本次优先：递归边界分析。',minute=40,name='update')],
        [has(C+'current_priority','递归边界分析'),has(P+'summary','递归边界分析'),
         check(C+'current_priority','not_contains','递归基础定义')])
    add('value','priority_expired',[control('本次优先：递归边界分析。',hour=3)],
        [absent(C+'current_priority'),check(P+'summary','not_contains','递归边界分析')])
    add('value','goal_lifecycle',[
        {'id':'confirm','op':'path_commit','at':'2026-09-01T11:00:00Z','revision':1},
        {'id':'revise','op':'path_commit','at':'2026-09-01T11:20:00Z','revision':2},
        {'id':'archive','op':'path_archive','at':'2026-09-01T11:40:00Z'}],
        [eq('/lens/path_status','archived'),eq('/lens/goal_status','archived'),eq('/lens/path_revision',2),
         eq('/observation/path_overlay/active_plan_id',None),
         eq('/lens/path_event_types',['vnext_learning_path_plan_committed','vnext_learning_path_plan_revised','vnext_learning_path_plan_archived']),
         eq('/lens/intermediate_goal_statuses',['confirmed','confirmed','archived']),
         has('/observation/projection/value/long_term/confirmed_goals/path-plan:capability-path/statement','含消融实验'),
         has('/receipts/1/projection_after/value/long_term/confirmed_goals/path-plan:capability-path/statement','含消融实验')])
    add('practice','supported',[grade(assistance='hint')],
        [eq('/lens/concept_statuses',['correct_with_support']),eq(C+'practice_feedback','supported_success'),
         eq('/lens/grade_independent',[False]),has('/lens/actions','fade_support_then_independent_probe')])
    add('practice','independent',[grade()],
        [eq('/lens/concept_statuses',['verified_once']),eq(C+'practice_feedback','independent_success'),
         eq('/lens/grade_independent',[True]),has('/lens/actions','independent_variant_or_reasoning_check')])
    add('practice','retry',[grade(),grade(name='retry',minute=40)],
        [eq('/lens/concept_statuses',['correct_with_support']),eq(C+'practice_feedback','supported_success'),
         eq('/lens/grade_independent',[True,False]),eq('/lens/grade_assistance',['none','guided']),
         eq('/lens/attempt_roles',['original','retry']),has('/lens/actions','fade_support_then_independent_probe')])
    for row in rows:
        for assertion in list(row['assertions']):
            if assertion['path']=='/lens/actions':
                row['assertions'].append({**assertion,'path':'/lens/plan_actions'})
    actual_preparation={
        'knowledge-resolved':('0','当前卡点已由学生自述解决'),
        'knowledge-evaluated_error':('1','先定位第一个错误步骤'),
        'practice-supported':('1','先逐步撤除提示'),
        'practice-independent':('1','无提示小变式或解释理由'),
        'practice-retry':('1','先逐步撤除提示'),
    }
    for row in rows:
        if row['case_id'] in actual_preparation:
            index,phrase=actual_preparation[row['case_id']]
            row['assertions'].append(has(P+'phases/'+index+'/purpose',phrase))
    return rows


if __name__=='__main__':
    Path(__file__).with_name('cases.json').write_text(json.dumps(cases(),ensure_ascii=False,indent=2)+'\n')
