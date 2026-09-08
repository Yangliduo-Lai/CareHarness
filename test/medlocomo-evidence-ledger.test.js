import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMedLoCoMoAdmissionOverview,buildMedLoCoMoEvidenceLedger,buildMedLoCoMoRoleCoverage} from '../src/medlocomo-evidence-ledger.js';

const nodes=[
  node('a-1','adm-a','1','2110-01-02','doctor','Aspirin was started for atrial fibrillation.'),
  {...node('a-1-semantic','adm-a','1','2110-01-02','doctor','Aspirin treatment.'),construction_kind:'semantic'},
  node('b-1','adm-b','1','2111-03-04','doctor','Warfarin was started with INR monitoring.'),
  node('b-2','adm-b','2','2111-03-05','patient','I understand the INR monitoring plan.'),
];

test('Admission Overview is source-derived, compact, and deduplicates semantic copies of one Turn',()=>{
  const overview=buildMedLoCoMoAdmissionOverview(nodes);
  assert.equal(overview.navigation_only,true);
  assert.equal(overview.answer_evidence,false);
  assert.equal(overview.version,'medlocomo-admission-overview.v2-multi-topic-source-anchors');
  assert.equal(overview.admission_count,2);
  assert.equal(overview.admissions[0].turn_count,1);
  assert.equal(overview.admissions[1].turn_count,2);
  assert.match(overview.admissions[1].representative_source_excerpt,/Warfarin/);
  assert.ok(overview.admissions.every(admission=>admission.topic_anchors.length<=3));
  assert.ok(overview.admissions.flatMap(admission=>admission.topic_anchors).every(anchor=>anchor.turn_id&&anchor.source_ref.startsWith('turn:')&&anchor.excerpt.length<=120&&anchor.key_terms.length<=4));
});

test('Admission Overview indexes every literal Turn from raw Admission observations',()=>{
  const overview=buildMedLoCoMoAdmissionOverview([{episode_id:'adm-raw',event_time:'2112-01-01',raw_text:'[Turn=1][Role=Doctor][Time=2112-01-01 09:00:00]\nStart ceftriaxone today.\n\n[Turn=2][Role=Patient][Time=2112-01-01 09:02:00]\nMy fever is better.'}]);
  assert.equal(overview.admission_count,1);
  assert.equal(overview.admissions[0].turn_count,2);
  assert.deepEqual(overview.admissions[0].speaker_counts,{patient:1,doctor:1});
  assert.ok(overview.admissions[0].key_terms.includes('ceftriaxone'));
  assert.deepEqual(new Set(overview.admissions[0].topic_anchors.map(anchor=>anchor.turn_id)),new Set(['1','2']));
});

test('Admission Overview preserves uncommon acronyms, numeric facts, and more than one topic anchor',()=>{
  const overview=buildMedLoCoMoAdmissionOverview([{episode_id:'adm-rich',event_time:'2112-01-01',raw_text:'[Turn=1][Role=Doctor][Time=2112-01-01 09:00:00]\nThe catheter tip grew MRSA and vancomycin was started.\n\n[Turn=2][Role=Doctor][Time=2112-01-01 12:00:00]\nINR is 3.2, so warfarin is held.\n\n[Turn=3][Role=Patient][Time=2112-01-02 08:00:00]\nMy vision remains blurry.'}]),admission=overview.admissions[0];
  assert.ok(admission.key_terms.includes('mrsa'));
  assert.ok(admission.key_terms.includes('inr'));
  assert.equal(admission.topic_anchors.length,3);
  assert.deepEqual(new Set(admission.topic_anchors.map(anchor=>anchor.turn_id)),new Set(['1','2','3']));
});

