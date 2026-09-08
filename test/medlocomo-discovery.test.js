import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryInvestigationWorkers } from '../src/investigation-workers.js';

function memory(memory_id,episode_id,turn_id,text,extra={}){
  return{memory_id,observation_id:`o-${memory_id}`,subject_id:'patient',episode_id,turn_id:String(turn_id),event_time:'2130-01-01',text,source_text:text,source_type:'doctor',certainty:1,polarity:'affirmed',families:['CS'],status:'active',version:1,...extra};
}

function hostilePairwiseRanker({records}){
  const ranked=[...records].sort((left,right)=>Number(left.node.memory_id.startsWith('noise'))-Number(right.node.memory_id.startsWith('noise'))||String(left.node.memory_id).localeCompare(String(right.node.memory_id))).reverse();
  return{records:ranked.map((record,index)=>({...record,pairwise_original_index:index,pairwise_admission_score:ranked.length-index,pairwise_admission_rank:index+1,pairwise_turn_score:ranked.length-index,pairwise_turn_rank:index+1,pairwise_turn_rank_within_admission:1,pairwise_rank:index+1})),trace:{status:'applied',ranking_applied:true}};
}

test('MedLoCoMo cross-Admission Search protects rare literal anchors and diversifies only relevance-qualified Admissions',async()=>{
  const literal=memory('literal-cdiff','admission-target',7,'Testing confirmed C. diff infection.',{construction_kind:'literal_provenance'}),semanticDuplicate=memory('semantic-cdiff','admission-target',7,'Testing confirmed C. diff infection.',{construction_kind:'semantic'}),otherRelevant=memory('other-cdiff','admission-other',2,'The prior admission also documented C. diff infection.'),noise=Array.from({length:7},(_,index)=>memory(`noise-${index}`,`admission-noise-${index}`,1,`Unrelated rehabilitation note ${index}.`)),nodes=[literal,semanticDuplicate,otherRelevant,...noise],scores=new Map(nodes.map((node,index)=>[node.memory_id,node.memory_id.startsWith('noise')?.99-index/100:.05])),request={question:'Across admissions, what followed the documented infection?',task:'cross_admission_comparison',query_type:'cross_admission_comparison',strategy_namespace:'medlocomo',scope:'cross_admission'},workers=createMemoryInvestigationWorkers({question_request:request,memory_nodes:nodes,candidate_budget:3,search_ranker:hostilePairwiseRanker,embedding_retriever:async()=>({scores,admission_features:new Map(),trace:{status:'completed'}})}),state={snapshot:{memory_nodes:[],memory_edges:[],patient_profile:null,recent_sessions:[]}},result=await workers.search.run({state,instruction:{search_terms:['C. diff']}}),selected=new Set(result.snapshot.memory_nodes.map(node=>node.memory_id));
  assert.equal(selected.has('literal-cdiff'),true,'the exact source Turn must survive an adverse learned ranking');
  assert.equal(selected.has('semantic-cdiff'),false,'the semantic duplicate must not displace its literal source Turn');
  assert.equal(result.trace.ranked.find(row=>row.memory_id==='literal-cdiff').literal_anchor,true);
  assert.equal(result.trace.cross_admission_selection.protected_literal_anchor_count,1);
  assert.equal(result.trace.cross_admission_selection.one_turn_quota_scope,'relevance_qualified_admissions_only');
  assert.ok(result.trace.cross_admission_selection.shortlisted_admission_count<result.trace.cross_admission_selection.candidate_admission_count);
  assert.ok(result.snapshot.memory_nodes.every(node=>!node.episode_id.startsWith('admission-noise')),'irrelevant Admissions must not receive automatic quota slots');
});

