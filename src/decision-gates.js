export const DECISION_GATES_VERSION='three-decision-gates.v1';

export const DECISION_GATE_FAMILY_CONTRACT=Object.freeze({
  clinical_need_and_safety:{primary:['CS','PE'],supporting:['BC','LO','CP']},
  understanding_and_clarification:{primary:['PA'],supporting:['PE','CS','LO']},
  preference_and_feasibility:{primary:['PA','BC'],supporting:['CP','PE','LO']}
});

const SAFETY_PATTERN=/过敏|禁忌|不得使用|避免使用|风险|危机|急诊|自伤|自杀|轻生|不想活|酮症酸中毒|\bDKA\b|意识模糊|昏迷|胸痛|呼吸困难|严重低血糖|allerg|contraindicat|avoid|emergency|self[- ]?harm|suicid|ketoacidosis|unconscious|chest pain|dyspn/iu;
const ESCALATION_PATTERN=/正在.{0,8}(?:自伤|自杀)|已经实施自伤|具体自杀计划|自杀手段.{0,8}(?:手边|可得)|意识模糊|昏迷|胸痛|呼吸困难|严重低血糖|尿酮.{0,4}\+\+|pH\s*7\.[0-2]|acute emergency|imminent|active suicid/iu;
const CONTRAINDICATION_PATTERN=/过敏|禁忌|不得使用|避免使用|终身禁用|allerg|contraindicat|must not use|avoid/iu;
const BELIEF_PATTERN=/认为|觉得|相信|理解|误以为|担心|害怕|顾虑|think|belie|understand|misunderstand|worr|fear|concern/iu;
const PREFERENCE_PATTERN=/偏好|愿意|希望|想要|不想|目标|优先|接受|拒绝|费用|预算|隐私|方便|prefer|willing|hope|want|goal|priority|accept|refus|cost|budget|privacy|convenien/iu;
const FEASIBILITY_PATTERN=/工作|家庭|照护|时间|费用|预算|保险|交通|住房|支持|依从|漏服|困难|不便|负担|work|family|caregiv|time|cost|budget|insurance|transport|housing|support|adherence|missed|difficult|burden/iu;
const CURRENT_PATTERN=/目前|当前|现在|正在|这两天|今天|昨晚|近期|recent|current|currently|now|today|tonight|last night/iu;
const HISTORICAL_PATTERN=/既往|病史|曾经|此前|过去|history|previous|formerly/iu;

export function runDecisionGates(queryPlan={},retrievalContext={},options={}){
  const enabled={
    clinical_need_and_safety:toBoolean(options.clinical_safety_gate),
    understanding_and_clarification:toBoolean(options.understanding_clarification_gate),
    preference_and_feasibility:toBoolean(options.preference_feasibility_gate)
  },records=stateRecords(retrievalContext),coverage=retrievalContext.trace?.evidence_index_gate?.coverage||null;
  const clinical=enabled.clinical_need_and_safety?clinicalSafetyGate(records):disabledGate('clinical_need_and_safety');
  const understanding=enabled.understanding_and_clarification?understandingGate(records,coverage):disabledGate('understanding_and_clarification');
  const preference=enabled.preference_and_feasibility?preferenceGate(records,clinical):disabledGate('preference_and_feasibility');
  const gates={clinical_need_and_safety:clinical,understanding_and_clarification:understanding,preference_and_feasibility:preference},executionOrder=Object.keys(enabled).filter(key=>enabled[key]);
  return{
    version:DECISION_GATES_VERSION,
    enabled,
    enabled_gate_count:executionOrder.length,
    execution_order:executionOrder,
    family_contract:DECISION_GATE_FAMILY_CONTRACT,
    gates,
    answer_guidance:answerGuidance(gates),
    provenance:{visible_state_count:records.length,referenced_state_ids:[...new Set(executionOrder.flatMap(key=>gates[key].referenced_state_ids||[]))],referenced_evidence_ids:[...new Set(executionOrder.flatMap(key=>gates[key].referenced_evidence_ids||[]))],gold_or_judge_input_used:false}
  };
}

