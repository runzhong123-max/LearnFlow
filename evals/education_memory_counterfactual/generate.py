"""Freeze authored cases with executed Python/SQL answer-oracle receipts.

No learner State, memory Fact, or model answer is constructed by this module.
The synthetic assistance labels describe a fixture, not an observed intervention.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys

VERSION = 'learnflow.education-counterfactual.fixtures.v1'
AT = datetime(2026, 9, 1, 12, tzinfo=timezone.utc)
CONTRASTS = ('assistance', 'latest_outcome', 'time_budget', 'support_expiry',
             'priority_update', 'self_report_vs_assessment')

# Each program computes the answer; no expected-answer literal is consulted.
TOPICS = (
 ('binary_search', '二分查找边界', 'formal', '下列有序序列中，首个不小于8的元素下标是多少（从0开始）？',
  'a=[1,3,5,8,8,12]\n', 'import bisect\nanswer=bisect.bisect_left(a,8)\n'),
 ('rpn_stack', '栈与逆波兰表达式', 'formal', '使用栈求值后，表达式的整数结果是多少？',
  "tokens=['7','3','-','2','*','5','+']\n", "stack=[]\nfor t in tokens:\n if t in ('+','-','*'):\n  b=stack.pop();a=stack.pop();stack.append(a+b if t=='+' else a-b if t=='-' else a*b)\n else:stack.append(int(t))\nanswer=stack[0]\n"),
 ('topological_sort', '拓扑排序', 'formal', '每次选择字典序最小的零入度节点，输出完整拓扑顺序。',
  "edges=[('A','C'),('B','C'),('B','D'),('C','E'),('D','E')]\n",
  "import heapq\nnodes=sorted({x for e in edges for x in e});degree={x:0 for x in nodes};adj={x:[] for x in nodes}\nfor a,b in edges:degree[b]+=1;adj[a].append(b)\nq=[x for x in nodes if degree[x]==0];heapq.heapify(q);answer=[]\nwhile q:\n a=heapq.heappop(q);answer.append(a)\n for b in adj[a]:\n  degree[b]-=1\n  if degree[b]==0:heapq.heappush(q,b)\n"),
 ('sql_group', 'SQL分组聚合', 'formal', '按类别排序，统计每类数量，输出查询结果。',
  "rows=[('network',2),('database',4),('network',6),('database',2),('compiler',3)]\n",
  "import sqlite3\nc=sqlite3.connect(':memory:');c.execute('CREATE TABLE t(category TEXT,value INTEGER)');c.executemany('INSERT INTO t VALUES (?,?)',rows)\nanswer=c.execute('SELECT category,COUNT(*),SUM(value) FROM t GROUP BY category ORDER BY category').fetchall();c.close()\n"),
 ('dijkstra', '非负权最短路径', 'formal', '从A到D的最短路径长度是多少？所有边均为有向非负边。',
  "edges={'A':[('B',4),('C',1)],'B':[('D',1)],'C':[('B',2),('D',7)],'D':[]}\n",
  "import heapq\nd={'A':0};q=[(0,'A')]\nwhile q:\n cost,a=heapq.heappop(q)\n if cost!=d[a]:continue\n for b,w in edges[a]:\n  if cost+w<d.get(b,float('inf')):d[b]=cost+w;heapq.heappush(q,(cost+w,b))\nanswer=d['D']\n"),
 ('lru_cache', 'LRU缓存淘汰', 'formal', '容量为3，依次访问以下键，最后从最久未使用到最近使用的键是什么？',
  "accesses=['A','B','C','A','D','B']\n",
  "from collections import OrderedDict\nc=OrderedDict()\nfor key in accesses:\n c.pop(key,None);c[key]=True\n if len(c)>3:c.popitem(last=False)\nanswer=list(c)\n"),
 ('bit_mask', '位运算与权限掩码', 'formal', '对整数13清除第2位（最低位编号0），再设置第1位，结果是多少？',
  'value=13\n', 'answer=(value & ~(1<<2)) | (1<<1)\n'),
 ('python_alias', 'Python浅拷贝', 'formal', '执行给定代码后，a和b中内部列表的长度分别是多少？',
  'a=[[1],[2]]\nb=a.copy()\na[0].append(3)\nb.append([4])\n',
  'answer=([len(x) for x in a],[len(x) for x in b])\n'),
 ('breadth_first', '广度优先遍历', 'dev', '邻接节点按给定顺序入队，从S开始的首次访问顺序是什么？',
  "graph={'S':['A','B'],'A':['C'],'B':['C','D'],'C':[],'D':[]}\n",
  "from collections import deque\nq=deque(['S']);seen={'S'};answer=[]\nwhile q:\n a=q.popleft();answer.append(a)\n for b in graph[a]:\n  if b not in seen:seen.add(b);q.append(b)\n"),
 ('sql_join', 'SQL左连接', 'dev', '以users为左表按id左连接scores，按id排序，查询id和COALESCE(score,0)。',
  "users=[(1,'Li'),(2,'Wu'),(3,'Zhao')];scores=[(1,8),(3,9)]\n",
  "import sqlite3\nc=sqlite3.connect(':memory:');c.execute('CREATE TABLE users(id INTEGER,name TEXT)');c.execute('CREATE TABLE scores(id INTEGER,score INTEGER)');c.executemany('INSERT INTO users VALUES (?,?)',users);c.executemany('INSERT INTO scores VALUES (?,?)',scores)\nanswer=c.execute('SELECT users.id,COALESCE(score,0) FROM users LEFT JOIN scores ON users.id=scores.id ORDER BY users.id').fetchall();c.close()\n"),
)


def sha(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def oracle(topic: tuple) -> dict:
    program = topic[4] + topic[5] + '\nprint(json.dumps(answer,ensure_ascii=False,separators=(",",":")))\n'
    guard = "import sys,json\ndef guard(event,args):\n if event in ('socket.connect','socket.getaddrinfo'):raise RuntimeError('oracle_network_forbidden')\n if event=='sqlite3.connect' and str(args[0])!=':memory:':raise RuntimeError('oracle_file_database_forbidden')\nsys.addaudithook(guard)\n"
    executed = guard + program
    result = subprocess.run([sys.executable, '-I', '-c', executed], capture_output=True,
                            text=True, timeout=10, check=False)
    if result.returncode or not result.stdout.strip():
        raise RuntimeError('oracle_execution_failed:'+topic[0]+':'+result.stderr)
    answer = json.loads(result.stdout)
    correct = json.dumps(answer, ensure_ascii=False, separators=(',', ':'))
    wrong = json.dumps(answer+1 if type(answer) is int else ['不同结果',answer], ensure_ascii=False, separators=(',', ':'))
    return {'kind':'executed_python_or_sql','interpreter':sys.executable,'python_version':sys.version,
            'program':executed,'program_sha256':sha(executed),'stdout':result.stdout,
            'stdout_sha256':sha(result.stdout),'stderr':result.stderr,'exit_code':result.returncode,
            'correct_response':correct,'incorrect_response':wrong}


def _at(hours=0, minutes=0):
    return (AT+timedelta(hours=hours,minutes=minutes)).isoformat()


def build_cases() -> list[dict]:
    cases=[]
    for topic in TOPICS:
        key,label,split,prompt,artifact,_=topic
        receipt=oracle(topic)
        for contrast in CONTRASTS:
            pair=f'cf-{key}-{contrast}'
            for side in ('a','b'):
                def assessment(identifier, when, correct=True, assistance='none', scope='target'):
                    return {'op':'concept_answer','id':identifier,'at':when,'scope':scope,
                            'item':identifier,'response':receipt['correct_response'] if correct else receipt['incorrect_response'],
                            'assistance_level':assistance}
                def control(identifier,text,when):
                    return {'op':'control_text','id':identifier,'at':when,'scope':'target','text':text}
                if contrast=='assistance':
                    steps=[assessment('result',_at(minutes=-30),assistance='guided' if side=='a' else 'none')]
                elif contrast=='latest_outcome':
                    steps=[assessment('result-1',_at(hours=-2),correct=side=='b'),
                           assessment('result-2',_at(minutes=-30),correct=side=='a')]
                elif contrast=='time_budget':
                    steps=[assessment('result',_at(hours=-2)),control('time',f'本次只有{8 if side=="a" else 25}分钟。',_at(minutes=-20))]
                elif contrast=='support_expiry':
                    steps=[control('support','请拆成小步，每次只处理一个问题。',_at(hours=-1 if side=='a' else -9)),
                           assessment('result',_at(minutes=-30))]
                elif contrast=='priority_update':
                    priorities=[label+'边界分析',label+'例题推演']
                    if side=='b':priorities.reverse()
                    steps=[assessment('result',_at(hours=-3)),
                           control('priority-1','本次优先：'+priorities[0]+'。',_at(hours=-2)),
                           control('priority-2','本次优先：'+priorities[1]+'。',_at(minutes=-20))]
                else:
                    steps=([{'op':'native_self_report','id':'self-report','at':_at(minutes=-30),
                             'scope':'target','text':f'我自述已经独立完成{label}的这道题；这只是我的说法，尚无正式测评。'}]
                           if side=='a' else [assessment('result',_at(minutes=-30))])
                background=[]
                for index,focus in enumerate(('输入前提与边界','中间状态的含义','操作顺序与依赖','异常输入的处理',
                                              '结果如何逐步核对','相似概念的区别','复杂度与规模变化','适用范围和未验证限制')):
                    background.append({'op':'native_gap','id':f'background-gap-{index+1}',
                        'at':_at(hours=-20+index),'scope':'target',
                        'text':f'我不懂{label}中{focus}。我目前只记下课堂例子的表面步骤，还没有独立解释每一步为何成立。'
                               '这条记录保留我当时的问题和理解边界，后续需要结合具体输入重新核对；不能把看过例子或复述名称当成独立完成的证据。'})
                background += [control('background-priority','本次优先：'+label+'术语整理。',_at(hours=-12)),
                               control('background-anchor','先回到'+label+'基础定义。',_at(hours=-11))]
                steps=background+steps
                # Real events are retained for independently checking scope/time,
                # rather than removing foreign/future fixtures at the adapter.
                steps += [assessment('foreign-result',_at(minutes=-10),correct=False,scope='foreign_project'),
                          assessment('future-result',_at(hours=2),correct=False)]
                cases.append({'schema':VERSION,'design_revision':2,'case_id':pair+'-'+side,'pair_id':pair,'family_id':key,
                    'split':split,'contrast':contrast,'side':side,'at':AT.isoformat(),
                    'topic':{'id':key,'label':label},'steps':sorted(steps,key=lambda s:(s['at'],s['id'])),
                    'question':{'prompt':prompt,'artifact':artifact,'oracle':receipt},
                    'request':f'请根据当前项目中关于{label}的有效记录，判断本次学习状态、有效安排及下一步。',
                    'limitations':['authored_mechanism_cases_not_population_samples','synthetic_declared_assistance_not_observed_intervention',
                                    'no_stable_mastery_or_verified_transfer','oracle_answers_hidden_from_reader']})
    return sorted(cases,key=lambda c:c['case_id'])


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();cases=build_cases();args.output.parent.mkdir(parents=True,exist_ok=True)
    with args.output.open('x',encoding='utf-8') as stream:
        for case in cases:stream.write(json.dumps(case,ensure_ascii=False,sort_keys=True)+'\n')
    print(json.dumps({'cases':len(cases),'formal':sum(c['split']=='formal' for c in cases),
        'dev':sum(c['split']=='dev' for c in cases),'data_sha256':hashlib.sha256(args.output.read_bytes()).hexdigest()}))


if __name__=='__main__':main()
