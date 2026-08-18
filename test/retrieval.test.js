import test from'node:test';
import assert from'node:assert/strict';
import{analyzeQuery,planQuery,retrieveRelevantStates,retrieveStateCandidates}from'../src/retrieval.js';
import{buildEvidenceIndex,runEvidenceIndexGate,EVIDENCE_INDEX_GATE_VERSION}from'../src/evidence-index-gate.js';

const state=(state_id,family,value,extra={})=>({state_id,subject_id:'p',family,value,status:'active',source_type:'patient',event_time:'2024-01-01',episode_id:'session-1',turn_id:'1',certainty:1,polarity:'affirmed',evidence_ids:[`e-${state_id}`],version:1,version_chain:[],supersedes:null,conflicts_with:null,operation:'ADD',...extra});
const evidence=(evidence_id,text='患者存在目标记录。')=>({evidence_id,subject_id:'p',text,source_text:text,source_type:'patient',event_time:'2024-01-01',episode_id:'session-1',turn_id:'1',certainty:1,polarity:'affirmed'});
const plan=(keywords,question='测试问题',extra={})=>({query_type:'generic',question,intent:'lookup',target:keywords[0]||null,answer_slot:'fact',keywords,state_scopes:[],temporal_operator:'none',evidence_facets:[],options:[],...extra});

test('LLM query plans use family-only scopes and retain deterministic clinical priors',async()=>{
  let received;
  const gateway={config:{provider:'live-test'},async completeJSON(component,input,validator){received={component,input};const value=validator({intent:'查找既往诊断',target:'慢性代谢性疾病',answer_slot:'disease_entity',keywords:['既往病史','慢性代谢性疾病'],state_scopes:[{family:'BC',priority:'primary'}],temporal_operator:'history',evidence_facets:['medical_history'],options:[]});return{value,trace:{component,model:'planner-test'}};}};
  const result=await planQuery({task:'entity_exact_match',question:'患者既往病史中提到的慢性代谢性疾病是什么？'},gateway);
  assert.equal(received.component,'query_planner');
  assert.ok(result.plan.state_scopes.some(scope=>scope.family==='BC'&&scope.priority==='primary'));
  assert.ok(result.plan.state_scopes.some(scope=>scope.family==='CS'));
  assert.equal(result.fallback_used,false);
});

test('malformed planner output falls back to deterministic family planning',async()=>{
  const gateway={config:{provider:'live-test'},async completeJSON(component,input,validator){return{value:validator({unknown:true}),trace:{component}};}};
  const result=await planQuery({task:'state_update',question:'恩格列净目前状态是什么？'},gateway);
  assert.equal(result.fallback_used,true);
  assert.ok(result.plan.state_scopes.some(scope=>scope.family==='LO'));
  assert.ok(result.error);
});

test('family scopes are soft priors and never hide a direct match',()=>{
  const query=plan([], '查找特殊目标',{target:'特殊目标',state_scopes:[{family:'BC',priority:'primary'}]}),outside=state('outside','PE','患者报告特殊目标。'),inside=state('inside','BC','患者有其他既往史。'),context=retrieveStateCandidates(query,[inside,outside],[evidence('e-inside'),evidence('e-outside')]);
  assert.ok(context.states.some(item=>item.state_id==='outside'));
  assert.ok(context.states.some(item=>item.state_id==='inside'));
  assert.ok(context.candidates.find(item=>item.state_id==='inside').reasons.includes('scope_family_prior'));
});

test('medical aliases recover a zero-literal historical disease query',()=>{
  const query=analyzeQuery({task:'entity_exact_match',question:'患者既往病史中提到的慢性代谢性疾病是什么？'}),diabetes=state('diabetes','BC','患者之前被诊断为2型糖尿病。'),other=state('other','BC','患者曾经搬家。'),context=retrieveStateCandidates(query,[other,diabetes],[evidence('e-diabetes'),evidence('e-other')]);
  assert.equal(context.states[0].state_id,'diabetes');
  assert.ok(context.candidates[0].reasons.includes('medical_alias_match'));
  assert.ok(context.candidates[0].reasons.includes('scope_family_prior'));
});

