/* Pure ordered forest layout. Cross-links remain the renderer's responsibility. */
function layoutTeachingTree(nodes, edges) {
  const gap = 28, forestGap = 44, margin = 24;
  const byId = new Map(nodes.map(node => [String(node.id), {
    id: String(node.id),
    w: Number.isFinite(node.w) && node.w > 0 ? node.w : 64,
    h: Number.isFinite(node.h) && node.h > 0 ? node.h : 38,
  }]));
  if (!byId.size) return { positions: new Map(), width: 600, height: 200 };
  const outgoing = new Map([...byId.keys()].map(id => [id, []]));
  const incoming = new Map([...byId.keys()].map(id => [id, 0]));
  edges.forEach((edge, order) => {
    const from = String(edge.from), to = String(edge.to);
    if (from === to || !byId.has(from) || !byId.has(to)) return;
    outgoing.get(from).push({ to, label: String(edge.label ?? ''), order });
    incoming.set(to, incoming.get(to) + 1);
  });
  // Binary prefix trees must preserve the semantic 0/1 order even when their
  // nodes or edges were registered in another order. Other edges retain order.
  for (const list of outgoing.values()) list.sort((a, b) => {
    const rank = edge => edge.label === '0' ? 0 : edge.label === '1' ? 1 : 2;
    return rank(a) - rank(b) || a.order - b.order;
  });
  const children = new Map([...byId.keys()].map(id => [id, []]));
  const roots = [], discovered = new Set(), queue = [], depth = new Map();
  const addRoot = id => {
    roots.push(id); discovered.add(id); queue.push(id); depth.set(id, 0);
  };
  for (const [id, count] of incoming) if (count === 0) addRoot(id);
  let cursor = 0;
  const discover = () => {
    for (; cursor < queue.length; cursor++) {
      const id = queue[cursor];
      for (const edge of outgoing.get(id)) {
        if (discovered.has(edge.to)) continue;
        discovered.add(edge.to);
        children.get(id).push(edge.to);
        depth.set(edge.to, depth.get(id) + 1);
        queue.push(edge.to);
      }
    }
  };
  discover();
  // Breadth-first discovery fixes the parent before following B+ leaf links.
  // A rootless cycle gets a finite spanning tree; its remaining links, including
  // self-loops, can still be drawn by the caller without recursive layout loops.
  for (const id of byId.keys()) if (!discovered.has(id)) { addRoot(id); discover(); }
  const subtreeWidth = new Map(), levelHeights = [];
  for (const [id, node] of byId) {
    const level = depth.get(id);
    levelHeights[level] = Math.max(levelHeights[level] || 0, node.h);
  }
  const measure = id => {
    const list = children.get(id);
    const contentWidth = list.reduce((sum, child) => sum + measure(child), 0) + Math.max(0, list.length - 1) * gap;
    const width = Math.max(byId.get(id).w, contentWidth);
    subtreeWidth.set(id, width);
    return width;
  };
  const contentWidth = roots.reduce((sum, id) => sum + measure(id), 0) + Math.max(0, roots.length - 1) * forestGap;
  const width = Math.max(600, contentWidth + margin * 2), levelY = [];
  let y = 46;
  for (const height of levelHeights) { levelY.push(y + height / 2); y += height + 64; }
  const height = Math.max(200, y - 64 + 28), positions = new Map();
  const place = (id, left) => {
    const span = subtreeWidth.get(id), list = children.get(id);
    positions.set(id, { x: left + span / 2, y: levelY[depth.get(id)], depth: depth.get(id) });
    const childWidth = list.reduce((sum, child) => sum + subtreeWidth.get(child), 0) + Math.max(0, list.length - 1) * gap;
    let childLeft = left + (span - childWidth) / 2;
    for (const child of list) { place(child, childLeft); childLeft += subtreeWidth.get(child) + gap; }
  };
  let left = (width - contentWidth) / 2;
  for (const id of roots) { place(id, left); left += subtreeWidth.get(id) + forestGap; }
  return { positions, width, height };
}

