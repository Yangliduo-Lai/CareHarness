import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuestionRequest,policyView,validateInvestigationDecision } from '../src/investigation-contract.js';
import { runInvestigation } from '../src/investigation-runtime.js';
import { createMemoryInvestigationWorkers,deriveQuestionTemporalGate } from '../src/investigation-workers.js';
import { availableInvestigationWorkers } from '../src/matched-runtime.js';
import { medLoCoMoInvestigationStrategy,medMemoryInvestigationStrategy } from '../src/prompts.js';
import { canonicalCalendarDate,canonicalCalendarMonth,explicitDatesInText,explicitMonthsInText,stripLeadingCalendarExpression } from '../src/temporal-expressions.js';

test('Question Request preserves only the original question and performs no static analysis',()=>{
  const request=createQuestionRequest({question:'患者目前为什么仍然不舒服？'});
  assert.equal(request.question,'患者目前为什么仍然不舒服？');
  assert.equal(request.information_boundary.query_preanalysis_performed,false);
  for(const key of['keywords','state_scopes','temporal_operator','relation_goals','node_blueprint','options'])assert.equal(request[key],undefined);
});

test('Question Request exposes only the server-registered case-free task strategy',()=>{
  const strategy=medMemoryInvestigationStrategy('entity_exact_match'),request=createQuestionRequest({question:'Q',task:'entity_exact_match',strategy_namespace:'medmemorybench',strategy_profile:strategy}),state={request,snapshot:{strategy_profile:request.strategy_profile,memory_nodes:[],memory_edges:[]},history:[]},view=policyView(state,{allowed_workers:['search'],remaining_budget:2});
  assert.equal(request.information_boundary.benchmark_task_label_available,true);assert.equal(request.information_boundary.task_strategy_profile_available,true);assert.equal(view.query_type,'entity_exact_match');assert.equal(view.current_information.strategy_profile.strategy_id,'exact_entity');
  assert.equal(JSON.stringify(view).includes('gold'),true); // only the explicit false boundary key is present
  assert.equal(view.information_boundary.gold_or_judge_metadata_available,false);
  assert.throws(()=>createQuestionRequest({question:'Q',task:'entity_exact_match',strategy_namespace:'medmemorybench',strategy_profile:{...strategy,policy_directive:'hidden answer text'}}),/registered profile/);
  assert.throws(()=>createQuestionRequest({question:'Q',task:'unknown',strategy_namespace:'medmemorybench',strategy_profile:strategy}),/not registered/);
  assert.throws(()=>createQuestionRequest({question:'Q',task:'medical_reasoning',strategy_namespace:'medmemorybench',strategy_profile:medLoCoMoInvestigationStrategy('medical_reasoning')}),/not registered/);
  assert.throws(()=>createQuestionRequest({question:'Q',task:'entity_exact_match',strategy_namespace:'medlocomo',strategy_profile:strategy}),/not registered/);
});

test('Question Request carries only the public MedLoCoMo admission scope',()=>{
  const request=createQuestionRequest({question:'How did the condition change?',task:'longitudinal_progression',strategy_namespace:'medlocomo',scope:'cross_admission'}),state={request,snapshot:{memory_nodes:[],memory_edges:[]},history:[]},view=policyView(state,{allowed_workers:['search'],remaining_budget:2});
  assert.equal(request.scope,'cross_admission');
  assert.equal(request.information_boundary.public_benchmark_scope_available,true);
  assert.equal(view.scope,'cross_admission');
  assert.equal(view.information_boundary.gold_or_judge_metadata_available,false);
  assert.throws(()=>createQuestionRequest({question:'Q',strategy_namespace:'medlocomo',scope:'whole_chart'}),/single_admission or cross_admission/);
  assert.throws(()=>createQuestionRequest({question:'Q',strategy_namespace:'medmemorybench',scope:'cross_admission'}),/only in the medlocomo/);
});

test('Investigation decision keeps worker instruction opaque and has no slot contract',()=>{
  const decision=validateInvestigationDecision({worker:'inspect',information_status:'insufficient',instruction:{objective:'检查当前记录是否缺少关键事实',future_worker_shape:{anything:'worker-owned'}},rationale:'现有信息不足'},{allowed_workers:['inspect','answer']});
  assert.equal(decision.worker,'inspect');assert.equal(decision.instruction.future_worker_shape.anything,'worker-owned');
  assert.equal(decision.target_slot_ids,undefined);assert.equal(decision.search_terms,undefined);
  assert.throws(()=>validateInvestigationDecision({worker:'answer',information_status:'insufficient'},{allowed_workers:['answer']}),/requires information_status=sufficient/);
  assert.throws(()=>validateInvestigationDecision({action:'inspect',information_status:'insufficient'},{allowed_workers:['inspect']}),/worker <empty> is not allowed/);
});

