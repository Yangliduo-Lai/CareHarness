import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNoHiddenRuntimeInput,buildAdaptiveInvestigationContext,buildDiagnosticInvestigationContext,buildMatchedManifest,fallbackInvestigationPolicyDecision,selectMatchedQueryCases,validateInvestigationPolicyDecision } from '../src/matched-experiment.js';
import { MATCHED_EVALUATION_MODE } from '../src/careharness-contract.js';
import { medLoCoMoInvestigationStrategy,medMemoryInvestigationStrategy } from '../src/prompts.js';

const model={provider:'dashscope',base_url:'https://example.invalid',model:'same-model',temperature:0,max_tokens:1200};
const embedding={provider:'local',model:'Xenova/bge-small-zh-v1.5',base_model:'BAAI/bge-small-zh-v1.5',pooling:'cls',normalized:true};
const manifestInput={noise:false,persona_id:1,query_ids:['q-1','q-2','q-3'],expected_query_count:3,memory_snapshot:{fingerprint:'f'.repeat(64),memory_node_count:100,edge_count:40,complete_through_session:100},memory_pipeline_version:'unified-memory-graph-v17-semantic-source-anchors',models:{answer:model,scoring_judge:model,investigation_policy:model,embedding},seed:42,candidate_budget:24,investigation_budget:6};
const memory=(memory_id,text,extra={})=>({memory_id,observation_id:`o-${memory_id}`,subject_id:'p1',text,source_type:'patient',episode_id:'session-1',turn_id:'1',event_time:'2025-01-01',certainty:1,polarity:'affirmed',families:['PE'],status:'active',version:1,version_chain:[],operation:'ADD',...extra});

test('matched manifest freezes the unified graph and adaptive investigation architecture',()=>{
  const left=buildMatchedManifest(manifestInput),right=buildMatchedManifest(manifestInput);
  assert.equal(left.version,'medmemory-matched-experiment.v33-classified-retrieval-official-answer');assert.equal(left.manifest_hash,right.manifest_hash);assert.equal(left.information_policy.query_classifier_question_only,true);assert.equal(left.information_policy.predicted_query_type_controls_retrieval,true);assert.equal(left.information_policy.official_query_type_hidden_from_retrieval_policy,true);assert.equal(left.information_policy.official_query_type_controls_answer_prompt,true);assert.equal(left.information_policy.public_query_type_strategy_profiles,true);assert.equal(left.information_policy.strategy_profiles_contain_case_content,false);assert.equal(left.information_policy.oracle_teacher_runtime_separated,true);assert.equal('offline_strategy_teacher' in left.information_policy,false);assert.equal(left.policy_artifacts.offline_student.status,'loaded_builtin');assert.match(left.policy_artifacts.offline_student.student_artifact.artifact_hash,/^[a-f0-9]{64}$/u);assert.match(left.policy_artifacts.offline_student.source_teacher_artifact.artifact_hash,/^[a-f0-9]{64}$/u);assert.equal(left.policy_artifacts.offline_student.strategy_profiles.content_hash,left.policy_artifacts.offline_student.compiled_strategy.profile_hash);assert.equal(left.policy_artifacts.offline_student.runtime_overlap.gold_answers,false);assert.equal(left.policy_artifacts.offline_student.runtime_overlap.judge_metadata,false);assert.equal(left.information_policy.offline_student_policy_status,'loaded_builtin');assert.equal(left.information_policy.offline_student_runtime_overlap.oracle_trajectories,false);assert.equal(left.information_policy.semantic_shortest_path_trace,true);assert.equal(left.information_policy.deterministic_question_temporal_gate,true);assert.equal(left.information_policy.persistent_refine_boundary,true);assert.equal(left.information_policy.hybrid_lexical_embedding_search,true);assert.equal(left.information_policy.state_update_answer_selected_memory_only,true);assert.equal(left.information_policy.state_update_answer_excludes_assessor_artifacts,true);assert.equal(left.information_policy.state_projection_conservative_refine,true);assert.equal(left.information_policy.relative_date_documentation_lag_days,30);assert.equal(left.information_policy.patient_profile_query_independent,true);assert.equal(left.information_policy.patient_profile_includes_recent_navigation,false);assert.equal(left.information_policy.patient_profile_recent_sessions_disjoint,true);assert.equal(left.information_policy.answer_memory_edges_persistent_verified_source_grounded,true);assert.equal(left.information_policy.query_time_connections_are_graph_facts,false);assert.equal(left.information_policy.profile_backing_nodes_excluded_from_retrieval,true);assert.equal(left.information_policy.recent_session_window,3);assert.equal(left.information_policy.historical_memory_only_investigation,true);assert.equal(left.scheduling.query_concurrency,4);assert.equal(left.scheduling.independent_queries_parallel,true);assert.deepEqual(left.scheduling.per_query_dependency_order,['query_classifier','investigation','answer','judge']);
  assert.equal(left.memory_snapshot.pipeline_version,'unified-memory-graph-v17-semantic-source-anchors');assert.equal(left.memory_snapshot.memory_node_count,100);
  assert.equal(left.models.investigation_policy.model,'same-model');assert.equal(left.models.query_classifier.model,left.models.investigation_policy.model);assert.equal(left.models.relation_evaluator.model,left.models.answer.model);assert.equal(left.models.embedding.base_model,'BAAI/bge-small-zh-v1.5');
  assert.equal(left.prompt_versions.memory_extractor,'extractor.session-memory.v13-source-anchored-semantic-state');assert.equal(left.prompt_versions.memory_relation_classifier,'memory-relation-classifier.v1-source-grounded-noncausal');assert.equal(left.prompt_versions.query_classifier,'medmemory-query-classifier.v1-question-only');assert.equal(left.prompt_versions.investigation_policy,'careharness-investigation-policy.closed-loop.v30-quality-weighted-learning');assert.equal(left.prompt_versions.investigation_strategy,'medmemory-investigation-strategy.v2-auditable-offline-student');
  assert.equal(left.method_claims.persistent_unified_memory_graph,true);assert.equal(left.method_claims.policy_owned_investigation_state,true);assert.equal(left.method_claims.static_query_preanalysis,false);assert.equal(left.method_claims.runtime_query_type_classifier,true);assert.equal(left.method_claims.transparent_query_type_adaptation,true);assert.equal(left.method_claims.learned_policy_claimed,false);assert.equal(left.method_claims.offline_student_policy_loaded,true);assert.deepEqual(left.action_policy_learning,{enabled:false});assert.deepEqual(left.action_policy_exploration,{enabled:false,rate:0,seed:0,training_only:true});
  assert.equal(left.information_policy.runtime_gold_or_judge_metadata_allowed,false);
});

test('matched manifest rejects legacy memory snapshots and incomplete strict selections',()=>{
  assert.throws(()=>buildMatchedManifest({...manifestInput,memory_pipeline_version:'unified-memory-graph-v16-lexical-provenance'}),/exact v17/);
  assert.throws(()=>buildMatchedManifest({...manifestInput,query_ids:['q-1']}),/strict query scope/);
  assert.throws(()=>buildMatchedManifest({...manifestInput,models:{...manifestInput.models,relation_evaluator:{...model,model:'different'}}}),/exactly the Answer Model/);
});

test('Persona 1 dev query-type selection remains an outer experiment concern only',()=>{
  const cases=[{score_id:'eem-1',task:'entity_exact_match'},{score_id:'ig-1',task:'inference_generation'},{score_id:'mcd-1',task:'multi_hop_clinical_deduction'}],selection=selectMatchedQueryCases(cases,{split:'dev',persona_id:1,query_types:['inference_generation','multi_hop_clinical_deduction']});
  assert.deepEqual(selection.cases.map(item=>item.score_id),['ig-1','mcd-1']);assert.equal(selection.expected_query_count,2);
  assert.throws(()=>selectMatchedQueryCases(cases,{split:'heldout',persona_id:1,query_types:['inference_generation']}),/Persona 1 dev/);
});

test('explicit diagnostic retrieval requires an explicit worker instruction',()=>{
  const nodes=[memory('drug','患者服用二甲双胍。')],empty=buildDiagnosticInvestigationContext({item:{question:'患者服用什么药？'},memory_nodes:nodes,instruction:{}}),focused=buildDiagnosticInvestigationContext({item:{question:'患者服用什么药？'},memory_nodes:nodes,instruction:{search_terms:['二甲双胍']}});
  assert.equal(empty.evaluation_mode,MATCHED_EVALUATION_MODE);assert.deepEqual(empty.memory_nodes,[]);
  assert.deepEqual(focused.memory_nodes.map(node=>node.memory_id),['drug']);assert.equal(focused.trace.query_preanalysis_performed,false);
});

test('legacy comparator modes are rejected',()=>{
  for(const evaluation_mode of ['direct','long_context','bm25']){
    assert.throws(()=>buildMatchedManifest({...manifestInput,evaluation_mode}),/fixed to static_careharness/);
    assert.throws(()=>buildDiagnosticInvestigationContext({evaluation_mode,item:{question:'Q'}}),/fixed to static_careharness/);
  }
});

