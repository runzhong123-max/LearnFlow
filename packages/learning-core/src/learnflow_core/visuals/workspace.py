"""Learner-private visual jobs and immutable revisions, independent of mastery.

All writes are scoped and transactional. User-provided publication statuses never
replace server compilation. Product operations emit zero-target EvidenceEvent audit;
view state and generated content are not mastery evidence.
"""
from __future__ import annotations

import copy
from datetime import datetime, timezone
import json
from uuid import uuid4
from sqlalchemy import Column, DateTime, ForeignKey, Integer, JSON, String, Text, UniqueConstraint, select, update
from sqlalchemy.exc import IntegrityError
from starlette.concurrency import run_in_threadpool
from app.db.database import Base, async_session
from .engine import compile_visual, digest
from .catalog import read_template, _terms
from .svg_story import compile_svg_story


def now(): return datetime.now(timezone.utc)
def uid(): return str(uuid4())


class VisualJob(Base):
    __tablename__ = 'visual_workspace_jobs'
    __table_args__ = (UniqueConstraint('learner_id', 'request_id', name='uq_visual_job_request'),)
    id = Column(String(36), primary_key=True, default=uid)
    learner_id = Column(Integer, ForeignKey('learners.id', ondelete='CASCADE'), nullable=False, index=True)
    project_id = Column(Integer, ForeignKey('projects.id', ondelete='SET NULL'), nullable=True)
    session_id = Column(Integer, ForeignKey('agent_sessions.id', ondelete='SET NULL'), nullable=True)
    request_id = Column(String(160), nullable=False)
    request_digest = Column(String(64), nullable=False)
    request = Column(Text, nullable=False)
    kind = Column(String(20), nullable=False)
    source_mode = Column(String(20), nullable=False)
    base_revision_id = Column(String(36), nullable=True)
    version = Column(Integer, nullable=False, default=1)
    status = Column(String(20), nullable=False, default='running')
    stage = Column(String(80), nullable=False, default='created')
    candidate = Column(JSON, nullable=True)
    diagnostics = Column(JSON, nullable=True)
    route = Column(JSON, nullable=True)
    artifact = Column(JSON, nullable=True)
    publish_digest = Column(String(64), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=now)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=now)


class VisualArtifact(Base):
    __tablename__ = 'visual_workspace_artifacts'
    id = Column(String(36), primary_key=True, default=uid)
    learner_id = Column(Integer, ForeignKey('learners.id', ondelete='CASCADE'), nullable=False, index=True)
    title = Column(String(240), nullable=False)
    kind = Column(String(20), nullable=False)
    latest_revision_id = Column(String(36), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=now)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=now)


class VisualRevision(Base):
    __tablename__ = 'visual_workspace_revisions'
    id = Column(String(36), primary_key=True, default=uid)
    artifact_id = Column(String(36), ForeignKey('visual_workspace_artifacts.id', ondelete='CASCADE'), nullable=False, index=True)
    learner_id = Column(Integer, ForeignKey('learners.id', ondelete='CASCADE'), nullable=False, index=True)
    job_id = Column(String(36), ForeignKey('visual_workspace_jobs.id'), nullable=False, unique=True)
    builder = Column(String(30), nullable=False)
    title = Column(String(240), nullable=False)
    kind = Column(String(20), nullable=False)
    source_mode = Column(String(20), nullable=False)
    parent_revision_id = Column(String(36), nullable=True)
    source = Column(JSON, nullable=False)
    source_digest = Column(String(64), nullable=False)
    template_ref = Column(JSON, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=now)


class VisualRun(Base):
    __tablename__ = 'visual_workspace_runs'
    __table_args__ = (UniqueConstraint('learner_id', 'revision_id', 'input_digest', name='uq_visual_run_input'),)
    id = Column(String(36), primary_key=True, default=uid)
    learner_id = Column(Integer, ForeignKey('learners.id', ondelete='CASCADE'), nullable=False, index=True)
    revision_id = Column(String(36), ForeignKey('visual_workspace_revisions.id', ondelete='CASCADE'), nullable=False, index=True)
    input_digest = Column(String(64), nullable=False)
    params = Column(JSON, nullable=False)
    compiled = Column(JSON, nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, default=now)