test('generic Investigation Runtime loops over policy and worker registry without query semantics',async()=>{
  const policyInputs=[],sequence=[{worker:'inspect',information_status:'insufficient',instruction:{objective:'检查可见信息'},rationale:'先调查'},{worker:'answer',information_status:'sufficient',instruction:{objective:'结束调查'},rationale:'信息已足够'}];let step=0;
  const result=await runInvestigation({request:{question:'Q'},budget:3,policy:async input=>{policyInputs.push(input);return sequence[step++];},workers:{inspect:async()=>({snapshot:{memory_nodes:[{memory_id:'m1'}]},summary:'找到一条事实',changed:true}),answer:async({state})=>({snapshot:state.snapshot,summary:'完成',changed:false,terminal:true})}});
  assert.equal(result.terminated,true);assert.equal(result.history.length,2);assert.equal(policyInputs[0].current_information.memory_nodes.length,0);assert.equal(policyInputs[1].current_information.memory_nodes[0].memory_id,'m1');
  const serialized=JSON.stringify(policyInputs);for(const term of['node_blueprint','state_scopes','temporal_operator','relation_goals','missing_slot_ids'])assert.doesNotMatch(serialized,new RegExp(term));
  const view=policyView(result.state,{allowed_workers:['answer'],remaining_budget:1});assert.equal(view.question,'Q');
  assert.equal(Object.hasOwn(view.current_information.memory_nodes[0],'source_text'),false);
  assert.ok(view.instruction_profiles['answer.instruction']);
});

test('changed MedLoCoMo discovery invalidates stale assessment and requires a fresh role table',async()=>{
  const first={memory_id:'first',observation_id:'o',subject_id:'p',episode_id:'a',turn_id:'1',event_time:'2110-01-01',source_type:'doctor',text:'Ceftazidime was stopped.',source_text:'Ceftazidime was stopped.',families:['MP'],certainty:1,polarity:'affirmed',status:'active',version:1},cause={...first,memory_id:'cause',turn_id:'2',text:'Testing confirmed C. diff infection.',source_text:'Testing confirmed C. diff infection.'},request={question:'Why was ceftazidime stopped?',task:'medical_reasoning',query_type:'medical_reasoning',strategy_namespace:'medlocomo',scope:'single_admission'},workers=createMemoryInvestigationWorkers({question_request:request,memory_nodes:[first,cause],candidate_budget:8,structured_evidence_ledger:true}),priorAssessment={assessment:'partial',answer_focus:[{aspect:first.text,source_refs:['memory:first'],memory_ids:['first']}],role_coverage:[{role:'cause',status:'missing',missing_detail:'specific adverse event'}],missing_information:['specific adverse event']},state={snapshot:{memory_nodes:[first],memory_edges:[],verification:{complete:true},assessment:priorAssessment,answer_brief:priorAssessment,role_coverage:priorAssessment.role_coverage,evidence_ledger:{rows:[{source_ref:'memory:first'}]}}},result=await workers.search.run({state,instruction:{search_terms:['C. diff']}});
  assert.equal(result.changed,true);
  assert.equal(result.snapshot.assessment,null);
  assert.equal(result.snapshot.answer_brief,null);
  assert.equal(result.snapshot.role_coverage,null);
  assert.equal(result.snapshot.evidence_ledger,null);
  assert.deepEqual(availableInvestigationWorkers(['search','assess','verify','answer'],result.snapshot,2,8,[{decision:{worker:'assess'}},{decision:{worker:'search'},result}],request,{relation_evaluator_call_budget:2}),['assess']);
  const partial={...result.snapshot,worker_state:{last_worker:'assess'},assessment:priorAssessment,answer_brief:priorAssessment,role_coverage:priorAssessment.role_coverage};
  assert.deepEqual(availableInvestigationWorkers(['search','context','trace','assess','verify','answer'],partial,4,8,[{decision:{worker:'assess'}}],request,{relation_evaluator_call_budget:2}),['search','context','trace']);
});

