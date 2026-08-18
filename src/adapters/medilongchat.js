import { BenchmarkAdapter,pjoin } from './base.js';
import { benchmarkAnswerContract } from '../prompts.js';
import { scoreMediLongChat } from '../medilongchat-metrics.js';

export class MediLongChatAdapter extends BenchmarkAdapter{
  constructor(root){super(pjoin(root,'MediLongChat'));this.name='medilongchat';}
  catalog(){
    const path=pjoin(this.root,'dataset.json');if(!this.exists(path))return{benchmark:this.name,path:this.root,available:false,sample_count:0,patients:[],release_has_official_task_annotations:false};
    const records=this.json(path),patients=records.map((record,index)=>({id:String(record.personal_info?.Patient_id||`Patient ${index+1}`),index:index+1,encounters:record.chat_history?.length||0}));
    return{benchmark:this.name,path:this.root,available:true,sample_count:records.length,patients,task_types:['in_dialogue_reasoning','cross_dialogue_reasoning','synthesis_reasoning'],release_has_official_task_annotations:false,protocol_status:'public_release_derived',visible_boundary:'The public repository currently releases dataset.json but not the paper task annotations. Studio questions are deterministic, corpus-derived diagnostics and are not directly comparable with Table 6.'};
  }
  load(config={}){
    const records=this.json(pjoin(this.root,'dataset.json')),record=selectPatient(records,config),patientId=String(record.personal_info?.Patient_id||`Patient ${Number(config.patient_index)||1}`),subjectId=`medilongchat-${patientId.toLowerCase().replace(/\s+/g,'-')}`,history=[...(record.chat_history||[])].sort((a,b)=>dateValue(a.date)-dateValue(b.date)),observations=[];
    for(let index=0;index<history.length;index++){const encounter=history[index],episode=`encounter-${index+1}`,eventTime=cleanPrefix(encounter.date,'Date:'),turns=(encounter.dialogue||[]).map((line,turn)=>{const match=String(line).match(/^\s*(Patient|Doctor)\s*:\s*([\s\S]*)$/i);return{subject_id:subjectId,source_type:match?.[1].toLowerCase()==='doctor'?'doctor':'patient',episode_id:episode,turn_id:String(turn+1),event_time:eventTime||null,raw_text:String(match?.[2]||line).trim()};}).filter(item=>item.raw_text);if(turns.length)observations.push(this.sessionObservation(turns));}
    return{sample_id:patientId,subject_id:subjectId,observations,encounters:history.map((item,index)=>({episode_id:`encounter-${index+1}`,date:cleanPrefix(item.date,'Date:'),location:cleanPrefix(item.location,'Location:'),medical_record:item.medical_record,turn_count:item.dialogue?.length||0})),record,protocol_status:'public_release_derived',official_comparable:false,visibility:{visible:['chat_history.dialogue','encounter dates and locations contained in derived questions'],hidden_from_answer:['Adjusted Diagnosis Considering History until used as derived SR gold','derived reference answers'],warning:'Official IDR/CDR/SR annotations described by the paper are not present in the public repository snapshot.'}};
  }
  cases(data,config={}){
    const requested=String(config.task_type||'all'),items=derivedCases(data);return items.filter(item=>requested==='all'||item.task===requested);
  }
  normalizeAnswer(value){return String(value||'').trim();}
  compatibleScore(output,_golds,item={}){return scoreMediLongChat(output,item);}
}

function derivedCases(data){
  const encounters=data.encounters||[],out=[];
  for(let index=0;index<encounters.length;index++){const item=encounters[index],facet=index%3===0?'date':index%3===1?'location':'medical_record',gold=facet==='date'?item.date:facet==='location'?item.location:item.medical_record,question=facet==='date'?`When did the encounter about "${item.medical_record}" take place?`:facet==='location'?`Where did the encounter about "${item.medical_record}" take place?`:`What medical event was documented at ${item.date}?`;out.push({score_id:`${data.sample_id}-idr-${index+1}-${facet}`,task:'in_dialogue_reasoning',question,gold:[gold],metadata:{answer_contract:benchmarkAnswerContract('medilongchat','in_dialogue_reasoning'),visible_episode_ids:[item.episode_id],scope:'single_encounter',long_term:false,protocol_status:'public_release_derived',official_comparable:false,official_evaluation:{benchmark:'medilongchat',metric:'release-derived F1 + BLEU-1'}}});}
  if(encounters.length>=2){const first=encounters[0],last=encounters.at(-1);out.push({score_id:`${data.sample_id}-cdr-1`,task:'cross_dialogue_reasoning',question:`Which documented event happened earlier: "${first.medical_record}" or "${last.medical_record}"?`,gold:[first.medical_record],metadata:{answer_contract:benchmarkAnswerContract('medilongchat','cross_dialogue_reasoning'),scope:'cross_encounter',long_term:true,protocol_status:'public_release_derived',official_comparable:false,official_evaluation:{benchmark:'medilongchat',metric:'release-derived F1 + BLEU-1'}}});}
  const diagnosis=String(data.record?.['Adjusted Diagnosis Considering History']||'').trim(),symptoms=String(data.record?.['Current Symptoms']||'').trim();if(diagnosis){const distractors=derivedDistractors(data.record,diagnosis),options=shuffleStable([diagnosis,...distractors]).slice(0,4),correct=String.fromCharCode(65+options.indexOf(diagnosis)),optionText=options.map((value,index)=>`${String.fromCharCode(65+index)}. ${value}`).join('\n');out.push({score_id:`${data.sample_id}-sr-1`,task:'synthesis_reasoning',question:`Current symptoms: ${symptoms}\nConsidering the complete longitudinal history, which diagnosis is most likely?\n${optionText}`,gold:[correct],metadata:{answer_contract:benchmarkAnswerContract('medilongchat','synthesis_reasoning'),correct_option:correct,scope:'complete_history',long_term:true,protocol_status:'public_release_derived',official_comparable:false,official_evaluation:{benchmark:'medilongchat',metric:'release-derived accuracy'}}});}
  return out;
}
function derivedDistractors(record,diagnosis){return [...new Set([record?.['Initial Diagnosis'],'Further clinical assessment required','A benign self-limited condition','No diagnosis supported'].map(String).map(value=>value.trim()).filter(value=>value&&value!==diagnosis))].slice(0,3);}
function shuffleStable(values){return values.map(value=>({value,key:[...value].reduce((n,char)=>((n*33)^char.codePointAt(0))>>>0,5381)})).sort((a,b)=>a.key-b.key||a.value.localeCompare(b.value)).map(item=>item.value);}
function selectPatient(records,config){const wanted=String(config.patient_id||'').trim();if(wanted){const match=records.find(item=>String(item.personal_info?.Patient_id||'')===wanted);if(match)return match;}const index=Math.max(1,Number(config.patient_index)||1)-1;if(!records[index])throw new Error(`MediLongChat patient index ${index+1} is unavailable`);return records[index];}
function cleanPrefix(value,prefix){return String(value||'').replace(new RegExp(`^\\s*${prefix.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\s*`,'i'),'').trim();}
function dateValue(value){const parsed=Date.parse(cleanPrefix(value,'Date:'));return Number.isFinite(parsed)?parsed:Number.MAX_SAFE_INTEGER;}
