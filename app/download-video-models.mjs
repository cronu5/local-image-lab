import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const files=JSON.parse(fs.readFileSync(path.join(root,'video-model-downloads.json'),'utf8'));
const modelsRoot=path.join(root,'models');
for(const item of files){
 const target=path.resolve(modelsRoot,item.file);
 if(!target.startsWith(modelsRoot+path.sep)||!Number.isSafeInteger(item.bytes)||item.bytes<=0||!/^[a-f0-9]{64}$/.test(item.sha256)||!/^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[a-f0-9]{40}\/.+/.test(item.url))throw new Error('Invalid download manifest entry');
}
fs.mkdirSync(path.join(root,'logs'),{recursive:true});
const lockPath=path.join(root,'logs','video-download.lock');
const progressPath=path.join(root,'logs','video-download-progress.json');
if(fs.existsSync(lockPath)){
 let existing;try{existing=JSON.parse(fs.readFileSync(lockPath,'utf8'));}catch{}
 if(existing?.pid){let alive=false;try{process.kill(existing.pid,0);alive=true;}catch{}if(alive){console.error('Model downloads are already running. Keep the other download window open.');process.exit(2);}}
 fs.unlinkSync(lockPath);
}
if(fs.existsSync(progressPath)){
 let prior;try{prior=JSON.parse(fs.readFileSync(progressPath,'utf8'));}catch{}
 if(prior&&Date.now()-Date.parse(prior.updatedAt)<20000&&prior.files?.some(f=>['downloading','verifying'].includes(f.status))){console.error('Model downloads are already running. If a previous window just closed, wait 20 seconds and try again.');process.exit(2);}
}
try{fs.writeFileSync(lockPath,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}),{flag:'wx'});}catch{console.error('Another model downloader is starting. Keep only one download window open.');process.exit(2);}
const concurrency=16, chunkBytes=16*1024*1024;
const evidencePath=path.join(root,'logs','video-downloads-verified.json');
const startedAt=new Date().toISOString();
const results=[];
const statuses=new Map(files.map(item=>{
 const target=path.join(root,'models',item.file),stateFile=target+'.download-state.json';
 let downloadedBytes=0,status='queued';
 if(fs.existsSync(target)){downloadedBytes=fs.statSync(target).size;status='checking';}
 else if(fs.existsSync(stateFile)){const s=JSON.parse(fs.readFileSync(stateFile,'utf8'));downloadedBytes=s.prefixBytes+s.chunks.reduce((n,c)=>n+(c.done?c.end-c.start+1:0),0);}
 else if(fs.existsSync(target+'.part'))downloadedBytes=fs.statSync(target+'.part').size;
 return [item.file,{file:item.file,downloadedBytes,bytes:item.bytes,status}];
}));
let totalReceived=0;const speedSamples=[{time:Date.now(),bytes:0}];
function progress(){
 const now=Date.now();speedSamples.push({time:now,bytes:totalReceived});while(speedSamples.length>2&&speedSamples[1].time<now-30000)speedSamples.shift();
 const first=speedSamples[0],bytesPerSecond=(totalReceived-first.bytes)/Math.max(1,(now-first.time)/1000),downloadedBytes=[...statuses.values()].reduce((n,v)=>n+v.downloadedBytes,0),totalBytes=files.reduce((n,v)=>n+v.bytes,0);
 const out={updatedAt:new Date().toISOString(),downloadedBytes,totalBytes,bytesPerSecond,etaSeconds:bytesPerSecond>0?Math.ceil((totalBytes-downloadedBytes)/bytesPerSecond):null,files:[...statuses.values()]};
 fs.mkdirSync(path.join(root,'logs'),{recursive:true});const f=path.join(root,'logs','video-download-progress.json');fs.writeFileSync(f+'.tmp',JSON.stringify(out,null,2));fs.renameSync(f+'.tmp',f);
}
const progressTimer=setInterval(progress,5000);progress();
let stopping=false;
process.on('SIGINT',()=>{stopping=true;});
process.on('SIGTERM',()=>{stopping=true;});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function digest(file){const h=createHash('sha256');for await(const b of fs.createReadStream(file))h.update(b);return h.digest('hex');}
function saveState(stateFile,state){fs.writeFileSync(stateFile+'.tmp',JSON.stringify(state));fs.renameSync(stateFile+'.tmp',stateFile);}
function saveEvidence(){
 const updatedAt=new Date().toISOString(),complete=results.length===files.length;
 fs.mkdirSync(path.dirname(evidencePath),{recursive:true});
 fs.writeFileSync(evidencePath,JSON.stringify({startedAt,updatedAt,completedAt:complete?updatedAt:undefined,complete,totalBytes:files.reduce((n,item)=>n+item.bytes,0),expectedFiles:files.length,verifiedFiles:results.length,results},null,2));
}
async function download(item){
 const target=path.join(root,'models',item.file),oldPartial=target+'.part',partial=target+'.segmented.part',stateFile=target+'.download-state.json';
 fs.mkdirSync(path.dirname(target),{recursive:true});
 if(fs.existsSync(target)){
  if(fs.statSync(target).size!==item.bytes)throw new Error('Unexpected existing target size '+item.file);
  const sha=await digest(target);if(sha!==item.sha256)throw new Error('Unexpected existing target hash '+item.file);
  statuses.get(item.file).status='verified';results.push({...item,verifiedAt:new Date().toISOString(),sha256Actual:sha});saveEvidence();console.log('VERIFIED '+item.file);return;
 }
 let state;
 if(fs.existsSync(stateFile)){
  state=JSON.parse(fs.readFileSync(stateFile,'utf8'));
  if(state.sha256!==item.sha256||state.bytes!==item.bytes||!fs.existsSync(partial))throw new Error('Inconsistent resume state '+item.file);
 }else{
  if(fs.existsSync(partial))throw new Error('Missing state for segmented partial '+item.file);
  const prefixBytes=fs.existsSync(oldPartial)?fs.statSync(oldPartial).size:0;
  if(prefixBytes>item.bytes)throw new Error('Oversized original partial '+item.file);
  if(prefixBytes)fs.renameSync(oldPartial,partial);else fs.writeFileSync(partial,'');
  const chunks=[];for(let start=prefixBytes;start<item.bytes;start+=chunkBytes)chunks.push({start,end:Math.min(start+chunkBytes,item.bytes)-1,done:false});
  state={file:item.file,sha256:item.sha256,bytes:item.bytes,prefixBytes,chunks};saveState(stateFile,state);
 }
 const fd=await fsp.open(partial,'r+');
 let received=0,previousReceived=0,previousTime=Date.now(),lastError='';
 const inFlight=new Map(), pending=state.chunks.filter(c=>!c.done);let next=0;
 let completeBytes=state.prefixBytes+state.chunks.reduce((s,c)=>s+(c.done?c.end-c.start+1:0),0);
 const status=statuses.get(item.file);status.status='downloading';
 const updateBytes=()=>{status.downloadedBytes=completeBytes+[...inFlight.values()].reduce((n,v)=>n+v.bytes,0);};
 console.log('START '+item.file+' prefix/resumed '+(completeBytes/1e6).toFixed(1)+'MB');
 const timer=setInterval(()=>{
  const now=Date.now();const speed=(received-previousReceived)/1e6/((now-previousTime)/1000);previousReceived=received;previousTime=now;
  console.log('PROGRESS '+item.file+' '+(100*completeBytes/item.bytes).toFixed(1)+'% '+(completeBytes/1e6).toFixed(0)+'MB verified ranges; '+speed.toFixed(2)+' MB/s; '+inFlight.size+' active'+(lastError?' latest: '+lastError:''));
 },30000);
 async function worker(id){
  while(next<pending.length&&!stopping){
   const chunk=pending[next++];let success=false;
   for(let attempt=1;attempt<=8&&!stopping;attempt++){
    const ac=new AbortController();let watchdog=setTimeout(()=>ac.abort(new Error('Response timeout')),90000);inFlight.set(id,{chunk,bytes:0});
    try{
     const response=await fetch(item.url,{headers:{Range:`bytes=${chunk.start}-${chunk.end}`,'Accept-Encoding':'identity'},signal:ac.signal});
     const expected=`bytes ${chunk.start}-${chunk.end}/${item.bytes}`;
     if(response.status!==206||response.headers.get('content-range')!==expected){await response.body?.cancel();throw new Error('Unexpected range '+response.status+' '+response.headers.get('content-range'));}
     const length=response.headers.get('content-length');if(length&&Number(length)!==chunk.end-chunk.start+1)throw new Error('Range length mismatch');
     let position=chunk.start;
     for await(const buffer of response.body){
      clearTimeout(watchdog);watchdog=setTimeout(()=>ac.abort(new Error('Stalled body')),90000);
      if(position+buffer.length>chunk.end+1)throw new Error('Range overflow');
      let offset=0;while(offset<buffer.length){const written=await fd.write(buffer,offset,buffer.length-offset,position+offset);if(!written.bytesWritten)throw new Error('No bytes written');offset+=written.bytesWritten;}
      position+=buffer.length;received+=buffer.length;totalReceived+=buffer.length;inFlight.get(id).bytes+=buffer.length;updateBytes();
     }
     if(position!==chunk.end+1)throw new Error('Truncated range');
     chunk.done=true;completeBytes+=chunk.end-chunk.start+1;saveState(stateFile,state);success=true;break;
    }catch(e){lastError=e.message;console.log('RETRY '+item.file+' range '+chunk.start+' attempt '+attempt+' '+e.message);await pause(Math.min(30000,1000*attempt));}
    finally{clearTimeout(watchdog);inFlight.delete(id);updateBytes();}
   }
   if(!success)throw new Error('Could not complete range '+chunk.start+' '+lastError);
  }
 }
 try{const workers=await Promise.allSettled(Array.from({length:concurrency},(_,i)=>worker(i)));const rejected=workers.find(r=>r.status==='rejected');if(rejected)throw rejected.reason;if(stopping)throw new Error('Stopped');await fd.sync();}
 finally{clearInterval(timer);await fd.close();}
 if(fs.statSync(partial).size!==item.bytes)throw new Error('Size mismatch '+item.file);
 console.log('HASHING '+item.file);
 status.status='verifying';progress();
 const sha=await digest(partial);if(sha!==item.sha256)throw new Error('SHA256 mismatch '+item.file+' actual '+sha);
 fs.renameSync(partial,target);fs.unlinkSync(stateFile);
 status.status='verified';
 results.push({...item,verifiedAt:new Date().toISOString(),sha256Actual:sha});saveEvidence();console.log('COMPLETE '+item.file);
}
try{for(const file of [...files].sort((a,b)=>Number(b.file.startsWith('flux-klein/'))-Number(a.file.startsWith('flux-klein/'))))await download(file);console.log('ALL VERIFIED '+results.length);}
catch(e){console.error('FAILED '+e.stack);for(const status of statuses.values())if(status.status==='downloading'||status.status==='verifying')status.status='failed';saveEvidence();process.exitCode=1;}
finally{clearInterval(progressTimer);progress();try{const lock=JSON.parse(fs.readFileSync(lockPath,'utf8'));if(lock.pid===process.pid)fs.unlinkSync(lockPath);}catch{}}