test('hidden post-answer fields never enter runtime inputs',()=>{
  assert.throws(()=>assertNoHiddenRuntimeInput({nested:{gold:'hidden'}}),/Forbidden post-answer field/);
  for(const key of ['expected_answer','answerExplanation','required_patient_info','nodes_for_validation','evaluation_focus','reasoning_chain'])assert.throws(()=>assertNoHiddenRuntimeInput({nested:{[key]:'hidden'}}),/Forbidden post-answer field/);
});

test('policy validation rejects an English objective with only broad source or family facets',()=>{
  const input={allowed_workers:['search']};
  assert.throws(()=>validateInvestigationPolicyDecision({worker:'search',information_status:'insufficient',instruction:{objective:'find relevant symptoms',source_types:['patient'],required_families:['PE']}},input),/too broad/);
  assert.doesNotThrow(()=>validateInvestigationPolicyDecision({worker:'search',information_status:'insufficient',instruction:{objective:'检索体重变化',source_types:['patient'],required_families:['PE']}},input));
  assert.doesNotThrow(()=>validateInvestigationPolicyDecision({worker:'search',information_status:'insufficient',instruction:{temporal:{operator:'exact',date_keys:['2025-01-02']}},rationale:'精确日期'},input));
  assert.doesNotThrow(()=>validateInvestigationPolicyDecision({worker:'search',information_status:'insufficient',instruction:{temporal:{operator:'exact',date_keys:['2132-09-23']}},rationale:'MedLoCoMo 精确日期'},input));
});

test('policy must encode an explicit-date Search as an executable temporal constraint',()=>{
  const input={allowed_workers:['search'],question:'患者自2024/1/5开始出现什么症状？',current_information:{memory_nodes:[]}};
  assert.throws(()=>validateInvestigationPolicyDecision({worker:'search',information_status:'insufficient',instruction:{objective:'查找2024-01-05的症状',search_terms:['2024-01-05','症状','开始']},rationale:'按日期查找'},input),/executable instruction\.temporal/);
  assert.doesNotThrow(()=>validateInvestigationPolicyDecision({worker:'search',information_status:'insufficient',instruction:{objective:'定位当天记录',temporal:{operator:'exact',date_keys:['2024-01-05']}},rationale:'按事件时间精确定位'},input));
});

test('policy relative-day Search must preserve base date and calendar offset',()=>{
  const input={allowed_workers:['search'],question:'患者在2024-01-15次日测得的空腹血糖值是多少？',current_information:{memory_nodes:[]}};
  assert.throws(()=>validateInvestigationPolicyDecision({worker:'search',information_status:'insufficient',instruction:{search_terms:['空腹血糖'],temporal:{operator:'exact',date_keys:['2024-01-15']}},rationale:'查找日期'},input),/offset_days/);
  assert.doesNotThrow(()=>validateInvestigationPolicyDecision({worker:'search',information_status:'insufficient',instruction:{search_terms:['空腹血糖'],temporal:{operator:'exact',base_date:'2024-01-15',offset_days:1}},rationale:'定位次日'},input));
  assert.doesNotThrow(()=>validateInvestigationPolicyDecision({worker:'search',information_status:'insufficient',instruction:{search_terms:['空腹血糖'],temporal:{operator:'range',start_date:'2024-01-16',end_date:'2024-02-15',prefer:'earliest'}},rationale:'在硬时间窗内优先最早记录'},input));
  assert.throws(()=>validateInvestigationPolicyDecision({worker:'search',information_status:'insufficient',instruction:{search_terms:['空腹血糖'],temporal:{operator:'range',start_date:'2024-01-01',end_date:'2024-08-31'}},rationale:'扩大范围'},input),/hard temporal gate/);
});

test('policy treats an explicit old date as a baseline for current status and two dates as a full range',()=>{
  const currentInput={allowed_workers:['search'],question:'设备在2023-02-04记录过一个基线值，目前的读数是多少？',current_information:{memory_nodes:[]}};
  assert.throws(()=>validateInvestigationPolicyDecision({worker:'search',information_status:'insufficient',instruction:{search_terms:['设备读数'],temporal:{operator:'exact',date_keys:['2023-02-04']}},rationale:'错误锁定基线'},currentInput),/lower-bound baseline/);
  assert.doesNotThrow(()=>validateInvestigationPolicyDecision({worker:'search',information_status:'insufficient',instruction:{search_terms:['设备读数'],temporal:{operator:'latest',start_date:'2023-02-04',prefer:'latest'}},rationale:'从基线向后找最新更新'},currentInput));
  assert.doesNotThrow(()=>validateInvestigationPolicyDecision({worker:'search',information_status:'insufficient',instruction:{objective:'从2023-02-04基线向后找目前读数',search_terms:['设备读数'],temporal:{operator:'latest',start_date:'2023-02-04',prefer:'latest'}},rationale:'目标文本也保留可执行时间方向'},currentInput));
  const currentFallback=fallbackInvestigationPolicyDecision(currentInput);assert.deepEqual(currentFallback.instruction.temporal,{operator:'latest',start_date:'2023-02-04',prefer:'latest'});
  const twoBaselineInput={allowed_workers:['search'],question:'设备在2023-02-04和2023-03-09都记录过基线，目前读数是多少？',current_information:{memory_nodes:[]}},twoBaselineFallback=fallbackInvestigationPolicyDecision(twoBaselineInput);assert.deepEqual(twoBaselineFallback.instruction.temporal,{operator:'latest',start_date:'2023-03-09',prefer:'latest'});
  const rangeInput={allowed_workers:['search'],question:'设备在2023-02-04至2023-03-09之间发生了哪些变化？',current_information:{memory_nodes:[]}};
  assert.throws(()=>validateInvestigationPolicyDecision({worker:'search',information_status:'insufficient',instruction:{search_terms:['设备变化'],temporal:{operator:'exact',date_keys:['2023-02-04']}},rationale:'只取起点'},rangeInput),/hard temporal gate/);
  assert.doesNotThrow(()=>validateInvestigationPolicyDecision({worker:'search',information_status:'insufficient',instruction:{search_terms:['设备变化'],temporal:{operator:'range',start_date:'2023-02-04',end_date:'2023-03-09'}},rationale:'覆盖完整区间'},rangeInput));
  const rangeFallback=fallbackInvestigationPolicyDecision(rangeInput);assert.deepEqual(rangeFallback.instruction.temporal,{operator:'range',start_date:'2023-02-04',end_date:'2023-03-09',prefer:'earliest'});
  const discreteInput={allowed_workers:['search'],question:'设备在2023-02-04和2023-03-09的读数有何差异？',current_information:{memory_nodes:[]}},discreteFallback=fallbackInvestigationPolicyDecision(discreteInput);assert.deepEqual(discreteFallback.instruction.temporal,{operator:'range',start_date:'2023-02-04',end_date:'2023-03-09',prefer:'earliest'});
});

test('policy turns temporal prose and first-occurrence intent into executable Search fields',()=>{
  const boundary={version:'careharness-refinement-boundary.v1',boundary_id:'refine-1',revision:1,excluded_memory_ids:['later'],temporal:{operator:'earliest',end_date:'2024-01-06',prefer:'earliest'},permanent:true},input={allowed_workers:['search'],question:'患者最初什么时候出现视物模糊？',current_information:{memory_nodes:[],refinement_boundary:boundary}};
  assert.throws(()=>validateInvestigationPolicyDecision({worker:'search',information_status:'insufficient',instruction:{objective:'search records prior to 2024-01-06',search_terms:['视物模糊']},rationale:'继续向前找'},input),/executable instruction\.temporal/);
  assert.throws(()=>validateInvestigationPolicyDecision({worker:'search',information_status:'insufficient',instruction:{objective:'search records prior to 2024-01-06',search_terms:['视物模糊'],temporal:{operator:'earliest'}},rationale:'继续向前找'},input),/persistent Refine boundary/);
  assert.doesNotThrow(()=>validateInvestigationPolicyDecision({worker:'search',information_status:'insufficient',instruction:{objective:'search records prior to 2024-01-06',search_terms:['视物模糊'],temporal:{operator:'earliest',end_date:'2024-01-06',prefer:'earliest'}},rationale:'继续向前找'},input));
  const fallback=fallbackInvestigationPolicyDecision(input);assert.deepEqual(fallback.instruction.temporal,boundary.temporal);
});

test('first-occurrence Refine persists the retained anchor date for unseen future nodes',()=>{
  const input={allowed_workers:['refine'],question:'患者的间歇性视力模糊最初出现于什么时间？',current_information:{memory_nodes:[memory('anchor','患者确认此前已有间歇性视物模糊。',{event_time:'2024-01-06'}),memory('later','患者后来仍有视物模糊。',{event_time:'2024-01-20'})],assessment:{relevant_memory_ids:['anchor']}}};
  assert.throws(()=>validateInvestigationPolicyDecision({worker:'refine',information_status:'insufficient',instruction:{objective:'保留最早锚点并排除2024-01-06之后记录',memory_ids:['anchor']},rationale:'固定边界'},input),/executable instruction\.temporal/);
  assert.doesNotThrow(()=>validateInvestigationPolicyDecision({worker:'refine',information_status:'insufficient',instruction:{objective:'保留最早锚点并排除2024-01-06之后记录',memory_ids:['anchor'],temporal:{operator:'earliest',end_date:'2024-01-06',prefer:'earliest'}},rationale:'固定边界'},input));
  const fallback=fallbackInvestigationPolicyDecision(input);assert.equal(fallback.worker,'refine');assert.deepEqual(fallback.instruction.temporal,{operator:'earliest',end_date:'2024-01-06',prefer:'earliest'});
});

