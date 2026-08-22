import { createHash } from 'node:crypto';
import { applyQueryTimeRelationEvaluation,executeCareHarnessPolicy,queryTimeRelationEvaluatorInput } from './careharness-actions.js';
import { MATCHED_EVALUATION_MODE } from './careharness-contract.js';
import { PROMPTS } from './prompts.js';

export const MATCHED_EXPERIMENT_VERSION='medmemory-matched-experiment.v6';
export const MEDMEMORY_FROZEN_QUERY_COUNT=97;
const HIDDEN_KEYS=/^(gold|answers?|answer_key|source_key_points?|judge_reason|judge_metadata|official_evaluation|reference(?:_answer)?|scoring_reason)$/i;

export function buildMatchedManifest({benchmark='medmemorybench',evaluation_mode=MATCHED_EVALUATION_MODE,noise,persona_id,split='dev',query_ids=[],state_snapshot,memory_pipeline_version,models,seed=42,candidate_budget=24,action_budget=6,strict_full_suite=true}){
  if(benchmark!=='medmemorybench')throw new Error('Matched inference-time loop currently supports MedMemoryBench only');
  assertStaticCareHarnessMode(evaluation_mode);
  if(memory_pipeline_version!=='patient-graph-memory-v13')throw new Error('Matched experiments require an exact v13 Patient Graph snapshot');
  if(!state_snapshot?.fingerprint||!Number.isInteger(Number(state_snapshot.state_count))||!Number.isInteger(Number(state_snapshot.edge_count))||!Number.isInteger(Number(state_snapshot.evidence_count)))throw new Error('Matched experiments require a frozen Patient Graph fingerprint and node/edge/Evidence counts');
  if(strict_full_suite&&query_ids.length!==MEDMEMORY_FROZEN_QUERY_COUNT)throw new Error(`Matched full-suite experiments require exactly ${MEDMEMORY_FROZEN_QUERY_COUNT} MedMemoryBench queries`);
  const uniqueIds=[...new Set(query_ids.map(String))];if(uniqueIds.length!==query_ids.length)throw new Error('Matched experiment query_ids must be unique');
  const publicModels=normalizeModels(models);if(!publicModels.answer||!publicModels.scoring_judge)throw new Error('Matched experiments must freeze Answer Model and Scoring Judge');
  if(stableJson(publicModels.relation_evaluator)!==stableJson(publicModels.answer))throw new Error('Matched experiments require relation_evaluator to use exactly the Answer Model configuration');
  const body={
    version:MATCHED_EXPERIMENT_VERSION,benchmark,evaluation_mode,split,persona_id:Number(persona_id||1),noise:Boolean(noise),query_count:query_ids.length,query_ids:[...query_ids].map(String).sort(),
    state_snapshot:{pipeline_version:memory_pipeline_version,fingerprint:String(state_snapshot.fingerprint),state_count:Number(state_snapshot.state_count),edge_count:Number(state_snapshot.edge_count),evidence_count:Number(state_snapshot.evidence_count),complete_through_session:Number(state_snapshot.complete_through_session||state_snapshot.required_through_session||0)},
    models:publicModels,seed:Number(seed),temperatures:Object.fromEntries(Object.entries(publicModels).map(([key,value])=>[key,value.temperature])),
    prompt_versions:{query_planner:PROMPTS.query_planner.version,relation_evaluator:PROMPTS.careharness_evaluate.version,answer:PROMPTS.medmemory_answer.version,scoring_judge:PROMPTS.medmemory_judge.version},
    budgets:{candidate_budget:positiveInteger(candidate_budget,'candidate_budget'),action_budget:positiveInteger(action_budget,'action_budget'),relation_evaluator_call_budget:1,relation_edge_budget:8,semantics:budgetSemantics()},
    mandatory_evidence_index_gate:true,
    information_policy:{runtime_gold_or_judge_metadata_allowed:false,post_answer_offline_diagnosis_allowed:true},
    method_claims:{persistent_versioned_patient_graph:true,query_conditioned_working_subgraph:true,persistent_cross_state_graph:true,strict_causality_claimed:false,learned_policy_claimed:false}
  };
  return{...body,manifest_hash:sha256(stableJson(body))};
}

