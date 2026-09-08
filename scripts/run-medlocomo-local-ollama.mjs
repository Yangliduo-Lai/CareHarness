import { Store } from '../src/db.js';
import { ExperimentHarness } from '../src/experiments.js';

const args=parseArgs(process.argv.slice(2));
if(!process.env[args.api_key_env])throw new Error(`Missing ${args.api_key_env}; Ollama accepts a non-secret placeholder such as "ollama".`);

const model={
  provider:'openai-compatible',
  base_url:args.base_url,
  model:args.model,
  api_key_ref:args.api_key_env,
  temperature:args.temperature,
  seed:args.seed,
  max_tokens:args.max_tokens,
  timeout_ms:args.timeout_ms,
  retries:args.retries,
  capabilities:['json'],
  context_length:args.context_length,
};

const store=new Store(args.database),harness=new ExperimentHarness(store);
try{
  const launched=harness.launch('medlocomo',{
    patient_id:args.patient,
    mode:'all',
    medlocomo_policy_mode:args.policy_mode,
    score_only_current_memory:true,
    candidate_budget:args.candidate_budget,
    investigation_budget:args.investigation_budget,
    query_concurrency:args.query_concurrency,
    evaluation_mode:args.label,
    query_type_routing_mode:'classified',
    ...(args.resume_source_experiment?{resume_source_experiment_id:args.resume_source_experiment}:{}),
    model,
    medlocomo_judge_model:model,
  });
  process.stdout.write(`${JSON.stringify(event(launched,'started'))}\n`);
  let previous='';
  for(;;){
    await wait(args.poll_ms);
    const experiment=harness.get(launched.id),signature=JSON.stringify(progress(experiment));
    if(signature!==previous){process.stdout.write(`${JSON.stringify(event(experiment,'progress'))}\n`);previous=signature;}
    if(terminal(experiment.status)){process.stdout.write(`${JSON.stringify(event(experiment,'finished'))}\n`);break;}
  }
}finally{store.close();}

function progress(experiment){
  const value=experiment?.progress||{},metrics=value.retrieval_metrics||{};
  return{status:experiment?.status||null,phase:value.phase||null,scored:Number(value.scored||0),query_total:Number(value.query_total||0),query_failed:Number(value.query_failed||0),active:Number(value.scoring_active||0),correct:Object.values(metrics.by_query_type||{}).reduce((sum,row)=>sum+Number(row.correct||0),0),accuracy:metrics.accuracy??null,eta_seconds:value.eta_seconds??null};
}
function event(experiment,event_name){return{event:event_name,at:new Date().toISOString(),experiment_id:experiment.id,patient_id:args.patient,model:args.model,base_url:args.base_url,...progress(experiment)};}
function terminal(status){return['completed','partial','failed','cancelled'].includes(String(status||''));}
function wait(ms){return new Promise(resolve=>setTimeout(resolve,ms));}

function parseArgs(argv){
  const out={database:process.env.CAREHARNESS_DB_PATH||'./data/careharness.sqlite',patient:null,base_url:'http://192.168.1.2:11434/v1',model:'gemma3:4b',api_key_env:'CAREHARNESS_LOCAL_OLLAMA_KEY',policy_mode:'distilled_typed',label:'medlocomo_local_ollama_full_patient',resume_source_experiment:null,candidate_budget:48,investigation_budget:6,query_concurrency:1,temperature:0,seed:42,max_tokens:4096,timeout_ms:600000,retries:1,context_length:131072,poll_ms:15000};
  for(let index=0;index<argv.length;index++){
    const key=argv[index],value=argv[index+1];
    if(key==='--database'){out.database=required(value,key);index++;}
    else if(key==='--patient'){out.patient=required(value,key);index++;}
    else if(key==='--base-url'){out.base_url=required(value,key).replace(/\/$/u,'');index++;}
    else if(key==='--model'){out.model=required(value,key);index++;}
    else if(key==='--api-key-env'){out.api_key_env=required(value,key);index++;}
    else if(key==='--policy-mode'){out.policy_mode=required(value,key);index++;}
    else if(key==='--label'){out.label=required(value,key);index++;}
    else if(key==='--resume-source-experiment'){out.resume_source_experiment=required(value,key);index++;}
    else if(key==='--candidate-budget'){out.candidate_budget=positive(value,key);index++;}
    else if(key==='--investigation-budget'){out.investigation_budget=positive(value,key);index++;}
    else if(key==='--query-concurrency'){out.query_concurrency=positive(value,key);index++;}
    else if(key==='--temperature'){out.temperature=boundedNumber(value,key,0,2);index++;}
    else if(key==='--seed'){out.seed=nonNegativeInteger(value,key);index++;}
    else if(key==='--max-tokens'){out.max_tokens=positive(value,key);index++;}
    else if(key==='--timeout-ms'){out.timeout_ms=positive(value,key);index++;}
    else if(key==='--retries'){out.retries=nonNegativeInteger(value,key);index++;}
    else if(key==='--context-length'){out.context_length=positive(value,key);index++;}
    else if(key==='--poll-ms'){out.poll_ms=positive(value,key);index++;}
    else throw new Error(`Unknown argument: ${key}`);
  }
  if(!out.patient)throw new Error('--patient is required');
  return out;
}
function required(value,key){if(!value||String(value).startsWith('--'))throw new Error(`${key} requires a value`);return String(value);}
function positive(value,key){const number=Number(value);if(!Number.isInteger(number)||number<1)throw new Error(`${key} requires a positive integer`);return number;}
function nonNegativeInteger(value,key){const number=Number(value);if(!Number.isInteger(number)||number<0)throw new Error(`${key} requires a non-negative integer`);return number;}
function boundedNumber(value,key,min,max){const number=Number(value);if(!Number.isFinite(number)||number<min||number>max)throw new Error(`${key} must be between ${min} and ${max}`);return number;}