test('exact duplicate content is one candidate slot while every original State and family remains auditable',()=>{
  const sharedEvidence='e-duplicate',states=[state('duplicate-pe-1','PE','患者夜间反复头痛。',{evidence_ids:[sharedEvidence],version:2}),state('duplicate-pe-2','PE','患者夜间反复头痛。',{evidence_ids:[sharedEvidence],version:1}),state('duplicate-cs','CS','患者夜间反复头痛。',{evidence_ids:[sharedEvidence],version:3})],context=retrieveStateCandidates(plan(['头痛']),states,[evidence(sharedEvidence,'患者夜间反复头痛。')]),merged=context.states[0];
  assert.equal(context.states.length,1);
  assert.equal(merged.merged_state_count,3);
  assert.deepEqual(new Set(merged.merged_state_ids),new Set(states.map(item=>item.state_id)));
  assert.deepEqual(new Set(merged.merged_families.map(item=>item.family)),new Set(['PE','CS']));
  assert.equal(context.trace.candidate_stage.content_dedup_gate.slots_saved,2);
  assert.equal(context.evidence.length,1);
});

test('shared-Evidence candidates cannot crowd independent provenance out of the cap',()=>{
  const shared=Array.from({length:8},(_,index)=>state(`a-shared-${index}`,'PE',`目标血糖相关记录 ${index}`,{evidence_ids:['e-shared']})),independent=Array.from({length:11},(_,index)=>state(`z-independent-${index}`,'CP',`目标血糖独立记录 ${index}`,{evidence_ids:[`e-independent-${index}`]})),evidenceRows=[evidence('e-shared','目标血糖共同记录'),...independent.map(item=>evidence(item.evidence_ids[0],item.value))],context=retrieveStateCandidates(plan(['目标血糖']),[...shared,...independent],evidenceRows,{limit:12}),selectedShared=context.states.filter(item=>item.evidence_ids.includes('e-shared'));
  assert.equal(context.states.length,12);
  assert.equal(selectedShared.length,1);
  assert.equal(context.trace.candidate_stage.provenance_redundancy.shared_evidence_group_count,1);
  assert.equal(context.trace.candidate_stage.provenance_redundancy.deferred_state_count,7);
});

test('a State carrying shared plus novel Evidence retains its novel provenance under the cap',()=>{
  const shared=state('a-shared','PE','目标血糖共同记录',{evidence_ids:['e-shared']}),overlap=state('b-overlap','PE','目标血糖共同记录',{evidence_ids:['e-shared','e-unique']}),independent=Array.from({length:11},(_,index)=>state(`z-overlap-independent-${index}`,'CP',`目标血糖独立记录 ${index}`,{evidence_ids:[`e-overlap-independent-${index}`]})),evidenceRows=[evidence('e-shared','目标血糖共同记录'),evidence('e-unique','独有睡眠信息'),...independent.map(item=>evidence(item.evidence_ids[0],item.value))],context=retrieveStateCandidates(plan(['目标血糖']),[shared,overlap,...independent],evidenceRows,{limit:12}),trace=context.candidates.find(item=>item.state_id==='b-overlap');
  assert.ok(context.states.some(item=>item.state_id==='a-shared'));
  assert.ok(context.states.some(item=>item.state_id==='b-overlap'));
  assert.ok(context.evidence.some(item=>item.evidence_id==='e-unique'));
  assert.equal(trace.provenance_priority,'novel_evidence');
  assert.deepEqual(trace.novel_evidence_ids,['e-unique']);
});

test('shared-Evidence provenance groups are interleaved fairly over multiple rounds',()=>{
  const run=groupCount=>{const groups=Array.from({length:groupCount},(_,groupIndex)=>{const name=String.fromCharCode(97+groupIndex),evidenceId=`e-round-${name}`;return{items:Array.from({length:8},(_,index)=>state(`${name}-round-${index}`,'PE',`目标血糖记录 ${name}-${index}`,{event_time:`2025-0${groupCount-groupIndex}-01`,evidence_ids:[evidenceId]})),evidence:evidence(evidenceId,'目标血糖共同记录')}}),context=retrieveStateCandidates(plan(['目标血糖']),groups.flatMap(group=>group.items),groups.map(group=>group.evidence),{limit:12}),counts=Object.fromEntries(groups.map(group=>[group.evidence.evidence_id,context.states.filter(item=>item.evidence_ids.includes(group.evidence.evidence_id)).length]));return{context,counts};};
  const two=run(2),three=run(3);
  assert.deepEqual(Object.values(two.counts),[6,6]);
  assert.deepEqual(Object.values(three.counts),[4,4,4]);
  assert.deepEqual(two.context.states.slice(0,6).map(item=>item.evidence_ids[0]),['e-round-a','e-round-b','e-round-a','e-round-b','e-round-a','e-round-b']);
});

