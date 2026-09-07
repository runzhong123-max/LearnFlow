/** Presentation only: preserve every node and edge; lay out rooted graphs by breadth. */
export function graphLayout(nodes: string[], edges: string[][], labels: Record<string,string>, available: number, directed: boolean) {
 const widths=Object.fromEntries(nodes.map(n=>[n,Math.max(48,Math.min(154,[...(labels[n]||n)].reduce((s,c)=>s+(c.charCodeAt(0)>255?13:7),0)+24))]));
 const incoming=new Set(edges.filter(e=>e[0]!==e[1]).map(e=>e[1]));
 const roots=nodes.filter(n=>!incoming.has(n));
 const positions:Record<string,[number,number]>={}; let width=available,height=180;
 if(directed&&roots.length){
  const levels: string[][]=[];const seen=new Set<string>();const queue:Array<[string,number]>=roots.map(n=>[n,0]);
  while(queue.length){const[n,d]=queue.shift()!;if(seen.has(n))continue;seen.add(n);(levels[d]??=[]).push(n);for(const e of edges)if(e[0]===n&&!seen.has(e[1]))queue.push([e[1],d+1]);}
  const remaining=nodes.filter(n=>!seen.has(n));if(remaining.length)levels.push(remaining);
  for(const row of levels){const max=Math.max(72,Math.floor((available-40-Math.max(0,row.length-1)*20)/Math.max(1,row.length)));for(const n of row)widths[n]=Math.min(widths[n],max)}
  const spans=levels.map(row=>row.reduce((s,n)=>s+widths[n],0)+Math.max(0,row.length-1)*20);
  width=Math.max(available,...spans.map(s=>s+40));height=Math.max(96,levels.length*94);
  levels.forEach((row,d)=>{let x=(width-spans[d])/2;for(const n of row){positions[n]=[x+widths[n]/2,44+d*94];x+=widths[n]+20;}});
 }else{
  width=Math.max(available,300);height=Math.max(200,Math.min(380,nodes.length*40));
  const rx=Math.max(60,(width-180)/2),ry=(height-65)/2;
  nodes.forEach((n,i)=>{const a=2*Math.PI*i/Math.max(1,nodes.length)-Math.PI/2;positions[n]=[width/2+rx*Math.cos(a),height/2+ry*Math.sin(a)];});
 }
 return{positions,widths,width,height};
}