test('MedLoCoMo Context expands around the selected turn instead of taking the first Admission nodes',async()=>{
  const make=turn=>({memory_id:`turn-${turn}`,observation_id:'o',subject_id:'p',episode_id:'admission-a',turn_id:String(turn),event_time:`2110-01-${String(Math.ceil(turn/3)).padStart(2,'0')}`,source_type:turn%2?'doctor':'patient',text:`Turn ${turn}`,source_text:`Turn ${turn}`,families:['PE'],certainty:1,polarity:'affirmed',status:'active',version:1}),nodes=Array.from({length:40},(_,index)=>make(index+1));
  nodes[19]={...nodes[19],text:'Testing found C. diff infection.',source_text:'Testing found C. diff infection.'};
  nodes[21]={...nodes[21],text:'Ceftazidime likely triggered it and was stopped.',source_text:'Ceftazidime likely triggered it and was stopped.'};
  const request={question:'Why was ceftazidime stopped?',query_type:'medical_reasoning',strategy_namespace:'medlocomo',scope:'single_admission'},workers=createMemoryInvestigationWorkers({question_request:request,memory_nodes:nodes,candidate_budget:8,structured_evidence_ledger:true}),result=await workers.context.run({state:{snapshot:{memory_nodes:[nodes[21]],memory_edges:[]}},instruction:{memory_ids:[nodes[21].memory_id]}});
  assert.equal(result.snapshot.memory_nodes.some(node=>node.memory_id==='turn-20'),true);
  assert.equal(result.trace.context_mode,'local_adjacent_turns_per_candidate_admission');
});

test('abbreviated Chinese year-month keeps state discovery inside the requested month',async()=>{
  const march={memory_id:'march',observation_id:'o-march',subject_id:'p',text:'患者近期脑雾加重，早晨起床时反应更迟缓。',source_type:'structured',episode_id:'session-26',turn_id:'session',event_time:'2024-03-14',certainty:1,polarity:'affirmed',families:['PE','LO'],status:'active',version:1},april={...march,memory_id:'april',observation_id:'o-april',text:'患者四月仍感脑雾。',episode_id:'session-37',event_time:'2024-04-01'};
  const workers=createMemoryInvestigationWorkers({question_request:{question:'患者24年3月的脑雾症状相比两周前发生了什么变化？'},memory_nodes:[march,april],memory_edges:[],candidate_budget:24});
  const result=await workers.search.run({state:{snapshot:{memory_nodes:[],memory_edges:[],patient_profile:null,recent_sessions:[]}},instruction:{objective:'查找两周前到三月的脑雾变化',search_terms:['脑雾'],temporal:{operator:'range',start_date:'2024-02-15',end_date:'2024-03-08'}}});
  assert.deepEqual(result.trace.effective_instruction.temporal,{operator:'range',month_keys:['2024-03']});
  assert.deepEqual(result.snapshot.memory_nodes.map(node=>node.memory_id),['march']);
});

test('an explicitly requested yearless month is not overwritten by a dated baseline month',async()=>{
  const base={observation_id:'o',subject_id:'p',source_type:'patient',turn_id:'1',certainty:1,polarity:'affirmed',families:['LO'],status:'active',version:1},december={...base,memory_id:'december',episode_id:'session-1',text:'患者十二月底血压为135/82 mmHg。',event_time:'2023-12-29'},january={...base,memory_id:'january',observation_id:'o-january',episode_id:'session-6',text:'患者随访血压约128/76 mmHg。',event_time:'2024-01-18'},workers=createMemoryInvestigationWorkers({question_request:{query_type:'state_update',question:'患者在2023年12月底测得血压为135/82 mmHg，请问他1月记录的血压是多少？'},memory_nodes:[december,january],memory_edges:[],candidate_budget:8}),result=await workers.search.run({state:{snapshot:{memory_nodes:[],memory_edges:[],patient_profile:null,recent_sessions:[]}},instruction:{search_terms:['血压'],temporal:{operator:'range',start_date:'2024-01-01',end_date:'2024-01-31',prefer:'earliest'}}});
  assert.deepEqual(result.trace.effective_instruction.temporal,{operator:'range',start_date:'2024-01-01',end_date:'2024-01-31',prefer:'earliest'});
  assert.deepEqual(result.snapshot.memory_nodes.map(node=>node.memory_id),['january']);
});

