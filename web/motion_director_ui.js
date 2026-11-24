import {createProject,activeShot,addShot,selectShot,deleteShot,selectedShotIds,initializeShotSelection,setAllShotsSelected,setShotSelected,clipBounds,timelineClips,generationAspects,generationResolution,generationSelection,globalGenerationSettings,planDirectorRun} from './motion_director_core.js';
import {mountTimeline} from './motion_director_timeline.js';
import {createPreviewTransport} from './motion_director_playback.js';
import {createMediaPreloader,createResultPreview} from './motion_director_result_preview.js';
const paths={video:'<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4"/>',person:'<circle cx="12" cy="7" r="3"/><path d="M5 21v-3a7 7 0 0 1 14 0v3"/>',layers:'<path d="m12 3 10 5-10 5L2 8Zm-10 10 10 5 10-5M2 18l10 5 10-5"/>',play:'<path d="m9 5 11 7-11 7Z"/>',pause:'<path d="M8 5v14M16 5v14"/>',plus:'<path d="M12 5v14M5 12h14"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',close:'<path d="m6 6 12 12M18 6 6 18"/>',check:'<path d="m5 12 4 4 10-10"/>'};
const icon=(name,size=20)=>`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]||paths.layers}</svg>`;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=n=>Number.isFinite(n)?`${String(Math.floor(n/60)).padStart(2,'0')}:${String(Math.floor(n%60)).padStart(2,'0')}`:'00:00';
export function openMotionDirector(options={}){
 if(!document.querySelector('[data-motion-style]')){const s=document.createElement('link');s.rel='stylesheet';s.href=new URL('./motion_director.css',import.meta.url).href;s.dataset.motionStyle='1';document.head.append(s);}
 const session=options.session||{},hadProject=Boolean(session.project),project=session.project||createProject(),urls=session.urls||new Set();session.project=project;session.urls=urls;
 const runtime=session.run??={busy:false,phase:'等待生成',startedAt:null,elapsedMs:0,value:0,max:1,listeners:new Set()};
 let closed=false,timeline,playback=null,resultPreview=null,renderedShotId=null,displayedResultShotId=null,displayedResultUrl=null,pendingVideoShot=null,pendingCharacterShot=null,runClock=null,hardwareClock=null,hardwareBusy=false,completedRuns=0,saveClock=null,unsubscribeRun=null;
 const runSettings={cache:false,vram:false,models:false,every:1,monitorHardware:true,scope:'sequence',...options.initialSettings};
 const mediaUrl=path=>{const parts=path.replaceAll('\\','/').split('/'),filename=parts.pop();return new URL(`api/view?${new URLSearchParams({type:'input',filename,subfolder:parts.join('/')})}`,document.baseURI).href;};
 const restoreAsset=asset=>asset?.inputPath?{...asset,url:mediaUrl(asset.inputPath)}:null;
 const initial=options.initialShot;
 if(!hadProject&&initial?.projectState?.shots?.length){project.shots=initial.projectState.shots.map(shot=>({...shot,results:shot.results||[],video:restoreAsset(shot.video),character:restoreAsset(shot.character),additionalCharacters:(shot.additionalCharacters||[]).map(restoreAsset).filter(Boolean)}));project.activeShotId=project.shots.some(s=>s.id===initial.projectState.activeShotId)?initial.projectState.activeShotId:project.shots[0].id;project.playhead=initial.projectState.playhead||0;}
 else if(!hadProject&&initial?.video&&initial?.character){const shot=activeShot(project);Object.assign(shot,{id:initial.id||shot.id,name:initial.name||shot.name,mode:initial.mode||'motion',prompt:initial.originalPrompt??initial.prompt??'',generationWidth:initial.generationWidth,generationHeight:initial.generationHeight,generationAspect:initial.generationAspect,generationMegapixels:initial.generationMegapixels,refImageSize:initial.refImageSize,referenceVideoMode:initial.referenceVideoMode,referenceVideoWidth:initial.referenceVideoWidth,referenceVideoHeight:initial.referenceVideoHeight,inPoint:initial.inPoint,outPoint:initial.outPoint,video:{inputPath:initial.video,url:mediaUrl(initial.video),name:initial.video.split('/').at(-1),duration:initial.duration,width:initial.width,height:initial.height},character:{inputPath:initial.character,url:mediaUrl(initial.character),name:initial.character.split('/').at(-1)},additionalCharacters:(initial.additionalCharacters||[]).map(inputPath=>({inputPath,url:mediaUrl(inputPath),name:inputPath.split('/').at(-1)}))});project.activeShotId=shot.id;}
 if(!hadProject&&initial?.projectState?.generationSettings)project.generationSettings={...initial.projectState.generationSettings};
 if(!hadProject&&initial?.projectState?.selectedShotIds)project.selectedShotIds=initial.projectState.selectedShotIds;
 if(!hadProject&&initial?.projectState?.shotSelectionInitialized)project.shotSelectionInitialized=true;
 initializeShotSelection(project);
 const generation=globalGenerationSettings(project);
 generation.filenamePrefix??=initial?.filenamePrefix||'';
 if(!hadProject&&initial?.projectState?.previewTracks)project.previewTracks=initial.projectState.previewTracks;
 const trackStates=project.previewTracks??={source:{audio:true,video:true},result:{audio:true,video:true}};trackStates.source??={audio:true,video:true};trackStates.result??={audio:true,video:true};
 const resultFailures=new Map();
 const previewFiles=createMediaPreloader({onChange:previewFileReady});
 let playRequested=false;
 async function persistProject(){try{await options.onSaveProject?.(project);}catch(error){if(!closed)message('保存分镜失败：'+error.message);}}
 function scheduleSave(){clearTimeout(saveClock);saveClock=setTimeout(()=>void persistProject(),350);}
 const root=document.createElement('section');root.className='xmt';root.setAttribute('role','dialog');root.setAttribute('aria-label','闲兔动作迁移角色替换导演台');
 root.innerHTML=`<header class="mt-head"><div class="mt-brand"><i>${icon('layers',25)}</i><div><h1>闲兔 <span>动作迁移 · 角色替换导演台</span></h1><small>MOTION TRANSFER DIRECTOR</small></div></div><b class="mt-preview-badge">UI 预览</b><span class="mt-status">● 等待素材 <small>尚未接入生成工作流</small></span><button class="mt-generate" disabled title="UI预览，不会提交任务">${icon('play',15)}开始生成</button><button class="mt-icon" data-close aria-label="关闭导演台">${icon('close')}</button></header>
 <nav class="mt-toolbar mt-toolbar-shots" aria-label="分镜列表"></nav>
 <div class="mt-workspace"><aside class="mt-assets">
 <div class="mt-material-slot" data-video-slot>
  <div class="mt-material-grid">
   <button type="button" class="mt-material-add" data-upload-video aria-label="添加参考视频">＋ 视频</button>
   <div class="mt-material-card" data-video-card hidden><video muted playsinline preload="metadata" data-video-thumb></video><button type="button" class="mt-material-action mt-material-replace" data-replace-video aria-label="替换参考视频" title="替换参考视频">↻</button><button type="button" class="mt-material-action" data-remove-video aria-label="移除参考视频" title="移除参考视频">×</button></div>
  </div>
  <input hidden data-video-file type="file" accept="video/*">
 </div>
 <div class="mt-material-slot" data-character-slot hidden>
  <div class="mt-material-grid" data-character-cards><button type="button" class="mt-material-add" data-add-characters aria-label="添加参考图">＋ 参考图</button></div>
  <input hidden data-character-file type="file" accept="image/*">
  <input hidden data-additional-character-files type="file" accept="image/*" multiple>
 </div></aside>
 <main class="mt-center"><div class="mt-stage-heading"><h2>画面对比 <span>原视频与生成结果</span></h2><small>并排预览</small></div><div class="mt-viewers"><article class="mt-viewer"><header><b><i></i>原视频</b><small>动作来源</small></header><div class="mt-preview-area"><div data-source-empty class="mt-empty">${icon('video',43)}<b>从一段动作开始</b><span>添加视频后，在这里查看原始动作</span><button data-pick-video>${icon('plus',13)}选择视频</button></div></div><footer><span data-video-caption>尚未选择视频</span><small>INPUT</small></footer></article>
 <article class="mt-viewer mt-result"><header><b><i></i>生成结果</b><label class="mt-filename"><span>保存文件名</span><input data-filename-prefix type="text" maxlength="100" placeholder="01-001" title="留空按分镜保存，例如 01-001。输入文件名后，在分镜号与版本号前加上该名称。"></label><small>当前分镜</small></header><div class="mt-preview-area"><div class="mt-empty"><i class="mt-orbit">${icon('person',36)}</i><b>等待生成结果</b><span>接入工作流后，对比动作与角色效果</span><small>本页面为 UI 预览，不生成视频</small></div></div><footer><span data-result-caption>暂无生成版本</span><small>OUTPUT</small></footer></article></div>
 <div class="mt-playbar"><button class="mt-icon" data-play disabled aria-label="播放或暂停原视频">${icon('play',16)}</button><span data-current>00:00</span><input data-scrub type="range" min="0" max="1000" value="0" disabled aria-label="视频播放位置"><span data-total>00:00</span><span class="mt-sync-title" data-preview-preload role="status">对比播放</span><button data-sync disabled title="暂无生成结果">同步播放</button></div>
 <div class="mt-shots-heading"><h2>分镜列表 <span data-count>01</span></h2><button type="button" data-select-all>全选</button><button type="button" data-clear-selection>取消全选</button><button type="button" data-delete-shot title="删除选中的分镜">删除当前分镜</button><button data-add-shot>${icon('plus',14)}添加分镜</button></div><div class="mt-shots" data-shots></div></main>
 <aside class="mt-settings"><div class="mt-section"><h2>分镜设置</h2><small data-shot-name>分镜 01</small></div><div class="mt-scope">${icon('layers',14)}仅作用于当前分镜</div><label class="mt-prompt">提示词<small>描述本镜希望保留或变化的内容</small><textarea data-prompt aria-label="当前分镜提示词" placeholder="例如：保持角色的面部、发型与服装一致，按照来源视频中的动作进行表演。"></textarea></label><div class="mt-prompt-footer"><span data-chars>0 字</span></div><section class="mt-parameters"><h3>工作流参数</h3><div>${icon('layers',23)}<b>等待接入具体工作流</b><small>只展示实际支持的参数<br>预览版不预设采样或模型选项</small></div></section><div class="mt-notice"><b>预览阶段</b><p>可以选择素材、编辑提示词和切换分镜；不会加载模型、修改工作流或提交任务。</p></div></aside></div>
 <footer class="mt-statusbar"><span>● 本地 UI 预览 · 未连接推理后端</span><span data-message role="status">素材和编辑仅保留在本窗口，关闭后释放</span><small>v0.1.3</small></footer>`;
 const q=s=>root.querySelector(s),qa=s=>[...root.querySelectorAll(s)];const sourceEmpty=q('[data-source-empty]');
 const resultEmpty=q('.mt-result .mt-empty');resultEmpty.style.position='relative';resultEmpty.style.zIndex='3';
 resultPreview=createResultPreview({area:q('.mt-result .mt-preview-area'),seekNext:true,prepare:(media,url,active,primed)=>playback?playback.prepareMedia(media,'result',url,{forceSeek:active&&!primed,positionReady:primed}):media.src=url,
  onReady:()=>{if(closed)return;const empty=q('.mt-result .mt-empty');if(empty&&resultPreview.displaying)empty.hidden=true;refreshSyncButton();},
  onError:(url,error)=>{
   if(closed)return;
   const shot=activeShot(project);
   if(resultUrl(shot)!==url)return;
   resultFailures.set(shot.resultUrl,error);renderResult(shot);timeline?.render();
   message('生成结果文件不可用，已停止该轨同步播放；原视频可继续播放');
  }
 });

 const sourcePreview=createResultPreview({area:sourceEmpty.parentElement,controls:false,seekNext:true,
  prepare:(media,url,active,primed)=>playback?playback.prepareMedia(media,'source',url,{forceSeek:active&&!primed,positionReady:primed}):media.src=url,
  onMetadata:(media,url)=>{
   const shot=activeShot(project);if(closed||sourceUrl(shot)!==url||!Number.isFinite(media.duration)||media.duration<=0)return;
   if(shot.video.duration!==media.duration||shot.video.width!==media.videoWidth||shot.video.height!==media.videoHeight){
    Object.assign(shot.video,{duration:media.duration,width:media.videoWidth,height:media.videoHeight});
    const clip=timelineClips(project).find(c=>c.shot.id===shot.id);
    const target=clip?clip.start+Math.max(0,Math.min(clip.duration,project.playhead-clip.timelineStart)):shot.inPoint;
    render(target,{preservePlayback:playback.playing});
   }
  },
  onError:url=>{if(!closed&&sourceUrl(activeShot(project))===url)message('此视频格式无法在浏览器预览，未提交任务');}
 });
 const shotBar=document.createElement('div');shotBar.className='mt-top-shots';shotBar.append(q('.mt-shots-heading'),q('[data-shots]'));q('.mt-toolbar').append(shotBar);
 const assetPanel=q('.mt-assets'),videoSlot=q('[data-video-slot]'),characterSlot=q('[data-character-slot]');
 const assetTabs=document.createElement('nav');assetTabs.className='mt-asset-tabs mt-modes';assetTabs.setAttribute('aria-label','素材类型');
 assetTabs.innerHTML='<button type="button" data-material-tab="video" class="active" aria-pressed="true">参考视频</button><button type="button" data-material-tab="character" aria-pressed="false">角色参考图</button>';
 assetPanel.prepend(assetTabs);
 const showMaterial=kind=>{
  videoSlot.hidden=kind!=='video';characterSlot.hidden=kind!=='character';
  for(const button of assetTabs.querySelectorAll('button')){const selected=button.dataset.materialTab===kind;button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected));}
 };
 for(const button of assetTabs.querySelectorAll('button'))button.onclick=()=>{showMaterial(button.dataset.materialTab);renderMaterialCards(activeShot(project));};
 const videoThumb=q('[data-video-thumb]'),videoCard=q('[data-video-card]'),addVideo=q('[data-upload-video]');
 const characterCards=q('[data-character-cards]'),addCharacters=q('[data-add-characters]');
 let characterCardKey='';
 function renderMaterialCards(shot){
  const video=shot.video;
  videoCard.hidden=!video;addVideo.hidden=Boolean(video);
  if(video&&!videoSlot.hidden){
   const url=sourceUrl(shot);
   if(videoThumb.getAttribute('src')!==url)videoThumb.src=url;
   videoCard.title=[video.name,video.duration?time(video.duration):'',video.width?video.width+' × '+video.height:''].filter(Boolean).join(' · ');
  }else if(videoThumb.hasAttribute('src')){videoThumb.removeAttribute('src');videoThumb.load();}
  if(characterSlot.hidden)return;
  const assets=[shot.character,...(shot.additionalCharacters||[])].filter(Boolean);
  const key=JSON.stringify(assets.map(asset=>[asset.url,asset.name]));
  if(key===characterCardKey)return;
  characterCardKey=key;
  const cards=assets.map((asset,index)=>{
   const number=index+1;
   const card=document.createElement('div');card.className='mt-material-card';card.title=asset.name;
   const img=document.createElement('img');img.src=asset.url;img.alt='参考图 '+number;img.decoding='async';
   const label=document.createElement('span');label.className='mt-material-number';label.textContent=number;
   const remove=document.createElement('button');remove.type='button';remove.className='mt-material-action';remove.dataset.removeReference=index;remove.textContent='×';remove.title='移除参考图 '+number;remove.setAttribute('aria-label',remove.title);
   card.append(img,label,remove);
   if(index===0){
    const replace=document.createElement('button');replace.type='button';replace.className='mt-material-action mt-material-replace';replace.dataset.replaceCharacter='';replace.textContent='↻';replace.title='替换参考图 1';replace.setAttribute('aria-label',replace.title);card.append(replace);
   }
   return card;
  });
  characterCards.replaceChildren(...cards,addCharacters);
 }

 const libraryFoot=document.createElement('div');libraryFoot.className='mt-library-foot';libraryFoot.innerHTML='<button type="button" data-open-library>▣ 资产库</button>';assetPanel.append(libraryFoot);
 const library=document.createElement('div');library.className='mt-library-backdrop';library.hidden=true;
 library.innerHTML='<section class="mt-library-dialog" role="dialog" aria-modal="true" aria-label="资产库"><header><b>资产库</b><button type="button" data-library-close aria-label="关闭资产库">×</button></header><nav><button type="button" data-library-kind="image">参考图</button><button type="button" data-library-kind="video">参考视频</button><select data-library-category aria-label="资产分类"><option value="all">全部资产</option><option value="character">角色资产</option><option value="scene">场景资产</option><option value="prop">道具资产</option><option value="other">其他资产</option><option value="camera">运镜资产</option><option value="blocking">站位资产</option></select><select data-library-image-slot aria-label="应用到角色参考图"><option value="append">追加参考图</option><option value="first">替换参考图 1</option></select><button type="button" data-library-import>导入资产</button><input type="file" data-library-file multiple hidden accept="image/*,video/*"></nav><div class="mt-library-grid" data-library-grid></div><p data-library-message role="status"></p><footer><button type="button" data-library-cancel>取消</button><button type="button" data-library-use>应用到当前分镜</button></footer></section>';root.append(library);
 let libraryAssets=[],libraryKind='image',librarySelection=null,libraryShotId=null;
 const lq=selector=>library.querySelector(selector),libraryMessage=text=>lq('[data-library-message]').textContent=text;
 function renderLibrary(){lq('[data-library-image-slot]').hidden=libraryKind!=='image';const category=lq('[data-library-category]').value;const assets=libraryAssets.filter(a=>String(a.mimeType||'').startsWith(libraryKind+'/')&&(category==='all'||a.category===category));lq('[data-library-grid]').innerHTML=assets.map(a=>`<button type="button" class="mt-library-card ${a.id===librarySelection?'active':''}" data-asset-id="${esc(a.id)}">${libraryKind==='image'?`<img src="${esc(options.libraryAssetUrl(a))}" alt="">`:`<video src="${esc(options.libraryAssetUrl(a))}" muted preload="metadata"></video>`}<b title="${esc(a.name)}">${esc(a.name)}</b></button>`).join('');for(const button of library.querySelectorAll('[data-asset-id]'))button.onclick=()=>{librarySelection=button.dataset.assetId;renderLibrary();};for(const b of library.querySelectorAll('[data-library-kind]'))b.classList.toggle('active',b.dataset.libraryKind===libraryKind);libraryMessage(assets.length?`共 ${assets.length} 个资产`:'暂无此类资产，可点击“导入资产”添加');}
 async function loadLibrary(){const data=await options.onLibraryRequest('');libraryAssets=data.assets||[];renderLibrary();}
 q('[data-open-library]').onclick=async()=>{libraryShotId=project.activeShotId;libraryKind=videoSlot.hidden?'image':'video';librarySelection=null;lq('[data-library-image-slot]').value='append';library.hidden=false;libraryMessage('正在读取资产库…');try{await loadLibrary();}catch(e){libraryMessage(e.message);}};
 lq('[data-library-close]').onclick=lq('[data-library-cancel]').onclick=()=>{library.hidden=true;};
 for(const b of library.querySelectorAll('[data-library-kind]'))b.onclick=()=>{libraryKind=b.dataset.libraryKind;librarySelection=null;renderLibrary();};
 lq('[data-library-category]').onchange=()=>{librarySelection=null;renderLibrary();};
 lq('[data-library-import]').onclick=()=>{lq('[data-library-file]').accept=libraryKind==='image'?'image/*':'video/*';lq('[data-library-file]').click();};
 lq('[data-library-file]').onchange=async e=>{const files=[...e.target.files];e.target.value='';libraryMessage('正在导入资产…');try{for(const file of files){const category=lq('[data-library-category]').value;const form=new FormData();form.append('category',category==='all'?(libraryKind==='image'?'character':'other'):category);form.append('library_scope','all');form.append('name',file.name.replace(/\.[^.]+$/,''));form.append('media',file,file.name);await options.onLibraryRequest('/import',{method:'POST',body:form});}await loadLibrary();}catch(error){libraryMessage(error.message);}};
 lq('[data-library-use]').onclick=async()=>{if(!librarySelection){libraryMessage('请先选择一个资产');return;}const shot=project.shots.find(s=>s.id===libraryShotId);if(!shot){libraryMessage('目标分镜不存在');return;}const button=lq('[data-library-use]'),replaceFirst=lq('[data-library-image-slot]').value==='first';button.disabled=true;try{const data=await options.onLibraryRequest('/apply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:[librarySelection]})});const asset=data.assets?.[0];if(!asset)throw new Error('资产库未返回素材');const path=(asset.subfolder?asset.subfolder+'/':'')+asset.filename,url=new URL(`api/view?${new URLSearchParams({filename:asset.filename,subfolder:asset.subfolder||'',type:asset.type||'input'})}`,document.baseURI).href;const value={inputPath:path,url,name:asset.name||asset.filename};
 if(String(asset.mimeType).startsWith('video/')){const probe=document.createElement('video');probe.preload='metadata';await new Promise((resolve,reject)=>{probe.onloadedmetadata=()=>{value.duration=probe.duration;value.width=probe.videoWidth;value.height=probe.videoHeight;resolve();};probe.onerror=()=>reject(new Error('无法读取所选视频'));probe.src=url;});const old=shot.video;shot.video=value;shot.inPoint=0;shot.outPoint=null;release(old);showMaterial('video');}
 else{bindCharacterReference(shot,value,replaceFirst);showMaterial('character');}stop();selectShot(project,shot.id);render();library.hidden=true;
 }catch(e){libraryMessage(e.message);}finally{button.disabled=false;}};

 const referenceSettings=document.createElement('div');referenceSettings.className='mt-reference-video-settings';referenceSettings.innerHTML='<label>视频参考尺寸<select data-reference-video-mode><option value="original">原尺寸</option><option value="generation">跟随生成尺寸</option><option value="custom">自定义</option></select></label><div data-reference-video-custom hidden><label>参考宽度上限<input type="number" min="32" step="32" value="640" data-reference-video-width></label><label>参考高度上限<input type="number" min="32" step="32" value="384" data-reference-video-height></label></div>';videoSlot.prepend(referenceSettings);
 for(const [selector,key] of [['[data-reference-video-mode]','referenceVideoMode'],['[data-reference-video-width]','referenceVideoWidth'],['[data-reference-video-height]','referenceVideoHeight']])q(selector).onchange=e=>{generation[key]=key==='referenceVideoMode'?e.target.value:Math.max(32,Math.floor((Number(e.target.value)||32)/32)*32);render();scheduleSave();};
 const message=t=>q('[data-message]').textContent=t;
 function stop(){
  playRequested=false;playback?.pause();
  q('[data-play]').innerHTML=icon('play',16);
  updatePreloadStatus();
 }
 function sourceUrl(shot){return previewFiles.resolve(shot?.video?.url);}
 function resultUrl(shot){
  const url=shot?.resultUrl;
  return resultFailures.has(url)?null:previewFiles.resolve(url,{wait:true});
 }
 function orderedPreviewClips(remaining=false){
  const clips=timelineClips(project);
  const index=clips.findIndex(clip=>clip.shot.id===project.activeShotId);
  const start=project.playhead>=(clips.at(-1)?.timelineEnd||0)?0:Math.max(0,index);
  return remaining?clips.slice(start):[...clips.slice(start),...clips.slice(0,start)];
 }
 function preloadUrls(clips,enabledOnly=false){
  return clips.flatMap(({shot})=>[
   !enabledOnly||trackStates.result.video?shot.resultUrl:null,
   !enabledOnly||trackStates.source.video?shot.video?.url:null,
  ]);
 }
 function syncPreviewFiles(){
  previewFiles.update(preloadUrls(orderedPreviewClips()));
  updatePreloadStatus();
 }
 function updatePreloadStatus(){
  const label=q('[data-preview-preload]');
  if(!label)return;
  const {total,ready,pending}=previewFiles.progress();
  label.textContent=pending?'预载视频 '+ready+'/'+total:'对比播放';
  label.title=pending?'打开工作台后预载完整视频，准备好后从段首连续播放':'同步预览原视频与生成结果';
 }
 function renderAtPlayhead(){
  const clip=timelineClips(project).find(c=>c.shot.id===project.activeShotId);
  const at=clip?clip.start+Math.max(0,Math.min(clip.duration,project.playhead-clip.timelineStart)):null;
  render(at,{preservePlayback:true});
 }
 function previewFileReady(url){
  if(closed)return;
  updatePreloadStatus();
  if(!playback||playback.playing)return;
  const clips=orderedPreviewClips(true);
  if(clips.slice(0,2).some(({shot})=>url===shot.resultUrl||url===shot.video?.url)){
   renderAtPlayhead();playback.refresh();
  }
  if(playRequested&&!previewFiles.progress(preloadUrls(clips,true)).pending)requestPlayback();
 }
 function requestPlayback(){
  syncPreviewFiles();
  if(previewFiles.progress(preloadUrls(orderedPreviewClips(true),true)).pending){
   playRequested=true;q('[data-play]').innerHTML=icon('pause',16);return;
  }
  playRequested=false;renderAtPlayhead();playback.play();
 }

 function updateRunButton(){if(!options.onRun)return;const count=selectedShotIds(project).length,button=q('.mt-generate');button.textContent=count?`生成勾选分镜（${count}）`:runSettings.scope==='current'?'运行当前分镜':'连续生成分镜';button.title=count?'只生成勾选的分镜，未勾选的保持原结果':'按生成范围逐镜提交工作流';}
 let shotCardsKey=null,activeCardId=null;
 const shotCards=new Map();
 function refreshShotCards(){
  const id=project.activeShotId;
  if(id===activeCardId)return;
  for(const key of [activeCardId,id]){
   const button=shotCards.get(key);if(!button)continue;
   const active=key===id;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));button.querySelector('i').hidden=!active;
  }
  activeCardId=id;
 }
 function renderShots(){
  const checked=new Set(selectedShotIds(project));q('[data-count]').textContent=String(project.shots.length).padStart(2,'0');
  const key=JSON.stringify([runtime.busy,project.shots.map(shot=>[shot.id,shot.name,shot.character?.url,clipBounds(shot)?.duration])]);
  if(key===shotCardsKey){
   refreshShotCards();
   for(const input of qa('[data-select-shot]'))input.checked=checked.has(input.dataset.selectShot);
   updateRunButton();return;
  }
  shotCardsKey=key;
  q('[data-shots]').innerHTML=project.shots.map(s=>`<div class="mt-shot-card"><button data-shot="${esc(s.id)}" class="mt-shot ${s.id===project.activeShotId?'active':''}" aria-pressed="${s.id===project.activeShotId}"><span class="mt-shot-pic">${s.character?`<img src="${esc(s.character.url)}" alt="" loading="lazy" decoding="async">`:icon('video',21)}</span><span><b>${esc(s.name)}</b><small>${clipBounds(s)?clipBounds(s).duration.toFixed(2)+'秒':'等待素材'}</small></span><i ${s.id===project.activeShotId?'':'hidden'}></i></button><input type="checkbox" data-select-shot="${esc(s.id)}" aria-label="勾选${esc(s.name)}参与生成" title="勾选需要重做的分镜" ${checked.has(s.id)?'checked':''} ${runtime.busy?'disabled':''}></div>`).join('');
  shotCards.clear();activeCardId=project.activeShotId;
  for(const button of qa('[data-shot]')){
   shotCards.set(button.dataset.shot,button);
   button.onclick=()=>{stop();selectShot(project,button.dataset.shot);render();};
  }
  qa('[data-select-shot]').forEach(input=>input.onchange=()=>{if(runtime.busy)return;setShotSelected(project,input.dataset.selectShot,input.checked);updateRunButton();scheduleSave();});updateRunButton();
 }
 function changeAllShotSelection(selected){if(runtime.busy)return;setAllShotsSelected(project,selected);for(const input of qa('[data-select-shot]'))input.checked=selected;updateRunButton();scheduleSave();}
 q('[data-select-all]').onclick=()=>changeAllShotSelection(true);
 q('[data-clear-selection]').onclick=()=>changeAllShotSelection(false);

 function refreshSyncButton(){const shot=activeShot(project),sync=q('[data-sync]');const available=Boolean(shot?.resultUrl&&!resultFailures.has(shot.resultUrl));sync.disabled=!available;sync.title=available?'按分镜同步播放上下轨':shot?.resultUrl?'生成结果文件不可用':'暂无生成结果';}
 function renderResult(s,{continuous=false,time=0}={}){
  displayedResultShotId=s.id;displayedResultUrl=s.resultUrl||null;
  const caption=q('[data-result-caption]'),file=s.results?.at(-1)?.file,error=resultFailures.get(s.resultUrl),empty=q('.mt-result .mt-empty');
  caption.textContent=s.resultUrl?(file?.filename||'已生成视频')+(error?'（文件不可用）':''):'暂无生成版本';caption.title=error||caption.textContent;
  resultPreview.select(resultUrl(s),{continuous,time});
  const clips=timelineClips(project),index=clips.findIndex(c=>c.shot.id===s.id),next=index>=0?clips[index+1]?.shot:null;
  resultPreview.setNext(resultUrl(next));
  if(empty){empty.hidden=Boolean(s.resultUrl&&!error&&resultPreview.displaying);empty.querySelector('b').textContent=error?'结果文件不可用':s.resultUrl?(resultUrl(s)?'正在加载生成结果':'正在预载成片'):'等待生成结果';empty.querySelector('span').textContent=error?'视频文件已失效，请重新生成':s.resultUrl?'正在读取视频画面':'接入工作流后，对比动作与角色效果';empty.querySelector('small').hidden=Boolean(error||s.resultUrl);}
  refreshSyncButton();
 }

 function renderGenerationSettings(shot){const inferred=generationSelection(shot),aspect=generationAspects[shot.generationAspect]?shot.generationAspect:inferred.aspect;const size=q('[data-generation-megapixels]');q('[data-generation-aspect]').value=aspect;size.replaceChildren();if(inferred.megapixels==='existing'){const option=document.createElement('option');option.value='existing';option.textContent=`当前 · ${inferred.width} × ${inferred.height}`;size.append(option);}for(let i=1;i<=30;i++){const mp=i/10,r=generationResolution(aspect,mp),option=document.createElement('option');option.value=mp.toFixed(1);option.textContent=`${mp.toFixed(1)} MP · ${r.width} × ${r.height}`;size.append(option);}size.value=inferred.megapixels==='existing'?'existing':Number(inferred.megapixels).toFixed(1);size.title=`生成尺寸 ${inferred.width} × ${inferred.height}`;}
 function render(sourceTime=null,{preservePlayback=false}={}){const s=activeShot(project),sameShot=renderedShotId===s.id;if(!preservePlayback)syncPreviewFiles();renderResult(s,{continuous:preservePlayback&&Boolean(playback?.playing),time:sourceTime==null?0:Math.max(0,sourceTime-(clipBounds(s)?.start||0))});renderMaterialCards(s);q('[data-reference-video-mode]').value=generation.referenceVideoMode||'original';q('[data-reference-video-width]').value=generation.referenceVideoWidth||640;q('[data-reference-video-height]').value=generation.referenceVideoHeight||384;q('[data-reference-video-custom]').hidden=generation.referenceVideoMode!=='custom';q('[data-shot-name]').textContent=s.name;q('[data-prompt]').value=s.prompt;q('[data-chars]').textContent=`${s.prompt.length} 字`;
 if(options.referenceOnly&&!preservePlayback){renderGenerationSettings(generation);q('[data-ref-size]').value=generation.refImageSize||'max';}
 q('[data-video-caption]').textContent=s.video?.name||'尚未选择视频';
 sourceEmpty.hidden=Boolean(s.video);const bounds=clipBounds(s),clips=timelineClips(project),clipIndex=clips.findIndex(c=>c.shot.id===s.id),clip=clips[clipIndex],local=clip?Math.max(0,Math.min(clip.duration,project.playhead-clip.timelineStart)):0,target=bounds?Math.max(bounds.start,Math.min(bounds.end,sourceTime??(sameShot?bounds.start+local:bounds.start))):0;renderedShotId=s.id;
 sourcePreview.select(sourceUrl(s),{continuous:preservePlayback,time:target});
 const nextClip=clipIndex<0?null:clips[clipIndex+1];
 sourcePreview.setNext(sourceUrl(nextClip?.shot),nextClip?.start);
 project.playhead=clip?clip.timelineStart+(target-bounds.start):0;q('[data-play]').disabled=!bounds;q('[data-scrub]').disabled=!bounds;q('[data-total]').textContent=bounds?time(bounds.duration):'00:00';q('[data-current]').textContent=bounds?time(target-bounds.start):'00:00';q('[data-scrub]').value=bounds?String((target-bounds.start)/bounds.duration*1000):'0';if(preservePlayback){refreshShotCards();timeline?.refreshSelection?.();}else{renderShots();timeline?.render();}refreshSyncButton();if(!preservePlayback&&clip){if(sameShot&&playback?.playing)playback.refresh();else playback?.seek(project.playhead,{keepSelection:true});}if(!preservePlayback)scheduleSave();}
 const release=asset=>{if(asset&&!project.shots.some(s=>s.video?.url===asset.url||s.character?.url===asset.url||s.additionalCharacters?.some(item=>item.url===asset.url))){URL.revokeObjectURL(asset.url);urls.delete(asset.url);}};
 function close(){if(closed)return;closed=true;clearTimeout(saveClock);void persistProject();clearInterval(runClock);clearInterval(hardwareClock);unsubscribeRun?.();stop();playback?.dispose();sourcePreview.dispose();resultPreview?.dispose();previewFiles.dispose();root.remove();}
 q('[data-close]').onclick=close;
 const filenameInput=q('[data-filename-prefix]');
 filenameInput.value=generation.filenamePrefix;
 filenameInput.oninput=()=>{generation.filenamePrefix=filenameInput.value;};
 root.addEventListener('input',scheduleSave);root.addEventListener('change',scheduleSave);
 q('[data-prompt]').oninput=e=>{activeShot(project).prompt=e.target.value;q('[data-chars]').textContent=`${e.target.value.length} 字`;};
 q('[data-add-shot]').onclick=()=>{stop();addShot(project);render();message('已创建独立分镜，未复制上一镜的素材或提示词');};
 q('[data-delete-shot]').onclick=()=>{if(runtime.busy){message('请先停止生成，再删除分镜');return;}stop();const removed=deleteShot(project,project.activeShotId);if(!removed)return;release(removed.video);release(removed.character);for(const asset of removed.additionalCharacters||[])release(asset);render();message(`已删除 ${removed.name}，后续分镜已重新编号`);};
 const videoFile=q('[data-video-file]'),additionalFiles=q('[data-additional-character-files]'),replacementFile=q('[data-character-file]');
 function bindCharacterReference(shot,asset,replaceFirst=false){
  if(shot.character&&!replaceFirst){(shot.additionalCharacters??=[]).push(asset);return;}
  const old=shot.character;shot.character=asset;release(old);
 }
 function newAsset(file){const url=URL.createObjectURL(file);urls.add(url);return {name:file.name,url,file};}
 function saveImportedMedia(){clearTimeout(saveClock);void persistProject();}
 function applyVideoFile(shot,file){
  if(!shot||!file)return;
  stop();
  const old=shot.video;
  shot.video={...newAsset(file),duration:0,width:0,height:0};shot.inPoint=0;shot.outPoint=null;release(old);
  selectShot(project,shot.id);render();saveImportedMedia();message('已添加参考视频');
 }
 function applyCharacterFiles(shot,files,replaceFirst=false){
  if(!shot||!files.length)return;
  stop();
  for(const file of files)bindCharacterReference(shot,newAsset(file),replaceFirst);
  selectShot(project,shot.id);render();saveImportedMedia();message(replaceFirst?'已替换参考图 1':'已添加参考图');
 }
 function pickVideo(){pendingVideoShot=project.activeShotId;videoFile.click();}
 function pickCharacterFiles(id,replaceFirst=false){pendingCharacterShot=id;(replaceFirst?replacementFile:additionalFiles).click();}
 addVideo.onclick=q('[data-pick-video]').onclick=q('[data-replace-video]').onclick=pickVideo;
 addCharacters.onclick=()=>pickCharacterFiles(project.activeShotId);
 videoFile.onchange=e=>{
  const shot=project.shots.find(s=>s.id===pendingVideoShot),file=e.target.files[0];
  pendingVideoShot=null;e.target.value='';applyVideoFile(shot,file);
 };
 function onCharacterFiles(e,replaceFirst=false){
  const shot=project.shots.find(s=>s.id===pendingCharacterShot),files=[...e.target.files];
  pendingCharacterShot=null;e.target.value='';applyCharacterFiles(shot,files,replaceFirst);
 }
 additionalFiles.onchange=onCharacterFiles;
 replacementFile.onchange=e=>onCharacterFiles(e,true);
 characterCards.onclick=e=>{
  if(e.target.closest('[data-replace-character]')){pickCharacterFiles(project.activeShotId,true);return;}
  const remove=e.target.closest('[data-remove-reference]');if(!remove)return;
  stop();
  const shot=activeShot(project),index=Number(remove.dataset.removeReference);
  if(index===0){
   const old=shot.character;shot.character=shot.additionalCharacters?.shift()||null;release(old);
  }else{
   const [old]=shot.additionalCharacters.splice(index-1,1);release(old);
  }
  render();
 };
 q('[data-remove-video]').onclick=()=>{stop();const shot=activeShot(project),old=shot.video;shot.video=null;shot.inPoint=0;shot.outPoint=null;release(old);render();};
 function bindDrop(slot,kind,apply){
  const hasFiles=e=>e.dataTransfer?.types?.includes('Files');
  slot.addEventListener('dragover',e=>{if(!hasFiles(e))return;e.preventDefault();e.dataTransfer.dropEffect='copy';slot.classList.add('mt-drop-active');});
  slot.addEventListener('dragleave',e=>{if(!e.relatedTarget||!slot.contains(e.relatedTarget))slot.classList.remove('mt-drop-active');});
  slot.addEventListener('drop',e=>{
   if(!hasFiles(e))return;
   e.preventDefault();slot.classList.remove('mt-drop-active');
   const extension=kind==='image'?/\.(png|jpe?g|webp|gif|bmp|avif|tiff?|heic|heif)$/i:/\.(mp4|webm|mov|mkv|avi|m4v|mpeg|mpg|ogv)$/i;
   const files=[...e.dataTransfer.files].filter(file=>file.type.startsWith(kind+'/')||(!file.type&&extension.test(file.name)));
   if(files.length)apply(activeShot(project),files);
   else message(kind==='image'?'请拖入图片文件':'请拖入视频文件');
  });
 }
 bindDrop(videoSlot,'video',(shot,files)=>applyVideoFile(shot,files[0]));
 bindDrop(characterSlot,'image',applyCharacterFiles);
 playback=createPreviewTransport({project,tracks:trackStates,getSource:()=>sourcePreview.media,getResult:()=>resultPreview?.media||null,onPlayRequest:requestPlayback,onError:message,
  onState:playing=>{if(!closed)q('[data-play]').innerHTML=icon(playing?'pause':'play',16);},
  onFrame:located=>{if(closed)return;const clip=located.clip,local=located.time-clip.timelineStart;if(project.activeShotId!==clip.shot.id){selectShot(project,clip.shot.id);render(located.sourceTime,{preservePlayback:true});}q('[data-current]').textContent=time(local);q('[data-total]').textContent=time(clip.duration);q('[data-scrub]').value=String(local/clip.duration*1000);timeline?.refreshPosition();sourcePreview.setTime(located.sourceTime);resultPreview?.setTime(local);}
 });
 q('[data-play]').onclick=q('[data-sync]').onclick=()=>{if(playback.playing||playRequested)stop();else requestPlayback();};
 q('[data-scrub]').oninput=e=>{const c=timelineClips(project).find(c=>c.shot.id===project.activeShotId);if(c)playback.seek(c.timelineStart+c.duration*Number(e.target.value)/1000);};
 timeline=mountTimeline(root,project,{trackStates,isBusy:()=>runtime.busy,onDeleteShot:()=>q('[data-delete-shot]').onclick(),isResultUnavailable:url=>resultFailures.has(url),onTrackToggle:(kind,key)=>{playback.setTrack(kind,key,!trackStates[kind][key]);if(playRequested)requestPlayback();scheduleSave();},onError:message,
  onSelectShot:id=>{stop();selectShot(project,id);render();},
  onSeek:located=>{if(!located)return;stop();playback.seek(located.time);},
  onChange:()=>{stop();render();message('分镜范围已更新，只修改剪辑参数，未改写源文件');},
  onPickCharacter:id=>{showMaterial('character');stop();selectShot(project,id);render();pickCharacterFiles(id);}});
 if(options.onSubmit){const submit=q('.mt-generate');submit.disabled=false;submit.textContent='应用当前分镜到节点';submit.title='提交素材到当前 ComfyUI 并更新本节点；不会自动排队';
 q('.mt-preview-badge').textContent='当前分镜接口';q('.mt-status').textContent='应用后在画布运行';
 q('.mt-parameters>div').innerHTML='<b>采样参数在画布节点设置</b><small>宽高、一采步数、原声参考在导演台节点<br>噪声、采样器、SIGMAS 由外部连线提供</small>';
 q('.mt-notice').innerHTML='<b>当前分镜接口 · 待采样验收</b><p>应用后手动运行画布。未启用长分段自动排队、跨镜续接、调色或提示词改写。</p>';
 q('.mt-statusbar>span').textContent='● 应用当前分镜，不自动排队';
 if(options.mediaOnly){submit.textContent='应用素材到原工作流';submit.title='只替换原 Media；范围与提示词仍用原分镜 MD';
 q('.mt-preview-badge').textContent='仅素材接口';
 q('.mt-parameters>div').innerHTML='<b>沿用原工作流全部生成设置</b><small>只输出角色图与完整源视频<br>分镜范围、提示词仍在原分镜 MD 设置</small>';
 q('.mt-notice').innerHTML='<b>不重复裁剪、不改提示词</b><p>本次只替换素材入口。本窗口的时间范围与提示词不写入原 MD，也不参与采样；原工作流分段、续接、二采、收集全部保留。</p>';
 }
 if(options.referenceOnly){
 q('.mt-parameters>div').innerHTML='<label>宽高比<select data-generation-aspect aria-label="生成宽高比"></select></label><label>分辨率<select data-generation-megapixels aria-label="生成分辨率"></select></label><label>参考图尺寸<select data-ref-size><option value="max">max</option><option value="match">match</option></select></label>';
 for(const [value,label] of [['1:1','1:1（方形）'],['2:3','2:3（竖幅照片）'],['3:2','3:2（照片）'],['3:4','3:4（竖幅标准）'],['4:3','4:3（标准）'],['9:16','9:16（竖幅宽屏）'],['16:9','16:9（宽屏）'],['21:9','21:9（超宽屏）']]){const option=document.createElement('option');option.value=value;option.textContent=label;q('[data-generation-aspect]').append(option);}
 const applyGenerationSelection=()=>{const aspect=q('[data-generation-aspect]').value,selection=q('[data-generation-megapixels]').value,mp=selection==='existing'?Math.max(.1,Math.min(3,Math.round(generation.generationWidth*generation.generationHeight/(1024*1024)*10)/10)):Number(selection),size=generationResolution(aspect,mp);Object.assign(generation,{generationAspect:aspect,generationMegapixels:mp,generationWidth:size.width,generationHeight:size.height});renderGenerationSettings(generation);scheduleSave();};
 q('[data-generation-aspect]').onchange=q('[data-generation-megapixels]').onchange=applyGenerationSelection;
 q('[data-ref-size]').onchange=e=>{generation.refImageSize=e.target.value;scheduleSave();};
 q('.mt-notice').innerHTML='<b>参考条件接口</b><p>按当前分镜范围读取视频，内部统一 24fps 并补齐末帧；角色图和提示词直接送入官方 H3 条件节点。输出 positive 与 LATENT，采样和二采沿用画布。补齐帧需在成片端裁回分镜时长。</p>';
 }
 if(options.onRun){
 submit.textContent=runSettings.scope==='current'?'运行当前分镜':'连续生成分镜';submit.title='按生成范围逐镜提交本节点连接的工作流';
 const stopButton=document.createElement('button');stopButton.type='button';stopButton.textContent='停止';stopButton.dataset.runStop='';stopButton.hidden=true;stopButton.title='取消本导演台当前任务';submit.after(stopButton);
 stopButton.onclick=()=>{if(!runtime.busy||runtime.controller?.signal.aborted)return;runtime.controller?.abort();updateRun({phase:'停止中',detail:'等待本次任务取消确认',value:0,max:0});};
 const head=q('.mt-head'),currentButton=document.createElement('button');currentButton.type='button';currentButton.dataset.runCurrent='';currentButton.textContent='仅生成当前分镜';currentButton.title='仅提交当前选中的一个分镜';currentButton.onclick=()=>submit.onclick('current');head.insertBefore(currentButton,submit);
 const settingsButton=document.createElement('button');settingsButton.type='button';settingsButton.textContent='⚙ 设置';settingsButton.className='mt-settings-toggle';settingsButton.setAttribute('aria-expanded','false');
 const dimensions=q('.mt-parameters');dimensions.classList.add('mt-asset-dimensions');assetPanel.insertBefore(dimensions,assetTabs);
 const panel=document.createElement('div');panel.className='mt-run-settings';panel.hidden=true;panel.innerHTML='<strong>生成设置</strong><label>生成范围 <select data-run-scope aria-label="生成范围"><option value="sequence">连续生成：当前至末尾</option><option value="current">仅当前分镜</option></select></label><label><input type="checkbox" data-cleanup-cache> 卸载缓存</label><label><input type="checkbox" data-cleanup-vram> 卸载显存</label><label><input type="checkbox" data-cleanup-models> 卸载模型</label><label>每 <input type="number" min="1" max="99" step="1" data-cleanup-every> 个分镜卸载一次</label><label><input type="checkbox" data-monitor-hardware> 监控硬件</label>';head.insertBefore(settingsButton,submit);head.append(panel);
 q('[data-run-scope]').value=runSettings.scope;
 q('[data-run-scope]').onchange=e=>{runSettings.scope=e.target.value;updateRunButton();options.onSettingsChange?.({...runSettings});};
 settingsButton.onclick=()=>{panel.hidden=!panel.hidden;settingsButton.setAttribute('aria-expanded',String(!panel.hidden));};
 const monitor=document.createElement('div');monitor.className='mt-run-monitor';monitor.innerHTML='<div class="mt-hardware-row"><div data-run-hardware><span data-hw-cpu>CPU --%</span><span data-hw-memory>内存 --%</span><span data-hw-vram>显存 --%</span><span data-hw-temp>温度 --℃</span></div><span>生成耗时 <time data-run-time>00:00</time></span></div><div class="mt-progress-row"><b data-run-phase role="status">等待生成</b><span data-run-step></span><span data-run-shot>分镜 0/1</span></div><progress data-run-progress max="1" value="0"></progress>';head.insertBefore(monitor,settingsButton);head.insertBefore(currentButton,submit);
 q('.mt-status').hidden=true;
 const refreshHardware=async()=>{if(closed||!runSettings.monitorHardware||hardwareBusy)return;hardwareBusy=true;try{const values=await options.onHardware?.();if(!values)throw new Error('硬件监控服务不可用');if(closed)return;for(const [key,label,unit] of [['cpu','CPU','%'],['memory','内存','%'],['vram','显存','%'],['temp','温度','℃']])q(`[data-hw-${key}]`).textContent=`${label} ${values[key==='temp'?'temperature':key]??'--'}${unit}`;q('[data-run-hardware]').title='实时硬件监控';}catch(e){if(!closed)q('[data-run-hardware]').title=e.message;}finally{hardwareBusy=false;}};
 const syncMonitor=()=>{clearInterval(hardwareClock);q('[data-run-hardware]').hidden=!runSettings.monitorHardware;if(runSettings.monitorHardware){void refreshHardware();hardwareClock=setInterval(refreshHardware,2000);}};
 for(const key of ['cache','vram','models']){const input=q(`[data-cleanup-${key}]`);input.checked=Boolean(runSettings[key]);input.onchange=()=>{runSettings[key]=input.checked;options.onSettingsChange?.({...runSettings});};}
 q('[data-cleanup-every]').value=runSettings.every;
 q('[data-cleanup-every]').onchange=e=>{runSettings.every=Math.max(1,Math.min(99,Number(e.target.value)||1));e.target.value=runSettings.every;options.onSettingsChange?.({...runSettings});};
 q('[data-monitor-hardware]').checked=runSettings.monitorHardware;
 q('[data-monitor-hardware]').onchange=e=>{runSettings.monitorHardware=e.target.checked;options.onSettingsChange?.({...runSettings});syncMonitor();};
 syncMonitor();

 }
 const tickClock=()=>{const elapsed=Math.floor((runtime.busy&&runtime.startedAt?Date.now()-runtime.startedAt:runtime.elapsedMs||0)/1000),t=q('[data-run-time]');if(t)t.textContent=`${String(Math.floor(elapsed/60)).padStart(2,'0')}:${String(elapsed%60).padStart(2,'0')}`;};
 const renderRun=()=>{
  if(closed)return;
  const selected=activeShot(project);
  if(selected&&renderedShotId!==null&&renderedShotId!==selected.id){
   stop();
   render();
   const card=qa('[data-shot]').find(button=>button.dataset.shot===selected.id);
   card?.scrollIntoView({block:'nearest',inline:'nearest'});
  }else if(selected&&(displayedResultShotId!==selected.id||displayedResultUrl!==(selected.resultUrl||null))){
   renderResult(selected);
   timeline?.render();
   playback?.refresh();
  }
  const phase=q('[data-run-phase]'),progress=q('[data-run-progress]');if(!phase||!progress)return;phase.textContent=runtime.error||(runtime.currentShotName?runtime.currentShotName+' · ':'')+runtime.phase;const history=(runtime.events||[]).join('\n');phase.title=runtime.error||history||runtime.detail||'';const known=Number(runtime.max)>0;progress.max=known?Number(runtime.max):1;if(known)progress.value=Number(runtime.value)||0;else progress.removeAttribute('value');const step=q('[data-run-step]');step.textContent=known&&runtime.busy?`${/采样/.test(runtime.phase)?'步数 ':''}${runtime.value} / ${runtime.max}`:runtime.detail||'';step.title=runtime.detail||'';q('[data-run-shot]').textContent=`分镜 ${runtime.completedShots||0}/${runtime.totalShots||1}`;updateRunButton();submit.disabled=runtime.busy;for(const input of qa('[data-select-shot]'))input.disabled=runtime.busy;q('[data-select-all]').disabled=runtime.busy;q('[data-clear-selection]').disabled=runtime.busy;q('[data-run-current]').disabled=runtime.busy;q('[data-delete-shot]').disabled=runtime.busy;q('[data-delete-clip]').disabled=runtime.busy||!clipBounds(activeShot(project));const cancel=q('[data-run-stop]');if(cancel){cancel.hidden=!runtime.busy;cancel.disabled=Boolean(runtime.controller?.signal.aborted);cancel.textContent=cancel.disabled?'停止中…':'停止';}tickClock();if(runtime.busy&&!runClock)runClock=setInterval(tickClock,250);if(!runtime.busy){clearInterval(runClock);runClock=null;}};
 const updateRun=state=>{if(runtime.controller?.signal.aborted&&runtime.busy&&!['停止中','停止请求失败，重试中','已停止','失败','已完成'].includes(state.phase)&&state.phase)return;Object.assign(runtime,state);if(state.phase){runtime.events??=[];const entry=`${new Date().toLocaleTimeString()} ${state.phase}${state.detail?' · '+state.detail:''}`;runtime.events.push(entry);if(runtime.events.length>60)runtime.events.shift();}for(const listener of runtime.listeners)listener();};
 runtime.listeners.add(renderRun);unsubscribeRun=()=>runtime.listeners.delete(renderRun);renderRun();
 submit.onclick=async(scope)=>{
  if(typeof scope!=='string')scope=selectedShotIds(project).length?'selected':runSettings.scope;
  if(runtime.busy)return;
  let snapshots;
  try{
   if(/[<>:"/\\|?*]/.test(filenameInput.value)){filenameInput.focus();throw new Error('保存文件名不能包含文件路径或 Windows 文件名禁用字符');}
   snapshots=planDirectorRun(project,options.onRun?scope:'current');
  }
  catch(error){if(error.shotId){stop();selectShot(project,error.shotId);render();}message(error.message);updateRun({phase:error.message,error:null,detail:'',value:0,max:0,currentShotName:''});if(error.focusPrompt)q('[data-prompt]').focus();return;}
  const targets=snapshots.map(snapshot=>project.shots.find(shot=>shot.id===snapshot.id));
  submit.disabled=true;runtime.controller=new AbortController();const control={signal:runtime.controller.signal};runtime.events=[];runtime.cleanupWarning='';
  try{
   runtime.busy=true;runtime.startedAt=Date.now();runtime.elapsedMs=0;
   updateRun({phase:'准备连续分镜',detail:'',error:null,value:0,max:0,node:null,completedShots:0,totalShots:snapshots.length,currentShotName:''});
   for(let index=0;index<snapshots.length;index++){
    control.signal.throwIfAborted();const snapshot=snapshots[index],shot=targets[index];
    const report=state=>updateRun({...state,phase:state.phase==='已完成'?'分镜已完成':state.phase,currentShotName:snapshot.name});
    report({phase:'准备素材',detail:`第 ${index+1} / ${snapshots.length} 个分镜`,value:0,max:0,node:null});
    await options.onSubmit(snapshot,report,control);control.signal.throwIfAborted();
    if(options.onRun){
     const result=await options.onRun(snapshot,report,control);shot.results.push(result);completedRuns++;
     if(result.file){
      const file=result.file;
      shot.resultUrl=new URL(`api/view?${new URLSearchParams({filename:file.filename,subfolder:file.subfolder||'',type:file.type||'output'})}`,document.baseURI).href;
      selectShot(project,shot.id);if(!closed)syncPreviewFiles();
     }
     updateRun({completedShots:index+1});
     if(!control.signal.aborted&&completedRuns%runSettings.every===0&&(runSettings.cache||runSettings.vram||runSettings.models)){
      report({phase:'清理缓存／卸载资源中',detail:'',value:0,max:0});
      try{const cleanup=await options.onCleanup?.({...runSettings},control);if(cleanup?.warnings?.length)runtime.cleanupWarning=cleanup.warnings.join('；');}catch(error){runtime.cleanupWarning=error.message;}
     }
     scheduleSave();
    }
   }
   control.signal.throwIfAborted();
   updateRun({phase:'已完成',detail:runtime.cleanupWarning||'',currentShotName:'',value:1,max:1,node:null});
   if(!closed)message(options.onRun?`本次 ${snapshots.length} 个分镜已生成完成`:'已应用当前分镜到绑定节点');
  }catch(error){const cancelled=error.name==='AbortError';if(!closed)message(cancelled?'连续生成已停止':error.message);updateRun({phase:cancelled?'已停止':'失败',error:cancelled?null:error.message,detail:'',max:0,value:0,node:null});}
  finally{runtime.elapsedMs=runtime.startedAt?Date.now()-runtime.startedAt:runtime.elapsedMs;runtime.startedAt=null;runtime.busy=false;updateRun({});scheduleSave();}
 };
 }
 document.body.append(root);render();return {close};
}
