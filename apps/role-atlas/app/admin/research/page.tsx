"use client";
import { useEffect, useState } from "react";
import "./research.css";
import { ownerId, ownerName, matchesOwner } from "@/lib/research-collection/owners";
type Row=Record<string, unknown>;
type Run=Row & {id:string;kind:string;status:string;started_at:string};
type Project=Row & {id:string;title:string;owner_subject_id:string|null;run_count:number};
type Attachment=Row & {id:string;filename:string;byte_size:number;run_count?:number};
const names:Record<string,string>={intake:"岗位澄清 / 说明",cold_start:"冷启动",iteration:"迭代 / 深化",workspace:"工作区接入",risk:"风险检查",legacy_risk:"旧版风险检查",completed:"已完成",running:"运行中",failed:"失败",cancelled:"已取消",pending:"等待中",ready:"就绪",published:"已发布",applied:"已应用",unchanged:"无变化",clarify:"岗位澄清",draft:"岗位说明",refine:"说明改进"};
const label=(x:unknown)=>names[String(x)]||String(x??"—");
const date=(x:unknown)=>x?String(x).replace("T"," ").slice(0,19):"—";
const size=(n:number)=>n>1024*1024?`${(n/1024/1024).toFixed(1)} MB`:`${Math.ceil(n/1024)} KB`;
async function read<T=Row>(query:string,signal?:AbortSignal):Promise<T>{const res=await fetch(`/api/admin/research${query}`,{cache:"no-store",signal});const data=await res.json() as {error?:string};if(!res.ok)throw new Error(res.status===401?"请先登录管理员账户。":res.status===403?"此页面仅供管理员使用。":data.error||"读取失败，请刷新重试。");return data as T;}
function Json({value}:{value:unknown}){return <pre className="research-json">{JSON.stringify(value??null,null,2)}</pre>;}
function Download({query,children}:{query:string;children:React.ReactNode}){return <a className="research-download" href={`/api/admin/research/export${query}`} download>{children}</a>;}
function Call({call}:{call:Row}) {
 const [data,setData]=useState<unknown>(),[error,setError]=useState("");
 return <details onToggle={event=>{if(event.currentTarget.open&&!data&&!error)void read(`?callId=${encodeURIComponent(String(call.id))}`).then(setData).catch(e=>setError(e.message));}}><summary>{String(call.model)} · {label(call.status)} · {date(call.started_at)}</summary>{error?<p role="alert">{error}</p>:data?<Json value={data}/>:<p>正在读取请求与响应…</p>}</details>;
}
export default function ResearchAdminPage() {
 const [index,setIndex]=useState<{projects:Project[];attachments:Attachment[];attachmentCount:number}|null>(null);
 const [userFilter,setUserFilter]=useState("");
 const [error,setError]=useState(""),[search,setSearch]=useState(""),[project,setProject]=useState<Project|null>(null);
 const [records,setRecords]=useState<{runs:Run[];releases:Row[]}|null>(null),[run,setRun]=useState<Run|null>(null),[detail,setDetail]=useState<Row|null>(null);
 const [section,setSection]=useState("inputs"),[filter,setFilter]=useState(""),[uploads,setUploads]=useState(false),[refresh,setRefresh]=useState(0);
 useEffect(()=>{const controller=new AbortController();void read<NonNullable<typeof index>>("",controller.signal).then(setIndex).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();},[refresh]);
 useEffect(()=>{setRecords(null);if(!project)return;const controller=new AbortController();void read<NonNullable<typeof records>>(`?projectId=${encodeURIComponent(project.id)}`,controller.signal).then(setRecords).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();},[project,refresh]);
 useEffect(()=>{setDetail(null);if(!run)return;const controller=new AbortController();void read(`?runId=${encodeURIComponent(run.id)}&kind=${run.kind}`,controller.signal).then(setDetail).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();},[run,refresh]);
 const scope=new URLSearchParams({...(project?{projectId:project.id}:{}),...(run?{runId:run.id,kind:run.kind}:{})});
 const users=Array.from(new Set([...(index?.projects||[]),...(index?.attachments||[])].map(ownerId).filter(Boolean))).sort();
 const selected=(index?.projects||[]).filter(p=>matchesOwner(p,userFilter)&&`${p.title} ${ownerId(p)} ${ownerName(p)}`.toLowerCase().includes(search.trim().toLowerCase()));
 const visibleUploads=(index?.attachments||[]).filter(a=>matchesOwner(a,userFilter)&&`${a.filename} ${ownerId(a)}`.toLowerCase().includes(search.trim().toLowerCase()));
 const attachments=(detail?.attachments||[]) as Attachment[];
 return <main className="research-admin">
  <header><div><a href="/">← 返回 Role Atlas</a><p className="research-eyebrow">ADMIN · RESEARCH ARCHIVE</p><h1>测试数据中心</h1><p>管理员可查看所有用户的测试数据，从首次输入到迭代与发布，保留每轮研究的依据与结果。</p></div>{index?<Download query="">一键导出全部</Download>:null}</header>
  {error?<div role="alert" className="research-error">{error}</div>:null}
  {!index?<p>{error?"使用管理员账户登录后刷新此页。":"正在验证管理员身份…"}</p>:<>
   <div className="research-toolbar"><span>全部用户 · {users.length} 个已归属用户 · {index.projects.length} 个项目 · {index.projects.reduce((n,p)=>n+p.run_count,0)} 次运行 · {index.attachmentCount} 份原件</span><button onClick={()=>{setError("");setRefresh(x=>x+1);}}>刷新</button></div>
   <div className="research-layout">
    <aside><label className="research-user-filter">用户<select aria-label="按用户筛选" value={userFilter} onChange={e=>{setUserFilter(e.target.value);setProject(null);setRun(null);setError("");}}><option value="">全部用户</option>{users.map(id=><option key={id} value={id}>{id}</option>)}<option value="unassigned">历史未归属</option></select></label><input aria-label="搜索项目、附件或用户 ID" placeholder="搜索项目、附件或用户 ID" value={search} onChange={e=>setSearch(e.target.value)}/><button className={uploads?"selected":""} onClick={()=>{setUploads(true);setProject(null);setRun(null);}}>附件存档 <small>含未提交、解析失败的附件</small></button>
     {selected.map(p=><button key={p.id} className={project?.id===p.id?"selected":""} onClick={()=>{setProject(p);setRun(null);setUploads(false);setError("");}}><strong>{p.title}</strong><small>{ownerName(p)} · {p.run_count} 次{p.deleted_at?" · 已回收":""}</small><small className="research-owner-id">用户 ID：{ownerId(p)||"未记录"}</small></button>)}
     {!selected.length?<p>没有匹配的项目。</p>:null}
    </aside>
    <section className="research-content">
     {uploads?<><h2>附件存档</h2><p>原件按上传者隔离保存；尚未提交的文件也可导出分析。列表最多显示最新 500 份，全部导出包含完整存档。</p>{visibleUploads.map(a=><div className="research-row" key={a.id}><span><strong>{a.filename}</strong><small>用户 ID：{ownerId(a)||"未记录"} · {size(a.byte_size)} · {a.run_count||0} 次引用</small></span><Download query={`?attachmentId=${a.id}`}>原件</Download></div>)}{!visibleUploads.length?<p>当前筛选下没有附件。</p>:null}</>:!project?<div className="research-empty"><h2>选择项目，查看完整研究历史</h2><p>输入与附件、模型请求、结果与版本、发布记录均可分别导出。<br/>需要交给 AI 分析时，直接使用右上角“一键导出全部”。此操作导出全部用户数据，不受列表筛选影响。</p><p>历史未采集的原件或模型请求无法补回；未记录不等于未发生。</p></div>:<>
      <div className="research-heading"><div><h2>{project.title}</h2><small>用户：{ownerName(project)}</small><small className="research-owner-id">用户 ID：{ownerId(project)||"未记录（历史未归属）"}</small><small>项目 ID：{project.id}</small></div><Download query={`?projectId=${encodeURIComponent(project.id)}`}>导出项目</Download></div>
      {!records?<p>正在读取历史…</p>:<>
       <label>运行类型 <select value={filter} onChange={e=>setFilter(e.target.value)}><option value="">全部</option>{Object.entries(names).slice(0,6).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
       <div className="research-runs">{records.runs.filter(r=>!filter||r.kind===filter).map(r=><button className={run?.id===r.id&&run.kind===r.kind?"selected":""} key={`${r.kind}:${r.id}`} onClick={()=>{setRun(r);setSection("inputs");}}><strong>{r.kind==="intake"?label(r.action):label(r.kind)} <span className={`research-status ${r.status}`}>{label(r.status)}</span></strong><small>{date(r.started_at)} · {r.id}</small></button>)}{!records.runs.length?<p>这个项目还没有执行记录。</p>:null}</div>
       <div className="research-heading"><h3>{run?`${label(run.kind)} · 本轮详情`:"项目发布记录"}</h3>{run?<Download query={`?${scope}`}>导出本轮</Download>:null}</div>
       <div className="research-tabs">{(run?[["inputs","输入与资料"],["calls","模型调用"],["results","结果与版本"],["releases","发布记录"]]:[["releases","发布记录"]]).map(([k,v])=><button className={(run?section:"releases")===k?"selected":""} key={k} onClick={()=>setSection(k)}>{v}</button>)}<Download query={`?${scope}&section=${run?section:"releases"}`}>导出此类</Download></div>
       {run&&!detail?<p>正在读取本轮记录…</p>:run&&detail&&section!=="releases"?<>
        {section==="inputs"?<><p>实际提交的提示词、选项、URL 与解析正文。原件可单独下载。</p>{attachments.map(a=><div className="research-row" key={a.id}><span>{a.filename} · {size(a.byte_size)}</span><Download query={`?attachmentId=${a.id}`}>原件</Download></div>)}<Json value={detail.input}/><details><summary>提交 / 重试记录（{(detail.attempts as Row[]).length} 次）</summary><Json value={detail.attempts}/></details></>:null}
        {section==="calls"?<><p>实际模型请求与响应。旧记录无法补采；无调用也可能是缓存命中或确定性检查。</p>{(detail.calls as Row[]).map(c=><Call key={String(c.id)} call={c}/>)}{!(detail.calls as Row[]).length?<p>本轮没有已采集的模型调用。</p>:null}</>:null}
        {section==="results"?<><p>{Number(detail.eventCount)} 条执行事件。完整事件、基线及结果版本见导出文件。</p>{detail.error?<p role="alert">{String(detail.error)}</p>:null}<details open><summary>本轮状态与结果</summary><Json value={detail.result}/></details><details><summary>执行进度 / 检查点</summary><Json value={detail.checkpoint}/></details><details><summary>事件索引（最多 200 条）</summary><Json value={detail.events}/></details></>:null}
       </>:<><p>项目发布历史包含编译、校验与发布状态。按本轮导出时，仅导出该轮产生版本对应的发布记录。</p>{records.releases.length?records.releases.map(r=><details key={String(r.id)}><summary>{String(r.package_version)} · {label(r.status)} · {date(r.created_at)}</summary><Json value={r}/></details>):<p>尚无发布记录。</p>}</>}
      </>}
     </>}
    </section>
   </div><footer>用户 ID 为系统记录的身份主体标识；历史未归属不会自动认领。列表筛选不影响“一键导出全部”的范围。分析包为 ZIP，内含结构化 JSON、附件原件与校验清单。采集不改变图谱结果；模型生成不作为学习掌握证据。</footer>
  </>}
 </main>;
}