/* Shared drawing primitives for maintained lessons. Pure, offline, deterministic. */
const Viz = (() => {
  const colors=['#087f8c','#d57a19','#7250a3','#2d8a61','#bf5364'];
  const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const n=x=>Number.isFinite(Number(x))?Number(x):0;
  const fmt=x=>Math.abs(x)>=10000||Math.abs(x)>0&&Math.abs(x)<.001?x.toExponential(2):String(+x.toFixed(3));
  const text=(x,y,s,size=15,anchor='middle')=>`<text x="${n(x)}" y="${n(y)}" font-size="${size}" text-anchor="${anchor}" fill="currentColor">${escape(s)}</text>`;
  const line=(x1,y1,x2,y2,color='#82969c')=>`<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${color}" stroke-width="1.8"/>`;
  const rect=(x,y,w,h,fill='#edf4f1',stroke='#90aca0')=>`<rect x="${n(x)}" y="${n(y)}" width="${Math.max(0,n(w))}" height="${Math.max(0,n(h))}" rx="4" fill="${fill}" stroke="${stroke}"/>`;
  const svg=(body,width=600,height=320)=>`<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="当前输入的机制图" viewBox="0 0 ${width} ${height}" style="--scene-width:${width}px" preserveAspectRatio="xMidYMid meet">${body}</svg>`;
  function plot({series=[],points=[],openPoints=[],crosses=[],segments=[],xLabel='x',yLabel='y',xDomain,yDomain,equalAspect=false}={}) {
    const all=[...series.flatMap(s=>s.points||[]),...points,...openPoints,...crosses,...segments.flatMap(s=>[[s[0],s[1]],[s[2],s[3]]])].filter(p=>p.every(Number.isFinite));
    const domain=(axis,d)=>{if(d)return d; const vals=all.map(p=>p[axis]);let a=Math.min(0,...vals),b=vals.length?Math.max(0,...vals):1;if(a===b)b=a+1;return[a-(b-a)*.05,b+(b-a)*.05];};
    let [xa,xb]=domain(0,xDomain),[ya,yb]=domain(1,yDomain);if(equalAspect){const units=Math.max((xb-xa)/510,(yb-ya)/226),cx=(xa+xb)/2,cy=(ya+yb)/2;xa=cx-units*255;xb=cx+units*255;ya=cy-units*113;yb=cy+units*113;}const X=x=>55+(x-xa)/(xb-xa||1)*510,Y=y=>266-(y-ya)/(yb-ya||1)*226;
    let body='';
    for(let i=0;i<=4;i++){const x=xa+(xb-xa)*i/4,y=ya+(yb-ya)*i/4;body+=line(X(x),40,X(x),266,'#e2eae7')+line(55,Y(y),565,Y(y),'#e2eae7')+text(X(x),285,fmt(x),11)+text(46,Y(y)+4,fmt(y),11,'end');}
    body+=text(565,307,xLabel,12,'end')+text(55,24,yLabel,12,'start');
    body+='<svg x="55" y="40" width="510" height="226" viewBox="55 40 510 226">';
    series.forEach((s,i)=>{if(s.scatter){for(const [x,y] of s.points||[])body+=`<circle cx="${X(x)}" cy="${Y(y)}" r="4.5" fill="${s.color||colors[i%5]}"/>`;return;}let d='';let open=false;for(const p of s.points||[]){if(!p.every(Number.isFinite)){open=false;continue;}d+=(open?'L':'M')+X(p[0])+','+Y(p[1]);open=true;}body+=`<path d="${d}" fill="none" stroke="${s.color||colors[i%5]}" stroke-width="2.6"/>`;});
    segments.forEach((s,i)=>body+=line(X(s[0]),Y(s[1]),X(s[2]),Y(s[3]),colors[i%5]));
    points.forEach(([x,y],i)=>{if(Number.isFinite(x)&&Number.isFinite(y))body+=`<circle cx="${X(x)}" cy="${Y(y)}" r="4.5" fill="${colors[i%5]}" stroke="white" stroke-width="1.5"/>`;});
    openPoints.forEach(([x,y])=>{if(Number.isFinite(x)&&Number.isFinite(y))body+=`<circle cx="${X(x)}" cy="${Y(y)}" r="5" fill="white" stroke="${colors[0]}" stroke-width="2"/>`;});
    crosses.forEach(([x,y])=>{body+=line(X(x)-6,Y(y),X(x)+6,Y(y),'#25392f')+line(X(x),Y(y)-6,X(x),Y(y)+6,'#25392f');});body+='</svg>';
    const legend=series.filter(s=>s.label).map((s,i)=>`<span><i style="background:${s.color||colors[i%5]}"></i>${escape(s.label)}</span>`).join('');
    return svg(body)+ (legend?`<div class="scene-legend">${legend}</div>`:'');
  }
  function bars(values,labels=[],active=[]) {
    const a=Math.min(0,...values),b=Math.max(1e-9,...values),Y=x=>252-(x-a)/(b-a)*205,w=500/Math.max(1,values.length);
    let body=line(48,Y(0),558,Y(0));
    values.forEach((v,i)=>{const y=Y(v),h=Math.max(1,Math.abs(y-Y(0)));body+=rect(50+i*w,Math.min(y,Y(0)),Math.max(1,w-5),h,active.includes(i)?colors[1]:colors[0],'none');if(values.length<=24)body+=text(50+(i+.5)*w,y+(v<0?15:-7),fmt(v),11);if(values.length<=32||i%Math.ceil(values.length/16)===0)body+=text(50+(i+.5)*w,278,labels[i]??i,11);});
    return svg(body,600,302);
  }
  function cells(values,{active=[],labels=[]}={}) {
    return `<div class="scene-cells">${values.map((v,i)=>`<div class="scene-cell${active.includes(i)?' is-active':''}"><strong>${escape(v)}</strong><small>${escape(labels[i]??i)}</small></div>`).join('')}</div>`;
  }
  function matrix(rows,{active=[],title=''}={}) {
    const columns=Math.max(1,...rows.map(r=>r.length));
    return `<div class="scene-matrix-wrap">${title?`<p class="scene-caption">${escape(title)}</p>`:''}<div class="scene-matrix" style="grid-template-columns:repeat(${columns},minmax(34px,1fr))">${rows.flatMap((row,r)=>row.map((v,c)=>`<span class="${active.includes(r*columns+c)?'is-active':''}">${escape(typeof v==='number'?fmt(v):v)}</span>`)).join('')}</div></div>`;
  }
  function graph({nodes,edges,directed=true,layout='circle'}) {
    const byId=new Map(nodes.map((v,i)=>[String(v.id),{...v,id:String(v.id),i}]));
    const es=edges.filter(e=>byId.has(String(e.from))&&byId.has(String(e.to))).map(e=>({...e,from:String(e.from),to:String(e.to)}));
    const labelLines=s=>String(s).match(/.{1,12}/gu)||[''];
    nodes.forEach(v=>{const t=byId.get(String(v.id));t.lines=labelLines(v.label);t.w=Math.min(148,Math.max(64,...t.lines.map(s=>Array.from(s).reduce((a,c)=>a+(/[^\x00-\xff]/.test(c)?12:7),0)+20)));t.h=Math.max(38,t.lines.length*17+16);});
    let width=600,height=300;
    if(layout==='tree'){const layout=layoutTeachingTree([...byId.values()],es);width=layout.width;height=layout.height;for(const [id,pos]of layout.positions)Object.assign(byId.get(id),pos);
    } else if(layout==='flow') {
      const indegree=new Map(nodes.map(v=>[String(v.id),0]));es.forEach(e=>indegree.set(e.to,indegree.get(e.to)+1));
      const roots=[...indegree].filter(([,d])=>d===0).map(([id])=>id),levels=new Map(),queue=roots.length?roots:[String(nodes[0]?.id)];queue.forEach(id=>levels.set(id,0));
      for(let i=0;i<queue.length;i++){const id=queue[i];es.filter(e=>e.from===id).forEach(e=>{if(!levels.has(e.to)){levels.set(e.to,levels.get(id)+1);queue.push(e.to);}});}
      for(const v of byId.values())if(!levels.has(v.id))levels.set(v.id,0);
      const rows=[];for(const v of byId.values()){const l=levels.get(v.id);(rows[l]??=[]).push(v);}
      width=Math.max(600,...rows.map(row=>row.reduce((s,v)=>s+v.w+28,16)));height=Math.max(200,rows.length*102+45);
      rows.forEach((row,l)=>{let x=(width-row.reduce((s,v)=>s+v.w,0)-(row.length-1)*28)/2;row.forEach(v=>{v.x=x+v.w/2;v.y=65+l*102; x+=v.w+28;});});
    } else {
      width=Math.max(600,nodes.length*54);height=Math.max(300,Math.min(490,nodes.length*39));
      [...byId.values()].forEach((v,i)=>{const a=-Math.PI/2+i/Math.max(1,nodes.length)*Math.PI*2;v.x=width/2+Math.cos(a)*(width/2-88);v.y=height/2+Math.sin(a)*(height/2-78);});
    }
    // Reserve actual loop bounds in the viewBox, including pointer loops on trees.
    const loopNodes=es.filter(e=>e.from===e.to).map(e=>byId.get(e.from));
    for(const v of loopNodes)v.loopSide=v.y<height/2?-1:1;
    const top=Math.min(0,...loopNodes.filter(v=>v.loopSide<0).map(v=>v.y-v.h/2-44));
    if(top<12&&loopNodes.some(v=>v.loopSide<0)){const shift=12-top;for(const v of byId.values())v.y+=shift;height+=shift;}
    height=Math.max(height,...loopNodes.filter(v=>v.loopSide>0).map(v=>v.y+v.h/2+50));
    let body='<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 1 L 9 5 L 0 9" fill="none" stroke="context-stroke" stroke-width="1.5"/></marker></defs>';
    es.forEach(e=>{const a=byId.get(e.from),b=byId.get(e.to);if(e.from===e.to){const side=a.loopSide,base=a.y+side*a.h/2,tip=base+side*38;body+=`<path d="M${a.x-14},${base} C${a.x-46},${tip} ${a.x+46},${tip} ${a.x+14},${base}" fill="none" stroke="#82969c"${directed?' marker-end="url(#arrow)"':''}/>`+text(a.x,base+side*25+(side>0?7:0),e.label||'',11);return;}let dx=b.x-a.x,dy=b.y-a.y;const clip=(v)=>{const f=1/Math.max(Math.abs(dx)/(v.w/2+3),Math.abs(dy)/(v.h/2+3),.0001);return f;};const ca=clip(a),cb=clip(b),x1=a.x+dx*ca,y1=a.y+dy*ca,x2=b.x-dx*cb,y2=b.y-dy*cb;const reciprocal=es.some(o=>o!==e&&o.from===e.to&&o.to===e.from);const d=reciprocal?`M${x1},${y1} Q${(x1+x2)/2-dy*.15},${(y1+y2)/2+dx*.15} ${x2},${y2}`:`M${x1},${y1} L${x2},${y2}`;
      body+=`<path d="${d}" fill="none" stroke="${e.active?colors[1]:'#82969c'}" stroke-width="${e.active?3:1.5}"${directed?' marker-end="url(#arrow)"':''}/>`;
      if(e.label){const x=(a.x+b.x)/2+(reciprocal?-dy*.075:0),y=(a.y+b.y)/2+(reciprocal?dx*.075:0)-7;body+=`<text x="${x}" y="${y}" text-anchor="middle" font-size="11" fill="currentColor" stroke="var(--background,#fff)" stroke-width="5" paint-order="stroke">${escape(e.label)}</text>`;}
    });
    for(const v of byId.values()){body+=rect(v.x-v.w/2,v.y-v.h/2,v.w,v.h,v.active?'#f9e8cf':'#eef5f2',v.active?colors[1]:'#9eb9af');v.lines.forEach((s,i)=>body+=text(v.x,v.y-(v.lines.length-1)*8.5+i*17+4,s,12));}
    return `<div class="scene-graph" style="--graph-min:${Math.min(width,560)}px">${svg(body,width,height)}</div>`;
  }
  const flow=(labels,active=[])=>`<div class="scene-flow">${labels.map((s,i)=>`${i?'<span aria-hidden="true">→</span>':''}<span class="scene-flow-node${active.includes(i)?' is-active':''}">${escape(s)}</span>`).join('')}</div>`;
  return {colors,escape,text,line,rect,svg,plot,bars,matrix,cells,graph,flow};
})();