test('Role coverage and Evidence Ledger retain every final source Turn once while roles reference aliases',()=>{
  const assessment={assessment:'supported',missing_information:[],answer_focus:[
    {role:'initial_management',aspect:'Aspirin was started for atrial fibrillation.',source_ref:'memory:a-1-semantic'},
    {role:'later_management',aspect:'Warfarin was started with INR monitoring.',source_refs:['memory:b-1'],memory_ids:['b-1']},
  ]};
  const coverage=buildMedLoCoMoRoleCoverage({assessment,memory_nodes:nodes}),ledger=buildMedLoCoMoEvidenceLedger({question_request:{question:'How did management change?'},assessment,memory_nodes:nodes});
  assert.equal(coverage.complete,true);
  assert.deepEqual(coverage.rows.map(row=>row.admission_ids),[['adm-a'],['adm-b']]);
  assert.equal(ledger.admission_count,2);
  assert.equal(ledger.row_count,3);
  assert.deepEqual(ledger.rows.map(row=>row.role),['initial_management','later_management','source_packet']);
  assert.equal(ledger.rows[1].evidence_text,'Warfarin was started with INR monitoring.');
  assert.equal(ledger.rows[1].turn_id,'1');
  assert.ok(ledger.rows[0].source_refs.includes('memory:a-1'));
  assert.ok(ledger.rows[0].source_refs.includes('memory:a-1-semantic'));
  assert.deepEqual(new Set(ledger.rows[0].memory_ids),new Set(['a-1','a-1-semantic']));
  assert.equal(ledger.rows[0].claim,ledger.rows[0].evidence_text);
  assert.equal(ledger.rows[0].role_interpretation_only,true);
  assert.equal(ledger.rows[0].roles[0].role,'initial_management');
  assert.equal(ledger.rows[0].roles[0].interpretation_only,true);
  assert.equal(ledger.role_annotations[0].interpretation_only,true);
  assert.equal('claim' in ledger.role_annotations[0],false);
  assert.equal(ledger.audit.input_memory_count,4);
  assert.equal(ledger.audit.retained_source_row_count,3);
  assert.equal(ledger.audit.duplicate_source_turn_count,1);
  assert.equal(ledger.audit.dropped[0].reason,'duplicate_source_turn');
});

test('Cross-admission Evidence Ledger aligns source references by Admission without inventing a comparison',()=>{
  const assessment={assessment:'supported',missing_information:[],role_coverage:[
    {role:'earlier_endpoint',status:'covered',claim:'Aspirin was started for atrial fibrillation.',source_refs:['memory:a-1']},
    {role:'later_endpoint',status:'covered',claim:'Warfarin was started with INR monitoring.',source_refs:['memory:b-1']},
  ]},ledger=buildMedLoCoMoEvidenceLedger({question_request:{question:'How did management change across admissions?',scope:'cross_admission'},assessment,memory_nodes:nodes}),alignment=ledger.task_structure.cross_admission_alignment;
  assert.equal(ledger.version,'medlocomo-evidence-ledger.v3-admission-aligned-source-pool');
  assert.equal(alignment.navigation_only,true);
  assert.equal(alignment.establishes_clinical_fact,false);
  assert.equal(alignment.source_admission_count,2);
  assert.equal(alignment.answer_relevant_admission_count,2);
  assert.equal(alignment.has_multiple_grounded_sides,true);
  assert.deepEqual(alignment.comparison_side_admission_ids,['adm-a','adm-b']);
  assert.deepEqual(alignment.admissions.map(row=>row.covered_roles),[['earlier_endpoint'],['later_endpoint']]);
  assert.ok(alignment.admissions[0].answer_relevant_source_refs.includes('memory:a-1'));
  assert.ok(alignment.admissions[1].answer_relevant_source_refs.includes('memory:b-1'));
});

test('Evidence Ledger preserves non-overlapping source fragments from duplicate State nodes in one Turn',()=>{
  const fragments=[node('fragment-1','adm-fragment','7','2113-01-01','doctor','Vancomycin was started.'),node('fragment-2','adm-fragment','7','2113-01-01','doctor','The catheter tip grew MRSA.')],ledger=buildMedLoCoMoEvidenceLedger({assessment:{assessment:'supported'},memory_nodes:fragments});
  assert.equal(ledger.row_count,1);
  assert.equal(ledger.rows[0].source_fragment_count,2);
  assert.match(ledger.rows[0].evidence_text,/Vancomycin was started\./u);
  assert.match(ledger.rows[0].evidence_text,/catheter tip grew MRSA\./u);
  assert.deepEqual(new Set(ledger.rows[0].memory_ids),new Set(['fragment-1','fragment-2']));
  assert.equal(ledger.audit.merged_fragment_row_count,1);
});

test('Evidence Ledger never upgrades a State paraphrase without source_text into source evidence',()=>{
  const paraphrase={...node('semantic-only','adm-a','9','2110-01-04','doctor','Semantic paraphrase not copied from the Turn.'),source_text:null,construction_kind:'semantic'},ledger=buildMedLoCoMoEvidenceLedger({assessment:{assessment:'supported'},memory_nodes:[nodes[0],paraphrase]});
  assert.equal(ledger.row_count,1);
  assert.equal(ledger.audit.invalid_source_count,1);
  assert.deepEqual(ledger.audit.dropped_memory_ids,['semantic-only']);
  assert.ok(ledger.rows.every(row=>!row.evidence_text.includes('Semantic paraphrase')));
});

