import { createHash } from 'node:crypto';
import { assertNoHiddenBenchmarkInput } from './information-boundary.js';
import { LEARNED_ACTION_PRIOR_ADVICE } from './prompts.js';

export const ACTION_POLICY_MODEL_VERSION='careharness-action-value-model.v4-hierarchical-relative-return';
const LEGACY_ACTION_POLICY_MODEL_VERSIONS=new Set([
  'careharness-action-value-model.v2-relative-return',
  'careharness-action-value-model.v3-query-type-relative-return',
]);
export const ACTION_POLICY_PRIOR_VERSION='careharness-action-value-prior.v1';
export const ACTION_EXPLORATION_VERSION='careharness-safe-action-exploration.v1';
const DISCOVERY_WORKERS=new Set(['search','context','trace']);

/**
 * Build a case-free control state. Public query type may be a feature, while
 * question text, retrieved clinical text, Gold and Judge metadata never are.
 * The learned component can prefer an operation for a task contract, but
 * cannot memorize what to retrieve or what answer to produce.
 */
export function abstractActionPolicyState(input={}){
  const information=input.current_information||{},steps=array(input.previous_steps),assessment=information.assessment||null,verification=information.verification||null,last=steps.at(-1)||null,nodeCount=array(information.memory_nodes).length,missingCount=array(assessment?.missing_information).filter(Boolean).length,discoveryCount=steps.filter(step=>DISCOVERY_WORKERS.has(String(step?.worker||''))).length,assessmentCount=steps.filter(step=>step?.worker==='assess').length;
  return{
    query_type:normalizeQueryType(input.query_type||information.strategy_profile?.query_type),
    node_count:bucket(nodeCount,[0,4,12],['none','small','medium','large']),
    assessment:assessmentStatus(assessment),
    missing_count:bucket(missingCount,[0,1,2],['none','one','two','many']),
    verification:verificationStatus(verification),
    last_worker:String(last?.worker||information.worker_state?.last_worker||'none'),
    last_changed:last?changeStatus(last.changed):'none',
    stalled_discovery:bucket(noProgressDiscoveryStreak(steps),[0,1],['none','one','repeated']),
    discovery_count:bucket(discoveryCount,[0,1,2],['none','one','two','many']),
    assessment_count:bucket(assessmentCount,[0,1],['none','one','repeated']),
    remaining_budget:bucket(Number(input.remaining_budget||0),[1,3,6],['last','low','medium','high']),
    has_profile:Number(information.patient_profile?.item_count||0)>0,
    has_recent_sessions:array(information.recent_sessions).length>0,
  };
}

export function actionPolicyStateKey(input={}){return serializeState(abstractActionPolicyState(input));}

