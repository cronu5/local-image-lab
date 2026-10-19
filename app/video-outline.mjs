import {randomInt} from 'node:crypto';

// Story outline: before scene 1 the story writer turns the user's idea, or a random theme, into a
// plot with five checkpoints pinned to points in the movie. Each scene sees only the checkpoint it
// is working toward and the ones already done, never the ones still to come, so the planner has
// a target without re-running the same instruction once it has happened.
const THEMES=[
 'a lore-heavy dark fantasy','a cyberpunk noir','a cosmic horror','a heist thriller','a survival thriller',
 'a mythic quest','a post-apocalyptic road movie','a space opera','a samurai revenge tale','a haunted house horror',
 'a giant monster disaster movie','a fairy tale gone wrong','a western showdown','a deep-sea mystery','a time-loop mystery',
 'a superhero origin story','a spy thriller','a zombie outbreak','a pirate adventure','an ancient tomb curse',
 'an alien first-contact story','a surreal dream-world journey','a viking saga','a steampunk adventure','a jungle expedition',
 'a gothic vampire tale','a robot uprising','a wizard duel','a lost-civilisation discovery','a creature feature in the snow'
];
export const randomTheme=()=>THEMES[randomInt(THEMES.length)];
export const OUTLINE_MODES=['off','idea','random'];
const POINTS=[0,0.25,0.5,0.75,1];

// Due scene for each checkpoint: the opening is scene 1, the ending is the last scene, the rest are spread evenly.
export function scheduleOutline(outline,totalClips){
 let previous=0;
 const checkpoints=outline.checkpoints.slice(0,POINTS.length).map((c,i,all)=>{
  const due=i===0?1:i===all.length-1?totalClips:Math.min(totalClips-(all.length-1-i),Math.max(previous+1,Math.round(POINTS[i]*totalClips)));
  previous=due;return {...c,due,status:'open'};
 });
 return {...outline,totalClips,checkpoints};
}

export const currentCheckpoint=outline=>outline?.checkpoints.find(c=>c.status==='open'||c.status==='started')||null;

// After a scene is reviewed: the opening is done once scene 1 exists; later checkpoints are done when
// the check says so, or once their slot has passed, so the story keeps pace instead of stalling.
export function advanceOutline(outline,scene,verdict){
 if(!outline)return outline;
 const checkpoints=outline.checkpoints.map(c=>({...c}));
 const c=checkpoints.find(x=>x.status==='open'||x.status==='started');if(!c)return outline;
 const happened=verdict?.happened;
 if(checkpoints.indexOf(c)===0||happened==='yes'||happened==='partly'&&scene>=c.due){c.status='done';c.doneAt=scene;c.evidence=verdict?.evidence||null;}
 else if(scene>c.due){c.status='skipped';c.doneAt=scene;}
 else if(happened==='partly')c.status='started';
 return {...outline,checkpoints};
}

const describe=outline=>[
 'STORY OUTLINE (written before filming; follow it, but what the footage actually shows always wins):',
 'Logline: '+outline.logline,'World: '+outline.world,
 'Main character (use this exact look every time they appear): '+outline.hero,
 'Key locations, in story order: '+outline.locations.join(' | ')
].join('\n');

// What the planner of scene `scene` is told.
export function outlineInstruction(outline,scene){
 if(!outline)return '';
 const done=outline.checkpoints.filter(c=>c.status==='done'||c.status==='skipped');
 const c=currentCheckpoint(outline),index=c?outline.checkpoints.indexOf(c)+1:0;
 const lines=[describe(outline)];
 if(done.length)lines.push('ALREADY HAPPENED (build on these and show their consequences; never stage them again): '+done.map(d=>d.name+(d.status==='skipped'?' (passed without a clear moment; treat it as behind us)':': '+d.goal)).join(' | '));
 // The first shot sets the hero's look for the whole film; in the overnight test the opening said only "the hero".
 if(scene===1)lines.push('This is the first shot: write the main character\'s full look from the outline into the prompt, word for word, so the video model draws them that way for the whole film.');
 if(!c)lines.push('Every story checkpoint is complete. Follow the ending pacing.');
 else{
  lines.push(`CURRENT STORY CHECKPOINT (${index} of ${outline.checkpoints.length}, "${c.name}"): ${c.goal}`);
  lines.push(scene>=c.due?'It must visibly happen in THIS scene. Show this checkpoint\'s event itself; do not run ahead into later story events.'
   :c.status==='started'?`It has begun. Move it forward and complete it by scene ${c.due} (this is scene ${scene}).`
   :scene===c.due-1?`It is due by scene ${c.due} (this is scene ${scene}): it can happen now, or this scene can bring it right to the edge.`
   :`It is due around scene ${c.due} (this is scene ${scene}). Build toward it: set it up or move closer, but save the event itself for then, and do not stall.`);
  lines.push('Later checkpoints exist but are hidden. Do not jump ahead to them or invent the ending early.');
 }
 return lines.join('\n');
}

export const checkpointDueNow=(outline,scene)=>{const c=currentCheckpoint(outline);return !!c&&scene>=c.due;};
