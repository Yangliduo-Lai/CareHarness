import { mkdirSync,writeFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { Store } from '../src/db.js';
import { ExperimentHarness,MEMORY_PIPELINE_VERSION,memoryScopeKey } from '../src/experiments.js';
import { ModelRegistry } from '../src/model-registry.js';

const DATABASE=process.env.CAREHARNESS_DB_PATH||'./data/careharness.sqlite';
const OUTPUT=process.argv[2]||'reports/persona2-mcd-qwen37flash-diagnostic.json';
const MODEL='qwen3.7-flash';
const QUERY_TYPE='multi_hop_clinical_deduction';

async function main(){
  const store=new Store(DATABASE),models=new ModelRegistry(store);
  try{
    hydrateCredential(models);
    const resolvedModels=models.assignmentSnapshot();
    assertFlashOnly(resolvedModels);
    const harness=new ExperimentHarness(store,undefined,models);
    const config={persona_id:2,noise:false,max_session:100,query_type:QUERY_TYPE,score_only_current_memory:true,split:'heldout',evaluation_mode:'diagnostic_heldout_mcd_subset',seed:42,candidate_budget:40,action_budget:6};
    const data=harness.adapters.medmemorybench.load(config),cases=harness.adapters.medmemorybench.cases(data,config),preview=harness.preview('medmemorybench',config),scope=preview.current_memory_scope;
    if(cases.length!==10||cases.some(item=>item.task!==QUERY_TYPE))throw new Error(`Expected exactly 10 Persona 2 MCD cases, found ${cases.length}`);
    const expectedScopeKey=memoryScopeKey({...config,resolved_models:resolvedModels});
    if(scope?.memory_pipeline_version!==MEMORY_PIPELINE_VERSION||scope?.status!=='completed'||Number(scope?.complete_through_session)<100||Number(scope?.observation_failed||0)>0||scope?.memory_scope_key!==expectedScopeKey)throw new Error('Persona 2 unified Memory Graph is incomplete or incompatible with the Flash-only model scope');
    process.stderr.write(`Running Persona 2 Clean diagnostic subset: ${cases.length} MCD queries; every component=${MODEL}\n`);
    const experiment=await harness.start('medmemorybench',config);
    const payload={report_version:'persona2-mcd-diagnostic.v2-memory',generated_at:new Date().toISOString(),note:'Held-out diagnostic subset; aggregate metrics only. This is not an official complete-suite matched result.',experiment_id:experiment.id,status:experiment.status,scope:{persona_id:2,split:'heldout',noise:false,query_type:QUERY_TYPE,query_count:cases.length,memory_snapshot:{memory_pipeline_version:scope.memory_pipeline_version,complete_through_session:scope.complete_through_session,observation_failed:scope.observation_failed}},models:publicModels(experiment.config.resolved_models),budgets:{candidate_budget:experiment.config.candidate_budget,action_budget:experiment.config.action_budget,seed:experiment.config.seed},metrics:aggregateMetrics(experiment.progress.retrieval_metrics)};
    const output=resolve(OUTPUT);mkdirSync(dirname(output),{recursive:true});writeFileSync(output,`${JSON.stringify(payload,null,2)}\n`);
    process.stdout.write(`${JSON.stringify(payload,null,2)}\n`);
    if(experiment.status!=='completed')process.exitCode=1;
  }finally{store.close();}
}

function hydrateCredential(models){
  const key=process.env.CAREHARNESS_MATCHED_API_KEY;
  if(!key)throw new Error('CAREHARNESS_MATCHED_API_KEY is required');
  const state=models.state(),profileIds=new Set(Object.values(state.assignments));
  for(const profileId of profileIds){
    const profile=state.profiles.find(item=>item.id===profileId);
    if(!profile)throw new Error(`Missing assigned profile ${profileId}`);
    if(profile.config.provider==='mock')throw new Error(`Offline Mock is assigned through ${profileId}`);
    models.save({id:profile.id,name:profile.name,config:profile.config,api_key:key});
  }
}

function assertFlashOnly(models){
  const invalid=Object.entries(models).filter(([,value])=>value.provider==='mock'||value.model!==MODEL);
  if(invalid.length)throw new Error(`Non-${MODEL} assignments: ${invalid.map(([component,value])=>`${component}=${value.model}`).join(', ')}`);
}

function publicModels(models={}){return Object.fromEntries(Object.entries(models).map(([component,value])=>[component,{provider:value?.provider,base_url:value?.base_url,model:value?.model,temperature:value?.temperature,max_tokens:value?.max_tokens}]));}
function aggregateMetrics(metrics={}){const type=metrics.by_query_type?.[QUERY_TYPE]||{};return{query_count:metrics.query_count,scored_query_count:metrics.scored_query_count,failed_query_count:metrics.failed_query_count,judge_infrastructure_failure_count:metrics.judge_infrastructure_failure_count,accuracy:metrics.accuracy,average_score:metrics.average_score,average_candidate_memory_nodes:metrics.average_candidate_memory_nodes,average_retrieved_memory_nodes:metrics.average_retrieved_memory_nodes,investigation_policy_calls:metrics.investigation_policy_calls,investigation_policy_input_tokens:metrics.investigation_policy_input_tokens,relation_evaluator_calls:metrics.relation_evaluator_calls,relation_evaluator_input_tokens:metrics.relation_evaluator_input_tokens,relation_evaluator_output_tokens:metrics.relation_evaluator_output_tokens,average_answer_input_tokens:metrics.average_answer_input_tokens,average_judge_input_tokens:metrics.average_judge_input_tokens,mcd:{count:type.count,scored:type.scored,failed:type.failed,average_score:type.average_score,avg_ncr:type.avg_ncr,avg_crc:type.avg_crc,avg_cc:type.avg_cc,node_mention_rate:type.node_mention_rate,node_causal_rate:type.node_causal_rate}};}

main().catch(error=>{process.stderr.write(`Persona 2 MCD diagnostic aborted: ${error.message}\n`);process.exitCode=1;});
