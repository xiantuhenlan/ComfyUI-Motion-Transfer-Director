export function createMediaPreloader({onChange=()=>{},fetchMedia=(url,signal)=>fetch(url,{signal})}={}){
 const files=new Map();
 let order=[],loading=0,closed=false;
 const remote=url=>typeof url==='string'&&/^https?:\/\//i.test(url);
 function remove(url,file){
  files.delete(url);file.controller?.abort();
  if(file.blobUrl)URL.revokeObjectURL(file.blobUrl);
 }
 async function read(url,file){
  const controller=new AbortController();
  file.controller=controller;file.state='loading';loading++;
  try{
   const response=await fetchMedia(url,controller.signal);
   if(!response.ok||response.status===206)throw new Error('无法预载完整视频');
   const blob=await response.blob();
   if(files.get(url)!==file)return;
   if(!blob.size)throw new Error('视频文件为空');
   file.blobUrl=URL.createObjectURL(blob);file.state='ready';
  }catch{
   if(files.get(url)===file)file.state='failed';
  }finally{
   loading--;file.controller=null;
   if(!closed){
    pump();
    if(files.get(url)===file)onChange(url);
   }
  }
 }
 function pump(){
  for(const url of order){
   if(loading>=4)return;
   const file=files.get(url);
   if(file?.state==='queued')void read(url,file);
  }
 }
 function update(urls){
  if(closed)return;
  const wanted=new Set(urls.filter(remote));
  for(const [url,file] of files)if(!wanted.has(url))remove(url,file);
  order=[...wanted];
  for(const url of order)if(!files.has(url))files.set(url,{state:'queued',blobUrl:null,controller:null});
  pump();
 }
 function progress(urls=order){
  let total=0,ready=0,pending=0;
  for(const url of new Set(urls.filter(remote))){
   total++;
   const state=files.get(url)?.state;
   if(state==='ready')ready++;
   else if(state!=='failed')pending++;
  }
  return {total,ready,pending};
 }
 function resolve(url,{wait=false}={}){
  const file=files.get(url);
  if(file?.blobUrl)return file.blobUrl;
  return wait&&file&&file.state!=='failed'?null:url||null;
 }
 function dispose(){
  closed=true;order=[];
  for(const [url,file] of files)remove(url,file);
 }
 return {update,progress,resolve,dispose};
}

// Keep the displayed frame while the next clip is loading or seeking.
export function createResultPreview({area,prepare,controls=true,seekNext=false,onMetadata=()=>{},onReady=()=>{},onError=()=>{},createVideo=()=>document.createElement('video'),requestFrame=callback=>requestAnimationFrame(callback),cancelFrame=handle=>cancelAnimationFrame(handle)}){
 let current=null,visible=null,nextUrl=null,nextTime=0,target=0,frame=null,disposed=false;
 const entries=[];
 const readError='视频无法读取，文件可能已被清理或格式不可播放';
 const clampTime=(video,time)=>Math.max(0,Math.min(time,Math.max(0,video.duration-.001)));
 function pause(entry){if(entry&&!entry.video.paused)entry.video.pause();}
 function entryFor(url){return entries.find(e=>e.url===url)||entries.find(e=>e!==visible&&e!==current)||entries.find(e=>e!==visible)||null;}
 function create(){
  const video=createVideo();video.playsInline=true;video.preload='auto';video.hidden=true;video.controls=false;
  const entry={video,url:null,failed:false,handlers:{}};entries.push(entry);area.append(video);
  entry.handlers={
   loadedmetadata:()=>{if(entry===current)onMetadata(video,entry.url);else prime(entry);},
   loadeddata:schedule,canplay:schedule,seeked:schedule,
   error:()=>{if(!video.error)return;entry.failed=true;if(entry===current)onError(entry.url,readError);}
  };
  for(const [event,handler] of Object.entries(entry.handlers))video.addEventListener(event,handler);
  return entry;
 }
 function load(entry,url,activate=false){
  const video=entry.video,changed=entry.url!==url;
  const wanted=clampTime(video,target);
  const primed=activate&&!changed&&!entry.failed&&!video.error&&video.readyState>=2&&!video.seeking&&Number.isFinite(video.duration)&&Math.abs(video.currentTime-wanted)<=.06;
  entry.url=url;if(changed)entry.failed=false;
  prepare(video,url,activate,primed);return primed;
 }
 function prime(entry){
  const video=entry.video;
  if(!seekNext||entry===current||entry.url!==nextUrl||entry.failed||video.readyState<1||!Number.isFinite(video.duration))return;
  const wanted=clampTime(video,nextTime);
  if(!video.seeking&&Math.abs(video.currentTime-wanted)>.01)video.currentTime=wanted;
 }
 function prefetch(){
  if(disposed||!nextUrl||nextUrl===current?.url||current!==visible)return;
  let entry=entryFor(nextUrl);if(!entry&&entries.length<2)entry=create();if(!entry||entry===current||entry===visible)return;
  pause(entry);entry.video.hidden=true;entry.video.controls=false;load(entry,nextUrl);prime(entry);
 }
 function present(){
  frame=null;if(disposed||!current)return;
  const entry=current,video=entry.video;if(entry.failed||video.error){onError(entry.url,readError);return;}if(video.readyState<2||video.seeking||!Number.isFinite(video.duration)||video.duration<=0)return;
  const wanted=clampTime(video,target);if(Math.abs(video.currentTime-wanted)>.18)return;
  const old=visible;visible=entry;video.hidden=false;video.style.zIndex='2';video.controls=controls;
  if(old&&old!==entry){pause(old);old.video.controls=false;old.video.hidden=true;old.video.style.zIndex='0';}
  if(old!==entry)onReady();prefetch();
 }
 function schedule(){if(!disposed&&frame==null)frame=requestFrame(present);}
 function select(url,{continuous=false,time=0}={}){
  if(disposed)return;
  if(!url){current=null;visible=null;for(const entry of entries){pause(entry);entry.video.hidden=true;entry.video.controls=false;}return;}
  target=Math.max(0,Number(time)||0);
  if(current?.url===url){schedule();return;}
  let entry=entryFor(url);if(!entry&&entries.length<2)entry=create();if(!entry)return;
  current=entry;
  if(visible&&visible!==entry){pause(visible);visible.video.controls=false;}
  entry.video.hidden=false;entry.video.style.zIndex=visible===entry?'2':'0';entry.video.controls=controls&&visible===entry;
  const primed=load(entry,url,true);
  if(continuous&&primed)present();else schedule();
 }
 function setTime(value){target=Math.max(0,Number(value)||0);if(current!==visible)schedule();}
 function setNext(url,time=0){const next=url||null,at=Math.max(0,Number(time)||0);if(next===nextUrl&&at===nextTime)return;nextUrl=next;nextTime=at;prefetch();}
 function dispose(){disposed=true;if(frame!=null)cancelFrame(frame);frame=null;current=null;visible=null;for(const entry of entries){pause(entry);for(const [event,handler] of Object.entries(entry.handlers))entry.video.removeEventListener(event,handler);entry.video.remove();}entries.length=0;}
 return {select,setTime,setNext,dispose,get media(){return current?.video||null;},get displaying(){return Boolean(visible&&!visible.video.hidden);}};
}
