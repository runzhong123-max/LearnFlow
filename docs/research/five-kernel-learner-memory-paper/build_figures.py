"""Vector research figures from frozen aggregate data and an explicit schematic.

Run with the bundled document Python (reportlab, pdf2image). No model images.
"""
from pathlib import Path
import hashlib
import json
import os

from reportlab.graphics.shapes import Drawing, Rect, Line, String, Circle, Polygon
from reportlab.graphics import renderPDF, renderSVG
from reportlab.lib.colors import HexColor, white
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from pdf2image import convert_from_path

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent / "education-memory-counterfactual/formal-01-aggregate.json"
OUT = HERE / "figures"
OUT.mkdir(exist_ok=True)
pdfmetrics.registerFont(TTFont('CJK', '/System/Library/Fonts/Supplemental/Arial Unicode.ttf'))
pdfmetrics.registerFont(TTFont('Arial', '/System/Library/Fonts/Supplemental/Arial.ttf'))
pdfmetrics.registerFont(TTFont('ArialB', '/System/Library/Fonts/Supplemental/Arial Bold.ttf'))
BLACK = HexColor('#20252A')
GRAY = HexColor('#D9DEE2')
BLUE = HexColor('#0072B2')
ORANGE = HexColor('#D55E00')
GREEN = HexColor('#009E73')
COLORS = [BLUE, GREEN, HexColor('#7B61A8'), ORANGE, HexColor('#6E7780')]
ARTIFACTS = []


def txt(d, x, y, value, size=12, color=BLACK, anchor='start', bold=False, cjk=False):
    d.add(String(x, y, value, fontName='CJK' if cjk else ('ArialB' if bold else 'Arial'),
                 fontSize=size, fillColor=color, textAnchor=anchor))


def line(d, x1, y1, x2, y2, color=GRAY, width=.7):
    d.add(Line(x1, y1, x2, y2, strokeColor=color, strokeWidth=width))


def arrow(d, x1, y1, x2, y2):
    line(d, x1, y1, x2, y2, BLACK, 1)
    if x1 == x2:
        d.add(Polygon([x2-3,y2+5,x2,y2,x2+3,y2+5], fillColor=BLACK, strokeColor=None))
    else:
        d.add(Polygon([x2-5,y2-3,x2,y2,x2-5,y2+3], fillColor=BLACK, strokeColor=None))


def save(d, name):
    renderPDF.drawToFile(d, str(OUT/f'{name}.pdf'))
    renderSVG.drawToFile(d, str(OUT/f'{name}.svg'))
    pages = convert_from_path(str(OUT/f'{name}.pdf'), dpi=240)
    assert len(pages) == 1
    pages[0].save(OUT/f'{name}.png')
    ARTIFACTS.extend(f'{name}.{ext}' for ext in ('pdf', 'svg', 'png'))


def architecture():
    d = Drawing(720, 370)
    txt(d, 12, 345, 'A', 17, bold=True)
    txt(d, 38, 345, 'Typed learner state and evidence authority', 16, bold=True)
    labels = [
        ('Structure', '位置与返回', '检查点  路径  依赖', '定位学习与恢复锚点', '不把位置当作掌握'),
        ('Knowledge', '概念与证据', '缺口  错误  测评', '保留理解证据等级', '不把自述当作测评'),
        ('Human', '支持与时限', '节奏  时长  支持', '约束本次教学安排', '不推断固定学习风格'),
        ('Value', '目标与优先', '确认目标  当前优先', '表达学习侧重', '不把临时目标永久化'),
        ('Practice', '表现与条件', '尝试  辅助  变式', '区分独立与受助表现', '不把重试当作迁移'),
    ]
    for i, (name, cn, objects, output, limit) in enumerate(labels):
        x=12+i*141
        line(d,x,319,x+131,319,COLORS[i],3)
        txt(d,x+65.5,295,name,14,anchor='middle',bold=True)
        txt(d,x+65.5,275,cn,13,anchor='middle',cjk=True)
        txt(d,x+65.5,244,objects,11.5,anchor='middle',cjk=True)
        txt(d,x+65.5,221,output,11.5,anchor='middle',cjk=True)
        txt(d,x+65.5,194,limit,10.7,anchor='middle',cjk=True)
    line(d,12,178,708,178)
    txt(d,12,155,'B',17,bold=True)
    txt(d,38,155,'One authoritative write chain',15,bold=True)
    chain=[('EvidenceEvent',64),('Reducer',204),('KernelMutation',344),('KernelState',484),('Fact / Module / Claim',638)]
    for i,(name,x) in enumerate(chain):
        txt(d,x,115,name,10.8 if i==4 else 11.8,anchor='middle',bold=True)
        if i<4: arrow(d,x+58,120,chain[i+1][1]-(74 if i==3 else 61),120)
    txt(d,360,80,'来源与归属校验   ·   确定性升级   ·   临时控制与长期巩固分流',13,anchor='middle',cjk=True)
    txt(d,360,49,'Scoped read projections → Tutor / Learning Design / Practice',13,anchor='middle')
    txt(d,360,20,'Architecture schematic; not a causal performance comparison.',10,anchor='middle')
    save(d,'architecture')


