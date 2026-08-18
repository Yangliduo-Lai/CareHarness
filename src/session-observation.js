const ROLE_LABELS={patient:'Patient',doctor:'Doctor',structured:'Structured'};
const TRANSCRIPT_HEADER=/^\[Turn=([^\]\n]+)\]\[Role=(Patient|Doctor|Structured)\](?:\[Time=([^\]\n]+)\])?\n/gm;

export function makeSessionObservation(turns,{turn_id='session'}={}){
  if(!Array.isArray(turns)||!turns.length)throw new Error('session observation requires at least one turn');
  const first=turns[0],subjectId=first.subject_id,episodeId=first.episode_id;
  if(turns.some(item=>item.subject_id!==subjectId||item.episode_id!==episodeId))throw new Error('session observation turns must share subject_id and episode_id');
  const raw_text=turns.map((item,index)=>{
    const role=ROLE_LABELS[item.source_type];
    if(!role)throw new Error(`unsupported session turn source_type: ${item.source_type}`);
    const originalTurn=safeMarker(item.turn_id??index+1),time=item.event_time?`[Time=${safeMarker(item.event_time)}]`:'';
    return `[Turn=${originalTurn}][Role=${role}]${time}\n${String(item.raw_text||'').trim()}`;
  }).join('\n\n');
  return{subject_id:subjectId,source_type:'structured',episode_id:episodeId,turn_id,event_time:first.event_time||null,raw_text};
}

export function groupSessionObservations(observations){
  if(!Array.isArray(observations))throw new Error('observations must be an array');
  const groups=[],byKey=new Map();
  for(const item of observations){
    const key=`${item.subject_id}\u0000${item.episode_id}`;
    let group=byKey.get(key);
    if(!group){group=[];byKey.set(key,group);groups.push(group);}
    group.push(item);
  }
  return groups.map(group=>group.length===1&&group[0].source_type==='structured'&&isSessionTranscript(group[0].raw_text)?group[0]:makeSessionObservation(group));
}

export function transcriptBlocks(rawText){
  const text=String(rawText||''),headers=[...text.matchAll(TRANSCRIPT_HEADER)];
  return headers.map((match,index)=>{
    const content_start=match.index+match[0].length,next=headers[index+1];
    let content_end=next?next.index:text.length;
    while(content_end>content_start&&/\s/u.test(text[content_end-1]))content_end--;
    return{header_start:match.index,content_start,content_end,source_type:roleSource(match[2]),turn_id:match[1],event_time:match[3]||null};
  });
}

export function transcriptContextForSpan(rawText,start,end){
  const block=transcriptBlocks(rawText).find(item=>start>=item.header_start&&start<item.content_end);
  if(!block)return null;
  return{...block,crosses_turn_boundary:end>block.content_end};
}

export function isSessionTranscript(rawText){return transcriptBlocks(rawText).length>0;}

function roleSource(role){return role==='Patient'?'patient':role==='Doctor'?'doctor':'structured';}
function safeMarker(value){return String(value).replace(/[\]\r\n]/gu,'_');}
