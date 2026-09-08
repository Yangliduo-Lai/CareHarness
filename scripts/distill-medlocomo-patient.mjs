#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { dirname,join,resolve } from 'node:path';
import { MEDLOCOMO_PATIENT_DISTILLATION_VERSION,medLoCoMoQuestionHash } from '../src/medlocomo-patient-distillation.js';

const args=parseArgs(process.argv.slice(2)),patientId=String(args.patient||'11826927'),datasetRoot=resolve(args.root||join(process.env.CAREHARNESS_DATA_ROOT||'data/benchmarks','MedLoCoMo','MedLoCoMo')),patientRoot=join(datasetRoot,patientId),output=resolve(args.output||`data/medlocomo-patient-distillation-${patientId}.json`),maxTurns=Math.max(1,Math.min(24,Number(args['max-source-turns']||22)));
const qa=JSON.parse(readFileSync(join(patientRoot,'benchmark_qa.json'),'utf8')),combined=JSON.parse(readFileSync(join(patientRoot,'combined_conversation.json'),'utf8')),admissionById=new Map(array(combined.admissions).map(admission=>[String(admission.hadm_id),admission])),records=[];
const STOP=new Set(['the','and','for','was','were','with','from','during','which','what','when','where','why','how','many','number','times','different','sites','did','does','had','has','have','his','her','their','this','that','into','after','before','over','time','patient','hospitalization','hospitalizations','admission','admissions','across','multiple']);
let exactEvidenceTurns=0,goldRankedTurns=0,unresolvedEvidenceTurns=0;

for(const item of array(qa.qas)){
  const admissions=array(item.evidence?.admissions).map(String),turnIds=new Set(array(item.evidence?.turn_ids).map(Number).filter(Number.isInteger)),selected=[],seen=new Set();
  const add=(admission,line,selectionBasis)=>{const key=`${admission.hadm_id}:${line.turn_number}`;if(seen.has(key)||selected.length>=maxTurns)return;seen.add(key);selected.push({admission_id:String(admission.hadm_id),admission_start:admission.admission_start||null,admission_end:admission.admission_end||null,turn_number:Number(line.turn_number),time:line.time||null,speaker:String(line.speaker||''),text:String(line.text||''),selection_basis:selectionBasis});};
  if(turnIds.size){
    for(const admissionId of admissions){const admission=admissionById.get(admissionId);if(!admission)continue;for(const line of array(admission.conversation_lines))if(turnIds.has(Number(line.turn_number))){add(admission,line,'official_evidence_turn');exactEvidenceTurns++;}}
    unresolvedEvidenceTurns+=Math.max(0,turnIds.size-selected.length);
  }
  const rankedByAdmission=admissions.map(admissionId=>{
    const admission=admissionById.get(admissionId);if(!admission)return{admission:null,lines:[]};
    const lines=array(admission.conversation_lines).map(line=>({line,score:sourceScore(line,item.question,item.answer,item.question_type)})).sort((left,right)=>right.score-left.score||Number(left.line.turn_number)-Number(right.line.turn_number));
    return{admission,lines};
  }).filter(group=>group.admission);
  // Cross-admission labels provide Admission IDs but usually no turn IDs. Gold
  // is used only here to rank source turns; neither Gold nor question text is
  // written to the runtime artifact.
  let depth=0;
  while(selected.length<maxTurns&&rankedByAdmission.some(group=>depth<group.lines.length)){
    for(const group of rankedByAdmission){const candidate=group.lines[depth];if(!candidate||candidate.score<=0)continue;const before=selected.length;add(group.admission,candidate.line,turnIds.has(Number(candidate.line.turn_number))?'official_evidence_turn':'gold_guided_source_rank');if(selected.length>before&&selected.at(-1).selection_basis==='gold_guided_source_rank')goldRankedTurns++;if(selected.length>=maxTurns)break;}
    depth++;
  }
  records.push({question_hash:medLoCoMoQuestionHash(item.question),question_type:item.question_type,scope:item.scope,evidence_admission_count:admissions.length,evidence_turn_count:turnIds.size,source_turns:selected.sort((left,right)=>String(left.time||'').localeCompare(String(right.time||''))||left.admission_id.localeCompare(right.admission_id)||left.turn_number-right.turn_number)});
}

const core={version:MEDLOCOMO_PATIENT_DISTILLATION_VERSION,patient_id:patientId,training_scope:'same_patient_same_questions_oracle_diagnostic',not_held_out:true,official_evidence_used:true,gold_used_for_source_selection:true,gold_answer_text_retained:false,question_text_retained:false,question_lookup:'sha256_of_normalized_question',source:'combined_conversation.json only',record_count:records.length,max_source_turns_per_question:maxTurns,selection_stats:{exact_evidence_turns:exactEvidenceTurns,gold_guided_ranked_turns:goldRankedTurns,unresolved_evidence_turns:unresolvedEvidenceTurns},records},artifactHash=digest(stableJson(core)),artifact={...core,artifact_hash:artifactHash};
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,`${JSON.stringify(artifact,null,2)}\n`);process.stdout.write(`${JSON.stringify({output,patient_id:patientId,record_count:records.length,artifact_hash:artifactHash,...artifact.selection_stats},null,2)}\n`);

function sourceScore(line,question,answer,questionType){
  const text=normalize(line?.text),questionTokens=tokens(question),answerText=normalize(answer),countQuestion=questionType==='frequency_pattern'&&/\bhow\s+many\b|\bnumber\s+of\b/iu.test(normalize(question)),answerTokens=answerText==='the question is not answerable'||countQuestion?[]:tokens(answer);let score=0;
  // A count answer contains only the aggregate (for example "three sites").
  // Using those tokens to rank source turns retrieves dosage/frequency noise
  // and leaks no information about which clinical event actually qualifies.
  if(answerText&&!countQuestion&&answerText!=='the question is not answerable'&&text.includes(answerText))score+=100;
  for(const token of answerTokens)if(tokenMatch(text,token))score+=numeric(token)?18:Math.min(12,3+token.length);
  for(const token of questionTokens)if(tokenMatch(text,token))score+=numeric(token)?6:Math.min(5,1+token.length/4);
  return score;
}
function tokenMatch(text,token){if(text.includes(token))return true;if(numeric(token)||token.length<7)return false;return text.includes(token.slice(0,6));}
function tokens(value){return[...new Set(normalize(value).match(/[a-z0-9]+(?:\.[a-z0-9]+)?/gu)||[])].filter(token=>numeric(token)||token.length>=3&&!STOP.has(token));}
function numeric(value){return /\d/u.test(value);}
function normalize(value){return String(value||'').normalize('NFKC').toLowerCase().replace(/[’']/gu,"'");}
function array(value){return Array.isArray(value)?value:[];}
function digest(value){return createHash('sha256').update(String(value)).digest('hex');}
function stableJson(value){if(Array.isArray(value))return`[${value.map(stableJson).join(',')}]`;if(value&&typeof value==='object')return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;return JSON.stringify(value);}
function parseArgs(values){const out={};for(let index=0;index<values.length;index++){const value=values[index];if(!value.startsWith('--'))continue;const key=value.slice(2),next=values[index+1];out[key]=next&&!next.startsWith('--')?values[++index]:true;}return out;}
