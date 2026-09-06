"""Authenticated stateless content computation; no files, remote refs or kernel writes."""
from fastapi import APIRouter, Depends, HTTPException, Request
from starlette.concurrency import run_in_threadpool
from app.services.auth import CurrentLearner, get_current_learner
from learnflow_core.visuals.engine import compile_visual, inspect_visual, predict_visual

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
    allowed = {'spec', 'params'} | ({'step','snapshot_ref'} if action != 'compile' else set()) | ({'answer'} if action=='predict' else set())
    if set(data)-allowed or 'spec' not in data or ('params' in data and not isinstance(data['params'],dict)):
        raise HTTPException(422, 'visual_invalid_fields')
    try:
        args = [data['spec'], data.get('params', {})]
        if action != 'compile': args += [data.get('step'), data.get('snapshot_ref')]
        if action == 'predict': args += [data.get('answer')]
        fn = {'compile':compile_visual, 'inspect':inspect_visual, 'predict':predict_visual}[action]
        result = await run_in_threadpool(fn, *args)
        return {**result, 'owner_scope': str(current.learner.id)}
    except Exception as exc:
        # Schema paths help repair, but never echo supplied content or stacks.
        from jsonschema import ValidationError
        if isinstance(exc, ValidationError):
            detail = 'visual_schema_invalid:/' + '/'.join(str(p) for p in exc.absolute_path)
        else:
            detail = 'visual_validation_failed' if not isinstance(exc, ValueError) else str(exc)[:180]
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
            provenance={'tool':'deterministic_assessment','runtime':'learnflow.visualize.1.0.0'},
            client_event_id='visual:' + digest([result['snapshot_ref'], data['answer']]))
        await db.commit()
    return result
