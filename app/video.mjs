import {FRAME_CHOICES} from './public/video-timing.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomInt} from 'node:crypto';
import {directorState} from './video-director.mjs';
import {validateClipSettings,validateSceneCount,controllerStateFromSession} from './video-settings.mjs';
import {createVideoRun,TURBO_FILE} from './video-generation.mjs';
import {OUTLINE_MODES} from './video-outline.mjs';
import {validateReferences} from './video-references.mjs';
import {createMergeRun} from './video-merge.mjs';
import {outputFile,publicVideo,listSessions,readSession,sessionFolder} from './video-storage.mjs';
import {holdAwake} from './video-awake.mjs';

export function createVideoEngine({root,isOtherBusy,spawnProcess=spawn,now=Date.now,keepAwake=holdAwake,freeBytes=()=>{const s=fs.statfsSync(root);return s.bavail*s.bsize;}}){
 const outputs=path.join(root,'outputs'),inputs=path.join(root,'inputs'),logs=path.join(root,'logs');
 const cli=path.join(root,'runtime/sd/sd-cli.exe'),ffmpeg=path.join(root,'runtime/ffmpeg/ffmpeg.exe');
 const folder=path.join(root,'models/minimax-h3');
 const files={diffusion:'minimax_h3_fl2va_pruned-Q4_K_M.gguf',encoder:'qwen3vl_32b_minimax_h3-Q4_K_M.gguf',vae:'minimax_h3_video_vae_fp16.safetensors',audio:'minimax_h3_audio_vae_fp32.safetensors'};
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'video-model-downloads.json'),'utf8'));
 const referenceDiffusion='minimax_h3_ref2va_pruned-Q4_K_M.gguf';
 let referenceManifest=[];try{referenceManifest=JSON.parse(fs.readFileSync(path.join(root,'video-reference-downloads.json'),'utf8'));}catch{}
 let job=null,active=null,currentBatch=null;
 const fail=(message,status=400)=>{const e=new Error(message);e.status=status;throw e;};
 function download(){const entries=['video-download-progress.json','video-reference-download-progress.json'].flatMap(name=>{try{return [JSON.parse(fs.readFileSync(path.join(logs,name),'utf8'))];}catch{return [];}});if(!entries.length)return null;const totalBytes=entries.reduce((n,p)=>n+p.totalBytes,0),downloadedBytes=entries.reduce((n,p)=>n+p.downloadedBytes,0),bytesPerSecond=entries.reduce((n,p)=>n+(Date.now()-Date.parse(p.updatedAt)<45000&&p.downloadedBytes<p.totalBytes?p.bytesPerSecond||0:0),0);return {totalBytes,downloadedBytes,bytesPerSecond,etaSeconds:bytesPerSecond?(totalBytes-downloadedBytes)/bytesPerSecond:null,updatedAt:entries.map(p=>p.updatedAt).sort().at(-1),files:entries.flatMap(p=>p.files||[])};}
 function ready(reference=false){const names=[reference?referenceDiffusion:files.diffusion,files.encoder,files.vae,files.audio];return names.every(file=>{try{return fs.statSync(path.join(folder,file)).size===[...manifest,...referenceManifest].find(f=>f.file.endsWith('/'+file)).bytes;}catch{return false;}})&&[cli,ffmpeg,path.join(root,'runtime/ffmpeg/ffprobe.exe')].every(file=>fs.existsSync(file));}
 function gallery(sessions){const items=fs.readdirSync(outputs).filter(n=>n.endsWith('.json')).sort().reverse().flatMap(n=>{try{const m=JSON.parse(fs.readFileSync(path.join(outputs,n),'utf8'));if(m.mediaType==='video'&&m.filename===path.basename(m.filename)&&fs.existsSync(path.join(outputs,m.filename)))return [publicVideo(m)];}catch{}return [];});const joined=new Set(items.filter(m=>m.continuous).map(m=>m.id));return [...sessions.flatMap(s=>s.result?[s.result]:s.latestClip?[s.latestClip]:[]),...items.filter(m=>!m.sequenceId||!joined.has(m.sequenceId))].sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).slice(0,100);}
 function state(){let setup=null,referenceSetup=null;try{setup=JSON.parse(fs.readFileSync(path.join(logs,'video-setup-check.json'),'utf8'));}catch{}try{referenceSetup=JSON.parse(fs.readFileSync(path.join(logs,'video-reference-setup-check.json'),'utf8'));}catch{}const sessions=listSessions(root,active?(job.sessionId||job.id):null);return {liveSettingsSupported:true,liveSceneCountSupported:true,storyExperimentsSupported:true,resumeSupported:true,guidedContinuationSupported:true,director:directorState(root),ready:ready(),referenceReady:ready(true),model:'MiniMax H3',busy:!!active,otherBusy:isOtherBusy(),download:download(),setup,referenceSetup,job:job?{...job,elapsedMs:job.finishedAt?job.elapsedMs:now()-job.startedAt}:null,gallery:gallery(sessions),sessions};}
 function decodeImage(item,label){
  if(!item?.dataUrl)return null;
  const match=/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(item.dataUrl);if(!match)fail(label+' must be a PNG image. Use the image picker to prepare it.');
  const b=Buffer.from(match[1],'base64');if(b.length>10*1024*1024||b.length<24||!b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))fail('Invalid '+label.toLowerCase()+'.');
  const w=b.readUInt32BE(16),h=b.readUInt32BE(20);if(w<1||h<1||w>2048||h>2048||w*h>4194304)fail('Use an image no larger than 2048 pixels per side.');return b;
 }
 function start(data){
  if(!data||typeof data!=='object'||Array.isArray(data))fail('Invalid video request.');
  if(active||isOtherBusy())fail('Wait for the current image, video or prompt to finish.',409);
  const mode=data.mode||'text',continuous=data.continuous===true,continuity='frame';
  if(!['text','image','references'].includes(mode))fail('Choose text, image or references.');
  if(continuous&&data.continuity&&data.continuity!=='frame')fail('Auto-continue now uses the previous final frame. Refresh the Video page and try again.');
  if(!ready(mode==='references')||(continuous&&!ready()))fail('The required video model is still downloading. This button unlocks when it is verified.',409);
  const blankPrompt=data.blankPrompt===true,prompt=blankPrompt?'':String(data.prompt||'').trim();if((!prompt&&!blankPrompt)||prompt.length>7000)fail('Describe your video, or switch on Blank prompt. Keep descriptions under 7,000 characters.');
  const sizes={draft:[512,288],standard:[768,448],large:[1024,576]};const size=sizes[data.size];if(!size)fail('Choose an available video size.');
  const shape=data.shape||'landscape';if(!['landscape','portrait','square'].includes(shape))fail('Choose a video shape.');
  let [width,height]=size;if(shape==='portrait')[width,height]=[height,width];if(shape==='square')width=height;
  let frames=Number(data.frames??124);if(!FRAME_CHOICES.includes(frames))fail('Choose an available duration.');
  const settings=validateClipSettings(data),steps=settings.steps;
  if(settings.turbo!=='off'&&!fs.existsSync(path.join(folder,TURBO_FILE)))fail('Turbo needs its LoRA file (780 MB). Run Install.cmd again (or "Resume video downloads.cmd") to fetch it, or turn Turbo off.',409);if(continuous&&settings.continuationStyle==='guided')frames=Math.max(124,frames);
  if(continuous&&settings.continuationStyle==='guided'&&!directorState(root).ready)fail('Guided continuation is still installing its story helpers. Choose Image only or wait for it to finish.',409);
  let seed=Number(data.seed??-1);if(!Number.isInteger(seed)||seed< -1||seed>2147483647)fail('Seed must be -1 or a whole number up to 2147483647.');if(seed===-1)seed=randomInt(2147483648);settings.seed=seed;
  const refs=mode==='references'?validateReferences(data,{root,fail,decodeImage}):{images:[],video:null,audio:null,includeVideoAudio:true};
  if(mode==='references'&&!refs.images.length&&!refs.video&&!refs.audio)fail('Add at least one reference image, video or audio file.');
  const first=mode==='image'?decodeImage(data.firstImage,'First frame'):null,last=mode==='image'?decodeImage(data.lastImage,'Last frame'):null;
  if(mode==='image'&&!first)fail('Add a first frame to animate.');
  const endMode=continuous?(data.endMode||'scenes'):'duration';
  if(!['scenes','duration','runtime','manual'].includes(endMode))fail('Choose a scene count, video length, PC running time, or Until stopped.');
  if(continuous&&last)fail('Last-frame targeting is available for single clips.');
  const sceneCount=continuous&&endMode==='scenes'?Number(data.sceneCount??12):null;
  if(sceneCount!==null&&(typeof data.sceneCount==='boolean'||!Number.isInteger(sceneCount)||sceneCount<1||sceneCount>2000))fail('Choose a whole number from 1 to 2,000 scenes.');
  const targetSeconds=continuous&&endMode==='duration'?Number(data.targetSeconds??30):null;
  if(targetSeconds!==null&&(!Number.isInteger(targetSeconds)||targetSeconds<1||targetSeconds>600))fail('Total duration must be a whole number between 1 and 600 seconds.');
  const runtimeHours=continuous&&endMode==='runtime'?Number(data.runtimeHours??10):null;
  if(runtimeHours!==null&&(!Number.isFinite(runtimeHours)||runtimeHours<0.25||runtimeHours>168||!Number.isInteger(runtimeHours*4)))fail('Choose a running time from 0.25 to 168 hours, in quarter-hour steps.');
  const mergeWhenDone=data.mergeWhenDone===true||(data.mergeWhenDone===undefined&&endMode!=='runtime');
  const referenceSeconds=Number(data.referenceSeconds??8);if(![2,4,8].includes(referenceSeconds))fail('Choose 2, 4 or 8 seconds of recent reference video.');
  const referenceLastFrame=data.referenceLastFrame!==false,runName=String(data.runName||'').trim();if(runName.length>80)fail('Keep the run name under 80 characters.');
  const overlapFrames=1,totalClips=!continuous?1:sceneCount!==null?sceneCount:targetSeconds===null?null:Math.max(1,1+Math.ceil((targetSeconds*24-frames)/(frames-overlapFrames)));
  const continuationPrompt=String(data.continuationPrompt||'').trim();if(continuationPrompt.length>7000)fail('Keep the continuation prompt under 7,000 characters.');
  if(continuous&&settings.continuationStyle==='custom'&&!continuationPrompt&&!prompt)fail('Enter a custom continuation prompt, or choose Image only.');
  const count=continuous?1:Number(data.count??1);if(!Number.isInteger(count)||count<1||count>4)fail('Choose 1 to 4 videos.');
  const outlineMode=continuous?String(data.storyOutline??'off'):'off';if(!OUTLINE_MODES.includes(outlineMode))fail('Choose a story outline option.');
  const request={settings,prompt,blankPrompt,continuationPrompt,mode,outlineMode,size:data.size,shape,width,height,frames,steps,seed,audio:data.audio!==false,first,last,refs,continuous,continuity,overlapFrames,endMode,sceneCount,targetSeconds,totalClips,runtimeHours,mergeWhenDone,referenceSeconds,referenceLastFrame,runName};
  // Several single clips run one after another (the GPU fits one), each with the next seed. Cancel stops the rest.
  const batch=currentBatch={count,cancelled:false};
  const launch=index=>{
   const clipSeed=(seed+index-1)%2147483648;
   let handle;handle=createVideoRun({root,cli,ffmpeg,folder,files,referenceDiffusion,spawnProcess,now,keepAwake,freeBytes,request:{...request,seed:clipSeed,settings:{...settings,seed:clipSeed},batch:{index,count}},onDone(){
    if(active===handle)active=null;
    if(index<count&&!batch.cancelled&&handle.job.status==='complete')setTimeout(function next(){if(batch.cancelled||active)return;if(isOtherBusy())return setTimeout(next,5000);try{launch(index+1);}catch{}},1000);
   }});
   job=handle.job;active=handle;return handle;
  };
  return {...launch(1).job};
 }
 function update(data){if(!active?.update||!data||data.id!==job.id)fail('This run is no longer active. Refresh its status before applying changes.',409);if(data.clear!==true&&data.settings?.continuationStyle==='guided'&&!directorState(root).ready)fail('The local story helpers are still downloading. Try Guided once they are ready.',409);return active.update(data);}
 function resume(data){
  if(active||isOtherBusy())fail('Wait for the current task to finish before resuming.',409);
  const saved=readSession(root,data?.id),clips=saved.clips;
  if(!saved.continuous||saved.continuity!=='frame'||saved.endMode!=='scenes'||!clips.length)fail('Only a scene-count run with saved clips can resume.');
  if(!ready())fail('The video model is not ready.',409);
  if(clips.some((c,i)=>c.clipIndex!==i+1||!fs.existsSync(outputFile(root,c.filename))))fail('A saved clip is missing or out of sequence. Restore the original files before resuming.');
  // titleOnly: a finished story run gets just its closing title card (one clip past the last scene).
  if(data.titleOnly&&clips.some(c=>c.storyPhase==='title'))fail('This run already has a title card.');
  const sceneCount=validateSceneCount(data.titleOnly?clips.length:data.sceneCount??saved.sceneCount,data.titleOnly?clips.length:clips.length+1);
  const controllerState=controllerStateFromSession(saved);
  if(data.settings){const patch=validateClipSettings(data.settings,{partial:true});controllerState.pending={settings:{...controllerState.pending?.settings,...patch},scope:'rest',clipIndex:clips.length+1,queuedAt:new Date().toISOString()};}
  const settings=controllerState.base;
  if((controllerState.pending?.settings.continuationStyle||settings.continuationStyle)==='guided'&&!directorState(root).ready)fail('The local story helpers are not ready.',409);
  const frames=saved.clipFrames||saved.frames;
  if(!FRAME_CHOICES.includes(frames)||!['draft','standard','large'].includes(saved.size)||!['landscape','portrait','square'].includes(saved.shape))fail('This saved run has unsupported video settings.');
  const dims={draft:[512,288],standard:[768,448],large:[1024,576]}[saved.size];let [width,height]=dims;if(saved.shape==='portrait')[width,height]=[height,width];if(saved.shape==='square')width=height;
  if(saved.width!==width||saved.height!==height||clips.some(c=>c.width!==width||c.height!==height||c.audio!==saved.audio))fail('The saved clips do not match this run’s video settings.');
  const resumeSession=structuredClone(saved);
  if(sceneCount!==saved.sceneCount)resumeSession.sceneCountChanges=[...(saved.sceneCountChanges||[]),{from:saved.sceneCount,to:sceneCount,currentClip:clips.length,appliesFrom:clips.length+1,changedAt:new Date().toISOString(),resuming:true}];
  const request={...saved,runName:saved.name,frames,settings,controllerState,resumeSession,sceneCount,totalClips:sceneCount,first:null,last:null,refs:{images:[],video:null,audio:null,includeVideoAudio:true},targetSeconds:null,runtimeHours:null,seed:settings.seed,steps:settings.steps};
  let handle;handle=createVideoRun({root,cli,ffmpeg,folder,files,referenceDiffusion,spawnProcess,now,keepAwake,freeBytes,request,onDone(){if(active===handle)active=null;}});job=handle.job;active=handle;return {...job};
 }
 function cancel(){active?.cancel();if(currentBatch)currentBatch.cancelled=true;return {ok:true};}
 function finish(){active?.finish();return {ok:true};}
 function merge(data){if(active||isOtherBusy())fail('Wait for the current task to finish before merging.',409);const session=readSession(root,data?.id);if(!session.clips.length)fail('This run has no completed clips to merge.');let handle;handle=createMergeRun({root,session,ffmpeg,spawnProcess,keepAwake,onDone(){if(active===handle)active=null;}});active=handle;job=handle.job;return {...job};}
 function openSession(data){const session=readSession(root,data?.id);spawn('explorer.exe',[sessionFolder(root,session.id)],{windowsHide:true,detached:true,stdio:'ignore'}).unref();return {ok:true};}
 function resumeDownload(){for(const [needed,script,prefix] of [[!ready(),'download-video-models.mjs','video-download'],[referenceManifest.length&&!ready(true),'download-video-reference-when-ready.mjs','video-reference-download'],[!directorState(root).readerReady,'download-video-director.mjs','video-director-download'],[!directorState(root).writerReady,'download-video-writer.mjs','video-writer-download']]){if(!needed)continue;const out=fs.openSync(path.join(logs,prefix+'-console.log'),'a'),err=fs.openSync(path.join(logs,prefix+'-error.log'),'a');try{const worker=spawn(path.join(root,'runtime/node.exe'),[path.join(root,'app',script)],{cwd:root,windowsHide:true,detached:true,stdio:['ignore',out,err]});worker.on('error',e=>fs.appendFileSync(path.join(logs,prefix+'-error.log'),e.message+'\n'));worker.unref();}finally{fs.closeSync(out);fs.closeSync(err);}}return {ok:true};}
 function serve(req,res,name){
  const file=outputFile(root,name);if(!fs.existsSync(file))fail('File not found.',404);
  const size=fs.statSync(file).size,type=name.endsWith('.mp4')?'video/mp4':name.endsWith('.jpg')?'image/jpeg':'application/json; charset=utf-8',range=req.headers.range;
  let start=0,end=size-1,status=200;
  if(range){const m=/^bytes=(\d*)-(\d*)$/.exec(range);if(!m||(!m[1]&&!m[2])){res.writeHead(416,{'Content-Range':`bytes */${size}`});return res.end();}start=m[1]?Number(m[1]):Math.max(0,size-Number(m[2]));end=m[1]&&m[2]?Math.min(size-1,Number(m[2])):size-1;if(start>end||start>=size){res.writeHead(416,{'Content-Range':`bytes */${size}`});return res.end();}status=206;}
  const headers={'Content-Type':type,'Content-Length':end-start+1,'Accept-Ranges':'bytes','Cache-Control':'private, max-age=3600'};if(status===206)headers['Content-Range']=`bytes ${start}-${end}/${size}`;res.writeHead(status,headers);fs.createReadStream(file,{start,end}).pipe(res);
 }
 return {state,start,update,resume,cancel,finish,merge,openSession,resumeDownload,serve,busy:()=>!!active};
}
