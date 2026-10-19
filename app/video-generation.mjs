import {clipFramesFor,sceneFrames,joinedSeconds,FRAME_CHOICES,longestFrames} from './public/video-timing.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {prepareReferenceArgs} from './video-references.mjs';
import {outputFile,publicVideo,saveVideo,saveSession,sessionFolder,removeWork} from './video-storage.mjs';
import {encodeVideo,mediaInput,inspectVideo,mergeSession} from './video-media.mjs';

import {planContinuation,planOpening,DIRECTOR_VERSION} from './video-director.mjs';
import {createClipController,storyPhase,validateSceneCount} from './video-settings.mjs';

export function createVideoRun({root,cli,ffmpeg,folder,files,referenceDiffusion,spawnProcess,request,onDone,now=Date.now,keepAwake=()=>()=>{},freeBytes=()=>Infinity}){
 const {prompt,blankPrompt,continuationPrompt,mode,size,shape,width,height,frames,steps,seed,audio,first,last,refs,continuous,continuity,overlapFrames,endMode,targetSeconds,runtimeHours,mergeWhenDone,referenceSeconds,referenceLastFrame,runName,resumeSession}=request;
 let sceneCount=request.sceneCount,totalClips=request.totalClips;
 // Guided story runs with a scene count end with one extra clip: the film's title card.
 const titleCard=continuous&&endMode==='scenes'&&request.titleCard!==false;
 const clipControl=createClipController({settings:request.settings,continuationPrompt,restore:request.controllerState});
 let currentSettings=clipControl.initial;
 const id=resumeSession?.id||new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,6);
 const dir=path.join(root,'inputs',id),logPath=path.join(root,'logs',id+'.log');
 fs.mkdirSync(dir,{recursive:true});if(continuous)fs.mkdirSync(sessionFolder(root,id),{recursive:true});
 const promptFile=path.join(dir,'prompt.txt');fs.writeFileSync(promptFile,prompt);
 const common={mediaType:'video',modelId:'minimax-h3',modelName:'MiniMax H3',prompt,blankPrompt,mode,size,shape,width,height,frames,fps:24,seconds:frames/24,steps,seed,audio};
 const startedAt=resumeSession?.startedAt||now(),deadlineAt=continuous&&endMode==='runtime'?startedAt+runtimeHours*3600000:null;
 const job={...common,id,continuous,continuity,continuationPrompt,endMode,sceneCount,targetSeconds,totalClips,runtimeHours,deadlineAt,mergeWhenDone,referenceSeconds,referenceLastFrame,runName,clipFrames:frames,clipIndex:0,completedClips:0,completedSeconds:0,status:'loading',message:'Loading video components…',progress:null,startedAt};
 const runtime={memoryStrategy:'sequential phases, disk-backed weights, Vulkan0 GPU budget 12.5 GiB',runtime:'stable-diffusion.cpp 2f016e8',modelSource:'https://huggingface.co/MiniMaxAI/MiniMax-H3'};
 let child=null,cancelled=false,finishRequested=false,stopReason=null,tail='',pending='',logError=null;
 const log=fs.createWriteStream(logPath,{flags:resumeSession?'a':'w'});log.on('error',error=>{logError=error;child?.kill();});
 const clips=structuredClone(resumeSession?.clips||[]);let init=null,end=null,storyMemory=resumeSession?.storyMemory||null,consecutiveFallbacks=resumeSession?.consecutiveFallbacks||0;
 const session={...resumeSession,...common,...runtime,id,name:runName||'Video run',createdAt:resumeSession?.createdAt||new Date().toISOString(),continuous:true,continuity,continuationPrompt,overlapFrames,clipFrames:frames,endMode,sceneCount,totalClips,targetSeconds,runtimeHours,deadlineAt,mergeWhenDone,referenceSeconds,referenceLastFrame,startedAt,clips,status:'running'};
 if(resumeSession){session.previousResults=[...(resumeSession.previousResults||[]),...(resumeSession.result?[resumeSession.result]:[])];delete session.result;session.resumedAt=new Date().toISOString();session.resumeCount=(resumeSession.resumeCount||0)+1;job.clipIndex=clips.length;job.completedClips=clips.length;job.completedSeconds=joinedSeconds(clips.map(c=>c.frames));job.latestClip=publicVideo(clips.at(-1));job.storyMemory=storyMemory;job.latestPlan=resumeSession.latestPlan;}
 const canEditRun=()=>continuous&&!cancelled&&!finishRequested&&!['complete','cancelled','error','assembling'].includes(job.status);
 Object.defineProperties(job,{nextSettings:{enumerable:true,get:()=>clipControl.nextSettings},pendingUpdate:{enumerable:true,get:()=>clipControl.pending},canUpdate:{enumerable:true,get:()=>canEditRun()&&(totalClips===null||job.clipIndex<totalClips)},canResize:{enumerable:true,get:()=>canEditRun()&&endMode==='scenes'}});
 const persist=(status='running')=>{if(continuous){session.directorVersion=DIRECTOR_VERSION;session.consecutiveFallbacks=consecutiveFallbacks;session.storyMemory=storyMemory;session.latestPlan=job.latestPlan;session.controllerState=clipControl.snapshot();session.nextSettings=clipControl.nextSettings;session.settingsChanges=clipControl.changes;session.pendingUpdate=clipControl.pending;session.status=status;session.stopReason=stopReason;session.elapsedMs=now()-startedAt;session.message=job.error||job.message;saveSession(root,session);}};
 persist();
 if(first){init=path.join(dir,'first.png');fs.writeFileSync(init,first);}
 if(last){end=path.join(dir,'last.png');fs.writeFileSync(end,last);}
 const logWrite=text=>{if(!log.destroyed)log.write(text);};
 function read(buffer){
  const text=buffer.toString().replace(/\x1b\[[0-9;]*m/g,'');logWrite(text);tail=(tail+text).slice(-12000);
  const lines=(pending+text).split(/[\r\n]/);pending=lines.pop().slice(-3000);
  if(['exporting','assembling','references','planning'].includes(job.status))return;
  for(const line of lines){
   if(/get_learned_condition|encoding prompt|qwen.*offload|qwen.*compute/i.test(line)&&job.status!=='generating'){job.status='encoding';job.message='Understanding your prompt…';}
   if(/sampling using|denoising|generating video|sampling with/i.test(line)){job.status='generating';job.message='Creating your video…';}
   for(const m of line.matchAll(/(?:\||\bstep\s*)(\s*\d+)\s*\/\s*(\d+)/gi))if(Number(m[2])===currentSettings.steps){job.status='generating';job.step=Number(m[1]);job.progress=job.step/currentSettings.steps;job.message=`Creating video · ${job.step} of ${currentSettings.steps} steps`;}
   if(/decoding|decode_first_stage/i.test(line)){job.status='decoding';job.progress=null;job.message='Decoding video and audio…';}
  }
 }
 const run=(exe,args,capture=false,timeoutMs=0)=>new Promise((resolve,reject)=>{
  if(cancelled)return reject(Error('Cancelled'));if(logError)return reject(logError);
  let stdout='';const process=spawnProcess(exe,args,{cwd:path.dirname(exe),windowsHide:true,stdio:['ignore','pipe','pipe']});child=process;
  process.stdout.on('data',b=>{if(capture)stdout=(stdout+b).slice(-1024*1024);read(b);});process.stderr.on('data',read);
  let timedOut=false;const timeout=timeoutMs?setTimeout(()=>{timedOut=true;process.kill();},timeoutMs):null;timeout?.unref();
  process.on('error',error=>{if(timeout)clearTimeout(timeout);reject(error);});process.on('close',code=>{if(timeout)clearTimeout(timeout);if(child===process)child=null;timedOut?reject(Error('The local scene planner took too long. Completed clips are saved.')):code===0?resolve(stdout):reject(Error('Engine stopped (code '+code+').'));});
 });
 const inspect=(file,count)=>inspectVideo({root,run,file,width,height,frames:count,audio});
 function reachedDeadline(){
  if(deadlineAt!==null&&now()>=deadlineAt){finishRequested=true;job.finishRequested=true;if(!stopReason)stopReason='runtime';job.stopReason=stopReason;return true;}
  return false;
 }
 const timer=deadlineAt===null?null:setInterval(reachedDeadline,1000);timer?.unref();
 const releaseAwake=continuous?keepAwake():()=>{};
 releaseAwake.ready?.then(ok=>job.sleepProtection=ok?'active':'unavailable');
 const promise=Promise.resolve().then(async()=>{try{
  if(clips.length){
   const previous=clips.at(-1),output=outputFile(root,previous.filename);job.message='Restoring the last saved frame…';
   await inspect(output,previous.frames);init=path.join(dir,'next-frame.png');
   await run(ffmpeg,['-nostdin','-y','-i',output,'-vf',`select=eq(n\\,${previous.frames-1})`,'-frames:v','1','-fps_mode','vfr',init]);
   if(!fs.existsSync(init)||fs.statSync(init).size<50)throw Error('Could not restore the last saved frame.');
  }
  for(let index=clips.length;!continuous?index===0:totalClips===null||index<totalClips+(titleCard?1:0);index++){
   if(cancelled)throw Error('Cancelled');if(reachedDeadline()||index&&finishRequested)break;
   if(continuous&&freeBytes()<5*1024**3){stopReason='disk';job.stopReason=stopReason;job.message='Stopped because less than 5 GB of free space remains.';if(!clips.length)throw Error(job.message);break;}
   const clipSettings=clipControl.take(index);
   const titleScene=titleCard&&totalClips!==null&&index===totalClips;
   if(titleScene&&(clipSettings.continuationStyle!=='guided'||!clipSettings.storyArc))break;
   let frames=titleScene?Math.min(longestFrames(size),192):continuous?clipFramesFor({baseFrames:request.frames,index,totalClips,endMode,settings:clipSettings,size}):request.frames;job.baseFrames=request.frames;job.clipFrames=frames;currentSettings=clipSettings;job.currentSettings={...clipSettings};job.currentSeed=clipSettings.seed;
   const clipId=continuous?id+'-c'+String(index+1).padStart(4,'0'):id,clipSeed=clipSettings.seed;
   const prefix=continuous?`videos/${id}/`:'';
   const raw=path.join(dir,'native.webm'),rel=prefix+clipId+'.mp4',output=outputFile(root,rel),poster=outputFile(root,prefix+clipId+'.jpg'),clipStarted=now();
   job.clipIndex=index+1;job.status='loading';job.progress=null;job.step=0;job.message=continuous?`Preparing clip ${index+1}…`:'Loading video components…';pending='';tail='';
   const phase=titleScene?'title':continuous&&clipSettings.continuationStyle==='guided'?storyPhase({index,totalClips,endMode,deadlineAt,now:now(),clips,storyArc:clipSettings.storyArc}):null;
   if(titleScene)job.message='Making the title card…';
   const context={phase,clipIndex:index+1,totalClips,scenesRemaining:totalClips===null?null:Math.max(0,totalClips-index-1),totalVideoSeconds:totalClips===null?null:joinedSeconds(sceneFrames({baseFrames:request.frames,totalClips,endMode,settings:clipSettings,size,clips})),endMode,elapsedVideoSeconds:job.completedSeconds,elapsedWallSeconds:(now()-startedAt)/1000,remainingWallSeconds:deadlineAt?Math.max(0,(deadlineAt-now())/1000):null,clipSeconds:targetSeconds?Math.min(frames/24,Math.max(1/24,targetSeconds-job.completedSeconds+(index?overlapFrames/24:0))):frames/24};
   job.storyPhase=phase;let directorPlan=null;
   if(continuous&&clipSettings.continuationStyle==='guided'&&(index>0||clipSettings.storyArc)){
    job.status='planning';job.message='Reviewing the story…';
    if(index===0){job.message='Planning the opening scene…';directorPlan=await planOpening({root,image:init,idea:clipSettings.prompt,brief:clipSettings.directorBrief,storyIntensity:clipSettings.storyIntensity,plantedThought:clipSettings.plantedThought,dir,run,runId:id,context,shouldStop:()=>cancelled||reachedDeadline()||finishRequested,onStage:message=>job.message=message});}
    else directorPlan=await planContinuation({root,clips,memory:storyMemory,brief:clipSettings.directorBrief,storyIntensity:clipSettings.storyIntensity,plantedThought:clipSettings.plantedThought,dir,ffmpeg,run,runId:id,context,onStage:message=>job.message=message,onMemory:memory=>{storyMemory=memory;job.storyMemory=memory;persist();},shouldStop:()=>cancelled||reachedDeadline()||finishRequested});
    if(cancelled)throw Error('Cancelled');if(directorPlan.stopped)break;
    if(directorPlan.memory)storyMemory=directorPlan.memory;job.storyMemory=storyMemory;consecutiveFallbacks=directorPlan.fallback?consecutiveFallbacks+1:0;job.consecutiveFallbacks=consecutiveFallbacks;job.latestPlan={observed:directorPlan.observed,summary:directorPlan.summary,nextPrompt:directorPlan.nextPrompt,reviewedClipIndex:directorPlan.reviewedClipIndex,recordFile:directorPlan.recordFile,phase,threadId:directorPlan.threadId,evidence:directorPlan.evidence,visibleResult:directorPlan.visibleResult,fallback:directorPlan.fallback,warnings:directorPlan.warnings};
    clipSettings.prompt=directorPlan.nextPrompt;clipSettings.blankPrompt=false;if(index===0&&clipSettings.cfgScale>1)clipSettings.negativePrompt=clipControl.initial.negativePrompt;job.currentSettings={...clipSettings};persist();
    if(reachedDeadline()||finishRequested)break;
   }
   if(!directorPlan)consecutiveFallbacks=0;
   const clipPrompt=clipSettings.prompt;fs.writeFileSync(promptFile,clipPrompt);
   const negativeFile=path.join(dir,'negative.txt');fs.writeFileSync(negativeFile,clipSettings.negativePrompt);
   const useReferences=index===0&&mode==='references';
   const args=['-M','vid_gen','--diffusion-model',path.join(folder,useReferences?referenceDiffusion:files.diffusion),'--llm',path.join(folder,files.encoder),'--vae',path.join(folder,files.vae),
    '--backend','Vulkan0','--params-backend','disk','--max-vram','12.5','--mmap','--flash-attn','auto','--vae-tiling','--vae-tile-size','256','--temporal-tiling','--threads','6',
    '--prompt-file',promptFile,'--negative-prompt-file',negativeFile,'--steps',String(clipSettings.steps),'--cfg-scale',String(clipSettings.cfgScale),'--flow-shift',String(clipSettings.flowShift),'--sampling-method',clipSettings.sampler,'--scheduler',clipSettings.scheduler,'--seed',String(clipSeed),'--rng','cpu','-W',String(width),'-H',String(height),'--video-frames',String(frames),'--fps','24','-o',raw];
   if(clipSettings.sampler==='euler_a')args.push('--eta',String(clipSettings.eta));
   if(audio)args.push('--audio-vae',path.join(folder,files.audio));if(!useReferences&&init)args.push('--init-img',init);if(!useReferences&&end)args.push('--end-img',end);
   const refDir=path.join(dir,'reference-work');let referenceImageCount=0;
   try {
    if(useReferences){
     job.status='references';job.message='Preparing recent video, audio and frame references…';fs.mkdirSync(refDir,{recursive:true});
     let clipRefs=refs;
     referenceImageCount=clipRefs.images.length;
     args.push(...await prepareReferenceArgs({refs:clipRefs,dir:refDir,run,ffmpeg,ffprobe:path.join(root,'runtime/ffmpeg/ffprobe.exe'),width,height}));
    }
    if(reachedDeadline())break;
    // Free GPU memory depends on other apps. Guided scenes chose their own length,
    // so when one does not fit, retry it at the next shorter H3 length instead of ending the run.
    for(;;){
     job.status='loading';job.message='Loading video components…';logWrite(JSON.stringify({clip:index+1,args,settings:clipSettings,continuous})+'\n');tail='';
     try{await run(cli,args);break;}
     catch(error){
      const shorter=continuous&&clipSettings.continuationStyle==='guided'?FRAME_CHOICES.filter(f=>f>=124&&f<frames).at(-1):null;
      if(cancelled||!shorter||!/cannot make enough memory available|ErrorOutOfDeviceMemory|out of.*memory/i.test(tail))throw error;
      logWrite(`\nNot enough free GPU memory for ${frames} frames. Retrying clip ${index+1} with ${shorter} frames.\n`);
      frames=shorter;job.clipFrames=frames;args[args.indexOf('--video-frames')+1]=String(frames);fs.rmSync(raw,{force:true});
     }
    }
   } finally {if(fs.existsSync(refDir))removeWork(dir,refDir);}
   if(cancelled)throw Error('Cancelled');if(!fs.existsSync(raw)||fs.statSync(raw).size<100)throw Error('The engine produced no video.');
   job.status='exporting';job.progress=null;job.message='Saving clip…';
   // The title card ends the film, so it fades picture and sound to black.
   const fadeAt=Math.max(0,frames/24-1.2).toFixed(2),fade=titleScene?['-vf',`fade=t=out:st=${fadeAt}:d=1.2`,...(audio?['-af',`afade=t=out:st=${fadeAt}:d=1.2`]:[])]:[];
   await run(ffmpeg,[...mediaInput(raw,audio),...fade,...encodeVideo,output]);await inspect(output,frames);
   await run(ffmpeg,['-nostdin','-y','-i',output,'-frames:v','1','-vf','scale=480:-2',poster]);
   const meta={...common,...runtime,...clipSettings,frames,seconds:frames/24,baseFrames:request.frames,generationSettings:{...clipSettings},director:directorPlan?{version:directorPlan.version,phase,threadId:directorPlan.threadId,evidence:directorPlan.evidence,visibleResult:directorPlan.visibleResult,fallback:directorPlan.fallback,warnings:directorPlan.warnings,reviewedClipIndex:directorPlan.reviewedClipIndex,model:directorPlan.model,observed:directorPlan.observed,storySummary:directorPlan.summary,reviewedClip:directorPlan.reviewedClip,recordFile:directorPlan.recordFile,elapsedMs:directorPlan.elapsedMs}:undefined,id:clipId,prompt:clipPrompt,seed:clipSeed,mode:useReferences?'references':init?'image':'text',checkpoint:useReferences?'Ref2VA':'FL2VA',filename:rel,poster:prefix+clipId+'.jpg',hasLastFrame:!!last,referenceImageCount,hasVideoReference:useReferences&&(index>0||!!refs.video),hasAudioReference:useReferences&&!!refs.audio,referenceSeconds:useReferences&&index>0?Math.min(referenceSeconds,clips.reduce((n,c)=>n+c.frames/24,0)):undefined,referenceLastFrame:useReferences&&index>0&&referenceLastFrame,createdAt:new Date().toISOString(),elapsedMs:now()-clipStarted,sequenceId:continuous?id:undefined,clipIndex:continuous?index+1:undefined,previousClip:clips.at(-1)?.filename};
   meta.storyPhase=phase;if(titleScene&&directorPlan?.title){meta.title=directorPlan.title;session.title=directorPlan.title;}const result=saveVideo(root,meta);clips.push(meta);job.latestClip=result;job.completedClips=clips.length;job.completedSeconds=joinedSeconds(clips.map(c=>c.frames));persist();
   removeWork(dir,raw);
   if(!continuous){job.result=result;break;}
   if(directorPlan?.fallback&&consecutiveFallbacks>=2){finishRequested=true;stopReason='director';job.stopReason=stopReason;job.finishRequested=true;}
   reachedDeadline();if(finishRequested||totalClips!==null&&clips.length>=totalClips+(titleCard?1:0))break;
   if(continuity==='frame'){job.message='Preparing the next starting frame…';init=path.join(dir,'next-frame.png');
    await run(ffmpeg,['-nostdin','-y','-i',output,'-vf',`select=eq(n\\,${frames-1})`,'-frames:v','1','-fps_mode','vfr',init]);
    if(!fs.existsSync(init)||fs.statSync(init).size<50)throw Error('Could not extract the final frame for the next clip.');}
  }
  job.stopReason=stopReason;
  if(continuous&&clips.length){
   job.result=publicVideo(clips.at(-1));
   if(mergeWhenDone&&stopReason!=='disk'){
    job.status='assembling';job.progress=null;job.message='Joining your clips…';persist('merging');
    session.result=await mergeSession({root,session,dir,ffmpeg,run,onProgress:message=>job.message=message});job.result=publicVideo(session.result);
   }
  }
  job.status='complete';job.progress=1;
  job.message=continuous?`${clips.length} clip${clips.length===1?'':'s'} saved${session.result?' and merged':'. Merge them whenever you are ready'}.${stopReason==='runtime'?' Running-time limit reached.':stopReason==='disk'?' Stopped: less than 5 GB of free space remains.':''}`:'Video saved.';
  if(stopReason==='director')job.message='Stopped after two consecutive scene-helper fallbacks. Completed clips and story records are saved.';
 }catch(error){
  job.status=cancelled?'cancelled':'error';stopReason=cancelled?'cancelled':stopReason||'error';job.stopReason=stopReason;job.message=cancelled?'Stopped. Completed clips are saved.':'Video generation failed. Completed clips are saved.';
  job.error=cancelled?null:(/out of.*memory|allocation.*failed|VK_ERROR_OUT_OF/i.test(tail)?'Not enough memory. Try Quick and Short, or close other GPU-heavy apps.':error.message)+` See logs/${id}.log.`;
 }finally{if(timer)clearInterval(timer);releaseAwake();job.finishedAt=now();job.elapsedMs=job.finishedAt-job.startedAt;try{persist(job.status);}finally{log.end();onDone();}}});
 return {job,promise,update(data){
  const resizing=Object.hasOwn(data,'sceneCount');
  const nextCount=resizing?validateSceneCount(data.sceneCount,Math.max(1,job.clipIndex)):sceneCount;
  if(resizing&&!job.canResize)throw Object.assign(Error('Scene count can change while a scene-count run is active.'),{status:409});
  if(data.settings||data.clear===true){
   if(!canEditRun()||(!resizing&&(totalClips!==null&&job.clipIndex>=totalClips))||resizing&&job.clipIndex>=nextCount)throw Object.assign(Error('There is no next clip to update. Increase the scene count first.'),{status:409});
   if(data.clear===true)clipControl.clear();else clipControl.queue(data.settings,data.scope||'rest',job.clipIndex+1);
  }else if(!resizing)throw Object.assign(Error('Change a setting or the scene count before applying.'),{status:400});
  if(resizing&&nextCount!==sceneCount){
   session.sceneCountChanges=[...(session.sceneCountChanges||[]),{from:sceneCount,to:nextCount,currentClip:job.clipIndex,appliesFrom:job.clipIndex+1,changedAt:new Date().toISOString()}];
   sceneCount=nextCount;totalClips=nextCount;Object.assign(job,{sceneCount,totalClips});Object.assign(session,{sceneCount,totalClips});
  }
  persist();return {ok:true,pendingUpdate:clipControl.pending,nextSettings:clipControl.nextSettings,sceneCount,totalClips};
 },cancel(){cancelled=true;child?.kill();job.message='Stopping…';},finish(){if(continuous&&job.status!=='assembling'){finishRequested=true;stopReason='manual';job.finishRequested=true;job.stopReason=stopReason;job.message='Will finish and save this clip, then stop.';}}};
}