test('rebuilding semantically identical States with different IDs keeps candidate semantics stable',()=>{
  const build=prefix=>[state(`${prefix}-shared-a`,'PE','A 目标血糖共同记录',{evidence_ids:['e-uuid-shared']}),state(`${prefix}-shared-b`,'CS','B 目标血糖共同记录',{evidence_ids:['e-uuid-shared']}),...Array.from({length:11},(_,index)=>state(`${prefix}-${index}`,'CP',`目标血糖独立记录 ${index}`,{evidence_ids:[`e-uuid-independent-${index}`]}))],evidenceRows=[evidence('e-uuid-shared','目标血糖共同记录'),...Array.from({length:11},(_,index)=>evidence(`e-uuid-independent-${index}`,`目标血糖独立记录 ${index}`))],semanticSet=items=>items.map(item=>JSON.stringify([item.family,item.value,[...item.evidence_ids].sort()])).sort(),first=retrieveStateCandidates(plan(['目标血糖']),build('first'),evidenceRows),second=retrieveStateCandidates(plan(['目标血糖']),build('second'),evidenceRows);
  assert.deepEqual(semanticSet(first.states),semanticSet(second.states));
  assert.deepEqual(first.states.filter(item=>item.evidence_ids.includes('e-uuid-shared')).map(item=>item.family),['PE']);
  assert.deepEqual(second.states.filter(item=>item.evidence_ids.includes('e-uuid-shared')).map(item=>item.family),['PE']);
});

test('State can match through linked Evidence text',()=>{
  const selected=state('selected','PE','患者报告近期变化',{evidence_ids:['e-selected']}),context=retrieveRelevantStates(plan(['视力模糊']),[selected],[evidence('e-selected','患者近期出现视力模糊。')]);
  assert.deepEqual(context.states.map(item=>item.state_id),['selected']);
});

test('state_update adds linked version context and ranks current State above history',()=>{
  const old=state('old','BC','患者曾经搬家',{event_time:'2024-01-01'}),current=state('current','CS','患者已经停用恩格列净',{event_time:'2024-02-01',supersedes:'old',version_chain:['old']}),query=analyzeQuery({task:'state_update',question:'恩格列净目前状态是什么？'}),context=retrieveStateCandidates(query,[old,current],[evidence('e-old','患者曾经搬家。'),evidence('e-current')]);
  assert.deepEqual(context.states.map(item=>item.state_id),['current','old']);
  assert.ok(context.candidates.find(item=>item.state_id==='old').reasons.includes('version_chain_context'));
  assert.equal(context.trace.linked_state_expansion,true);
});

test('temporal earliest uses visual-symptom aliases before date ordering',()=>{
  const query=analyzeQuery({task:'temporal_localization',question:'间歇性视力模糊最初出现是什么时候？'}),early=state('early','PE','进入1月后眼睛时不时看不清。',{event_time:'2024-01-05 00:00:00'}),later=state('later','PE','患者近期出现间歇性视力模糊。',{event_time:'2024-02-10 00:00:00'}),context=retrieveStateCandidates(query,[later,early],[evidence('e-later'),evidence('e-early')]);
  assert.deepEqual(context.states.slice(0,2).map(item=>item.state_id),['early','later']);
  assert.ok(context.candidates[0].matched_aliases.includes('看不清'));
});

test('multiple-choice candidates are traced and balanced per option',()=>{
  const question='以下哪些项目有记录？\nA. 恩格列净\nB. 二甲双胍\nC. 尿酮体\nD. 青光眼',states=[state('a','PE','患者已停用恩格列净'),state('b','CS','患者正在服用二甲双胍'),state('c','CP','医生建议不适时加测尿酮体')],query=analyzeQuery({task:'multiple_choice',question}),context=retrieveStateCandidates(query,states,states.map(item=>evidence(item.evidence_ids[0],item.value)));
  assert.deepEqual(new Set(context.states.map(item=>item.state_id)),new Set(['a','b','c']));
  assert.equal(context.trace.option_results.length,4);
  assert.deepEqual(context.trace.option_results.find(item=>item.option_id==='D').candidate_state_ids,[]);
  assert.equal(context.trace.candidate_stage.strategy.mode,'per_option_balancing');
});

