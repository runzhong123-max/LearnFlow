"""Predeclared synthetic stress cases; never writes a production database."""
from datetime import timedelta
import random
import run_ablation as v1


async def make_fixture(path, seeds):
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
    from app.models.learning import (AgentSession, EvidenceEvent, KernelMutation, MemoryNode,
        MemoryFact, MemoryModule, MemoryClaim, MemoryEdge, MemoryArchive)
    from app.models.project import Roadmap, Checkpoint
    fixture = await v1.make_fixture(path, seeds)
    meta, cases, counts = fixture['nodes'], fixture['cases'], fixture['counts']
    for c in cases:
        c.update(cohort='known_family', history_size=0, forbidden=[])
    engine = create_async_engine(f'sqlite+aiosqlite:///{path}')
    async with async_sessionmaker(engine, expire_on_commit=False)() as db:
        for index, seed in enumerate(seeds):
            learner, project, session = index+1, 2*index+1, index+1
            other_session = 1000+learner
            db.add(AgentSession(id=other_session, learner_id=learner, project_id=project, session_type='project'))
            db.add(Roadmap(id=1000+learner, project_id=project, raw_json={}))
            await db.flush()
            for k in (1,2):
                db.add(Checkpoint(id=10000+learner*10+k, roadmap_id=1000+learner, title=f'checkpoint {k}', order=k))
            await db.flush()
            cp, other_cp = 10000+learner*10+1, 10000+learner*10+2
            ordinal=0
            history_size=(256,1024,4096)[index%3]
            rng=random.Random(seed)
            unique=f'样本{seed}'

            def fact(key, body, *, subject=None, kernel='knowledge', age=10, grade='observed',
                     status='active', checkpoint=None, sid=session, pid=project,
                     expiry=None, sensitive=False, salience=.45, padding=''):
                nonlocal ordinal
                ordinal+=1; nid=1_000_000+(index+1)*100_000+ordinal
                subject=subject or f'topic:{unique}-{key}'
                stamp=v1.NOW-timedelta(days=age,seconds=ordinal)
                text=body+padding
                db.add(EvidenceEvent(id=nid,learner_id=learner,project_id=pid,checkpoint_id=checkpoint,
                    session_id=sid,event_type='synthetic_projection_fixture',source='fixture',
                    payload={'statement':text},provenance={'synthetic':True},occurred_at=stamp,
                    created_at=stamp,learner_seq=10000+ordinal))
                db.add(KernelMutation(id=nid,learner_id=learner,event_id=nid,kernel_name=kernel,patch={'fixture':True}))
                db.add(MemoryNode(id=nid,learner_id=learner,project_id=pid,checkpoint_id=checkpoint,session_id=sid,
                    node_type='fact',kernel_name=kernel,subject_key=subject,subject_type=subject.split(':')[0],
                    subject_id=subject.split(':',1)[-1],text=text,payload={'key':'answer' if sensitive else key},
                    occurred_at=stamp,created_at=stamp,status=status,valid_to=expiry,salience=salience))
                db.add(MemoryFact(node_id=nid,source_event_id=nid,source_mutation_id=nid,fact_ordinal=0,
                    predicate='long_term.'+key,object_value=text,evidence_grade=grade,project_id=pid,
                    checkpoint_id=checkpoint,session_id=sid))
                meta[str(nid)]={'learner_id':learner,'project_id':pid,'checkpoint_id':checkpoint,'session_id':sid,
                    'kernel':kernel,'node_type':'fact','grade':grade,'status':status,'sensitive':sensitive,
                    'expires_at':expiry.isoformat() if expiry else None,'units':{f'{seed}:v2-{key}':body}}
                counts['facts']+=1
                return nid

            def edge(a,b,relation='BLOCKS',age=0):
                db.add(MemoryEdge(learner_id=learner,source_node_id=a,target_node_id=b,relation_type=relation,
                                  created_at=v1.NOW-timedelta(days=age),origin='deterministic'))
                counts['edges']+=1

            def summary(key, subject, sources, body=None, status='active'):
                nonlocal ordinal
                units={k:v for n in sources for k,v in meta[str(n)]['units'].items()}
                text=body or '；'.join(units.values())
                ordinal+=1; mid=1_000_000+(index+1)*100_000+ordinal
                ordinal+=1; cid=1_000_000+(index+1)*100_000+ordinal
                for nid,kind in ((mid,'module'),(cid,'claim')):
                    db.add(MemoryNode(id=nid,learner_id=learner,project_id=project,session_id=session,
                        node_type=kind,kernel_name='knowledge',subject_key=subject,subject_type='topic',subject_id=key,
                        text=text,payload={},occurred_at=v1.NOW,status=status,salience=.6))
                    meta[str(nid)]={'learner_id':learner,'project_id':project,'session_id':session,'kernel':'knowledge',
                        'node_type':kind,'status':status,'sensitive':False,'units':units}
                db.add(MemoryModule(node_id=mid,summary=text,time_start=v1.NOW-timedelta(days=20),time_end=v1.NOW,
                    input_fingerprint=f'v2-{seed}-{key}',evidence_fact_ids=sources,delta_fact_ids=sources))
                db.add(MemoryClaim(node_id=cid,module_node_id=mid,claim_ordinal=0,predicate='exposure',verification_status='self_reported'))
                for src in sources:
                    edge(src,mid,'CONSOLIDATED_INTO');edge(src,cid,'SUPPORTS')
                counts['modules']+=1;counts['claims']+=1
                return mid,cid

            def case(family, query, sources=(), *, subjects=(), forbidden=(), checkpoint=None,
                     sid=session, hour=0, adaptation=None):
                required=list(dict.fromkeys(k for nid in sources for k in meta[str(nid)]['units']))
                cases.append({'id':f'{seed}-{family}','trajectory':seed,'family':family,'cohort':'expanded_stress',
                    'history_size':history_size,'learner_id':learner,'project_id':project,'checkpoint_id':checkpoint,
                    'session_id':sid,'query':query,'subject_keys':list(subjects),'policy':'project_tutor',
                    'required':required,'at':(v1.NOW+timedelta(hours=hour)).isoformat(),
                    'adaptation':adaptation,'forbidden':list(forbidden)})

            f=fact('precise',f'{unique}振荡器的温漂补偿仍需重新标定。',subject='topic:oscillator')
            case('no_subject_precise','振荡器温漂补偿',[f])
            f=fact('casefold',f'{unique}: Spectrometer ultraviolet calibration remains unverified.',subject='topic:instrument')
            case('english_casefold','SPECTROMETER ULTRAVIOLET',[f])
            f=fact('synonym',f'{unique}多版本并发控制的快照可见性需要验证。',subject='topic:database-isolation')
            case('synonym_without_subject','MVCC snapshot visibility',[f])
            f=fact('typo',f'{unique}: semaphore fairness remains unverified.',subject='topic:concurrency')
            case('typo_without_subject','semaphroe fairnes',[f])
            a=fact('cross_a',f'{unique}部署目标是先完成端口配置。')
            b=fact('cross_b',f'{unique}验证约束是必须使用隔离测试库。')
            case('multi_subject','同时核对部署目标与验证约束',[a,b],subjects=[f'topic:{unique}-cross_a',f'topic:{unique}-cross_b'])
            subj=f'topic:{unique}-attempts'
            a=fact('assisted_session',f'{unique}第一会话获得步骤提示后通过，不能视为独立。',subject=subj,age=40)
            b=fact('independent_session',f'{unique}第二会话在不同输入上无提示通过。',subject=subj,sid=other_session,grade='verified')
            case('cross_session_attempts','两次尝试的辅助条件分别是什么',[a,b],subjects=[subj])
            subj=f'topic:{unique}-goal-chain'
            old=fact('goal_v1',f'{unique}历史目标一：做理论综述。',subject=subj,kernel='value',status='superseded',age=60)
            middle=fact('goal_v2',f'{unique}历史目标二：做离线原型。',subject=subj,kernel='value',status='superseded',age=30)
            current=fact('goal_v3',f'{unique}当前目标三：做可运行服务。',subject=subj,kernel='value',grade='corrected',age=1)
            edge(current,middle,'SUPERSEDES');edge(middle,old,'SUPERSEDES')
            case('multiple_goal_revisions','当前确认的目标是什么',[current],subjects=[subj])
            subj=f'topic:{unique}-details'
            a=fact('constraint',f'{unique}通过只适用于单线程输入；并发场景尚未验证。',subject=subj)
            summary('details',subj,[a],body=f'{unique}存在一次受约束的通过记录。')
            case('summary_detail_exception','通过记录适用什么条件，还有什么未验证',[a],subjects=[subj])
            f=fact('long_body','过程说明。'*230+f'{unique}最后的关键结论是必须检验溢出。')
            # Gold is the decision-bearing suffix, not the long filler prefix.
            meta[str(f)]['units']={f'{seed}:v2-long_body':f'{unique}最后的关键结论是必须检验溢出。'}
            case('long_body_tail','最后的溢出结论',[f],subjects=[f'topic:{unique}-long_body'])
            root=fact('one_root',f'{unique}当前返回点是仪器联调。',kernel='structure')
            near=fact('one_near',f'{unique}继续前必须先检查供电稳压。',subject='topic:electrical')
            far=fact('two_far',f'{unique}稳压检查之前还需确认接地连续性。',subject='topic:ground')
            edge(near,root);edge(far,near)
            case('one_hop_return','返回仪器联调前的直接阻碍',[root,near],subjects=[f'topic:{unique}-one_root'])
            case('two_hop_dependency','联调前沿前置条件追溯到接地检查',[root,near,far],subjects=[f'topic:{unique}-one_root'])
            root=fact('dense_root',f'{unique}密集依赖入口。',kernel='structure')
            wanted=fact('dense_old',f'{unique}旧依赖中仍有效的必要条件是基准源校验。',subject='topic:reference',age=500,salience=.1)
            edge(wanted,root,age=400)
            for j in range(95):
                n=fact(f'dense_noise{j}',f'{unique}非必要关联条件 {j}。',subject='topic:unrelated-condition')
                edge(n,root,age=0)
            case('dense_edge_window','入口需要哪条基准源条件',[root,wanted],subjects=[f'topic:{unique}-dense_root'])
            rare=fact('rare_old',f'{unique}: quartz resonator cryogenic drift remains unresolved.',subject='topic:measurement',age=900,salience=.05)
            same=fact('same_old',f'{unique}测量历史中最初记录的待办必须保留。',subject='topic:measurement',age=900,salience=.05)
            for j in range(history_size):
                fact(f'history{j}',f'{unique}测量历史 ordinary measurement record {j}。',subject='topic:measurement',age=rng.random(),salience=.6)
            case('large_history_rare','quartz resonator cryogenic',[rare])
            case('large_history_same_terms','测量历史',[same],subjects=['topic:measurement'])
            a=fact('checkpoint_ok',f'{unique}本关允许引用的检查清单。',checkpoint=cp)
            forbidden=f'{unique}另一关私有检查内容不可出现。'
            fact('checkpoint_bad',forbidden,checkpoint=other_cp,subject=f'topic:{unique}-checkpoint_ok',salience=1)
            case('checkpoint_isolation','本关检查清单',[a],subjects=[f'topic:{unique}-checkpoint_ok'],forbidden=[forbidden],checkpoint=cp)
            subj=f'topic:{unique}-archived'
            banned=f'{unique}已归档的计时偏差旧记录。'
            a=fact('archive_probe',banned,subject=subj)
            summary('archived',subj,[a])
            db.add(MemoryArchive(learner_id=learner,kernel_name='knowledge',memory_scope='long_term',memory_key='archive_probe',status='archived'))
            # Archive matching uses the production Fact projection payload.
            await db.flush()
            (await db.get(MemoryNode,a)).payload={'key':'archive_probe','scope':'long_term'}
            case('archive_descendants','计时偏差旧记录',subjects=[subj],forbidden=[banned])
            root=fact('expiry_root',f'{unique}当前有效的测量入口。',kernel='structure')
            banned=f'{unique}已经过期的临时校准要求。'
            expired=fact('expired',banned,expiry=v1.NOW-timedelta(hours=1))
            edge(expired,root)
            case('expired_relation','读取当前入口与有效条件',[root],subjects=[f'topic:{unique}-expiry_root'],forbidden=[banned])
            banned=f'{unique}隐藏评分答案不允许进入上下文。'
            fact('concept_answer',banned,subject=f'concept:private-{seed}',sensitive=True)
            human=f'{unique}私密人因原文不允许进入上下文。'
            fact('concept_human',human,subject=f'concept:private-{seed}',kernel='human')
            case('concept_attachment_private','隐藏评分答案与私密人因',subjects=[f'concept:private-{seed}'],forbidden=[banned,human])
            case('uncovered_zero_terms','xylophoniczzq')
            case('uncovered_generic_terms','此前的星际航行学习记录是什么')
            case('human_other_session','当前教学节奏',sid=other_session,adaptation='none')
            for c in cases:
                if c['trajectory']==seed:
                    c['history_size']=history_size
        await db.commit()
    await engine.dispose()
    fixture['version']='expanded-fixture.v2.0'
    return fixture