class VisualViewState(Base):
    __tablename__ = 'visual_workspace_views'
    __table_args__ = (UniqueConstraint('learner_id', 'revision_id', 'run_id', name='uq_visual_view_run'),)
    id = Column(String(36), primary_key=True, default=uid)
    learner_id = Column(Integer, ForeignKey('learners.id', ondelete='CASCADE'), nullable=False, index=True)
    revision_id = Column(String(36), ForeignKey('visual_workspace_revisions.id', ondelete='CASCADE'), nullable=False)
    run_id = Column(String(36), ForeignKey('visual_workspace_runs.id', ondelete='CASCADE'), nullable=False)
    state = Column(JSON, nullable=False)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=now)


class VisualWorkspaceAudit(Base):
    __tablename__ = 'visual_workspace_audit'
    __table_args__ = (UniqueConstraint('learner_id', 'dedupe_key', name='uq_visual_audit_dedupe'),)
    id = Column(String(36), primary_key=True, default=uid)
    learner_id = Column(Integer, ForeignKey('learners.id', ondelete='CASCADE'), nullable=False, index=True)
    operation = Column(String(30), nullable=False)
    job_id = Column(String(36), nullable=True)
    revision_id = Column(String(36), nullable=True)
    run_id = Column(String(36), nullable=True)
    dedupe_key = Column(String(64), nullable=False)
    detail = Column(JSON, nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, default=now)


class WorkspaceError(ValueError):
    def __init__(self, detail, status=422):
        super().__init__(detail); self.status = status


def require(ok, detail, status=422):
    if not ok: raise WorkspaceError(detail, status)


def bounded(value, name, maximum, minimum=0):
    require(isinstance(value, str) and minimum <= len(value) <= maximum, f'visual_workspace:{name}_invalid')
    return value


def json_budget(value, name, maximum):
    try: size = len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode())
    except (TypeError, ValueError, RecursionError): raise WorkspaceError(f'visual_workspace:{name}_invalid')
    require(size <= maximum, f'visual_workspace:{name}_budget')


def fields(payload, required, optional=()):
    require(isinstance(payload, dict) and set(required) <= set(payload) <= set(required) | set(optional), 'visual_workspace:invalid_fields')


def job_ref(job):
    return {'job_id':job.id,'version':job.version,'status':job.status,'stage':job.stage,'request':job.request,'kind':job.kind,'source_mode':job.source_mode,
            **{k:copy.deepcopy(getattr(job,k)) for k in ('base_revision_id','candidate','diagnostics','route','artifact','project_id','session_id') if getattr(job,k) is not None}}


def artifact_ref(revision, run):
    return {'artifact_id':revision.artifact_id,'revision_id':revision.id,'run_id':run.id,'builder':revision.builder,'title':revision.title,'kind':revision.kind,
            'verification':copy.deepcopy(run.compiled['verification']),'source_mode':revision.source_mode,
            **({'parent_revision_id':revision.parent_revision_id} if revision.parent_revision_id else {})}


async def owned(db, cls, learner_id, ident, field='id'):
    bounded(ident, field, 160, 1)
    row = (await db.execute(select(cls).where(getattr(cls,field)==ident, cls.learner_id==learner_id).execution_options(populate_existing=True))).scalar_one_or_none()
    require(row is not None, 'visual_workspace:not_found', 404)
    return row


async def validate_scope(db, learner_id, project_id=None, session_id=None):
    from app.models.project import Project
    from app.models.learning import AgentSession
    if project_id is not None:
        require(type(project_id) is int and project_id > 0, 'visual_workspace:project_id_invalid')
        project = await db.scalar(select(Project).where(Project.id==project_id,Project.learner_id==learner_id))
        require(project is not None, 'visual_workspace:scope_not_found', 404)
    if session_id is not None:
        require(type(session_id) is int and session_id > 0, 'visual_workspace:session_id_invalid')
        session = await db.scalar(select(AgentSession).where(AgentSession.id==session_id,AgentSession.learner_id==learner_id))
        require(session is not None, 'visual_workspace:scope_not_found', 404)
        require(project_id is None or session.session_type not in ('project','checkpoint') or session.project_id == project_id, 'visual_workspace:scope_mismatch', 409)