function clinicalSafetyGate(records){
  const primary=byFamilies(records,DECISION_GATE_FAMILY_CONTRACT.clinical_need_and_safety.primary),supporting=byFamilies(records,DECISION_GATE_FAMILY_CONTRACT.clinical_need_and_safety.supporting),safetyFacts=uniqueFacts([...primary,...supporting].filter(item=>SAFETY_PATTERN.test(item.value))),contraindications=safetyFacts.filter(item=>CONTRAINDICATION_PATTERN.test(item.value)),redFlags=safetyFacts.filter(item=>ESCALATION_PATTERN.test(item.value)&&affirmedCurrent(item)),carePlans=uniqueFacts(supporting.filter(item=>item.family==='CP')),nonConflictingPlans=carePlans.filter(plan=>!contraindications.some(constraint=>contentOverlap(plan.value,constraint.value))&&(!contraindications.length||!/药|剂量|服用|medication|dose|take/iu.test(plan.value))),mustEscalate=redFlags.length>0;
  const selected=uniqueFacts([...safetyFacts,...primary.slice(0,8),...carePlans.slice(0,5),...supporting.filter(item=>['BC','LO'].includes(item.family)).slice(0,5)]).slice(0,18);
  return gateEnvelope('clinical_need_and_safety',selected,{
    risk_level:mustEscalate?'high':contraindications.length?'constrained':safetyFacts.length?'attention':'not_established',
    must_escalate:mustEscalate,
    red_flags:redFlags,
    contraindications,
    hard_constraints:contraindications.map(item=>({rule:'不得违背已记录的过敏或禁忌',...item})),
    safe_action_set:mustEscalate?nonConflictingPlans.filter(item=>/急诊|立即|尽快|危机|安全|联系|emergency|urgent|safety|contact/iu.test(item.value)):nonConflictingPlans,
    forbidden_action_set:contraindications.map(item=>({rule:'不得推荐与该禁忌或过敏相冲突的行动',state_id:item.state_id,evidence_ids:item.evidence_ids,value:item.value}))
  });
}

function understandingGate(records,coverage){
  const primary=byFamilies(records,DECISION_GATE_FAMILY_CONTRACT.understanding_and_clarification.primary),supporting=byFamilies(records,DECISION_GATE_FAMILY_CONTRACT.understanding_and_clarification.supporting),beliefs=uniqueFacts(primary.filter(item=>BELIEF_PATTERN.test(item.value))),conflicts=uniqueFacts(records.filter(item=>item.status==='conflict'||item.operation==='CONFLICT'||item.conflicts_with)),missing=[...new Set(coverage?.missing_facets||[])],selected=uniqueFacts([...beliefs,...conflicts,...primary,...supporting.slice(0,8)]).slice(0,16);
  const action=conflicts.length?'VERIFY':missing.length?'ASK':beliefs.length?'EDUCATE':'ANSWER';
  return gateEnvelope('understanding_and_clarification',selected,{
    recommended_action:action,
    belief_or_interpretation_facts:beliefs,
    conflicting_facts:conflicts,
    missing_information:missing,
    clarification_targets:missing.map(facet=>({facet,question:`请补充或确认与 ${facet} 相关的患者信息。`})),
    verification_targets:conflicts.map(item=>({state_id:item.state_id,evidence_ids:item.evidence_ids,value:item.value})),
    education_targets:beliefs.map(item=>({state_id:item.state_id,evidence_ids:item.evidence_ids,value:item.value,note:'回答时应核对该理解是否与临床事实一致。'}))
  });
}