def object_interaction():
    d = Drawing(720, 480)
    def box(x, y, w, h, title, body, color=BLUE):
        d.add(Rect(x,y,w,h,strokeColor=GRAY,strokeWidth=.7,fillColor=white))
        line(d,x,y+h,x+w,y+h,color,2)
        txt(d,x+w/2,y+h-20,title,12.5,anchor='middle',cjk=True)
        for j, s in enumerate(body):
            txt(d,x+w/2,y+h-40-j*17,s,10.7,anchor='middle',cjk=True)
    def down(x,y1,y2,color=BLACK):
        line(d,x,y1,x,y2,color,1)
        d.add(Polygon([x-3,y2+5,x,y2,x+3,y2+5],fillColor=color,strokeColor=None))
    def up(x,y1,y2,color=BLUE):
        line(d,x,y1,x,y2,color,1)
        d.add(Polygon([x-3,y2-5,x,y2,x+3,y2-5],fillColor=color,strokeColor=None))
    txt(d,16,458,'Teaching objects, workbenches and learner-state authority',16,bold=True)
    box(20,388,638,50,'工作台入口','路径操作   /   学习任务执行   /   复习呈现与作答'.splitlines())
    line(d,339,388,339,373,BLACK,1)
    line(d,121,373,557,373,BLACK,1)
    for x in (121,339,557): down(x,373,364)
    txt(d,26,376,'用户操作与业务调用',10.5,cjk=True)
    box(20,278,203,86,'学习路径','课程图与确认路线\n个人计划部分存于 Structure'.splitlines())
    box(238,278,203,86,'LearningTask','任务规格、阶段与来源\n对象完成不代替学习证据'.splitlines())
    box(456,278,202,86,'ReviewSchedule','到期、间隔与调度阶段\n调度更新不直接升级掌握'.splitlines())
    for x in (121,339,557): line(d,x,278,x,266,BLACK,1)
    line(d,121,266,557,266,BLACK,1)
    down(339,266,258)
    box(20,209,638,49,'Tutor / Learning Design / Practice','协调与状态读取   /   教学设计   /   实践与确定性评价'.splitlines(),GREEN)
    for x in (81,210,339,468,597): line(d,x,187,x,192,BLUE,1)
    line(d,81,192,597,192,BLUE,1)
    up(339,192,209)
    txt(d,353,194,'有作用域的只读投影',10.5,color=BLUE,cjk=True)
    for i,(name,label) in enumerate([('Structure','位置与路径关系'),('Knowledge','概念与证据'),
                                   ('Human','支持与期限'),('Value','目标与优先'),('Practice','尝试与辅助')]):
        x=20+i*129
        box(x,132,122,55,name,[label],COLORS[i])
    line(d,339,103,339,124,BLUE,1)
    line(d,81,124,597,124,BLUE,1)
    for x in (81,210,339,468,597): up(x,124,132)
    txt(d,353,114,'归约后的学习者状态',10.5,color=BLUE,cjk=True)
    d.add(Rect(20,46,638,57,strokeColor=ORANGE,strokeWidth=.9,fillColor=white))
    txt(d,339,82,'EvidenceEvent → reducer → KernelMutation → KernelState',12,anchor='middle')
    txt(d,339,62,'零核目标止于审计；符合契约时形成状态及 Fact / Module / Claim',10.5,anchor='middle',cjk=True)
    line(d,658,234,687,234,ORANGE,1.3)
    down(687,234,74,ORANGE)
    line(d,687,74,658,74,ORANGE,1.3)
    d.add(Polygon([663,77,658,74,663,71],fillColor=ORANGE,strokeColor=None))
    txt(d,693,193,'证',10.5,color=ORANGE,cjk=True)
    txt(d,693,177,'据',10.5,color=ORANGE,cjk=True)
    txt(d,339,20,'Implementation schematic; service/API verification is distinct from browser or learning-outcome evaluation.',9,anchor='middle')
    save(d,'object_interaction')


