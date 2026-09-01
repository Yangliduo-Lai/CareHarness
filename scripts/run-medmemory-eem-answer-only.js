import { randomUUID } from 'node:crypto';
import { Store } from '../src/db.js';
import { ModelRegistry } from '../src/model-registry.js';
import { adapters } from '../src/adapters/index.js';
import { compactMedMemorySource,PROMPTS } from '../src/prompts.js';

const args=parseArgs(process.argv.slice(2));

async function main(){
  const store=new Store(args.database);
  try{
    const models=new ModelRegistry(store),profile=models.state().profiles.find(item=>item.id===args.profile);
    if(!profile)throw new Error(`Missing model profile ${args.profile}`);
    const apiKey=process.env[args.api_key_env]||(await readStdinLine()).trim();
    if(!apiKey)throw new Error(`${args.api_key_env} or one stdin line is required`);
    // Keep the supplied evaluation credential in this process only. The model
    // profile already stores its environment-variable reference.
    process.env[profile.config.api_key_ref||args.api_key_env]=apiKey;
    const source=findSourceExperiment(store,args),sourceItems=source.results.filter(item=>item.kind==='score'&&item.task===args.task);
    if(!sourceItems.length)throw new Error(`Source experiment ${source.id} has no ${args.task} score results`);
    const gateway=models.gatewayForProfile(profile.id),adapter=adapters().medmemorybench,results=Array(sourceItems.length),started=Date.now();let next=0;
    const worker=async()=>{while(true){const index=next++;if(index>=sourceItems.length)return;const prior=sourceItems[index],context=prior.retrieval_context||{},modelInput={task:args.task,question:prior.question,memory_source:compactMedMemorySource({task:args.task,question:prior.question,patient_profile:context.patient_profile,recent_sessions:context.recent_sessions,memory_nodes:context.memory_nodes,memory_edges:context.memory_edges,working_memory:context.working_memory,semantic_evaluation:context.semantic_evaluation,mq_option_retrieval:context.mq_option_retrieval})};
      try{
        const response=await gateway.completeText('medmemory_answer',modelInput,()=>'',{maxTokens:args.task==='entity_exact_match'?160:1200}),answer=adapter.normalizeAnswer(String(response.value).trim(),{task:args.task});let score,judgeInput=null,judgeTrace=null;
        if(adapter.requiresOfficialJudge({task:args.task})){
          if(!prior.official_judge_input)throw new Error(`Source result ${prior.score_id} has no frozen official Judge input`);
          judgeInput={...prior.official_judge_input,model_output:answer};
          const judge=await gateway.completeJSON('medmemory_judge',judgeInput,value=>adapter.validateOfficialJudge(value,{task:args.task}),()=>{throw new Error('Live Judge required')},{maxTokens:adapter.officialJudgeMaxTokens({task:args.task}),extractJsonObject:true});
          judgeTrace=judge.trace;score=adapter.scoreOfficialJudge(judge.value,{task:args.task});
        }else score=adapter.compatibleScore(answer,prior.gold,{task:args.task});
        results[index]={...prior,status:'scored',system_output:answer,score:score.score,is_correct:score.is_correct,scoring_method:score.method,scoring_reason:score.reason,scoring_details:score.details,official_judge_input:judgeInput,evaluation_mode:'diagnostic_answer_only_prompt_ab',matched_manifest_hash:null,source_experiment_id:source.id,source_system_output:prior.system_output,source_is_correct:prior.is_correct,answer_only_ab:true,raw_answer_output:response.trace,answer_model_trace:response.trace,answer_input_tokens:response.trace.token_input,answer_latency_ms:response.trace.latency_ms,raw_judge_output:judgeTrace,judge_model_trace:judgeTrace,judge_input_tokens:judgeTrace?.token_input??null,judge_latency_ms:judgeTrace?.latency_ms??null,judge_infrastructure_failure:false,latency_ms:response.trace.latency_ms+Number(judgeTrace?.latency_ms||0)};
      }catch(error){results[index]={...prior,status:'failed',system_output:'',score:null,is_correct:null,scoring_method:'answer_or_judge_failed',scoring_reason:String(error.message||error),scoring_details:null,evaluation_mode:'diagnostic_answer_only_prompt_ab',matched_manifest_hash:null,source_experiment_id:source.id,source_system_output:prior.system_output,source_is_correct:prior.is_correct,answer_only_ab:true,raw_answer_output:error.gatewayTrace||null,answer_model_trace:error.gatewayTrace||null};}
    }};
    await Promise.all(Array.from({length:Math.min(args.concurrency,sourceItems.length)},worker));
    const experimentId=randomUUID(),now=new Date().toISOString(),scored=results.filter(item=>item.status==='scored'),correct=scored.filter(item=>item.is_correct).length,failed=results.length-scored.length,score=scored.length?scored.reduce((sum,item)=>sum+Number(item.score||0),0)/scored.length:null,beforeCorrect=sourceItems.filter(item=>item.is_correct).length;
    const config={...source.config,persona_id:args.persona,query_type:args.task,query_types:[args.task],score_only_current_memory:true,resume_incomplete:false,matched_experiment:false,evaluation_mode:'diagnostic_answer_only_prompt_ab',answer_only_source_experiment_id:source.id,query_concurrency:args.concurrency,resolved_models:{answer:{...gateway.publicConfig(),profile_id:profile.id},scoring_judge:{...gateway.publicConfig(),profile_id:profile.id}},prompt_versions:{medmemory_answer:PROMPTS.medmemory_answer.version}};
    delete config.matched_manifest;
    const byType={count:results.length,scored:scored.length,score_count:scored.length,failed,correct,accuracy:score,average_score:score,candidate_zero_recall:sourceItems.filter(item=>item.retrieval_trace?.investigation?.candidate_zero_recall).length,zero_recall:sourceItems.filter(item=>!(item.retrieval_context?.memory_nodes||[]).length).length,memory_incomplete:0};
    const progress={phase:'finished',score_only_current_memory:true,total:0,available:0,completed:0,failed:0,skipped:0,current:null,eta_seconds:0,started_at:new Date(started).toISOString(),query_total:results.length,query_message:null,scored:scored.length,query_failed:failed,scoring_total:results.length,scoring_current:null,scoring_active:0,scoring_concurrency:args.concurrency,score,reused_through_session:100,prompt_ab:{source_experiment_id:source.id,before_correct:beforeCorrect,before_accuracy:sourceItems.length?beforeCorrect/sourceItems.length:null,after_correct:correct,after_accuracy:score,delta_correct:correct-beforeCorrect},retrieval_metrics:{query_count:results.length,scored_query_count:scored.length,classified_query_count:scored.length,wrong_answer_count:scored.length-correct,failed_query_count:failed,judge_infrastructure_failure_count:0,accuracy:score,average_score:score,by_query_type:{[args.task]:byType}}};
    const version={diagnostic:'medmemory-answer-only-prompt-ab.v2',prompt_version:PROMPTS.medmemory_answer.version,source_experiment_id:source.id};
    store.db.prepare(`INSERT INTO experiments VALUES(?,?,?,?,?,?,?,?,?)`).run(experimentId,'medmemorybench',failed?'partial':'completed',JSON.stringify(config),JSON.stringify(progress),JSON.stringify(results),JSON.stringify(version),now,now);
    process.stdout.write(`${JSON.stringify({experiment_id:experimentId,status:failed?'partial':'completed',persona_id:args.persona,task:args.task,source_experiment_id:source.id,prompt_version:PROMPTS.medmemory_answer.version,model:profile.config.model,count:results.length,completed:scored.length,failed,before_correct:beforeCorrect,before_accuracy:sourceItems.length?beforeCorrect/sourceItems.length:null,after_correct:correct,after_accuracy:score,delta_correct:correct-beforeCorrect},null,2)}\n`);
  }finally{store.close();}
}

