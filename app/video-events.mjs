import {createHash} from 'node:crypto';

// Surprises: now and then the planner is handed a vague story event it must work into the next
// scene, so long runs keep moving instead of circling one place or one action. Events are
// deliberately open-ended; the planner decides what they mean for the subjects and setting.
// Some events have a follow-up ("then") that pays them off a few scenes later. While a
// follow-up is pending no new event is drawn, so surprises build on each other instead of piling up.
const card=(text,then)=>({text,then});
const DECK={
 common:[
  card('Someone or something unexpected arrives.'),
  card('An animal wanders in and gets involved.'),
  card('The weather or light changes suddenly, and it matters.'),
  card('Something the main subject relies on breaks, slips away or stops working.','The main subject improvises a fix or a replacement.'),
  card('A noise or movement nearby demands immediate attention.'),
  card('The current attempt suddenly works, in an unexpected way.'),
  card('The main subject notices something important that was there all along.'),
  card('The main subject gives up on what they are doing and heads somewhere new.'),
  card('A small accident creates a new problem.'),
  card('The ground, a structure or the surroundings shift or give way.'),
  card('Something falls, rolls or blows into the scene.'),
  card('The main subject finds something that changes their plan.'),
  card('The way forward is suddenly blocked.','A way around the blockage is found, at a cost.'),
  card('The main subject takes a risky shortcut.'),
  card('Something that was out of reach becomes reachable.'),
  card('The main subject is distracted by something tempting.'),
  card('Something the main subject expected to happen does not.'),
  card('The main subject discovers something about the place they are in.')
 ],
 uncommon:[
  card('A stranger appears and wants something.',"The stranger's real intentions become clear."),
  card('The main subject realises they are being followed or watched.','Whoever or whatever was following finally shows itself.'),
  card('A hidden way forward is revealed.'),
  card('Something from earlier in the film comes back, changed.'),
  card('The main subject is suddenly in a hurry and has to leave immediately.','The main subject arrives where they were rushing to, and finds out why it mattered.'),
  card('Something starts chasing the main subject.','The chase comes to a head: an escape, a hiding place or a confrontation.'),
  card('The main subject finds an unexpected solution using something nearby.'),
  card('Something big happens in the distance and changes everything.','The consequences of the distant event reach the main subject.'),
  card('The main subject does something impulsive and reckless.'),
  card("Another character's plans collide with the main subject's."),
  card('The main subject gets help from an unlikely source.'),
  card('Something valuable is lost, stolen or destroyed.','A chance appears to get back what was lost, or to replace it.'),
  card('A rival shows up, after the same thing as the main subject.'),
  card('The main subject has to choose between two ways forward.'),
  card('The main subject has to hide, fast.'),
  card('A vehicle, mount or ride becomes available.')
 ],
 rare:[
  card('The main subject suddenly decides they must go home right now and runs off.','The main subject reaches home, or what they think is home.'),
  card('Reality glitches for a moment: something in the scene behaves impossibly.','The glitch happens again, bigger.'),
  card('The main subject meets a double, a copy or a reflection that acts on its own.','The double makes its move.'),
  card('Everything goes dark for a moment; when it returns, something has changed.','The cause of the darkness is revealed.'),
  card('Gravity, time or scale stops behaving normally.'),
  card('A crowd, a swarm or a herd appears out of nowhere.'),
  card('The main subject is suddenly somewhere else entirely.'),
  card('An object comes to life.','The living object decides whose side it is on.'),
  card('Two things in the scene swap places.'),
  card('Something enormous moves in the background.')
 ],
 strange:[
  card('Something absurd that has no business being here interrupts everything.'),
  card('The main subject transforms in some way.','The transformation changes what the main subject can do.'),
  card('The camera reveals the whole scene is not what it seemed.'),
  card('The world itself reacts to the main subject, as if it were alive.'),
  card('Everything freezes except the main subject.'),
  card('The main subject briefly sees the scene from somewhere impossible.')
 ],
 // Chaos only.
 dark:[
  card('Something sinister is revealed about this place.','The main subject uncovers the source of the sinister presence.'),
  card('A threat appears, and the main subject must fight or flee.','The fight or escape is decided.'),
  card('Something grotesque or unsettling emerges.'),
  card('Violent destruction erupts nearby.'),
  card('The main subject is hurt or loses something important.'),
  card('Something is hunting the main subject.','The hunter strikes.'),
  card('The main subject does something cruel or shocking.'),
  card('Whatever was safe is suddenly deadly.'),
  card('The main subject is trapped.','A desperate way out appears.'),
  card('Someone the main subject trusted turns on them.')
 ]
};
// chance: odds of an event before a scene. gap: fewest scenes from one event to the next.
// weights: how often each tier is drawn.
const LEVELS={
 some:{chance:0.22,gap:3,weights:{common:68,uncommon:25,rare:6,strange:1}},
 often:{chance:0.35,gap:2,weights:{common:56,uncommon:31,rare:10,strange:3}},
 chaos:{chance:0.5,gap:2,weights:{common:24,uncommon:28,rare:16,strange:12,dark:20}}
};
export const STORY_EVENT_LEVELS=['off',...Object.keys(LEVELS)];
// Odds rise this much when the last few scenes barely changed.
const STALL_BOOST=0.35;
// A follow-up lands 2 to 5 scenes after its event: possible from 2, certain by 4.
const FOLLOW_UP={first:2,certain:4,last:5};