async def revision_scope(db, learner_id, revision):
    job = await owned(db, VisualJob, learner_id, revision.job_id)
    await validate_scope(db, learner_id, job.project_id, job.session_id)


async def choose_run(db, learner_id, revision, run_id=None):
    if run_id:
        run = await owned(db, VisualRun, learner_id, run_id)
        require(run.revision_id == revision.id, 'visual_workspace:run_revision_mismatch', 409)
        return run
    pin = await db.scalar(select(VisualViewState).where(VisualViewState.revision_id==revision.id,VisualViewState.learner_id==learner_id).order_by(VisualViewState.updated_at.desc()).limit(1))
    if pin:
        return await owned(db, VisualRun, learner_id, pin.run_id)
    run = await db.scalar(select(VisualRun).where(VisualRun.revision_id==revision.id,VisualRun.learner_id==learner_id).order_by(VisualRun.created_at.desc(),VisualRun.id.desc()).limit(1))
    require(run is not None, 'visual_workspace:run_not_found', 404)
    return run


def audit(db, learner_id, operation, key, detail, job_id=None, revision_id=None, run_id=None):
    row = VisualWorkspaceAudit(id=uid(),learner_id=learner_id,operation=operation,dedupe_key=digest(key),detail=detail,job_id=job_id,revision_id=revision_id,run_id=run_id)
    db.add(row); return row


async def record_workspace_event(db, learner_id, operation, result_id, *, job_id=None, revision_id=None, run_id=None):
    """Registered zero-target product evidence, atomically with its own record."""
    from app.services.learning_runtime import record_event
    if job_id is None and revision_id is not None:
        revision = await owned(db, VisualRevision, learner_id, revision_id)
        job_id = revision.job_id
    job = await owned(db, VisualJob, learner_id, job_id)
    await validate_scope(db, learner_id, job.project_id, job.session_id)
    payload = {'operation': operation, **{key:value for key,value in {'job_id':job_id,'revision_id':revision_id,'run_id':run_id}.items() if value is not None}}
    await record_event(db, learner_id=learner_id, project_id=job.project_id, session_id=job.session_id, event_type='visual_workspace_changed', source='visual_workspace', payload=payload,
                       provenance={'tool':'visual_artifact_workspace','plugin':'educational_visuals','policy':'visual-workspace.v1'},
                       client_event_id=f'visual-workspace:{operation}:{result_id}')


async def compiled(builder, source, params, kind, learner_id, template_ref=None):
    require(builder in ('visual_spec','svg_story'), 'visual_workspace:builder_invalid')
    require(isinstance(source, dict), 'visual_workspace:source_invalid')
    require(isinstance(params, dict), 'visual_workspace:params_invalid')
    json_budget(source,'source',262144 if builder=='visual_spec' else 131072)
    if builder == 'visual_spec':
        bundle = await run_in_threadpool(compile_visual, source, params)
        if kind == 'animation':
            frames = bundle['frames']
            signatures = {digest({key:value for key,value in f['state'].items() if key not in {'step','stage_id','title','narration','authored_note','phase'}}) for f in frames}
            require(len(frames)>=2 and len(signatures)>=2, 'visual_workspace:animation_requires_changed_states')
        provenance = {'source':'generated'}
        if template_ref is not None:
            fields(template_ref, {'id','version'})
            recipe = await run_in_threadpool(read_template,template_ref['id'],template_ref['version'])
            provenance = {**recipe['provenance'],'source':'maintained_library' if digest(source)==recipe['provenance']['spec_digest'] else 'adapted_library'}
        return {**bundle,'source_provenance':provenance,'owner_scope':str(learner_id)}
    require(not params, 'visual_workspace:svg_story_has_no_numeric_parameters')
    require(template_ref is None, 'visual_workspace:svg_story_template_ref_invalid')
    return await run_in_threadpool(compile_svg_story,source,kind)


