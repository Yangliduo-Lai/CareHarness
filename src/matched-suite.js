import { randomUUID } from 'node:crypto';
import { MATCHED_EVALUATION_MODE } from './careharness-contract.js';
import { careHarnessResultRows } from './matched-experiment.js';
import { MEMORY_PIPELINE_VERSION } from './experiments.js';
import { FAILURE_TAXONOMY } from './failure-attribution.js';
import { medMemorySubjectId } from './adapters/medmemory.js';

const TERMINAL_EXPERIMENT_STATUSES=new Set(['completed','partial','failed','cancelled']);
const TERMINAL_SUITE_STATUSES=new Set(['completed','failed','cancelled']);
const CONDITIONS=['clean','noise'];

/** Coordinates a formal matched MedMemoryBench run inside the same server process.
 * This deliberately reuses ModelRegistry session credentials configured by the UI.
 */
export class MatchedSuiteController{
  constructor(store,harness,models,{poll_interval_ms=250}={}){this.store=store;this.harness=harness;this.models=models;this.pollInterval=Math.max(10,Number(poll_interval_ms)||250);this.active=new Map();for(const suite of this.store.listMatchedSuites(100).filter(item=>['queued','running','cancelling'].includes(item.status)))this.store.saveMatchedSuite({...suite,status:'failed',current_step_id:null,active_experiment_id:null,error:'服务器进程重启：内存 API Key 和活动 Experiment 不可恢复，请重新预检后启动。',steps:suite.steps.map(step=>step.status==='running'?{...step,status:'failed',error:'服务器进程重启'}:step)});}

  preflight(input={}){
    const config=normalizeConfig(input),errors=[],warnings=[],scopes=[];
    const modelState=this.models.state(),requiredComponents=new Set(['judge','scoring_judge','investigation_policy']);
    for(const condition of config.conditions){
      const split=config.split,persona=config.persona,noise=condition==='noise';
      try{
        const data=this.harness.adapters.medmemorybench.load({persona_id:persona,noise,start_session:1,max_session:100}),cases=this.harness.adapters.medmemorybench.cases(data),requiredThrough=Math.max(...cases.map(item=>Number(item.metadata?.query_session)).filter(Number.isFinite)),subjectId=medMemorySubjectId(persona,noise),scope=this.store.memoryScope(subjectId),ready=isReadyGraphScope(scope,{persona,noise,requiredThrough});
        if(!cases.length)errors.push(`${split} / ${condition} / Persona ${persona} 没有可冻结的测试题。`);
        scopes.push({split,condition,persona_id:persona,noise,subject_id:subjectId,query_count:cases.length,available_query_count:cases.length,query_selection_policy:'adapter_complete_scope',observation_count:data.observations.length,required_through_session:requiredThrough,current_memory_scope:scope||null,graph_ready:ready,preparation:ready?'skip_existing_unified_memory_graph':config.prepare_snapshots?'build_unified_memory_graph':'blocked_missing_unified_memory_graph'});
        if(!ready&&config.prepare_snapshots){requiredComponents.add('extractor');requiredComponents.add('router');requiredComponents.add('relation_classifier');}
        if(!ready&&!config.prepare_snapshots)errors.push(`${split} / ${condition} 缺少完整的统一 Memory Graph；请开启“准备 Memory Graph”。`);
      }catch(error){errors.push(`${split} / ${condition} 数据预检失败：${String(error.message||error)}`);}
    }
    const modelChecks=[...requiredComponents].map(component=>modelCheck(modelState,component));
    for(const check of modelChecks)if(!check.ready)errors.push(`${check.component}：${check.reason}`);
    warnings.push(`本次 suite 将对 ${scopes.length} 个 Memory scope 运行 adapter 完整 query 集，独立题目最多 ${config.query_concurrency} 题并发${config.prepare_snapshots?'，并按需准备缺失的统一 Memory Graph':''}，可能产生较长延迟和模型费用。`);
    return{version:'medmemory-matched-suite.v9',ok:errors.length===0,errors,warnings,config,models:modelChecks,scopes,information_boundary:{runtime_gold_or_judge_metadata:false,static_query_preanalysis:false,post_answer_offline_diagnosis:config.split==='dev',heldout_details_sealed:config.split==='heldout'},method_claims:{persistent_unified_memory_graph:true,source_anchored_semantic_state:true,session_membership_is_not_reasoning_edge:true,source_grounded_noncausal_relation_classifier:true,policy_owned_investigation_state:true,extensible_worker_registry:true,parallel_independent_queries:true,strict_causality_claimed:false,learned_policy_claimed:false},estimated_experiments:scopes.filter(scope=>!scope.graph_ready&&config.prepare_snapshots).length+scopes.length};
  }

