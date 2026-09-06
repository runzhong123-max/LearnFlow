import type {VisualView, PresentationPlan, RenderDiagnostic, VisualBundle} from './types.ts'
const escape = (value: unknown) => String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
const fmt = (n: number) => Number(n.toPrecision(5)).toString()
const widthOf = (s: string) => [...s].reduce((n,c)=>n+(c.charCodeAt(0)>255?16:9),0)
function text(x: number,y: number,value: unknown,size=16,anchor='start') {return `<text x="${x}" y="${y}" font-size="${size}" text-anchor="${anchor}" fill="#172b4d">${escape(value)}</text>`}
export function renderView(view: VisualView, viewport=720): {svg: string; plan: PresentationPlan; diagnostics: RenderDiagnostic[]} {
  const plan: PresentationPlan = {version:'1',viewId:view.id,width:Math.max(260,Math.min(720,viewport)),height:380,objects:[],transition:'cut'}
  const width=plan.width
  const diagnostics: RenderDiagnostic[]=[]
  const shapes: string[]=[]
  const axis=view.elements.find(e=>e.kind==='axis')?.values?.axes
  const plotKinds=new Set(['axis','curve','point','region'])
  let cursor=30
  let plotSeries=0
  function object(id: string,x: number,y: number,w: number,h: number,overlap: 'plot'|'none'='none') {plan.objects.push({id,bounds:[x,y,w,h],overlap})}
  for(const e of view.elements) {
    const v=e.values || {}
    if(plotKinds.has(e.kind)) {
      if(!axis) throw new Error('plot_axis_required')
      const [xmin,xmax]=axis.x.domain, [ymin,ymax]=axis.y.domain
      const px=(x:number)=>70+(x-xmin)/(xmax-xmin)*(width-120)
      const py=(y:number)=>300-(y-ymin)/(ymax-ymin)*240
      if(e.kind!=='axis') {
        const coordinates=e.kind==='point'?[v.point]:(v.points||v.polygon)
        if(coordinates.some(([x,y]:number[])=>x<xmin||x>xmax||y<ymin||y>ymax))diagnostics.push({code:'VIEWPORT_OVERFLOW',object_id:e.id,semantic_mutation_allowed:false})
        if(widthOf(e.label)>width-90)diagnostics.push({code:'TEXT_TOO_DENSE',object_id:e.id,semantic_mutation_allowed:false})

        const legendX=70
        shapes.push(text(legendX,375+plotSeries*23,e.label,14))
        plotSeries++
      }
      if(e.kind==='axis') {
        shapes.push(`<path d="M70 60 V300 H${width-50}" fill="none" stroke="#49617b"/>`)
        for(let i=0;i<=4;i++) {
          const x=xmin+(xmax-xmin)*i/4,y=ymin+(ymax-ymin)*i/4
          shapes.push(text(px(x),325,fmt(x),13,'middle'),text(62,py(y)+4,fmt(y),13,'end'))
        }
        shapes.push(text(width/2,345,axis.x.label,15,'middle'),text(70,30,axis.y.label,15))
      } else if(e.kind==='point') {
        const [x,y]=v.point;shapes.push(`<circle cx="${px(x)}" cy="${py(y)}" r="7" fill="#c2410c" stroke="white" stroke-width="2"/>`)
      } else {
        const points=(v.points||v.polygon) as number[][]
        shapes.push(`<${e.kind==='region'?'polygon':'polyline'} points="${points.map(([x,y])=>`${px(x)},${py(y)}`).join(' ')}" fill="${e.kind==='region'?'#0f766e':'none'}" fill-opacity="0.22" stroke="${e.kind==='region'?'#0f766e':'#2563eb'}" stroke-width="2" stroke-dasharray="${e.id.includes('path')?'6 4':'none'}"/>`)
      }
      object(e.id,60,20,width-90,340,'plot');cursor=400+plotSeries*23
      continue
    }
    shapes.push(text(24,cursor,e.label,16));cursor+=20
    if(widthOf(e.label)>width-48) diagnostics.push({code:'TEXT_TOO_DENSE',object_id:e.id,semantic_mutation_allowed:false})
    if(e.kind==='graph') {
      const g=v.graph, nodes=g.nodes as string[]
      const radius=Math.min(width/2-50,nodes.length>12?260:150)
      if(nodes.length>Math.floor(2*Math.PI*radius/62)) diagnostics.push({code:'TEXT_TOO_DENSE',object_id:e.id,semantic_mutation_allowed:false})
      const centerY=cursor+radius+35
      const positions=Object.fromEntries(nodes.map((n,i)=>[n,[width/2+radius*Math.cos(-Math.PI/2+2*Math.PI*i/nodes.length),centerY+radius*Math.sin(-Math.PI/2+2*Math.PI*i/nodes.length)]]))
      for(const [a,b] of g.edges) {const p=positions[a],q=positions[b];shapes.push(`<line x1="${p[0]}" y1="${p[1]}" x2="${q[0]}" y2="${q[1]}" stroke="#94a3b8" stroke-width="2"/>`)}
      for(const n of nodes) {
        const [x,y]=positions[n]; const active=v.active===n
        shapes.push(`<circle cx="${x}" cy="${y}" r="27" fill="${active?'#ffedd5':'#eff6ff'}" stroke="${active?'#c2410c':'#2563eb'}" stroke-width="${active?4:2}"/>`,text(x,y+5,n,16,'middle'))
        object(`${e.id}.${n}`,x-30,y-30,60,60)
        if(widthOf(n)>48) diagnostics.push({code:'TEXT_TOO_DENSE',object_id:e.id,semantic_mutation_allowed:false})
      }
      cursor+=radius*2+90
    } else if(e.kind==='array'||e.kind==='matrix') {
      const rows=e.kind==='matrix'?v.values:[v.items]
      const columns=Math.max(1,Math.floor((width-48)/96))
      for(const row of rows) {
        if(!row.length) {shapes.push(text(28,cursor+25,'∅'));cursor+=48}
        row.forEach((value:any,i:number)=>{
          const x=24+(i%columns)*96,y=cursor+Math.floor(i/columns)*50
          shapes.push(`<rect x="${x}" y="${y}" width="88" height="40" rx="6" fill="#eff6ff" stroke="#93c5fd"/>`,text(x+44,y+25,value,15,'middle'))
          if(widthOf(String(value))>80) diagnostics.push({code:'TEXT_TOO_DENSE',object_id:e.id,semantic_mutation_allowed:false})
        })
        object(e.id,24,cursor,width-48,Math.max(1,Math.ceil(row.length/columns))*50)
        cursor+=Math.max(1,Math.ceil(row.length/columns))*50
      }
      cursor+=20
    } else {
      const value=e.kind==='code'?v.source:v.value
      const lines=String(value).split('\n')
      for(const line of lines) {
        // Never silently clip semantic text: renderer requests the full text view.
        if(widthOf(line)>width-48) diagnostics.push({code:'TEXT_TOO_DENSE',object_id:e.id,semantic_mutation_allowed:false})
        shapes.push(text(28,cursor+20,line,e.kind==='metric'?24:16));cursor+=30
      }
      object(e.id,24,cursor-lines.length*30,width-48,lines.length*30);cursor+=24
    }
  }
  plan.height=Math.max(axis?410:120,cursor+20)
  for(const o of plan.objects) {const [x,y,w,h]=o.bounds;if(x<0||y<0||x+w>plan.width||y+h>plan.height)diagnostics.push({code:'VIEWPORT_OVERFLOW',object_id:o.id,semantic_mutation_allowed:false})}
  return {svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${plan.width} ${plan.height}" role="img"><rect width="100%" height="100%" fill="#fff"/>${shapes.join('')}</svg>`,plan,diagnostics}
}
export function describeFrame(bundle: VisualBundle, index: number) {
  const s=bundle.frames[index].state
  if(bundle.spec.model.id==='optimization.quadratic_gd')return `第 ${index} 次更新：学习率 ${bundle.params.alpha}，x = ${fmt(s.x)}，函数值 = ${fmt(s.loss)}，距最优点的有向误差 = ${fmt(s.error)}。`
  if(bundle.spec.model.id==='algorithms.bfs')return `第 ${index} 步，${s.current===null?'尚未展开节点':`展开节点 ${s.current}`}。待展开队列（左为队首）：${s.queue.join(' → ')||'空'}；已发现：${s.discovered.join('、')}。`
  if(bundle.spec.model.id==='probability.uniform_interval')return `支持区间宽度 ${bundle.params.width}，密度高度 ${fmt(s.density)}，所选区间的概率面积 ${fmt(s.probability)}。`
  return bundle.spec.teaching.goal
}
