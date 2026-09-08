import test from 'node:test';
import assert from 'node:assert/strict';
import {applyInvestigationAssessment,investigationAssessmentInput} from '../src/careharness-actions.js';
import {promptFor} from '../src/prompts.js';
import {buildMedLoCoMoEvidenceLedger} from '../src/medlocomo-evidence-ledger.js';

const node=(id,text,source_text=text,episode_id='visit-a')=>({memory_id:id,subject_id:'patient',observation_id:episode_id,episode_id,turn_id:id,event_time:'2111-02-03',source_type:'doctor',text,source_text});
const request={question:'What was the result?',strategy_namespace:'medlocomo'};
const options={structured_evidence_ledger:true};

test('MedLoCoMo accepts a decisive source quote omitted by the semantic node',()=>{
  const baseline={memory_nodes:[node('result','The biopsy excluded a viral cause.','The biopsy excluded a viral cause. It showed a lichenoid reaction.')],memory_edges:[]};
  const assessment=applyInvestigationAssessment(request,baseline,{assessment:'supported',answer_focus:[{aspect:'It showed a lichenoid reaction.',source_ref:'memory:result'}],role_coverage:[{role:'outcome',status:'covered',claim:'It showed a lichenoid reaction.',source_ref:'memory:result'}]},options).semantic_evaluation;
  assert.equal(assessment.assessment,'supported');
  assert.deepEqual(assessment.answer_focus[0].source_refs,['memory:result']);
  assert.equal(assessment.role_coverage[0].status,'covered');
  assert.equal(assessment.missing_information.length,0);
});

test('MedLoCoMo source access still rejects an invented value or unrelated citation',()=>{
  const baseline={memory_nodes:[node('result','The level was 7 units.','The level was 7 units. Continue monitoring.')],memory_edges:[]};
  const assessment=applyInvestigationAssessment(request,baseline,{assessment:'supported',answer_focus:[{aspect:'The level was 19 units.',memory_ids:['result']},{aspect:'Condition Z was confirmed.',memory_ids:['missing']}],missing_information:[]},options).semantic_evaluation;
  assert.deepEqual(assessment.answer_focus,[]);
  assert.equal(assessment.assessment,'partial');
});

test('a compressed-node error cannot override MedLoCoMo source text in the handoff',()=>{
  const baseline={memory_nodes:[node('result','The level was 19 units.','The level was 7 units.')],memory_edges:[]};
  const assessment=applyInvestigationAssessment(request,baseline,{assessment:'supported',answer_focus:[{aspect:'The level was 19 units.',memory_ids:['result']}],missing_information:[]},options).semantic_evaluation;
  assert.deepEqual(assessment.answer_focus,[]);
  assert.equal(assessment.assessment,'partial');
});

test('structured event annotations retain verified source metadata and invalidate incomplete enumeration',()=>{
  const baseline={memory_nodes:[node('event','Treatment X was started.')],memory_edges:[]};
  const assessment=applyInvestigationAssessment(request,baseline,{assessment:'supported',counting:{unit:'event',scope_complete:true},occurrence_candidates:[
    {event_key:'start-x',admission_id:'visit-a',event_time:'2999-01-01',event_status:'documented',source_refs:['memory:event'],included:true},
    {event_key:'fabricated-visit',admission_id:'visit-b',event_status:'documented',source_refs:['memory:event'],included:true},
    {event_key:'bad-ref',admission_id:'visit-a',event_status:'documented',source_refs:['memory:event','memory:absent'],included:true}
  ]},options).semantic_evaluation;
  assert.equal(assessment.occurrence_candidates[0].event_time,'2111-02-03');
  assert.equal(assessment.occurrence_candidates[0].included,true);
  assert.equal(assessment.occurrence_candidates[1].included,false);
  assert.equal(assessment.occurrence_candidates[2].included,false);
  assert.equal(assessment.counting.scope_complete,false);
  assert.equal(assessment.assessment,'partial');
});

test('MedLoCoMo final Answer never receives Policy estimates alongside source rows',()=>{
  const sourceNode=node('a','Treatment X was started.');
  const rendered=promptFor('medlocomo_answer',{question:'How many events occurred?',medlocomo_question_type:'frequency_pattern',memory_nodes:[sourceNode],investigation_focus:{target:'99 total invented events',stop_condition:'99 are sufficient'},semantic_evaluation:{reasoning_hypotheses:[{summary:'An invented bridge.'}]},evidence_ledger:{version:'test',source_grounded:true,coverage:{complete:false},rows:[{source_ref:'memory:a',evidence_text:sourceNode.source_text}],task_structure:{counting:{observed_count:1,total_count:null}}}});
  const source=JSON.parse(rendered.match(/Memory source:\n(.+)\n\nQuestion:/u)[1]);
  assert.equal(source.evidence_ledger.rows.length,1);
  assert.equal(source.evidence_ledger.task_structure.counting.total_count,null);
  assert.doesNotMatch(rendered,/99 total|99 are sufficient|An invented bridge|control_focus/);
});

test('MedLoCoMo serializes each source excerpt once despite legacy Ledger claim fields',()=>{
  const sourceNode=node('a','The uniquely phrased outcome is documented here.');
  const evidence_ledger=buildMedLoCoMoEvidenceLedger({memory_nodes:[sourceNode],assessment:{assessment:'supported',role_coverage:[{role:'outcome',status:'covered',claim:sourceNode.source_text,memory_ids:['a']}]}});
  const rendered=promptFor('medlocomo_answer',{question:'What happened?',medlocomo_question_type:'longitudinal_progression',memory_nodes:[sourceNode],evidence_ledger});
  assert.equal(rendered.split(sourceNode.source_text).length-1,1);
});

test('MedMemory assessment schema and source visibility do not acquire MedLoCoMo event rules',()=>{
  const baseline={memory_nodes:[node('summary','Stable status.','Record includes a separate fact.')],memory_edges:[]};
  const input=investigationAssessmentInput({question:'Q',strategy_namespace:'medmemorybench'},baseline);
  assert.equal(Object.hasOwn(input.output_schema,'occurrence_candidates'),false);
  const result=applyInvestigationAssessment({question:'Q'},baseline,{assessment:'supported',answer_focus:[{aspect:'Record includes a separate fact.',memory_ids:['summary']}]}).semantic_evaluation;
  assert.equal(result.answer_focus.length,0);
});