  launch(input={}){
    if(this.list(100).some(item=>['queued','running','cancelling'].includes(item.status)))throw new Error('已有 matched suite 正在运行；请先等待完成或取消。');
    const preflight=this.preflight(input);if(!preflight.ok)throw new Error(`Matched suite 预检未通过：${preflight.errors.join('；')}`);
    const now=new Date().toISOString(),id=randomUUID(),steps=buildSteps(preflight),suite={id,status:'queued',version:'medmemory-matched-suite.v9',config:preflight.config,preflight,steps,result:null,current_step_id:null,active_experiment_id:null,created_at:now,updated_at:now};
    this.store.saveMatchedSuite(suite);const controller={cancelled:false,active_experiment_id:null};this.active.set(id,controller);setTimeout(()=>{void this.#execute(id,controller).catch(error=>this.#fail(id,error));},0);return this.get(id);
  }

  list(limit=50){return this.store.listMatchedSuites(limit).map(item=>suiteSummary(item));}
  get(id){const suite=this.store.getMatchedSuite(id);if(!suite)return null;const live=suite.active_experiment_id?this.#experimentSummary(suite.active_experiment_id):null;return{...suite,progress:suiteProgress(suite),live_experiment:live?experimentProgress(live):null};}
  cancel(id){const suite=this.store.getMatchedSuite(id);if(!suite)throw new Error('Matched suite not found');if(TERMINAL_SUITE_STATUSES.has(suite.status))return{ok:true,status:suite.status};const controller=this.active.get(id);if(controller)controller.cancelled=true;if(suite.active_experiment_id&&this.harness.active.has(suite.active_experiment_id)){try{this.harness.control(suite.active_experiment_id,'cancel');}catch{}}this.#save({...suite,status:'cancelling'});return{ok:true,status:'cancelling'};}

  async #execute(id,controller){
    let suite=this.store.getMatchedSuite(id);suite=this.#save({...suite,status:'running'});
    for(const step of suite.steps){
      if(controller.cancelled){this.#cancelRemaining(id);return;}
      if(['completed','skipped'].includes(step.status))continue;
      if(step.phase==='preflight'){this.#finishStep(id,step.id,{summary:{models:suite.preflight.models,scope_count:suite.preflight.scopes.length,query_counts:suite.preflight.scopes.map(scope=>scope.query_count)}});continue;}
      if(step.phase==='prepare_memory'){
        const scope=suite.preflight.scopes.find(item=>item.split===step.split&&item.condition===step.condition);
        if(scope.graph_ready){this.#finishStep(id,step.id,{status:'skipped',summary:{reason:'已存在完整兼容的统一 Memory Graph snapshot；未修改当前 Graph。',memory_scope:scope.current_memory_scope}});continue;}
        if(!await this.#runExperimentStep(id,step.id,{persona_id:step.persona_id,noise:step.noise,start_session:1,max_session:100,query_type:'__memory_build_only__',seed:suite.config.seed},controller))return;
        const current=this.store.memoryScope(step.subject_id);if(!isReadyGraphScope(current,{persona:step.persona_id,noise:step.noise,requiredThrough:scope.required_through_session}))throw new Error(`${step.label} 完成后仍未得到完整的统一 Memory Graph scope。`);
        this.#mergeStep(id,step.id,{summary:{memory_scope:current,claim:'single_atomic_versioned_memory_graph'}});continue;
      }
      if(step.phase==='careharness_run'){
        if(!await this.#runExperimentStep(id,step.id,{persona_id:step.persona_id,noise:step.noise,start_session:1,max_session:100,max_queries:step.query_count,score_only_current_memory:true,matched_experiment:true,matched_strict_full_suite:true,evaluation_mode:MATCHED_EVALUATION_MODE,split:step.split,seed:suite.config.seed,candidate_budget:suite.config.candidate_budget,investigation_budget:suite.config.investigation_budget,query_concurrency:suite.config.query_concurrency},controller))return;
        const finished=this.harness.get(this.store.getMatchedSuite(id).steps.find(item=>item.id===step.id).experiment_id);if(finished?.status!=='completed')throw new Error(`${step.label} 未完整完成：${finished?.status||'unknown'}`);
        const row=careHarnessResultRows([finished])[0];if(row.query_count!==step.query_count)throw new Error(`${step.label} 只得到 ${row.query_count}/${step.query_count} 个正式分数。`);
        const visibleRow=step.split==='heldout'?Object.fromEntries(Object.entries(row).filter(([key])=>key!=='by_task')):row;
        this.#mergeStep(id,step.id,{summary:{...visibleRow,persona_id:step.persona_id,condition:step.condition}});continue;
      }
      if(step.phase==='taxonomy'){
        this.#startStep(id,step.id);const current=this.store.getMatchedSuite(id),careHarnessRun=current.steps.find(item=>item.phase==='careharness_run'&&item.split===step.split&&item.condition===step.condition),report=this.harness.wrongAnswerExport(careHarnessRun.experiment_id).failure_taxonomy;
        if(step.split!=='dev')throw new Error('Held-out scope must never enter failure attribution');
        this.#finishStep(id,step.id,{summary:{...report,scope:{split:step.split,condition:step.condition,persona_id:step.persona_id},usage:'dev_patch_design_allowed_after_answer'}});continue;
      }
      if(step.phase==='acceptance'){
        this.#startStep(id,step.id);const current=this.store.getMatchedSuite(id),careHarnessSteps=current.steps.filter(item=>item.phase==='careharness_run'),rows=careHarnessSteps.map(item=>item.summary),taxonomy=current.steps.filter(item=>item.phase==='taxonomy').map(item=>item.summary),complete=careHarnessSteps.length===current.preflight.scopes.length&&careHarnessSteps.every(run=>run.summary?.query_count===run.query_count&&!run.summary?.mock),heldout=current.config.split==='heldout',nextAction=!complete?'先修复不完整的 Static CareHarness run；不得接受 patch。':heldout?'只将聚合 average score 交给一次性接受/回退判断；不得查看逐题或继续调参。':'可从 dev 的聚合 failure taxonomy 设计一个透明、题型自适应且不含单题内容的 patch。';
        this.#finishStep(id,step.id,{summary:{selected_run_contract_complete:complete,patch_evaluated:false,decision:'not_applicable_no_patch_yet',next_action:nextAction,training_allowed:false,acceptance_requirements:['held-out average score 严格提高','完整 query 集','非 Mock','无隐藏字段'],taxonomy}});continue;
      }
    }
    suite=this.store.getMatchedSuite(id);const careHarnessSteps=suite.steps.filter(item=>item.phase==='careharness_run'),careHarnessRows=careHarnessSteps.map(item=>item.summary),taxonomy=suite.steps.filter(item=>item.phase==='taxonomy').map(item=>item.summary),includedSplits=unique(suite.preflight.scopes.map(item=>item.split)),includedConditions=unique(suite.preflight.scopes.map(item=>item.condition)),selectedRunComplete=careHarnessRows.length===suite.preflight.scopes.length&&careHarnessSteps.every(run=>run.summary?.query_count===run.query_count&&!run.summary?.mock),result={careharness_rows:careHarnessRows,taxonomy_reports:taxonomy,experiment_ids:suite.steps.filter(item=>item.experiment_id).map(item=>item.experiment_id),training_started:false,completion:{requested_scopes:selectedRunComplete,selected_run_contract_complete:selectedRunComplete,scope_count:suite.preflight.scopes.length,included_splits:includedSplits,included_conditions:includedConditions,clean_noise:CONDITIONS.every(condition=>includedConditions.includes(condition)),reproducible_manifests:careHarnessRows.every(item=>item?.reproducible),optimization_patch_evaluated:false}};
    this.#save({...suite,status:'completed',current_step_id:null,active_experiment_id:null,result});this.active.delete(id);
  }

  async #runExperimentStep(suiteId,stepId,config,controller){
    this.#startStep(suiteId,stepId);const launched=this.harness.launch('medmemorybench',config);controller.active_experiment_id=launched.id;this.#mergeStep(suiteId,stepId,{experiment_id:launched.id});this.#save({...this.store.getMatchedSuite(suiteId),active_experiment_id:launched.id});
    const done=await this.#waitForExperiment(launched.id,controller);controller.active_experiment_id=null;this.#save({...this.store.getMatchedSuite(suiteId),active_experiment_id:null});
    if(controller.cancelled||done.status==='cancelled'){this.#cancelRemaining(suiteId);return false;}
    if(!['completed'].includes(done.status))throw new Error(`${done.id} 以 ${done.status} 结束${done.progress?.fatal_error?.message?`：${done.progress.fatal_error.message}`:''}`);
    this.#finishStep(suiteId,stepId,{summary:{experiment_status:done.status,progress:experimentProgress(done)}});return true;
  }
  async #waitForExperiment(experimentId,controller){for(;;){const experiment=this.#experimentSummary(experimentId);if(!experiment)throw new Error(`Experiment ${experimentId} not found`);if(TERMINAL_EXPERIMENT_STATUSES.has(experiment.status))return experiment;if(controller.cancelled&&this.harness.active.has(experimentId)){try{this.harness.control(experimentId,'cancel');}catch{}}await delay(this.pollInterval);}}
  #experimentSummary(id){return typeof this.harness.summary==='function'?this.harness.summary(id):this.harness.get(id);}
  #startStep(id,stepId){const suite=this.store.getMatchedSuite(id),steps=suite.steps.map(step=>step.id===stepId?{...step,status:'running',started_at:step.started_at||new Date().toISOString()}:step);this.#save({...suite,steps,current_step_id:stepId});}
  #finishStep(id,stepId,{status='completed',summary=null}={}){const suite=this.store.getMatchedSuite(id),steps=suite.steps.map(step=>step.id===stepId?{...step,status,summary:summary??step.summary,completed_at:new Date().toISOString()}:step);return this.#save({...suite,steps,current_step_id:null});}
  #mergeStep(id,stepId,patch){const suite=this.store.getMatchedSuite(id),steps=suite.steps.map(step=>step.id===stepId?{...step,...patch}:step);return this.#save({...suite,steps});}
  #cancelRemaining(id){const suite=this.store.getMatchedSuite(id),steps=suite.steps.map(step=>step.status==='running'?{...step,status:'cancelled',completed_at:new Date().toISOString()}:step.status==='pending'?{...step,status:'cancelled'}:step);this.#save({...suite,status:'cancelled',steps,current_step_id:null,active_experiment_id:null});this.active.delete(id);}
  #fail(id,error){const suite=this.store.getMatchedSuite(id);if(!suite)return;const message=String(error.message||error),steps=suite.steps.map(step=>step.id===suite.current_step_id?{...step,status:'failed',error:message,completed_at:new Date().toISOString()}:step);this.#save({...suite,status:'failed',steps,current_step_id:null,active_experiment_id:null,error:message});this.active.delete(id);}
  #save(suite){return this.store.saveMatchedSuite(suite);}
}

function normalizeConfig(input){
  if(Object.hasOwn(input,'modes'))throw new Error('modes 配置已删除；matched suite 固定运行 static_careharness。请移除 modes 后重试。');
  const allowed=new Set(['persona','dev_persona','split','conditions','prepare_snapshots','seed','candidate_budget','investigation_budget','query_concurrency']),unsupported=Object.keys(input).filter(key=>!allowed.has(key));if(unsupported.length)throw new Error(`不支持的 matched suite 配置：${unsupported.join(', ')}`);
  const conditions=unique((Array.isArray(input.conditions)?input.conditions:['clean']).map(value=>String(value).toLowerCase()));if(!conditions.length||conditions.some(value=>!CONDITIONS.includes(value)))throw new Error('conditions 仅支持 clean / noise。');
  const split=String(input.split||'dev').toLowerCase();if(!['dev','heldout'].includes(split))throw new Error('split 仅支持 dev / heldout。');
  return{persona:positiveInteger(input.persona??input.dev_persona??1,'persona'),split,conditions,prepare_snapshots:input.prepare_snapshots!==false,seed:integer(input.seed??42,'seed'),candidate_budget:positiveInteger(input.candidate_budget??24,'candidate_budget'),investigation_budget:positiveInteger(input.investigation_budget??6,'investigation_budget'),query_concurrency:boundedConcurrency(input.query_concurrency??4,'query_concurrency')};
}
function buildSteps(preflight){let ordinal=0;const next=value=>({ordinal:++ordinal,status:'pending',summary:null,error:null,started_at:null,completed_at:null,...value}),splits=unique(preflight.scopes.map(scope=>scope.split)).join('/'),conditions=unique(preflight.scopes.map(scope=>scope.condition)).join('/'),counts=preflight.scopes.map(scope=>scope.query_count).join('/'),steps=[next({id:'preflight',phase:'preflight',label:'方法、模型与数据预检',explanation:`冻结模型、adapter 完整 query 集（${counts}）、${conditions}、${splits}、seed、prompt、题型策略、统一 Memory Graph snapshot 与预算；运行时不读取 Gold/Judge metadata，也不做单题静态 query 预解析。`})];for(const scope of preflight.scopes)steps.push(next({id:`prepare-${scope.split}-${scope.condition}`,phase:'prepare_memory',label:`准备 ${scope.split} / ${scope.condition} 统一 Memory Graph`,explanation:'完整 Session → 原子 Memory Node → 多 family 标签 → 单一持久版本图；family 是节点属性。',...scope}));for(const scope of preflight.scopes)steps.push(next({id:`careharness-${scope.split}-${scope.condition}`,phase:'careharness_run',label:`${scope.split} / ${scope.condition} · Adaptive CareHarness`,explanation:'透明的题型级证据合同只规定所需证据角色；Investigation Policy 每轮仍根据原问题、当前信息和此前结果动态选择 Worker 与具体检索方向。',...scope,evaluation_mode:MATCHED_EVALUATION_MODE}));for(const scope of preflight.scopes.filter(item=>item.split==='dev'))steps.push(next({id:`taxonomy-${scope.split}-${scope.condition}`,phase:'taxonomy',label:`${scope.split} / ${scope.condition} failure attribution`,explanation:'答案冻结后按 raw Session → Memory Graph → Investigation → Answer → Scorer 做反事实检查；仅 dev failure 可用于 patch 设计。',...scope}));steps.push(next({id:'acceptance',phase:'acceptance',label:'自动接受/回退入口检查',explanation:'Held-out 仅公开聚合平均分并用于一次性接受/回退；不会启动 SFT/RL。'}));return steps;}
function modelCheck(state,component){const profileId=state.assignments?.[component]||state.assignments?.global||'offline-mock',profile=state.profiles.find(item=>item.id===profileId),provider=profile?.config?.provider||null,credential=profile?.credential||'missing',ready=Boolean(profile&&provider!=='mock'&&credential!=='missing');return{component,profile_id:profileId,name:profile?.name||null,provider,model:profile?.config?.model||null,temperature:Number(profile?.config?.temperature??0),credential,ready,reason:ready?null:!profile?'模型 profile 不存在':provider==='mock'?'动态 Investigation Policy 需要实时模型；Offline Mock 只能用于离线结构测试':'API Key 缺失；请先在“模型与 Provider”前端填写，本页会复用同一后端进程内存中的 Key'};}
function isReadyGraphScope(scope,{persona,noise,requiredThrough}){return Boolean(scope&&scope.benchmark==='medmemorybench'&&Number(scope.persona_id)===Number(persona)&&Boolean(scope.noise)===Boolean(noise)&&scope.memory_pipeline_version===MEMORY_PIPELINE_VERSION&&Number(scope.source_start_session)===1&&Number(scope.complete_through_session)>=Number(requiredThrough)&&scope.status==='completed'&&Number(scope.observation_failed||0)===0);}
function suiteProgress(suite){const terminal=suite.steps.filter(step=>['completed','skipped','failed','cancelled'].includes(step.status)).length,completed=suite.steps.filter(step=>['completed','skipped'].includes(step.status)).length;return{completed,total:suite.steps.length,terminal,percent:suite.steps.length?completed/suite.steps.length:0,current_step_id:suite.current_step_id};}
function suiteSummary(suite){return{id:suite.id,status:suite.status,config:suite.config,progress:suiteProgress(suite),current_step_id:suite.current_step_id,active_experiment_id:suite.active_experiment_id,created_at:suite.created_at,updated_at:suite.updated_at,error:suite.error||null};}
function experimentProgress(experiment){return{id:experiment.id,status:experiment.status,phase:experiment.progress?.phase||null,current:experiment.progress?.scoring_current||experiment.progress?.current||null,memory_completed:Number(experiment.progress?.completed||0),memory_total:Number(experiment.progress?.total||0),scored:Number(experiment.progress?.scored||0),query_total:Number(experiment.progress?.query_total||0),score:experiment.progress?.score??null,eta_seconds:experiment.progress?.eta_seconds??null};}
function unique(items){return[...new Set(items)];}function positiveInteger(value,name){const n=Number(value);if(!Number.isInteger(n)||n<1)throw new Error(`${name} must be a positive integer`);return n;}function boundedConcurrency(value,name){const n=positiveInteger(value,name);if(n>16)throw new Error(`${name} must be between 1 and 16`);return n;}function integer(value,name){const n=Number(value);if(!Number.isInteger(n))throw new Error(`${name} must be an integer`);return n;}function delay(ms){return new Promise(resolve=>setTimeout(resolve,ms));}

export const MATCHED_SUITE_TAXONOMY_CODES=Object.keys(FAILURE_TAXONOMY);
