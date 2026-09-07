"""Authenticated stateless content computation; no files, remote refs or kernel writes."""
from fastapi import APIRouter, Depends, HTTPException, Request
from starlette.concurrency import run_in_threadpool
from app.services.auth import CurrentLearner, get_current_learner
from learnflow_core.visuals.engine import compile_visual, inspect_visual, predict_visual, digest, RUNTIME_VERSION
from learnflow_core.visuals.catalog import search_catalog, read_template

router = APIRouter(prefix='/visuals', tags=['Visual teaching'])

async def body(request):
    import json
    payload = bytearray()
    async for chunk in request.stream():
        payload.extend(chunk)
        if len(payload) > 300_000:
            raise HTTPException(413, 'visual_payload_too_large')
    try:
        result = json.loads(payload)
        if not isinstance(result, dict): raise ValueError('object required')
        return result
    except (ValueError, RecursionError):
        raise HTTPException(422, 'visual_invalid_json')

async def execute(request, current, action):
    data = await body(request)
    request.state.visual_payload = data
    allowed = {'spec', 'params'} | ({'template_ref'} if action == 'compile' else set()) | ({'step','snapshot_ref'} if action != 'compile' else set()) | ({'answer'} if action=='predict' else set())
    if set(data)-allowed or 'spec' not in data or ('params' in data and not isinstance(data['params'],dict)):
        raise HTTPException(422, 'visual_invalid_fields')
    try:
        args = [data['spec'], data.get('params', {})]
        if action != 'compile': args += [data.get('step'), data.get('snapshot_ref')]
        if action == 'predict': args += [data.get('answer')]
        fn = {'compile':compile_visual, 'inspect':inspect_visual, 'predict':predict_visual}[action]
        result = await run_in_threadpool(fn, *args)
        if action == 'compile':
            reference = data.get('template_ref')
            provenance = {'source': 'generated'}
            if reference is not None:
                if not isinstance(reference, dict) or set(reference) != {'id', 'version'}:
                    raise ValueError('visual_template_identity_required')
                template = await run_in_threadpool(read_template, reference['id'], reference['version'])
                provenance = {**template['provenance'], 'source': 'maintained_library' if digest(data['spec']) == template['provenance']['spec_digest'] else 'adapted_library'}
            result['source_provenance'] = provenance
        return {**result, 'owner_scope': str(current.learner.id)}
    except Exception as exc:
        # Schema paths help repair, but never echo supplied content or stacks.
        from jsonschema import ValidationError
        if isinstance(exc, ValidationError):
            path = '/' + '/'.join(str(p) for p in exc.absolute_path)
            rule = str(exc.validator)
            expectation = ''
            if rule == 'required' and isinstance(exc.instance, dict):
                expectation = ' missing=' + ','.join(key for key in exc.validator_value if key not in exc.instance)
            elif rule in {'type', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength'}:
                expectation = ' expected=' + str(exc.validator_value)
            elif rule == 'enum':
                expectation = ' allowed=' + ','.join(str(item) for item in exc.validator_value[:12])
            elif rule == 'additionalProperties' and isinstance(exc.instance, dict):
                import re
                extra = set(exc.instance) - set(exc.schema.get('properties', {}))
                expectation = ' unexpected=' + ','.join(re.sub(r'[^a-zA-Z0-9_.-]', '?', key)[:48] for key in sorted(extra)[:4])
            detail = ('visual_schema_invalid:' + path + ' rule=' + rule + expectation)[:360]
        else:
            detail = 'visual_validation_failed' if not isinstance(exc, ValueError) else str(exc)[:1800]
        raise HTTPException(409 if detail=='state conflict' else 422, detail)

@router.post('/compile')
async def compile_artifact(request: Request, current: CurrentLearner = Depends(get_current_learner)):
    return await execute(request, current, 'compile')

@router.post('/inspect')
async def inspect_artifact(request: Request, current: CurrentLearner = Depends(get_current_learner)):
    return await execute(request, current, 'inspect')

@router.post('/predict')
async def predict_artifact(request: Request, current: CurrentLearner = Depends(get_current_learner)):
    result = await execute(request, current, 'predict')
    from app.db.database import async_session
    from app.services.learning_runtime import record_event
    from learnflow_core.visuals.engine import digest
    data = request.state.visual_payload
    # Stateless content replay is repeatable; answer audit is learner-scoped and idempotent.
    async with async_session() as db:
        await record_event(db, learner_id=current.learner.id,
            event_type='visual_exploration_recorded', source='visual_exploration',
            payload={'snapshot_ref': result['snapshot_ref'], 'correct': result['correct'],
                     'answer': data['answer'], 'mastery_unchanged': True, 'assistance': 'open_exploration'},
            provenance={'tool':'deterministic_assessment','runtime':RUNTIME_VERSION},
            client_event_id='visual:' + digest([result['snapshot_ref'], data['answer']]))
        await db.commit()
    return result


@router.post('/catalog')
async def catalog(request: Request, current: CurrentLearner = Depends(get_current_learner)):
    data = await body(request)
    if not {'query', 'kind'} <= set(data) <= {'query', 'kind', 'templates'} or ('templates' in data and type(data['templates']) is not bool):
        raise HTTPException(422, 'visual_catalog_fields_invalid')
    try:
        return await run_in_threadpool(search_catalog, data['query'], data['kind'], data.get('templates', True))
    except ValueError as exc:
        raise HTTPException(422, str(exc)[:180])


@router.post('/template')
async def template(request: Request, current: CurrentLearner = Depends(get_current_learner)):
    data = await body(request)
    if set(data) != {'id', 'version'}:
        raise HTTPException(422, 'visual_template_fields_invalid')
    try:
        return await run_in_threadpool(read_template, data['id'], data['version'])
    except ValueError as exc:
        detail = str(exc)[:180]
        raise HTTPException(404 if detail == 'visual_template_not_found' else 422, detail)


@router.post('/workspace')
async def workspace(request: Request, current: CurrentLearner = Depends(get_current_learner)):
    """Private authoring progress and immutable artifact revisions, learner-bound."""
    from learnflow_core.visuals.workspace import workspace_operation, WorkspaceError
    data = await body(request)
    if set(data) != {'operation', 'payload'}:
        raise HTTPException(422, 'visual_workspace:invalid_envelope')
    try:
        return await workspace_operation(current.learner.id, data['operation'], data['payload'])
    except WorkspaceError as exc:
        raise HTTPException(exc.status, str(exc)[:1800])
    except (ValueError, TypeError, KeyError, RecursionError) as exc:
        raise HTTPException(422, str(exc)[:1800] if isinstance(exc, ValueError) else 'visual_workspace:invalid_payload')


@router.post('/hub')
async def hub(request: Request, current: CurrentLearner = Depends(get_current_learner)):
    """Internal curriculum discovery; planned candidates are not runnable works."""
    from learnflow_core.visuals.hub import query_hub
    data = await body(request)
    if set(data) - {'query', 'module_id', 'offset', 'limit'}:
        raise HTTPException(422, 'visual_hub_fields_invalid')
    try:
        return await run_in_threadpool(query_hub, **data)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