def results(data):
    d=Drawing(720,315)
    idx={(g['variant'],g['budget']):g for g in data['groups']}
    variants=['five_kernel_gated','flat_gated','five_kernel_source','flat_source']
    labels=['Five + eligibility','Flat + eligibility','Five, source only','Flat, source only']
    for p,(title,metric,denom) in enumerate([
        ('Complete consistency','whole_record_correct',96),('Counterfactual pair success','pair_joint_success',48)]):
        origin=12+p*360
        txt(d,origin,286,chr(65+p),17,bold=True)
        txt(d,origin+25,286,title,14,bold=True)
        x0=origin+136; x1=origin+340; w=x1-x0
        for tick in [0,25,50,75,100]:
            x=x0+tick*w/100
            line(d,x,73,x,250)
            txt(d,x,54,str(tick),10,anchor='middle')
        for row,(v,label) in enumerate(zip(variants,labels)):
            y=227-row*45
            txt(d,origin+2,y-3,label,11)
            for b,dy,color in [(2200,6,BLUE),(8000,-6,ORANGE)]:
                g=idx[v,b]
                n=g['metrics'][metric] if metric=='whole_record_correct' else g[metric]
                x=x0+n/denom*w
                d.add(Circle(x,y+dy,3.7,fillColor=color,strokeColor=white,strokeWidth=.6))
        txt(d,(x0+x1)/2,33,'Success (%)',11,anchor='middle')
    for x,b,color in [(212,2200,BLUE),(407,8000,ORANGE)]:
        d.add(Circle(x,13,3.7,fillColor=color,strokeColor=None))
        txt(d,x+10,9,f'{b:,} budget units',11)
    save(d,'results')


def effects(data):
    d=Drawing(720,315)
    txt(d,12,291,'Paired differences in complete consistency',16,bold=True)
    x0,x1=303,690
    def xp(v): return x0+(v+10)/100*(x1-x0)
    for tick in [-10,0,20,40,60,80,90]:
        line(d,xp(tick),48,xp(tick),266, BLACK if tick==0 else GRAY,.9 if tick==0 else .6)
        txt(d,xp(tick),30,str(tick),10,anchor='middle')
    labels={'grouping_gated':'Grouping with eligibility','grouping_source':'Grouping with source only',
            'eligibility_five':'Eligibility within five kernels','eligibility_flat':'Eligibility within flat'}
    for i,row in enumerate(data['paired_differences']):
        y=250-i*27
        color=BLUE if row['budget']==2200 else ORANGE
        key=row['comparison']
        label=labels.get(key,key.replace('_',' '))
        txt(d,12,y-4,f"{label} | {row['budget']:,}",11)
        lo,hi=[v*100 for v in row['topic_cluster_bootstrap_95_percentile']]
        delta=row['delta']*100
        line(d,xp(lo),y,xp(hi),y,color,1.3)
        for bound in (lo,hi): line(d,xp(bound),y-3,xp(bound),y+3,color,1)
        d.add(Circle(xp(delta),y,3.5,fillColor=color,strokeColor=None))
    txt(d,(x0+x1)/2,8,'Difference (percentage points)',11,anchor='middle')
    save(d,'effects')