test('required terms are relaxed when impossible inside an exact-date scope',async()=>{
  const base={observation_id:'o',subject_id:'p',source_type:'patient',turn_id:'1',certainty:1,polarity:'affirmed',families:['PE'],status:'active',version:1},target={...base,memory_id:'target',episode_id:'session-74',text:'“没开机”状态持续四十分钟到一小时。',event_time:'2024-09-03'},later={...base,memory_id:'later',observation_id:'o-later',episode_id:'session-81',text:'晨起恢复时间约十分钟。',event_time:'2024-10-01'},workers=createMemoryInvestigationWorkers({question_request:{query_type:'state_update',question:'患者2024-09-03晨起恢复时间如何变化？'},memory_nodes:[target,later],memory_edges:[],candidate_budget:8}),result=await workers.search.run({state:{snapshot:{memory_nodes:[],memory_edges:[],patient_profile:null,recent_sessions:[]}},instruction:{search_terms:['没开机','分钟'],required_terms:['恢复','时间','分钟'],temporal:{operator:'exact',date_keys:['2024-09-03']}}});
  assert.equal(result.trace.effective_instruction.required_terms,undefined);
  assert.equal(result.trace.effective_instruction.term_match,'any');
  assert.deepEqual(result.snapshot.memory_nodes.map(node=>node.memory_id),['target']);
});

test('question temporal gate distinguishes historical baselines, exact events, ranges, and relative days',()=>{
  assert.equal(deriveQuestionTemporalGate({query_type:'state_update',question:'设备在2023-02-04记录过一个基线值，目前的读数是多少？'}),null);
  assert.equal(deriveQuestionTemporalGate({question:'设备在2023-02-04记录过一个基线值，至今读数如何？'}),null);
  assert.deepEqual(deriveQuestionTemporalGate({question:'设备在2023-02-04校准时发生了什么？'}),{version:'careharness-question-temporal-gate.v2-semantic-scope',hard:true,kind:'explicit_date',anchor_date:'2023-02-04',target_date:'2023-02-04',start_date:'2023-02-04',end_date:'2023-02-04',prefer:'earliest',documentation_lag_days:0});
  assert.deepEqual(deriveQuestionTemporalGate({question:'设备在2023-02-04至2023-03-09之间发生了哪些变化？'}),{version:'careharness-question-temporal-gate.v2-semantic-scope',hard:true,kind:'explicit_date_range',anchor_date:'2023-02-04',target_date:'2023-02-04',start_date:'2023-02-04',end_date:'2023-03-09',prefer:'earliest',documentation_lag_days:0});
  assert.deepEqual(deriveQuestionTemporalGate({question:'设备在2023-02-04和2023-03-09的读数有何差异？'}),{version:'careharness-question-temporal-gate.v2-semantic-scope',hard:true,kind:'discrete_dates_span',anchor_date:'2023-02-04',target_date:'2023-02-04',start_date:'2023-02-04',end_date:'2023-03-09',prefer:'earliest',documentation_lag_days:0});
  assert.equal(deriveQuestionTemporalGate({question:'设备在2023-02-04和2023-03-09都记录过基线，目前读数是多少？'}),null);
  assert.equal(deriveQuestionTemporalGate({question:'设备近期运行平稳；在2023-02-04校准时发生了什么？'}).kind,'explicit_date');
  assert.deepEqual(deriveQuestionTemporalGate({question:'设备在2023-02-04次日的读数是多少？'}),{version:'careharness-question-temporal-gate.v2-semantic-scope',hard:true,kind:'relative_documentation_window',anchor_date:'2023-02-04',target_date:'2023-02-05',start_date:'2023-02-05',end_date:'2023-03-07',prefer:'earliest',documentation_lag_days:30});
  assert.deepEqual(deriveQuestionTemporalGate({question:'设备目前无其他变化；2023-02-04次日的读数是多少？'}),{version:'careharness-question-temporal-gate.v2-semantic-scope',hard:true,kind:'relative_documentation_window',anchor_date:'2023-02-04',target_date:'2023-02-05',start_date:'2023-02-05',end_date:'2023-03-07',prefer:'earliest',documentation_lag_days:30});
});