test('Evidence Ledger never lets a partial assessor selection erase the rest of the final packet',()=>{
  const assessment={assessment:'partial',relevant_memory_ids:['b-1'],answer_focus:[],role_coverage:[{role:'unresolved',status:'missing',missing_detail:'one gap'}],missing_information:['one gap']},ledger=buildMedLoCoMoEvidenceLedger({question_request:{question:'Q'},assessment,memory_nodes:nodes});
  assert.equal(ledger.row_count,3);
  assert.deepEqual(new Set(ledger.rows.map(row=>row.admission_id)),new Set(['adm-a','adm-b']));
  assert.ok(ledger.rows.some(row=>row.evidence_text.includes('Aspirin was started for atrial fibrillation.')));
  assert.ok(ledger.rows.some(row=>row.evidence_text==='I understand the INR monitoring plan.'));
  assert.equal(ledger.audit.all_valid_source_turns_retained,true);
});

test('Evidence Ledger emits grounded connections only as interpretation links',()=>{
  const assessment={assessment:'supported',missing_information:[],connections:[
    {from_memory_id:'a-1-semantic',to_memory_id:'b-1',relation_type:'changed_to',assessment:'supports',supporting_memory_ids:['a-1','b-1'],confidence:.8},
    {from_memory_id:'missing',to_memory_id:'b-1',relation_type:'invented'},
  ]},ledger=buildMedLoCoMoEvidenceLedger({question_request:{question:'Q'},assessment,memory_nodes:nodes});
  assert.equal(ledger.interpretation_links.length,1);
  assert.equal(ledger.interpretation_links[0].interpretation_only,true);
  assert.equal(ledger.interpretation_links[0].establishes_clinical_fact,false);
  assert.equal(ledger.interpretation_links[0].relation_type,'changed_to');
  assert.deepEqual(new Set(ledger.interpretation_links[0].support_source_refs),new Set(['memory:a-1','memory:b-1']));
  assert.equal('claim' in ledger.interpretation_links[0],false);
});

test('Task structure counts verified documented events by admission and never promotes incomplete scope to a total',()=>{
  const assessment={assessment:'partial',missing_information:['another admission may exist'],occurrence_candidates:[
    {event_key:'MRSA infection',admission_id:'adm-a',event_status:'documented',source_ref:'memory:a-1',included:true},
    {event_key:'MRSA infection',admission_id:'adm-b',event_status:'documented',source_refs:['memory:b-1'],included:true},
    {event_key:'MRSA infection',admission_id:'adm-a',event_status:'documented',source_ref:'memory:missing',included:true},
    {event_key:'MRSA infection',admission_id:'adm-b',event_status:'planned',source_ref:'memory:b-2',included:true},
  ],counting:{unit:'admission',scope_complete:true}},ledger=buildMedLoCoMoEvidenceLedger({question_request:{question:'How often?'},assessment,memory_nodes:nodes}),structure=ledger.task_structure;
  assert.equal(structure.counting.unit,'admission');
  assert.equal(structure.counting.observed_count,2);
  assert.equal(structure.counting.scope_complete,false);
  assert.equal(structure.counting.total_count,null);
  assert.equal(structure.groups[0].observed_count,2);
  assert.equal(structure.occurrence_candidates[2].included,false);
  assert.equal(structure.occurrence_candidates[2].exclusion_reason,'unverified_source_ref');
  assert.equal(structure.occurrence_candidates[3].included,false);
  assert.equal(structure.occurrence_candidates[3].exclusion_reason,'event_status_planned');
});

test('Task structure cannot certify a total when a supported assessment still contains an invalid candidate',()=>{
  const assessment={assessment:'supported',missing_information:[],occurrence_candidates:[
    {event_key:'infection',admission_id:'adm-a',event_status:'documented',source_ref:'memory:a-1'},
    {event_key:'infection',admission_id:'adm-b',event_status:'documented',source_ref:'memory:missing'},
  ],counting:{unit:'admission',scope_complete:true}},structure=buildMedLoCoMoEvidenceLedger({assessment,memory_nodes:nodes}).task_structure;
  assert.equal(structure.counting.observed_count,1);
  assert.equal(structure.counting.scope_complete,false);
  assert.equal(structure.counting.total_count,null);
  assert.equal(structure.counting.blocking_candidate_count,1);
});

