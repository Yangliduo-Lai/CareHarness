import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchedSuiteController } from '../src/matched-suite.js';

const taxonomy={version:'careharness-failure-taxonomy.v1',total:1,failure_count:1,counts:{H1:1,H2:0,H3:0,H4:0,H5:0,H6:0,H7:0,M1:0,M2:0,M3:0,M4:0,M5:0,X1:0,X2:0,X3:0},axis:{harness:1,model_foundation:0,external:0},high_frequency_harness_failure:'H1',post_answer_only:true,runtime_gold_or_judge_metadata_used:false};

test('preflight blocks missing in-memory credentials before any experiment launches',()=>{
  const fixture=createFixture({credential:'missing'}),controller=new MatchedSuiteController(fixture.store,fixture.harness,fixture.models);
  const result=controller.preflight({conditions:['clean']});
  assert.equal(result.ok,false);assert.equal(result.version,'medmemory-matched-suite.v9');assert.deepEqual(result.scopes.map(scope=>scope.split),['dev']);assert.ok(result.errors.some(item=>item.includes('API Key 缺失')));assert.equal(fixture.harness.launches.length,0);
});

test('single-Persona preflight estimates one CareHarness run per selected condition',()=>{
  const fixture=createFixture(),controller=new MatchedSuiteController(fixture.store,fixture.harness,fixture.models),result=controller.preflight({dev_persona:1,conditions:['clean']});
  assert.equal(result.ok,true);assert.equal(Object.hasOwn(result.config,'modes'),false);assert.deepEqual(result.scopes.map(scope=>[scope.split,scope.condition,scope.persona_id]),[['dev','clean',1]]);assert.equal(result.estimated_experiments,2);assert.ok(result.models.some(item=>item.component==='relation_classifier'&&item.ready));
});

test('preflight requires a live Investigation Policy model',()=>{
  const fixture=createFixture(),live={id:'live',name:'live',credential:'session-memory',config:{provider:'openai',model:'qwen-test',temperature:0}},offline={id:'offline-mock',name:'Offline Mock',credential:'not-required',config:{provider:'mock',model:'careharness-rules-v1',temperature:0}},models={state(){return{assignments:{global:'live',investigation_policy:'offline-mock'},profiles:[live,offline]}}},controller=new MatchedSuiteController(fixture.store,fixture.harness,models),result=controller.preflight({conditions:['clean']});
  assert.equal(result.ok,false);assert.equal(result.models.find(item=>item.component==='investigation_policy').provider,'mock');assert.equal(result.models.find(item=>item.component==='investigation_policy').ready,false);assert.match(result.models.find(item=>item.component==='investigation_policy').reason,/Investigation Policy/);assert.ok(result.models.filter(item=>['judge','scoring_judge'].includes(item.component)).every(item=>item.provider==='openai'&&item.ready));
});

test('legacy modes config is rejected rather than silently mapped to CareHarness',()=>{
  const fixture=createFixture(),controller=new MatchedSuiteController(fixture.store,fixture.harness,fixture.models);
  assert.throws(()=>controller.preflight({modes:['static_careharness']}),/modes 配置已删除/);assert.throws(()=>controller.preflight({modes:['direct']}),/modes 配置已删除/);
  assert.throws(()=>controller.preflight({action_budget:6}),/不支持的 matched suite 配置/);
  assert.throws(()=>controller.preflight({extra_scope:true}),/不支持的 matched suite 配置/);
});

