import test from'node:test';
import assert from'node:assert/strict';
import{analyzeQuery,planQuery,retrieveEvidenceCandidates,retrieveRelevantStates,retrieveSessionEvidenceAnchors,retrieveStateCandidates}from'../src/retrieval.js';
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

test('numeric value matching preserves ranges and outranks generic older events for earliest queries',()=>{
  const weightQuery=analyzeQuery({task:'temporal_localization',question:'裤腰变松并再次下降约1-2斤被记录在什么时候？'}),weight=state('weight','LO','患者体重又下降了 1～2 斤。',{event_time:'2024-01-15'}),glucose=state('glucose','CS','患者空腹血糖为 12 mmol/L。',{event_time:'2024-01-05'}),weightContext=retrieveStateCandidates(weightQuery,[glucose,weight],[evidence('e-glucose','患者空腹血糖为 12 mmol/L。'),evidence('e-weight','患者体重又下降了 1～2 斤。')]);
  assert.equal(weightContext.states[0].state_id,'weight');
  assert.deepEqual(weightContext.candidates[0].matched_numeric_values,['1~2斤']);
  assert.equal(weightContext.trace.candidate_stage.channels.numeric_value_match,1);

  const earliestQuery=analyzeQuery({task:'temporal_localization',question:'患者餐后两小时血糖首次升至18.4 mmol/L被记录在什么时间？'}),generic=state('generic-glucose','CS','患者很早就需要监测餐后血糖。',{event_time:'2024-01-05'}),exact=state('exact-glucose','CS','患者餐后两小时血糖升至 18.4 mmol/L。',{event_time:'2024-03-18'}),earliestContext=retrieveStateCandidates(earliestQuery,[generic,exact],[evidence('e-generic-glucose',generic.value),evidence('e-exact-glucose',exact.value)]);
  assert.equal(earliestContext.states[0].state_id,'exact-glucose');
  assert.ok(earliestContext.candidates[0].reasons.includes('numeric_value_match'));
});

test('direct Evidence fallback recovers a hyphen-variant numeric fact omitted from State',()=>{
  const query=analyzeQuery({task:'temporal_localization',question:'过去一个月体位性头晕仅发生2-3次被记录在何时？'}),correct={...evidence('e-direct-correct','医生记录站起来眼前发白整月仅发生2‑3次。'),event_time:'2024-02-05'},noise={...evidence('e-direct-noise','医生记录空腹血糖为12 mmol/L。'),event_time:'2024-01-05'},context=retrieveEvidenceCandidates(query,[noise,correct]);
  assert.equal(context.evidence[0].evidence_id,'e-direct-correct');
  assert.ok(context.trace.ranked[0].reasons.includes('numeric_value_match'));
  assert.deepEqual(context.trace.ranked[0].matched_numeric_values,['2~3','2~3次']);
});

test('direct Evidence fallback keeps the adjacent atomic answer split from its query anchor',()=>{
  const query=analyzeQuery({task:'entity_exact_match',question:'患者震动感觉阈值 VPT 检查的结果范围是多少？'}),anchor={...evidence('obs-vpt:llm:1','患者完成了震动感觉阈值 VPT 检查。'),observation_id:'obs-vpt'},answer={...evidence('obs-vpt:llm:2','患者结果出来是18到22V。'),observation_id:'obs-vpt'},noise={...evidence('obs-vpt:llm:3','患者询问后续安排。'),observation_id:'obs-vpt'},context=retrieveEvidenceCandidates(query,[anchor,answer,noise],{limit:1,neighbor_radius:1,neighbor_seed_limit:1});
  assert.deepEqual(context.evidence.map(item=>item.evidence_id),['obs-vpt:llm:1','obs-vpt:llm:2']);
  assert.equal(context.trace.adjacent_count,1);
  assert.equal(context.trace.ranked[1].linked_to,'obs-vpt:llm:1');
});

test('Session anchor recovers a distant exact answer from the same observation',()=>{
  const query=analyzeQuery({task:'entity_exact_match',question:'患者 GADA 检查的具体滴度是多少？'}),rows=[
    {...evidence('obs-gada:llm:0','患者完成 GADA 检查，结果为强阳性。'),observation_id:'obs-gada',event_time:'2024-03-23'},
    ...Array.from({length:18},(_,index)=>({...evidence(`obs-gada:llm:${index+1}`,`第 ${index+1} 条常规问诊记录。`),observation_id:'obs-gada',event_time:'2024-03-23'})),
    {...evidence('obs-gada:llm:20','具体滴度大于 2000 U/mL。'),observation_id:'obs-gada',event_time:'2024-03-23'},
    {...evidence('obs-noise:llm:0','患者另一次复诊讨论 GADA 的意义。'),observation_id:'obs-noise',event_time:'2024-04-10'}
  ],context=retrieveSessionEvidenceAnchors(query,rows,{anchor_limit:1,evidence_limit:12});
  assert.equal(context.anchors[0].observation_id,'obs-gada');
  assert.ok(context.evidence.some(item=>item.evidence_id==='obs-gada:llm:20'));
  assert.equal(context.trace.version,'careharness-session-anchor.v1');
});