test('high-noise medication decisions reserve candidate budget across clinical families and facets',()=>{
  const query=analyzeQuery({task:'inference_generation',question:'医生，我要不要把降糖药加量？'}),relevant=[state('hba1c','CS','患者糖化血红蛋白 HbA1c 为9.2%。'),state('hba1c-current','CS','患者当前 HbA1c 为9.2%。'),state('weight-loss','PE','患者近一个月体重下降5公斤。'),state('fatigue','PE','患者最近出现明显乏力。'),state('poly','PE','患者出现多饮、多尿和掉重。'),state('medication','CS','患者正在服用二甲双胍。'),state('adherence','PE','患者一直规律服用降糖药。'),state('trajectory','LO','患者的血糖控制持续恶化。'),state('response','LO','加用恩格列净后血糖仍然偏高。')],noise=[...Array.from({length:30},(_,index)=>state(`headache-${index}`,'PE',`患者第${index+1}次报告普通头痛。`,{event_time:`2024-03-${String(index%28+1).padStart(2,'0')}`})),...Array.from({length:24},(_,index)=>state(`lab-${index}`,'CS',`患者第${index+1}项无关肝功能检查正常。`)),...Array.from({length:12},(_,index)=>state(`history-${index}`,'BC',`患者既往背景记录${index+1}。`))],states=[...noise,...relevant],context=retrieveStateCandidates(query,states,states.map(item=>evidence(item.evidence_ids[0],item.value))),ids=new Set(context.states.flatMap(item=>item.merged_state_ids||[item.state_id]));
  assert.equal(context.states.length,18);
  for(const id of relevant.map(item=>item.state_id))assert.ok(ids.has(id),id);
  assert.equal(context.trace.candidate_stage.strategy.mode,'family_and_facet_coverage');
});

test('Evidence follows selected State IDs and missing IDs are traced',()=>{
  const selected=state('selected','PE','患者报告视力模糊',{evidence_ids:['e-selected','e-missing']}),context=retrieveRelevantStates(plan(['视力模糊']),[selected],[evidence('e-selected')]);
  assert.deepEqual(context.evidence.map(item=>item.evidence_id),['e-selected']);
  assert.deepEqual(context.trace.missing_evidence_ids,['e-missing']);
});

test('no lexical, alias, scope or facet signal remains a true zero recall',()=>{
  const context=retrieveRelevantStates(plan(['青光眼']),[state('recent','PE','患者今天乘坐公交就诊',{event_time:'2026-01-01'})],[evidence('e-recent')]);
  assert.deepEqual(context.states,[]);
  assert.equal(context.trace.zero_recall,true);
});

test('candidate retrieval is the final context and preserves capped candidates',()=>{
  const sharedEvidence='e-shared-final',states=[state('shared-pe','PE','患者夜间头痛。',{evidence_ids:[sharedEvidence]}),state('shared-cs','CS','头痛影响患者睡眠。',{evidence_ids:[sharedEvidence]}),state('support','CP','医生建议继续观察头痛。')],query=plan(['头痛','睡眠'],'头痛对患者睡眠有什么影响？',{state_scopes:[{family:'PE',priority:'primary'},{family:'CS',priority:'primary'}]}),context=retrieveRelevantStates(query,states,[evidence(sharedEvidence,'患者夜间头痛，疼得无法入睡。'),evidence('e-support','医生建议继续观察头痛。')]);
  assert.deepEqual(context.states.map(item=>item.state_id),context.trace.candidate_stage.ranked.map(item=>item.state_id));
  assert.equal(context.trace.selection_mode,'candidate_passthrough');
  assert.equal(Object.hasOwn(context.trace,'selector_stage'),false);
});

test('fallback plan and retrieval trace never expose benchmark answers',()=>{
  const item={task:'entity_exact_match',question:'血糖相关信息是什么？',gold:['秘密答案'],source_key_points:['秘密依据']},queryPlan=analyzeQuery(item),states=[state('b','CS','血糖偏高'),state('a','PE','血糖偏高')],context=retrieveRelevantStates(queryPlan,states,states.map(item=>evidence(item.evidence_ids[0]))),raw=JSON.stringify({queryPlan,trace:context.trace});
  assert.equal(raw.includes('秘密答案'),false);
  assert.equal(raw.includes('秘密依据'),false);
});

