import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAdaptiveInvestigationContext } from '../src/matched-runtime.js';
import { medLoCoMoInvestigationStrategy } from '../src/prompts.js';

function memory(id,text,{episode_id='admission-a',subject_id='medlocomo-test',turn_id='1'}={}){
  return{memory_id:id,observation_id:`observation-${id}`,subject_id,episode_id,turn_id,event_time:'2130-01-01 10:00:00',source_type:'doctor',text,source_text:text,construction_kind:'literal_provenance',status:'active'};
}
function request(type,question='Why did management change?'){
  return{question,task:type,scope:type==='medical_reasoning'?'single_admission':'cross_admission',strategy_namespace:'medlocomo',strategy_profile:medLoCoMoInvestigationStrategy(type)};
}
function obeyFinalization(input,searchTerms=['target']){
  const worker=input.allowed_workers[0],searchCount=input.investigation_progress?.worker_counts?.search||0;
  return{worker,information_status:worker==='answer'?'sufficient':'unknown',instruction:worker==='search'?{search_terms:[searchTerms[Math.min(searchCount,searchTerms.length-1)]]}:worker==='assess'?{objective:'assess the final source packet'}:{},rationale:'follow the bounded MedLoCoMo finalization gate'};
}
function supported(nodes){
  return{value:{assessment:'supported',relevant_memory_ids:nodes.map(node=>node.memory_id),covered_aspects:nodes.map(node=>node.text),answer_focus:nodes.map((node,index)=>({aspect:node.text,role:index?'current':'baseline',memory_ids:[node.memory_id],required_in_answer:true})),role_coverage:nodes.map((node,index)=>({role:index?'current':'baseline',status:'covered',claim:node.text,memory_ids:[node.memory_id]})),connections:[],reasoning_hypotheses:[],missing_information:[]}};
}

test('small-budget MedLoCoMo starts with Search and reserves Assess Verify Answer',async()=>{
  const nodes=[memory('target','The target event was documented.')],inputs=[];
  const output=await buildAdaptiveInvestigationContext({question_request:request('medical_reasoning'),memory_nodes:nodes,investigation_budget:1,investigation_policy:async input=>{inputs.push(input);return obeyFinalization(input);},relation_evaluator:async()=>({value:{assessment:'supported',relevant_memory_ids:['target'],covered_aspects:['The target event was documented.'],answer_focus:[{aspect:'The target event was documented.',role:'target',memory_ids:['target'],required_in_answer:true}],role_coverage:[{role:'target',status:'covered',claim:'The target event was documented.',memory_ids:['target']}],connections:[],reasoning_hypotheses:[],missing_information:[]}})});
  assert.deepEqual(output.investigation_trace.map(step=>step.worker),['search','assess','verify','answer']);
  assert.deepEqual(inputs.map(input=>input.allowed_workers),[['search'],['assess'],['verify'],['answer']]);
  assert.equal(output.investigation_trace[0].finalization_state.packet_changed,true);
  assert.equal(output.investigation_trace[1].finalization_state.semantic_assessment_fresh,true);
  assert.equal(output.semantic_assessment_fresh,true);
  assert.equal(output.source_verification_fresh,true);
  assert.equal(output.semantic_complete,true);
  assert.equal(output.answer_ready,true);
});

test('policy failure inside the reserved finalization sequence uses bounded fallbacks',async()=>{
  const nodes=[memory('target','The target event was documented.')];
  const output=await buildAdaptiveInvestigationContext({question_request:request('medical_reasoning'),memory_nodes:nodes,investigation_budget:1,investigation_policy:async input=>{if(input.allowed_workers[0]==='search')return obeyFinalization(input);throw new Error('policy unavailable');},relation_evaluator:async input=>supported(input.nodes)});
  assert.deepEqual(output.investigation_trace.map(step=>step.worker),['search','assess','verify','answer']);
  assert.deepEqual(output.trace.investigation.turns.map(step=>step.fallback_used),[false,true,true,true]);
  assert.equal(output.semantic_assessment_fresh,true);
  assert.equal(output.source_verification_fresh,true);
  assert.equal(output.answer_ready,true);
});

test('failed MedLoCoMo assessor remains a fresh attempt but never masquerades as semantic completeness',async()=>{
  const nodes=[memory('target','The target event was documented.')];
  const output=await buildAdaptiveInvestigationContext({question_request:request('medical_reasoning'),memory_nodes:nodes,investigation_budget:1,investigation_policy:async input=>obeyFinalization(input),relation_evaluator:async()=>{const error=new Error('invalid evaluator JSON');throw Object.assign(error,{gatewayTrace:{component:'careharness_evaluate',error:{kind:'invalid_json',message:error.message}}});}});
  assert.deepEqual(output.investigation_trace.map(step=>step.worker),['search','assess','verify','answer']);
  assert.equal(output.trace.semantic_relation_evaluator.status,'failed');
  assert.equal(output.semantic_assessment_fresh,true);
  assert.equal(output.source_verification_fresh,true);
  assert.equal(output.semantic_complete,false);
  assert.equal(output.verification_complete,true);
  assert.equal(output.answer_ready,false);
  assert.deepEqual(output.answer_ready_blockers,['semantic_assessment_incomplete']);
});