export function buildMatchedRuntimeContext({evaluation_mode=MATCHED_EVALUATION_MODE,item,query_plan,states=[],evidence=[],graph_edges=[],candidate_budget=24,action_budget=6}){
  assertStaticCareHarnessMode(evaluation_mode);
  const runtimeQuestion={question:String(item?.question||query_plan?.question||'')};
  assertNoHiddenRuntimeInput({runtimeQuestion,query_plan,states,evidence,graph_edges});
  const candidateBudget=positiveInteger(candidate_budget,'candidate_budget'),actionBudget=positiveInteger(action_budget,'action_budget');
  const context=executeCareHarnessPolicy(query_plan,states,evidence,{graph_edges,candidate_budget:candidateBudget,action_budget:actionBudget});
  return{evaluation_mode,...context,trace:{...context.trace,mandatory_evidence_index_gate:true}};
}

export async function buildMatchedRuntimeContextWithEvaluator({relation_evaluator,...input}){
  const baseline=buildMatchedRuntimeContext(input),selected=baseline.action_policy?.selected_actions||[];
  if(!selected.includes('evaluate'))return{...baseline,trace:{...baseline.trace,semantic_relation_evaluator:{status:'not_run',model_calls:0,token_input:null,token_output:null,total_tokens:null,latency_ms:null}}};
  if(baseline.verification?.safe_to_answer!==true)return{...baseline,trace:{...baseline.trace,semantic_relation_evaluator:{status:'skipped_verification_blocked',model_calls:0,blocking_rejected_states:(baseline.verification?.rejected_states||[]).filter(item=>item.blocking).length,blocking_rejected_relations:(baseline.verification?.rejected_relations||[]).filter(item=>item.blocking).length}}};
  if(baseline.proof?.complete===true)return{...baseline,trace:{...baseline.trace,semantic_relation_evaluator:{status:'skipped_already_supported',model_calls:0}}};
  if((baseline.proof?.missing_families||[]).length||baseline.states.length<2)return{...baseline,trace:{...baseline.trace,semantic_relation_evaluator:{status:'skipped_missing_required_families',model_calls:0,missing_families:baseline.proof?.missing_families||[]}}};
  if(typeof relation_evaluator!=='function')throw new Error('CareHarness relation_evaluator callback is required when the matched runtime selects evaluate and deterministic checks require semantic evaluation');
  const evaluatorInput=queryTimeRelationEvaluatorInput(input.query_plan,baseline);assertNoHiddenRuntimeInput(evaluatorInput,'relation_evaluator');
  const preSemanticVerification=baseline.verification,evaluatorStarted=Date.now();
  try{
    const response=await relation_evaluator(evaluatorInput),evaluation=response?.value??response,augmented=applyQueryTimeRelationEvaluation(input.query_plan,baseline,evaluation,{full_visible_states:input.states});
    const modelTrace=response?.trace||null,usage=evaluatorUsage(modelTrace,evaluatorStarted);
    return withEvaluatorAccounting({...augmented,evaluation_trace:modelTrace,pre_semantic_verification:preSemanticVerification},{...augmented.trace.semantic_relation_evaluator,status:'completed',...usage,model_trace:modelTrace,pre_semantic_verification:preSemanticVerification});
  }catch(error){
    const message=String(error?.message||error),modelTrace=error?.gatewayTrace||null,usage=evaluatorUsage(modelTrace,evaluatorStarted),actionTrace=(baseline.action_trace||[]).map(item=>['connect','evaluate'].includes(item.action)?{...item,outcome:{...item.outcome,semantic_evaluator_used:true,semantic_evaluator_status:'failed',evaluator_error:message}}:item);
    return withEvaluatorAccounting({...baseline,action_trace:actionTrace,evaluation_trace:modelTrace,pre_semantic_verification:preSemanticVerification},{status:'failed',...usage,error:message,error_kind:modelTrace?.error?.kind||null,model_trace:modelTrace,pre_semantic_verification:preSemanticVerification});
  }
}