test('first-occurrence Refine does not invent an end date when retained nodes have no event date',()=>{
  const input={allowed_workers:['refine'],question:'患者的症状最初是什么？',current_information:{memory_nodes:[memory('undated','患者描述了起初的症状。',{event_time:null})],assessment:{relevant_memory_ids:['undated']}}};
  const fallback=fallbackInvestigationPolicyDecision(input);assert.equal(fallback.worker,'refine');assert.deepEqual(fallback.instruction.temporal,{operator:'earliest',prefer:'earliest'});
  assert.doesNotThrow(()=>validateInvestigationPolicyDecision(fallback,input));
});

test('fallback Refine converts an exact persistent boundary into an executable date filter',()=>{
  const input={question:'在2024-01-18的记录中，患者的排尿情况出现了什么变化？',allowed_workers:['refine'],current_information:{temporal_gate:{hard:true,kind:'explicit_date',target_date:'2024-01-18',start_date:'2024-01-18',end_date:'2024-01-18'},refinement_boundary:{temporal:{operator:'exact',start_date:'2024-01-18',end_date:'2024-01-18'}},memory_nodes:[{memory_id:'dated',event_time:'2024-01-18'}]}};
  const fallback=fallbackInvestigationPolicyDecision(input);assert.equal(fallback.worker,'refine');assert.deepEqual(fallback.instruction.temporal,{operator:'exact',date_keys:['2024-01-18']});
});

test('fallback Refine trusts an already permanent temporal boundary for a current question',()=>{
  const input={question:'设备在2023-02-04记录过基线，目前读数是多少？',allowed_workers:['refine'],current_information:{refinement_boundary:{temporal:{operator:'exact',start_date:'2023-02-04',end_date:'2023-02-04'}},memory_nodes:[{memory_id:'baseline',event_time:'2023-02-04'}]}};
  const fallback=fallbackInvestigationPolicyDecision(input);
  assert.equal(fallback.worker,'refine');
  assert.doesNotThrow(()=>validateInvestigationPolicyDecision(fallback,input));
});

test('fallback Refine keeps a dated first-observed baseline open toward the current state',()=>{
  const input={question:'设备于2023-02-04首次记录基线，目前最新读数是多少？',allowed_workers:['refine'],current_information:{memory_nodes:[{memory_id:'baseline',event_time:'2023-02-04'},{memory_id:'current',event_time:'2024-06-01'}]}};
  const fallback=fallbackInvestigationPolicyDecision(input);
  assert.equal(fallback.worker,'refine');
  assert.deepEqual(fallback.instruction.temporal,{operator:'latest',start_date:'2023-02-04',prefer:'latest'});
  assert.doesNotThrow(()=>validateInvestigationPolicyDecision(fallback,input));
});

test('semantic assessor failure degrades to unresolved evidence instead of aborting the query',async()=>{
  const nodes=[memory('headache','患者近期头痛。',{families:['PE']})];let assessed=false;
  const output=await buildAdaptiveInvestigationContext({item:{question:'患者近期有什么症状？'},memory_nodes:nodes,candidate_budget:8,investigation_budget:5,investigation_policy:async input=>{if(!input.current_information.memory_nodes.length&&input.allowed_workers.includes('search'))return{worker:'search',information_status:'insufficient',instruction:{search_terms:['头痛']},rationale:'先找症状'};if(!assessed&&input.allowed_workers.includes('assess')){assessed=true;return{worker:'assess',information_status:'unknown',instruction:{objective:'评估已找到的症状'},rationale:'检查是否足够'};}if(input.allowed_workers.includes('verify'))return{worker:'verify',information_status:'unknown',instruction:{},rationale:'核验原文边界'};return{worker:'answer',information_status:'sufficient',instruction:{},rationale:'冻结当前信息'};},relation_evaluator:async()=>{const error=new Error('Model output was truncated at max_tokens=8192');throw Object.assign(error,{gatewayTrace:{component:'careharness_evaluate',error:{kind:'truncated_output',message:error.message}}});}});
  assert.equal(output.answer_ready,true);assert.equal(output.trace.semantic_relation_evaluator.status,'failed');assert.ok(output.memory_nodes.some(item=>item.memory_id==='headache'));
});

test('policy fallback retains a turn-local exact date constraint without changing Question Request',()=>{
  const decision=fallbackInvestigationPolicyDecision({allowed_workers:['assess','search','verify'],question:'患者自2024/1/5开始出现什么症状？',current_information:{memory_nodes:[],recent_sessions:[{episode_id:'recent'}],patient_profile:{item_count:10}}});
  assert.equal(decision.worker,'search');
  assert.deepEqual(decision.instruction.temporal,{operator:'exact',date_keys:['2024-01-05']});
});

test('policy fallback preserves latest semantics when a clinical decimal resembles a year-month',()=>{
  const question='患者之前的体重维持在约66.5kg，请问最近一次体重记录是多少？',input={question,allowed_workers:['search'],current_information:{memory_nodes:[],recent_sessions:[],patient_profile:null}};
  const fallback=fallbackInvestigationPolicyDecision(input);
  assert.equal(fallback.worker,'search');
  assert.deepEqual(fallback.instruction.temporal,{operator:'latest',prefer:'latest'});
  assert.equal(fallback.instruction.objective,question);
});

test('validator-aware fallback does not repeat a raw or effective no-progress Search',()=>{
  const question='患者自2024/1/5开始出现什么症状？',temporal={operator:'exact',date_keys:['2024-01-05']},input={allowed_workers:['search'],question,current_information:{memory_nodes:[]},previous_steps:[{worker:'search',instruction:{objective:question,temporal},effective_instruction:{objective:question,temporal},changed:false}]};
  const decision=fallbackInvestigationPolicyDecision(input);
  assert.equal(decision.worker,'search');assert.deepEqual(decision.instruction.search_terms,[question]);assert.equal(decision.instruction.expand_graph,true);
});

test('no-progress comparison includes ranking, numeric, lens and Trace controls',()=>{
  const searchInput={allowed_workers:['search'],question:'患者当前状态是什么？',current_information:{memory_nodes:[]},previous_steps:[{worker:'search',instruction:{search_terms:['状态'],family_weights:[{family:'LO',weight:2}],numeric_signals:['90'],lenses:['trajectory'],term_match:'all',expand_graph:true},effective_instruction:{search_terms:['状态'],family_weights:[{family:'LO',weight:2}],numeric_signals:['90'],lenses:['trajectory'],term_match:'all',expand_graph:true},changed:false}]};
  assert.throws(()=>validateInvestigationPolicyDecision({worker:'search',information_status:'insufficient',instruction:{search_terms:['状态'],family_weights:[{weight:2,family:'LO'}],numeric_signals:['90'],lenses:['trajectory'],term_match:'all',expand_graph:true},rationale:'重复'},searchInput),/repeats the same effective no-progress direction/);
  assert.doesNotThrow(()=>validateInvestigationPolicyDecision({worker:'search',information_status:'insufficient',instruction:{search_terms:['状态'],family_weights:[{weight:3,family:'LO'}],numeric_signals:['90'],lenses:['trajectory'],term_match:'all',expand_graph:true},rationale:'改变权重'},searchInput));
  const traceInput={allowed_workers:['trace'],question:'状态如何变化？',current_information:{memory_nodes:[memory('seed','起点。')]},previous_steps:[{worker:'trace',instruction:{seed_memory_ids:['seed'],depth:2,include_same_factor:true,include_same_concept:false,include_same_episode:true,include_context:false},effective_instruction:{seed_memory_ids:['seed'],depth:2,include_same_factor:true,include_same_concept:false,include_same_episode:true,include_context:false},changed:false}]};
  assert.throws(()=>validateInvestigationPolicyDecision({worker:'trace',information_status:'insufficient',instruction:{seed_memory_ids:['seed'],depth:2,include_same_factor:true,include_same_concept:false,include_same_episode:true,include_context:false},rationale:'重复'},traceInput),/repeats the same effective no-progress direction/);
  assert.doesNotThrow(()=>validateInvestigationPolicyDecision({worker:'trace',information_status:'insufficient',instruction:{seed_memory_ids:['seed'],depth:3,include_same_factor:true,include_same_concept:false,include_same_episode:true,include_context:false},rationale:'加深'},traceInput));
});