async def start_job(db, learner_id, p):
    fields(p,{'request_id','request','kind','source_mode'},{'base_revision_id','project_id','session_id'})
    bounded(p['request_id'],'request_id',160,1);bounded(p['request'],'request',12000,1)
    require(p['kind'] in ('diagram','animation'),'visual_workspace:kind_invalid')
    require(p['source_mode'] in ('auto','reuse','adapt','fresh'),'visual_workspace:source_mode_invalid')
    require(p['source_mode']!='fresh' or not p.get('base_revision_id'),'visual_workspace:fresh_cannot_reference_source')
    await validate_scope(db,learner_id,p.get('project_id'),p.get('session_id'))
    if p.get('base_revision_id'):
        base=await owned(db,VisualRevision,learner_id,p['base_revision_id']);await revision_scope(db,learner_id,base)
    fingerprint=digest(p)
    old=await db.scalar(select(VisualJob).where(VisualJob.learner_id==learner_id,VisualJob.request_id==p['request_id']))
    if old:
        require(old.request_digest==fingerprint,'visual_workspace:request_id_conflict',409);return job_ref(old)
    row=VisualJob(id=uid(),learner_id=learner_id,request_id=p['request_id'],request_digest=fingerprint,request=p['request'],kind=p['kind'],source_mode=p['source_mode'],
                  base_revision_id=p.get('base_revision_id'),project_id=p.get('project_id'),session_id=p.get('session_id'),version=1,status='running',stage='created')
    db.add(row)
    try:
        await db.flush();audit(db,learner_id,'start_job',[row.id,'start'],{'version':1},job_id=row.id);await db.commit()
    except IntegrityError:
        await db.rollback()
        old=await db.scalar(select(VisualJob).where(VisualJob.learner_id==learner_id,VisualJob.request_id==p['request_id']))
        require(old is not None and old.request_digest==fingerprint,'visual_workspace:request_id_conflict',409);return job_ref(old)
    return job_ref(row)


async def checkpoint(db,learner_id,p):
    fields(p,{'job_id','expected_version','stage','status'},{'candidate','diagnostics','route'})
    job=await owned(db,VisualJob,learner_id,p['job_id']);await validate_scope(db,learner_id,job.project_id,job.session_id)
    require(type(p['expected_version']) is int,'visual_workspace:version_invalid');bounded(p['stage'],'stage',80,1)
    require(p['status'] in ('running','paused'),'visual_workspace:status_invalid')
    for name,limit in [('candidate',150000),('diagnostics',16000),('route',32000)]:
        if name in p:json_budget(p[name],name,limit)
    require(job.status in ('running','paused'),'visual_workspace:job_terminal',409)
    changes={key:copy.deepcopy(p[key]) for key in ('stage','status','candidate','diagnostics','route') if key in p}
    changes.update(version=p['expected_version']+1,updated_at=now())
    result=await db.execute(update(VisualJob).where(VisualJob.id==job.id,VisualJob.learner_id==learner_id,VisualJob.version==p['expected_version'],VisualJob.status.in_(('running','paused'))).values(**changes).execution_options(synchronize_session=False))
    require(result.rowcount==1,'visual_workspace:version_conflict',409)
    audit(db,learner_id,'checkpoint',[job.id,changes['version']],{'version':changes['version'],'stage':p['stage'],'status':p['status']},job_id=job.id)
    await db.commit();return job_ref(await owned(db,VisualJob,learner_id,p['job_id']))


