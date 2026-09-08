import { randomInt } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { adapters } from '../src/adapters/index.js';

const sourceExperimentId=process.argv[2];
if(!sourceExperimentId)throw new Error('Usage: node scripts/queue-medlocomo-random-patients.mjs <source-experiment-id> [server-base-url] [count]');
const serverBase=String(process.argv[3]||'http://127.0.0.1:8767').replace(/\/$/u,'');
const count=Math.max(1,Number(process.argv[4]||2));
const database=process.env.CAREHARNESS_DB_PATH||resolve('data/careharness.sqlite');
const output=resolve('reports',`medlocomo-auto-queue-${sourceExperimentId}.json`);
const terminal=new Set(['completed','partial','failed','cancelled']);

const sleep=milliseconds=>new Promise(resolvePromise=>setTimeout(resolvePromise,milliseconds));
const request=async(path,options={})=>{
  const response=await fetch(`${serverBase}${path}`,options);
  const text=await response.text();
  let value;try{value=JSON.parse(text);}catch{value={raw:text};}
  if(!response.ok)throw new Error(`${response.status}: ${value?.error||text}`);
  return value;
};
const persist=value=>writeFileSync(output,`${JSON.stringify(value,null,2)}\n`);

let source;
for(;;){
  source=await request(`/api/experiments/${sourceExperimentId}/summary`);
  persist({status:'waiting',source_experiment_id:sourceExperimentId,source_status:source.status,source_progress:source.progress?.scoring_current||null,updated_at:new Date().toISOString()});
  if(terminal.has(source.status))break;
  await sleep(30_000);
}

const db=new DatabaseSync(database,{readOnly:true});
const previouslyRun=new Set(db.prepare(`
  SELECT DISTINCT json_extract(config_json,'$.patient_id') AS patient_id
  FROM experiments
  WHERE benchmark='medlocomo'
    AND json_extract(config_json,'$.patient_id') IS NOT NULL
    AND COALESCE(json_extract(progress_json,'$.query_total'),0)>=50
`).all().map(row=>String(row.patient_id)));
previouslyRun.add(String(source.config?.patient_id||''));
const patients=adapters().medlocomo.catalog().patients.filter(patient=>!previouslyRun.has(String(patient)));
if(patients.length<count)throw new Error(`Only ${patients.length} untested MedLoCoMo patients remain; requested ${count}`);
for(let index=patients.length-1;index>0;index--){const selected=randomInt(index+1);[patients[index],patients[selected]]=[patients[selected],patients[index]];}
const selected=patients.slice(0,count),launched=[];

for(const patientId of selected){
  const config={
    patient_id:patientId,
    mode:'all',
    medlocomo_policy_mode:source.config.medlocomo_policy_mode||'distilled_typed',
    query_type_routing_mode:source.config.query_type_routing_mode||'classified',
    candidate_budget:Number(source.config.candidate_budget||48),
    investigation_budget:Number(source.config.investigation_budget||6),
    query_concurrency:Number(source.config.query_concurrency||12),
    preprocess_concurrency:Number(source.config.preprocess_concurrency||4),
    model:source.config.model,
    medlocomo_judge_model:source.config.medlocomo_judge_model
  };
  const experiment=await request('/api/benchmarks/medlocomo/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(config)});
  launched.push({patient_id:patientId,experiment_id:experiment.id,status:experiment.status});
}

persist({status:'launched',source_experiment_id:sourceExperimentId,source_status:source.status,selected_patients:selected,experiments:launched,launched_at:new Date().toISOString()});
console.log(JSON.stringify({output,selected,launched},null,2));