test('Task structure event identity includes Admission and conflicting statuses on one Turn become uncertain',()=>{
  const complete={assessment:'supported',missing_information:[],occurrence_candidates:[
    {event_key:'line infection',admission_id:'adm-a',event_status:'documented',source_ref:'memory:a-1'},
    {event_key:'line infection',admission_id:'adm-b',event_status:'documented',source_ref:'memory:b-1'},
  ],counting:{unit:'event',scope_complete:true}},first=buildMedLoCoMoEvidenceLedger({assessment:complete,memory_nodes:nodes}).task_structure;
  assert.equal(first.counting.observed_count,2);
  assert.equal(first.counting.total_count,2);
  const conflict={assessment:'supported',missing_information:[],occurrence_candidates:[
    {event_key:'line infection',admission_id:'adm-a',event_status:'documented',source_ref:'memory:a-1'},
    {event_key:'line infection',admission_id:'adm-a',event_status:'negated',source_ref:'memory:a-1'},
  ],counting:{unit:'event',scope_complete:true}},second=buildMedLoCoMoEvidenceLedger({assessment:conflict,memory_nodes:nodes}).task_structure;
  assert.equal(second.counting.observed_count,0);
  assert.equal(second.counting.scope_complete,false);
  assert.equal(second.counting.total_count,null);
  assert.ok(second.occurrence_candidates.every(candidate=>candidate.event_status==='uncertain'&&candidate.included===false&&candidate.exclusion_reason==='conflicting_event_status'));
  const contextualConflict={assessment:'supported',missing_information:[],occurrence_candidates:[
    {event_key:'line infection',admission_id:'adm-a',event_status:'documented',source_refs:['memory:a-1']},
    {event_key:'line infection',admission_id:'adm-a',event_status:'negated',source_refs:['memory:a-1','memory:a-1-semantic']},
  ],counting:{unit:'event',scope_complete:true}},third=buildMedLoCoMoEvidenceLedger({assessment:contextualConflict,memory_nodes:nodes}).task_structure;
  assert.equal(third.counting.observed_count,0);
  assert.ok(third.occurrence_candidates.every(candidate=>candidate.exclusion_reason==='conflicting_event_status'));
});

test('Task structure leaves counting inactive when the assessor did not request a valid unit',()=>{
  const structure=buildMedLoCoMoEvidenceLedger({assessment:{assessment:'supported',missing_information:[],counting:{unit:null,scope_complete:true}},memory_nodes:nodes}).task_structure;
  assert.equal(structure.counting.unit,null);
  assert.equal(structure.counting.scope_complete,false);
  assert.equal(structure.counting.observed_count,null);
  assert.equal(structure.counting.total_count,null);
  assert.equal(structure.counting.count_semantics,'not_requested');
});

test('Task structure site counting normalizes Unicode whitespace and rejects missing or mismatched sites',()=>{
  const assessment={assessment:'supported',missing_information:[],occurrence_candidates:[
    {event_key:'catheter issue',admission_id:'adm-a',site:' Right\u00a0Groin ',event_status:'documented',source_ref:'memory:a-1'},
    {event_key:'catheter issue',admission_id:'adm-b',site:'right   groin',event_status:'documented',source_ref:'memory:b-1'},
    {event_key:'catheter issue',admission_id:'wrong-admission',site:'left groin',event_status:'documented',source_ref:'memory:b-2'},
    {event_key:'catheter issue',admission_id:'adm-b',site:'',event_status:'documented',source_ref:'memory:b-2'},
  ],counting:{unit:'site',scope_complete:true}},structure=buildMedLoCoMoEvidenceLedger({assessment,memory_nodes:nodes}).task_structure;
  assert.equal(structure.counting.observed_count,1);
  assert.equal(structure.counting.scope_complete,false);
  assert.equal(structure.counting.total_count,null);
  assert.equal(structure.occurrence_candidates[0].site,'right groin');
  assert.equal(structure.occurrence_candidates[2].exclusion_reason,'admission_source_mismatch');
  assert.equal(structure.occurrence_candidates[3].exclusion_reason,'missing_site');
});

test('Task structure keeps distinct sites from one cited Turn and never accepts an uncited event time',()=>{
  const sameAdmission=[...nodes,node('a-2','adm-a','2','2110-01-03','doctor','A second documented fact.')],assessment={assessment:'supported',missing_information:[],occurrence_candidates:[
    {event_key:'catheter issue',admission_id:'adm-a',site:'left groin',event_status:'documented',source_refs:['memory:a-1','memory:a-2'],event_time:'2099-12-31'},
    {event_key:'catheter issue',admission_id:'adm-a',site:'right groin',event_status:'documented',source_refs:['memory:a-1','memory:a-2'],event_time:'2099-12-31'},
  ],counting:{unit:'site',scope_complete:true}},structure=buildMedLoCoMoEvidenceLedger({assessment,memory_nodes:sameAdmission}).task_structure;
  assert.equal(structure.counting.observed_count,2);
  assert.equal(structure.counting.total_count,2);
  assert.equal(structure.occurrence_candidates[0].event_time,null);
  assert.deepEqual(new Set(structure.occurrence_candidates.map(candidate=>candidate.site)),new Set(['left groin','right groin']));
});

function node(memory_id,episode_id,turn_id,event_time,source_type,text){return{memory_id,subject_id:'p',observation_id:`o-${episode_id}`,episode_id,turn_id,event_time,source_type,text,source_text:text,construction_kind:'literal_provenance'};}
