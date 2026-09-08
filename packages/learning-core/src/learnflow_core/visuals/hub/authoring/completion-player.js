/* Host only supplies a fixed maintained lesson; no generated scripts enter here. */
function mountLesson(lesson) {
  const root=document.querySelector('[data-course]');
  const $=s=>root.querySelector(s),params={},defaults={};let frames=[],index=0,timer=null,zoomed=false;
  const esc=Viz.escape;
  root.innerHTML=`<header><p class="course-eyebrow">动手看机制</p><h2>${esc(lesson.title)}</h2><p class="course-question">${esc(lesson.question)}</p></header><div class="course-inputs"></div><div class="course-scene"></div><div class="course-view-tools"><span data-pan-hint hidden>左右滑动查看完整图形</span><button data-zoom hidden>放大图形</button></div><p class="course-note" aria-live="polite"></p><div class="course-playback"><div class="course-buttons"><button data-prev aria-label="上一步">‹</button><button data-play class="course-primary">▶ 播放</button><button data-next aria-label="下一步">›</button><output data-progress></output><select data-speed aria-label="播放速度"><option value="1400">1×</option><option value="2200">0.6×</option><option value="700">2×</option></select></div><input data-seek type="range" min="0" value="0" aria-label="当前步骤"/></div><div class="course-bottom"><p class="course-takeaway">${esc(lesson.takeaway)}</p><button data-reset>重置</button></div><details class="course-comparison"><summary>比较不同输入的最终结果</summary><div data-baseline></div><p data-baseline-note></p></details><details class="course-details"><summary>数据与演示范围</summary><dl data-values></dl><p>${esc(lesson.scope)}</p></details><p class="course-error" role="alert" hidden></p>`;
  function stop(){if(timer)clearInterval(timer);timer=null;$('[data-play]').textContent=index===frames.length-1?'↻ 重播':'▶ 播放';}
  function compare(){if(!$('.course-comparison').open)return;const initial=lesson.compute({...defaults}).frames.at(-1),current=frames.at(-1);$('[data-baseline]').innerHTML='<p class="scene-caption">当前输入 · 最终结果</p>'+current.svg+'<p>'+esc(current.note)+'</p><p class="scene-caption">初始输入 · 最终结果</p>'+initial.svg;$('[data-baseline-note]').textContent=lesson.controls.map(c=>c.label+'='+(c.type==='select'?c.options.find(o=>o.value===c.value)?.label:c.value)).join('，')+'。'+initial.note;}

  function sizeHint(){const scene=$('.course-scene');$('[data-pan-hint]').hidden=![scene,...scene.querySelectorAll('div')].some(e=>e.scrollWidth>e.clientWidth+3);$('[data-zoom]').hidden=!scene.querySelector('.scene-graph');}
  function paint(){
    const f=frames[index];$('.course-scene').innerHTML=f.svg;$('.course-note').textContent=f.note;
    $('[data-progress]').textContent=`${index+1} / ${frames.length}`;$('[data-seek]').value=String(index);
    $('[data-prev]').disabled=index===0;$('[data-next]').disabled=index===frames.length-1;
    const format=v=>typeof v==='number'?(Number.isInteger(v)?String(v):String(+v.toPrecision(6))):typeof v==='object'?JSON.stringify(v):String(v);
    $('[data-values]').innerHTML=Object.entries(f.values||{}).map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(format(v))}</dd>`).join('');
    $('.course-scene').classList.toggle('is-zoomed',zoomed);$('[data-play]').textContent=timer?'Ⅱ 暂停':index===frames.length-1?'↻ 重播':'▶ 播放';sizeHint();compare();root.dataset.frame=String(index);root.dataset.frames=String(frames.length);
  }
  function recompute(){stop();try{const r=lesson.compute({...params});if(!r||!Array.isArray(r.frames)||!r.frames.length||r.frames.length>200)throw Error('步骤数量异常');frames=r.frames;index=0;const widths=$('.course-scene').clientWidth||600;const heights=frames.map(f=>{const box=/viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(f.svg);return box?widths*Number(box[2])/Number(box[1]):170;});$('.course-scene').style.minHeight=frames.length>1?Math.max(180,Math.min(340,Math.max(...heights)+28))+'px':'auto';$('.course-playback').hidden=frames.length===1;$('[data-seek]').max=String(frames.length-1);$('.course-error').hidden=true;paint();root.dataset.ready='true';}catch(e){root.dataset.ready='false';$('.course-error').hidden=false;$('.course-error').textContent='这个输入暂时无法计算，请重置后重试。';console.error(e);}}
  for(const c of lesson.controls){
    params[c.id]=defaults[c.id]=c.type==='select'?String(c.value):Number(c.value);
    const label=document.createElement('label');label.innerHTML=`<span>${esc(c.label)} <output></output></span>`;
    const input=document.createElement(c.type==='select'?'select':'input');input.setAttribute('aria-label',c.label);input.dataset.param=c.id;
    if(c.type==='select'){input.innerHTML=c.options.map(o=>`<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');}else{input.type='range';input.min=c.min;input.max=c.max;input.step=c.step||1;}
    input.value=String(c.value);label.querySelector('output').textContent=c.type==='range'?input.value:'';
    input.addEventListener('input',()=>{params[c.id]=c.type==='select'?input.value:Math.min(c.max,Math.max(c.min,Number(input.value)));label.querySelector('output').textContent=c.type==='range'?input.value:'';recompute();});label.append(input);$('.course-inputs').append(label);
  }
  $('[data-prev]').onclick=()=>{stop();index=Math.max(0,index-1);paint();};$('[data-next]').onclick=()=>{stop();index=Math.min(frames.length-1,index+1);paint();};
  $('[data-seek]').oninput=e=>{stop();index=Number(e.target.value);paint();};
  function play(){if(timer){stop();return;}if(index===frames.length-1)index=0;timer=setInterval(()=>{index++;paint();if(index===frames.length-1)stop();},Number($('[data-speed]').value));paint();}
  $('[data-play]').onclick=play;$('[data-speed]').onchange=()=>{if(timer){stop();play();}};
  $('[data-reset]').onclick=()=>{for(const c of lesson.controls){params[c.id]=defaults[c.id];const input=root.querySelector(`[data-param="${c.id}"]`);input.value=String(c.value);input.parentElement.querySelector('output').textContent=c.type==='range'?input.value:'';}recompute();};
  $('[data-zoom]').onclick=()=>{zoomed=!zoomed;$('.course-scene').classList.toggle('is-zoomed',zoomed);$('[data-zoom]').textContent=zoomed?'适合窗口':'放大图形';sizeHint();};
  new ResizeObserver(sizeHint).observe($('.course-scene'));
  $('.course-comparison').ontoggle=compare;
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});
  recompute();
}