test('a Verify mutation is reassessed before Answer while evaluator budget remains',async()=>{
  const nodes=[memory('kept','Target evidence from the patient.',{subject_id:'patient-a'}),memory('foreign','Target evidence from another patient.',{subject_id:'patient-b',turn_id:'2'})];let assessments=0;
  const output=await buildAdaptiveInvestigationContext({question_request:request('medical_reasoning'),memory_nodes:nodes,investigation_budget:1,investigation_policy:async input=>obeyFinalization(input),relation_evaluator:async input=>{assessments++;return supported(input.nodes);}});
  assert.deepEqual(output.investigation_trace.map(step=>step.worker),['search','assess','verify','assess','answer']);
  assert.equal(assessments,2);
  assert.equal(output.memory_nodes.length,1);
  assert.equal(new Set(output.memory_nodes.map(node=>node.subject_id)).size,1);
  assert.equal(output.investigation_trace[2].finalization_state.packet_changed,true);
  assert.equal(output.investigation_trace[2].finalization_state.semantic_assessment_fresh,false);
  assert.equal(output.semantic_assessment_fresh,true);
  assert.equal(output.answer_ready,true);
});

test('three exhausted Assess calls forbid another discovery and fail readiness if final selection then changes',async()=>{
  const nodes=['alpha','beta','gamma'].flatMap((term,index)=>[
    memory(`${term}-kept`,`${term} target evidence.`,{episode_id:`admission-${index+1}`,subject_id:'patient-a',turn_id:String(index*2+1)}),
    memory(`${term}-foreign`,`${term} target evidence.`,{episode_id:`admission-${index+1}`,subject_id:'patient-b',turn_id:String(index*2+2)}),
  ]),searchTerms=['alpha','beta','gamma'];let assessments=0;
  const output=await buildAdaptiveInvestigationContext({question_request:request('cross_admission_comparison','How did target management differ across admissions?'),memory_nodes:nodes,investigation_budget:10,investigation_policy:async input=>{
    const searchCount=input.investigation_progress?.worker_counts?.search||0,worker=input.allowed_workers.includes('search')?'search':input.allowed_workers[0];
    return{worker,information_status:worker==='answer'?'sufficient':'unknown',instruction:worker==='search'?{search_terms:[searchTerms[Math.min(searchCount,2)]]}:worker==='assess'?{objective:'assess both comparison sides'}:{},rationale:'exercise the fixed assessor allowance'};
  },relation_evaluator:async input=>{assessments++;return{value:{assessment:'partial',relevant_memory_ids:input.nodes.map(node=>node.memory_id),covered_aspects:['one bounded comparison packet'],answer_focus:[],role_coverage:[],connections:[],reasoning_hypotheses:[],missing_information:['another comparison detail']}};}});
  const workers=output.investigation_trace.map(step=>step.worker),lastAssess=workers.lastIndexOf('assess');
  assert.equal(assessments,3);
  assert.deepEqual(workers,['search','assess','search','assess','search','assess','verify','answer']);
  assert.equal(workers.slice(lastAssess+1).some(worker=>['search','context','trace','refine'].includes(worker)),false);
  assert.equal(output.investigation_trace.at(-2).finalization_state.packet_changed,true);
  assert.equal(output.semantic_assessment_fresh,false);
  assert.equal(output.source_verification_fresh,true);
  assert.equal(output.answer_ready,false);
  assert.deepEqual(output.answer_ready_blockers,['final_packet_not_semantically_assessed']);
});

test('Answer-time selection cannot reuse an assessment of a larger packet',async()=>{
  const nodes=[memory('target-a','Target evidence A.',{episode_id:'admission-a',turn_id:'1'}),memory('target-b','Target evidence B.',{episode_id:'admission-b',turn_id:'2'})];
  const output=await buildAdaptiveInvestigationContext({question_request:request('adversarial','Is the target relation documented?'),memory_nodes:nodes,candidate_budget:4,investigation_budget:1,investigation_policy:async input=>{
    const worker=input.allowed_workers[0],instruction=worker==='search'?{search_terms:['Target evidence']}:worker==='refine'?{memory_ids:['not-a-visible-memory-id']}:worker==='assess'?{objective:'assess the complete candidate packet'}:{};
    return{worker,information_status:worker==='answer'?'sufficient':'unknown',instruction,rationale:'exercise final Answer selection freshness'};
  },relation_evaluator:async input=>supported(input.nodes)});
  assert.deepEqual(output.investigation_trace.map(step=>step.worker),['search','refine','assess','verify','answer']);
  assert.equal(output.investigation_trace.at(-1).finalization_state.packet_changed,true);
  assert.equal(output.investigation_trace.at(-1).finalization_state.semantic_assessment_fresh,false);
  assert.equal(output.investigation_trace.at(-1).finalization_state.source_verification_fresh,true);
  assert.equal(output.semantic_assessment_fresh,false);
  assert.equal(output.answer_ready,false);
  assert.deepEqual(output.answer_ready_blockers,['final_packet_not_semantically_assessed']);
});