def longtail(data):
    assert data['matrix_complete'] and data['all_integrity_checks_passed']
    labels = {
        ('old_rare_exact','exact'): '旧稀有问题 精确词',
        ('alias','alias'): '术语别名 两个情境',
        ('unique_typo','typo'): '唯一错拼',
        ('out_of_alias_vocabulary','oov'): '词表外表达',
        ('separated_qualifier','split'): '分离的限定条件',
        ('source_tail','tail'): '正文尾部观察',
        ('historical_vs_current','earliest'): '同主题 最初问题',
        ('historical_vs_current','current'): '同主题 当前问题',
        ('scope_pollution','owned'): '作用域干扰下的本人来源',
        ('ambiguous_typo','ambiguous'): '歧义错拼',
        ('uncovered_exact','absent'): '无证据 精确查询',
        ('uncovered_generic','absent'): '无证据 普通问法',
    }
    d=Drawing(720,480)
    txt(d,16,455,'Native long-history retrieval',17,bold=True)
    txt(d,16,431,'A',14,bold=True)
    txt(d,39,431,'目标观察与限定共同交付',12,cjk=True)
    x0,x1=257,568
    for tick in (0,25,50,75,100):
        x=x0+(x1-x0)*tick/100
        line(d,x,75,x,416)
        txt(d,x,57,str(tick),10,anchor='middle')
    for i,(key,label) in enumerate(labels.items()):
        y=400-i*25-(25 if i>=9 else 0)
        if i==9:
            txt(d,16,y+23,'B',14,bold=True)
            txt(d,39,y+23,'负向查询 严格无背景正文',12,cjk=True)
        txt(d,16,y-4,label,11.5,cjk=True)
        metric='joint_term_qualifier_delivered' if i<9 else 'strict_empty_on_uncovered'
        scores=[]
        for variant,color,dy in [('default',BLUE,3.5),('source',ORANGE,-3.5)]:
            rows=[r for r in data['by_stratum'] if (r['family'],r['query_id'])==key and r['variant']==variant]
            n=sum(r['metrics'][metric]['numerator'] for r in rows)
            total=sum(r['metrics'][metric]['denominator'] for r in rows)
            assert total>0,(key,variant)
            d.add(Circle(x0+(x1-x0)*n/total,y+dy,3.2,fillColor=color,strokeColor=white,strokeWidth=.5))
            scores.append(f'{n}/{total}')
        txt(d,596,y-4,'  /  '.join(scores),10.5)
    txt(d,596,422,'Default / Source',10,bold=True)
    txt(d,(x0+x1)/2,37,'Condition success (%)',10.5,anchor='middle')
    for x,label,color in [(120,'Default',BLUE),(220,'Source',ORANGE)]:
        d.add(Circle(x,16,3.2,fillColor=color,strokeColor=None));txt(d,x+9,12,label,10.5)
    txt(d,690,12,'3 histories × 2 budgets; correlated conditions',10,anchor='end')
    save(d,'longtail')


if __name__=='__main__':
    data=json.loads(SOURCE.read_text())
    assert data['actual_responses']==768 and data['audit']['ok'] and data['matrix_complete']
    architecture(); object_interaction(); results(data); effects(data)
    additional={}
    longtail_source=HERE/'longtail-validation/aggregate.json'
    if longtail_source.is_file():
        longtail(json.loads(longtail_source.read_text()))
        additional['longtail-validation/aggregate.json']=hashlib.sha256(longtail_source.read_bytes()).hexdigest()
    manifest={'source':str(SOURCE.relative_to(HERE.parents[2])),
              'source_sha256':hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
              'generator_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'figures':{n:hashlib.sha256((OUT/n).read_bytes()).hexdigest() for n in ARTIFACTS},
              'additional_sources':additional,
              'schematic':'architecture and object_interaction: explanatory diagrams; no experimental values',
              'quantitative':'results, effects and longtail: saved aggregate data; no fabricated repetitions'}
    (OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print(json.dumps({'created':len(ARTIFACTS),'source_responses':data['actual_responses']}))