test('deterministic discovery cannot repeat an identical effective direction after bookkeeping progress',()=>{
  const input={allowed_workers:['search'],question:'寻找特定记录',current_information:{memory_nodes:[memory('hit','已有命中。')]},previous_steps:[{worker:'search',instruction:{search_terms:['特定记录']},effective_instruction:{search_terms:['特定记录']},changed:true}]};
  assert.throws(()=>validateInvestigationPolicyDecision({worker:'search',information_status:'insufficient',instruction:{search_terms:['特定记录']},rationale:'重复同一检索'},input),/repeats the same effective no-progress direction/);
});

test('Search does not target only recent Sessions whose transcripts are already visible',()=>{
  const input={allowed_workers:['search','assess'],question:'判断近期记录',current_information:{memory_nodes:[],recent_sessions:[{episode_id:'session-80'}]}};
  assert.throws(()=>validateInvestigationPolicyDecision({worker:'search',information_status:'insufficient',instruction:{search_terms:['血糖'],episode_ids:['session-80']},rationale:'重复检索近期原文'},input),/always-visible recent Sessions/);
  assert.doesNotThrow(()=>validateInvestigationPolicyDecision({worker:'search',information_status:'insufficient',instruction:{search_terms:['血糖'],episode_ids:['session-70']},rationale:'检索更早记录'},input));
});

test('relative-date state exposes a hard gate and stops searching after answer-bearing evidence',async()=>{
  const nodes=[memory('base','患者表示次日会复测空腹血糖。',{event_time:'2024-01-15'}),memory('target','患者回顾次日空腹血糖为 12-13 mmol/L。',{event_time:'2024-01-20',episode_id:'session-8'}),...Array.from({length:30},(_,index)=>memory(`late-${index}`,`患者后期空腹血糖记录 ${index}。`,{event_time:'2024-08-01',episode_id:'session-50'}))],inputs=[],decisions=[
    {worker:'search',information_status:'insufficient',instruction:{search_terms:['空腹血糖','FBG'],temporal:{operator:'exact',base_date:'2024-01-15',offset_days:1}},rationale:'定位次日指标'},
    {worker:'assess',information_status:'unknown',instruction:{objective:'判断时间窗内记录是否直接给出数值和单位'},rationale:'检查直接答案'},
    {worker:'verify',information_status:'unknown',instruction:{},rationale:'核验命中'},
    {worker:'answer',information_status:'sufficient',instruction:{},rationale:'结束'},
  ];
  const output=await buildAdaptiveInvestigationContext({item:{task:'entity_exact_match',question:'患者在2024-01-15次日测得的空腹血糖值是多少？'},memory_nodes:nodes,candidate_budget:24,investigation_budget:5,investigation_policy:async input=>{inputs.push(input);return decisions[inputs.length-1];},relation_evaluator:async input=>{assert.equal(input.temporal_target.documentation_date_need_not_equal_target_date,true);assert.deepEqual(input.temporal_target.candidate_matches[0].measurements,['12-13 mmol/L']);return{value:{assessment:'unresolved',relevant_memory_ids:['target'],covered_aspects:['发现回忆值但记录日晚于目标日'],answer_focus:[{aspect:'次日空腹血糖为 12-13 mmol/L',role:'baseline',memory_ids:['target'],required_in_answer:true}],connections:[],reasoning_hypotheses:[],missing_information:['缺少2024-01-16当天记录']}};}});
  assert.deepEqual(inputs[0].current_information.temporal_gate,{version:'careharness-question-temporal-gate.v2-semantic-scope',hard:true,kind:'relative_documentation_window',anchor_date:'2024-01-15',target_date:'2024-01-16',start_date:'2024-01-16',end_date:'2024-02-15',prefer:'earliest',documentation_lag_days:30});
  assert.deepEqual(inputs[1].allowed_workers,['assess']);assert.deepEqual(inputs[2].allowed_workers,['verify']);
  assert.deepEqual(output.investigation_trace.map(step=>step.worker),['search','assess','verify','answer']);
  assert.deepEqual(output.memory_nodes.map(node=>node.memory_id),['target']);assert.equal(output.trace.deterministic_temporal_gate_applied,true);
});

test('policy observes the original question and changed information after every worker',async()=>{
  const inputs=[],nodes=[memory('diagnosis','患者已确诊目标疾病。',{families:['CS']}),memory('treatment','患者随后开始目标治疗。',{families:['CP'],episode_id:'session-2',event_time:'2025-02-01'})],decisions=[
    {worker:'search',information_status:'insufficient',instruction:{search_terms:['目标疾病']},rationale:'先查诊断'},
    {worker:'search',information_status:'insufficient',instruction:{search_terms:['目标治疗']},rationale:'再查治疗'},
    {worker:'verify',information_status:'unknown',instruction:{},rationale:'核验当前信息'},
    {worker:'answer',information_status:'sufficient',instruction:{},rationale:'信息足够'}
  ];
  const output=await buildAdaptiveInvestigationContext({item:{question:'治疗为何变化？'},memory_nodes:nodes,investigation_budget:6,investigation_policy:async input=>{inputs.push(input);return decisions[inputs.length-1];}});
  assert.equal(inputs.length,4);assert.equal(inputs[0].question,'治疗为何变化？');assert.equal(inputs[0].current_information.memory_nodes.length,0);assert.equal(inputs[1].current_information.memory_nodes[0].memory_id,'diagnosis');assert.equal(inputs[2].current_information.memory_nodes.length,2);
  assert.deepEqual(output.investigation_trace.map(step=>step.worker),['search','search','verify','answer']);assert.equal(output.verification.complete,true);
  for(const term of ['query_plan','node_blueprint','state_scopes','relation_goals'])assert.equal(JSON.stringify(inputs).includes(term),false,term);
});

test('policy can invoke semantic evaluation after retrieval and its result becomes current information',async()=>{
  const nodes=[memory('a','患者开始目标治疗。',{families:['CP']}),memory('b','患者治疗后指标仍升高。',{families:['LO'],event_time:'2025-02-01'})],inputs=[];let evaluatorCalls=0;
  const decisions=[{worker:'search',information_status:'insufficient',instruction:{search_terms:['目标治疗','指标仍升高']},rationale:'召回端点'},{worker:'assess',information_status:'unknown',instruction:{objective:'判断治疗与后续变化的联系'},rationale:'评估联系'},{worker:'answer',information_status:'sufficient',instruction:{},rationale:'结束'}];
  const output=await buildAdaptiveInvestigationContext({item:{question:'治疗后为什么仍恶化？'},memory_nodes:nodes,investigation_budget:5,investigation_policy:async input=>{inputs.push(input);return decisions[inputs.length-1];},relation_evaluator:async input=>{evaluatorCalls++;assert.equal(input.nodes.length,2);return{value:{assessment:'partial',connections:[{from_memory_id:'a',to_memory_id:'b',relation_type:'observed_before',assessment:'supports',supporting_memory_ids:['a','b'],confidence:.8}],reasoning_hypotheses:[{summary:'仍需机制信息',supporting_memory_ids:['a','b'],reasoning_steps:['先治疗','后升高'],confidence:.6}],missing_information:['确切机制']},trace:{token_input:10,token_output:5,latency_ms:2}};}});
  assert.equal(evaluatorCalls,1);assert.equal(inputs[2].current_information.assessment.assessment,'partial');assert.equal(output.semantic_evaluation.missing_information[0],'确切机制');assert.equal(output.trace.semantic_relation_evaluator.total_tokens,15);
});

test('EEM semantic evaluation disables hypotheses without exposing the task label to the assessor',async()=>{
  const nodes=[memory('target','患者的口服药出现继发性药效减弱。')],decisions=[{worker:'search',information_status:'insufficient',instruction:{search_terms:['继发性药效减弱']},rationale:'定位实体'},{worker:'assess',information_status:'unknown',instruction:{objective:'提取原文实体类别'},rationale:'核对类别'},{worker:'answer',information_status:'sufficient',instruction:{},rationale:'结束'}];let turn=0;
  const output=await buildAdaptiveInvestigationContext({item:{task:'entity_exact_match',question:'医生怀疑哪类药物出现继发性药效减弱？'},memory_nodes:nodes,investigation_budget:5,investigation_policy:async()=>decisions[turn++],relation_evaluator:async input=>{assert.equal(input.task,undefined);assert.deepEqual(input.output_schema.reasoning_hypotheses,[]);return{value:{assessment:'supported',relevant_memory_ids:['target'],covered_aspects:['口服药'],answer_focus:[{aspect:'患者的口服药出现继发性药效减弱。',role:'target',memory_ids:['target'],required_in_answer:true}],connections:[],reasoning_hypotheses:[{summary:'模型不应保留的解释',supporting_memory_ids:['target']}],missing_information:[]}};}});
  assert.deepEqual(output.semantic_evaluation.reasoning_hypotheses,[]);
  assert.deepEqual(output.working_memory.reasoning_hypotheses,[]);
});

