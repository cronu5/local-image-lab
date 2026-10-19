import {randomInt} from 'node:crypto';

export const VIDEO_DEFAULTS={steps:20,cfgScale:1,flowShift:12,sampler:'euler',scheduler:'simple',eta:1,negativePrompt:'',seedMode:'fixed',continuationStyle:'blank',directorBrief:'',storyArc:true,storyIntensity:'standard',plantedThought:''};
export const VIDEO_SAMPLERS=['euler','euler_a','heun','dpm++2m'];
export const VIDEO_SCHEDULERS=['simple','sgm_uniform','karras','exponential'];
const seedLimit=2147483648;
const fail=message=>{throw Object.assign(Error(message),{status:400});};
export function validateClipSettings(data,{partial=false}={}){
 if(!data||typeof data!=='object'||Array.isArray(data))fail('Invalid clip settings.');
 const allowed=['prompt','blankPrompt','steps','cfgScale','flowShift','sampler','scheduler','eta','negativePrompt','seedMode','seed','continuationStyle','directorBrief','storyArc','storyIntensity','plantedThought'];
 if(partial)for(const key of Object.keys(data))if(!allowed.includes(key))fail('This setting cannot change during a run: '+key+'.');
 const result={};
 for(const key of allowed){
  if(partial&&!Object.hasOwn(data,key))continue;
  const value=data[key]??({prompt:'',blankPrompt:false,seed:-1,...VIDEO_DEFAULTS}[key]);
  if(key==='plantedThought'){
   if(typeof value!=='string'||value.length>200)fail('Keep the planted thought under 200 characters.');result[key]=value.trim();
  }else if(['prompt','negativePrompt','directorBrief'].includes(key)){
   if(typeof value!=='string'||value.length>7000)fail('Keep each prompt under 7,000 characters.');result[key]=value.trim();
  }else if(key==='blankPrompt'||key==='storyArc'){
   if(typeof value!=='boolean')fail(key+' must be on or off.');result[key]=value;
  }else if(['seedMode','sampler','scheduler','continuationStyle','storyIntensity'].includes(key)){
   const choices=key==='storyIntensity'?['gentle','standard','bold']:key==='continuationStyle'?['blank','guided','custom']:key==='seedMode'?['fixed','random','increment']:key==='sampler'?VIDEO_SAMPLERS:VIDEO_SCHEDULERS;
   if(!choices.includes(value))fail('Choose an available '+key+'.');result[key]=value;
  }else{
   if(value===''||typeof value==='boolean'||!Number.isFinite(Number(value)))fail('Enter a number for '+key+'.');
   const number=Number(value),[min,max,integer]=({steps:[1,100,true],cfgScale:[1,10,false],flowShift:[1,30,false],eta:[0,1,false],seed:[-1,seedLimit-1,true]})[key];
   if(number<min||number>max||integer&&!Number.isInteger(number))fail(key+' must be '+(integer?'a whole number ':'')+'between '+min+' and '+max+'.');result[key]=number;
  }
 }
 return result;
}

export {storyPhase} from './public/video-timing.mjs';

// Each clip receives an immutable settings snapshot. Queued edits are consumed
// only at the following clip boundary, never during inference or export.
export function createClipController({settings,continuationPrompt='',randomSeed=()=>randomInt(seedLimit),restore=null}){
 const initial=restore?structuredClone(restore.initial):{...settings,seed:settings.seed===-1?randomSeed():settings.seed};
 let base=restore?structuredClone(restore.base):{...initial,prompt:continuationPrompt||initial.prompt},anchor=restore?.anchor||0,previousSeed=restore?.previousSeed??null,pending=restore?.pending?structuredClone(restore.pending):null;
 const changes=structuredClone(restore?.changes||[]);
 function chooseRandom(){const value=randomSeed();return value===previousSeed?(value+1)%seedLimit:value;}
 return {
  initial,
  get nextSettings(){return {...base};},
  get pending(){return pending?structuredClone(pending):null;},
  get changes(){return structuredClone(changes);},
  snapshot(){return structuredClone({initial,base,anchor,previousSeed,pending,changes});},
  queue(patch,scope,clipIndex){
   if(!['next','rest'].includes(scope))fail('Choose Next clip only or Rest of this run.');
   const clean=validateClipSettings(patch,{partial:true});if(!Object.keys(clean).length)fail('Change a setting before applying.');
   const candidate={...base,...clean};if(candidate.continuationStyle==='custom'&&!candidate.prompt)fail('Enter a custom continuation prompt, or choose Image only.');
   pending={settings:clean,scope,clipIndex,queuedAt:new Date().toISOString()};return this.pending;
  },
  clear(){pending=null;},
  take(index){
   let selected=index===0?{...initial}:{...base},clipAnchor=anchor;
   if(pending){
    const edit=pending;pending=null;selected={...selected,...edit.settings};
    if(Object.hasOwn(edit.settings,'seed')||Object.hasOwn(edit.settings,'seedMode'))clipAnchor=index;
    if(selected.seed===-1)selected.seed=chooseRandom();
    if(edit.scope==='rest'){base={...selected};anchor=clipAnchor;}
    changes.push({...edit,clipIndex:index+1,appliedAt:new Date().toISOString()});
   }
   if(selected.seed===-1)selected.seed=chooseRandom();
   const seed=selected.seedMode==='random'&&index>0?chooseRandom():selected.seedMode==='increment'?(selected.seed+index-clipAnchor)%seedLimit:selected.seed;
   previousSeed=seed;
   if(index>0)selected.blankPrompt=selected.continuationStyle==='blank';
   return {...selected,seed,prompt:selected.blankPrompt||index>0&&selected.continuationStyle==='guided'?'':selected.prompt,negativePrompt:selected.blankPrompt||selected.cfgScale===1?'':selected.negativePrompt};
  }
 };
}

// Old saved runs did not include the controller snapshot. Rebuild their base
// from the original settings and applied edits; observed clip seeds stay intact.
export function controllerStateFromSession(session){
 if(session.controllerState){const saved=structuredClone(session.controllerState);saved.initial=validateClipSettings(saved.initial);saved.base=validateClipSettings(saved.base);return saved;}
 const first=session.clips[0],initial=validateClipSettings({...first?.generationSettings,...session,prompt:session.prompt||'',blankPrompt:!!session.blankPrompt});
 let base={...initial,prompt:session.continuationPrompt||initial.prompt},anchor=0;
 const changes=structuredClone(session.settingsChanges||[]);
 for(const change of changes){
  if(change.scope!=='rest')continue;
  base={...base,...validateClipSettings(change.settings,{partial:true})};
  if(Object.hasOwn(change.settings,'seed')||Object.hasOwn(change.settings,'seedMode'))anchor=change.clipIndex-1;
  if(base.seed===-1)base.seed=session.clips.find(c=>c.clipIndex===change.clipIndex)?.seed??initial.seed;
 }
 if(session.nextSettings)base={...base,...validateClipSettings(session.nextSettings)};
 return {initial,base,anchor,previousSeed:session.clips.at(-1)?.seed??null,pending:session.pendingUpdate||null,changes};
}

export function validateSceneCount(value,min=1){
 if(typeof value==='boolean'||value===''||value==null||!Number.isInteger(Number(value))||Number(value)<min||Number(value)>2000)fail('Choose a whole number from '+min+' to 2,000 scenes. The current clip must be kept.');
 return Number(value);
}