test('single-Persona Static CareHarness suite runs one Clean scope',async()=>{
  const fixture=createFixture();fixture.store.scopes.set('medmemory-persona-1-clean',readyScope(1,false));
  const controller=new MatchedSuiteController(fixture.store,fixture.harness,fixture.models,{poll_interval_ms:10}),launched=controller.launch({conditions:['clean'],prepare_snapshots:true}),done=await waitFor(()=>controller.get(launched.id),item=>['completed','failed'].includes(item.status));
  assert.equal(done.status,'completed');assert.equal(done.version,'medmemory-matched-suite.v9');assert.equal(done.preflight.estimated_experiments,1);assert.deepEqual(done.steps.filter(item=>item.phase==='prepare_memory').map(item=>item.id),['prepare-dev-clean']);assert.deepEqual(done.steps.filter(item=>item.phase==='careharness_run').map(item=>item.id),['careharness-dev-clean']);assert.deepEqual(done.steps.filter(item=>item.phase==='taxonomy').map(item=>item.id),['taxonomy-dev-clean']);
  assert.equal(fixture.harness.launches.length,1);assert.equal(fixture.harness.launches[0].persona_id,1);assert.equal(fixture.harness.launches[0].split,'dev');assert.equal(fixture.harness.launches[0].evaluation_mode,'static_careharness');assert.equal(fixture.harness.launches[0].query_concurrency,4);
  assert.equal(done.result.careharness_rows.length,1);assert.equal(done.result.careharness_rows[0].runtime,'static_careharness');assert.equal(Object.hasOwn(done.result.careharness_rows[0],'mode'),false);assert.equal(Object.hasOwn(done.result,'baseline_rows'),false);assert.equal(done.result.taxonomy_reports.length,1);assert.equal(done.result.taxonomy_reports[0].scope.split,'dev');assert.deepEqual(done.result.completion.included_splits,['dev']);assert.deepEqual(done.result.completion.included_conditions,['clean']);assert.equal(done.result.completion.scope_count,1);assert.equal(done.result.completion.requested_scopes,true);assert.equal(done.result.completion.selected_run_contract_complete,true);assert.equal(Object.hasOwn(done.result.completion,'comparison_complete'),false);assert.equal(done.result.completion.clean_noise,false);
  const acceptance=done.steps.at(-1).summary;assert.equal(acceptance.selected_run_contract_complete,true);assert.equal(Object.hasOwn(acceptance,'comparison_complete'),false);assert.deepEqual(acceptance.acceptance_requirements,['held-out average score 严格提高','完整 query 集','非 Mock','无隐藏字段']);
});

test('Clean and Noise run as two scopes for the same Persona',async()=>{
  const fixture=createFixture();fixture.store.scopes.set('medmemory-persona-1-clean',readyScope(1,false));
  const controller=new MatchedSuiteController(fixture.store,fixture.harness,fixture.models,{poll_interval_ms:10}),launched=controller.launch({conditions:['clean','noise'],prepare_snapshots:true});
  const done=await waitFor(()=>controller.get(launched.id),item=>['completed','failed'].includes(item.status));
  assert.equal(done.status,'completed');assert.equal(done.steps.find(item=>item.id==='prepare-dev-clean').status,'skipped');assert.equal(done.steps.find(item=>item.id==='prepare-dev-noise').status,'completed');
  assert.equal(fixture.harness.launches.filter(config=>!config.score_only_current_memory).length,1);assert.equal(fixture.harness.launches.filter(config=>config.score_only_current_memory).length,2);
  assert.ok(fixture.harness.launches.filter(config=>config.score_only_current_memory).every(config=>config.matched_experiment&&config.matched_strict_full_suite&&config.max_queries===97));
  assert.ok(fixture.harness.launches.every(config=>Object.hasOwn(config,'decision_gates')===false));
  assert.equal(done.result.careharness_rows.length,2);assert.ok(done.result.careharness_rows.every(row=>row.query_count===97&&row.mock===false));
  assert.deepEqual(done.result.taxonomy_reports.map(item=>[item.scope.split,item.scope.condition,item.usage]),[['dev','clean','dev_patch_design_allowed_after_answer'],['dev','noise','dev_patch_design_allowed_after_answer']]);
  assert.equal(done.result.completion.clean_noise,true);assert.equal(done.result.completion.scope_count,2);
  assert.equal(done.result.training_started,false);assert.equal(done.steps.at(-1).summary.patch_evaluated,false);
});

test('held-out Persona uses its complete adapter scope and never runs taxonomy',async()=>{
  const fixture=createFixture();fixture.store.scopes.set('medmemory-persona-2-clean',readyScope(2,false));
  const controller=new MatchedSuiteController(fixture.store,fixture.harness,fixture.models,{poll_interval_ms:10}),launched=controller.launch({persona:2,split:'heldout',conditions:['clean'],prepare_snapshots:false}),done=await waitFor(()=>controller.get(launched.id),item=>['completed','failed'].includes(item.status));
  assert.equal(done.status,'completed');assert.equal(done.preflight.scopes[0].query_count,100);assert.equal(done.steps.some(item=>item.phase==='taxonomy'),false);assert.equal(fixture.harness.launches[0].max_queries,100);assert.equal(fixture.harness.launches[0].split,'heldout');assert.equal(done.result.careharness_rows[0].query_count,100);assert.equal(Object.hasOwn(done.result.careharness_rows[0],'by_task'),false);assert.equal(done.result.taxonomy_reports.length,0);
});