async def publish(db,learner_id,p):
    fields(p,{'job_id','expected_version','builder','source'},{'params','parent_revision_id','template_ref'})
    job=await owned(db,VisualJob,learner_id,p['job_id']);await validate_scope(db,learner_id,job.project_id,job.session_id)
    require(type(p['expected_version']) is int,'visual_workspace:version_invalid')
    fingerprint=digest({'builder':p['builder'],'source':p['source'],'params':p.get('params',{}),'parent_revision_id':p.get('parent_revision_id') or job.base_revision_id,'template_ref':p.get('template_ref')})
    if job.status=='published':
        require(job.publish_digest==fingerprint,'visual_workspace:publish_conflict',409);return copy.deepcopy(job.artifact)
    require(job.status in ('running','paused'),'visual_workspace:job_terminal',409)
    parent_id=p.get('parent_revision_id') or job.base_revision_id
    route=job.route if isinstance(job.route,dict) else {}
    source_mode=job.source_mode if job.source_mode!='auto' else route.get('source_mode','adapt' if parent_id or p.get('template_ref') else 'fresh')
    require(source_mode in ('reuse','adapt','fresh'),'visual_workspace:resolved_source_mode_required')
    require(source_mode!='fresh' or not (parent_id or p.get('template_ref')),'visual_workspace:fresh_cannot_reference_source')
    selected=route.get('source_ref')
    if isinstance(selected,dict) and selected.get('kind')=='revision':
        require(parent_id==selected.get('revision_id'),'visual_workspace:source_reference_conflict',409)
    if isinstance(selected,dict) and selected.get('kind')=='template':
        require(p.get('template_ref')=={key:selected.get(key) for key in ('id','version')},'visual_workspace:source_reference_conflict',409)
    require(not job.base_revision_id or parent_id==job.base_revision_id,'visual_workspace:parent_revision_conflict',409)
    parent=None
    if parent_id:
        parent=await owned(db,VisualRevision,learner_id,parent_id);await revision_scope(db,learner_id,parent)
    require(source_mode not in ('reuse','adapt') or parent is not None or p.get('template_ref') is not None,'visual_workspace:source_reference_required')
    if source_mode=='reuse' and parent:
        require(p['builder']==parent.builder and digest(p['source'])==parent.source_digest,'visual_workspace:reuse_requires_unchanged_source')
    result=await compiled(p['builder'],p['source'],p.get('params',{}),job.kind,learner_id,p.get('template_ref'))
    if source_mode=='reuse' and p.get('template_ref'):
        require(result.get('source_provenance',{}).get('source')=='maintained_library','visual_workspace:reuse_requires_unchanged_source')
    if parent and p['builder']=='visual_spec' and not p.get('template_ref'):
        result['source_provenance']={'source':'private_revision','revision_id':parent.id,'spec_digest':parent.source_digest}
    require(job.version==p['expected_version'],'visual_workspace:version_conflict',409)
    locked=await db.execute(update(VisualJob).where(VisualJob.id==job.id,VisualJob.learner_id==learner_id,VisualJob.version==p['expected_version'],VisualJob.status.in_(('running','paused'))).values(version=p['expected_version']+1,status='publishing',updated_at=now()).execution_options(synchronize_session=False))
    if locked.rowcount!=1:
        await db.rollback();current=await owned(db,VisualJob,learner_id,p['job_id'])
        if current.status=='published' and current.publish_digest==fingerprint:return copy.deepcopy(current.artifact)
        raise WorkspaceError('visual_workspace:version_conflict',409)
    if parent:
        artifact=await owned(db,VisualArtifact,learner_id,parent.artifact_id)
    else:
        artifact=VisualArtifact(id=uid(),learner_id=learner_id,title=p['source']['title'][:240],kind=job.kind);db.add(artifact);await db.flush()
    revision=VisualRevision(id=uid(),artifact_id=artifact.id,learner_id=learner_id,job_id=job.id,builder=p['builder'],title=p['source']['title'][:240],kind=job.kind,
                            source_mode=source_mode,parent_revision_id=parent_id,source=copy.deepcopy(p['source']),source_digest=digest(p['source']),template_ref=copy.deepcopy(p.get('template_ref')))
    db.add(revision);await db.flush()
    params=result.get('params',{})
    run=VisualRun(id=uid(),learner_id=learner_id,revision_id=revision.id,input_digest=digest({'params':params,'runtime':result['runtime_version']}),params=params,compiled=result)
    db.add(run);await db.flush();reference=artifact_ref(revision,run)
    artifact.latest_revision_id=revision.id;artifact.title=revision.title;artifact.kind=revision.kind;artifact.updated_at=now()
    await db.execute(update(VisualJob).where(VisualJob.id==job.id).values(status='published',stage='complete',publish_digest=fingerprint,artifact=reference))
    audit(db,learner_id,'publish',[job.id,'publish'],{'builder':p['builder'],'verification_scope':result['verification']['scope'],'version':p['expected_version']+1},job_id=job.id,revision_id=revision.id,run_id=run.id)
    await record_workspace_event(db,learner_id,'publish',revision.id,job_id=job.id,revision_id=revision.id,run_id=run.id)
    await db.commit();return reference