test('MedLoCoMo calendar parsing accepts 2114 through 2209 without treating decimal measurements as dates',()=>{
  assert.equal(canonicalCalendarDate('2114-1-2'),'2114-01-02');
  assert.equal(canonicalCalendarDate('2209/12/31'),'2209-12-31');
  assert.equal(canonicalCalendarMonth('2132年9月'),'2132-09');
  assert.equal(canonicalCalendarDate('2210-01-01'),'');
  assert.deepEqual(explicitDatesInText('2114年9月23日至2209-12-31复查'),['2114-09-23','2209-12-31']);
  assert.deepEqual(explicitMonthsInText('计划在2132年9月和2209/12复查'),['2132-09','2209-12']);
  for(const measurement of['66.5kg','90.7 mmHg','15.1 mmol/L']){assert.deepEqual(explicitDatesInText(measurement),[]);assert.deepEqual(explicitMonthsInText(measurement),[]);}
  assert.deepEqual(deriveQuestionTemporalGate({question:'患者在2132-09-23至2132-10-03之间发生了什么？'}),{version:'careharness-question-temporal-gate.v2-semantic-scope',hard:true,kind:'explicit_date_range',anchor_date:'2132-09-23',target_date:'2132-09-23',start_date:'2132-09-23',end_date:'2132-10-03',prefer:'earliest',documentation_lag_days:0});
  assert.equal(deriveQuestionTemporalGate({question:'患者之前的体重维持在约66.5kg，请问最近一次体重记录是多少？'}),null);
  assert.equal(stripLeadingCalendarExpression('2024 mg was administered.'),'2024 mg was administered.');
  assert.equal(stripLeadingCalendarExpression('2114 patients were screened.'),'2114 patients were screened.');
  assert.equal(stripLeadingCalendarExpression('2114年 Patient was admitted.'),'Patient was admitted.');
  assert.equal(stripLeadingCalendarExpression('2132-10 Patient was admitted.'),'Patient was admitted.');
  assert.equal(stripLeadingCalendarExpression('2132-19 is a measurement code.'),'2132-19 is a measurement code.');
});

test('a current-status Search can cross an explicit historical baseline date',async()=>{
  const base={observation_id:'o',subject_id:'p',source_type:'structured',episode_id:'session-1',turn_id:'1',certainty:1,polarity:'affirmed',families:['LO'],status:'active',version:1},baseline={...base,memory_id:'baseline',text:'设备基线读数为四十。',event_time:'2023-02-04'},current={...base,memory_id:'current',observation_id:'o-current',episode_id:'session-2',text:'设备当前读数为二十。',event_time:'2023-08-11'},workers=createMemoryInvestigationWorkers({question_request:{query_type:'state_update',question:'设备在2023-02-04记录过一个基线值，目前的读数是多少？'},memory_nodes:[baseline,current],memory_edges:[],candidate_budget:8}),result=await workers.search.run({state:{snapshot:{memory_nodes:[],memory_edges:[],patient_profile:null,recent_sessions:[]}},instruction:{search_terms:['设备','读数'],temporal:{operator:'latest',start_date:'2023-02-04',prefer:'latest'}}});
  assert.equal(result.snapshot.temporal_gate,null);assert.deepEqual(result.snapshot.memory_nodes.map(node=>node.memory_id),['current','baseline']);
});

test('Search Context and Trace expose one discovery result-signal shape and Context reports zero recall',async()=>{
  const base={observation_id:'o',subject_id:'p',source_type:'patient',episode_id:'session-1',turn_id:'1',event_time:'2024-01-16',certainty:1,polarity:'affirmed',families:['PE'],status:'active',version:1},a={...base,memory_id:'a',text:'患者初始指标异常。',factor_key:'glucose'},b={...base,memory_id:'b',observation_id:'o-b',text:'治疗后指标仍持续恶化。',factor_key:'glucose'},graphEdge={edge_id:'a-b',subject_id:'p',from_memory_id:'a',to_memory_id:'b',edge_family:'temporal',relation_type:'updates',support_memory_ids:['a','b'],status:'verified',confidence:1,persistent:true,causal_claim:false},workers=createMemoryInvestigationWorkers({question_request:{question:'指标为何持续恶化？'},memory_nodes:[a,b],memory_edges:[graphEdge],candidate_budget:8});
  const emptyState={snapshot:{memory_nodes:[],memory_edges:[],patient_profile:null,recent_sessions:[]}},search=await workers.search.run({state:emptyState,instruction:{search_terms:['初始指标']}}),context=await workers.context.run({state:emptyState,instruction:{search_terms:['完全不存在的术语']}}),trace=await workers.trace.run({state:{snapshot:{memory_nodes:[a],memory_edges:[],patient_profile:null,recent_sessions:[]}},instruction:{seed_memory_ids:['a'],target_memory_ids:['b'],depth:2,include_same_factor:false,include_same_concept:false}});
  for(const result of[search,context,trace])for(const key of['worker','selected_count','candidate_count','new_node_count','path_count','unconnected_target_count','zero_recall'])assert.ok(Object.hasOwn(result.trace.result_signal,key),`${result.trace.worker} missing ${key}`);
  assert.equal(context.trace.worker,'context');assert.equal(context.trace.zero_recall,true);assert.equal(context.trace.result_signal.selected_count,0);assert.equal(context.trace.result_signal.new_node_count,0);
  assert.equal(trace.trace.path_count,1);assert.equal(trace.trace.unconnected_target_count,0);
  const request=createQuestionRequest({question:'指标为何持续恶化？'}),view=policyView({version:'careharness-investigation-state.v1',request,snapshot:trace.snapshot,history:[{turn:1,decision:{worker:'trace',information_status:'insufficient',instruction:{},rationale:'追踪'},result:trace}]},{allowed_workers:['assess'],remaining_budget:2});
  assert.equal(view.previous_steps[0].result_signal.new_node_count,1);assert.equal(view.previous_steps[0].result_signal.path_count,1);assert.equal(view.previous_steps[0].result_signal.unconnected_target_count,0);assert.equal(view.current_information.navigation_paths[0].semantics,'navigation_only_non_causal');assert.equal(view.current_information.navigation_paths[0].navigation_links[0].link_kind,'verified_graph_edge');
});