export function careHarnessResultRows(experiments=[]){
  return experiments.map(experiment=>{
    const scores=(experiment.results||[]).filter(item=>item.kind==='score'&&item.status==='scored'),byTask={};
    for(const item of scores)(byTask[item.task]||=[]).push(Number(item.score));
    return{manifest_hash:experiment.config?.matched_manifest?.manifest_hash||null,runtime:experiment.config?.evaluation_mode||MATCHED_EVALUATION_MODE,split:experiment.config?.matched_manifest?.split||null,noise:Boolean(experiment.config?.noise),query_count:scores.length,score:average(scores.map(item=>Number(item.score))),by_task:Object.fromEntries(Object.entries(byTask).map(([task,values])=>[task,average(values)])),mock:scores.some(item=>item.mock===true),reproducible:Boolean(experiment.config?.matched_manifest?.manifest_hash)};
  });
}

export function assertNoHiddenRuntimeInput(value,path='runtime'){
  if(Array.isArray(value)){value.forEach((item,index)=>assertNoHiddenRuntimeInput(item,`${path}[${index}]`));return true;}
  if(!value||typeof value!=='object')return true;
  for(const[key,item]of Object.entries(value)){
    if(HIDDEN_KEYS.test(key))throw new Error(`Forbidden post-answer field in runtime input: ${path}.${key}`);
    assertNoHiddenRuntimeInput(item,`${path}.${key}`);
  }
  return true;
}

function normalizeModels(models={}){const answer=models.answer||models.judge||models.global,aliases={answer,relation_evaluator:models.relation_evaluator||answer,scoring_judge:models.scoring_judge||models.global,query_planner:models.query_planner||models.global},out={};for(const[key,value]of Object.entries(aliases))if(value)out[key]={provider:value.provider||null,base_url:value.base_url||'',model:value.model||null,temperature:Number(value.temperature??0),max_tokens:Number(value.max_tokens??1200),context_length:value.context_length??null};return out;}
function evaluatorUsage(trace,started){const tokenInput=finiteOrNull(trace?.token_input),tokenOutput=finiteOrNull(trace?.token_output);return{model_calls:1,token_input:tokenInput,token_output:tokenOutput,total_tokens:tokenInput!=null&&tokenOutput!=null?tokenInput+tokenOutput:null,latency_ms:finiteOrNull(trace?.latency_ms)??Math.max(0,Date.now()-started)};}
function withEvaluatorAccounting(context,semanticTrace){const actionTrace=(context.action_trace||[]).map(item=>item.action==='evaluate'?{...item,cost_units:Number(item.cost_units||0)+1}:item),totalCost=actionTrace.reduce((sum,item)=>sum+Number(item.cost_units||0),0),actionPolicy={...context.action_policy,total_cost_units:totalCost},trace={...context.trace,careharness_action_policy:{...context.trace?.careharness_action_policy,total_cost_units:totalCost},semantic_relation_evaluator:semanticTrace};return{...context,action_trace:actionTrace,action_policy:actionPolicy,trace};}
function finiteOrNull(value){if(value==null||value==='')return null;const number=Number(value);return Number.isFinite(number)?number:null;}
function budgetSemantics(){return{candidates:'candidate_budget_state_evidence',actions:'selective_action_budget',relation_evaluator:'at_most_one_model_call_for_complex_query_and_at_most_8_relations'};}
function assertStaticCareHarnessMode(value){if(value!==MATCHED_EVALUATION_MODE)throw new Error(`Matched evaluation mode is fixed to ${MATCHED_EVALUATION_MODE}; legacy comparator modes have been removed`);return value;}
function positiveInteger(value,name){const number=Number(value);if(!Number.isInteger(number)||number<=0)throw new Error(`${name} must be a positive integer`);return number;}
function average(values){return values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null;}
function sha256(value){return createHash('sha256').update(value).digest('hex');}
function stableJson(value){if(Array.isArray(value))return`[${value.map(stableJson).join(',')}]`;if(value&&typeof value==='object')return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;return JSON.stringify(value);}