test('CGM upgrade inference seeds separate affordability and workplace-fit sessions',()=>{
  const query=analyzeQuery({task:'inference_generation',question:'医生，我现在用的是CGM，我有必要换个更高级的血糖贴吗？'}),rows=[
    {...evidence('cost:0','患者房租高、可支配收入低，CGM 监测耗材的长期开销已经很吃力。'),observation_id:'cost',episode_id:'session-4',event_time:'2024-01-07'},
    {...evidence('fit:0','患者第一次贴上的 CGM 传感器很隐蔽，在办公室明显更放松。'),observation_id:'fit',episode_id:'session-35',event_time:'2024-03-27'},
    {...evidence('noise:0','患者近期空腹血糖偏高。'),observation_id:'noise',episode_id:'session-70',event_time:'2024-08-20'}
  ],context=retrieveSessionEvidenceAnchors(query,rows,{anchor_limit:2,evidence_limit:8});
  assert.deepEqual(new Set(context.anchors.map(item=>item.observation_id)),new Set(['cost','fit']));
  assert.ok(context.evidence.some(item=>item.evidence_id==='cost:0'));
  assert.ok(context.evidence.some(item=>item.evidence_id==='fit:0'));
});

test('sleep and exercise multiple choice preserves evidence for every supported option',()=>{
  const question='结合近期情况，患者目前更符合哪些表现？A 疲劳后刷手机拖到凌晨1点；B 短时室内运动很快乏力；C 关电脑直接休息；D 运动频率过低影响控糖',query=analyzeQuery({task:'multiple_choice',question,options:['A','B','C','D']}),rows=[
    {...evidence('sleep:1','患者身体已经疲劳，但关电脑后仍刷手机拖延到凌晨一点多。'),observation_id:'sleep',episode_id:'session-22'},
    {...evidence('sleep:2','患者昨天尝试短时室内运动，却因连续熬夜很快乏力而停下来。'),observation_id:'sleep',episode_id:'session-22'},
    {...evidence('sleep:3','患者意识到近期运动频率特别低，可能影响控糖。'),observation_id:'sleep',episode_id:'session-22'},
    {...evidence('sleep:4','医生提出一般性睡眠建议。'),observation_id:'sleep',episode_id:'session-22'}
  ],context=retrieveSessionEvidenceAnchors(query,rows,{anchor_limit:1,evidence_limit:8});
  assert.deepEqual(new Set(context.evidence.map(item=>item.evidence_id)),new Set(['sleep:1','sleep:2','sleep:3','sleep:4']));
});

test('medication progression multiple choice anchors decline and monitoring evidence',()=>{
  const question='复查后当前用药与病情进展可能包括哪些？A 口服药继发性药效减弱；B 密切监测确认异常病程；C 完全未用药；D 无需关注',query=analyzeQuery({task:'multiple_choice',question,options:['A','B','C','D']}),rows=[
    {...evidence('progression:1','医生判断口服药可能出现继发性药效减弱。'),observation_id:'progression',episode_id:'session-25'},
    {...evidence('progression:2','医生建议加强监测后再评估并确认趋势。'),observation_id:'progression',episode_id:'session-25'},
    {...evidence('noise-progression:1','医生讨论其他血糖问题。'),observation_id:'noise-progression',episode_id:'session-60'}
  ],context=retrieveSessionEvidenceAnchors(query,rows,{anchor_limit:2,evidence_limit:8});
  assert.ok(context.evidence.some(item=>item.evidence_id==='progression:1'));
  assert.ok(context.evidence.some(item=>item.evidence_id==='progression:2'));
});

test('state-update Session anchor ignores baseline numbers in the question and prefers the latest observation',()=>{
  const query=analyzeQuery({task:'state_update',question:'患者初次 HbA1c 为 9.2%，最新检测是多少？'}),rows=[
    {...evidence('obs-old:llm:0','患者初次 HbA1c 为 9.2%。'),observation_id:'obs-old',event_time:'2024-01-12'},
    {...evidence('obs-new:llm:0','患者最新复查 HbA1c 为 8.8%。'),observation_id:'obs-new',event_time:'2024-03-18'}
  ],context=retrieveSessionEvidenceAnchors(query,rows,{anchor_limit:1,evidence_limit:8});
  assert.equal(context.anchors[0].observation_id,'obs-new');
  assert.deepEqual(context.anchors[0].matched_numeric_values,[]);
  assert.ok(context.evidence.some(item=>item.evidence_id==='obs-new:llm:0'));
});

