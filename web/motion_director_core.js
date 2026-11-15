export function createMotionId(){
    if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
    const bytes=crypto.getRandomValues(new Uint8Array(16));
    bytes[6]=(bytes[6]&0x0f)|0x40;
    bytes[8]=(bytes[8]&0x3f)|0x80;
    const hex=Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
    return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}
export function createShot(index=1){return {id:createMotionId(),name:`分镜 ${String(index).padStart(2,'0')}`,mode:'motion',prompt:'',video:null,character:null,results:[],inPoint:0,outPoint:null};}
export function createProject(){const shot=createShot();return {shots:[shot],activeShotId:shot.id,playhead:0};}
export function activeShot(project){return project.shots.find(s=>s.id===project.activeShotId);}
export function addShot(project){const allSelected=project.shots.length>0&&selectedShotIds(project).length===project.shots.length,shot=createShot(project.shots.length+1);project.shots.push(shot);if(allSelected)setShotSelected(project,shot.id,true);project.activeShotId=shot.id;return shot;}
export function selectShot(project,id){if(!project.shots.some(s=>s.id===id))return false;project.activeShotId=id;return true;}
export function selectedShotIds(project){const ids=new Set(project.selectedShotIds||[]);return project.shots.filter(shot=>ids.has(shot.id)).map(shot=>shot.id);}
export function initializeShotSelection(project){const ids=selectedShotIds(project);project.selectedShotIds=!project.shotSelectionInitialized&&!ids.length?project.shots.map(shot=>shot.id):ids;project.shotSelectionInitialized=true;}
export function setAllShotsSelected(project,selected){project.selectedShotIds=selected?project.shots.map(shot=>shot.id):[];project.shotSelectionInitialized=true;}
export function setShotSelected(project,id,selected){const ids=new Set(selectedShotIds(project));if(selected)ids.add(id);else ids.delete(id);project.selectedShotIds=project.shots.filter(shot=>ids.has(shot.id)).map(shot=>shot.id);project.shotSelectionInitialized=true;}
export function deleteShot(project,id){
    const index=project.shots.findIndex(s=>s.id===id);if(index<0)return null;
    const [removed]=project.shots.splice(index,1);
    project.selectedShotIds=selectedShotIds(project);
    if(!project.shots.length)project.shots.push(createShot());
    project.shots.forEach((shot,i)=>{shot.name=`分镜 ${String(i+1).padStart(2,'0')}`;});
    if(!activeShot(project))project.activeShotId=project.shots[Math.min(index,project.shots.length-1)].id;
    project.playhead=timelineClips(project).find(c=>c.shot.id===project.activeShotId)?.timelineStart||0;
    return removed;
}
export function clipBounds(shot){
    const duration=Number(shot?.video?.duration);if(!Number.isFinite(duration)||duration<=0)return null;
    const start=Number(shot.inPoint??0),end=Number(shot.outPoint??duration);
    if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end>duration||end<=start)return null;
    return {start,end,duration:end-start,sourceDuration:duration};
}
export function timelineClips(project){let position=0;return project.shots.flatMap(shot=>{const bounds=clipBounds(shot);if(!bounds)return [];const clip={shot,...bounds,timelineStart:position,timelineEnd:position+bounds.duration};position+=bounds.duration;return [clip];});}
export function trimShot(shot,start,end){
    const candidate={...shot,inPoint:Number(start),outPoint:Number(end)};
    if(!clipBounds(candidate))throw new Error('入点、出点须在源视频范围内，且出点大于入点');
    shot.inPoint=candidate.inPoint;shot.outPoint=candidate.outPoint;return shot;
}
export function splitShot(project,id,sourceTime){
    const index=project.shots.findIndex(s=>s.id===id),shot=project.shots[index],bounds=clipBounds(shot),point=Number(sourceTime);
    if(!bounds||!Number.isFinite(point)||point<=bounds.start+1e-6||point>=bounds.end-1e-6)throw new Error('请把播放位置移到当前分镜内部再切分');
    const right={...createShot(project.shots.length+1),mode:shot.mode,prompt:shot.prompt,generationWidth:shot.generationWidth,generationHeight:shot.generationHeight,generationAspect:shot.generationAspect,generationMegapixels:shot.generationMegapixels,refImageSize:shot.refImageSize,referenceVideoMode:shot.referenceVideoMode,referenceVideoWidth:shot.referenceVideoWidth,referenceVideoHeight:shot.referenceVideoHeight,video:{...shot.video},character:shot.character?{...shot.character}:null,additionalCharacters:(shot.additionalCharacters||[]).map(asset=>({...asset})),inPoint:point,outPoint:bounds.end};
    shot.inPoint=bounds.start;shot.outPoint=point;project.shots.splice(index+1,0,right);if(selectedShotIds(project).includes(id))setShotSelected(project,right.id,true);project.shots.forEach((item,position)=>{item.name=`分镜 ${String(position+1).padStart(2,'0')}`;});project.activeShotId=right.id;return right;
}
export function locateTimelineTime(project,time,clips=timelineClips(project)){
    if(!clips.length)return null;
    const total=clips.at(-1).timelineEnd,t=Math.min(total,Math.max(0,Number(time)||0));
    const clip=clips.find((c,i)=>t<c.timelineEnd||i===clips.length-1);
    return {clip,time:t,sourceTime:clip.start+t-clip.timelineStart};
}

