import test from'node:test';
import assert from'node:assert/strict';
import{DECISION_GATE_FAMILY_CONTRACT,DECISION_GATES_VERSION,runDecisionGates}from'../src/decision-gates.js';
import{promptFor}from'../src/prompts.js';

const state=(state_id,family,value,extra={})=>({state_id,subject_id:'p',family,value,status:'active',source_type:'patient',event_time:'2026-01-01',episode_id:'session-1',turn_id:'1',certainty:1,polarity:'affirmed',evidence_ids:[`e-${state_id}`],version:1,version_chain:[],supersedes:null,conflicts_with:null,operation:'ADD',...extra});
const evidence=(item)=>({evidence_id:item.evidence_ids[0],subject_id:'p',text:item.value,source_text:item.value,source_type:item.source_type||'patient',event_time:item.event_time,episode_id:item.episode_id,turn_id:item.turn_id,certainty:1,polarity:'affirmed'});

test('decision gates use the fixed six-family contract and preserve State/Evidence provenance',()=>{
  const states=[state('danger','PE','患者目前意识模糊，尿酮++。'),state('contra','CS','患者对 NSAIDs 过敏，属于用药禁忌。'),state('belief','PA','患者认为白天没有症状就是血糖已经改善。'),state('preference','PA','患者希望优先采用费用较低且每天一次的方案。'),state('context','BC','患者工作繁忙，预算有限。'),state('plan','CP','医生建议立即联系急诊并进行安全评估。'),state('trajectory','LO','血糖控制近期持续恶化。')],context={states,evidence:states.map(evidence),trace:{evidence_index_gate:{coverage:{missing_facets:['objective_results']}}}},output=runDecisionGates({question:'患者现在应该怎么处理？'},context,{clinical_safety_gate:true,understanding_clarification_gate:true,preference_feasibility_gate:true});
  assert.equal(output.version,DECISION_GATES_VERSION);
  assert.deepEqual(DECISION_GATE_FAMILY_CONTRACT.clinical_need_and_safety,{primary:['CS','PE'],supporting:['BC','LO','CP']});
  assert.deepEqual(DECISION_GATE_FAMILY_CONTRACT.understanding_and_clarification,{primary:['PA'],supporting:['PE','CS','LO']});
  assert.deepEqual(DECISION_GATE_FAMILY_CONTRACT.preference_and_feasibility,{primary:['PA','BC'],supporting:['CP','PE','LO']});
  assert.deepEqual(output.execution_order,['clinical_need_and_safety','understanding_and_clarification','preference_and_feasibility']);
  assert.equal(output.gates.clinical_need_and_safety.must_escalate,true);
  assert.ok(output.gates.clinical_need_and_safety.contraindications.some(item=>item.state_id==='contra'));
  assert.equal(output.gates.understanding_and_clarification.recommended_action,'ASK');
  assert.deepEqual(output.gates.understanding_and_clarification.missing_information,['objective_results']);
  assert.equal(output.gates.preference_and_feasibility.blocked_by_escalation,true);
  assert.deepEqual(output.gates.preference_and_feasibility.feasible_options,[]);
  assert.ok(output.provenance.referenced_state_ids.includes('danger'));
  assert.ok(output.provenance.referenced_evidence_ids.includes('e-danger'));
  assert.equal(output.provenance.gold_or_judge_input_used,false);
});

test('each optional gate can be disabled without disabling the mandatory evidence index layer',()=>{
  const item=state('plan','CP','医生建议继续监测并复诊。'),output=runDecisionGates({}, {states:[item],evidence:[evidence(item)],trace:{evidence_index_gate:{enabled:true,coverage:{missing_facets:[]}}}}, {preference_feasibility_gate:true});
  assert.equal(output.enabled_gate_count,1);
  assert.equal(output.gates.clinical_need_and_safety.enabled,false);
  assert.equal(output.gates.understanding_and_clarification.enabled,false);
  assert.equal(output.gates.preference_and_feasibility.enabled,true);
  assert.equal(output.gates.preference_and_feasibility.constrained_by_clinical_gate,false);
  assert.equal(output.gates.preference_and_feasibility.feasible_options[0].state_id,'plan');
});

test('preference ranking is a strict subset of the enabled clinical safe-action set',()=>{
  const states=[state('contra','CS','患者存在明确药物过敏禁忌。'),state('drug-plan','CP','医生建议调整药物剂量。',{source_type:'doctor'}),state('monitor-plan','CP','医生建议继续监测并复诊。',{source_type:'doctor'}),state('preference','PA','患者偏好更方便的方案。')],context={states,evidence:states.map(evidence),trace:{evidence_index_gate:{coverage:{missing_facets:[]}}}},output=runDecisionGates({},context,{clinical_safety_gate:true,preference_feasibility_gate:true}),clinicalIds=output.gates.clinical_need_and_safety.safe_action_set.map(item=>item.state_id),feasibleIds=output.gates.preference_and_feasibility.feasible_options.map(item=>item.state_id);
  assert.deepEqual(clinicalIds,['monitor-plan']);
  assert.deepEqual(feasibleIds,['monitor-plan']);
  assert.equal(output.gates.preference_and_feasibility.excluded_options.some(item=>item.state_id==='drug-plan'),true);
});

test('answer prompt makes enabled decision-gate output part of final generation with strict precedence',()=>{
  const prompt=promptFor('judge',{task:'inference_generation',question:'现在怎么办？',answer_contract:{language:'zh-CN',format:'短答案'},retrieved_states:[],retrieved_evidence:[],decision_gates:{enabled_gate_count:1,gates:{clinical_need_and_safety:{must_escalate:true}}}});
  assert.match(prompt,/decision_gates/);
  assert.match(prompt,/clinical_need_and_safety, understanding_and_clarification, preference_and_feasibility/);
  assert.match(prompt,/Clinical hard constraints and must_escalate take precedence/);
  assert.match(prompt,/internal State\/Evidence IDs must not appear/);
});
