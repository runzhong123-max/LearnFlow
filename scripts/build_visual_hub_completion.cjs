/* Compile maintained teaching sources into independent immutable documents. */
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),hub=path.join(root,'packages/learning-core/src/learnflow_core/visuals/hub'),author=path.join(hub,'authoring');
const ts=require(path.join(root,'frontend/node_modules/typescript'));
const curriculum=JSON.parse(fs.readFileSync(path.join(hub,'curriculum.json'))),works=JSON.parse(fs.readFileSync(path.join(hub,'works.json')));
const sessions=new Map(curriculum.modules.flatMap(m=>m.chapters.flatMap(c=>c.sessions.map(s=>[s.id,{session:s,module:m,chapter:c}]))));
const runtime=fs.readFileSync(path.join(author,'completion-runtime.js'),'utf8'),player=fs.readFileSync(path.join(author,'completion-player.js'),'utf8'),css=fs.readFileSync(path.join(author,'completion.css'),'utf8');
function load(file){const lessons=[];const context=vm.createContext({register:x=>lessons.push(x),console});vm.runInContext(runtime,context);vm.runInContext(fs.readFileSync(file,'utf8'),context,{filename:file,timeout:10000});return lessons;}
function finite(value,p='values'){if(typeof value==='number'&&!Number.isFinite(value))throw Error(`nonfinite ${p}`);if(value&&typeof value==='object')for(const [k,v]of Object.entries(value))finite(v,p+'.'+k);}
function verify(lesson){
 if(!sessions.has(lesson.session)||!lesson.question||!lesson.scope||!lesson.takeaway||!lesson.title)throw Error('missing teaching identity '+lesson.id);
 if(!lesson.controls?.length)throw Error('no substantive input '+lesson.id);
 const defaults=Object.fromEntries(lesson.controls.map(c=>[c.id,c.value])),variants=[defaults];
 for(const c of lesson.controls){const values=c.type==='select'?c.options.map(o=>o.value):[c.min,c.max];for(const value of values)variants.push({...defaults,[c.id]:value});}
 const hashes=new Set();let maxFrames=0;
 for(const p of variants){const result=lesson.compute(p);if(!result?.frames?.length||result.frames.length>200)throw Error('invalid frames '+lesson.id);maxFrames=Math.max(maxFrames,result.frames.length);
  for(const f of result.frames){if(typeof f.svg!=='string'||!f.svg.trim()||!f.note||!f.values)throw Error('empty scene or explanation '+lesson.id);if(/(?:NaN|Infinity)/.test(f.svg))throw Error('nonfinite geometry '+lesson.id);finite(f.values);}
  hashes.add(JSON.stringify(result.frames.map(f=>[f.svg,f.values])));
 }
 if(hashes.size<2)throw Error('inputs do not change mechanism '+lesson.id);
 return {parameter_cases:variants.length,max_frames:maxFrames,checked:['compute','finite_values','scene_changes','bounded_steps']};
}
function prune(source,session){
 const ast=ts.createSourceFile('lesson.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),cuts=[];
 function visit(node){if(ts.isExpressionStatement(node)&&ts.isCallExpression(node.expression)){const arg=node.expression.arguments[0];if(arg&&ts.isStringLiteral(arg)&&sessions.has(arg.text)&&arg.text!==session){cuts.push([node.getStart(ast),node.end]);return;}}ts.forEachChild(node,visit);}
 visit(ast);for(const [a,b]of cuts.sort((a,b)=>b[0]-a[0]))source=source.slice(0,a)+source.slice(b);return source.replace(/^[\t ]+$/gm,'');
}
const report=[];const files=fs.readdirSync(path.join(author,'completion')).filter(f=>f.endsWith('.js')).sort();
for(const name of files){const file=path.join(author,'completion',name),source=fs.readFileSync(file,'utf8');
 for(const lesson of load(file)){
  let checks;try{checks=verify(lesson);}catch(e){throw Error(lesson.id+': '+e.message);}
  const version=lesson.version||'1.0.0',filename=lesson.id+'-'+version+'.html';
  const script=`${runtime}\n${player}\nlet selectedLesson;function register(lesson){if(lesson.id===${JSON.stringify(lesson.id)})selectedLesson=lesson;}\n${prune(source,lesson.session)}\nmountLesson(selectedLesson);`;
  const fragment=`<section data-course="${lesson.id}"></section><style>${css}</style><script>${script.replace(/<\/script/gi,'<\\/script')}</script>`;
  const hash=crypto.createHash('sha256').update(fragment).digest('hex'),existing=works.find(w=>w.id===lesson.id&&w.version===version);
  // Before publication the completion build may be iterated; immutable versions
  // already present in git are never overwritten by an accidental rebuild.
  if(existing&&existing.sha256!==hash&&require('node:child_process').spawnSync('git',['cat-file','-e',`HEAD:packages/learning-core/src/learnflow_core/visuals/hub/works/${filename}`],{cwd:root}).status===0)throw Error('Published version would change: '+filename);
  fs.writeFileSync(path.join(hub,'works',filename),fragment);
  const link=sessions.get(lesson.session),candidate=link.session.visual_candidates.find(c=>c.status==='planned'&&c.id===lesson.session+'.visual')||link.session.visual_candidates.find(c=>c.status==='planned')||link.session.visual_candidates.find(c=>c.work_refs.some(r=>r.id===lesson.id));
  const entry={id:lesson.id,version,title:lesson.title,description:lesson.description,file:filename,session_ids:[lesson.session],questions:[lesson.question,lesson.takeaway],kind:checks.max_frames>1?['diagram','animation']:['diagram'],scope:lesson.scope,sha256:hash,status:'ready',builder:'interactive_html',aliases:[...(lesson.aliases||[]),link.module.title,link.chapter.title,link.session.title,...(candidate?.concepts||[])],quality:{...checks,review:'See docs/VISUAL_HUB_COMPLETION.md for semantic and browser review scope'}};
  const legacyPath=path.join(hub,'..','library',lesson.id+'.1.0.0.json');
  if(fs.existsSync(legacyPath)){const legacy=JSON.parse(fs.readFileSync(legacyPath));entry.aliases=[...new Set([...entry.aliases,...legacy.aliases,...legacy.retrieval.questions])];entry.retrieval={...legacy.retrieval,questions:[...new Set([...legacy.retrieval.questions,...entry.questions])]};}
  if(existing)works.splice(works.indexOf(existing),1,entry);else works.push(entry);
  if(lesson.id.startsWith('course-')){const c=candidate||link.session.visual_candidates.find(c=>c.work_refs.some(r=>r.id===lesson.id));if(!c)throw Error('no candidate '+lesson.id);c.status='ready';c.work_refs=[{id:lesson.id,version}];}
  else for(const m of curriculum.modules)for(const ch of m.chapters)for(const s of ch.sessions)for(const c of s.visual_candidates)for(const ref of c.work_refs)if(ref.id===lesson.id)ref.version=version;
  report.push({id:lesson.id,version,session:lesson.session,file:filename,...checks});
 }
}
fs.writeFileSync(path.join(hub,'works.json'),JSON.stringify(works,null,2)+'\n');fs.writeFileSync(path.join(hub,'curriculum.json'),JSON.stringify(curriculum,null,2)+'\n');
fs.writeFileSync(path.join(author,'completion-checks.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({built:report.length,parameterCases:report.reduce((n,r)=>n+r.parameter_cases,0),planned:curriculum.modules.flatMap(m=>m.chapters.flatMap(c=>c.sessions.flatMap(s=>s.visual_candidates))).filter(c=>c.status==='planned').length}));
