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
const models = [
 {id:'qwen-turbo',name:'Qwen Image 2.1 Turbo',description:'Create, edit and combine images. Transparent backgrounds supported.',folder:'models/qwen-turbo',
  defaults:{width:768,height:768,steps:8,cfg:1}, capabilities:{editing:true,maxReferences:10,transparent:true,promptExpansion:true},
  diffusion:'Qwen-Image-2.1-Turbo-AD-Q4_K.gguf',encoder:'Qwen-Image-2.1-Turbo-Uncensored-AD-Q4_K.gguf',vae:'qwen_image_2.1_vae_bf16.safetensors',projector:'mmproj-Qwen-Image-2.1-Turbo-Uncensored-F16.gguf',
  source:'https://huggingface.co/AtomicChat/Qwen-Image-2.1-Turbo-GGUF',settings:{stepsLocked:true,cfgLocked:true}},
 {id:'flux-klein',name:'FLUX 3 Image Klein',description:'Create, edit and combine images. Detailed scene descriptions work best.',folder:'models/flux-klein',
  defaults:{width:768,height:768,steps:16,cfg:1},capabilities:{editing:true,maxReferences:10,transparent:false,promptExpansion:true},
  diffusion:'flux-3-image-klein-Q4_K_M.gguf',encoder:'Qwen3VL-4B-Instruct-Q4_K_M.gguf',vae:'flux2-vae.safetensors',
  source:'https://huggingface.co/black-forest-labs/flux-3-image-klein',settings:{stepsLocked:false,cfgLocked:true}}
];
let job = null;
let active = null;
let closing = false;
const video = createVideoEngine({root:ROOT,isOtherBusy:()=>Boolean(active)});
const running = () => Boolean(active)||video.busy();
const encoder4b = path.join(ROOT,'models','flux-klein','Qwen3VL-4B-Instruct-Q4_K_M.gguf');
function modelFile(model, filename) { return path.join(ROOT,model.folder,filename); }
function getModels() {
 return models.map(model=>{
  const missing=[model.diffusion,model.encoder,model.vae].filter(file=>!fs.existsSync(modelFile(model,file)));
  const canEdit=!model.projector || fs.existsSync(modelFile(model,model.projector));
  return {...model,ready:missing.length===0&&fs.existsSync(CLI),missing,capabilities:{...model.capabilities,editing:canEdit,promptExpansion:fs.existsSync(LLAMA)&&fs.existsSync(encoder4b)}};
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
function publicJob() {return job?{...job,elapsedMs:job.finishedAt?job.elapsedMs:Date.now()-job.startedAt}:null;}
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
 const blankPrompt=data.blankPrompt===true;
 const prompt=blankPrompt?'':String(data.prompt||'').trim();if(!prompt&&!blankPrompt)problem('Describe the image first, or switch on Blank prompt.');if(prompt.length>12000)problem('Keep the description under 12,000 characters.');
 const width=Number(data.width),height=Number(data.height);
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<256||height<256||width>1024||height>1024||width%32||height%32)problem('Choose an image size between 256 and 1024 pixels, in multiples of 32.');
 let seed=Number(data.seed??-1);if(!Number.isInteger(seed)||seed< -1||seed>2147483647)problem('Seed must be -1 or a whole number up to 2147483647.');if(seed===-1)seed=randomInt(2147483647);
 let steps=Number(data.steps??model.defaults.steps),cfg=Number(data.cfg??model.defaults.cfg);
 if(!Number.isInteger(steps)||steps<1||steps>50)problem('Steps must be a whole number from 1 to 50.');
 if(!Number.isFinite(cfg)||cfg<1||cfg>10)problem('Prompt guidance must be between 1 and 10.');
 // Distilled checkpoints need their trained guidance/schedule. Preserve those defaults.
 if(model.settings.stepsLocked)steps=model.defaults.steps;if(model.settings.cfgLocked)cfg=model.defaults.cfg;
 const mode=data.mode==='edit'?'edit':'create';const references=mode==='edit'?(data.references||[]):[];
 if(!Array.isArray(references)||references.length>model.capabilities.maxReferences)problem('Use at most 10 reference images.');
 if(mode==='edit'&&!references.length)problem('Add an image to edit.');if(mode==='edit'&&!available.capabilities.editing)problem('The image-editing component is still missing.',409);
 const decoded=references.map((item,index)=>{
  if(typeof item.dataUrl!=='string')problem('A reference image is missing.');
  const match=/^data:image\/(?:png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(item.dataUrl);if(!match)problem('Use PNG, JPEG or WebP reference images.');
  const bytes=Buffer.from(match[1],'base64');if(bytes.length>10*1024*1024)problem('Each reference image must be under 10 MB.');
  const ext=imageFormat(bytes);if(!ext)problem('One of the reference files is not a supported image.');
  const dimensions=imageDimensions(bytes,ext);
  if(!dimensions||dimensions.some(v=>v<1||v>2048)||dimensions[0]*dimensions[1]>4194304)problem('Reference images must be at most 2048 px per side. Add them through the image picker to resize a copy automatically.');
  return {bytes,ext,name:path.basename(String(item.name||`Reference ${index+1}`))};
 });
 return {model,prompt,blankPrompt,width,height,seed,steps,cfg,mode,references:decoded,transparent:Boolean(!blankPrompt&&data.transparent&&model.capabilities.transparent)};
}
function startGeneration(data) {
 if(running())problem('An image or prompt is already being processed.',409);
 const request=validateRequest(data);const {model,prompt,blankPrompt,width,height,seed,steps,cfg,mode,transparent}=request;
 const id=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,6);
 const directory=path.join(INPUTS,id);fs.mkdirSync(directory,{recursive:true});
 const effectivePrompt=transparent?`This is an RGBA image with transparency. ${prompt}. The image has alpha channel and the background is transparent.`:prompt;
 const promptFile=path.join(directory,'prompt.txt');fs.writeFileSync(promptFile,effectivePrompt,'utf8');
 const refs=request.references.map((ref,index)=>{const file=path.join(directory,`reference-${index+1}.${ref.ext}`);fs.writeFileSync(file,ref.bytes);return {file,name:ref.name};});
 const output=path.join(OUTPUTS,id+'.png');
 const args=['--diffusion-model',modelFile(model,model.diffusion),'--llm',modelFile(model,model.encoder),'--vae',modelFile(model,model.vae),'--backend','Vulkan0','--max-vram','-1.5','--mmap','--vae-tiling','--vae-tile-size','256','--flash-attn','auto','--threads','6','--prompt-file',promptFile,'--steps',String(steps),'--cfg-scale',String(cfg),'--sampling-method','euler','--seed',String(seed),'-W',String(width),'-H',String(height),'--rng','cpu','-o',output];
 if(model.id==='qwen-turbo')args.push('--sigmas',SIGMAS);
 if(refs.length&&model.projector)args.push('--llm_vision',modelFile(model,model.projector));
 for(const ref of refs)args.push('-r',ref.file);
 const logFile=path.join(LOGS,id+'.log');const log=fs.createWriteStream(logFile);
 log.write(JSON.stringify({model:model.id,mode,seed,width,height,steps,cfg,startedAt:new Date().toISOString()})+'\n');
 job={id,status:'loading',modelId:model.id,prompt,blankPrompt,width,height,seed,steps,cfg,mode,transparent,step:0,progress:null,message:'Loading model…',startedAt:Date.now(),elapsedMs:0,referenceCount:refs.length};
 const child=spawn(CLI,args,{cwd:path.dirname(CLI),windowsHide:true,stdio:['ignore','pipe','pipe']});
 const current=job;active={kind:'generation',process:child,cancelled:false};const processState=active;let tail='';
 const partialLines={stdout:'',stderr:''};
 const parse=text=>{
  if(/sampling using|generating image|sampling with|denoising/i.test(text)){current.status='generating';current.message='Creating your image…';}
  const matches=[...text.matchAll(/(?:\||\bstep\s*)(\s*\d+)\s*\/\s*(\d+)/gi)];
  for(const match of matches){const step=Number(match[1]),total=Number(match[2]);if(current.status==='generating'&&total===steps&&step>=0&&step<=total){current.step=step;current.progress=step/total;current.message=`Creating image · ${step} of ${total} steps`;}}
  if(/decoding|decode_first_stage/i.test(text)){current.status='decoding';current.message='Finishing the image…';}
 };
 const read=(stream,buffer)=>{
  const text=buffer.toString('utf8').replace(/\x1b\[[0-9;]*m/g,'');log.write(text);tail=(tail+text).slice(-16000);
  const lines=(partialLines[stream]+text).split(/[\r\n]/);partialLines[stream]=lines.pop().slice(-4000);for(const line of lines)parse(line);
 };
 child.stdout.on('data',buffer=>read('stdout',buffer));child.stderr.on('data',buffer=>read('stderr',buffer));
 child.on('error',error=>{current.error=error.message;});
 child.on('close',code=>{
  log.end();if(active===processState)active=null;current.finishedAt=Date.now();current.elapsedMs=current.finishedAt-current.startedAt;
  if(processState.cancelled){current.status='cancelled';current.message='Cancelled. Ready when you are.';return;}
  const resultFile=fs.existsSync(output)?path.basename(output):fs.readdirSync(OUTPUTS).find(name=>name.startsWith(id)&&name.endsWith('.png'));
  if(code===0&&resultFile){
   const metadata={filename:resultFile,prompt,effectivePrompt,blankPrompt,modelId:model.id,modelName:model.name,mode,width,height,seed,steps,cfg,transparent,referenceCount:refs.length,references:refs.map(r=>({name:r.name,path:path.relative(ROOT,r.file)})),createdAt:new Date().toISOString(),elapsedMs:current.elapsedMs,runtime:'stable-diffusion.cpp 2f016e8',modelSource:model.source};
   fs.writeFileSync(path.join(OUTPUTS,id+'.json'),JSON.stringify(metadata,null,2));
   current.status='complete';current.progress=1;current.message='Image saved.';current.result={url:`/api/image?name=${encodeURIComponent(resultFile)}`,filename:resultFile,metadataUrl:`/api/metadata?name=${encodeURIComponent(id+'.json')}`};
  }else{
   current.status='error';current.message='This image could not be generated.';
   current.error=/out of.*memory|allocation.*failed|VK_ERROR_OUT_OF|not enough.*memory/i.test(tail)?'The model ran out of memory. Try 512 px, fewer reference images, or close other apps using the GPU.':current.error||`The image engine stopped (code ${code}). Details are saved in logs/${id}.log.`;
   current.diagnostic=tail.split(/[\r\n]+/).filter(v=>/error|failed|assert/i.test(v)).slice(-3).join('\n');
  }
 });
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
   if(url.pathname==='/api/enhance')return json(res,200,await expandPrompt(data));
   if(url.pathname==='/api/cancel')return json(res,200,cancel());
   if(url.pathname==='/api/open-outputs'){spawn('explorer.exe',[OUTPUTS],{windowsHide:true,detached:true,stdio:'ignore'}).unref();return json(res,200,{ok:true});}
   if(url.pathname==='/api/shutdown'){json(res,200,{ok:true});shutdown();return;}
   return json(res,404,{error:'Unknown action.'});
  }
  if(req.method!=='GET')return json(res,405,{error:'Unsupported request.'});
  if(url.pathname==='/api/health')return json(res,200,{app:'local-image-lab',version:'1.6.0',root:ROOT});
  if(url.pathname==='/api/state')return json(res,200,{models:getModels(),job:publicJob(),busy:running(),enhancing:active?.kind==='enhance',download:downloadStatus(),gallery:gallery(),version:'1.6.0'});
  if(url.pathname==='/api/video/state')return json(res,200,video.state());
  if(url.pathname==='/api/video/file')return video.serve(req,res,url.searchParams.get('name')||'');
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
