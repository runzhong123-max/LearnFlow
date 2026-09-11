import {useEffect,useState} from 'react'
import InteractiveHtmlPlayer from './InteractiveHtmlPlayer'
import VisualizeArtifact from './VisualizeArtifact'
import VisualHubStudio from './VisualHubStudio'
import './VisualHubPage.css'
type Row={id:string;version:string;title:string;description:string;kind:string[];curriculum:Array<{module_title:string;chapter:string;session:string}>}
type Request=(action:string,payload:Record<string,unknown>,signal?:AbortSignal)=>Promise<any>
function errorMessage(error:unknown){
 const message=error instanceof Error?error.message:String(error||'')
 return /failed to fetch|networkerror|network request failed/i.test(message)
  ? '暂时无法连接作品库，请检查网络后重试。'
  : message||'作品库加载失败，请重试。'
}
export default function VisualHubPage({request}:{request:Request}){
 const [view,setView]=useState<'gallery'|'studio'>('gallery');
 const [draft,setDraft]=useState(''),[query,setQuery]=useState(''),[module,setModule]=useState(''),[kind,setKind]=useState(''),[offset,setOffset]=useState(0),[retry,setRetry]=useState(0),[data,setData]=useState<{items:Row[];total:number;next_offset:number|null;modules:Array<{id:string;title:string}>}>({items:[],total:0,next_offset:null,modules:[]}),[selected,setSelected]=useState<Row|null>(null),[preview,setPreview]=useState<any>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[opening,setOpening]=useState(false);
 useEffect(()=>{const controller=new AbortController();setBusy(true);setError('');request('gallery',{query,...(module?{module_id:module}:{}),...(kind?{kind}:{}),offset,limit:16},controller.signal).then(value=>{if(!controller.signal.aborted)setData(value)}).catch(e=>{if(!controller.signal.aborted)setError(errorMessage(e))}).finally(()=>{if(!controller.signal.aborted)setBusy(false)});return()=>controller.abort()},[request,query,module,kind,offset,retry]);
 useEffect(()=>{setPreview(null);if(!selected)return;const controller=new AbortController();setOpening(true);setError('');request('preview',{id:selected.id,version:selected.version},controller.signal).then(value=>{if(!controller.signal.aborted)setPreview(value)}).catch(e=>{if(!controller.signal.aborted)setError(errorMessage(e))}).finally(()=>{if(!controller.signal.aborted)setOpening(false)});return()=>controller.abort()},[selected,request]);
 return <section className="visual-hub-page"><header><div><h1>图解与动画</h1><p>查找现有作品，或创建自己的教学图解。</p></div><span className="visual-hub-count">{busy?'加载中':`${data.total} 份作品`}</span></header>
 <nav className="visual-hub-tabs" aria-label="图解工作区"><button aria-pressed={view==='gallery'} onClick={()=>setView('gallery')}>作品库</button><button aria-pressed={view==='studio'} onClick={()=>setView('studio')}>我的创作</button><button className="primary" onClick={()=>setView('studio')}>＋ 新建作品</button></nav>
 <VisualHubStudio request={request} active={view==='studio'}/>
 <div hidden={view!=='gallery'}>
 <form className="visual-hub-toolbar" onSubmit={e=>{e.preventDefault();setQuery(draft);setOffset(0)}}><input aria-label="搜索图解与动画" placeholder="搜索知识点，例如：哈夫曼、注意力、分页" value={draft} onChange={e=>setDraft(e.target.value)} maxLength={1000}/><button type="submit">搜索</button><select aria-label="课程模块" value={module} onChange={e=>{setModule(e.target.value);setOffset(0)}}><option value="">全部模块</option>{data.modules.map(m=><option key={m.id} value={m.id}>{m.title}</option>)}</select><select aria-label="作品形式" value={kind} onChange={e=>{setKind(e.target.value);setOffset(0)}}><option value="">全部形式</option><option value="animation">动画</option><option value="diagram">图解</option></select></form>
 {error&&<div className="visual-hub-alert" role="alert"><span>{error}</span><button type="button" onClick={()=>setRetry(value=>value+1)}>重试</button></div>}
 {busy&&data.items.length===0?<div className="visual-hub-status" role="status">正在加载作品…</div>:null}
 {!busy&&!error&&data.items.length===0?<div className="visual-hub-zero"><span>◇</span><h2>没有找到作品</h2><p>换个关键词或筛选条件试试。</p></div>:null}
 {data.items.length>0?<div className="visual-hub-layout"><div><div className="visual-hub-list">{data.items.map(row=><button className={selected?.id===row.id?'selected':''} key={row.id+row.version} onClick={()=>setSelected(row)}><small>{row.kind.includes('animation')?'▶ 动画':'◇ 图解'} · {row.curriculum[0]?.module_title}</small><strong>{row.title}</strong><span>{row.description}</span></button>)}</div>
 <nav className="visual-hub-pagination" aria-label="作品分页"><button disabled={offset===0||busy} onClick={()=>setOffset(Math.max(0,offset-16))}>上一页</button><span>第 {Math.floor(offset/16)+1} 页</span><button disabled={data.next_offset===null||busy} onClick={()=>setOffset(data.next_offset!)}>下一页</button></nav></div>
 <aside aria-label="作品展示">{!selected?<div className="visual-hub-empty"><span>◇</span><h2>选择一份作品</h2><p>预览会显示在这里。</p></div>:<><div className="visual-hub-selected"><span>{selected.curriculum[0]?.chapter} · {selected.curriculum[0]?.session}</span><button onClick={()=>setSelected(null)} aria-label="关闭作品">×</button></div>{opening&&<p role="status">正在打开…</p>}{preview?.builder==='interactive_html'?<InteractiveHtmlPlayer key={selected.id} title={preview.title} html={preview.html}/>:preview?.bundle?<VisualizeArtifact publicPreview onRun={async params=>(await request('preview',{id:selected.id,version:selected.version,params})).bundle} key={selected.id} initial={preview.bundle} mode={selected.kind.includes('animation')?'animation':'diagram'} storageScope={'hub:'+selected.id+':'+selected.version} transport={(action,payload)=>request(action,payload)}/>:null}</>}</aside></div>:null}</div></section>
}
