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


if __name__=='__main__':
    data=json.loads(SOURCE.read_text())
    assert data['actual_responses']==768 and data['audit']['ok'] and data['matrix_complete']
    architecture(); results(data); effects(data)
    manifest={'source':str(SOURCE.relative_to(HERE.parents[2])),
              'source_sha256':hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
              'generator_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'figures':{n:hashlib.sha256((OUT/n).read_bytes()).hexdigest() for n in ARTIFACTS},
              'schematic':'architecture: designed explanatory diagram; no experimental values',
              'quantitative':'results and effects: direct frozen aggregate data; no fabricated repetitions'}
    (OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print(json.dumps({'created':len(ARTIFACTS),'source_responses':data['actual_responses']}))