// Seeded by run and scene, so a resumed run draws the same event.
const roll=(runId,scene,salt)=>createHash('sha256').update(['story-event',runId,scene,salt].join(':')).digest().readUInt32LE(0)/2**32;

// history: earlier events of this run, oldest first. stalled: recent scenes barely changed.
export function drawStoryEvent({level='some',runId,context,history=[],stalled=false}){
 const config=LEVELS[level],scene=context.clipIndex,remaining=context.scenesRemaining;
 if(!config||!scene||scene<3||['title','opening','opening-and-ending'].includes(context.phase))return null;
 const last=history.at(-1),since=last?scene-last.scene:Infinity;
 // A pending follow-up blocks new events. It may still land in the run-up to the ending,
 // because paying off an earlier surprise helps the ending; only the final two scenes stay clear.
 if(last?.then&&since<=FOLLOW_UP.last){
  if(since<FOLLOW_UP.first||remaining!=null&&remaining<=1)return null;
  const odds=since>=FOLLOW_UP.certain?1:0.5;
  return roll(runId,scene,'follow-up')<odds?{scene,tier:'follow-up',text:last.then,after:last.text}:null;
 }
 // New surprises stay out of the final three scenes so the ending can land.
 if(remaining!=null&&remaining<=2||since<config.gap)return null;
 if(roll(runId,scene,'chance')>=Math.min(0.85,config.chance+(stalled?STALL_BOOST:0)))return null;
 const tiers=Object.entries(config.weights),total=tiers.reduce((n,[,w])=>n+w,0);
 let pick=roll(runId,scene,'tier')*total,tier=tiers.at(-1)[0];
 for(const [name,weight] of tiers){if(pick<weight){tier=name;break;}pick-=weight;}
 const chosen=DECK[tier][Math.floor(roll(runId,scene,'card')*DECK[tier].length)];
 return {scene,tier,text:chosen.text,...(chosen.then?{then:chosen.then}:{}),stalled};
}

export function eventInstruction(event){
 if(!event)return '';
 const payoff=event.tier==='follow-up'?' It pays off an earlier event in this film: '+JSON.stringify(event.after)+' Connect the two clearly.':'';
 return 'STORY EVENT, IT MUST HAPPEN IN THIS SCENE: '+JSON.stringify(event.text)+payoff+' This is deliberately vague. Decide what it means for these exact subjects, this place and the story so far, make it clearly visible within this clip, and let it change where the story goes next rather than undoing it. Keep it to one clear, filmable event. For this scene it overrides the usual preference for calm, low-conflict steps; user direction still applies.';
}