test('recent complete Sessions bypass retrieval and can form a verified answer context by themselves',async()=>{
  const recent=[{episode_id:'session-10',event_time:'2025-02-10',transcript:'[Turn=1][Role=Patient]\n患者当前空腹血糖为 8 mmol/L。'}],inputs=[];let evaluatorInput=null,turn=0,decisions=[
    {worker:'assess',information_status:'unknown',instruction:{objective:'检查近期原文是否直接回答'},rationale:'近期 Session 始终可见'},
    {worker:'verify',information_status:'unknown',instruction:{},rationale:'核验固定上下文'},
    {worker:'answer',information_status:'sufficient',instruction:{},rationale:'回答'},
  ];
  const output=await buildAdaptiveInvestigationContext({item:{question:'患者当前空腹血糖是多少？'},recent_sessions:recent,memory_nodes:[],investigation_budget:4,investigation_policy:async input=>{inputs.push(input);return decisions[turn++];},relation_evaluator:async input=>{evaluatorInput=input;return{value:{assessment:'supported',relevant_memory_ids:[],covered_aspects:['近期 Session 直接记录当前空腹血糖'],answer_focus:[],connections:[],reasoning_hypotheses:[],missing_information:[]}};}});
  assert.deepEqual(output.investigation_trace.map(step=>step.worker),['assess','verify','answer']);
  assert.deepEqual(inputs[0].current_information.recent_sessions,[{episode_id:'session-10',event_time:'2025-02-10',verbatim_available_to_assess_and_answer:true}]);
  assert.deepEqual(evaluatorInput.recent_sessions,recent);
  assert.deepEqual(output.memory_nodes,[]);
  assert.equal(output.verification.complete,true);
  assert.equal(output.verification.fixed_context_count,1);
  assert.equal(output.answer_ready,true);
});

test('query-independent Patient Profile is visible before retrieval and can form a verified context',async()=>{
  const profile={version:'careharness-patient-profile-view.v1',query_independent:true,item_count:2,sections:[{key:'clinical_identity_and_safety',label:'诊断',items:[{text:'患者已确诊目标疾病。'}]},{key:'current_treatment_and_monitoring',label:'治疗',items:[{text:'患者当前使用目标治疗。'}]}]},inputs=[];let turn=0,evaluatorInput=null,decisions=[
    {worker:'assess',information_status:'unknown',instruction:{objective:'先用病历首页形成初步判断'},rationale:'Profile 已覆盖核心事实'},
    {worker:'verify',information_status:'unknown',instruction:{},rationale:'核验固定病历上下文'},
    {worker:'answer',information_status:'sufficient',instruction:{},rationale:'回答'},
  ];
  const output=await buildAdaptiveInvestigationContext({item:{question:'患者目前接受什么治疗？'},patient_profile:profile,recent_sessions:[],memory_nodes:[],investigation_budget:4,investigation_policy:async input=>{inputs.push(input);return decisions[turn++];},relation_evaluator:async input=>{evaluatorInput=input;return{value:{assessment:'supported',relevant_memory_ids:[],covered_aspects:['Profile 记录当前治疗'],answer_focus:[],connections:[],reasoning_hypotheses:[],missing_information:[]}};}});
  assert.equal(inputs[0].current_information.patient_profile,profile);
  assert.equal(evaluatorInput.patient_profile,profile);
  assert.deepEqual(output.investigation_trace.map(step=>step.worker),['assess','verify','answer']);
  assert.equal(output.verification.fixed_context_count,2);assert.equal(output.verification.complete,true);assert.equal(output.answer_ready,true);
});

test('invalid premature answers are replaced by bounded search, verify and answer fallbacks',async()=>{
  const output=await buildAdaptiveInvestigationContext({item:{question:'目标信息是什么？'},memory_nodes:[memory('m','目标信息。')],investigation_budget:2,investigation_policy:async()=>({worker:'answer',information_status:'insufficient'})});
  assert.deepEqual(output.investigation_trace.map(step=>step.worker),['search','verify','answer']);
  assert.ok(output.trace.investigation.turns.every(turn=>turn.fallback_used===true));
});

test('an explicit-date investigation locates first and refines only within that scope',async()=>{
  const nodes=[memory('symptom','患者出现目标症状。',{event_time:'2024-01-05',families:['CS']}),memory('plan','医生提出目标计划。',{event_time:'2024-01-05',families:['CP'],source_type:'doctor'}),memory('later','患者次日出现另一个症状。',{event_time:'2024-01-06',families:['CS']})],decisions=[
    {worker:'search',information_status:'insufficient',instruction:{temporal:{operator:'exact',date_keys:['2024-01-05']}},rationale:'先定位日期'},
    {worker:'refine',information_status:'unknown',instruction:{required_families:['CS'],temporal:{operator:'exact',date_keys:['2024-01-05']}},rationale:'只在当前日期集合中保留临床状态'},
    {worker:'verify',information_status:'unknown',instruction:{},rationale:'核验最小集合'},
    {worker:'answer',information_status:'sufficient',instruction:{},rationale:'信息足够'}
  ];let turn=0;
  const output=await buildAdaptiveInvestigationContext({item:{question:'患者在2024-01-05出现了什么症状？'},memory_nodes:nodes,investigation_budget:5,investigation_policy:async()=>decisions[turn++]});
  assert.deepEqual(output.investigation_trace.map(step=>step.worker),['search','refine','verify','answer']);
  assert.deepEqual(output.memory_nodes.map(node=>node.memory_id),['symptom']);
});

test('dated symptom investigation retains a faithful structured patient-fact summary through context and assessment',async()=>{
  const nodes=[
    memory('vague','患者表示现在这些症状又冒出来。',{event_time:'2024-01-05',episode_id:'session-1',families:['PE']}),
    memory('vision','患者自述进入1月后出现持续性头部不适，反复发生，休息后会缓解。',{event_time:'2024-01-05',episode_id:'session-1',source_type:'structured',families:['PE']}),
    ...Array.from({length:20},(_,index)=>memory(`later-${index}`,`后续无关状态 ${index}。`,{event_time:'2024-05-30',episode_id:'session-47',families:['PE']})),
  ],decisions=[
    {worker:'search',information_status:'insufficient',instruction:{search_terms:['症状'],source_types:['patient'],required_families:['PE','PA'],temporal:{operator:'exact',date_keys:['2024-01-05']}},rationale:'定位日期和患者症状'},
    {worker:'context',information_status:'unknown',instruction:{objective:'补全当前命中会话内的症状描述'},rationale:'查看同会话原始表述'},
    {worker:'assess',information_status:'unknown',instruction:{objective:'判断哪些记录直接回答问题'},rationale:'识别最相关节点'},
    {worker:'refine',information_status:'unknown',instruction:{memory_ids:['vision']},rationale:'保留直接回答问题的记录'},
    {worker:'verify',information_status:'unknown',instruction:{},rationale:'核验'},
    {worker:'answer',information_status:'sufficient',instruction:{},rationale:'结束'},
  ];let turn=0;
  const output=await buildAdaptiveInvestigationContext({item:{question:'患者自2024/1/5开始出现什么症状？'},memory_nodes:nodes,candidate_budget:4,investigation_budget:6,investigation_policy:async()=>decisions[turn++],relation_evaluator:async input=>{assert.deepEqual(new Set(input.nodes.map(item=>item.memory_id)),new Set(['vague','vision']));return{value:{assessment:'supported',relevant_memory_ids:['vision'],covered_aspects:['患者自1月初出现持续性、反复发生且休息后缓解的头部不适'],answer_focus:[{aspect:'患者自1月初出现持续性、反复发生且休息后缓解的头部不适',role:'target',memory_ids:['vision'],required_in_answer:true}],connections:[],reasoning_hypotheses:[],missing_information:[]}};}});
  assert.deepEqual(output.investigation_trace.map(step=>step.worker),['search','context','assess','refine','verify','answer']);
  assert.deepEqual(output.memory_nodes.map(node=>node.memory_id),['vision']);
  assert.match(output.memory_nodes[0].text,/持续性头部不适/);
  assert.deepEqual(output.working_memory.answer_focus.map(item=>item.memory_ids),[['vision']]);
});

test('overflowing information is reassessed and refined before the mandatory budget-boundary answer',async()=>{
  const nodes=[memory('a','目标记录第一条。'),memory('b','目标记录第二条。'),memory('c','目标记录第三条。')],seen=[];
  const output=await buildAdaptiveInvestigationContext({item:{question:'目标记录是什么？'},memory_nodes:nodes,candidate_budget:2,investigation_budget:4,investigation_policy:async input=>{seen.push(input);if(seen.length===1)return{worker:'search',information_status:'insufficient',instruction:{search_terms:['目标记录']},rationale:'先取两条'};if(seen.length===2)return{worker:'search',information_status:'insufficient',instruction:{required_terms:['第三条']},rationale:'补第三条'};return{worker:'answer',information_status:'sufficient',instruction:{},rationale:'过早结束'};}});
  assert.deepEqual(output.investigation_trace.map(step=>step.worker),['search','search','assess','refine','answer']);
  assert.equal(output.memory_nodes.length,2);
  assert.equal(output.verification.complete,true);
  assert.equal(output.answer_ready,true);
  assert.deepEqual(seen[2].allowed_workers,['assess']);
});

