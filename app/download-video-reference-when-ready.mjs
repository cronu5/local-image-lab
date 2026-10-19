import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),marker=path.join(root,'logs/video-reference-download-wait.lock');
if(fs.existsSync(marker)){try{const previous=JSON.parse(fs.readFileSync(marker));process.kill(previous.pid,0);process.exit(0);}catch{fs.unlinkSync(marker);}}
fs.writeFileSync(marker,JSON.stringify({pid:process.pid}),{flag:'wx'});
try{
 for(;;){let ready=false;try{ready=JSON.parse(fs.readFileSync(path.join(root,'logs/video-downloads-verified.json'))).complete===true;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,15000));}
 await import('./download-video-reference-model.mjs');
}finally{try{if(JSON.parse(fs.readFileSync(marker)).pid===process.pid)fs.unlinkSync(marker);}catch{}}
