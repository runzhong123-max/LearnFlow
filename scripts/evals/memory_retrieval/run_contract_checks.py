"""Usage: python run_contract_checks.py HOST OUTPUT_PREFIX; offline temporary DB only."""
import json,os,pathlib,sys,tempfile
host=pathlib.Path(sys.argv[1]).resolve();output=pathlib.Path(sys.argv[2]).resolve()
repo=pathlib.Path(__file__).resolve().parents[3]
sys.path[:0]=[str(host),str(repo/'packages/learning-core/src')]
attempts=[];opened=set()
allowed=[pathlib.Path(tempfile.gettempdir()).resolve(),pathlib.Path('/private/tmp')]
def guard(event,args):
 if event=='socket.connect':
  attempts.append('socket.connect');raise RuntimeError('Offline contract check forbids network')
 if event=='sqlite3.connect':
  name=str(args[0])
  if name!=':memory:':
   p=pathlib.Path(name).resolve()
   if not any(p.is_relative_to(root) for root in allowed):raise RuntimeError('Database is outside temporary roots')
   opened.add(p.name)
sys.addaudithook(guard)
import pytest
names=['test_memory_graph.py','test_memory_upgrade.py','test_immediate_teaching_context.py','test_memory_retrieval_budget.py','test_architecture_registry.py']
result=pytest.main([*[str(host/'tests'/n) for n in names],'-q','-p','no:cacheprovider','--junitxml='+str(output)+'.xml'])
pathlib.Path(str(output)+'.audit.json').write_text(json.dumps({'exit_code':result,'network_attempts':attempts,'sqlite_names':sorted(opened),'command':sys.argv,'python':sys.version}))
raise SystemExit(result)