export const generationAspects={'1:1':1,'2:3':2/3,'3:2':3/2,'3:4':3/4,'4:3':4/3,'9:16':9/16,'16:9':16/9,'21:9':21/9};
export function generationResolution(aspect,megapixels){const ratio=generationAspects[aspect]||generationAspects['3:4'],pixels=Math.max(.1,Math.min(3,Number(megapixels)||.5))*1024*1024;return {width:Math.max(32,Math.round(Math.sqrt(pixels*ratio)/32)*32),height:Math.max(32,Math.round(Math.sqrt(pixels/ratio)/32)*32)};}
export function generationSelection(shot){const width=shot.generationWidth||640,height=shot.generationHeight||832;for(const aspect of Object.keys(generationAspects))for(let i=1;i<=30;i++){const size=generationResolution(aspect,i/10);if(size.width===width&&size.height===height)return {aspect,megapixels:i/10,width,height};}const aspect=Object.keys(generationAspects).reduce((a,b)=>Math.abs(Math.log(generationAspects[a]/(width/height)))<Math.abs(Math.log(generationAspects[b]/(width/height)))?a:b);return {aspect,megapixels:'existing',width,height};}

export function globalGenerationSettings(project){
    const shot=activeShot(project)||{};
    if(!project.generationSettings)project.generationSettings={generationWidth:shot.generationWidth||640,generationHeight:shot.generationHeight||832,generationAspect:shot.generationAspect,generationMegapixels:shot.generationMegapixels,refImageSize:shot.refImageSize||'max'};
    const settings=project.generationSettings;
    settings.referenceVideoMode??=shot.referenceVideoMode||'original';
    settings.referenceVideoWidth??=shot.referenceVideoWidth||640;
    settings.referenceVideoHeight??=shot.referenceVideoHeight||384;
    return settings;
}

export function planDirectorRun(project,scope='sequence'){
    const index=project.shots.findIndex(s=>s.id===project.activeShotId);
    const ids=new Set(selectedShotIds(project));
    const shots=scope==='selected'?project.shots.filter(shot=>ids.has(shot.id)):scope==='current'?[project.shots[index]]:project.shots.slice(index);
    if(scope==='selected'&&!shots.length)throw new Error('请先勾选需要生成的分镜');
    if((scope!=='selected'&&index<0)||!shots.length)throw new Error('没有可运行的分镜');
    const settings={...globalGenerationSettings(project)};
    return shots.map(shot=>{
        let reason='';const bounds=clipBounds(shot);
        const availablePictures=Number(Boolean(shot.character))+(shot.additionalCharacters?.length||0);
        const missingPicture=[...String(shot.prompt||'').matchAll(/<Picture\s+(\d+)>/gi)].find(match=>Number(match[1])>availablePictures);
        if(!String(shot.prompt||'').trim())reason='请填写提示词，不能为空或只有空格';
        else if(!bounds||!shot.character)reason='请选择视频、有效分镜范围和角色参考图';
        else if(missingPicture)reason='请添加提示词引用的参考图 '+missingPicture[1];
        if(reason){const error=new Error(`${shot.name}：${reason}`);error.shotId=shot.id;error.focusPrompt=!String(shot.prompt||'').trim();throw error;}
        return {...shot,...settings,shotIndex:project.shots.indexOf(shot)+1,runToken:createMotionId(),video:{...shot.video},character:{...shot.character},additionalCharacters:(shot.additionalCharacters||[]).map(asset=>({...asset})),inPoint:bounds.start,outPoint:bounds.end};
    });
}