test('assessment relevance forces semantic refine and final Answer context stays below the final limit',async()=>{
  const nodes=Array.from({length:20},(_,index)=>memory(`m${index}`,index<2?`直接相关事实 ${index}。`:`重复或无关内容 ${index}。`)),inputs=[];let assessed=false;
  const output=await buildAdaptiveInvestigationContext({item:{question:'应该怎样处理？'},memory_nodes:nodes,candidate_budget:24,investigation_budget:6,investigation_policy:async input=>{inputs.push(input);if(inputs.length===1)return{worker:'search',information_status:'insufficient',instruction:{search_terms:['事实','内容']},rationale:'取得候选'};if(!assessed){assessed=true;return{worker:'assess',information_status:'unknown',instruction:{objective:'筛选直接相关事实'},rationale:'评估'};}return{worker:'answer',information_status:'sufficient',instruction:{},rationale:'尝试结束'};},relation_evaluator:async()=>({value:{assessment:'supported',relevant_memory_ids:['m0','m1'],covered_aspects:['两条直接相关事实'],answer_focus:[{aspect:'直接相关事实',role:'target',memory_ids:['m0','m1'],required_in_answer:true}],connections:[],reasoning_hypotheses:[],missing_information:[]}})});
  assert.deepEqual(output.investigation_trace.map(step=>step.worker),['search','assess','refine','verify','answer']);
  assert.deepEqual(output.memory_nodes.map(node=>node.memory_id),['m0','m1']);
  assert.equal(output.answer_ready,true);
  assert.deepEqual(inputs[2].allowed_workers,['refine']);
});

test('state projection keeps all in-scope candidates when Assessor selects only one focus',async()=>{
  const nodes=[memory('selected','患者开始佩戴连续血糖监测。',{event_time:'2024-03-27'}),memory('also-relevant','患者承诺主动测量空腹和深夜餐后血糖并反馈。',{event_time:'2024-03-10'})],inputs=[];
  const output=await buildAdaptiveInvestigationContext({item:{question:'患者24年3月的血糖监测意愿状态是什么？'},state_projection:true,memory_nodes:nodes,candidate_budget:2,investigation_budget:5,investigation_policy:async input=>{inputs.push(input);if(inputs.length===1)return{worker:'search',information_status:'insufficient',instruction:{search_terms:['血糖'],temporal:{operator:'range',month_keys:['2024-03']}},rationale:'查找月内状态'};if(inputs.length===2)return{worker:'assess',information_status:'unknown',instruction:{objective:'确认状态'},rationale:'评估'};if(inputs.length===3){assert.equal(input.current_information.state_projection,true);assert.equal(input.allowed_workers.includes('refine'),false);return{worker:'verify',information_status:'unknown',instruction:{},rationale:'保守保留并核验'};}return{worker:'answer',information_status:'sufficient',instruction:{},rationale:'回答'};},relation_evaluator:async()=>({value:{assessment:'supported',relevant_memory_ids:['selected'],covered_aspects:['患者开始佩戴连续血糖监测'],answer_focus:[{aspect:'患者开始佩戴连续血糖监测',role:'target',memory_ids:['selected'],required_in_answer:true}],connections:[],reasoning_hypotheses:[],missing_information:[]}})});
  assert.deepEqual(output.investigation_trace.map(step=>step.worker),['search','assess','verify','answer']);assert.deepEqual(new Set(output.memory_nodes.map(node=>node.memory_id)),new Set(['selected','also-relevant']));assert.equal(output.verification.limit,2);assert.equal(output.answer_ready,true);
});

test('SUA profile keeps baseline/current roles, honors its answer limit, and audits overflow selection',async()=>{
  const profile=medMemoryInvestigationStrategy('state_update'),nodes=[memory('baseline','患者既往晨起心率多在八十多到九十出头。',{event_time:'2024-06-28',families:['LO']}),memory('current','患者当前晨起心率多在七十多。',{event_time:'2024-11-02',families:['LO']}),...Array.from({length:20},(_,index)=>memory(`d${index}`,`晨起心率相关的重复背景 ${index}。`,{event_time:`2024-07-${String(index+1).padStart(2,'0')}`,families:['LO']}))],inputs=[];let evaluatorInput=null;
  const output=await buildAdaptiveInvestigationContext({item:{task:'state_update',question:'患者当前的晨起心率是多少？',strategy_namespace:'medmemorybench',strategy_profile:profile},state_projection:true,memory_nodes:nodes,candidate_budget:24,investigation_budget:3,investigation_policy:async input=>{inputs.push(input);if(input.allowed_workers.includes('search'))return{worker:'search',information_status:'insufficient',instruction:{search_terms:['晨起心率']},rationale:'先找同一指标的变化'};if(input.allowed_workers.includes('assess'))return{worker:'assess',information_status:'unknown',instruction:{objective:'比较同一指标的基线和当前状态'},rationale:'确认动态变化'};if(input.allowed_workers.includes('refine'))return{worker:'refine',information_status:'insufficient',instruction:{memory_ids:['baseline','current']},rationale:'优先两端状态但保守保留候选'};return{worker:'answer',information_status:'sufficient',instruction:{},rationale:'冻结当前最佳信息'};},relation_evaluator:async input=>{evaluatorInput=input;return{value:{assessment:'partial',relevant_memory_ids:['baseline','current'],covered_aspects:['晨起心率从八十多到九十出头更新为七十多'],answer_focus:[{aspect:'患者既往晨起心率多在八十多到九十出头。',role:'baseline',memory_ids:['baseline'],required_in_answer:true},{aspect:'患者当前晨起心率多在七十多。',role:'current',memory_ids:['current'],required_in_answer:true}],connections:[],reasoning_hypotheses:[],missing_information:['缺少更精确的当前数值']}};}});
  assert.equal(evaluatorInput.focus_role_policy,null);assert.match(evaluatorInput.output_schema.answer_focus[0].role,/baseline/);
  assert.equal(output.semantic_evaluation.assessment,'partial');assert.deepEqual(output.semantic_evaluation.missing_information,['缺少更精确的当前数值']);assert.deepEqual(output.semantic_evaluation.answer_focus.map(item=>item.role),['baseline','current']);
  assert.equal(output.verification.limit,20);assert.equal(output.memory_nodes.length,20);assert.deepEqual(output.memory_nodes.slice(0,2).map(node=>node.memory_id),['baseline','current']);
  const selection=output.trace.answer_selection;assert.equal(selection.answer_memory_limit,20);assert.equal(selection.input_memory_count,22);assert.equal(selection.overflow,true);assert.equal(selection.dropped_memory_ids.length,2);assert.equal(selection.selection_audited,true);
  assert.deepEqual(output.investigation_trace.map(step=>step.worker),['search','assess','refine','answer']);assert.deepEqual(output.investigation_trace.at(-1).answer_selection,selection);
});

test('relation evaluator call budget is hard-limited to two assessments',async()=>{
  const nodes=[memory('a','患者有目标事实 A。'),memory('b','患者有目标事实 B。')],inputs=[];let calls=0;
  const output=await buildAdaptiveInvestigationContext({item:{question:'这些事实意味着什么？'},memory_nodes:nodes,investigation_budget:7,investigation_policy:async input=>{inputs.push(input);const last=input.current_information.worker_state?.last_worker;if(!last)return{worker:'search',information_status:'insufficient',instruction:{search_terms:['目标事实 A']},rationale:'找 A'};if(last==='search'&&calls===0)return{worker:'assess',information_status:'unknown',instruction:{objective:'第一次评估'},rationale:'评估 A'};if(last==='assess'&&calls===1)return{worker:'search',information_status:'insufficient',instruction:{search_terms:['目标事实 B']},rationale:'补 B'};if(last==='search'&&calls===1)return{worker:'assess',information_status:'unknown',instruction:{objective:'第二次评估'},rationale:'评估 A+B'};if(last==='assess'&&calls===2)return{worker:'assess',information_status:'unknown',instruction:{objective:'第三次评估'},rationale:'尝试超预算'};return{worker:'answer',information_status:'sufficient',instruction:{},rationale:'结束'};},relation_evaluator:async()=>{calls++;return{value:{assessment:'partial',relevant_memory_ids:['a','b'],covered_aspects:['A 与 B'],answer_focus:[],connections:[],reasoning_hypotheses:[],missing_information:['仍有缺口']},trace:{token_input:2,token_output:1,latency_ms:3}};}});
  assert.equal(calls,2);assert.deepEqual(output.investigation_trace.map(step=>step.worker),['search','assess','search','assess','verify','answer']);assert.equal(output.trace.semantic_relation_evaluator.model_calls,2);assert.equal(output.trace.semantic_relation_evaluator.call_budget,2);assert.equal(output.trace.semantic_relation_evaluator.total_tokens,6);assert.equal(output.trace.semantic_relation_evaluator.latency_ms,6);assert.equal(inputs.at(-2).allowed_workers.includes('assess'),false);
});

