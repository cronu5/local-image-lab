import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';

// One installation check, using the same queue and cancellation controls as the UI.
// It waits for downloaded weights, never interrupts a user job, and never retries a failure.
export function armVideoSetup({root,video,intervalMs=10000,reference=false}){
 const file=path.join(root,reference?'logs/video-reference-setup-check.json':'logs/video-setup-check.json');let checking=false;
 const read=()=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
 const write=value=>{fs.writeFileSync(file+'.tmp',JSON.stringify({...value,updatedAt:new Date().toISOString()},null,2));fs.renameSync(file+'.tmp',file);};
 const probe=filename=>new Promise((resolve,reject)=>execFile(path.join(root,'runtime/ffmpeg/ffprobe.exe'),['-v','error','-show_streams','-show_format','-of','json',path.join(root,'outputs',filename)],{windowsHide:true,timeout:60000,maxBuffer:1024*1024},(error,stdout)=>{if(error)return reject(error);try{resolve(JSON.parse(stdout));}catch(e){reject(e);}}));
 async function tick(){
  if(checking)return;checking=true;
  try{
   const check=read();if(!check||!['waiting','running'].includes(check.status))return;
   const state=video.state();
   if(check.status==='waiting'){
    if(!(reference?state.referenceReady:state.ready)||state.busy||state.otherBusy)return;
    let source=null;if(reference){try{source=JSON.parse(fs.readFileSync(path.join(root,'logs/video-setup-check.json'))).filename;}catch{}if(!source||!fs.existsSync(path.join(root,'outputs',source)))return;}
    const job=video.start({prompt:reference?'Continue the canoe scene from <Video 1>, keeping the same canoe, lake, light and natural water sounds.':'A red canoe drifts slowly across a calm alpine lake. The camera glides beside it as gentle ripples spread across the water. Natural daylight, distant birds and soft water sounds.',mode:reference?'references':'text',referenceVideo:reference?{outputName:source}:undefined,referenceVideoAudio:true,size:'draft',shape:'landscape',frames:56,steps:20,seed:17018,audio:true});
    write({...check,status:'running',jobId:job.id,startedAt:new Date().toISOString(),message:'Making one short installation test clip. Cancel generation to skip.'});return;
   }
   const result=state.gallery.find(item=>item.id===check.jobId);
   if(result){
    const media=await probe(result.filename),stream=media.streams?.find(s=>s.codec_type==='video'),audio=media.streams?.find(s=>s.codec_type==='audio');
    if(stream?.codec_name!=='h264'||stream.width!==512||stream.height!==288||Number(stream.nb_frames)!==56||!audio||Number(media.format?.duration)<2)throw Error('The test output did not match the expected playable video and audio.');
    write({...check,status:'passed',filename:result.filename,finishedAt:new Date().toISOString(),message:'Test clip saved with video and audio. Preview it in Recent videos.',checks:{videoCodec:stream.codec_name,width:stream.width,height:stream.height,frames:Number(stream.nb_frames),audioCodec:audio.codec_name,duration:Number(media.format.duration)}});return;
   }
   if(state.job?.id!==check.jobId){write({...check,status:'interrupted',message:'The installation check was interrupted. You can generate a clip manually.'});return;}
   if(state.busy&&Date.now()-Date.parse(check.startedAt)>90*60000){video.cancel();write({...check,status:'failed',message:'The installation test exceeded 90 minutes and was stopped. Its log is saved for troubleshooting.'});return;}
   if(['error','cancelled'].includes(state.job.status))write({...check,status:state.job.status==='cancelled'?'skipped':'failed',message:state.job.error||'Installation test skipped. You can generate a clip manually.'});
  }catch(error){const check=read();write({...check,status:'failed',message:error.message});}
  finally{checking=false;}
 }
 const timer=setInterval(tick,intervalMs);timer.unref();void tick();return ()=>clearInterval(timer);
}
