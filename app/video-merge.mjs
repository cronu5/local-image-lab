import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {mergeSession} from './video-media.mjs';
import {saveSession,publicVideo} from './video-storage.mjs';

export function createMergeRun({root,session,ffmpeg,spawnProcess,onDone,keepAwake}){
 const startedAt=Date.now(),id=session.id+'-merge-'+randomUUID().slice(0,6),dir=path.join(root,'inputs',id);
 fs.mkdirSync(dir,{recursive:true});
 const job={id,sessionId:session.id,status:'assembling',message:'Preparing saved clips…',progress:null,startedAt,completedClips:session.clips.length};
 let child=null,cancelled=false;const releaseAwake=keepAwake();
 releaseAwake.ready?.then(ok=>job.sleepProtection=ok?'active':'unavailable');
 const log=fs.createWriteStream(path.join(root,'logs',id+'.log'));let logError=null;log.on('error',e=>{logError=e;child?.kill();});
 const run=(exe,args,capture=false)=>new Promise((resolve,reject)=>{
  if(cancelled)return reject(Error('Cancelled'));if(logError)return reject(logError);
  let stdout='';const p=spawnProcess(exe,args,{cwd:path.dirname(exe),windowsHide:true,stdio:['ignore','pipe','pipe']});child=p;
  p.stdout.on('data',b=>{if(capture)stdout=(stdout+b).slice(-1024*1024);if(!log.destroyed)log.write(b);});p.stderr.on('data',b=>{if(!log.destroyed)log.write(b);});
  p.on('error',reject);p.on('close',code=>{if(child===p)child=null;code===0?resolve(stdout):reject(Error('Video export stopped (code '+code+').'));});
 });
 const previousStatus=session.status;
 const promise=Promise.resolve().then(async()=>{try{
  session.status='merging';saveSession(root,session);
  const result=await mergeSession({root,session,dir,ffmpeg,run,onProgress:message=>job.message=message});
  session.result=result;session.status='complete';session.message='Clips merged. The originals are still saved.';saveSession(root,session);
  job.result=publicVideo(result);job.status='complete';job.progress=1;job.message=session.message;
 }catch(error){
  session.status=previousStatus==='running'?'interrupted':previousStatus;session.message=cancelled?'Merge cancelled. All clips are still saved.':error.message;saveSession(root,session);
  job.status=cancelled?'cancelled':'error';job.message=session.message;job.error=cancelled?null:error.message;
 }finally{releaseAwake();job.finishedAt=Date.now();job.elapsedMs=job.finishedAt-startedAt;log.end();onDone();}});
 return {job,promise,cancel(){cancelled=true;child?.kill();job.message='Stopping merge…';},finish(){}};
}