def retrieval_fields(revision, request):
    """Bounded authoring metadata is searchable data, never instructions."""
    source = revision.source
    teaching = source.get('teaching', {}) if isinstance(source.get('teaching'), dict) else {}
    goal = teaching.get('goal', source.get('goal', ''))
    labels = [str(node.get('label', '')) for node in source.get('nodes', [])[:16] if isinstance(node, dict)]
    labels += [str(parameter.get('label', '')) for parameter in source.get('parameters', [])[:32] if isinstance(parameter, dict)]
    metadata = ' '.join(str(value) for key in ('domains',) for value in source.get(key, [])[:16])
    metadata += ' ' + ' '.join(str(value) for key in ('misconceptions', 'assumptions') for value in teaching.get(key, [])[:16])
    return [(revision.title, 3.0), (str(goal)[:2000], 2.0), (' '.join(labels)[:4000], 1.5), (metadata[:6000], 1.0), (request[:12000], 1.0)]


async def search_private(db, learner_id, payload):
    fields(payload, {'query'}, {'kind'}); bounded(payload['query'], 'query', 2000)
    require(payload.get('kind') in (None, 'diagram', 'animation'), 'visual_workspace:kind_invalid')
    # Scope in SQL before materialization; one latest revision per private artifact.
    query = select(VisualRevision, VisualJob.request).join(VisualArtifact, VisualArtifact.latest_revision_id == VisualRevision.id).join(VisualJob, VisualJob.id == VisualRevision.job_id).where(
        VisualRevision.learner_id == learner_id, VisualArtifact.learner_id == learner_id, VisualJob.learner_id == learner_id)
    if payload.get('kind'): query = query.where(VisualRevision.kind == payload['kind'])
    rows = (await db.execute(query.order_by(VisualRevision.created_at.desc(), VisualRevision.id.desc()).limit(200))).all()
    question = payload['query'].strip().casefold()
    stop = {'如何', '为什么', '什么', '怎样', '一下', '是否', '可以', '这个', '一个', '请问', '帮我', '图解', '动画', '生成'}
    terms = _terms(question) - stop
    candidates = []
    for revision, request in rows:
        parts = retrieval_fields(revision, request)
        scored = [(text, weight, _terms(text.replace('_', ' ')) - stop) for text, weight in parts]
        matches = terms & set().union(*(tokens for _, _, tokens in scored))
        exact = bool(question) and any(question in text.casefold() for text, _ in parts)
        if question and not exact and (not matches or len(terms) > 3 and len(matches) < 2): continue
        score = (10 if exact else 0) + sum(weight * len(terms & tokens) for _, weight, tokens in scored)
        snippet = max(scored, key=lambda part: part[1] * len(terms & part[2]))[0] if terms else parts[1][0]
        candidates.append((score, revision, str(parts[1][0]), snippet))
    # Stable ties keep newest-first SQL order, and results remain thin references.
    candidates.sort(key=lambda item: -item[0])
    items = []
    for score, revision, goal, snippet in candidates:
        try:
            await revision_scope(db, learner_id, revision)
            run = await choose_run(db, learner_id, revision)
        except WorkspaceError as exc:
            if exc.status in (404, 409): continue  # One stale scope must not hide other owned artifacts.
            raise
        items.append({**artifact_ref(revision, run), 'summary': goal[:500], 'retrieval_snippet': snippet[:400], 'retrieval_score': score})
        if len(items) == 20: break
    unfinished = select(VisualJob).where(VisualJob.learner_id == learner_id, VisualJob.status.in_(('running', 'paused')))
    if payload.get('kind'): unfinished = unfinished.where(VisualJob.kind == payload['kind'])
    jobs = (await db.scalars(unfinished.order_by(VisualJob.updated_at.desc(), VisualJob.id.desc()).limit(200))).all()
    ranked_jobs = []
    for job in jobs:
        matches = terms & (_terms(job.request) - stop)
        exact = bool(question) and question in job.request.casefold()
        if question and not exact and (not matches or len(terms) > 3 and len(matches) < 2): continue
        ranked_jobs.append(((10 if exact else 0) + len(matches), job))
    ranked_jobs.sort(key=lambda item: -item[0])
    job_items = []
    for _, job in ranked_jobs:
        try:
            await validate_scope(db, learner_id, job.project_id, job.session_id)
        except WorkspaceError as exc:
            if exc.status in (404, 409): continue
            raise
        job_items.append({'job_id': job.id, 'version': job.version, 'status': job.status, 'stage': job.stage, 'kind': job.kind,
                          'source_mode': job.source_mode, 'title': job.request[:160], 'request': job.request[:400],
                          'updated_at': job.updated_at.isoformat(), **({'base_revision_id': job.base_revision_id} if job.base_revision_id else {})})
        if len(job_items) == 10: break
    return {'query': payload['query'], 'items': items, 'jobs': job_items, 'candidate_limit': 200}