test('suite cancellation propagates to the active experiment and cancels pending steps',async()=>{
  const fixture=createFixture({hold:true}),controller=new MatchedSuiteController(fixture.store,fixture.harness,fixture.models,{poll_interval_ms:10}),launched=controller.launch({conditions:['clean']});
  await waitFor(()=>controller.get(launched.id),item=>Boolean(item.active_experiment_id));const response=controller.cancel(launched.id);assert.equal(response.status,'cancelling');
  const done=await waitFor(()=>controller.get(launched.id),item=>item.status==='cancelled');assert.equal(done.status,'cancelled');assert.ok(done.steps.some(item=>item.status==='cancelled'));assert.ok(fixture.harness.cancelled.length>=1);
});

test('server restart terminalizes stale suites because process-memory keys cannot be recovered',()=>{
  const fixture=createFixture(),stale={id:'stale-suite',status:'running',config:{},steps:[{id:'one',status:'running'}],created_at:new Date().toISOString()};fixture.store.saveMatchedSuite(stale);
  new MatchedSuiteController(fixture.store,fixture.harness,fixture.models);const recovered=fixture.store.getMatchedSuite('stale-suite');assert.equal(recovered.status,'failed');assert.match(recovered.error,/进程重启/);assert.equal(recovered.steps[0].status,'failed');
});

function createFixture({credential='session-memory',hold=false}={}){
  const suites=new Map(),scopes=new Map(),experiments=new Map(),launches=[],cancelled=[];
  const store={scopes,saveMatchedSuite(value){const now=new Date().toISOString(),saved={...structuredClone(value),created_at:value.created_at||now,updated_at:now};suites.set(saved.id,saved);return structuredClone(saved)},getMatchedSuite(id){const value=suites.get(id);return value&&structuredClone(value)},listMatchedSuites(limit=50){return[...suites.values()].slice(-limit).reverse().map(value=>structuredClone(value))},memoryScope(id){const value=scopes.get(id);return value&&structuredClone(value)}};
  const adapter={load(config){return{persona_id:Number(config.persona_id||1),observations:Array.from({length:100},(_,index)=>({observation_id:`${config.persona_id}-${config.noise}-${index}`}))}},cases(data){const count=data.persona_id===2?100:97;return Array.from({length:count},(_,index)=>({score_id:`q-${index+1}`,metadata:{query_session:100}}))}};
  const harness={adapters:{medmemorybench:adapter},active:new Map(),launches,cancelled,launch(configName,config){assert.equal(configName,'medmemorybench');launches.push(structuredClone(config));const id=`experiment-${launches.length}`,queryCount=config.score_only_current_memory?Number(config.max_queries||97):0,experiment={id,status:hold?'running':'completed',config:{...structuredClone(config),matched_manifest:config.matched_experiment?{manifest_hash:`manifest-${id}`,split:config.split}:undefined},progress:{phase:config.score_only_current_memory?'finished':'memory_build',completed:config.score_only_current_memory?0:100,total:config.score_only_current_memory?0:100,scored:queryCount,query_total:queryCount,score:config.score_only_current_memory?1:null},results:config.score_only_current_memory?Array.from({length:queryCount},(_,index)=>({kind:'score',status:'scored',score_id:`q-${index+1}`,task:'entity_exact_match',score:1,is_correct:true,mock:false})):[]};experiments.set(id,experiment);if(hold)this.active.set(id,{status:'running'});else if(!config.score_only_current_memory)scopes.set(`medmemory-persona-${config.persona_id}-${config.noise?'with-noise':'clean'}`,readyScope(config.persona_id,config.noise));return structuredClone(experiment)},get(id){const value=experiments.get(id);return value&&structuredClone(value)},control(id,action){assert.equal(action,'cancel');cancelled.push(id);this.active.delete(id);const experiment=experiments.get(id);experiment.status='cancelled';return{ok:true,status:'cancelled'}},wrongAnswerExport(){return{failure_taxonomy:structuredClone(taxonomy)}}};
  const profile=id=>({id,name:id,credential,config:{provider:'openai',model:'gpt-test',temperature:0}}),models={state(){return{assignments:{global:'live'},profiles:[profile('live')]}}};
  return{store,harness,models};
}
function readyScope(persona,noise){return{subject_id:`medmemory-persona-${persona}-${noise?'with-noise':'clean'}`,benchmark:'medmemorybench',persona_id:persona,noise,memory_pipeline_version:'unified-memory-graph-v17-semantic-source-anchors',source_start_session:1,complete_through_session:100,status:'completed',observation_failed:0};}
async function waitFor(read,predicate,timeout=1500){const started=Date.now();for(;;){const value=read();if(predicate(value))return value;if(Date.now()-started>timeout)throw new Error('timed out');await new Promise(resolve=>setTimeout(resolve,10));}}