export function learnActionPolicyModel(experiments=[],options={}){
  const rows=[],trajectories=[],trainingHashes=[],trainingPersonas=new Set(),trainingSplits=new Set(),exclusionCounts={non_score_result:0,judge_infrastructure_failure:0,memory_incomplete:0,unscored_or_non_numeric:0,incomplete_or_invalid_trajectory:0};
  for(const experiment of array(experiments)){
    validateTrainingExperiment(experiment);
    trainingPersonas.add(Number(experiment.config?.persona_id));trainingSplits.add(String(experiment.config?.split||'dev'));
    trainingHashes.push(hashIdentifier(experiment.id||JSON.stringify(experiment.config||{})));
    const budget=Math.max(1,Number(experiment.config?.investigation_budget||8)+1);
    for(const result of array(experiment.results)){
      const exclusion=actionPolicyTrajectoryEligibility(result).reason;
      if(exclusion){exclusionCounts[exclusion]++;continue;}
      const turns=result.retrieval_trace.investigation.turns;
      const finalValue=clamp(Number(result.score),0,1),initialInformation={patient_profile:result.retrieval_context?.patient_profile||null,recent_sessions:array(result.retrieval_context?.recent_sessions).map(session=>({episode_id:session?.episode_id,event_time:session?.event_time})),memory_nodes:[],memory_edges:[],verification:null,assessment:null,answer_brief:null,worker_state:null};
      trajectories.push({comparison_group:String(result.score_id||'<unidentified>'),query_type:normalizeQueryType(result.task||result.query_type||result.retrieval_context?.question_request?.query_type),final_value:finalValue,budget,initial_information:initialInformation,turns});
    }
  }
  const comparisons=hierarchicalComparisons(trajectories),comparisonModeCounts={within_question:0,cross_case_query_type:0,calibrated_raw_score:0};
  for(const trajectory of trajectories){let currentInformation=trajectory.initial_information,previousSteps=[];const comparison=comparisons.get(trajectory),relativeReturn=comparison.relative_return;comparisonModeCounts[comparison.mode]++;for(let index=0;index<trajectory.turns.length;index++){const turn=trajectory.turns[index],worker=String(turn?.decision?.worker||'').trim(),input={query_type:trajectory.query_type,current_information:currentInformation,previous_steps:previousSteps,remaining_budget:Math.max(1,trajectory.budget-index)},state=abstractActionPolicyState(input),shapedValue=clamp(relativeReturn+transitionAdjustment(turn,index,currentInformation),0,1),conditionalProbability=Number(turn?.action_exploration_assignment?.conditional_probability||0);rows.push({state,worker,value:shapedValue,...(conditionalProbability>0?{conditional_probability:conditionalProbability}:{})});previousSteps=[...previousSteps,{worker,changed:turn?.result?.changed??null}];currentInformation=turn.result.snapshot;}}
  const excludedTotal=Object.values(exclusionCounts).reduce((sum,value)=>sum+value,0);
  if(!rows.length)throw new Error(`No valid complete scored investigation trajectories were available for action-policy learning (excluded ${excludedTotal}: ${formatCounts(exclusionCounts)})`);
  const global=aggregate(rows,()=>'*'),contexts=aggregate(rows,row=>serializeState(row.state)),backoffs=aggregate(rows,row=>serializeState(backoffState(row.state))),priorStrength=Math.max(1,Number(options.prior_strength||4)),globalMeans=meanByAction(global['*']||{}),contextValues=posteriorValues(contexts,globalMeans,priorStrength),backoffValues=posteriorValues(backoffs,globalMeans,priorStrength),globalValues=posteriorValues(global,globalMeans,0)['*']||[];
  const body={
    version:ACTION_POLICY_MODEL_VERSION,
    training_scope:{benchmark:'medmemorybench',splits:[...trainingSplits].sort(),persona_ids:[...trainingPersonas].sort((a,b)=>a-b),noise:false,trajectory_count:trajectories.length,decision_count:rows.length,exploration_decision_count:rows.filter(row=>row.conditional_probability>0).length,experiment_count:trainingHashes.length,experiment_hashes:trainingHashes.sort(),excluded_result_count:excludedTotal,exclusion_counts:exclusionCounts,comparison_mode_counts:comparisonModeCounts,uses_question_text:false,uses_task_label:true,uses_gold_or_judge_content:false,uses_post_answer_scalar_reward:true,reward_signal:'hierarchical_within_question_or_cross_case_query_type_or_calibrated_raw_score_plus_runtime_transition_progress',reward_interpretation:'correlational_weak_prior_not_causal_action_effect',causal_claim:false,propensity_weighting:'capped_inverse_conditional_assignment_probability',comparison_group_retained:false},
    state_features:Object.keys(abstractActionPolicyState({})),
    prior_strength:priorStrength,
    contexts:contextValues,
    backoff_contexts:backoffValues,
    global_actions:globalValues,
  };
  const model={...body,model_hash:sha256(stableJson(body))};
  assertSafeLearnedModel(model);
  return model;
}

export function withLearnedActionPrior(input={},model=null){
  if(!model)return input;
  validateActionPolicyModel(model);
  const state=abstractActionPolicyState(input),exact=array(model.contexts?.[serializeState(state)]),backoff=array(model.backoff_contexts?.[serializeState(backoffState(state))]),global=array(model.global_actions),allowed=[...new Set(array(input.allowed_workers).map(String))],ranked=allowed.map(worker=>valueForWorker(worker,exact,backoff,global)).filter(Boolean).sort((left,right)=>right.estimated_value-left.estimated_value||right.support-left.support||left.worker.localeCompare(right.worker)),margin=ranked.length>1?ranked[0].estimated_value-ranked[1].estimated_value:0,support=ranked[0]?.support||0,comparisonQuality=actionPolicyComparisonQuality(model),confidence=round(Math.min(.8,(support/(support+4))*(.25+Math.max(0,margin)))*comparisonQuality.reliability);
  const learned_action_prior={version:ACTION_POLICY_PRIOR_VERSION,model_hash:model.model_hash,source:ranked[0]?.value_source||'none',confidence,comparison_quality:comparisonQuality,advice:LEARNED_ACTION_PRIOR_ADVICE,ranked_actions:ranked};
  const output={...input,learned_action_prior};
  assertNoHiddenBenchmarkInput(output,'investigation_policy_with_learned_prior');
  return output;
}

