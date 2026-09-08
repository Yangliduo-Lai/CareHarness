import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryInvestigationWorkers } from '../src/investigation-workers.js';

function memory(id,text,{episode='a',turn=id,factor='target',source_text=text}={}){
  return{memory_id:id,observation_id:`o-${id}`,subject_id:'patient',episode_id:episode,turn_id:String(turn),event_time:'2130-01-01',text,source_text,source_type:'doctor',certainty:1,polarity:'affirmed',families:['CS'],factor_key:factor,status:'active',version:1};
}
const request=(type='medical_reasoning',scope='single_admission')=>({question:'What changed and why?',query_type:type,strategy_namespace:'medlocomo',scope});

test('MedLoCoMo Search balances dynamic missing aspects and caps the working set at 48',async()=>{
  const alpha=Array.from({length:40},(_,index)=>memory(`a-${index}`,`alpha evidence ${index}`,{episode:`a-${index%5}`})),beta=Array.from({length:40},(_,index)=>memory(`b-${index}`,`beta evidence ${index}`,{episode:`b-${index%5}`})),workers=createMemoryInvestigationWorkers({question_request:request(),memory_nodes:[...alpha,...beta],candidate_budget:48,search_candidate_limit:32,context_candidate_limit:64,assess_memory_limit:48,answer_memory_limit:32,evidence_preserving_refine:true,structured_evidence_ledger:true}),first=await workers.search.run({state:{snapshot:{memory_nodes:[],memory_edges:[],coverage_state:{missing_aspects:['alpha','beta']}}},instruction:{search_terms:['evidence']}});
  assert.equal(first.trace.stage_limits.search_new,32);assert.equal(first.trace.stage_limits.working_set,48);assert.equal(first.trace.aspect_top_k,4);assert.deepEqual(first.trace.effective_instruction.lenses.map(item=>item.objective),['alpha','beta']);
  assert.ok(first.snapshot.memory_nodes.some(node=>node.text.includes('alpha')));assert.ok(first.snapshot.memory_nodes.some(node=>node.text.includes('beta')));assert.ok(first.snapshot.memory_nodes.length<=48);
  const second=await workers.search.run({state:{snapshot:first.snapshot},instruction:{search_terms:['beta']}});assert.ok(second.snapshot.memory_nodes.length<=48);
});

test('MedLoCoMo Assess persists dynamic coverage and requires an aligned second Admission',async()=>{
  const first=memory('first','Target treatment improved.',{episode:'a',factor:'treatment'}),second=memory('second','Target treatment later failed.',{episode:'b',factor:'treatment'}),workers=createMemoryInvestigationWorkers({question_request:request('cross_admission_comparison','cross_admission'),memory_nodes:[first,second],candidate_budget:48,structured_evidence_ledger:true,relation_evaluator:async()=>({value:{assessment:'supported',relevant_memory_ids:['first','second'],covered_aspects:['improvement','failure'],answer_focus:[{aspect:first.text,role:'baseline',memory_ids:['first']},{aspect:second.text,role:'current',memory_ids:['second']}],role_coverage:[{role:'baseline',status:'covered',claim:first.text,memory_ids:['first']},{role:'current',status:'covered',claim:second.text,memory_ids:['second']}],connections:[],reasoning_hypotheses:[],missing_information:[]}})}),result=await workers.assess.run({state:{snapshot:{memory_nodes:[first,second],memory_edges:[]}},instruction:{objective:'align the same factor'}});
  assert.equal(result.snapshot.coverage_state.complete,true);assert.equal(result.snapshot.coverage_state.cross_admission.complete,true);assert.deepEqual(new Set(result.snapshot.coverage_state.covered_episode_ids),new Set(['a','b']));assert.deepEqual(result.snapshot.investigation_focus.missing_roles,[]);
});

test('evidence-preserving Refine removes duplicate States but retains independent facts and source IDs',async()=>{
  const kept=memory('kept','The target dose was 5 mg.',{episode:'a',turn:1}),duplicate=memory('duplicate','Doctor: The target dose was 5 mg.',{episode:'a',turn:1}),independent=memory('independent','The patient developed nausea.',{episode:'a',turn:2,factor:'symptom'}),workers=createMemoryInvestigationWorkers({question_request:request(),memory_nodes:[kept,duplicate,independent],candidate_budget:48,evidence_preserving_refine:true,structured_evidence_ledger:true}),assessment={assessment:'supported',relevant_memory_ids:['kept'],answer_focus:[],role_coverage:[],connections:[],reasoning_hypotheses:[],missing_information:[]},result=await workers.refine.run({state:{snapshot:{memory_nodes:[kept,duplicate,independent],memory_edges:[],assessment,answer_brief:assessment}},instruction:{memory_ids:['kept']}});
  assert.deepEqual(new Set(result.snapshot.memory_nodes.map(node=>node.memory_id)),new Set(['kept','independent']));assert.deepEqual(result.trace.duplicate_removed_memory_ids,['duplicate']);assert.equal(result.trace.removal_policy,'near_duplicate_or_explicit_hard_temporal_mismatch_only');
});