test('state-update Session anchor resolves month-day dates without an explicit year',()=>{
  const query=analyzeQuery({task:'state_update',question:'相较于1月的餐后血糖，患者4月3日记录的餐后血糖数值是多少？'}),rows=[
    {...evidence('obs-exact-day:llm:0','患者4月3日晚餐后血糖直接飙到16.5 mmol/L。'),observation_id:'obs-exact-day',event_time:'2024-04-03'},
    {...evidence('obs-later:llm:0','患者后来回顾曾有一次餐后血糖升高。'),observation_id:'obs-later',event_time:'2024-05-26'}
  ],context=retrieveSessionEvidenceAnchors(query,rows,{anchor_limit:1,evidence_limit:8});
  assert.equal(context.anchors[0].observation_id,'obs-exact-day');
  assert.ok(context.evidence.some(item=>item.evidence_id==='obs-exact-day:llm:0'));
});

test('state-update Session anchor keeps an explicit day and early-month stage isolated from later updates',()=>{
  const exact=analyzeQuery({task:'state_update',question:'患者3月14日脑雾相较两周前是什么状态？'}),rows=[
    {...evidence('obs-exact:llm:0','患者3月14日脑雾加重，尤其早晨反应更慢。'),observation_id:'obs-exact',event_time:'2024-03-14'},
    {...evidence('obs-later:llm:0','患者3月23日反馈脑雾已经改善。'),observation_id:'obs-later',event_time:'2024-03-23'}
  ],exactContext=retrieveSessionEvidenceAnchors(exact,rows,{anchor_limit:3,evidence_limit:8});
  assert.deepEqual(exactContext.anchors.map(item=>item.observation_id),['obs-exact']);
  const early=analyzeQuery({task:'state_update',question:'患者3月初的血糖监测意愿状态是什么？'}),earlyRows=[
    {...evidence('obs-early:llm:0','患者3月初愿意测空腹、餐后两小时、外卖后及半夜上线后的血糖。'),observation_id:'obs-early',event_time:'2024-03-08'},
    {...evidence('obs-late:llm:0','患者3月27日开始使用CGM连续监测。'),observation_id:'obs-late',event_time:'2024-03-27'}
  ],earlyContext=retrieveSessionEvidenceAnchors(early,earlyRows,{anchor_limit:3,evidence_limit:8});
  assert.deepEqual(earlyContext.anchors.map(item=>item.observation_id),['obs-early']);
});

test('state-update Session anchors cover monitoring facets and split diet commitments',()=>{
  const monitoring=analyzeQuery({task:'state_update',question:'患者先前只愿意极简三点监测，24年3月的血糖监测意愿状态是什么？'}),monitoringRows=[
    {...evidence('obs-monitor:llm:0','医生记录患者愿意不挑状态、不挑时间测真实血糖。'),observation_id:'obs-monitor',event_time:'2024-03-10'},
    {...evidence('obs-monitor:llm:1','患者会测空腹、深夜吃完两小时、外卖后以及半夜上线后的血糖并反馈。'),observation_id:'obs-monitor',event_time:'2024-03-10'},
    {...evidence('obs-weak-monitor:llm:0','患者愿意偶尔测一下血糖。'),observation_id:'obs-weak-monitor',event_time:'2024-03-22'}
  ],monitoringContext=retrieveSessionEvidenceAnchors(monitoring,monitoringRows,{anchor_limit:1,evidence_limit:8});
  assert.equal(monitoringContext.anchors[0].observation_id,'obs-monitor');
  assert.ok(monitoringContext.evidence.some(item=>item.evidence_id==='obs-monitor:llm:1'));

  const diet=analyzeQuery({task:'state_update',question:'相较于1月，患者3月的深夜饮食底线是什么？'}),dietRows=[
    {...evidence('obs-diet:llm:0','患者深夜饮食维持80%版本：主食减半、咖啡半糖或无糖。'),observation_id:'obs-diet',event_time:'2024-03-08'},
    {...evidence('obs-diet:llm:1','医生要求加蛋白质。'),observation_id:'obs-diet',event_time:'2024-03-08'},
    {...evidence('obs-diet:llm:2','患者吃完不会立刻喝奶咖。'),observation_id:'obs-diet',event_time:'2024-03-08'},
    {...evidence('obs-diet:llm:3','患者可以尽量拖十几二十分钟。'),observation_id:'obs-diet',event_time:'2024-03-08'}
  ],dietContext=retrieveSessionEvidenceAnchors(diet,dietRows,{anchor_limit:1,evidence_limit:8});
  for(const id of['obs-diet:llm:0','obs-diet:llm:1','obs-diet:llm:2','obs-diet:llm:3'])assert.ok(dietContext.evidence.some(item=>item.evidence_id===id),id);
});

