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

export function explicitDiagnosticResumePlan(source,{benchmark,config,cases,memorySnapshot}={}){
  const orderedCases=Array.isArray(cases)?cases:[];
  if(!source)throw new Error('Explicit resume source experiment was not found');
  if(source.benchmark!==benchmark||source.config?.score_only_current_memory!==true)throw new Error('Explicit resume source is not a compatible score-only experiment');
  if(Number(source.config?.persona_id||1)!==Number(config?.persona_id||1)||Boolean(source.config?.noise)!==Boolean(config?.noise))throw new Error('Explicit resume source uses a different Persona or noise scope');
  if(source.config?.memory_pipeline_version!==config?.memory_pipeline_version||source.config?.memory_scope_key!==config?.memory_scope_key)throw new Error('Explicit resume source uses a different Memory Graph pipeline or scope');
  const sourceFingerprint=String(source.config?.current_memory_snapshot?.fingerprint||''),currentFingerprint=String(memorySnapshot?.fingerprint||'');
  if(!sourceFingerprint||sourceFingerprint!==currentFingerprint)throw new Error('Explicit resume source uses a different Memory Graph snapshot');
  if(String(source.config?.evaluation_mode||'')!==String(config?.evaluation_mode||''))throw new Error('Explicit resume source uses a different evaluation mode');
  if(stableJson(resumeModelIdentity(source.config?.resolved_models))!==stableJson(resumeModelIdentity(config?.resolved_models)))throw new Error('Explicit resume source uses different Answer, Policy, or Judge models');
  const currentIds=new Set(orderedCases.map(item=>String(item.score_id))),scores=new Map();
  for(const item of source.results||[]){
    const id=String(item?.score_id||'');
    if(!currentIds.has(id)||scores.has(id)||!reusableDiagnosticScore(item))continue;
    scores.set(id,item);
  }
  const reusableScores=orderedCases.map(item=>scores.get(String(item.score_id))).filter(Boolean),reusedIds=new Set(reusableScores.map(item=>String(item.score_id)));
  return{reusable_scores:reusableScores,pending_cases:orderedCases.filter(item=>!reusedIds.has(String(item.score_id)))};
}

function reusableScore(item,manifestHash){
  return Boolean(item?.kind==='score'&&item.status==='scored'&&!item.memory_incomplete&&!item.judge_infrastructure_failure&&Number.isFinite(item.score)&&typeof item.is_correct==='boolean'&&item.matched_manifest_hash===manifestHash);
}

function reusableDiagnosticScore(item){
  return Boolean(item?.kind==='score'&&item.status==='scored'&&!item.memory_incomplete&&!item.judge_infrastructure_failure&&Number.isFinite(item.score)&&typeof item.is_correct==='boolean');
}

function resumeModelIdentity(models={}){
  const project=value=>({provider:value?.provider||null,base_url:value?.base_url||null,model:value?.model||null,temperature:value?.temperature??null,max_tokens:value?.max_tokens??null});
  return Object.fromEntries(['global','investigation_policy','judge','scoring_judge'].map(key=>[key,project(models?.[key])]));
}

function stableJson(value){
  if(Array.isArray(value))return`[${value.map(stableJson).join(',')}]`;
  if(value&&typeof value==='object')return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
