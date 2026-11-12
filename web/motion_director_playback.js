import {locateTimelineTime,timelineClips} from './motion_director_core.js';

export function createPreviewTransport({project,tracks,getSource,getResult,onPlayRequest=()=>play(),onFrame=()=>{},onState=()=>{},onError=()=>{},now=()=>performance.now(),requestFrame=callback=>requestAnimationFrame(callback),cancelFrame=handle=>cancelAnimationFrame(handle)}){
 let playing=false,disposed=false,handle=null,baseTime=0,basePosition=0,heldPosition=null,currentClip=null;
 let clips=[];
 const bound=new Map(),ignorePause=new WeakSet(),expectedSeek=new WeakMap(),pendingPlay=new WeakMap(),needsSeek=new WeakSet();
 let failedPlay=new WeakSet();
 const total=()=>clips.at(-1)?.timelineEnd||0;
 const mediaFor=kind=>kind==='source'?getSource():getResult();
 const position=()=>heldPosition??Math.min(total(),basePosition+(now()-baseTime)/1000);
 const resultRate=(media,clip)=>{
  const duration=media.duration;
  return Number.isFinite(duration)&&duration>0&&Math.abs(duration-clip.duration)<=1/24?duration/clip.duration:1;
 };
 const sourceTime=(kind,media,clip)=>kind==='source'?media.currentTime-clip.start:media.currentTime/resultRate(media,clip);

 function pauseMedia(media){
  if(!media)return;
  pendingPlay.delete(media);
  if(!media.paused){ignorePause.add(media);media.pause();}
 }
 function seekMedia(media,target){
  expectedSeek.set(media,target);media.currentTime=target;
 }
 function prepareMedia(media,kind,url,{forceSeek=false,positionReady=false}={}){
  if(!media)return;
  bindMedia(media,kind);
  if(!url){pauseMedia(media);media.removeAttribute('src');needsSeek.delete(media);return;}
  const changed=media.getAttribute('src')!==url;
  if(changed){
   pauseMedia(media);media.src=url;failedPlay.delete(media);expectedSeek.delete(media);needsSeek.add(media);
  }
  if(positionReady&&!changed&&media.readyState>=2&&!media.seeking)needsSeek.delete(media);
  else if(forceSeek)needsSeek.add(media);
 }
 function bindMedia(media,kind){
  if(bound.has(media))return;
  const isCurrent=()=>media===mediaFor(kind);
  const update=()=>{if(isCurrent())refresh();};
  const handlers={
   play:()=>{
    if(media.paused)return;
    if(!isCurrent()||!tracks[kind].video||media.error){pauseMedia(media);return;}
    if(playing)return;
    const clip=timelineClips(project).find(c=>c.shot.id===project.activeShotId);
    if(clip){seek(clip.timelineStart+sourceTime(kind,media,clip));onPlayRequest();}
   },
   pause:()=>{
    if(ignorePause.delete(media)||!isCurrent())return;
    if(playing&&tracks[kind].video&&media.readyState>=2&&!media.ended)pause();
   },
   seeking:()=>{
    if(!isCurrent()||needsSeek.has(media)||!tracks[kind].video)return;
    const expected=expectedSeek.get(media);
    if(expected!=null&&Math.abs(media.currentTime-expected)<.08)return;
    const clip=timelineClips(project).find(c=>c.shot.id===project.activeShotId);
    if(clip)seek(clip.timelineStart+sourceTime(kind,media,clip));
   },
   seeked:()=>{if(!media.seeking)expectedSeek.delete(media);update();},
   loadedmetadata:update,canplay:update,
   error:()=>{failedPlay.add(media);pauseMedia(media);update();}
  };
  for(const [event,callback] of Object.entries(handlers))media.addEventListener(event,callback);
  bound.set(media,handlers);
 }
 function prepareTrack(kind,clip,local,force){
  const media=mediaFor(kind);
  if(!media)return null;
  media.muted=!tracks[kind].audio;
  if(!media.getAttribute('src')||!tracks[kind].video){pauseMedia(media);return null;}
  if(force)needsSeek.add(media);
  if(media.error||failedPlay.has(media)){pauseMedia(media);return null;}
  if(media.readyState<1||!Number.isFinite(media.duration)||media.duration<=0)return {media,waiting:true};

  const rate=kind==='result'?resultRate(media,clip):1;
  if(media.playbackRate!==rate)media.playbackRate=rate;
  const time=kind==='source'?clip.start+local:local*rate;
  const exhausted=time>=media.duration;
  const target=Math.max(0,Math.min(time,media.duration-.001));
  if(!media.seeking&&(needsSeek.has(media)||(!exhausted&&Math.abs(media.currentTime-target)>.15))){
   needsSeek.delete(media);
   if(Math.abs(media.currentTime-target)>.006)seekMedia(media,target);
  }
  return {media,exhausted,waiting:!exhausted&&(media.seeking||media.readyState<2)};
 }
 function playTrack({media,exhausted}){
  if(exhausted){pauseMedia(media);return true;}
  if(!pendingPlay.has(media)&&media.paused){
   const attempt={};pendingPlay.set(media,attempt);
   Promise.resolve(media.play()).catch(error=>{
    if(pendingPlay.get(media)!==attempt)return;
    failedPlay.add(media);if(!disposed)onError(error.message||'视频无法播放');
   }).finally(()=>{if(pendingPlay.get(media)===attempt)pendingPlay.delete(media);});
  }
  return !media.paused;
 }
 function synchronize(force=false,forceKind=null,selectedId=null){
  let located=locateTimelineTime(project,project.playhead,clips);
  if(selectedId){
   const clip=clips.find(c=>c.shot.id===selectedId);if(!clip)return true;
   const time=Math.max(clip.timelineStart,Math.min(clip.timelineEnd,project.playhead));
   project.playhead=time;located={clip,time,sourceTime:clip.start+(time-clip.timelineStart)};
  }
  if(!located)return true;
  const clip=located.clip,local=located.time-clip.timelineStart;
  currentClip=clip;
  onFrame(located);
  const source=prepareTrack('source',clip,local,force&&(!forceKind||forceKind==='source'));
  const result=prepareTrack('result',clip,local,force&&(!forceKind||forceKind==='result'));
  const primary=result||source;
  if(!playing||primary?.waiting){
   pauseMedia(source?.media);pauseMedia(result?.media);
   return !playing;
  }
  const ready=primary?playTrack(primary):true;
  if(result&&source){
   if(!ready||source.waiting)pauseMedia(source.media);
   else playTrack(source);
  }
  return ready;
 }
 function resetClock(at){basePosition=at;baseTime=now();heldPosition=null;}
 function advance(){
  const end=total();
  let at=position();
  // Let a cold transition wait at its first frame, even if the browser skips a tick.
  if(currentClip&&currentClip.timelineEnd<end&&at>=currentClip.timelineEnd){
   at=currentClip.timelineEnd;resetClock(at);
  }
  project.playhead=at;
  const ready=synchronize();
  if(at>=end){pause();return;}
  if(!ready)heldPosition=at;
  else if(heldPosition!=null)resetClock(at);
 }
 function tick(){
  handle=null;
  if(!playing||disposed)return;
  advance();
  if(playing)handle=requestFrame(tick);
 }
 function play(){
  if(disposed||playing)return;
  clips=timelineClips(project);if(!total())return;
  if(project.playhead>=total())project.playhead=0;
  playing=true;currentClip=null;resetClock(project.playhead);heldPosition=project.playhead;
  failedPlay=new WeakSet();onState(true);advance();
  if(playing)handle=requestFrame(tick);
 }
 function pause(){
  playing=false;heldPosition=null;
  if(handle!=null)cancelFrame(handle);handle=null;
  pauseMedia(getSource());pauseMedia(getResult());onState(false);
 }
 function seek(value,{keepSelection=false}={}){
  clips=timelineClips(project);
  project.playhead=Math.max(0,Math.min(total(),Number(value)||0));resetClock(project.playhead);
  if(!synchronize(true,null,keepSelection?project.activeShotId:null)&&playing)heldPosition=project.playhead;
 }
 function refresh(){
  if(disposed)return;
  clips=timelineClips(project);
  if(playing)advance();else synchronize(false,null,project.activeShotId);
 }
 function setTrack(kind,key,value){
  tracks[kind][key]=Boolean(value);
  const media=mediaFor(kind);if(media)failedPlay.delete(media);
  if(playing)advance();else synchronize(key==='video'&&value,kind,project.activeShotId);
 }
 function dispose(){
  pause();disposed=true;
  for(const [media,handlers] of bound)for(const [event,callback] of Object.entries(handlers))media.removeEventListener(event,callback);
  bound.clear();
 }
 return {play,pause,seek,refresh,setTrack,bindMedia,prepareMedia,dispose,get playing(){return playing;}};
}