test('medication-adjustment inference anchors cover diagnosis, treatment failure, and insulin execution',()=>{
  const query=analyzeQuery({task:'inference_generation',question:'最近深夜吃完后口干头闷，要不要把晚上的药再加点？'}),rows=[
    {...evidence('obs-symptom:llm:0','患者深夜吃完后出现口干、头闷。'),observation_id:'obs-symptom',episode_id:'session-23',event_time:'2024-03-08'},
    {...evidence('obs-failure:llm:0','患者规律口服药后 HbA1c 仍从8.1%反弹到8.8%，药效已经撑不住。'),observation_id:'obs-failure',episode_id:'session-24',event_time:'2024-03-10'},
    {...evidence('obs-execution:llm:0','患者深夜加班没有隐私空间，仍无法按时打餐前胰岛素。'),observation_id:'obs-execution',episode_id:'session-19',event_time:'2024-03-01'},
    {...evidence('obs-diagnosis:llm:0','GADA 大于2000 U/mL，已确诊 SAID，胰岛功能快速下降。'),observation_id:'obs-diagnosis',episode_id:'session-31',event_time:'2024-03-23'}
  ],context=retrieveSessionEvidenceAnchors(query,rows,{anchor_limit:3,evidence_limit:12}),ids=new Set(context.anchors.map(item=>item.observation_id));
  assert.deepEqual(ids,new Set(['obs-diagnosis','obs-failure','obs-execution']));
  for(const id of['obs-diagnosis:llm:0','obs-failure:llm:0','obs-execution:llm:0'])assert.ok(context.evidence.some(item=>item.evidence_id===id),id);
});

test('safety inference anchors prioritize silent microvascular risk and DKA severity',()=>{
  const silent=analyzeQuery({task:'inference_generation',question:'最近夜里血糖上冲不难受了，还要盯吗？'}),silentRows=[
    {...evidence('obs-old-symptom:llm:0','患者以前夜里血糖上冲时会难受。'),observation_id:'obs-old-symptom',event_time:'2024-01-10'},
    {...evidence('obs-retina:llm:0','眼底检查发现散在微血管瘤、少量硬性渗出，属于轻度 NPDR。'),observation_id:'obs-retina',event_time:'2024-06-03'}
  ],silentContext=retrieveSessionEvidenceAnchors(silent,silentRows,{anchor_limit:1,evidence_limit:8});
  assert.equal(silentContext.anchors[0].observation_id,'obs-retina');
  assert.ok(silentContext.evidence.some(item=>item.evidence_id==='obs-retina:llm:0'));

  const leave=analyzeQuery({task:'inference_generation',question:'补液后我能早点走吗？'}),leaveRows=[
    {...evidence('obs-partial:llm:0','补液后口干略有缓解。'),observation_id:'obs-partial',event_time:'2024-03-20'},
    {...evidence('obs-dka:llm:0','患者血 pH 7.28、尿酮体 ++，并有短暂意识模糊和呼吸偏快。'),observation_id:'obs-dka',event_time:'2024-03-20'}
  ],leaveContext=retrieveSessionEvidenceAnchors(leave,leaveRows,{anchor_limit:1,evidence_limit:8});
  assert.equal(leaveContext.anchors[0].observation_id,'obs-dka');
  assert.ok(leaveContext.evidence.some(item=>item.evidence_id==='obs-dka:llm:0'));

  const monitor=analyzeQuery({task:'inference_generation',question:'最近站起来时眼前发白少了不少，能少测点血糖吗？'}),monitorRows=[
    {...evidence('obs-improved:llm:0','患者站起眼前发白已从隔几天一次减少到整月2–3次。'),observation_id:'obs-improved',event_time:'2024-02-05'},
    {...evidence('obs-high:llm:0','患者空腹血糖仍常在10–11 mmol/L，餐后曾明显飙升。'),observation_id:'obs-high',event_time:'2024-03-05'},
    {...evidence('obs-risk:llm:0','患者曾有尿酮体 ++、酸中毒和短暂意识模糊。'),observation_id:'obs-risk',event_time:'2024-03-20'}
  ],monitorContext=retrieveSessionEvidenceAnchors(monitor,monitorRows,{anchor_limit:3,evidence_limit:12});
  assert.deepEqual(new Set(monitorContext.anchors.map(item=>item.observation_id)),new Set(['obs-improved','obs-high','obs-risk']));
});

test('decision inference anchors cover cost, reversible sensory findings, and metabolic warning evidence',()=>{
  const cgm=analyzeQuery({task:'inference_generation',question:'我现在用的是CGM，有必要换个更高级的血糖贴吗？'}),cgmRows=[
    {...evidence('obs-cgm-generic:llm:0','患者使用 CGM 查看血糖。'),observation_id:'obs-cgm-generic',event_time:'2024-04-01'},
    {...evidence('obs-cgm-cost:llm:0','患者表示 CGM 耗材费用很吃力，医生建议改为关键周期使用。'),observation_id:'obs-cgm-cost',event_time:'2024-04-06'}
  ],cgmContext=retrieveSessionEvidenceAnchors(cgm,cgmRows,{anchor_limit:1,evidence_limit:8});
  assert.equal(cgmContext.anchors[0].observation_id,'obs-cgm-cost');

  const foot=analyzeQuery({task:'inference_generation',question:'脚底偶尔麻要吃药吗？'}),footRows=[
    {...evidence('obs-foot-generic:llm:0','患者偶尔脚底麻。'),observation_id:'obs-foot-generic',event_time:'2024-06-10'},
    {...evidence('obs-foot-specific:llm:0','VPT 为18到22V，仅在灰区；麻感持续十几分钟，活动后缓解，次日完全恢复。'),observation_id:'obs-foot-specific',event_time:'2024-06-13'}
  ],footContext=retrieveSessionEvidenceAnchors(foot,footRows,{anchor_limit:1,evidence_limit:8});
  assert.equal(footContext.anchors[0].observation_id,'obs-foot-specific');

  const morning=analyzeQuery({task:'inference_generation',question:'近两天早晨醒不动、脑子反应更迟缓，这要紧吗？'}),morningRows=[
    {...evidence('obs-morning-generic:llm:0','患者早晨有些疲劳。'),observation_id:'obs-morning-generic',event_time:'2024-03-10'},
    {...evidence('obs-morning-risk:llm:0','患者早晨醒不动且脑雾加重，空腹血糖持续9到12 mmol/L，需结合抗体和C肽评估胰岛功能。'),observation_id:'obs-morning-risk',event_time:'2024-03-14'}
  ],morningContext=retrieveSessionEvidenceAnchors(morning,morningRows,{anchor_limit:1,evidence_limit:8});
  assert.equal(morningContext.anchors[0].observation_id,'obs-morning-risk');
});

