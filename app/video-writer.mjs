import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const options=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const work=path.dirname(process.argv[2]),log=path.join(work,'writer-runtime');
// Keep the private package linked to the downloadable model after a repair.
const packageRoot=path.join(root,'models/story-writer/ollama');
const manifest=JSON.parse(fs.readFileSync(path.join(packageRoot,'manifests/registry.ollama.ai/library/story-writer/latest'),'utf8'));
const modelPart=manifest.layers.find(part=>part.mediaType==='application/vnd.ollama.image.model');
if(!modelPart||!/^sha256:[a-f0-9]{64}$/.test(modelPart.digest))throw Error('Story writer package is invalid.');
const modelFile=path.join(root,'models/story-writer/Qwen3.5-9B.gguf'),modelStat=fs.statSync(modelFile);
if(modelStat.size!==modelPart.size)throw Error('Story writer model is incomplete.');
const blobFile=path.join(packageRoot,'blobs',modelPart.digest.replace(':','-'));
let linked=false;try{linked=fs.statSync(blobFile).ino===modelStat.ino;}catch{}
if(!linked){if(fs.existsSync(blobFile))fs.unlinkSync(blobFile);fs.linkSync(modelFile,blobFile);}
const socket=net.createServer();await new Promise((resolve,reject)=>{socket.once('error',reject);socket.listen(0,'127.0.0.1',resolve);});
const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
const url='http://127.0.0.1:'+port;
fs.writeFileSync(path.join(work,'writer-endpoint.json'),JSON.stringify({port,pid:process.pid}));
const env={...process.env,OLLAMA_HOST:'127.0.0.1:'+port,OLLAMA_MODELS:path.join(root,'models/story-writer/ollama'),OLLAMA_KEEP_ALIVE:'0',OLLAMA_MAX_LOADED_MODELS:'1',OLLAMA_NUM_PARALLEL:'1',OLLAMA_CONTEXT_LENGTH:'8192',OLLAMA_VULKAN:'1',OLLAMA_NO_CLOUD:'1'};
const guard=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'app/writer-host.ps1'),'-WriterExe',path.join(root,'runtime/ollama/ollama.exe'),'-WriterParentId',String(process.pid),'-WriterLog',log],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let guardError='',closed=false;guard.stdout.on('data',b=>guardError=(guardError+b).slice(-3000));guard.stderr.on('data',b=>guardError=(guardError+b).slice(-3000));guard.on('error',e=>guardError=e.message);guard.on('close',()=>closed=true);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function call(route,body,timeout=3000){const response=await fetch(url+route,{...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(timeout)});const data=await response.json();if(!response.ok)throw Error(data.error||'Writer request failed.');return data;}
try{
 let ready=false;const startup=Date.now();
 while(Date.now()-startup<45000){if(closed)throw Error('Story writer did not start: '+guardError);if(fs.existsSync(log+'.host.json')){try{await call('/api/version');ready=true;break;}catch{}}await pause(250);}
 if(!ready)throw Error('Story writer startup timed out.');
 const body={model:'story-writer:latest',prompt:fs.readFileSync(options.promptFile,'utf8'),system:options.system,format:JSON.parse(fs.readFileSync(options.schemaFile,'utf8')),stream:false,think:false,keep_alive:0,options:{seed:options.seed,num_ctx:8192,num_predict:options.numPredict??1024,temperature:options.temperature??0.7,top_p:0.8,top_k:20,min_p:0,presence_penalty:options.presencePenalty??1.5,repeat_penalty:1}};
 fs.writeFileSync(path.join(work,'writer-request.json'),JSON.stringify(body,null,2));
 const reply=await call('/api/generate',body,210000);
 fs.writeFileSync(path.join(work,'writer-result.json'),JSON.stringify(reply,null,2));
 if(!reply.done||!reply.response||reply.done_reason==='length')throw Error('Story writer response was incomplete.');
 const deadline=Date.now()+10000;let unloaded=false;
 while(Date.now()<deadline){if(!(await call('/api/ps')).models?.length){unloaded=true;break;}await pause(200);}
 if(!unloaded)throw Error('Story writer did not release its model.');
 fs.writeFileSync(path.join(work,'writer-unloaded.json'),JSON.stringify({unloaded:true,at:new Date().toISOString(),port}));
 process.stdout.write(reply.response);
}catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
finally{
 fs.writeFileSync(log+'.stop','stop');
 if(!closed)await new Promise(resolve=>{const timer=setTimeout(resolve,7000);guard.once('close',()=>{clearTimeout(timer);resolve();});});
 if(!closed){guard.kill();guard.stdout.destroy();guard.stderr.destroy();guard.unref();}
}
