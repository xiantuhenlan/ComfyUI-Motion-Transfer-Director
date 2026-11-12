import {app} from '../../scripts/app.js';
import {api} from '../../scripts/api.js';
import {openMotionDirector} from './motion_director_ui.js';
async function uploadAsset(asset,signal){
    signal?.throwIfAborted();
    if(asset.inputPath)return asset.inputPath;
    if(!asset.file)throw new Error('请重新选择本分镜的素材文件');
    const form=new FormData();
    form.append('image',asset.file,`${crypto.randomUUID()}_${asset.file.name}`);
    form.append('type','input');form.append('subfolder','xiantu_motion_director');form.append('overwrite','false');
    const response=await api.fetchApi('/upload/image',{method:'POST',body:form,signal});
    if(!response.ok)throw new Error(`素材提交失败：${response.status}`);
    const data=await response.json();
    return `${data.subfolder?data.subfolder+'/':''}${data.name}`;
}
// Queue only output branches belonging to this director and their dependencies.
async function runDirector(node,report,{signal}={}){
 signal?.throwIfAborted();report({phase:'读取画布与检查连线',detail:'',value:0,max:0,node:null});
 const graph=await app.graphToPrompt(),all=graph.output,id=String(node.id);
 const depends=(key,target,seen=new Set())=>{key=String(key);if(key===target)return true;if(seen.has(key))return false;seen.add(key);return Object.values(all[key]?.inputs||{}).some(v=>Array.isArray(v)&&v.length===2&&all[String(v[0])]&&depends(v[0],target,seen));};
 const infoResponse=await api.fetchApi('/object_info');if(!infoResponse.ok)throw new Error('无法读取工作流节点信息');const info=await infoResponse.json();
 const targets=Object.keys(all).filter(key=>info[all[key].class_type]?.output_node&&depends(key,id));if(!targets.length)throw new Error('本导演台未连接到视频保存节点，请先检查画布连线');
 const keep=new Set();function collect(key){key=String(key);if(keep.has(key))return;keep.add(key);for(const value of Object.values(all[key]?.inputs||{}))if(Array.isArray(value)&&value.length===2&&all[String(value[0])])collect(value[0]);}targets.forEach(collect);
 graph.output=Object.fromEntries([...keep].map(key=>[key,all[key]]));
 const shot=JSON.parse(all[id]?.inputs?.shot_json||'{}');
 if(!String(shot.prompt||'').trim())throw new Error('请先填写当前分镜提示词，不能为空或只有空格');
 signal?.throwIfAborted();
 let promptId=null,observedPrompt=null,started=false,activeNode=null,currentPhase='',currentDetail='',cancelSent=false,nextCancel=0;
 const early=[],listeners=[],nodeAliases=new Map(),nodeStates=new Map();
 const emit=state=>{if(!signal?.aborted)report(state);};
 const label=key=>{
   const item=all[String(key)],type=item?.class_type||'',title=item?._meta?.title||info[type]?.display_name||type;
   let phase='执行节点中';
   if(/VAEDecode|VAE.*Decode/i.test(type))phase=/audio|音频/i.test(title+type)?'音频解码中':'视频 VAE 解码中';
   else if(/Sampler|Sampling/i.test(type))phase=/二采|2nd|second/i.test(title)?'二次采样中':'采样中';
   else if(/Upscal|SplitUpscale/i.test(type))phase=/Split/i.test(type)?'分块放大／采样中':'潜空间放大中';
   else if(/Save|VideoCombine|Video.*Encode/i.test(type))phase='视频编码／保存中';
   else if(/Loader|Load.*Model/i.test(type))phase='模型／编码器加载中';
   else if(String(key)===id)phase='导演台准备参考条件';
   return {phase,detail:title||`节点 ${key}`};
 };
 const resolveNode=(...values)=>{for(const value of values){if(value==null)continue;const key=String(value);if(keep.has(key))return key;if(nodeAliases.has(key))return nodeAliases.get(key);}return null;};
 const nodeProgress=(key,value=0,max=0)=>{activeNode=key;const state=label(key);if(key!==id){currentPhase=state.phase;currentDetail=state.detail;}emit({phase:key===id?currentPhase||state.phase:state.phase,detail:key===id?currentDetail:state.detail,node:key,value:Number(value)||0,max:Math.max(0,Number(max)||0)});};
 const listen=(name,handler)=>{const wrapped=e=>{if(!promptId){if(early.length<200)early.push([name,e]);return;}handler(e.detail??null);};api.addEventListener(name,wrapped);listeners.push([name,wrapped,handler]);};
 listen('execution_start',d=>{if(!d)return;observedPrompt=d.prompt_id;if(d.prompt_id===promptId){started=true;emit({phase:'开始执行工作流',detail:'',max:0,value:0});}});
 listen('executing',d=>{
   const object=d!=null&&typeof d==='object';
   if(object&&d.prompt_id!=null){if(d.prompt_id!==promptId)return;observedPrompt=promptId;}
   else if(!started||observedPrompt!==promptId)return;
   const node=object?d.node??d.display_node:d;
   if(node==null){activeNode=null;return;}
   const key=resolveNode(node,object?d.display_node:null);if(!key)return;started=true;nodeProgress(key);
 });
 listen('xiantu_motion_progress',d=>{if(!d||d.prompt_id!==promptId||String(d.node)!==id||d.runToken!==shot.runToken)return;started=true;observedPrompt=promptId;activeNode=id;currentPhase=d.phase;currentDetail=d.detail||'';emit({phase:d.phase,detail:currentDetail,node:id,max:d.max||0,value:d.value||0});});
 listen('progress',d=>{if(!d)return;if(d.prompt_id!=null){if(d.prompt_id!==promptId)return;}else if(!started||observedPrompt!==promptId)return;const key=resolveNode(d.node??activeNode);if(!key)return;started=true;if(d.prompt_id===promptId)observedPrompt=promptId;nodeProgress(key,d.value,d.max);});
 listen('progress_state',d=>{
   if(!d||d.prompt_id!==promptId)return;started=true;observedPrompt=promptId;let changed=null;
   for(const [raw,node] of Object.entries(d.nodes||{})){
     if(node.prompt_id!=null&&node.prompt_id!==promptId)continue;
     const key=resolveNode(raw,node.node_id,node.real_node_id,node.display_node_id,node.parent_node_id);if(!key)continue;
     nodeAliases.set(raw,key);if(node.node_id!=null)nodeAliases.set(String(node.node_id),key);
     const stamp=`${node.state}:${node.value}:${node.max}`,previous=nodeStates.get(raw);nodeStates.set(raw,stamp);
     if(node.state==='running'&&stamp!==previous)changed={key,value:node.value,max:Number(node.max)>1||Number(node.value)>0?node.max:0};
   }
   if(changed)nodeProgress(changed.key,changed.value,changed.max);
 });
 for(const event of ['execution_success','execution_error','execution_interrupted'])listen(event,d=>{if(d?.prompt_id===observedPrompt)observedPrompt=null;if(d?.prompt_id===promptId)activeNode=null;});
 try{
   emit({phase:'提交工作流',detail:'',max:0,value:0});
   // Keep this request alive when stopping: its returned ID is needed to cancel safely.
   const response=await api.queuePrompt(0,graph);promptId=response?.prompt_id;if(!promptId)throw new Error('提交失败：未返回任务编号');
   emit({phase:'排队中',detail:`任务 ${promptId}`,max:0,value:0});
   for(const [name,event] of early){const handler=listeners.find(x=>x[0]===name)?.[2];handler?.(event.detail??null);}
   for(;;){
     if(signal?.aborted&&!cancelSent&&Date.now()>=nextCancel){
       report({phase:'停止中',detail:'正在取消本次任务；等待当前处理退出',max:0,value:0});
       try{const response=await api.fetchApi(`/api/jobs/${encodeURIComponent(promptId)}/cancel`,{method:'POST'});if(!response.ok)throw new Error(`停止请求失败：${response.status}`);cancelSent=true;}
       catch(error){nextCancel=Date.now()+2000;report({phase:'停止请求失败，重试中',detail:error.message,max:0,value:0});}
     }
     const r=await api.fetchApi(`/history/${encodeURIComponent(promptId)}`);if(!r.ok)throw new Error('无法读取任务执行状态');const h=(await r.json())[promptId];
     if(h){const errors=(h.status?.messages||[]).filter(m=>['execution_error','execution_interrupted'].includes(m[0]));if(errors.length){if(signal?.aborted&&errors[0][0]==='execution_interrupted')throw new DOMException('当前任务已停止','AbortError');throw new Error(errors[0][1]?.exception_message||'任务已中断');}
       if(h.status?.completed||h.status?.status_str==='success'){const files=[];const scan=v=>{if(!v||typeof v!=='object')return;if(v.filename&&/\.(mp4|webm|mov|mkv)$/i.test(v.filename))files.push(v);else for(const x of Object.values(v))scan(x);};scan(h.outputs);report({phase:'已完成',detail:'',value:1,max:1,node:null});return {promptId,file:files.at(-1)||null};}}
     if(!started||signal?.aborted){const q=await api.fetchApi('/queue');if(q.ok){const state=await q.json(),running=(state.queue_running||[]).some(x=>x[1]===promptId),pending=state.queue_pending||[],position=pending.findIndex(x=>x[1]===promptId);if(signal?.aborted&&cancelSent&&!running&&position<0)throw new DOMException('当前任务已停止','AbortError');if(running&&!started){started=true;observedPrompt=promptId;emit({phase:'工作流执行中',detail:'等待当前节点状态',max:0,value:0});}else if(position>=0)emit({phase:'排队中',detail:`前面 ${position+(state.queue_running?.length||0)} 个任务`,max:0,value:0});}}
     await new Promise(resolve=>setTimeout(resolve,700));
   }
 }finally{for(const [name,handler] of listeners)api.removeEventListener(name,handler);}
}
app.registerExtension({name:'ComfyUI.MotionTransferDirector',setup(){
    globalThis.ComfyUIMotionTransferDirector=Object.freeze({apiVersion:1,pluginId:'comfyui-motion-transfer-director',open:openMotionDirector});
},beforeRegisterNodeDef(nodeType,nodeData){
    if(nodeData.name!=='ComfyUIMotionTransferDirector')return;
    const previousConfigure=nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure=function(){
        const result=previousConfigure?.apply(this,arguments);
        if(this.outputs?.length>=2){
            for(let index=this.outputs.length;index<nodeData.output.length;index++){
                const type=nodeData.output[index];
                this.addOutput(nodeData.output_name?.[index]||type,type);
            }
        }
        return result;
    };
    const referenceOnly=true;
    const previous=nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated=function(){
        const result=previous?.apply(this,arguments);
        const snapshot=this.widgets?.find(w=>w.name==='shot_json');
        if(snapshot){snapshot.type='converted-widget';snapshot.hidden=true;snapshot.computeSize=()=>[0,-4];snapshot.draw=()=>{};snapshot.serializeValue=async()=>snapshot.value;if(snapshot.element)snapshot.element.style.display='none';}
        this.addWidget('button','打开动作迁移角色替换工作台',null,()=>{
            let initialShot=null;try{initialShot=JSON.parse(snapshot?.value||'{}');}catch{}
            const session=this._motionDirectorSession??={uploads:new WeakMap(),saveRevision:0};
            const saveProject=async project=>{
                const revision=++session.saveRevision;
                const persistAsset=async asset=>{
                    if(!asset)return null;
                    if(!asset.inputPath){let pending=session.uploads.get(asset.file);if(!pending){pending=uploadAsset(asset).catch(error=>{session.uploads.delete(asset.file);throw error;});session.uploads.set(asset.file,pending);}asset.inputPath=await pending;}
                    return {inputPath:asset.inputPath,name:asset.name,duration:asset.duration,width:asset.width,height:asset.height};
                };
                const saved=await Promise.all(project.shots.map(async shot=>{
                    const [video,character,additionalCharacters]=await Promise.all([persistAsset(shot.video),persistAsset(shot.character),Promise.all((shot.additionalCharacters||[]).map(persistAsset))]);
                    return {...shot,video,character,...(additionalCharacters.length?{additionalCharacters}:shot.additionalCharacters?{additionalCharacters:[]}:{} )};
                }));
                if(revision!==session.saveRevision||!snapshot)return;
                let current={};try{current=JSON.parse(snapshot.value||'{}');}catch{}
                current.projectState={shots:saved,activeShotId:project.activeShotId,playhead:project.playhead,generationSettings:{...project.generationSettings},previewTracks:project.previewTracks,selectedShotIds:project.selectedShotIds||[],shotSelectionInitialized:Boolean(project.shotSelectionInitialized)};snapshot.value=JSON.stringify(current);this.setDirtyCanvas?.(true,true);
            };
            openMotionDirector({session,onSaveProject:saveProject,initialShot,mediaOnly:!referenceOnly,referenceOnly,onSubmit:async(shot,report=()=>{},{signal}={})=>{
                if(!String(shot.prompt||'').trim())throw new Error('请先填写当前分镜提示词，不能为空或只有空格');
                const extra=shot.additionalCharacters||[],total=2+extra.length;
                signal?.throwIfAborted();let ready=0;report({phase:'检查／上传分镜素材',detail:'参考视频与角色图',value:0,max:total});
                const prepare=async(asset,label)=>{let path=asset.inputPath;if(!path){let pending=session.uploads.get(asset.file);if(!pending){pending=uploadAsset(asset,signal).catch(error=>{session.uploads.delete(asset.file);throw error;});session.uploads.set(asset.file,pending);}path=await pending;}signal?.throwIfAborted();report({phase:'检查／上传分镜素材',detail:`${label}已就绪`,value:++ready,max:total});return path;};
                const [video,character,...additionalCharacters]=await Promise.all([prepare(shot.video,'参考视频'),prepare(shot.character,'参考图 1'),...extra.map((asset,index)=>prepare(asset,'参考图 '+(index+2)))]);
                signal?.throwIfAborted();
                const data={version:1,id:shot.id,runToken:shot.runToken,name:shot.name,shotIndex:shot.shotIndex,filenamePrefix:shot.filenamePrefix,mode:shot.mode,prompt:shot.prompt,originalPrompt:shot.prompt,
                    video,character,...(additionalCharacters.length?{additionalCharacters}:{}),inPoint:shot.inPoint,outPoint:shot.outPoint,
                    duration:shot.video.duration,width:shot.video.width,height:shot.video.height,
                    generationWidth:shot.generationWidth,generationHeight:shot.generationHeight,generationAspect:shot.generationAspect,generationMegapixels:shot.generationMegapixels,refImageSize:shot.refImageSize,
                    referenceVideoMode:shot.referenceVideoMode||'original',referenceVideoWidth:shot.referenceVideoWidth,referenceVideoHeight:shot.referenceVideoHeight};
                if(!snapshot)throw new Error('节点缺少 shot_json，请更新并重启 ComfyUI');
                let stored={};try{stored=JSON.parse(snapshot.value||'{}');}catch{}snapshot.value=JSON.stringify({...data,projectState:stored.projectState});this.setDirtyCanvas?.(true,true);if(session.project)await saveProject(session.project);

            },onRun:async(shot,report,control)=>runDirector(this,report,control),
            onLibraryRequest:async(path,options={})=>{const r=await api.fetchApi('/xiantu/video-editor/common-assets'+path,options);const data=await r.json();if(!r.ok)throw new Error(data.error||'资产库操作失败');return data;},
            libraryAssetUrl:asset=>api.apiURL('/xiantu/video-editor/common-assets/content?'+new URLSearchParams({id:asset.id,v:asset.updatedAt||''})),
            initialSettings:this.properties?.xiantuMotionRunSettings,
            onSettingsChange:settings=>{this.properties??={};this.properties.xiantuMotionRunSettings={...settings};this.setDirtyCanvas?.(true,true);},
            onHardware:async()=>{const r=await api.fetchApi('/xiantu/video-editor/hardware');if(!r.ok)throw new Error('硬件监控服务不可用');return r.json();},
            onCleanup:async(settings,{signal}={})=>{const r=await api.fetchApi('/xiantu/motion-director/cleanup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(settings),signal,timeoutMs:null});const data=await r.json();if(!r.ok||!data.ok)throw new Error(data.error||'资源清理失败');return data;}});
        },{serialize:false});
        this.setSize([340,Math.max(referenceOnly?160:100,this.computeSize()[1])]);
        return result;
    };
}});