test('multi-hop anchors reserve sessions for each longitudinal mechanism node',()=>{
  const query=analyzeQuery({task:'multi_hop_clinical_deduction',question:'这两周午饭后脑子发胀、乏力，药一直按时吃，是不是药已经压不住血糖了？'}),rows=[
    {...evidence('obs-response:llm:0','规律使用二甲双胍和 DPP-4 后，HbA1c 曾从 9.2% 降至 8.1%。'),observation_id:'obs-response',episode_id:'session-11'},
    {...evidence('obs-failure:llm:0','口服药进入第三个月后仍然压不住空腹和餐后血糖。'),observation_id:'obs-failure',episode_id:'session-19'},
    {...evidence('obs-adherence:llm:0','患者二甲双胍和 DPP-4 一直按时吃、没有漏药。'),observation_id:'obs-adherence',episode_id:'session-4'},
    {...evidence('obs-noise:llm:0','患者偶尔午饭后有些疲劳。'),observation_id:'obs-noise',episode_id:'session-15'}
  ],context=retrieveSessionEvidenceAnchors(query,rows,{anchor_limit:3,evidence_limit:12}),ids=new Set(context.anchors.map(item=>item.observation_id));
  assert.deepEqual(ids,new Set(['obs-response','obs-failure','obs-adherence']));
});

test('temporal Session anchor prefers the original event over a later restatement',()=>{
  const query=analyzeQuery({task:'temporal_localization',question:'患者首次出现间歇性视力模糊是什么时候？'}),rows=[
    {...evidence('obs-original:llm:0','患者首次出现间歇性视力模糊。'),observation_id:'obs-original',event_time:'2024-01-15'},
    {...evidence('obs-restatement:llm:0','复诊时回顾患者首次出现间歇性视力模糊。'),observation_id:'obs-restatement',event_time:'2024-01-20'}
  ],context=retrieveSessionEvidenceAnchors(query,rows,{anchor_limit:1,evidence_limit:8});
  assert.equal(context.anchors[0].observation_id,'obs-original');
  assert.equal(context.anchors[0].event_time,'2024-01-15');
});

test('temporal Session anchor joins split patient weight details before a later clinician restatement',()=>{
  const query=analyzeQuery({task:'temporal_localization',question:'患者近期裤腰变松并再次下降约1-2斤的体重变化被记录在什么时候？'}),rows=[
    {...evidence('obs-original:llm:0','患者但感觉裤腰又松了一点点'),observation_id:'obs-original',event_time:'2024-01-15'},
    {...evidence('obs-original:llm:1','患者应该是比上次又掉了一点'),observation_id:'obs-original',event_time:'2024-01-15'},
    {...evidence('obs-original:llm:2','患者一两斤那种感觉。'),observation_id:'obs-original',event_time:'2024-01-15'},
    {...evidence('obs-restatement:llm:0','医生还记得你最近裤腰又松了、体重又掉了1-2斤'),observation_id:'obs-restatement',event_time:'2024-01-20'}
  ],context=retrieveSessionEvidenceAnchors(query,rows,{anchor_limit:1,evidence_limit:8});
  assert.equal(context.anchors[0].observation_id,'obs-original');
  assert.equal(context.anchors[0].event_time,'2024-01-15');
});

test('temporal Session anchor chooses the earliest high-signal event instead of a weak older mention',()=>{
  const query=analyzeQuery({task:'temporal_localization',question:'裤腰变松并再次下降约1-2斤的体重变化被记录在什么时候？'}),rows=[
    {...evidence('obs-weak:llm:0','医生询问是否有明显体重变化。'),observation_id:'obs-weak',event_time:'2024-01-06'},
    {...evidence('obs-original:llm:0','患者感觉裤腰又松了一点，体重又掉了一点。'),observation_id:'obs-original',event_time:'2024-01-15'},
    {...evidence('obs-restatement:llm:0','医生回顾裤腰变松并再次下降约1-2斤。'),observation_id:'obs-restatement',event_time:'2024-01-20'}
  ],context=retrieveSessionEvidenceAnchors(query,rows,{anchor_limit:1,evidence_limit:8});
  assert.equal(context.anchors[0].observation_id,'obs-original');
  assert.equal(context.anchors[0].event_time,'2024-01-15');
});