export function withActionExploration(input={},options={}){
  const rate=Number(options.rate||0),allowed=[...new Set(array(input.allowed_workers).map(String))];
  if(!Number.isFinite(rate)||rate<0||rate>1)throw new Error('Action exploration rate must be between 0 and 1');
  if(rate===0||allowed.length<2)return input;
  const turn=array(input.previous_steps).length+1,key=`${Number(options.seed||0)}\u0000${String(options.trajectory_key||'trajectory')}\u0000${turn}`,gate=randomUnit(`${key}\u0000gate`);
  if(gate>=rate)return input;
  const worker=allowed[Math.floor(randomUnit(`${key}\u0000action`)*allowed.length)%allowed.length],action_exploration_assignment={version:ACTION_EXPLORATION_VERSION,mode:'uniform_over_runtime_allowed_actions',worker,eligible_workers:allowed,conditional_probability:round(1/allowed.length),assignment_probability:round(rate/allowed.length),seed:Number(options.seed||0),turn};
  const output={...input,action_exploration_assignment};assertNoHiddenBenchmarkInput(output,'investigation_policy_with_action_exploration');return output;
}

export function actionPolicyLearningManifest(model=null){
  if(!model)return{enabled:false};
  validateActionPolicyModel(model);
  return{enabled:true,version:model.version,model_hash:model.model_hash,training_scope:model.training_scope,state_features:model.state_features,prior_strength:model.prior_strength};
}

export function validateActionPolicyModel(model){
  if(!model||model.version!==ACTION_POLICY_MODEL_VERSION&&!LEGACY_ACTION_POLICY_MODEL_VERSIONS.has(model.version))throw new Error(`Unsupported action-policy model version: ${model?.version||'<missing>'}`);
  if(model.training_scope?.benchmark!=='medmemorybench'||model.training_scope?.noise!==false)throw new Error('Action-policy model must be trained only on MedMemoryBench Clean trajectories');
  if(model.training_scope?.uses_question_text!==false||model.training_scope?.uses_gold_or_judge_content!==false)throw new Error('Action-policy model violates the runtime information boundary');
  if(model.version==='careharness-action-value-model.v2-relative-return'&&model.training_scope?.uses_task_label!==false)throw new Error('Legacy action-policy model has an invalid task-label boundary');
  if(model.version!=='careharness-action-value-model.v2-relative-return'&&model.training_scope?.uses_task_label!==true)throw new Error('Type-adaptive action-policy model must disclose task-label conditioning');
  assertSafeLearnedModel(model);
  return model;
}

export function actionPolicyTrajectoryEligibility(result){
  const reason=trainingExclusionReason(result);return{eligible:reason===null,reason};
}

