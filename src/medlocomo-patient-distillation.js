import { createHash } from 'node:crypto';
import { existsSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const MEDLOCOMO_PATIENT_DISTILLATION_VERSION='medlocomo-patient-evidence-distillation.v1';

const CACHE=new Map();

/**
 * Explicitly diagnostic, in-domain distillation support. The artifact is built
 * from one patient's own Gold/Evidence and must never be reported as held-out.
 * Runtime receives source conversation turns only; Gold answer text is not
 * retained in the artifact or passed to the policy/answer model.
 */
export function loadMedLoCoMoPatientDistillation({patient_id,path}={}){
  const patientId=String(patient_id||'').trim();
  if(!patientId)throw new Error('patient-distilled MedLoCoMo mode requires patient_id');
  const artifactPath=resolve(path||`data/medlocomo-patient-distillation-${patientId}.json`);
  if(!existsSync(artifactPath))throw new Error(`MedLoCoMo patient distillation artifact not found: ${artifactPath}`);
  const cached=CACHE.get(artifactPath);if(cached)return cached;
  const artifact=JSON.parse(readFileSync(artifactPath,'utf8'));
  if(artifact?.version!==MEDLOCOMO_PATIENT_DISTILLATION_VERSION)throw new Error(`Unsupported MedLoCoMo patient distillation version: ${artifact?.version||'<missing>'}`);
  if(String(artifact.patient_id)!==patientId)throw new Error(`Patient distillation artifact belongs to ${artifact.patient_id}, not ${patientId}`);
  if(artifact.gold_answer_text_retained!==false||artifact.gold_used_for_source_selection!==true||artifact.official_evidence_used!==true)throw new Error('Patient distillation artifact must declare its oracle training provenance');
  const records=new Map();
  for(const record of array(artifact.records)){
    const key=String(record?.question_hash||'');
    if(!/^[a-f0-9]{64}$/u.test(key)||records.has(key))throw new Error('Patient distillation artifact contains an invalid or duplicate question hash');
    records.set(key,record);
  }
  const loaded={artifact_path:artifactPath,artifact,records};CACHE.set(artifactPath,loaded);return loaded;
}

export function medLoCoMoPatientDistilledMemory(loaded,question){
  if(!loaded?.artifact||!(loaded.records instanceof Map))return null;
  const questionHash=medLoCoMoQuestionHash(question),record=loaded.records.get(questionHash);
  if(!record)return null;
  const patientId=String(loaded.artifact.patient_id),nodes=array(record.source_turns).map((turn,index)=>{
    const sourceText=String(turn.text||'').trim(),speaker=String(turn.speaker||'Doctor'),sourceType=speaker.toLowerCase()==='patient'?'patient':'doctor',memoryId=`distilled:${questionHash.slice(0,16)}:${String(index+1).padStart(2,'0')}`;
    return{memory_id:memoryId,observation_id:`distilled-observation:${questionHash.slice(0,16)}:${String(index+1).padStart(2,'0')}`,subject_id:`medlocomo-${patientId}`,text:sourceText,source_text:sourceText,span:[0,sourceText.length],support_unit_ids:[`turn:${turn.admission_id}:${turn.turn_number}`],construction_kind:'semantic',source_type:sourceType,episode_id:String(turn.admission_id),turn_id:String(turn.turn_number),event_time:turn.time||null,certainty:1,polarity:'affirmed',families:['PE'],factor_key:`distilled_source_turn:${turn.admission_id}:${turn.turn_number}`,factor_domains:['distilled_source_evidence'],status:'active',valid_from:turn.time||null,version:1,version_chain:[memoryId],predecessor_memory_id:null,successor_memory_id:null,conflicts_with_memory_id:null,operation:'ADD'};
  });
  return{version:loaded.artifact.version,patient_id:patientId,question_hash:questionHash,question_type:record.question_type,scope:record.scope,training_provenance:'same_patient_gold_guided_source_selection_not_held_out',gold_answer_text_retained:false,source_turn_count:nodes.length,memory_nodes:nodes,memory_edges:[]};
}

export function medLoCoMoQuestionHash(value){return createHash('sha256').update(normalizeQuestion(value)).digest('hex');}

function normalizeQuestion(value){return String(value||'').normalize('NFKC').trim().replace(/\s+/gu,' ').toLowerCase();}
function array(value){return Array.isArray(value)?value:[];}