function preferenceGate(records,clinical){
  const primary=byFamilies(records,DECISION_GATE_FAMILY_CONTRACT.preference_and_feasibility.primary),supporting=byFamilies(records,DECISION_GATE_FAMILY_CONTRACT.preference_and_feasibility.supporting),preferences=uniqueFacts(primary.filter(item=>item.family==='PA'&&PREFERENCE_PATTERN.test(item.value))),constraints=uniqueFacts([...primary,...supporting].filter(item=>FEASIBILITY_PATTERN.test(item.value))),plans=uniqueFacts(supporting.filter(item=>item.family==='CP')),blocked=Boolean(clinical.enabled&&clinical.must_escalate),safeActionIds=new Set((clinical.enabled?clinical.safe_action_set||[]:plans).map(item=>item.state_id)),feasible=blocked?[]:plans.filter(plan=>safeActionIds.has(plan.state_id));
  const selected=uniqueFacts([...preferences,...constraints,...plans,...primary]).slice(0,18);
  return gateEnvelope('preference_and_feasibility',selected,{
    constrained_by_clinical_gate:Boolean(clinical.enabled),
    blocked_by_escalation:blocked,
    preferences,
    feasibility_constraints:constraints,
    excluded_options:blocked?plans:plans.filter(item=>!feasible.some(option=>option.state_id===item.state_id)),
    feasible_options:feasible,
    personalized_ranking:feasible.map((item,index)=>({rank:index+1,option:item,basis_state_ids:[...new Set([...preferences,...constraints].map(fact=>fact.state_id))]})),
    implementation_plan:blocked?[{instruction:'先执行临床安全门的升级处理；在风险解除前不按偏好排序常规方案。'}]:feasible.slice(0,3)
  });
}

function answerGuidance(gates){
  const clinical=gates.clinical_need_and_safety,understanding=gates.understanding_and_clarification,preference=gates.preference_and_feasibility;
  return{
    precedence:['clinical_need_and_safety','understanding_and_clarification','preference_and_feasibility'],
    must_escalate:Boolean(clinical.enabled&&clinical.must_escalate),
    hard_constraints:clinical.enabled?clinical.hard_constraints:[],
    communication_action:understanding.enabled?understanding.recommended_action:null,
    clarification_targets:understanding.enabled?understanding.clarification_targets:[],
    feasible_options:preference.enabled?preference.feasible_options:[],
    instruction:'只使用门中引用的可见 State/Evidence；临床安全约束优先，理解澄清决定沟通动作，偏好排序只能在安全可行集合内进行。'
  };
}

function stateRecords(context){
  const evidenceById=new Map((context.evidence||[]).map(item=>[String(item.evidence_id),item])),out=[],seen=new Set();
  for(const state of context.states||[])for(const original of Array.isArray(state.merged_states)?state.merged_states:[state]){
    const stateId=String(original?.state_id||'');if(!stateId||seen.has(stateId))continue;seen.add(stateId);
    const evidenceIds=[...new Set(original.evidence_ids||[])].map(String),sourceTypes=[...new Set(evidenceIds.map(id=>evidenceById.get(id)?.source_type).filter(Boolean))];
    out.push({state_id:stateId,family:String(original.family||''),value:String(original.value||''),status:original.status??null,operation:original.operation??null,polarity:original.polarity??null,event_time:original.event_time??null,episode_id:original.episode_id??null,conflicts_with:original.conflicts_with??null,evidence_ids:evidenceIds,source_types:sourceTypes});
  }
  return out;
}

function gateEnvelope(name,facts,details){return{enabled:true,gate:name,input_families:DECISION_GATE_FAMILY_CONTRACT[name],referenced_state_ids:facts.map(item=>item.state_id),referenced_evidence_ids:[...new Set(facts.flatMap(item=>item.evidence_ids||[]))],facts,...details};}
function disabledGate(name){return{enabled:false,gate:name,input_families:DECISION_GATE_FAMILY_CONTRACT[name],referenced_state_ids:[],referenced_evidence_ids:[],facts:[]};}
function byFamilies(records,families){const allowed=new Set(families);return records.filter(item=>allowed.has(item.family));}
function uniqueFacts(records){const seen=new Set();return records.filter(item=>{if(!item?.state_id||seen.has(item.state_id))return false;seen.add(item.state_id);return true;});}
function affirmedCurrent(item){if(item.polarity==='negated'||/(?:无|否认|没有|未见).{0,8}(?:自伤|自杀|酮症酸中毒|意识模糊|胸痛|呼吸困难|低血糖)/u.test(item.value))return false;return CURRENT_PATTERN.test(item.value)||!HISTORICAL_PATTERN.test(item.value);}
function contentOverlap(left,right){const terms=value=>new Set((String(value||'').normalize('NFKC').toLowerCase().match(/[a-z][a-z0-9-]{2,}|[\p{Script=Han}]{2,6}/gu)||[]).filter(term=>term.length>1)),a=terms(left),b=terms(right);return[...a].some(term=>b.has(term));}
function toBoolean(value){return value===true||value==='true';}
