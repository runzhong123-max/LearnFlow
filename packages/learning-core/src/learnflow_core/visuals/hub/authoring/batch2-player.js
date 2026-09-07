(()=>{
 const root=document.querySelector('[data-hub-demo]'),cfg=JSON.parse(root.dataset.config),q=s=>root.querySelector(s),esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),num=v=>typeof v==='number'?Number(v.toFixed(3)):v;
 let p=cfg[6],frames=[],step=0,timer=null;const reduced=matchMedia('(prefers-reduced-motion: reduce)');
 const colors=['var(--viz-series-1)','var(--viz-series-2)','var(--viz-series-3)'];
 const tx=(x,y,t,size=16)=>`<text x="${x}" y="${y}" text-anchor="middle" fill="var(--foreground)" font-size="${size}">${esc(t)}</text>`;
 const ln=(x,y,a,b,c=colors[0])=>`<line x1="${x}" y1="${y}" x2="${a}" y2="${b}" stroke="${c}" stroke-width="2"/>`;
 const svg=body=>`<svg viewBox="0 0 600 330" role="img" aria-label="${esc(cfg[1])}当前状态">${body}</svg>`;
 const cells=(a,active=[])=>`<div class="cells">${a.map((v,i)=>`<span class="${active.includes(i)?'active':''}"><b>${esc(num(v))}</b><small>${i}</small></span>`).join('')}</div>`;
 const matrix=(a,active=[])=>`<div class="matrix" style="grid-template-columns:repeat(${a[0].length},1fr)">${a.flat().map((v,i)=>`<span class="${active.includes(i)?'active':''}">${v===null?'·':esc(num(v))}</span>`).join('')}</div>`;
 function draw(){const s=frames[step];let html='';
 if(s.graph){const g=s.graph,ind=new Map(g.nodes.map(n=>[n.id,0])),children=new Map();g.edges.forEach(e=>{ind.set(e.b,(ind.get(e.b)||0)+1);children.set(e.a,[...(children.get(e.a)||[]),e.b])});const roots=g.nodes.filter(n=>!ind.get(n.id)),pos=new Map();
 if(roots.length&&g.edges.every(e=>(ind.get(e.b)||0)<=1)&&g.edges.length<g.nodes.length){let levels=[],visited=new Set(),queue=roots.map(n=>[n.id,0]);while(queue.length){let[id,d]=queue.shift();if(visited.has(id))continue;visited.add(id);(levels[d]??=[]).push(id);queue.push(...(children.get(id)||[]).map(c=>[c,d+1]))}levels.forEach((ids,d)=>ids.forEach((id,i)=>pos.set(id,[40+(i+.5)*520/ids.length,40+d*250/Math.max(1,levels.length-1)])))}
 else g.nodes.forEach((n,i)=>{let t=i*2*Math.PI/g.nodes.length-Math.PI/2;pos.set(n.id,[300+220*Math.cos(t),165+120*Math.sin(t)])});
 let body='<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="24" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="var(--viz-series-1)"/></marker></defs>'+g.edges.map(e=>{const a=pos.get(e.a),b=pos.get(e.b);return ln(...a,...b,'var(--border)').replace('/>',e.directed?' marker-end="url(#arrow)"/>':'/>')+tx((a[0]+b[0])/2,(a[1]+b[1])/2-5,e.label||'',13)}).join('');
 body+=g.nodes.map(n=>{let[x,y]=pos.get(n.id);return `<rect x="${x-36}" y="${y-19}" width="72" height="38" rx="16" fill="var(--background)" stroke="${(g.active||[]).includes(n.id)?colors[0]:'var(--border)'}" stroke-width="3"/>`+tx(x,y+5,n.label,13)}).join('');html=svg(body);
 }else if(s.plot||s.points){let data=[...(s.plot||[]),...(s.points||[]),...(s.centers||[]),...(s.segments||[]).flatMap(a=>[[a[0],a[1]],[a[2],a[3]]])],xs=data.map(v=>v[0]),ys=data.map(v=>v[1]),xmin=Math.min(0,...xs),xmax=Math.max(1,...xs),ymin=Math.min(0,...ys),ymax=Math.max(1,...ys),X=x=>45+(x-xmin)/(xmax-xmin)*510,Y=y=>280-(y-ymin)/(ymax-ymin)*250;
 let body=ln(45,280,560,280,'var(--border)')+ln(45,25,45,280,'var(--border)')+tx(45,310,num(xmin))+tx(550,310,num(xmax))+tx(25,35,num(ymax),12)+tx(25,280,num(ymin),12);
 if(s.plot)body+=`<polyline points="${s.plot.map(([x,y])=>X(x)+','+Y(y)).join(' ')}" fill="none" stroke="${colors[0]}" stroke-width="3"/>`;
 body+=(s.segments||[]).map(a=>ln(X(a[0]),Y(a[1]),X(a[2]),Y(a[3]),colors[1])).join('');body+=(s.points||[]).map(([x,y],i)=>`<circle cx="${X(x)}" cy="${Y(y)}" r="6" fill="${colors[s.classes?.[i]??1]}"/>`).join('');body+=(s.centers||[]).map(([x,y])=>ln(X(x)-8,Y(y),X(x)+8,Y(y),'var(--foreground)')+ln(X(x),Y(y)-8,X(x),Y(y)+8,'var(--foreground)')).join('');html=svg(body);
 }else if(s.bars){const a=s.bars,min=Math.min(0,...a),max=Math.max(1e-9,...a),Y=v=>275-(v-min)/(max-min)*240,zero=Y(0),w=520/a.length;html=svg(a.map((v,i)=>{let x=40+i*w;return `<rect x="${x+2}" y="${Math.min(zero,Y(v))}" width="${Math.max(2,w-4)}" height="${Math.max(1,Math.abs(zero-Y(v)))}" fill="${(s.active||[]).includes(i)?colors[1]:colors[0]}"/>`+(a.length<=16?tx(x+w/2,Math.max(20,Math.min(zero,Y(v))-8),num(v),13):'')+((i%Math.max(1,Math.ceil(a.length/14)))===0?tx(x+w/2,305,s.labels?.[i]??i,12):'')}).join(''));
 }else if(s.matrix)html=`<div class="matrices"><div><small>输入 / 当前矩阵</small>${matrix(s.matrix,s.active)}</div>${s.output?'<div><small>输出</small>'+matrix(s.output)+'</div>':''}</div>`;
 else if(s.timeline){const total=s.timeline.at(-1).end;html='<div class="timeline">'+s.timeline.map(t=>`<span style="flex:${t.end-t.start};background:${colors[+t.label.slice(1)%3]}">${esc(t.label)}<small>${t.start}–${t.end}</small></span>`).join('')+'</div>'+cells([`总时间 ${total}`]);}
 else if(s.ring){let coord=n=>[300+125*Math.cos(n*2*Math.PI/100-Math.PI/2),160+125*Math.sin(n*2*Math.PI/100-Math.PI/2)];html=svg(`<circle cx="300" cy="160" r="125" fill="none" stroke="var(--border)"/>`+s.ring.map(n=>{let[x,y]=coord(n);return `<circle cx="${x}" cy="${y}" r="16" fill="${colors[0]}"/>`+tx(x,y+5,n)}).join('')+s.keys.map(k=>{let[x,y]=coord(k);return `<circle cx="${x}" cy="${y}" r="4" fill="${colors[1]}"/>`}).join(''))}
 else if(s.chain)html='<div class="flow">'+s.chain.map((c,i)=>`<span>${esc(c)}</span>${i<s.chain.length-1?'<b>→</b>':''}`).join('')+'</div>';
 else if(s.cells)html=cells(s.cells,s.active);
 q('[data-scene]').innerHTML=html;q('[data-note]').textContent=s.note;q('[data-formula]').textContent=s.formula||'';q('[data-progress]').textContent=`${step+1} / ${frames.length}`;q('[data-seek]').max=frames.length-1;q('[data-seek]').value=step;q('[data-prev]').disabled=step===0;q('[data-next]').disabled=step===frames.length-1;q('[data-transport]').hidden=frames.length<2;q('[data-seek]').hidden=frames.length<2;
 root.__state=s;
 }
 function stop(){clearInterval(timer);timer=null;q('[data-play]').textContent=reduced.matches?'下一步':'播放'}
 function build(){stop();frames=buildHubModel(cfg[0],p);step=0;draw()}
 q('[data-param]').oninput=e=>{p=+e.target.value;q('[data-value]').textContent=p;build()};
 q('[data-prev]').onclick=()=>{stop();step=Math.max(0,step-1);draw()};q('[data-next]').onclick=()=>{stop();step=Math.min(frames.length-1,step+1);draw()};q('[data-seek]').oninput=e=>{stop();step=+e.target.value;draw()};
 q('[data-play]').onclick=()=>{if(timer){stop();return}if(step===frames.length-1)step=0;if(reduced.matches){step=Math.min(frames.length-1,step+1);draw();return}q('[data-play]').textContent='暂停';timer=setInterval(()=>{step++;draw();if(step===frames.length-1)stop()},650)};
 reduced.addEventListener('change',stop);root.__audit={compute:value=>buildHubModel(cfg[0],value),get frames(){return frames}};build();
})();
