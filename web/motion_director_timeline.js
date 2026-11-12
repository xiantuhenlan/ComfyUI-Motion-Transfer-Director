import {activeShot,clipBounds,timelineClips,trimShot,splitShot,locateTimelineTime} from './motion_director_core.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clock=n=>{const m=Math.floor(n/60),s=n-m*60;return `${String(m).padStart(2,'0')}:${s.toFixed(2).padStart(5,'0')}`;};
export function mountTimeline(root,project,actions){
    const section=document.createElement('section');section.className='mt-timeline';
    section.innerHTML=`<header><h2>分镜剪辑</h2><button data-split disabled>✂ 切分分镜</button><button data-set-in disabled>设为入点</button><button data-set-out disabled>设为出点</button><label class="mt-timeline-zoom">时间轴<input data-timeline-zoom type="range" min="0.25" max="4" step="0.05" value="1" aria-label="时间轴缩放"><output data-zoom-value>100%</output></label><span class="mt-trim-fields"><label>源入点 <input data-in type="number" step="0.01" min="0" aria-label="当前分镜源入点（秒）" disabled></label><label>源出点 <input data-out type="number" step="0.01" min="0" aria-label="当前分镜源出点（秒）" disabled></label></span><span data-timeline-position>00:00.00 / 00:00.00</span></header><div class="mt-timeline-scroll"><div class="mt-timeline-canvas"><div class="mt-time-ruler"><div data-ruler></div></div><div class="mt-track"><div class="mt-track-label"><span>源视频轨道</span><div class="mt-track-controls"><button type="button" data-track-kind="source" data-track-toggle="audio">声音</button><button type="button" data-track-kind="source" data-track-toggle="video">视频</button></div></div><div class="mt-track-lane mt-source-lane" data-source-lane></div></div><div class="mt-track"><div class="mt-track-label"><span data-result-track-title>替换角色图</span><div class="mt-track-controls"><button type="button" data-track-kind="result" data-track-toggle="audio">声音</button><button type="button" data-track-kind="result" data-track-toggle="video">视频</button></div></div><div class="mt-track-lane mt-image-lane" data-image-lane></div></div></div></div><footer>点击时间尺定位 · 拖动视频块两端裁剪 · 下排生成视频与角色参考按分镜一一对应 <span data-clip-duration></span></footer>`;
    root.querySelector('.mt-statusbar').before(section);
    const applyButton=document.createElement('button');applyButton.dataset.applyTrim='';applyButton.textContent='应用裁剪';applyButton.disabled=true;section.querySelector('.mt-trim-fields').after(applyButton);
    const deleteButton=document.createElement('button');deleteButton.type='button';deleteButton.dataset.deleteClip='';deleteButton.textContent='删除片段';section.querySelector('[data-split]').after(deleteButton);deleteButton.onclick=()=>{if(drag)endDrag(drag);actions.onDeleteShot?.();};
    const q=s=>section.querySelector(s);let drag=null,suppressSeekClick=false,zoom=1,edgeFrame=null,edgeTime=null;
    const selected=()=>timelineClips(project).find(c=>c.shot.id===project.activeShotId);
    const sourcePosition=()=>{const c=selected();return c?Math.max(c.start,Math.min(c.end,c.start+project.playhead-c.timelineStart)):0;};
    const positionLabel=q('[data-timeline-position]');
    let total=0,layoutKey=null;
    function refreshPosition(){project.playhead=Math.max(0,Math.min(project.playhead,total));const label=clock(project.playhead)+' / '+clock(total);if(positionLabel.textContent!==label)positionLabel.textContent=label;section.style.setProperty('--mt-playhead',(total?project.playhead/total*100:0)+'%');}
    function renderScale(total,keepCenter=false){
        const viewport=q('.mt-timeline-scroll'),canvas=q('.mt-timeline-canvas'),oldWidth=canvas.getBoundingClientRect().width||viewport.clientWidth||620;
        const center=(viewport.scrollLeft+viewport.clientWidth/2)/oldWidth;
        const targetWidth=Math.max(620,total*35,viewport.clientWidth)*zoom;
        canvas.style.minWidth=`${targetWidth}px`;
        const width=canvas.getBoundingClientRect().width||targetWidth;
        const raw=total/Math.max(1,(width-100)/90),unit=raw>0?10**Math.floor(Math.log10(raw)):1;
        const step=[1,2,5,10].map(n=>n*unit).find(n=>n>=raw)||unit*10;
        let ticks='';if(total)for(let t=0;t<=total;t+=step)ticks+=`<span style="left:${t/total*100}%">${clock(t)}</span>`;
        q('[data-ruler]').innerHTML=ticks+'<i class="mt-timeline-cursor"></i>';
        q('[data-zoom-value]').textContent=`${Math.round(zoom*100)}%`;
        if(keepCenter)viewport.scrollLeft=Math.max(0,center*width-viewport.clientWidth/2);
    }
    q('[data-timeline-zoom]').oninput=e=>{zoom=Number(e.target.value);renderScale(timelineClips(project).at(-1)?.timelineEnd||0,true);refreshPosition();};
    function render(){
        const clips=timelineClips(project);
        total=clips.at(-1)?.timelineEnd||0;
        const key=JSON.stringify(clips.map(({shot,start,end})=>[shot.id,shot.name,start,end,shot.character?.url,shot.character?.name,shot.resultUrl,shot.results?.at(-1)?.file?.filename,actions.isResultUnavailable?.(shot.resultUrl)]));
        if(layoutKey===key){refreshTrackControls();refreshSelection();return;}
        layoutKey=key;
        renderScale(total);
        q('[data-source-lane]').innerHTML=clips.length?clips.map(c=>`<div role="button" tabindex="0" aria-label="源视频 ${esc(c.shot.name)}" data-source-clip="${c.shot.id}" class="mt-source-clip ${c.shot.id===project.activeShotId?'active':''}" style="left:${c.timelineStart/total*100}%;width:${c.duration/total*100}%"><button data-trim="in" data-trim-shot="${c.shot.id}" aria-label="拖动调整${esc(c.shot.name)}入点"></button><div><b>${esc(c.shot.name)}</b><small>${clock(c.start)} → ${clock(c.end)} · ${c.duration.toFixed(2)}秒</small></div><button data-trim="out" data-trim-shot="${c.shot.id}" aria-label="拖动调整${esc(c.shot.name)}出点"></button></div>`).join('')+'<i class="mt-timeline-cursor"></i>':'<span class="mt-track-empty">上传视频后，在这里裁剪和切分分镜</span>';
        q('[data-image-lane]').innerHTML=clips.length?clips.map(c=>{
            const generated=Boolean(c.shot.resultUrl&&!actions.isResultUnavailable?.(c.shot.resultUrl)),file=c.shot.results?.at(-1)?.file;
            const thumbnail=c.shot.character?`<img src="${esc(c.shot.character.url)}" alt="" loading="lazy" decoding="async">`:'<i>＋</i>';
            const media=generated?`<span class="mt-result-thumbnail">${c.shot.character?thumbnail:""}<i aria-hidden="true">▶</i></span>`:thumbnail;
            return `<button data-image-clip="${c.shot.id}" data-generated="${generated}" class="mt-image-clip ${c.shot.id===project.activeShotId?'active':''}" style="left:${c.timelineStart/total*100}%;width:${c.duration/total*100}%" title="${generated?'选择生成视频分镜':'选择替换角色图'}">${media}<span><b>${esc(c.shot.name)}</b><small>${esc(generated?(file?.filename||'生成视频'):c.shot.character?.name||'点击选择替换角色图')}</small></span></button>`;
        }).join('')+'<i class="mt-timeline-cursor"></i>':'<span class="mt-track-empty">角色图片与对应视频分镜对齐</span>';
        q('[data-result-track-title]').textContent=clips.some(c=>c.shot.resultUrl&&!actions.isResultUnavailable?.(c.shot.resultUrl))?'生成视频轨道':'替换角色图';
        refreshTrackControls();
        refreshSelection();
    }
    function refreshSelection(){
        const c=selected(),bounds=c&&clipBounds(c.shot);
        for(const element of section.querySelectorAll('[data-source-clip],[data-image-clip]'))element.classList.toggle('active',(element.dataset.sourceClip||element.dataset.imageClip)===project.activeShotId);
        for(const s of ['[data-split]','[data-set-in]','[data-set-out]','[data-in]','[data-out]','[data-apply-trim]'])q(s).disabled=!bounds;
        deleteButton.disabled=!bounds||Boolean(actions.isBusy?.());
        q('[data-in]').value=bounds?bounds.start.toFixed(2):'';q('[data-out]').value=bounds?bounds.end.toFixed(2):'';q('[data-in]').max=q('[data-out]').max=bounds?.sourceDuration||0;
        q('[data-clip-duration]').textContent=bounds?`${c.shot.name} · ${bounds.duration.toFixed(2)} 秒`:'';refreshPosition();
    }
    function refreshTrackControls(){
        for(const button of section.querySelectorAll('[data-track-toggle]')){
            const kind=button.dataset.trackKind,key=button.dataset.trackToggle,enabled=actions.trackStates?.[kind]?.[key]!==false;
            button.classList.toggle('off',!enabled);button.setAttribute('aria-pressed',String(enabled));
            button.title=(enabled?'关闭':'打开')+(key==='audio'?'声音':'视频');button.setAttribute('aria-label',(kind==='source'?'源视频轨道':'生成视频轨道')+button.title);
            if(key==='video')button.closest('.mt-track').dataset.videoDisabled=String(!enabled);
        }
    }
    function applyTrim(start,end){try{const shot=activeShot(project);trimShot(shot,start,end);actions.onChange();}catch(e){actions.onError(e.message);render();}}
    q('[data-in]').onchange=()=>{const b=clipBounds(activeShot(project));if(b)applyTrim(Number(q('[data-in]').value),b.end);};q('[data-out]').onchange=()=>{const b=clipBounds(activeShot(project));if(b)applyTrim(b.start,Number(q('[data-out]').value));};
    q('[data-apply-trim]').onclick=()=>applyTrim(Number(q('[data-in]').value),Number(q('[data-out]').value));
    q('[data-set-in]').onclick=()=>{const b=clipBounds(activeShot(project));if(b)applyTrim(sourcePosition(),b.end);};q('[data-set-out]').onclick=()=>{const b=clipBounds(activeShot(project));if(b)applyTrim(b.start,sourcePosition());};
    q('[data-split]').onclick=()=>{try{splitShot(project,project.activeShotId,sourcePosition());actions.onChange();}catch(e){actions.onError(e.message);}};
    section.onclick=e=>{
        if(suppressSeekClick){suppressSeekClick=false;e.preventDefault();return;}
        const toggle=e.target.closest('[data-track-toggle]');if(toggle){actions.onTrackToggle?.(toggle.dataset.trackKind,toggle.dataset.trackToggle);refreshTrackControls();return;}
        if(e.target.closest('[data-trim]'))return;
        const image=e.target.closest('[data-image-clip]');if(image){if(image.dataset.generated==='true'){actions.onSelectShot(image.dataset.imageClip);focusClip('image');}else actions.onPickCharacter(image.dataset.imageClip);return;}
        const source=e.target.closest('[data-source-clip]');if(source){actions.onSelectShot(source.dataset.sourceClip);focusClip('source');return;}
        const lane=e.target.closest('[data-ruler], [data-source-lane]');if(!lane)return;const clips=timelineClips(project),total=clips.at(-1)?.timelineEnd||0,rect=lane.getBoundingClientRect();if(!total)return;
        const located=locateTimelineTime(project,(e.clientX-rect.left)/rect.width*total);actions.onSeek(located);
    };
    function focusClip(kind){for(const element of section.querySelectorAll(`[data-${kind}-clip]`))if(element.dataset[kind+'Clip']===project.activeShotId){element.focus({preventScroll:true});break;}}
    section.onkeydown=e=>{const clip=e.target.closest('[data-source-clip],[data-image-clip]');if(!clip)return;if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();if(drag)endDrag(drag);actions.onSelectShot(clip.dataset.sourceClip||clip.dataset.imageClip);actions.onDeleteShot?.();focusClip(clip.dataset.sourceClip?'source':'image');return;}if(clip.dataset.sourceClip&&(e.key==='Enter'||e.key===' ')){e.preventDefault();actions.onSelectShot(clip.dataset.sourceClip);focusClip('source');}};
    function seekPointer(clientX){const total=timelineClips(project).at(-1)?.timelineEnd||0,rect=q('[data-ruler]').getBoundingClientRect();if(total&&rect.width)actions.onSeek(locateTimelineTime(project,Math.max(0,Math.min(1,(clientX-rect.left)/rect.width))*total));}
    function seekDrag(){if(drag?.kind!=='seek')return;const rect=q('.mt-timeline-scroll').getBoundingClientRect();seekPointer(Math.max(rect.left,Math.min(rect.right,drag.clientX)));}
    function edgeVelocity(){
        if(drag?.kind!=='seek')return 0;
        const rect=q('.mt-timeline-scroll').getBoundingClientRect(),zone=Math.min(64,rect.width/5);
        if(!zone)return 0;
        if(drag.clientX<rect.left+zone)return -600*Math.min(1,(rect.left+zone-drag.clientX)/zone);
        if(drag.clientX>rect.right-zone)return 600*Math.min(1,(drag.clientX-rect.right+zone)/zone);
        return 0;
    }
    function stopEdgeScroll(){if(edgeFrame!=null)cancelAnimationFrame(edgeFrame);edgeFrame=null;edgeTime=null;}
    function scrollDrag(timestamp){
        edgeFrame=null;if(drag?.kind!=='seek'||!section.isConnected){stopEdgeScroll();return;}
        const viewport=q('.mt-timeline-scroll'),speed=edgeVelocity(),before=viewport.scrollLeft;
        const seconds=edgeTime==null?1/60:Math.min(.05,Math.max(0,(timestamp-edgeTime)/1000));edgeTime=timestamp;
        viewport.scrollLeft=Math.max(0,Math.min(Math.max(0,viewport.scrollWidth-viewport.clientWidth),before+speed*seconds));
        if(viewport.scrollLeft===before){stopEdgeScroll();return;}
        seekDrag();edgeFrame=requestAnimationFrame(scrollDrag);
    }
    function updateEdgeScroll(){if(!edgeVelocity()){stopEdgeScroll();return;}if(edgeFrame==null){edgeTime=null;edgeFrame=requestAnimationFrame(scrollDrag);}}
    section.onpointerdown=e=>{const handle=e.target.closest('[data-trim]');if(e.button!==0)return;
        if(!handle&&e.target.closest('.mt-timeline-cursor,[data-ruler]')){if(!timelineClips(project).length)return;drag={kind:'seek',pointerId:e.pointerId,clientX:e.clientX};suppressSeekClick=true;section.setPointerCapture(e.pointerId);seekDrag();updateEdgeScroll();e.preventDefault();return;}
        if(!handle)return;const shot=project.shots.find(s=>s.id===handle.dataset.trimShot),bounds=clipBounds(shot),clips=timelineClips(project),total=clips.at(-1)?.timelineEnd||0;if(!bounds||!total)return;actions.onSelectShot(shot.id);drag={id:shot.id,edge:handle.dataset.trim,x:e.clientX,bounds,total,width:q('[data-source-lane]').getBoundingClientRect().width,pointerId:e.pointerId};section.setPointerCapture(e.pointerId);e.preventDefault();};
    section.onpointermove=e=>{if(!drag||e.pointerId!==drag.pointerId)return;if(drag.kind==='seek'){drag.clientX=e.clientX;seekDrag();updateEdgeScroll();e.preventDefault();return;}const shot=project.shots.find(s=>s.id===drag.id);if(!shot)return;const delta=(e.clientX-drag.x)/drag.width*drag.total,b=drag.bounds;
        const start=drag.edge==='in'?Math.max(0,Math.min(b.end-.001,b.start+delta)):b.start;
        const end=drag.edge==='out'?Math.min(b.sourceDuration,Math.max(b.start+.001,b.end+delta)):b.end;
        trimShot(shot,start,end);actions.onChange();e.preventDefault();};
    function endDrag(e){if(drag?.pointerId!==e.pointerId)return;const wasSeek=drag.kind==='seek';stopEdgeScroll();drag=null;if(wasSeek)setTimeout(()=>{suppressSeekClick=false;},0);if(section.hasPointerCapture(e.pointerId))section.releasePointerCapture(e.pointerId);}
    section.onpointerup=section.onpointercancel=section.onlostpointercapture=endDrag;
    return {render,refreshSelection,refreshPosition,refreshTrackControls};
}
