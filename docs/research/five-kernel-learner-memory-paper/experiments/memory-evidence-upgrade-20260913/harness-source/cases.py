"""Predeclared business interactions, not an empirical long-tail sample."""
import json
from pathlib import Path


def at(day,hour=11,minute=0):return f'2026-09-{day:02}T{hour:02}:{minute:02}:00Z'
def step(name,op,day=1,**kw):return {'id':name,'op':op,'at':at(day),**kw}
def eq(path,value):return {'path':path,'op':'eq','value':value}
def has(path,value):return {'path':path,'op':'contains','value':value}
def absent(path):return {'path':path,'op':'absent','value':None}


def cases():
    out=[]
    def add(name,steps,checks,*,variant=False,day=2,purpose='contract'):
        out.append({'case_id':name,'at':at(day,12),'variant':variant,'steps':steps,'assertions':checks,'purpose':purpose})
    grade=lambda:step('grade','grade',correct=True,assistance='none')
    review=lambda name,day,**kw:step(name,'review',day,correct=True,assistance='none',**kw)
    L='/lens/';P='/observation/plan/';C='/observation/compiled/'
    add('path_lifecycle',[
        step('confirm','path_commit',revision=1),step('replay','replay',request_from='confirm'),
        step('revise','path_commit',8,revision=2),step('archive','path_archive',22)],
        [eq(L+'path_revision',2),eq(L+'path_status','archived'),eq(L+'goal_status','archived'),
         has(L+'goal_statement','含消融实验'),eq(L+'path_events',['vnext_learning_path_plan_committed','vnext_learning_path_plan_revised','vnext_learning_path_plan_archived']),
         eq('/steps/replay/new_event_count',0),eq('/observation/path_overlay/active_plan_id',None)],day=22)
    add('assessment_creates_schedule',[grade()],
        [eq(L+'schedule_count',1),eq(L+'attempt_count',1),eq(L+'last_grade','good'),eq(L+'current_evidence','verified_once'),eq(L+'stable_eligible',False),eq(L+'long_stable',False)])
    add('due_without_learning',[grade(),step('due','read',22)],
        [eq(L+'attempt_count',1),eq(L+'review_count',0),eq(L+'bucket','overdue'),eq(L+'long_stable',False),eq('/steps/due/new_event_count',0)],day=22)
    add('defer_is_not_evidence',[grade(),step('defer','defer',8),step('repeat','replay',8,request_from='defer')],
        [eq(L+'attempt_count',1),eq(L+'defer_count',1),eq('/steps/repeat/new_event_count',0),eq('/steps/repeat/response/idempotent_replay',True),eq(L+'long_stable',False),eq(L+'defer_moves_one_day',True)],day=8)
    add('assisted_review',[grade(),step('review','review',8,correct=True,assistance='hint')],
        [eq(L+'review_forms',['original']),eq(L+'review_independent',[False]),eq(L+'retention','retrieved_with_support'),eq(L+'last_grade','hard'),eq(L+'long_stable',False),has(L+'plan_actions','fade_support_then_independent_probe')],day=8)
    add('independent_original',[grade(),review('review',8)],
        [eq(L+'review_forms',['original']),eq(L+'review_independent',[True]),eq(L+'retention','retrieved'),eq(L+'long_stable',False),has(L+'plan_actions','independent_variant_or_reasoning_check')],day=8)
    add('independent_variant',[grade(),review('review',8)],
        [eq(L+'review_forms',['validated_variant']),eq(L+'retention','retrieved'),eq(L+'last_grade','easy'),eq(L+'stable_eligible',False),eq(L+'long_stable',False)],variant=True,day=8)
    add('spaced_original_is_not_stable',[grade(),review('r1',8),review('r2',22)],
        [eq(L+'review_forms',['original','original']),eq(L+'stable_eligible',False),eq(L+'long_stable',False),eq(L+'retention','retrieved')],day=22)
    add('spaced_variant_contract',[grade(),review('r1',8),review('r2',22)],
        [eq(L+'review_forms',['validated_variant','original']),eq(L+'stable_eligible',True),eq(L+'long_stable',True),eq(L+'retention','spaced_stable'),eq(L+'current_evidence','spaced_stable'),eq(L+'stable_source_coverage',True)],variant=True,day=22)
    add('nonresponse_and_idempotence',[grade(),step('missing','review',8,response_status='answered',empty=True,expected_http=422),
        step('skip','review',8,response_status='skipped'),step('skip_replay','replay',8,request_from='skip'),
        step('unknown','review',8,response_status='unknown')],
        [eq('/steps/missing/new_attempt_count',0),eq('/steps/missing/http_status',422),eq('/steps/skip/new_attempt_count',0),
         eq('/steps/skip_replay/new_event_count',0),eq('/steps/unknown/response/outcome','unknown'),eq(L+'last_attempt_status','abstained'),eq(L+'retention','retrieval_gap'),eq(L+'long_stable',False)],day=8)
    add('review_submission_replay',[grade(),review('review',8),step('replay','replay',8,request_from='review')],
        [eq(L+'attempt_count',2),eq(L+'review_count',1),eq('/steps/replay/new_attempt_count',0),eq('/steps/replay/new_event_count',0),eq('/steps/replay/response/idempotent_replay',True)],day=8)
    for active in (True,False):
        controls_day=22 if active else 1
        name='cross_week_current_support' if active else 'cross_week_expired_support'
        ops=[step('path','path_commit',revision=1),grade(),step('old_anchor','control',text='先回到递归基础定义。'),
             review('review',8),step('revise','path_commit',21,revision=2),
             step('time','control',controls_day,text='本次只有25分钟。'),
             {**step('support','control',controls_day,text='请拆成小步，每次只处理一个问题。'),'at':at(controls_day,11,20)},
             {**step('priority','control',22,text='本次优先：检索与复习边界分析。'),'at':at(22,11,40)}]
        ops.sort(key=lambda s:(s['at'], {'path':0,'grade':1}.get(s['id'],2)))
        assertions=[eq(L+'path_revision',2),has(L+'goal_statement','含消融实验'),has(C+'current_priority','检索与复习边界分析'),
                    absent(C+'return_anchor'),eq(P+'estimated_minutes',20 if active else 35)]
        assertions+=[eq(C+'small_steps',True)] if active else [absent(C+'small_steps'),absent(C+'max_minutes')]
        add(name,ops,assertions,variant=True,day=22,purpose='authored_boundary_challenge')
    add('relapse_invalidates_current_stability',[grade(),review('r1',8),review('r2',22),
        step('relapse','review',29,correct=False,assistance='none')],
        [eq(L+'stable_eligible',False),eq(L+'current_evidence','none'),eq(L+'retention','needs_review'),
         eq(L+'long_stable',False)],variant=True,day=29,purpose='authored_safety_challenge')
    return out


if __name__=='__main__':Path(__file__).with_name('cases.json').write_text(json.dumps(cases(),ensure_ascii=False,indent=2)+'\n')
