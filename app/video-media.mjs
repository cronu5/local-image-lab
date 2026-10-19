import fs from 'node:fs';
import path from 'node:path';
import {outputFile, saveVideo, removeWork} from './video-storage.mjs';

export const encodeVideo = ['-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-movflags','+faststart'];
export const mediaInput = (file,audio) => ['-nostdin','-y','-i',file,'-map','0:v:0',...(audio?['-map','0:a:0']:['-an'])];
export async function inspectVideo({root,run,file,width,height,frames,audio}) {
  const data = JSON.parse(await run(path.join(root,'runtime/ffmpeg/ffprobe.exe'),['-v','error','-show_streams','-show_format','-of','json',file],true));
  const video=data.streams.find(s=>s.codec_type==='video'), sound=data.streams.find(s=>s.codec_type==='audio');
  if(video?.width!==width || video?.height!==height || Number(video.nb_frames)!==frames || Boolean(sound)!==audio) throw Error('The exported video has unexpected dimensions, frames or audio.');
  return data;
}
const quote = file => file.replaceAll('\\','/').replaceAll("'", "'\\''");

export async function rollingReference({root,clips,seconds,dir,ffmpeg,run,audio}) {
  const selected=[]; let frameCount=0;
  for(let i=clips.length-1;i>=0 && frameCount<seconds*24;i--){selected.unshift(clips[i]);frameCount+=clips[i].frames;}
  const list=path.join(dir,'recent.txt'), output=path.join(dir,'recent.mp4');
  fs.writeFileSync(list,selected.map(c=>`file '${quote(outputFile(root,c.filename))}'\nduration ${c.frames/24}\n`).join(''));
  const wanted=Math.min(frameCount,seconds*24), start=(frameCount-wanted)/24;
  await run(ffmpeg,['-nostdin','-y','-f','concat','-safe','0','-i',list,'-ss',String(start),'-map','0:v:0',...(audio?['-map','0:a:0']:['-an']),'-frames:v',String(wanted),'-t',String(wanted/24),...encodeVideo,output]);
  return output;
}

export async function mergeSession({root,session,dir,ffmpeg,run,onProgress}) {
  const {clips,id,width,height,audio,overlapFrames=0,targetSeconds}=session;
  if(!clips.length) throw Error('There are no completed clips to merge yet.');
  // Validate all saved media before starting; originals are never modified.
  for(const clip of clips){
    if(!fs.existsSync(outputFile(root,clip.filename))) throw Error('A saved clip is missing: '+path.basename(clip.filename));
    await inspectVideo({root,run,file:outputFile(root,clip.filename),width,height,frames:clip.frames,audio});
  }
  const mergeDir=path.join(dir,'merge'); fs.mkdirSync(mergeDir,{recursive:true});
  const entries=[];
  try {
    for(let i=0;i<clips.length;i++){
      onProgress?.(`Preparing clip ${i+1} of ${clips.length} for merging…`);
      const clip=clips[i], source=outputFile(root,clip.filename), frames=clip.frames-(i?overlapFrames:0);
      let piece=source;
      if(i && overlapFrames){piece=path.join(mergeDir,'piece-'+i+'.mp4');await run(ffmpeg,[...mediaInput(source,audio),'-vf',`trim=start_frame=${overlapFrames},setpts=PTS-STARTPTS`,...(audio?['-af',`atrim=start=${overlapFrames/24},asetpts=PTS-STARTPTS`]:[]),'-t',String(frames/24),...encodeVideo,piece]);}
      entries.push(`file '${quote(piece)}'\nduration ${frames/24}\n`);
    }
    const available=clips.reduce((n,c)=>n+c.frames,0)-(clips.length-1)*overlapFrames;
    const renderId=fs.existsSync(outputFile(root,`videos/${id}/${id}.mp4`))?id+'-merged-'+Date.now():id;
    const frames=Math.min(available,targetSeconds==null?available:targetSeconds*24), rel=`videos/${id}/${renderId}.mp4`;
    const output=outputFile(root,rel), poster=output.replace(/\.mp4$/,'.jpg'), temp=path.join(mergeDir,'merged.mp4'), thumb=path.join(mergeDir,'merged.jpg'), list=path.join(mergeDir,'join.txt');
    fs.writeFileSync(list,entries.join(''));onProgress?.('Rendering the merged video…');
    await run(ffmpeg,['-nostdin','-y','-f','concat','-safe','0','-i',list,'-map','0:v:0',...(audio?['-map','0:a:0']:['-an']),'-frames:v',String(frames),'-t',String(frames/24),'-fps_mode','cfr',...encodeVideo,temp]);
    await inspectVideo({root,run,file:temp,width,height,frames,audio});
    await run(ffmpeg,['-nostdin','-y','-i',temp,'-frames:v','1','-vf','scale=480:-2',thumb]);
    const {status,stopReason,message,result,...base}=session;
    const meta={...base,mediaType:'video',filename:rel,poster:rel.replace(/\.mp4$/,'.jpg'),frames,seconds:frames/24,continuous:true,totalClips:clips.length,stoppedEarly:['manual','runtime','disk','director'].includes(stopReason),createdAt:new Date().toISOString(),clips:clips.map(({filename,seed,previousClip,checkpoint})=>({filename,seed,previousClip,checkpoint}))};
    fs.renameSync(temp,output);fs.renameSync(thumb,poster);saveVideo(root,meta);return meta;
  } finally { removeWork(dir,mergeDir); }
}