test('Refine preserves concrete gaps and new evidence is reassessed before another refinement',async()=>{
  const nodes=[...Array.from({length:18},(_,index)=>memory(`b${index}`,index<2?`当前治疗事实 ${index}。`:`无关候选 ${index}。`)),memory('symptom','患者同期出现持续消瘦和多饮多尿。')],inputs=[];let assessments=0;
  const output=await buildAdaptiveInvestigationContext({item:{question:'是否需要调整当前治疗？'},memory_nodes:nodes,candidate_budget:24,investigation_budget:8,investigation_policy:async input=>{inputs.push(input);const last=input.current_information.worker_state?.last_worker;if(!last)return{worker:'search',information_status:'insufficient',instruction:{search_terms:['当前治疗事实','无关候选']},rationale:'建立候选'};if(last==='search'&&!input.current_information.assessment)return{worker:'assess',information_status:'unknown',instruction:{objective:'检查治疗证据'},rationale:'评估'};if(last==='assess'&&input.current_information.memory_nodes.length>16)return{worker:'refine',information_status:'insufficient',instruction:{memory_ids:['b0','b1']},rationale:'删除无关候选'};if(last==='refine')return{worker:'search',information_status:'insufficient',instruction:{search_terms:['持续消瘦','多饮多尿']},rationale:'检索保留下来的缺口'};if(last==='assess')return{worker:'verify',information_status:'unknown',instruction:{},rationale:'核验'};return{worker:'answer',information_status:'sufficient',instruction:{},rationale:'回答'};},relation_evaluator:async()=>{assessments++;return{value:assessments===1?{assessment:'partial',relevant_memory_ids:['b0','b1'],covered_aspects:['当前治疗'],answer_focus:[{aspect:'当前治疗事实',role:'treatment',memory_ids:['b0','b1'],required_in_answer:true}],connections:[],reasoning_hypotheses:[],missing_information:['体重及多饮多尿变化']}:{assessment:'supported',relevant_memory_ids:['b0','b1','symptom'],covered_aspects:['当前治疗','消瘦及多饮多尿'],answer_focus:[{aspect:'当前治疗事实',role:'treatment',memory_ids:['b0','b1'],required_in_answer:true},{aspect:'持续消瘦和多饮多尿',role:'risk',memory_ids:['symptom'],required_in_answer:true}],connections:[],reasoning_hypotheses:[],missing_information:[]}};}});
  assert.deepEqual(output.investigation_trace.map(step=>step.worker),['search','assess','refine','search','assess','verify','answer']);
  assert.equal(assessments,2);
  assert.deepEqual(inputs[3].current_information.assessment.missing_information,['体重及多饮多尿变化']);
  assert.equal(inputs[3].allowed_workers.includes('assess'),false);
  assert.equal(inputs[3].allowed_workers.includes('refine'),false);
  assert.deepEqual(new Set(output.memory_nodes.map(node=>node.memory_id)),new Set(['b0','b1','symptom']));
  assert.equal(output.answer_ready,true);
});

test('the final budget turn answers from best available information even after zero recall',async()=>{
  const output=await buildAdaptiveInvestigationContext({item:{question:'找不到的目标是什么？'},memory_nodes:[memory('other','完全无关记录。')],investigation_budget:2,investigation_policy:async()=>({worker:'search',information_status:'insufficient',instruction:{search_terms:['不存在目标']},rationale:'继续查找'})});
  assert.equal(output.investigation_policy.termination_reason,'answer_selected');
  assert.equal(output.answer_ready,true);assert.equal(output.packet_frozen,true);assert.equal(output.verification_complete,false);assert.equal(output.trace.investigation.packet_frozen,true);assert.equal(output.trace.investigation.verification_complete,false);assert.match(output.answer_ready_semantics,/separate/);
  assert.deepEqual(output.memory_nodes,[]);
  assert.deepEqual(output.investigation_trace.map(step=>step.worker),['search','search','answer']);
});

test('budget-boundary answer preserves causal support IDs and enforces the final context limit',async()=>{
  const nodes=Array.from({length:20},(_,index)=>memory(`m${index}`,`目标事实 ${index}。`)),inputs=[];
  const output=await buildAdaptiveInvestigationContext({item:{question:'这些事实如何共同解释结果？'},memory_nodes:nodes,candidate_budget:24,investigation_budget:3,investigation_policy:async input=>{inputs.push(input);return inputs.length===1?{worker:'search',information_status:'insufficient',instruction:{search_terms:['目标事实']},rationale:'取得候选'}:{worker:'answer',information_status:'sufficient',instruction:{},rationale:'尝试提前回答'};},relation_evaluator:async()=>({value:{assessment:'supported',relevant_memory_ids:['m0'],covered_aspects:['目标事实'],answer_focus:[{aspect:'目标事实 0',role:'baseline',memory_ids:['m0'],required_in_answer:true}],connections:[{from_memory_id:'m0',to_memory_id:'m19',relation_type:'progresses_to',assessment:'supports',supporting_memory_ids:['m0','m19'],confidence:.8}],reasoning_hypotheses:[{grounding_scope:'source_supported_patient_fact',summary:'目标事实 0 和目标事实 19',supporting_memory_ids:['m0','m19'],reasoning_steps:['目标事实 0','目标事实 19'],confidence:.7}],missing_information:[]}})});
  assert.deepEqual(output.investigation_trace.map(step=>step.worker),['search','assess','refine','answer']);
  assert.equal(output.memory_nodes.length,2);assert.equal(output.memory_nodes[0].memory_id,'m0');assert.equal(output.memory_nodes[1].memory_id,'m19');
  assert.equal(output.verification.complete,true);assert.equal(output.answer_ready,true);
  assert.deepEqual(output.working_memory.reasoning_hypotheses[0].supporting_memory_ids,['m0','m19']);
});

test('MedLoCoMo frequency count cannot skip Search and semantic ledger assessment even with a one-turn configured budget',async()=>{
  const strategy=medLoCoMoInvestigationStrategy('frequency_pattern'),nodes=[memory('a','Vancomycin was administered during dialysis.',{episode_id:'admission-a'}),memory('b','Vancomycin was administered during dialysis.',{episode_id:'admission-b'})],inputs=[];
  const output=await buildAdaptiveInvestigationContext({question_request:{question:'How many times was vancomycin administered during dialysis?',task:'frequency_pattern',strategy_namespace:'medlocomo',strategy_profile:strategy},memory_nodes:nodes,candidate_budget:40,investigation_budget:1,investigation_policy:async input=>{inputs.push(input);if(input.allowed_workers[0]==='search')return{worker:'search',information_status:'insufficient',instruction:{search_terms:['vancomycin','dialysis']},rationale:'enumerate'};if(input.allowed_workers[0]==='assess')return{worker:'assess',information_status:'unknown',instruction:{objective:'validate each Admission occurrence'},rationale:'build ledger'};return{worker:'answer',information_status:'sufficient',instruction:{},rationale:'freeze'};},relation_evaluator:async()=>({value:{assessment:'supported',relevant_memory_ids:['a','b'],covered_aspects:['two source-supported Admission events'],answer_focus:[{aspect:'Vancomycin was administered during dialysis.',role:'target',memory_ids:['a'],required_in_answer:true},{aspect:'Vancomycin was administered during dialysis.',role:'target',memory_ids:['b'],required_in_answer:true}],connections:[],reasoning_hypotheses:[],missing_information:[]}})});
  assert.deepEqual(output.investigation_trace.map(step=>step.worker),['search','assess','verify','answer']);
  assert.deepEqual(inputs.map(input=>input.allowed_workers),[['search'],['assess'],['verify'],['answer']]);
  assert.equal(output.memory_nodes.length,2);assert.equal(output.answer_ready,true);
});

test('MedLoCoMo cross-admission patient-distilled evidence must be assessed on one source-cited axis before Answer',async()=>{
  const strategy=medLoCoMoInvestigationStrategy('cross_admission_comparison'),nodes=[memory('first','Admission A used aspirin for atrial fibrillation.',{episode_id:'admission-a'}),memory('last','Admission B used warfarin with INR monitoring for atrial fibrillation.',{episode_id:'admission-b'})],inputs=[];let assessments=0;
  const output=await buildAdaptiveInvestigationContext({question_request:{question:'How did atrial fibrillation management change across admissions?',task:'cross_admission_comparison',strategy_namespace:'medlocomo',strategy_profile:strategy},initial_memory_nodes:nodes,candidate_budget:24,investigation_budget:1,investigation_policy:async input=>{inputs.push(input);const worker=input.allowed_workers[0];return{worker,information_status:worker==='answer'?'sufficient':'unknown',instruction:worker==='assess'?{objective:'align the same treatment factor across admissions'}:{},rationale:'follow the executable comparison gate'};},relation_evaluator:async()=>{assessments++;return{value:{assessment:'supported',relevant_memory_ids:['first','last'],covered_aspects:['atrial fibrillation treatment changed across admissions'],answer_focus:[{aspect:'Admission A used aspirin for atrial fibrillation.',role:'baseline',memory_ids:['first'],required_in_answer:true},{aspect:'Admission B used warfarin with INR monitoring for atrial fibrillation.',role:'current',memory_ids:['last'],required_in_answer:true}],connections:[],reasoning_hypotheses:[],missing_information:[]}};}});
  assert.equal(assessments,1);assert.deepEqual(output.investigation_trace.map(step=>step.worker),['assess','verify','answer']);assert.deepEqual(inputs.map(input=>input.allowed_workers),[['assess'],['verify'],['answer']]);assert.equal(output.answer_ready,true);
});

