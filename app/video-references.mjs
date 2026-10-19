import fs from 'node:fs';
import path from 'node:path';
import {outputFile} from './video-storage.mjs';

export function validateReferences(data,{root,fail,decodeImage}){
 const images=data.referenceImages??[];if(!Array.isArray(images)||images.length>4)fail('Use up to four reference images.');
 const decodedImages=images.map((item,index)=>{const bytes=decodeImage(item,'Reference '+(index+1));if(!bytes)fail('A reference image is missing.');return bytes;});
 const media=(item,kind,maxMB)=>{
  if(!item)return null;
  if(kind==='video'&&item.outputName){const name=String(item.outputName);if(!name.endsWith('.mp4'))fail('Invalid saved video reference.');const file=outputFile(root,name);if(!fs.existsSync(file))fail('The saved reference video is missing.');return {file,name};}
  const match=typeof item.dataUrl==='string'&&/^data:[a-zA-Z0-9/+.-]+;base64,([A-Za-z0-9+/=]+)$/.exec(item.dataUrl);if(!match)fail('Choose a supported '+kind+' reference.');
  const bytes=Buffer.from(match[1],'base64');if(bytes.length<12||bytes.length>maxMB*1024*1024)fail(`Use a ${kind} reference under ${maxMB} MB.`);
  const mp4=bytes.toString('ascii',4,8)==='ftyp',webm=bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
  const audio=bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WAVE'||bytes.toString('ascii',0,3)==='ID3'||bytes[0]===255&&(bytes[1]&0xe0)===0xe0||['fLaC','OggS'].includes(bytes.toString('ascii',0,4));
  if(kind==='video'&&!mp4&&!webm||kind==='audio'&&!mp4&&!audio)fail(kind==='video'?'Use an MP4, MOV or WebM reference.':'Use WAV, MP3, M4A, FLAC or Ogg audio.');
  return {bytes,name:path.basename(String(item.name||kind))};
 };
 return {images:decodedImages,video:media(data.referenceVideo,'video',50),audio:media(data.referenceAudio,'audio',10),includeVideoAudio:data.referenceVideoAudio!==false};
}

// Convert only local, validated inputs. Ref2VA expects sorted PNG frames and PCM WAV audio.
export async function prepareReferenceArgs({refs,dir,run,ffmpeg,ffprobe,width,height}){
 const args=[];for(let i=0;i<refs.images.length;i++){const file=path.join(dir,'reference-image-'+(i+1)+'.png');fs.writeFileSync(file,refs.images[i]);args.push('--ref-image',file);}
 async function input(item,kind){if(item.file)return item.file;const file=path.join(dir,'reference-'+kind+'.media');fs.writeFileSync(file,item.bytes);return file;}
 async function inspect(file){return JSON.parse(await run(ffprobe,['-v','error','-show_streams','-show_format','-of','json',file],true));}
 const extractAudio=async(file,out,start,duration)=>run(ffmpeg,['-nostdin','-y','-ss',String(start),'-i',file,'-t',String(duration),'-vn','-ac','2','-ar','32000','-c:a','pcm_s16le',out]);
 if(refs.video){
  const file=await input(refs.video,'video'),media=await inspect(file),stream=media.streams?.find(s=>s.codec_type==='video');
  const length=Number(media.format?.duration);if(!stream||!Number.isFinite(length)||length<=0)throw Error('Could not read the reference video duration.');if(stream.width<32||stream.height<32||stream.width>8192||stream.height>8192||stream.width*stream.height>33554432)throw Error('Use a video between 32 and 8192 pixels per side, up to 33 megapixels.');
  const duration=Math.min(8,length),start=Math.max(0,length-duration),framesDir=path.join(dir,'reference-frames');fs.mkdirSync(framesDir,{recursive:true});
  await run(ffmpeg,['-nostdin','-y','-ss',String(start),'-i',file,'-t',String(duration),'-vf',`fps=24,scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=32`,'-frames:v','192',path.join(framesDir,'%06d.png')]);
  if(!fs.readdirSync(framesDir).some(file=>file.endsWith('.png')))throw Error('The reference video produced no frames.');args.push('--ref-video',framesDir);
  if(refs.includeVideoAudio&&media.streams.some(s=>s.codec_type==='audio')){const wav=path.join(dir,'reference-video-audio.wav');await extractAudio(file,wav,start,duration);args.push('--ref-video-audio',wav);}
 }
 if(refs.audio){const file=await input(refs.audio,'audio'),media=await inspect(file);if(!media.streams?.some(s=>s.codec_type==='audio'))throw Error('The audio reference has no audio track.');const wav=path.join(dir,'reference-audio.wav');await extractAudio(file,wav,0,8);args.push('--ref-audio',wav);}
 return args;
}