function findSourceExperiment(store,{persona,task,source_experiment}){
  if(source_experiment){const row=store.db.prepare(`SELECT * FROM experiments WHERE id=?`).get(source_experiment);if(!row)throw new Error(`Unknown source experiment ${source_experiment}`);return hydrate(row);}
  const rows=store.db.prepare(`SELECT * FROM experiments WHERE benchmark='medmemorybench' AND status='completed' ORDER BY created_at DESC LIMIT 100`).all();
  for(const row of rows){const item=hydrate(row),selected=item.results.filter(result=>result.kind==='score'&&result.task===task);if(Number(item.config.persona_id)===persona&&selected.length)return item;}
  throw new Error(`No completed Persona ${persona} experiment with ${task} results was found`);
}

function hydrate(row){return{...row,config:JSON.parse(row.config_json),progress:JSON.parse(row.progress_json),results:JSON.parse(row.results_json),version:JSON.parse(row.version_json||'{}')};}
function readStdinLine(){return new Promise((resolve,reject)=>{let value='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{value+=chunk;if(value.includes('\n')){process.stdin.pause();resolve(value.split(/\r?\n/u)[0]);}});process.stdin.on('end',()=>resolve(value));process.stdin.on('error',reject);});}
function parseArgs(argv){const out={database:process.env.CAREHARNESS_DB_PATH||'./data/careharness.sqlite',persona:4,task:'entity_exact_match',profile:'closeai-qwen3.5-flash',api_key_env:'CAREHARNESS_RUN_KEY',concurrency:16,source_experiment:null};for(let index=0;index<argv.length;index++){const key=argv[index],value=argv[index+1];if(key==='--database'){out.database=value;index++;}else if(key==='--persona'){out.persona=positive(value,key);index++;}else if(key==='--task'){out.task=required(value,key);index++;}else if(key==='--profile'){out.profile=required(value,key);index++;}else if(key==='--api-key-env'){out.api_key_env=required(value,key);index++;}else if(key==='--concurrency'){out.concurrency=positive(value,key);index++;}else if(key==='--source-experiment'){out.source_experiment=required(value,key);index++;}else throw new Error(`Unknown argument: ${key}`);}return out;}
function positive(value,key){const number=Number(value);if(!Number.isInteger(number)||number<1)throw new Error(`${key} requires a positive integer`);return number;}
function required(value,key){if(!value||String(value).startsWith('--'))throw new Error(`${key} requires a value`);return String(value);}

main().catch(error=>{process.stderr.write(`${error.stack||error.message||error}\n`);process.exitCode=1;});