test('temporal Session anchor requires the continuous-occurrence cue when the question does',()=>{
  const query=analyzeQuery({task:'temporal_localization',question:'患者连续多日空腹血糖稳定在10–11 mmol/L的情况被记录在什么时候？'}),rows=[
    {...evidence('obs-unrelated-continuous:llm:0','医生说两杯全糖咖啡对血糖就像连续两脚油门，空腹以后可能稳到10–11。'),observation_id:'obs-unrelated-continuous',event_time:'2024-01-31'},
    {...evidence('obs-background:llm:0','医生回顾拉面加奶咖后空腹血糖可到10–11 mmol/L。'),observation_id:'obs-background',event_time:'2024-02-22'},
    {...evidence('obs-current:llm:0','医生记录空腹血糖连续几天落在10–11 mmol/L。'),observation_id:'obs-current',event_time:'2024-03-01'},
    {...evidence('obs-repeat:llm:0','医生再次提到空腹血糖连续几天在10–11 mmol/L。'),observation_id:'obs-repeat',event_time:'2024-03-02'}
  ],context=retrieveSessionEvidenceAnchors(query,rows,{anchor_limit:1,evidence_limit:8});
  assert.equal(context.anchors[0].observation_id,'obs-current');
});

test('temporal Session anchor distinguishes current shallow self-awakening from thirst and improvement transitions',()=>{
  const query=analyzeQuery({task:'temporal_localization',question:'患者每晚出现2-3次浅睡自行醒来的情况被记录在什么时候？'}),rows=[
    {...evidence('obs-thirst:llm:0','患者夜里被渴醒两三次。'),observation_id:'obs-thirst',event_time:'2024-02-12'},
    {...evidence('obs-current:llm:0','患者一晚上大概会醒两三次。'),observation_id:'obs-current',event_time:'2024-02-18'},
    {...evidence('obs-current:llm:1','患者有时候是自己醒，有时候是轻微不舒服弄醒。'),observation_id:'obs-current',event_time:'2024-02-18'},
    {...evidence('obs-current:llm:2','医生判断大脑处在浅睡阶段太久。'),observation_id:'obs-current',event_time:'2024-02-18'},
    {...evidence('obs-improved:llm:0','医生夜醒次数从2-3次降到1次甚至能一觉到天亮。'),observation_id:'obs-improved',event_time:'2024-02-20'}
  ],context=retrieveSessionEvidenceAnchors(query,rows,{anchor_limit:1,evidence_limit:8});
  assert.equal(context.anchors[0].observation_id,'obs-current');
  assert.equal(context.anchors[0].event_time,'2024-02-18');
});

test('temporal Session anchor prefers the original medication warning over later reminder language',()=>{
  const query=analyzeQuery({task:'temporal_localization',question:'医生是在什么时间提示患者可能出现口服降糖药的继发性药效减弱？'}),rows=[
    {...evidence('obs-original:llm:0','医生“药效继发性减弱”在2型糖尿病里需要警惕。'),observation_id:'obs-original',event_time:'2024-03-08'},
    {...evidence('obs-later:llm:0','医生之前已经提醒过继发性药效减弱的可能性。'),observation_id:'obs-later',event_time:'2024-03-10'}
  ],context=retrieveSessionEvidenceAnchors(query,rows,{anchor_limit:1,evidence_limit:8});
  assert.equal(context.anchors[0].observation_id,'obs-original');
  assert.equal(context.anchors[0].event_time,'2024-03-08');
});

test('temporal Session anchor selects the patient monitoring-frequency question instead of later ketone tests',()=>{
  const query=analyzeQuery({task:'temporal_localization',question:'患者关于酮症风险担忧并主动询问尿酮体监测频率的情况被记录在什么时间？'}),rows=[
    {...evidence('obs-question:llm:0','患者总怕自己会不会突然又出现酮体问题。'),observation_id:'obs-question',event_time:'2024-01-15'},
    {...evidence('obs-question:llm:1','患者还需要每天特地测尿酮体吗？'),observation_id:'obs-question',event_time:'2024-01-15'},
    {...evidence('obs-test:llm:0','患者尿酮体是（++）。'),observation_id:'obs-test',event_time:'2024-03-20'},
    {...evidence('obs-test:llm:1','患者明天早上测完空腹血糖和尿酮。'),observation_id:'obs-test',event_time:'2024-03-20'}
  ],context=retrieveSessionEvidenceAnchors(query,rows,{anchor_limit:1,evidence_limit:8});
  assert.equal(context.anchors[0].observation_id,'obs-question');
  assert.equal(context.anchors[0].event_time,'2024-01-15');
});

