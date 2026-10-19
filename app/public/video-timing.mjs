export const FRAME_CHOICES=[56,124,192,243,345];
export function storyPhase({index,totalClips,storyArc}){
 if(!storyArc)return 'continuation';
 if(index===0)return totalClips===1?'opening-and-ending':'opening';
 if(totalClips!==null&&index===totalClips-1)return 'ending';
 if(totalClips>=3&&index===totalClips-2)return 'resolving';
 if(totalClips>=4&&index===totalClips-3)return 'preparing-finale';
 if(totalClips>2){
  const progress=(index+0.5)/totalClips;
  if(progress>=0.65)return 'converging';
  if(progress<0.25)return 'exploring';
  return 'developing';
 }
 return 'continuation';
}
export function endingBeat({index,totalClips,storyArc}){
 if(!storyArc||!Number.isInteger(totalClips))return null;
 return ({2:'prepare',1:'resolve',0:'finale'})[totalClips-index-1]||null;
}
// Past roughly 52 million frame-pixels, H3 buffers exceed this GPU's Vulkan allocation
// limit and the engine falls back to system memory. Measured on the RX 9070 XT:
// 512×288×345 (51M) runs at full speed (80 s/step); 1024×576×124 (73M) takes ~20 min/step;
// 768×448×243 (84M) and 1024×576×243 (143M) are similarly slow. Guided scenes stay >= 5.2 s.
// A Guided scene that still does not fit free GPU memory is retried at a shorter length.
const FAST_FRAME_PIXELS=52e6,SIZE_PIXELS={draft:512*288,standard:768*448,large:1024*576};
export const longestFrames=size=>Math.max(124,[...FRAME_CHOICES].reverse().find(f=>f*(SIZE_PIXELS[size]||SIZE_PIXELS.draft)<=FAST_FRAME_PIXELS)||124);
export function clipFramesFor({baseFrames,index,totalClips,endMode,settings,size}){
 if(settings.continuationStyle!=='guided')return baseFrames;
 const longest=longestFrames(size),normal=Math.min(longest,Math.max(124,baseFrames));
 if(!settings.storyArc||endMode!=='scenes')return normal;
 if(index===0||index===totalClips-1)return longest;
 const phase=storyPhase({index,totalClips,storyArc:true});
 const previous=storyPhase({index:index-1,totalClips,storyArc:true});
 return ['preparing-finale','resolving'].includes(phase)||phase!==previous&&['developing','converging'].includes(phase)?Math.min(longest,Math.max(normal,243)):normal;
}
export function sceneFrames({baseFrames,totalClips,endMode,settings,size,clips=[]}){
 if(totalClips===null)return null;
 return Array.from({length:totalClips},(_,index)=>clips[index]?.frames||clipFramesFor({baseFrames,index,totalClips,endMode,settings,size}));
}
export const joinedSeconds=frames=>(frames.reduce((n,f)=>n+f,0)-Math.max(0,frames.length-1))/24;