function validateTrainingExperiment(experiment){
  const config=experiment?.config||{},model=config.resolved_models?.investigation_policy;
  if(experiment?.benchmark!=='medmemorybench'||!Number.isInteger(Number(config.persona_id))||Number(config.persona_id)<1||Boolean(config.noise))throw new Error('Training accepts only completed MedMemoryBench Clean Persona experiments');
  if(experiment.status!=='completed')throw new Error(`Training experiment ${experiment.id||'<unknown>'} is not completed`);
  if(model?.provider!=='dashscope'||model?.model!=='qwen3.7-flash')throw new Error('Training trajectories must use DashScope qwen3.7-flash Investigation Policy');
}
function assertSafeLearnedModel(model){
  assertNoHiddenBenchmarkInput(model,'learned_action_policy');
  const serialized=JSON.stringify(model);
  for(const forbidden of ['question','task_label','score_id','system_output','memory_nodes','required_patient_info','nodes_for_validation'])if(serialized.includes(`"${forbidden}"`))throw new Error(`Learned action-policy model contains forbidden feature ${forbidden}`);
  return true;
}
function aggregate(rows,keyFor){const output={};for(const row of rows){const key=keyFor(row),actions=output[key]||={},cell=actions[row.worker]||{count:0,weight_sum:0,sum:0},weight=trajectoryWeight(row);cell.count++;cell.weight_sum+=weight;cell.sum+=row.value*weight;actions[row.worker]=cell;output[key]=actions;}return output;}
function meanByAction(actions){return Object.fromEntries(Object.entries(actions).map(([worker,value])=>[worker,value.weight_sum?value.sum/value.weight_sum:0]));}
function posteriorValues(groups,globalMeans,priorStrength){return Object.fromEntries(Object.entries(groups).map(([key,actions])=>[key,Object.entries(actions).map(([worker,value])=>({worker,count:value.count,effective_weight:round(value.weight_sum),mean:round((value.sum+priorStrength*Number(globalMeans[worker]||0))/(value.weight_sum+priorStrength))})).sort((left,right)=>right.mean-left.mean||right.effective_weight-left.effective_weight||left.worker.localeCompare(right.worker))]));}
function valueForWorker(worker,exact,backoff,global){for(const[value_source,values]of[['exact',exact],['backoff',backoff],['global',global]]){const value=values.find(item=>String(item?.worker||'')===worker);if(value)return{worker,estimated_value:round(Number(value.mean||0)),support:Number(value.count||0),value_source};}return{worker,estimated_value:.5,support:0,value_source:'unobserved'};}
function backoffState(state){return{node_count:state.node_count,assessment:state.assessment,verification:state.verification,last_worker:state.last_worker,last_changed:state.last_changed,remaining_budget:state.remaining_budget};}
function serializeState(value){return Object.keys(value).sort().map(key=>`${key}=${String(value[key])}`).join('|');}
function assessmentStatus(value){const status=String(value?.assessment||'none').toLowerCase();return['supported','partial','unresolved'].includes(status)?status:value?'other':'none';}
function verificationStatus(value){if(!value)return'none';if(value.overflow===true||value.requires_refine===true)return'overflow';return value.complete===true?'complete':'incomplete';}
function changeStatus(value){return value===true?'yes':value===false?'no':'unknown';}
function noProgressDiscoveryStreak(steps){let count=0;for(let index=steps.length-1;index>=0;index--){const step=steps[index];if(!DISCOVERY_WORKERS.has(String(step?.worker||''))||step?.changed!==false)break;count++;}return count;}
function transitionAdjustment(turn,index,before={}){const worker=String(turn?.decision?.worker||''),changed=turn?.result?.changed,after=turn?.result?.snapshot||before;let value=-.003*(index+1);if(DISCOVERY_WORKERS.has(worker)){const nodeGain=array(after.memory_nodes).length-array(before.memory_nodes).length,edgeGain=array(after.memory_edges).length-array(before.memory_edges).length;value+=changed===false?-.08:Math.min(.07,.012*Math.max(0,nodeGain)+.006*Math.max(0,edgeGain)+.01);}else if(worker==='assess'){const prior=before.assessment||before.answer_brief||null,next=after.assessment||null;if(prior&&assessmentSignature(prior)===assessmentSignature(next))value-=.07;else{const coveredGain=array(next?.covered_aspects).length-array(prior?.covered_aspects).length,missingReduction=array(prior?.missing_information).length-array(next?.missing_information).length;value+=.015+.008*Math.max(0,coveredGain)+.01*Math.max(0,missingReduction)+.004*array(next?.answer_focus).length;if(next?.assessment==='supported')value+=.02;}}else if(worker==='refine'){const beforeCount=array(before.memory_nodes).length,afterCount=array(after.memory_nodes).length;if(changed===false)value-=.05;else value+=beforeCount>16&&afterCount<=16?.06:.015;}else if(worker==='verify')value+=after.verification?.complete===true?.04:-.04;else if(worker==='answer')value+=.01;return value;}
function assessmentSignature(value){return stableJson({assessment:value?.assessment||null,relevant_memory_ids:array(value?.relevant_memory_ids).map(String).sort(),covered_aspects:array(value?.covered_aspects).map(String).sort(),missing_information:array(value?.missing_information).map(String).sort(),answer_focus:array(value?.answer_focus).map(item=>({aspect:String(item?.aspect||''),memory_ids:array(item?.memory_ids).map(String).sort(),source_refs:array(item?.source_refs).map(String).sort()}))});}
function trainingExclusionReason(result){
  if(result?.kind!=='score')return'non_score_result';
  if(result.judge_infrastructure_failure===true)return'judge_infrastructure_failure';
  if(result.memory_incomplete===true)return'memory_incomplete';
  if(result.status!=='scored'||!Number.isFinite(Number(result.score)))return'unscored_or_non_numeric';
  const investigation=result.retrieval_trace?.investigation,turns=investigation?.turns;
  if(!Array.isArray(turns)||!turns.length||String(investigation.termination_reason||'')!=='answer_selected'||String(turns.at(-1)?.decision?.worker||'')!=='answer'||!turns.every(validTrainingTurn))return'incomplete_or_invalid_trajectory';
  return null;
}
function actionPolicyComparisonQuality(model){
  if(model.version!==ACTION_POLICY_MODEL_VERSION)return{mode:'legacy_unspecified',within_question_fraction:null,reliability:1};
  const counts=model.training_scope?.comparison_mode_counts||{},within=Math.max(0,Number(counts.within_question)||0),cross=Math.max(0,Number(counts.cross_case_query_type)||0),raw=Math.max(0,Number(counts.calibrated_raw_score)||0),total=within+cross+raw,fraction=total?within/total:0;
  return{mode:fraction===1?'within_question':fraction>0?'mixed':cross>0?'cross_case_only':'calibrated_raw_only',within_question_fraction:round(fraction),reliability:round(.2+.8*fraction)};
}
function validTrainingTurn(turn){const worker=String(turn?.decision?.worker||'');return['search','context','trace','assess','refine','verify','answer'].includes(worker)&&Boolean(turn?.result?.snapshot&&typeof turn.result.snapshot==='object'&&!Array.isArray(turn.result.snapshot));}
function hierarchicalComparisons(trajectories){
  const byQuestion=groupStats(trajectories,item=>item.comparison_group),byType=groupStats(trajectories,item=>item.query_type),output=new Map();
  for(const trajectory of trajectories){const question=byQuestion.get(trajectory.comparison_group),type=byType.get(trajectory.query_type);let mode,baseline;
    if(question.count>=2){mode='within_question';baseline=question.sum/question.count;}
    else if(type.count>=2){mode='cross_case_query_type';baseline=(type.sum-trajectory.final_value)/(type.count-1);}
    else{mode='calibrated_raw_score';baseline=.5;}
    output.set(trajectory,{mode,relative_return:clamp(.5+(trajectory.final_value-baseline),0,1)});
  }
  return output;
}
function groupStats(values,keyFor){const cells=new Map();for(const item of values){const key=keyFor(item),cell=cells.get(key)||{sum:0,count:0};cell.sum+=item.final_value;cell.count++;cells.set(key,cell);}return cells;}
function formatCounts(value){return Object.entries(value).map(([key,count])=>`${key}=${count}`).join(', ');}
function trajectoryWeight(row){const probability=Number(row?.conditional_probability||0);return probability>0?Math.min(6,1/probability):1;}
function hashIdentifier(value){return sha256(String(value)).slice(0,16);}
function sha256(value){return createHash('sha256').update(value).digest('hex');}
function randomUnit(value){return Number.parseInt(sha256(value).slice(0,13),16)/0x10000000000000;}
function stableJson(value){if(Array.isArray(value))return`[${value.map(stableJson).join(',')}]`;if(value&&typeof value==='object')return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;return JSON.stringify(value);}
function bucket(value,limits,labels){const number=Number(value)||0;for(let index=0;index<limits.length;index++)if(number<=limits[index])return labels[index];return labels.at(-1);}
function normalizeQueryType(value){const type=String(value||'unknown').normalize('NFKC').trim().toLowerCase();return type&&type.length<=80?type:'unknown';}
function clamp(value,min,max){return Math.min(max,Math.max(min,value));}
function round(value){return Math.round((Number(value)||0)*10000)/10000;}
function array(value){return Array.isArray(value)?value:[];}