test('temporal Session anchor matches Chinese one-or-two ranges and the next-day occurrence cue',()=>{
  const query=analyzeQuery({task:'temporal_localization',question:'足底麻木持续十几分钟，站立活动1-2分钟后缓解，次日完全恢复这一事件被记录在什么时间？'}),rows=[
    {...evidence('obs-older:llm:0','足底感觉之后完全恢复，活动十几分钟。'),observation_id:'obs-older',event_time:'2024-06-15'},
    {...evidence('obs-event:llm:0','患者足底开始麻木。'),observation_id:'obs-event',event_time:'2024-06-22'},
    {...evidence('obs-event:llm:1','麻木持续了十几分钟。'),observation_id:'obs-event',event_time:'2024-06-22'},
    {...evidence('obs-event:llm:2','站起来活动一两分钟后就慢慢淡下去了。'),observation_id:'obs-event',event_time:'2024-06-22'},
    {...evidence('obs-review:llm:0','餐后走动1-2分钟就坐下写代码。'),observation_id:'obs-review',event_time:'2024-06-28'},
    {...evidence('obs-review:llm:1','负重感由10-20分钟下降到5-10分钟，但没有完全恢复。'),observation_id:'obs-review',event_time:'2024-06-28'}
  ],context=retrieveSessionEvidenceAnchors(query,rows,{anchor_limit:1,evidence_limit:8});
  assert.equal(context.anchors[0].observation_id,'obs-event');
  assert.deepEqual(context.anchors[0].matched_numeric_values,['1~2','1~2分钟']);
});

test('temporal discriminator prefers asserted numeric results over an earlier test plan',()=>{const query=analyzeQuery({task:'temporal_localization',question:'GADA强阳性、滴度大于2000 U/mL的结果记录在什么时候？'}),rows=[
  {...evidence('obs-plan:llm:0','医生计划安排GADA抗体检测。'),observation_id:'obs-plan',event_time:'2024-03-14'},
  {...evidence('obs-result:llm:0','检测结果显示GADA强阳性，滴度大于2000 U/mL。'),observation_id:'obs-result',event_time:'2024-03-23'}
],context=retrieveSessionEvidenceAnchors(query,rows,{anchor_limit:1,evidence_limit:8});assert.equal(context.anchors[0].observation_id,'obs-result');});

test('temporal Session evidence keeps the answer-bearing topic span ahead of unrelated time cues',()=>{
  const coffeeQuery=analyzeQuery({task:'temporal_localization',question:'在2024-02-20的记录中，患者会在什么时候饮用奶咖以提神？'}),coffeeRows=[
    {...evidence('obs-coffee:llm:0','医生饭后站5分钟。'),observation_id:'obs-coffee',event_time:'2024-02-20'},
    ...Array.from({length:10},(_,index)=>({...evidence(`obs-coffee:llm:${index+1}`,`第${index+1}条普通记录。`),observation_id:'obs-coffee',event_time:'2024-02-20'})),
    {...evidence('obs-coffee:llm:20','医生记录患者吃完深夜外卖后马上喝奶咖。'),observation_id:'obs-coffee',event_time:'2024-02-20'}
  ],coffee=retrieveSessionEvidenceAnchors(coffeeQuery,coffeeRows,{anchor_limit:1,evidence_limit:6});
  assert.ok(coffee.evidence.some(item=>item.evidence_id==='obs-coffee:llm:20'));
  const dryQuery=analyzeQuery({task:'temporal_localization',question:'在2024年3月1日的对话里，记录了患者与口干相关的什么情况？'}),dryRows=[
    {...evidence('obs-dry:llm:0','患者其他情况又出现了。'),observation_id:'obs-dry',event_time:'2024-03-01'},
    {...evidence('obs-dry:llm:20','患者喝水后暂时好一点，但很快又觉得干了。'),observation_id:'obs-dry',event_time:'2024-03-01'}
  ],dry=retrieveSessionEvidenceAnchors(dryQuery,dryRows,{anchor_limit:1,evidence_limit:4});
  assert.ok(dry.evidence.some(item=>item.evidence_id==='obs-dry:llm:20'));
});

test('explicit query date ranks the matching State event time above repeated historical values',()=>{
  const old=state('old-uacr','CS','患者 UACR 为 52 mg/g。',{event_time:'2024-07-10'}),dated=state('dated-uacr','LO','患者 UACR 从 52 mg/g 降至 34 mg/g。',{event_time:'2024-11-15'}),query=analyzeQuery({task:'entity_exact_match',question:'患者2024-11-15复查的 UACR 降至多少 mg/g？'}),context=retrieveStateCandidates(query,[old,dated],[evidence('e-old-uacr','患者 UACR 为 52 mg/g。'),evidence('e-dated-uacr','患者 UACR 从 52 mg/g 降至 34 mg/g。')],{limit:1});
  assert.deepEqual(context.states.map(item=>item.state_id),['dated-uacr']);
  assert.ok(context.trace.candidate_stage.ranked[0].reasons.includes('event_time_match'));
  assert.equal(context.trace.candidate_stage.channels.event_time_match,1);
});