test('MedLoCoMo cross-Admission Refine preserves assessor endpoints and later Search recovers soft removals',async()=>{
  const anchor=memory('anchor','admission-a',1,'Anchor event.'),focus=memory('focus','admission-b',2,'The treatment endpoint was documented.'),occurrence=memory('occurrence','admission-c',3,'A separate documented occurrence was confirmed.'),recoverable=memory('recoverable','admission-d',4,'A recoverable complication was documented.'),nodes=[anchor,focus,occurrence,recoverable],request={question:'How did the events differ across admissions?',task:'cross_admission_comparison',query_type:'cross_admission_comparison',strategy_namespace:'medlocomo',scope:'cross_admission'},workers=createMemoryInvestigationWorkers({question_request:request,memory_nodes:nodes,memory_edges:[],candidate_budget:8,answer_memory_limit:4,structured_evidence_ledger:true}),assessment={assessment:'supported',relevant_memory_ids:[],answer_focus:[{aspect:'treatment endpoint',source_refs:['memory:focus'],memory_ids:[],required_in_answer:true}],role_coverage:[],connections:[{from_memory_id:'focus',to_memory_id:'occurrence',supporting_memory_ids:['focus','occurrence']}],reasoning_hypotheses:[],occurrence_candidates:[{event_key:'separate event',admission_id:'admission-c',source_refs:['memory:occurrence'],memory_ids:['occurrence'],included:true,grounding_complete:true},{event_key:'invalid event',source_refs:['memory:not-in-state'],memory_ids:['not-in-state'],included:true,grounding_complete:true}],counting:{unit:'admission',scope_complete:true},missing_information:[]},state={snapshot:{memory_nodes:nodes,memory_edges:[],assessment,answer_brief:assessment,patient_profile:null,recent_sessions:[],refinement_boundary:null}},refined=await workers.refine.run({state,instruction:{memory_ids:['anchor']}});
  assert.deepEqual(new Set(refined.snapshot.memory_nodes.map(node=>node.memory_id)),new Set(['anchor','focus','occurrence']));
  assert.equal(refined.snapshot.refinement_boundary,null);
  assert.equal(refined.trace.refinement_semantics,'soft_recoverable_selection');
  assert.deepEqual(new Set(refined.trace.protected_assessment_memory_ids),new Set(['focus','occurrence']));
  assert.deepEqual(refined.trace.soft_removed_memory_ids,['recoverable']);
  assert.equal(refined.snapshot.assessment.occurrence_candidates.length,1);
  assert.deepEqual(refined.snapshot.assessment.occurrence_candidates[0].source_refs,['memory:occurrence']);
  assert.equal(refined.snapshot.assessment.counting.scope_complete,false);
  assert.equal(refined.snapshot.assessment.assessment,'partial');

  const searched=await workers.search.run({state:{snapshot:refined.snapshot},instruction:{search_terms:['recoverable complication']}});
  assert.equal(searched.snapshot.memory_nodes.some(node=>node.memory_id==='recoverable'),true);
  assert.equal(searched.trace.new_node_count,1);
  assert.equal(searched.snapshot.refinement_boundary,null);
});

test('soft Refine recovery never bypasses a hard question temporal gate and remains MedLoCoMo-isolated',async()=>{
  const inside=memory('inside','admission-a',1,'Recoverable target event.',{event_time:'2130-01-01'}),outside=memory('outside','admission-b',1,'Recoverable target event.',{event_time:'2130-02-01'}),softBoundary={version:'careharness-refinement-boundary.v1',boundary_id:'legacy-soft',revision:1,excluded_memory_ids:['inside'],temporal:{},permanent:true},hardGate={hard:true,kind:'explicit_date',anchor_date:'2130-01-01',target_date:'2130-01-01',start_date:'2130-01-01',end_date:'2130-01-01',prefer:'earliest'},medRequest={question:'What happened on 2130-01-01 across admissions?',task:'cross_admission_comparison',query_type:'cross_admission_comparison',strategy_namespace:'medlocomo',scope:'cross_admission'},medWorkers=createMemoryInvestigationWorkers({question_request:medRequest,memory_nodes:[inside,outside],candidate_budget:4,temporal_gate:hardGate}),state={snapshot:{memory_nodes:[],memory_edges:[],patient_profile:null,recent_sessions:[],refinement_boundary:softBoundary}},medResult=await medWorkers.search.run({state,instruction:{search_terms:['Recoverable target']}});
  assert.deepEqual(medResult.snapshot.memory_nodes.map(node=>node.memory_id),['inside']);
  assert.equal(medResult.trace.soft_refinement_recovery,true);
  assert.equal(medResult.trace.temporal_gate.hard,true);

  const genericWorkers=createMemoryInvestigationWorkers({question_request:{question:'Find the target.'},memory_nodes:[inside,outside],candidate_budget:4}),genericResult=await genericWorkers.search.run({state,instruction:{search_terms:['Recoverable target']}});
  assert.deepEqual(genericResult.snapshot.memory_nodes.map(node=>node.memory_id),['outside']);
  assert.equal(genericResult.trace.soft_refinement_recovery,false);
});
