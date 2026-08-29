export const EXPERIMENT_RESUME_VERSION='careharness-resume.v1';

export function memoryResumeStart(current,expectedScopeKey,maxSession=100){
  const complete=Number(current?.complete_through_session||0),compatible=current?.memory_pipeline_version==='unified-memory-graph-v17-semantic-source-anchors'&&current?.memory_scope_key===expectedScopeKey;
  return compatible&&Number.isInteger(complete)&&complete>0&&complete<maxSession?complete+1:1;
}

export function checkpointSourceCompatible(experiment,{benchmark,config,scopeKey}){
  return Boolean(experiment&&!experiment.config?.score_only_current_memory&&experiment.benchmark===benchmark&&Number(experiment.config?.persona_id||1)===Number(config?.persona_id||1)&&Boolean(experiment.config?.noise)===Boolean(config?.noise)&&experiment.config?.memory_pipeline_version==='unified-memory-graph-v17-semantic-source-anchors'&&experiment.config?.memory_scope_key===scopeKey);
}

export function queryResumePlan(experiments,{benchmark,manifest,cases}){
  const manifestHash=String(manifest?.manifest_hash||''),orderedCases=Array.isArray(cases)?cases:[],currentIds=new Set(orderedCases.map(item=>String(item.score_id))),scores=new Map(),sources=[];
  if(!manifestHash)return{reusable_scores:[],pending_cases:orderedCases,source_experiment_ids:[]};
  for(const experiment of experiments||[]){
    if(experiment?.benchmark!==benchmark||experiment.config?.score_only_current_memory!==true||experiment.config?.matched_manifest?.manifest_hash!==manifestHash)continue;
    let used=false;
    for(const item of experiment.results||[]){
      const id=String(item?.score_id||'');
      if(!currentIds.has(id)||scores.has(id)||!reusableScore(item,manifestHash))continue;
      scores.set(id,item);used=true;
    }
    if(used)sources.push(experiment.id);
  }
  const reusable=orderedCases.map(item=>scores.get(String(item.score_id))).filter(Boolean),reusedIds=new Set(reusable.map(item=>String(item.score_id)));
  return{reusable_scores:reusable,pending_cases:orderedCases.filter(item=>!reusedIds.has(String(item.score_id))),source_experiment_ids:sources};
}

function reusableScore(item,manifestHash){
  return Boolean(item?.kind==='score'&&item.status==='scored'&&!item.memory_incomplete&&!item.judge_infrastructure_failure&&Number.isFinite(item.score)&&typeof item.is_correct==='boolean'&&item.matched_manifest_hash===manifestHash);
}