test('MedLoCoMo cross-admission gate does not repeat Assess when Search leaves the packet unchanged',async()=>{
  const strategy=medLoCoMoInvestigationStrategy('cross_admission_comparison'),nodes=[memory('first','Admission A used aspirin for atrial fibrillation.',{episode_id:'admission-a'}),memory('last','Admission B used warfarin with INR monitoring for atrial fibrillation.',{episode_id:'admission-b'})],inputs=[];let assessments=0;
  const output=await buildAdaptiveInvestigationContext({question_request:{question:'How did atrial fibrillation management change across admissions?',task:'cross_admission_comparison',strategy_namespace:'medlocomo',strategy_profile:strategy},memory_nodes:nodes,initial_memory_nodes:nodes,candidate_budget:24,investigation_budget:1,investigation_policy:async input=>{inputs.push(input);let worker=input.allowed_workers[0];if(input.allowed_workers.includes('search'))worker='search';return{worker,information_status:worker==='answer'?'sufficient':'unknown',instruction:worker==='assess'?{objective:'align the same treatment factor across admissions'}:worker==='search'?{search_terms:['atrial fibrillation']}:{},rationale:'repair incomplete comparison coverage'};},relation_evaluator:async()=>{assessments++;return{value:assessments===1?{assessment:'supported',relevant_memory_ids:['first','last'],covered_aspects:['atrial fibrillation treatment'],answer_focus:[{aspect:'Admission A used aspirin for atrial fibrillation.',role:'baseline',memory_ids:['first'],required_in_answer:true}],connections:[],reasoning_hypotheses:[],missing_information:[]}:{assessment:'supported',relevant_memory_ids:['first','last'],covered_aspects:['atrial fibrillation treatment changed across admissions'],answer_focus:[{aspect:'Admission A used aspirin for atrial fibrillation.',role:'baseline',memory_ids:['first'],required_in_answer:true},{aspect:'Admission B used warfarin with INR monitoring for atrial fibrillation.',role:'current',memory_ids:['last'],required_in_answer:true}],connections:[],reasoning_hypotheses:[],missing_information:[]}};}});
  assert.equal(assessments,1);assert.deepEqual(output.investigation_trace.map(step=>step.worker),['assess','search','verify','answer']);assert.equal(inputs[1].allowed_workers.includes('answer'),false);assert.equal(output.packet_frozen,true);assert.equal(output.answer_ready,false);
});

test('MedLoCoMo comparison gate does not change another MedLoCoMo task',async()=>{
  const strategy=medLoCoMoInvestigationStrategy('longitudinal_progression'),nodes=[memory('first','The symptom improved over time.',{episode_id:'admission-a'})],inputs=[];
  const output=await buildAdaptiveInvestigationContext({question_request:{question:'How did the symptom progress?',task:'longitudinal_progression',strategy_namespace:'medlocomo',strategy_profile:strategy},initial_memory_nodes:nodes,investigation_budget:1,investigation_policy:async input=>{inputs.push(input);const worker=input.allowed_workers.includes('verify')?'verify':'answer';return{worker,information_status:worker==='answer'?'sufficient':'unknown',instruction:{},rationale:'unchanged non-comparison route'};}});
  assert.deepEqual(output.investigation_trace.map(step=>step.worker),['verify','answer']);assert.equal(output.trace.semantic_relation_evaluator.model_calls,0);assert.equal(output.packet_frozen,true);assert.equal(output.answer_ready,false);
});

test('MedLoCoMo comparison freezes the best paired packet at the budget edge when alignment remains partial',async()=>{
  const strategy=medLoCoMoInvestigationStrategy('cross_admission_comparison'),nodes=[memory('first','Admission A documents the earlier treatment.',{episode_id:'admission-a'}),memory('last','Admission B documents the later treatment.',{episode_id:'admission-b'})],inputs=[];
  const output=await buildAdaptiveInvestigationContext({question_request:{question:'How did treatment change across admissions?',task:'cross_admission_comparison',strategy_namespace:'medlocomo',strategy_profile:strategy},memory_nodes:nodes,initial_memory_nodes:nodes,candidate_budget:24,investigation_budget:1,investigation_policy:async input=>{inputs.push(input);let worker=input.allowed_workers[0];if(input.allowed_workers.includes('context')&&input.previous_steps.filter(step=>step.worker==='assess').length>=2)worker='context';return{worker,information_status:worker==='answer'?'sufficient':'insufficient',instruction:worker==='assess'?{objective:'align both admissions'}:worker==='search'?{search_terms:['treatment']}:{},rationale:'keep investigating until the bounded best-effort answer'};},relation_evaluator:async()=>({value:{assessment:'partial',relevant_memory_ids:['first'],covered_aspects:['earlier treatment'],answer_focus:[{aspect:'Admission A documents the earlier treatment.',role:'baseline',memory_ids:['first'],required_in_answer:true}],connections:[],reasoning_hypotheses:[],missing_information:['later treatment detail']}})});
  assert.equal(output.investigation_trace[0].worker,'assess');assert.equal(output.investigation_trace.at(-1).worker,'answer');assert.equal(output.packet_frozen,true);assert.equal(output.answer_ready,false);assert.equal(output.memory_nodes.some(node=>node.episode_id==='admission-a'),true);assert.equal(output.memory_nodes.some(node=>node.episode_id==='admission-b'),true);
});

test('a complex investigation uses assessment gaps to change search direction',async()=>{
  const nodes=[memory('baseline','患者初始客观指标明显异常。',{families:['CS']}),memory('treatment','患者规律执行治疗。',{families:['CP'],event_time:'2025-02-01'}),memory('response','治疗后客观指标仍继续恶化。',{families:['LO'],event_time:'2025-03-01'}),memory('symptoms','患者同期出现持续消瘦和明显症状。',{families:['PE','LO'],event_time:'2025-03-01'})],policyInputs=[],decisions=[
    {worker:'search',information_status:'insufficient',instruction:{search_terms:['初始客观指标']},rationale:'建立基线'},
    {worker:'assess',information_status:'unknown',instruction:{objective:'判断当前信息是否足以支持治疗决策'},rationale:'识别缺失方面'},
    {worker:'search',information_status:'insufficient',instruction:{search_terms:['规律执行治疗','治疗后客观指标']},rationale:'补治疗暴露与响应'},
    {worker:'search',information_status:'insufficient',instruction:{search_terms:['持续消瘦','明显症状']},rationale:'补症状与风险变化'},
    {worker:'assess',information_status:'unknown',instruction:{objective:'复核患者特异证据链'},rationale:'复核覆盖'},
    {worker:'refine',information_status:'unknown',instruction:{memory_ids:['baseline','treatment','response','symptoms']},rationale:'保留最小证据链'},
    {worker:'verify',information_status:'unknown',instruction:{},rationale:'核验'},
    {worker:'answer',information_status:'sufficient',instruction:{},rationale:'结束'}
  ];let policyTurn=0,assessmentTurn=0;
  const output=await buildAdaptiveInvestigationContext({item:{question:'是否需要调整当前治疗？'},memory_nodes:nodes,investigation_budget:9,investigation_policy:async input=>{policyInputs.push(input);return decisions[policyTurn++];},relation_evaluator:async()=>{assessmentTurn++;return{value:assessmentTurn===1?{assessment:'partial',relevant_memory_ids:['baseline'],covered_aspects:['已知基线异常'],connections:[],reasoning_hypotheses:[],missing_information:['治疗是否实际执行','治疗后的客观响应','伴随症状与风险变化']}:{assessment:'supported',relevant_memory_ids:['baseline','treatment','response','symptoms'],covered_aspects:['基线','治疗执行','治疗后恶化','伴随症状'],connections:[],reasoning_hypotheses:[],missing_information:[]},trace:{token_input:1,token_output:1}};}});
  assert.deepEqual(policyInputs[2].current_information.assessment.missing_information,['治疗是否实际执行','治疗后的客观响应']);
  assert.ok(policyInputs[2].allowed_workers.length>1);assert.ok(policyInputs[2].allowed_workers.includes('search'));assert.ok(policyInputs[2].allowed_workers.includes('context'));assert.ok(policyInputs[2].allowed_workers.includes('trace'));
  assert.deepEqual(new Set(output.memory_nodes.map(node=>node.memory_id)),new Set(['baseline','treatment','response','symptoms']));
  assert.deepEqual(output.investigation_trace.map(step=>step.worker),['search','assess','search','search','assess','refine','verify','answer']);
});

test('fallback preserves onset semantics when the question also says later',()=>{
  const input={allowed_workers:['search'],question:'患者后来首次出现的面部稳态信号是什么？',current_information:{memory_nodes:[]}};
  const fallback=fallbackInvestigationPolicyDecision(input);
  assert.equal(fallback.worker,'search');
  assert.deepEqual(fallback.instruction.temporal,{operator:'earliest',prefer:'earliest'});
  assert.doesNotThrow(()=>validateInvestigationPolicyDecision(fallback,input));
});