test('standalone Evidence Index Gate builds family indexes, query chains, and coverage repair',()=>{
  const query=analyzeQuery({task:'inference_generation',question:'医生，我要不要把降糖药加量？'}),states=[state('diagnosis','CS','患者被诊断为成人隐匿性自身免疫性糖尿病。'),state('medication','CS','患者正在服用二甲双胍和恩格列净。'),state('adherence','PE','患者一直规律服用降糖药。'),state('response','LO','口服降糖治疗后 HbA1c 仍由8.1%升至8.8%。'),state('objective','CS','患者当前 HbA1c 为8.8%。'),state('symptom','PE','患者持续体重下降、多饮、多尿和乏力。'),state('complication','CS','检查发现糖尿病视网膜病变。'),state('safety','CS','患者肾功能情况构成恩格列净用药安全禁忌。'),state('preference','PA','患者更偏好每天一次的治疗方案。'),state('care-plan','CP','医生建议检查 GADA、C肽并评估胰岛素治疗。'),state('trajectory','LO','血糖控制长期持续恶化。'),...Array.from({length:18},(_,index)=>state(`noise-${index}`,'CS',`第${index+1}条糖尿病血糖常规检查记录。`))],evidences=states.map(item=>evidence(item.evidence_ids[0],item.value)),index=buildEvidenceIndex(states,evidences),gate=runEvidenceIndexGate(query,states,evidences);
  assert.equal(index.version,EVIDENCE_INDEX_GATE_VERSION);
  assert.ok(index.by_family.get('CS').some(item=>item.state.state_id==='diagnosis'));
  assert.equal(gate.enabled,true);
  assert.ok(gate.candidate_state_ids.includes('safety'));
  assert.ok(gate.coverage.covered_facets.includes('contraindications_and_allergies'));
  assert.equal(gate.chains.length,1);
});

test('enabled gate is a fail-open union and every candidate reaches the final context',()=>{
  const query=analyzeQuery({task:'inference_generation',question:'昨晚头痛要不要吃点药？'}),states=[state('pain','PE','患者昨晚出现头痛。'),state('contra','CS','患者既往胃溃疡，NSAIDs 属于禁忌。'),state('preference','PA','患者希望优先采用非药物措施。'),state('care-plan','CP','医生曾建议必要时使用对乙酰氨基酚。')],candidate=retrieveStateCandidates(query,states,states.map(item=>evidence(item.evidence_ids[0],item.value)),{evidence_index_gate:true});
  assert.equal(candidate.trace.candidate_stage.mode,'evidence_index_chain_gate_union');
  for(const id of states.map(item=>item.state_id))assert.ok(candidate.states.some(item=>item.state_id===id),id);
  assert.equal(candidate.trace.selection_mode,'candidate_passthrough');
});

test('gate task profiles operate across benchmark task families and the retrieval path is always gated',()=>{
  const states=[state('fact','PE','患者头痛并感到焦虑。',{event_time:'2024-03-02'}),state('goal','PA','患者希望改善睡眠。'),state('care-plan','CP','医生建议继续监测。')],evidences=states.map(item=>evidence(item.evidence_ids[0],item.value)),tasks=['entity_exact_match','temporal_localization','state_update','multiple_choice','inference_generation','multi_hop_clinical_deduction','task_3','WAI'];
  for(const task of tasks){const query=analyzeQuery({task,question:task==='multiple_choice'?'哪些有记录？\nA. 头痛\nB. 睡眠':'患者的头痛、目标和变化是什么？'}),gate=runEvidenceIndexGate(query,states,evidences);assert.equal(gate.profile.task,task);assert.ok(gate.profile.required_facets.length);assert.ok(gate.chains.length,task);}
  const mandatory=retrieveStateCandidates(analyzeQuery({task:'entity_exact_match',question:'患者是否头痛？'}),states,evidences,{evidence_index_gate:false});
  assert.equal(mandatory.trace.evidence_index_gate.enabled,true);
  assert.equal(mandatory.trace.candidate_stage.mode,'evidence_index_chain_gate_union');
  assert.equal(mandatory.trace.candidate_stage.content_dedup_gate.enabled,true);
});