test('Trace counts a newly discovered navigation path as progress even when nodes and edges are unchanged',async()=>{
  const base={observation_id:'o',subject_id:'p',source_type:'structured',episode_id:'session-1',turn_id:'1',event_time:'2025-01-01',certainty:1,polarity:'affirmed',families:['PE'],factor_key:'shared',status:'active',version:1},a={...base,memory_id:'a',text:'起点记录。'},b={...base,memory_id:'b',observation_id:'o-b',text:'终点记录。'},workers=createMemoryInvestigationWorkers({question_request:{question:'两条记录如何连接？'},memory_nodes:[a,b],memory_edges:[],candidate_budget:8}),state={snapshot:{memory_nodes:[a,b],memory_edges:[],navigation_paths:[],patient_profile:null,recent_sessions:[]}},instruction={seed_memory_ids:['a'],target_memory_ids:['b'],depth:2,include_same_factor:true,include_same_concept:false},first=await workers.trace.run({state,instruction}),second=await workers.trace.run({state:{snapshot:first.snapshot},instruction});
  assert.equal(first.changed,true);assert.equal(first.snapshot.navigation_paths.length,1);assert.deepEqual(first.snapshot.memory_nodes.map(node=>node.memory_id),['a','b']);assert.deepEqual(first.snapshot.memory_edges,[]);
  assert.equal(second.changed,false);
});

test('Trace worker cannot reintroduce nodes outside the hard temporal gate or permanent Refine boundary',async()=>{
  const base={observation_id:'o',subject_id:'p',text:'记录',source_type:'patient',episode_id:'session-1',turn_id:'1',certainty:1,polarity:'affirmed',families:['PE'],factor_key:'same',status:'active',version:1},allowed={...base,memory_id:'allowed',event_time:'2024-01-16'},excluded={...base,memory_id:'excluded',observation_id:'o-e',event_time:'2024-01-16'},outside={...base,memory_id:'outside',observation_id:'o-o',event_time:'2024-03-01'},temporal_gate={hard:true,kind:'relative_documentation_window',anchor_date:'2024-01-15',target_date:'2024-01-16',start_date:'2024-01-16',end_date:'2024-02-15',prefer:'earliest'},refinement_boundary={version:'careharness-refinement-boundary.v1',boundary_id:'refine-1',revision:1,excluded_memory_ids:['excluded'],temporal:{operator:'range',start_date:'2024-01-01',end_date:'2024-01-31'},permanent:true},workers=createMemoryInvestigationWorkers({question_request:{question:'患者在2024-01-15次日发生了什么？'},memory_nodes:[allowed,excluded,outside],memory_edges:[],candidate_budget:8,temporal_gate}),result=await workers.trace.run({state:{snapshot:{temporal_gate,refinement_boundary,memory_nodes:[allowed,excluded,outside],memory_edges:[],patient_profile:null,recent_sessions:[]}},instruction:{seed_memory_ids:['allowed'],depth:2,include_same_factor:true}});
  assert.deepEqual(result.snapshot.memory_nodes.map(node=>node.memory_id),['allowed']);assert.equal(result.trace.temporal_gate.start_date,'2024-01-16');assert.deepEqual(result.trace.refinement_boundary.excluded_memory_ids,['excluded']);
});