test('multiple-choice candidates are traced and balanced per option',()=>{
  const question='以下哪些项目有记录？\nA. 恩格列净\nB. 二甲双胍\nC. 尿酮体\nD. 青光眼',states=[state('a','PE','患者已停用恩格列净'),state('b','CS','患者正在服用二甲双胍'),state('c','CP','医生建议不适时加测尿酮体')],query=analyzeQuery({task:'multiple_choice',question}),context=retrieveStateCandidates(query,states,states.map(item=>evidence(item.evidence_ids[0],item.value)));
  assert.deepEqual(new Set(context.states.map(item=>item.state_id)),new Set(['a','b','c']));
  assert.equal(context.trace.option_results.length,4);
  assert.deepEqual(context.trace.option_results.find(item=>item.option_id==='D').candidate_state_ids,[]);
  assert.equal(context.trace.candidate_stage.strategy.mode,'per_option_balancing');
});

test('multiple-choice candidate cap preserves the patient-asserted orthostatic symptom',()=>{const question='医生，我这段时间总觉得不太对劲，下面哪些表现和我目前的情况相符？\nA. 饮水量增加\nB. 半夜起床喝水2–3次\nC. 最近明显乏力，久坐后起身时会有轻微头晕\nD. 饮水量和以往差不多',critical=state('orthostatic-critical','PE','患者久坐后站起来还是会有点头晕。'),noise=Array.from({length:60},(_,index)=>state('orthostatic-noise-'+index,'PE','医生第'+(index+1)+'次询问近期口渴与疲劳情况。')),states=[...noise,critical],context=retrieveStateCandidates(analyzeQuery({task:'multiple_choice',question}),states,states.map(item=>evidence(item.evidence_ids[0],item.value)),{limit:12});assert.ok(context.states.some(item=>item.state_id==='orthostatic-critical'));});

test('high-noise medication decisions reserve candidate budget across clinical families and facets',()=>{
  const query=analyzeQuery({task:'inference_generation',question:'医生，我要不要把降糖药加量？'}),relevant=[state('hba1c','CS','患者糖化血红蛋白 HbA1c 为9.2%。'),state('hba1c-current','CS','患者当前 HbA1c 为9.2%。'),state('weight-loss','PE','患者近一个月体重下降5公斤。'),state('fatigue','PE','患者最近出现明显乏力。'),state('poly','PE','患者出现多饮、多尿和掉重。'),state('medication','CS','患者正在服用二甲双胍。'),state('adherence','PE','患者一直规律服用降糖药。'),state('trajectory','LO','患者的血糖控制持续恶化。'),state('response','LO','加用恩格列净后血糖仍然偏高。')],noise=[...Array.from({length:30},(_,index)=>state(`headache-${index}`,'PE',`患者第${index+1}次报告普通头痛。`,{event_time:`2024-03-${String(index%28+1).padStart(2,'0')}`})),...Array.from({length:24},(_,index)=>state(`lab-${index}`,'CS',`患者第${index+1}项无关肝功能检查正常。`)),...Array.from({length:12},(_,index)=>state(`history-${index}`,'BC',`患者既往背景记录${index+1}。`))],states=[...noise,...relevant],context=retrieveStateCandidates(query,states,states.map(item=>evidence(item.evidence_ids[0],item.value))),ids=new Set(context.states.flatMap(item=>item.merged_state_ids||[item.state_id]));
  assert.equal(context.states.length,18);
  for(const id of relevant.map(item=>item.state_id))assert.ok(ids.has(id),id);
  assert.equal(context.trace.candidate_stage.strategy.mode,'family_and_facet_coverage');
});

test('multiple-choice candidate cap reserves symptom-triggered ketone safety evidence',()=>{const question='医生，我最近有点不舒服，下面哪些做法更稳妥？（多选）\nA. 继续按空腹、餐后两小时及状态不稳时监测血糖\nB. 出现乏力、恶心等不适时加测尿酮体\nC. 只有血糖异常时再考虑加测尿酮体\nD. 增加空腹血糖监测次数',critical=state('ketone-critical','PE','患者出现乏力、口渴、恶心等情况就赶紧测尿酮体。'),risk=state('ketone-risk','CP','恩格列净会增加正常血糖酮症酸中毒风险。'),noise=Array.from({length:60},(_,index)=>state(`ketone-noise-${index}`,index%2?'CS':'CP',`患者第${index+1}条空腹和餐后血糖监测记录。`)),states=[...noise,critical,risk],context=retrieveStateCandidates(analyzeQuery({task:'multiple_choice',question}),states,states.map(item=>evidence(item.evidence_ids[0],item.value)),{limit:12}),ids=new Set(context.states.map(item=>item.state_id));assert.ok(ids.has('ketone-critical'));assert.ok(ids.has('ketone-risk'));});

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