async def dispatch(db,learner_id,operation,p):
    if operation=='start_job':return await start_job(db,learner_id,p)
    if operation=='checkpoint':return await checkpoint(db,learner_id,p)
    if operation=='publish':return await publish(db,learner_id,p)
    if operation in ('get_job','cancel_job'):
        fields(p,{'job_id'});job=await owned(db,VisualJob,learner_id,p['job_id']);await validate_scope(db,learner_id,job.project_id,job.session_id)
        if operation=='cancel_job' and job.status!='cancelled':
            require(job.status!='published','visual_workspace:job_terminal',409)
            result=await db.execute(update(VisualJob).where(VisualJob.id==job.id,VisualJob.version==job.version,VisualJob.status.in_(('running','paused'))).values(status='cancelled',stage='cancelled',version=job.version+1,updated_at=now()).execution_options(synchronize_session=False))
            if result.rowcount!=1:
                await db.rollback();current=await owned(db,VisualJob,learner_id,p['job_id'])
                require(current.status=='cancelled','visual_workspace:version_conflict',409)
                return job_ref(current)
            audit(db,learner_id,'cancel_job',[job.id,'cancel'],{'version':job.version+1},job_id=job.id)
            await record_workspace_event(db,learner_id,'cancel_job',job.id,job_id=job.id)
            await db.commit()
            job=await owned(db,VisualJob,learner_id,p['job_id'])
        return job_ref(job)
    if operation=='search':
        return await search_private(db,learner_id,p)
    if operation in ('read','rerun','view','feedback'):
        contracts={'read':({'revision_id'},{'run_id'}),'rerun':({'revision_id','params'},set()),'view':({'revision_id'},{'run_id','state','view_state'}),'feedback':({'revision_id','comment'},{'run_id','snapshot_ref'})}
        fields(p,*contracts[operation]);rev=await owned(db,VisualRevision,learner_id,p['revision_id']);await revision_scope(db,learner_id,rev)
        if operation=='rerun':
            result=await compiled(rev.builder,rev.source,p['params'],rev.kind,learner_id,rev.template_ref)
            fingerprint=digest({'params':result.get('params',{}),'runtime':result['runtime_version']})
            run=await db.scalar(select(VisualRun).where(VisualRun.learner_id==learner_id,VisualRun.revision_id==rev.id,VisualRun.input_digest==fingerprint))
            if not run:
                revision_id=rev.id
                run=VisualRun(id=uid(),learner_id=learner_id,revision_id=rev.id,input_digest=fingerprint,params=result.get('params',{}),compiled=result);db.add(run)
                try:
                    await record_workspace_event(db,learner_id,'rerun',run.id,revision_id=rev.id,run_id=run.id)
                    await db.commit()
                except IntegrityError:
                    await db.rollback();rev=await owned(db,VisualRevision,learner_id,revision_id)
                    run=await db.scalar(select(VisualRun).where(VisualRun.learner_id==learner_id,VisualRun.revision_id==rev.id,VisualRun.input_digest==fingerprint))
            return {**artifact_ref(rev,run),'source':copy.deepcopy(rev.source),**({'bundle':copy.deepcopy(run.compiled)} if rev.builder=='visual_spec' else {'scenes':copy.deepcopy(run.compiled['scenes'])})}
        run=await choose_run(db,learner_id,rev,p.get('run_id'))
        if operation=='read':
            view=await db.scalar(select(VisualViewState).where(VisualViewState.learner_id==learner_id,VisualViewState.revision_id==rev.id,VisualViewState.run_id==run.id))
            return {**artifact_ref(rev,run),'source':copy.deepcopy(rev.source),**({'bundle':copy.deepcopy(run.compiled)} if rev.builder=='visual_spec' else {'scenes':copy.deepcopy(run.compiled['scenes'])}),**({'view_state':copy.deepcopy(view.state)} if view else {})}
        if operation=='view':
            require(('state' in p) != ('view_state' in p),'visual_workspace:view_state_required')
            state=p.get('view_state',p.get('state'));require(isinstance(state,dict),'visual_workspace:view_state_invalid');json_budget(state,'view_state',16000)
            if 'step' in state:require(type(state['step']) is int and 0<=state['step']<len(run.compiled.get('frames',run.compiled.get('scenes',[]))),'visual_workspace:view_step_invalid')
            existing=await db.scalar(select(VisualViewState).where(VisualViewState.learner_id==learner_id,VisualViewState.revision_id==rev.id,VisualViewState.run_id==run.id))
            if existing:existing.state=copy.deepcopy(state);existing.updated_at=now()
            else:db.add(VisualViewState(id=uid(),learner_id=learner_id,revision_id=rev.id,run_id=run.id,state=copy.deepcopy(state)))
            revision_id,run_id=rev.id,run.id
            try:await db.commit()
            except IntegrityError:
                await db.rollback()
                await db.execute(update(VisualViewState).where(VisualViewState.learner_id==learner_id,VisualViewState.revision_id==revision_id,VisualViewState.run_id==run_id).values(state=copy.deepcopy(state),updated_at=now()));await db.commit()
            return {'revision_id':revision_id,'run_id':run_id,'view_state':state}
        bounded(p['comment'],'comment',4000,1)
        if p.get('snapshot_ref'):
            require(any(f['snapshot_ref']==p['snapshot_ref'] for f in run.compiled.get('frames',run.compiled.get('scenes',[]))),'state conflict',409)
        key=digest(['feedback',rev.id,run.id,p.get('snapshot_ref'),p['comment']])
        existing=await db.scalar(select(VisualWorkspaceAudit).where(VisualWorkspaceAudit.learner_id==learner_id,VisualWorkspaceAudit.dedupe_key==key))
        if not existing:
            existing=audit(db,learner_id,'feedback',['feedback',rev.id,run.id,p.get('snapshot_ref'),p['comment']],{'comment':p['comment'],'snapshot_ref':p.get('snapshot_ref'),'mastery_unchanged':True},revision_id=rev.id,run_id=run.id)
            try:
                await record_workspace_event(db,learner_id,'feedback',existing.id,revision_id=rev.id,run_id=run.id)
                await db.commit()
            except IntegrityError:
                await db.rollback();existing=await db.scalar(select(VisualWorkspaceAudit).where(VisualWorkspaceAudit.learner_id==learner_id,VisualWorkspaceAudit.dedupe_key==key))
        return {'feedback_id':existing.id,'status':'recorded','mastery_unchanged':True}
    raise WorkspaceError('visual_workspace:operation_unsupported')


async def workspace_operation(learner_id, operation, payload):
    require(isinstance(operation,str),'visual_workspace:operation_invalid')
    json_budget(payload,'payload',290000)
    async with async_session() as db:
        return await dispatch(db,learner_id,operation,payload)
