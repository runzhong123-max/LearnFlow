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
/** An icon states the action by itself, so the buttons that use one stay square
 *  and label-free; the accessible name lives on the button. */
const ICONS={
 search:'M10.5 3a7.5 7.5 0 1 1-4.7 13.3l-3.3 3.3-1.4-1.4 3.3-3.3A7.5 7.5 0 0 1 10.5 3Zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z',
 back:'M12.7 4.3 7 10l5.7 5.7-1.4 1.4L4.2 10l7.1-7.1 1.4 1.4Z',
 forward:'M7.3 4.3 13 10l-5.7 5.7 1.4 1.4L15.8 10 8.7 2.9 7.3 4.3Z',
 refresh:'M10 3a7 7 0 0 1 6.2 3.8l1.6-1v6.4l-5.5-3.2 1.8-1A5 5 0 1 0 15 10h2a7 7 0 1 1-7-7Z',
 close:'M4.3 2.9 10 8.6l5.7-5.7 1.4 1.4L11.4 10l5.7 5.7-1.4 1.4L10 11.4l-5.7 5.7-1.4-1.4L8.6 10 2.9 4.3l1.4-1.4Z',
 plus:'M9 3h2v6h6v2h-6v6H9v-6H3V9h6V3Z',
}
function Icon({name}:{name:keyof typeof ICONS}){
 return <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false"><path d={ICONS[name]}/></svg>
}
export default function VisualHubPage({request}:{request:Request}){
 const [view,setView]=useState<'gallery'|'studio'>('gallery');
 const [draft,setDraft]=useState(''),[query,setQuery]=useState(''),[module,setModule]=useState(''),[kind,setKind]=useState(''),[offset,setOffset]=useState(0),[retry,setRetry]=useState(0),[data,setData]=useState<{items:Row[];total:number;next_offset:number|null;modules:Array<{id:string;title:string}>}>({items:[],total:0,next_offset:null,modules:[]}),[selected,setSelected]=useState<Row|null>(null),[preview,setPreview]=useState<any>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[opening,setOpening]=useState(false);
 useEffect(()=>{const controller=new AbortController();setBusy(true);setError('');request('gallery',{query,...(module?{module_id:module}:{}),...(kind?{kind}:{}),offset,limit:16},controller.signal).then(value=>{if(!controller.signal.aborted)setData(value)}).catch(e=>{if(!controller.signal.aborted)setError(errorMessage(e))}).finally(()=>{if(!controller.signal.aborted)setBusy(false)});return()=>controller.abort()},[request,query,module,kind,offset,retry]);
 useEffect(()=>{setPreview(null);if(!selected)return;const controller=new AbortController();setOpening(true);setError('');request('preview',{id:selected.id,version:selected.version},controller.signal).then(value=>{if(!controller.signal.aborted)setPreview(value)}).catch(e=>{if(!controller.signal.aborted)setError(errorMessage(e))}).finally(()=>{if(!controller.signal.aborted)setOpening(false)});return()=>controller.abort()},[selected,request]);
 return <section className="visual-hub-page">
 <header className="page-hero"><div><h1>图解与动画</h1><p>查找现有作品，或创建自己的教学图解。</p></div><span className="visual-hub-count">{busy?'加载中':`${data.total} 份作品`}</span></header>
 <nav className="visual-hub-tabs" aria-label="图解工作区"><button aria-pressed={view==='gallery'} onClick={()=>setView('gallery')}>作品库</button><button aria-pressed={view==='studio'} onClick={()=>setView('studio')}>我的创作</button><button className="primary icon-button" type="button" aria-label="新建作品" title="新建作品" onClick={()=>setView('studio')}><Icon name="plus"/></button></nav>
 <VisualHubStudio request={request} active={view==='studio'}/>
 <div hidden={view!=='gallery'}>
 <form className="visual-hub-toolbar" onSubmit={e=>{e.preventDefault();setQuery(draft);setOffset(0)}}><input aria-label="搜索图解与动画" placeholder="搜索知识点，例如：哈夫曼、注意力、分页" value={draft} onChange={e=>setDraft(e.target.value)} maxLength={1000}/><button className="icon-button" type="submit" aria-label="搜索" title="搜索"><Icon name="search"/></button><select aria-label="课程模块" value={module} onChange={e=>{setModule(e.target.value);setOffset(0)}}><option value="">全部模块</option>{data.modules.map(m=><option key={m.id} value={m.id}>{m.title}</option>)}</select><select aria-label="作品形式" value={kind} onChange={e=>{setKind(e.target.value);setOffset(0)}}><option value="">全部形式</option><option value="animation">动画</option><option value="diagram">图解</option></select></form>
 {error&&<div className="visual-hub-alert" role="alert"><span>{error}</span><button className="icon-button" type="button" aria-label="重试" title="重试" onClick={()=>setRetry(value=>value+1)}><Icon name="refresh"/></button></div>}
 {busy&&data.items.length===0?<div className="visual-hub-status" role="status">正在加载作品…</div>:null}
 {!busy&&!error&&data.items.length===0?<div className="visual-hub-zero"><span aria-hidden="true">◇</span><h2>没有找到作品</h2><p>换个关键词或筛选条件试试。</p></div>:null}
 {data.items.length>0?<div className="visual-hub-layout"><div><div className="visual-hub-list">{data.items.map(row=><button className={selected?.id===row.id?'selected':''} key={row.id+row.version} onClick={()=>setSelected(row)}><small>{row.kind.includes('animation')?'▶ 动画':'◇ 图解'} · {row.curriculum[0]?.module_title}</small><strong>{row.title}</strong><span>{row.description}</span></button>)}</div>
 <nav className="visual-hub-pagination" aria-label="作品分页"><button className="icon-button" type="button" disabled={offset===0||busy} aria-label="上一页" title="上一页" onClick={()=>setOffset(Math.max(0,offset-16))}><Icon name="back"/></button><span>第 {Math.floor(offset/16)+1} 页</span><button className="icon-button" type="button" disabled={data.next_offset===null||busy} aria-label="下一页" title="下一页" onClick={()=>setOffset(data.next_offset!)}><Icon name="forward"/></button></nav></div>
 <aside aria-label="作品展示">{!selected?<div className="visual-hub-empty"><span aria-hidden="true">◇</span><h2>选择一份作品</h2><p>预览会显示在这里。</p></div>:<><div className="visual-hub-selected"><span>{selected.curriculum[0]?.chapter} · {selected.curriculum[0]?.session}</span><button className="icon-button" type="button" onClick={()=>setSelected(null)} aria-label="关闭作品" title="关闭作品"><Icon name="close"/></button></div>{opening&&<p role="status">正在打开…</p>}{preview?.builder==='interactive_html'?<InteractiveHtmlPlayer key={selected.id} title={preview.title} html={preview.html}/>:preview?.bundle?<VisualizeArtifact publicPreview onRun={async params=>(await request('preview',{id:selected.id,version:selected.version,params})).bundle} key={selected.id} initial={preview.bundle} mode={selected.kind.includes('animation')?'animation':'diagram'} storageScope={'hub:'+selected.id+':'+selected.version} transport={(action,payload)=>request(action,payload)}/>:null}</>}</aside></div>:null}</div></section>
}
