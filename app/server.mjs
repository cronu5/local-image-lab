import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomInt, randomUUID} from 'node:crypto';
import {createVideoEngine} from './video.mjs';
import {armVideoSetup} from './video-setup.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.IMAGE_LAB_PORT || 48766);
const URL_BASE = `http://127.0.0.1:${PORT}`;
const OUTPUTS = path.join(ROOT,'outputs');
const LOGS = path.join(ROOT,'logs');
const INPUTS = path.join(ROOT,'inputs');
const CLI = path.join(ROOT,'runtime','sd','sd-cli.exe');
const LLAMA = path.join(ROOT,'runtime','llama','llama-completion.exe');
for (const dir of [OUTPUTS,LOGS,INPUTS]) fs.mkdirSync(dir,{recursive:true});
const SIGMAS = '1.0,0.978453,0.95418,0.926626,0.89508,0.845148,0.704534,0.414568,0.0';
const LORAS = path.join(ROOT,'models','loras');
const UPSCALERS = path.join(ROOT,'models','upscalers');
// Options sd-cli accepts for these flow-matching DiT models. Each was test-run with both models on this build.
const SAMPLERS = ['euler','euler_a','heun','dpm2','dpm++2s_a','dpm++2m','dpm++2mv2','ipndm','ipndm_v','lcm','ddim_trailing','tcd','res_multistep','res_2s','er_sde','euler_cfg_pp','euler_a_cfg_pp','euler_ge','dpm++2m_sde','dpm++2m_sde_bt','lms'];
const ETA_SAMPLERS = ['euler_a','dpm++2s_a','er_sde','dpm++2m_sde','dpm++2m_sde_bt','euler_a_cfg_pp','ddim_trailing','tcd','res_multistep','res_2s'];
const SCHEDULERS = ['discrete','karras','exponential','ays','gits','sgm_uniform','simple','smoothstep','kl_optimal','lcm','bong_tangent','logit_normal','beta','flux','flux2'];
const HIRES_UPSCALERS = ['Latent','Latent (nearest)','Latent (nearest-exact)','Latent (antialiased)','Latent (bicubic)','Latent (bicubic antialiased)','Lanczos','Nearest'];
const CACHE_MODES = ['easycache','dbcache','taylorseer','cache-dit','spectrum'];
const TILING = {off:[],both:['--circular'],x:['--circularx'],y:['--circulary']};
const imageOptions = {references:10,startImage:true,mask:true,negativePrompt:true,batch:8,maxSize:2048,hires:true,loras:true,tiling:true,preview:true,cache:true,eta:true,samplers:SAMPLERS,etaSamplers:ETA_SAMPLERS,schedulers:SCHEDULERS,hiresUpscalers:HIRES_UPSCALERS,cacheModes:CACHE_MODES};
const models = [
 {id:'qwen-turbo',name:'Qwen Image 2.1 Turbo',description:'Create, edit and combine images. Transparent backgrounds supported.',folder:'models/qwen-turbo',
  defaults:{width:768,height:768,steps:8,cfg:1,sampler:'euler',scheduler:'turbo',strength:0.75,hiresScale:1.5,hiresStrength:0.7,hiresUpscaler:'Lanczos'}, capabilities:{editing:true,maxReferences:10,transparent:true,promptExpansion:true},
  options:{...imageOptions,turboSchedule:true,flowShift:false,transparent:true},
  diffusion:'Qwen-Image-2.1-Turbo-AD-Q4_K.gguf',encoder:'Qwen-Image-2.1-Turbo-Uncensored-AD-Q4_K.gguf',vae:'qwen_image_2.1_vae_bf16.safetensors',projector:'mmproj-Qwen-Image-2.1-Turbo-Uncensored-F16.gguf',
  source:'https://huggingface.co/AtomicChat/Qwen-Image-2.1-Turbo-GGUF',settings:{stepsLocked:false,cfgLocked:false}},
 {id:'flux-klein',name:'FLUX 3 Image Klein',description:'Create, edit and combine images. Detailed scene descriptions work best.',folder:'models/flux-klein',
  defaults:{width:768,height:768,steps:16,cfg:1,sampler:'euler',scheduler:'default',strength:0.75,hiresScale:1.5,hiresStrength:0.5,hiresUpscaler:'Lanczos'},capabilities:{editing:true,maxReferences:10,transparent:false,promptExpansion:true},
  options:{...imageOptions,turboSchedule:false,flowShift:true,transparent:false},
  diffusion:'flux-3-image-klein-Q4_K_M.gguf',encoder:'Qwen3VL-4B-Instruct-Q4_K_M.gguf',vae:'flux2-vae.safetensors',
  source:'https://huggingface.co/black-forest-labs/flux-3-image-klein',settings:{stepsLocked:false,cfgLocked:false}}
];
for (const model of models) fs.mkdirSync(path.join(LORAS,model.id),{recursive:true});
let job = null;
let jobPreview = null; // {id,file}: the live preview sd-cli rewrites after each step
let active = null;
let closing = false;
const video = createVideoEngine({root:ROOT,isOtherBusy:()=>Boolean(active)});
const running = () => Boolean(active)||video.busy();
const encoder4b = path.join(ROOT,'models','flux-klein','Qwen3VL-4B-Instruct-Q4_K_M.gguf');
function modelFile(model, filename) { return path.join(ROOT,model.folder,filename); }
// LoRA files live in models/loras/<model id>. sd-cli finds them by file name in the <lora:name:weight> prompt tag.
function listLoras(modelId) {
 try {return fs.readdirSync(path.join(LORAS,modelId),{withFileTypes:true}).filter(entry=>entry.isFile()&&/\.(safetensors|gguf|ckpt|pt|pth)$/i.test(entry.name)&&!/[:<>]/.test(entry.name)).map(entry=>({name:entry.name.replace(/\.[^.]+$/,''),file:entry.name,size:fs.statSync(path.join(LORAS,modelId,entry.name)).size})).sort((a,b)=>a.name.localeCompare(b.name));}
 catch {return [];}
}
// ESRGAN-type upscalers (RRDBNet or MoSR) for 4× sharpening, in models/upscalers.
function listUpscalers() {
 try {return fs.readdirSync(UPSCALERS,{withFileTypes:true}).filter(entry=>entry.isFile()&&/\.(pth|safetensors|gguf)$/i.test(entry.name)).map(entry=>({name:entry.name.replace(/\.[^.]+$/,''),file:entry.name,size:fs.statSync(path.join(UPSCALERS,entry.name)).size})).sort((a,b)=>a.name.localeCompare(b.name));}
 catch {return [];}
}
function getModels() {
 return models.map(model=>{
  const missing=[model.diffusion,model.encoder,model.vae].filter(file=>!fs.existsSync(modelFile(model,file)));
  const canEdit=!model.projector || fs.existsSync(modelFile(model,model.projector));
  return {...model,ready:missing.length===0&&fs.existsSync(CLI),missing,loras:listLoras(model.id),loraFolder:path.join('models','loras',model.id),capabilities:{...model.capabilities,editing:canEdit,promptExpansion:fs.existsSync(LLAMA)&&fs.existsSync(encoder4b)}};
 });
}
function downloadStatus() {
 try {return JSON.parse(fs.readFileSync(path.join(LOGS,'download-progress.json'),'utf8'));} catch {return null;}
}
function gallery() {
 const entries=[];
 for(const file of fs.readdirSync(OUTPUTS).filter(v=>v.endsWith('.json')).sort().reverse().slice(0,200)) {
  try {const value=JSON.parse(fs.readFileSync(path.join(OUTPUTS,file),'utf8')); if(value.mediaType!=='video'&&value.filename&&fs.existsSync(path.join(OUTPUTS,path.basename(value.filename))))entries.push({...value,url:`/api/image?name=${encodeURIComponent(value.filename)}`,metadataUrl:`/api/metadata?name=${encodeURIComponent(file)}`});}catch{}
 }
 return entries;
}
function publicJob() {
 if(!job)return null;
 let preview=null;
 if(!job.finishedAt&&jobPreview?.id===job.id){try{preview=`/api/preview?id=${encodeURIComponent(job.id)}&v=${Math.floor(fs.statSync(jobPreview.file).mtimeMs)}`;}catch{}}
 return {...job,preview,elapsedMs:job.finishedAt?job.elapsedMs:Date.now()-job.startedAt};
}
function json(res,status,value) {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
function problem(message,status=400) {const error=new Error(message);error.status=status;throw error;}
async function body(req,limit=145*1024*1024) {
 if(!String(req.headers['content-type']||'').startsWith('application/json'))problem('Expected a JSON request.',415);
 const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)problem('Images are too large. Use smaller reference files.',413);chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{problem('Could not read the request.');}
}
function imageFormat(bytes) {
 if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'png';
 if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'jpg';
 if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'webp';
 return null;
}
function imageDimensions(bytes,format) {
 if(format==='png'&&bytes.length>=24)return [bytes.readUInt32BE(16),bytes.readUInt32BE(20)];
 if(format==='jpg'){
  let at=2;
  while(at+4<bytes.length){
   if(bytes[at++]!==255)continue;while(bytes[at]===255)at++;const marker=bytes[at++];
   if(marker===0xd9||marker===0xda)break;if(marker>=0xd0&&marker<=0xd7||marker===0x01)continue;
   if(at+2>bytes.length)break;const length=bytes.readUInt16BE(at);if(length<2||at+length>bytes.length)break;
   if(marker>=0xc0&&marker<=0xcf&&![0xc4,0xc8,0xcc].includes(marker)&&length>=7)return [bytes.readUInt16BE(at+5),bytes.readUInt16BE(at+3)];at+=length;
  }
 }
 if(format==='webp'){
  for(let at=12;at+8<bytes.length;){
   const type=bytes.toString('ascii',at,at+4),length=bytes.readUInt32LE(at+4),data=at+8;if(data+length>bytes.length)break;
   if(type==='VP8X'&&length>=10)return [1+bytes.readUIntLE(data+4,3),1+bytes.readUIntLE(data+7,3)];
   if(type==='VP8L'&&length>=5&&bytes[data]===0x2f){const value=bytes.readUInt32LE(data+1);return [1+(value&0x3fff),1+((value>>>14)&0x3fff)];}
   if(type==='VP8 '&&length>=10)return [bytes.readUInt16LE(data+6)&0x3fff,bytes.readUInt16LE(data+8)&0x3fff];at=data+length+(length%2);
  }
 }
 return null;
}
function validateRequest(data) {
 const model=models.find(m=>m.id===data.modelId);if(!model)problem('Choose an available model.');
 const available=getModels().find(m=>m.id===model.id);if(!available.ready)problem('This model is not downloaded yet.',409);
 // An empty description counts as Blank prompt, which sends the Braille blank U+2800 (see startGeneration).
 const typed=String(data.prompt||'').trim();const blankPrompt=data.blankPrompt===true||!typed;
 const prompt=blankPrompt?'':typed;if(prompt.length>12000)problem('Keep the description under 12,000 characters.');
 const options=model.options;
 const width=Number(data.width),height=Number(data.height);
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<256||height<256||width>options.maxSize||height>options.maxSize||width%32||height%32||width*height>4194304)problem(`Choose an image size between 256 and ${options.maxSize} pixels, in multiples of 32.`);
 let seed=Number(data.seed??-1);if(!Number.isInteger(seed)||seed< -1||seed>2147483647)problem('Seed must be -1 or a whole number up to 2147483647.');if(seed===-1)seed=randomInt(2147483647);
 const scheduler=String(data.scheduler??model.defaults.scheduler);
 if(![...(options.turboSchedule?['turbo']:[]),'default',...SCHEDULERS].includes(scheduler))problem('Choose a valid schedule.');
 const turbo=scheduler==='turbo';
 let steps=Number(data.steps??model.defaults.steps),cfg=Number(data.cfg??model.defaults.cfg);
 // The Turbo schedule is a fixed list of 8 trained steps. Other schedules accept any step count.
 if(turbo)steps=8;
 if(!Number.isInteger(steps)||steps<1||steps>100)problem('Steps must be a whole number from 1 to 100.');
 if(!Number.isFinite(cfg)||cfg<1||cfg>20)problem('Guidance must be between 1 and 20.');
 const sampler=String(data.sampler??model.defaults.sampler);if(!SAMPLERS.includes(sampler))problem('Choose a valid sampler.');
 const eta=optionalNumber(data.eta,ETA_SAMPLERS.includes(sampler),0,2,'Extra noise');
 const flowShift=optionalNumber(data.flowShift,options.flowShift&&!turbo,0.1,20,'Flow shift');
 const negativePrompt=blankPrompt||cfg<=1?'':String(data.negativePrompt||'').trim();if(negativePrompt.length>4000)problem('Keep the Avoid text under 4,000 characters.');
 const batch=Number(data.batch??1);if(!Number.isInteger(batch)||batch<1||batch>options.batch)problem(`Images per run must be from 1 to ${options.batch}.`);
 const tiling=String(data.tiling||'off');if(!Object.hasOwn(TILING,tiling))problem('Choose a valid tiling option.');
 const cache=String(data.cache||'off');if(cache!=='off'&&!CACHE_MODES.includes(cache))problem('Choose a valid speed-up option.');
 const postUpscale=data.postUpscale?listUpscalers().find(item=>item.file===String(data.postUpscale)):null;
 if(data.postUpscale&&!postUpscale)problem(`The upscaler "${String(data.postUpscale).slice(0,80)}" is not in ${path.join("models","upscalers")}.`);
 let hires=null;
 if(data.hires?.enabled){
  const scale=Number(data.hires.scale??model.defaults.hiresScale),strength=Number(data.hires.strength??model.defaults.hiresStrength),upscaler=String(data.hires.upscaler||model.defaults.hiresUpscaler);
  const hiresSteps=turbo?0:Number(data.hires.steps??0);
  if(!Number.isFinite(scale)||scale<1.1||scale>4)problem('The upscale factor must be between 1.1 and 4.');
  if(!Number.isFinite(strength)||strength<0.05||strength>1)problem('Upscale redraw strength must be between 0.05 and 1.');
  if(!Number.isInteger(hiresSteps)||hiresSteps<0||hiresSteps>100)problem('Upscale steps must be a whole number from 0 to 100.');
  if(!HIRES_UPSCALERS.includes(upscaler))problem('Choose a valid upscale method.');
  const hiresWidth=Math.round(width*scale/32)*32,hiresHeight=Math.round(height*scale/32)*32;
  if(hiresWidth>options.maxSize||hiresHeight>options.maxSize||hiresWidth*hiresHeight>4194304)problem(`The upscaled image would be ${hiresWidth} × ${hiresHeight}. Keep it within ${options.maxSize} pixels per side by lowering the size or the upscale factor.`);
  hires={scale,strength,steps:hiresSteps,upscaler,width:hiresWidth,height:hiresHeight};
 }
 const installedLoras=listLoras(model.id);
 if(data.loras!==undefined&&!Array.isArray(data.loras))problem('Could not read the LoRA list.');
 const loras=(data.loras||[]).map(item=>{
  const found=installedLoras.find(lora=>lora.name===String(item?.name));if(!found)problem(`The LoRA "${String(item?.name).slice(0,80)}" is not in ${path.join('models','loras',model.id)}.`);
  const weight=Number(item.weight??1);if(!Number.isFinite(weight)||weight< -4||weight>4)problem('LoRA strength must be between -4 and 4.');
  return {name:found.name,file:found.file,weight:Math.round(weight*100)/100};
 });
 if(loras.length>8||new Set(loras.map(lora=>lora.name)).size!==loras.length)problem('Use each LoRA once, up to 8 at a time.');
 const references=data.references||[];
 if(!Array.isArray(references)||references.length>options.references)problem(`Use at most ${options.references} reference images.`);
 if(data.mode==='edit'&&!references.length)problem('Add an image to edit.');if(references.length&&!available.capabilities.editing)problem('The image-editing component is still missing.',409);
 const decoded=references.map((item,index)=>decodeImage(item,`Reference image ${index+1}`,`Reference ${index+1}`));
 const initImage=data.initImage?decodeImage(data.initImage,'The start image','Start image'):null;
 const mask=data.mask?decodeImage(data.mask,'The mask','Mask'):null;
 if(mask&&!initImage)problem('Add a start image before painting a mask.');
 if(mask&&(mask.dimensions[0]!==initImage.dimensions[0]||mask.dimensions[1]!==initImage.dimensions[1]))problem('The mask no longer matches the start image. Paint it again.');
 const strength=Number(data.strength??model.defaults.strength);if(initImage&&(!Number.isFinite(strength)||strength<0.01||strength>1))problem('Change strength must be between 0.01 and 1.');
 const mode=initImage?mask?'inpaint':'redraw':decoded.length?'edit':'create';
 return {model,prompt,blankPrompt,width,height,seed,steps,cfg,mode,references:decoded,transparent:Boolean(!blankPrompt&&data.transparent&&options.transparent),
  negativePrompt,sampler,scheduler,eta,flowShift,batch,tiling,cache,postUpscale,preview:data.preview!==false&&options.preview,hires,loras,initImage,mask,strength:initImage?strength:null};
}
function optionalNumber(value,allowed,min,max,label) {
 if(!allowed||value===undefined||value===null||value==='')return null;
 const number=Number(value);if(!Number.isFinite(number)||number<min||number>max)problem(`${label} must be between ${min} and ${max}.`);return number;
}
function decodeImage(item,label,fallbackName) {
 if(!item||typeof item.dataUrl!=='string')problem(`${label} is missing.`);
 const match=/^data:image\/(?:png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(item.dataUrl);if(!match)problem(`${label} must be a PNG, JPEG or WebP file.`);
 const bytes=Buffer.from(match[1],'base64');if(bytes.length>10*1024*1024)problem(`${label} must be under 10 MB.`);
 const ext=imageFormat(bytes);if(!ext)problem(`${label} is not a supported image.`);
 const dimensions=imageDimensions(bytes,ext);
 if(!dimensions||dimensions.some(v=>v<1||v>2048)||dimensions[0]*dimensions[1]>4194304)problem(`${label} must be at most 2048 px per side. Add it through the image picker to resize a copy automatically.`);
 return {bytes,ext,dimensions,name:path.basename(String(item.name||fallbackName))};
}
function startGeneration(data) {
 if(running())problem('An image or prompt is already being processed.',409);
 const request=validateRequest(data);const {model,prompt,blankPrompt,width,height,seed,steps,cfg,mode,transparent,postUpscale,negativePrompt,sampler,scheduler,eta,flowShift,batch,tiling,cache,preview,hires,loras,strength}=request;
 const id=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,6);
 const directory=path.join(INPUTS,id);fs.mkdirSync(directory,{recursive:true});
 // Blank prompt sends the invisible Braille blank U+2800, which gives unrelated images on every run.
 const effectivePrompt=(blankPrompt?'⠀':transparent?`This is an RGBA image with transparency. ${prompt}. The image has alpha channel and the background is transparent.`:prompt)+loras.map(lora=>` <lora:${lora.name}:${lora.weight}>`).join('');
 const promptFile=path.join(directory,'prompt.txt');fs.writeFileSync(promptFile,effectivePrompt,'utf8');
 const refs=request.references.map((ref,index)=>{const file=path.join(directory,`reference-${index+1}.${ref.ext}`);fs.writeFileSync(file,ref.bytes);return {file,name:ref.name};});
 const saveInput=(image,name)=>{if(!image)return null;const file=path.join(directory,`${name}.${image.ext}`);fs.writeFileSync(file,image.bytes);return {file,name:image.name};};
 const init=saveInput(request.initImage,'start'),mask=saveInput(request.mask,'mask');
 const output=path.join(OUTPUTS,id+'.png');const previewFile=path.join(directory,'preview.png');
 // Encoding a picture with 256 px VAE tiles leaves visible seams that a partial redraw cannot remove (seen with Qwen),
 // so jobs that encode a start image or a pixel-space upscale use 512 px tiles. Plain generation keeps 256 px.
 const encodesPixels=Boolean(init)||Boolean(hires&&!hires.upscaler.startsWith('Latent'));
 const args=['--diffusion-model',modelFile(model,model.diffusion),'--llm',modelFile(model,model.encoder),'--vae',modelFile(model,model.vae),'--backend','Vulkan0','--max-vram','-1.5','--mmap','--vae-tiling','--vae-tile-size',encodesPixels?'512':'256','--flash-attn','auto','--threads','6','--prompt-file',promptFile,'--steps',String(steps),'--cfg-scale',String(cfg),'--sampling-method',sampler,'--seed',String(seed),'-W',String(width),'-H',String(height),'--rng','cpu','-o',output];
 if(scheduler==='turbo')args.push('--sigmas',SIGMAS);else if(scheduler!=='default')args.push('--scheduler',scheduler);
 if(negativePrompt){const file=path.join(directory,'avoid.txt');fs.writeFileSync(file,negativePrompt,'utf8');args.push('--negative-prompt-file',file);}
 if(eta!==null)args.push('--eta',String(eta));
 if(flowShift!==null)args.push('--flow-shift',String(flowShift));
 if(batch>1)args.push('-b',String(batch));
 args.push(...TILING[tiling]);
 if(cache!=='off')args.push('--cache-mode',cache);
 if(preview)args.push('--preview','proj','--preview-path',previewFile,'--preview-interval','1');
 if(hires){
  args.push('--hires','--hires-upscaler',hires.upscaler,'--hires-width',String(hires.width),'--hires-height',String(hires.height),'--hires-denoising-strength',String(hires.strength));
  // The full Turbo list restarts from pure noise and leaves seams. Start the second pass at the chosen noise level
  // and finish with the Turbo steps below it, e.g. 0.7 -> 0.7,0.414568,0.0.
  if(scheduler==='turbo')args.push('--hires-sigmas',[hires.strength,...SIGMAS.split(',').map(Number).filter(value=>value<hires.strength-0.02)].join(','));
  else if(hires.steps)args.push('--hires-steps',String(hires.steps));
 }
 if(loras.length)args.push('--lora-model-dir',path.join(LORAS,model.id));
 if(postUpscale)args.push('--upscale-model',path.join(UPSCALERS,postUpscale.file),'--upscale-repeats','1','--upscale-tile-size','128');
 if(init){args.push('-i',init.file,'--strength',String(strength));if(mask)args.push('--mask',mask.file);}
 if(refs.length&&model.projector)args.push('--llm_vision',modelFile(model,model.projector));
 for(const ref of refs)args.push('-r',ref.file);
 const settings={negativePrompt,sampler,scheduler,eta,flowShift,batch,tiling,cache,hires,loras:loras.map(({name,weight})=>({name,weight})),strength,postUpscale:postUpscale?.name||null};
 job={id,status:'loading',modelId:model.id,prompt,blankPrompt,width,height,seed,steps,cfg,mode,transparent,...settings,step:0,progress:null,message:'Loading model…',startedAt:Date.now(),elapsedMs:0,referenceCount:refs.length,imageIndex:1};
 jobPreview=preview?{id,file:previewFile}:null;
 const current=job;
 // Each image runs one sampling pass, or two with Upscale. sd-cli prints "generating image: k/n" before each image.
 // Sampling bars end in it/s or s/it; weight-loading bars end in MB/s or GB/s. VAE encode and decode tiles also
 // end in it/s, so steps are only counted after "generating image: k/n" (first pass) or the hires plan line, which
 // gives the second pass's length as sigma_sched_size - 1.
 const totalPasses=batch*(hires?2:1);let completedPasses=0,lastStep=0,counting=false,upscaling=false,hiresTotal=0;
 const parse=text=>{
  if(/sampling using/i.test(text)&&current.status==='loading'){current.status='generating';current.message=batch>1?'Creating your images…':'Creating your image…';}
  const image=/generating image:\s*(\d+)\s*\/\s*(\d+)/i.exec(text);
  if(image){current.imageIndex=Number(image[1]);counting=true;lastStep=0;current.status='generating';if(batch>1)current.message=`Creating image ${current.imageIndex} of ${batch}…`;}
  const plan=/hires fix: .*sigma_sched_size=(\d+)/i.exec(text);
  if(hires&&plan){upscaling=true;counting=true;lastStep=0;hiresTotal=Number(plan[1])-1;current.status='generating';current.message='Upscaling…';}
  const bar=/\|[=> ]*\|\s*(\d+)\s*\/\s*(\d+)\s*-\s*[\d.]+\s*(?:it\/s|s\/it)/i.exec(text);
  if(bar&&counting&&(!upscaling||Number(bar[2])===hiresTotal)){
   const step=Number(bar[1]),total=Number(bar[2]);
   if(step===total){if(lastStep!==-1)completedPasses++;lastStep=-1;if(!upscaling)counting=false;}
   else lastStep=step;
   current.step=step;current.progress=Math.min(0.99,(completedPasses+(lastStep===-1?0:step/total))/totalPasses);
   current.message=`${upscaling?'Upscaling':'Creating'} ${batch>1?`image ${upscaling?Math.min(batch,completedPasses-batch+(lastStep===-1?0:1)):current.imageIndex} of ${batch} · `:''}step ${step} of ${total}`;
  }
  // A LoRA made for another model still loads but matches few or none of this model's layers.
  const lora=/\((\d+) \/ (\d+)\) LoRA tensors have been applied, lora_file_path = (.+?)(?: ---|$)/.exec(text);
  if(lora&&Number(lora[1])<Number(lora[2]))current.warning=`Only ${lora[1]} of ${lora[2]} parts of the LoRA ${path.basename(lora[3].trim())} matched this model. It may be made for a different model.`;
  if(/can ?not find lora|lora.*not found|failed to load lora/i.test(text))current.warning='A LoRA could not be loaded. Check that its file is still in the LoRA folder.';
  if(/decode_first_stage|latent \d+ decoded/i.test(text)){current.status='decoding';current.message=batch>1?'Finishing the images…':'Finishing the image…';}
  if(postUpscale&&/upscaling from/i.test(text)){current.status='decoding';current.message=`Sharpening ${batch>1?'the images':'the image'} 4×…`;}
 };
 runCli({id,args,current,parse,header:{model:model.id,mode,seed,width,height,steps,cfg,...settings,startedAt:new Date().toISOString()},collect:()=>{
  // One image is saved as <id>.png. A batch is saved as <id>_0.png, <id>_1.png… with seed, seed+1…
  const index=name=>Number(/_(\d+)\.png$/.exec(name)?.[1]??0);
  const relative=item=>item&&{name:item.name,path:path.relative(ROOT,item.file)};
  return fs.readdirSync(OUTPUTS).filter(name=>(name===`${id}.png`||new RegExp(`^${id}_\\d+\\.png$`).test(name))).sort((a,b)=>index(a)-index(b)).map(resultFile=>{
   const imageSeed=seed+index(resultFile),[finalWidth,finalHeight]=pngSize(path.join(OUTPUTS,resultFile))||[hires?.width??width,hires?.height??height];
   return saveResult(resultFile,{prompt,effectivePrompt,blankPrompt,modelId:model.id,modelName:model.name,mode,width:finalWidth,height:finalHeight,...(finalWidth!==width||finalHeight!==height?{baseWidth:width,baseHeight:height}:{}),seed:imageSeed,steps,cfg,transparent,...settings,batchIndex:index(resultFile)+1,referenceCount:refs.length,references:refs.map(relative),startImage:relative(init),mask:relative(mask),elapsedMs:Date.now()-current.startedAt,runtime:'stable-diffusion.cpp 2f016e8',modelSource:model.source});
  });
 }});
 return publicJob();
}
function pngSize(file) {try{const fd=fs.openSync(file,'r');const bytes=Buffer.alloc(24);fs.readSync(fd,bytes,0,24,0);fs.closeSync(fd);return imageDimensions(bytes,'png');}catch{return null;}}
function saveResult(resultFile,metadata) {
 const base=resultFile.replace(/\.png$/,'');
 fs.writeFileSync(path.join(OUTPUTS,base+'.json'),JSON.stringify({...metadata,filename:resultFile,createdAt:new Date().toISOString()},null,2));
 return {url:`/api/image?name=${encodeURIComponent(resultFile)}`,filename:resultFile,metadataUrl:`/api/metadata?name=${encodeURIComponent(base+'.json')}`,seed:metadata.seed};
}
// Runs sd-cli for the current job. Output goes to logs/<id>.log and, line by line, to parse(); collect() saves the
// results once sd-cli exits successfully.
function runCli({id,args,current,parse,header,collect}) {
 const log=fs.createWriteStream(path.join(LOGS,id+'.log'));log.write(JSON.stringify(header)+'\n');
 const child=spawn(CLI,args,{cwd:path.dirname(CLI),windowsHide:true,stdio:['ignore','pipe','pipe']});
 active={kind:'generation',process:child,cancelled:false};const processState=active;let tail='';
 const partialLines={stdout:'',stderr:''};
 const read=(stream,buffer)=>{
  const text=buffer.toString('utf8').replace(/\x1b\[[0-9;]*m/g,'');log.write(text);tail=(tail+text).slice(-16000);
  const lines=(partialLines[stream]+text).split(/[\r\n]/);partialLines[stream]=lines.pop().slice(-4000);for(const line of lines)parse(line);
 };
 child.stdout.on('data',buffer=>read('stdout',buffer));child.stderr.on('data',buffer=>read('stderr',buffer));
 child.on('error',error=>{current.error=error.message;});
 child.on('close',code=>{
  log.end();if(active===processState)active=null;current.finishedAt=Date.now();current.elapsedMs=current.finishedAt-current.startedAt;
  if(processState.cancelled){current.status='cancelled';current.message='Cancelled. Ready when you are.';return;}
  let results=[];if(code===0){try{results=collect();}catch(error){current.error=`The image was made but could not be saved: ${error.message}`;}}
  if(results.length){
   current.results=results;current.status='complete';current.progress=1;current.message=results.length>1?`${results.length} images saved.`:'Image saved.';current.result=results[0];
  }else{
   current.status='error';current.message='This image could not be generated.';
   current.error=/out of.*memory|allocation.*failed|VK_ERROR_OUT_OF|not enough.*memory/i.test(tail)?'The model ran out of memory. Try 512 px, fewer reference images, or close other apps using the GPU.':current.error||`The image engine stopped (code ${code}). Details are saved in logs/${id}.log.`;
   current.diagnostic=tail.split(/[\r\n]+/).filter(v=>/error|failed|assert/i.test(v)).slice(-3).join('\n');
  }
 });
}
// 4× upscale of a saved image with an ESRGAN-type model from models/upscalers (sd-cli upscale mode).
function startUpscale(data) {
 if(running())problem('An image or prompt is already being processed.',409);
 const name=String(data.name||'');if(!name||name!==path.basename(name)||!name.endsWith('.png')||!fs.existsSync(path.join(OUTPUTS,name)))problem('Choose a saved image to upscale.');
 const installed=listUpscalers();const upscaler=installed.find(item=>item.file===data.upscaler)||installed[0];
 if(!upscaler)problem(`No upscaler model is installed. Put one in ${path.join('models','upscalers')}.`,409);
 const source=path.join(OUTPUTS,name);const size=pngSize(source);
 if(!size||size[0]>2048||size[1]>2048)problem('Only images up to 2048 px per side can be upscaled 4×.');
 let sourceMeta={};try{sourceMeta=JSON.parse(fs.readFileSync(source.replace(/\.png$/,'.json'),'utf8'));}catch{}
 const id=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,6);const output=path.join(OUTPUTS,id+'.png');
 const args=['-M','upscale','--upscale-model',path.join(UPSCALERS,upscaler.file),'-i',source,'-o',output,'--upscale-repeats','1','--upscale-tile-size','128','--backend','Vulkan0','--threads','6'];
 job={id,status:'loading',modelId:sourceMeta.modelId||null,prompt:sourceMeta.prompt||'',blankPrompt:sourceMeta.blankPrompt===true,width:size[0]*4,height:size[1]*4,seed:sourceMeta.seed??null,mode:'upscale',upscaledFrom:name,step:0,progress:null,message:'Loading the upscaler…',startedAt:Date.now(),elapsedMs:0};
 jobPreview=null;const current=job;
 const parse=text=>{
  if(/upscaling from/i.test(text)){current.status='generating';current.message=`Upscaling 4× to ${size[0]*4} × ${size[1]*4}…`;}
  const bar=/\|[=> ]*\|\s*(\d+)\s*\/\s*(\d+)\s*-\s*[\d.]+\s*(?:it\/s|s\/it)/i.exec(text);
  if(bar&&current.status==='generating'){current.progress=Math.min(0.99,Number(bar[1])/Number(bar[2]));}
 };
 runCli({id,args,current,parse,header:{mode:'upscale',source:name,upscaler:upscaler.file,startedAt:new Date().toISOString()},collect:()=>{
  if(!fs.existsSync(output))return [];const [width,height]=pngSize(output)||[size[0]*4,size[1]*4];
  return [saveResult(path.basename(output),{...sourceMeta,mode:'upscale',modelName:`${sourceMeta.modelName||'Image'} · 4× upscale`,width,height,upscaledFrom:name,upscaler:upscaler.file,elapsedMs:Date.now()-current.startedAt,runtime:'stable-diffusion.cpp 2f016e8'})];
 }});
 return publicJob();
}
async function expandPrompt(data) {
 if(running())problem('Wait for the current image to finish.',409);
 if(!fs.existsSync(LLAMA)||!fs.existsSync(encoder4b))problem('Prompt expansion is not ready yet.',409);
 const prompt=String(data.prompt||'').trim();if(!prompt||prompt.length>4000)problem('Enter a description of up to 4,000 characters.');
 const system='Rewrite the user\'s image request as one clear, detailed scene caption for an image generator. Preserve their subject, intention, requested words, style and composition. Describe placement, materials, colors, framing, lighting and background only where helpful. Do not add unrelated subjects or change the meaning. Return only the caption, no introduction, quotes, bullets, explanations or thinking. Keep it under 180 words.';
 const args=['-m',encoder4b,'--jinja','--single-turn','-sys',system,'-p',prompt,'-c','4096','-n','384','--device','Vulkan0','--split-mode','none','--main-gpu','0','-ngl','all','--threads','6','--no-display-prompt','--simple-io','--color','off','--temp','0.3'];
 return await new Promise((resolve,reject)=>{
  const child=spawn(LLAMA,args,{cwd:path.dirname(LLAMA),windowsHide:true,stdio:['ignore','pipe','pipe']});const state={kind:'enhance',process:child,cancelled:false};active=state;let output='',diagnostic='';
  const timer=setTimeout(()=>{state.cancelled=true;child.kill();},180000);
  child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>diagnostic=(diagnostic+v).slice(-6000));
  child.on('error',e=>{clearTimeout(timer);if(active===state)active=null;reject(e);});
  child.on('close',code=>{clearTimeout(timer);if(active===state)active=null;
   const clean=output.replace(/<think>[\s\S]*?<\/think>/g,'').replace(/\[end of text\]/g,'').trim();
   fs.writeFileSync(path.join(LOGS,'prompt-expansion.log'),diagnostic);
   if(code!==0||state.cancelled||!clean)reject(new Error(state.cancelled?'Prompt expansion was cancelled.':'Could not expand this prompt. You can still generate with your original text.'));
   else resolve({prompt:clean});
  });
 });
}
function cancel(){video.cancel();if(active){active.cancelled=true;active.process.kill();if(job&&active.kind==='generation')job.message='Cancelling…';}return {ok:true};}
function serveFile(res,file,type) {if(!fs.existsSync(file)){json(res,404,{error:'File not found.'});return;}res.writeHead(200,{'Content-Type':type,'Content-Length':fs.statSync(file).size,'Cache-Control':type.startsWith('image/')?'private, max-age=3600':'no-store'});fs.createReadStream(file).pipe(res);}
function openBrowser(){spawn('rundll32.exe',['url.dll,FileProtocolHandler',URL_BASE],{windowsHide:true,detached:true,stdio:'ignore'}).unref();}
const server=http.createServer(async(req,res)=>{
 try{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
  const host=req.headers.host;if(host!==`127.0.0.1:${PORT}`&&host!==`localhost:${PORT}`){json(res,403,{error:'Local access only.'});return;}
  const url=new URL(req.url,URL_BASE);
  if(req.method==='POST'){
   if(req.headers.origin&&req.headers.origin!==URL_BASE&&req.headers.origin!==`http://localhost:${PORT}`){json(res,403,{error:'Local access only.'});return;}
   const data=await body(req);
   if(url.pathname==='/api/video/generate')return json(res,202,{job:video.start(data)});
   if(url.pathname==='/api/video/cancel')return json(res,200,video.cancel());
   if(url.pathname==='/api/video/update')return json(res,200,video.update(data));
   if(url.pathname==='/api/video/resume')return json(res,200,video.resume(data));
   if(url.pathname==='/api/video/finish')return json(res,200,video.finish());
   if(url.pathname==='/api/video/merge')return json(res,202,{job:video.merge(data)});
   if(url.pathname==='/api/video/open-session')return json(res,200,video.openSession(data));
   if(url.pathname==='/api/video/download')return json(res,202,video.resumeDownload());
   if(url.pathname==='/api/generate')return json(res,202,{job:startGeneration(data)});
   if(url.pathname==='/api/upscale')return json(res,202,{job:startUpscale(data)});
   if(url.pathname==='/api/enhance')return json(res,200,await expandPrompt(data));
   if(url.pathname==='/api/cancel')return json(res,200,cancel());
   if(url.pathname==='/api/open-loras'){const model=models.find(m=>m.id===data.modelId);if(!model)problem('Choose an available model.');const folder=path.join(LORAS,model.id);fs.mkdirSync(folder,{recursive:true});spawn('explorer.exe',[folder],{windowsHide:true,detached:true,stdio:'ignore'}).unref();return json(res,200,{ok:true});}
   if(url.pathname==='/api/open-outputs'){spawn('explorer.exe',[OUTPUTS],{windowsHide:true,detached:true,stdio:'ignore'}).unref();return json(res,200,{ok:true});}
   if(url.pathname==='/api/shutdown'){json(res,200,{ok:true});shutdown();return;}
   return json(res,404,{error:'Unknown action.'});
  }
  if(req.method!=='GET')return json(res,405,{error:'Unsupported request.'});
  if(url.pathname==='/api/health')return json(res,200,{app:'local-image-lab',version:'1.6.0',root:ROOT});
  if(url.pathname==='/api/state')return json(res,200,{models:getModels(),job:publicJob(),busy:running(),enhancing:active?.kind==='enhance',download:downloadStatus(),gallery:gallery(),upscalers:listUpscalers(),version:'1.6.0'});
  if(url.pathname==='/api/video/state')return json(res,200,video.state());
  if(url.pathname==='/api/video/file')return video.serve(req,res,url.searchParams.get('name')||'');
  if(url.pathname==='/api/preview'){if(!jobPreview||url.searchParams.get('id')!==jobPreview.id)return json(res,404,{error:'No preview.'});res.setHeader('Cache-Control','no-store');return serveFile(res,jobPreview.file,'image/png');}
  if(['/api/image','/api/metadata'].includes(url.pathname)){
   const name=url.searchParams.get('name')||'';if(name!==path.basename(name)||!name||name.includes('..'))problem('Invalid filename.');
   const isImage=url.pathname==='/api/image';if(isImage&&!name.endsWith('.png')||!isImage&&!name.endsWith('.json'))problem('Unsupported file.');
   return serveFile(res,path.join(OUTPUTS,name),isImage?'image/png':'application/json; charset=utf-8');
  }
  const assets={'/':'index.html','/index.html':'index.html','/style.css':'style.css','/app.js':'app.js','/video':'video.html','/video.html':'video.html','/video.js':'video.js','/video-timing.mjs':'video-timing.mjs','/video.css':'video.css'};const asset=assets[url.pathname];
  if(asset){res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");return serveFile(res,path.join(ROOT,'app','public',asset),asset.endsWith('.html')?'text/html; charset=utf-8':asset.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8');}
  json(res,404,{error:'Not found.'});
 }catch(error){if(!res.headersSent)json(res,error.status||500,{error:error.message});else res.end();}
});
function shutdown(){if(closing)return;closing=true;cancel();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),1500).unref();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
process.on('uncaughtException',error=>{fs.appendFileSync(path.join(LOGS,'app-error.log'),new Date().toISOString()+' '+error.stack+'\n');shutdown();});
server.on('error',async error=>{
 if(error.code==='EADDRINUSE'){
  try{const response=await fetch(URL_BASE+'/api/health');const info=await response.json();if(info.app==='local-image-lab'){if(process.argv.includes('--open'))openBrowser();process.exit(0);}}catch{}
 }
 fs.appendFileSync(path.join(LOGS,'app-error.log'),String(error)+'\n');process.exit(1);
});
server.listen(PORT,'127.0.0.1',()=>{console.log(`Local Image Lab: ${URL_BASE}`);armVideoSetup({root:ROOT,video});armVideoSetup({root:ROOT,video,reference:true});if(process.argv.includes('--open'))openBrowser();});
