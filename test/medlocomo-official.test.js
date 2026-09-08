import test from'node:test';
import assert from'node:assert/strict';
import{createHash}from'node:crypto';
import{mkdtempSync,writeFileSync}from'node:fs';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{Store}from'../src/db.js';
import{ExperimentHarness}from'../src/experiments.js';
import{adapters}from'../src/adapters/index.js';
import{ModelGateway}from'../src/gateway.js';
import{medLoCoMoJudgeInput,medLoCoMoTokenF1,normalizeMedLoCoMoAnswer,scoreMedLoCoMoAbstention,validateMedLoCoMoJudgeOutput}from'../src/medlocomo-official.js';
import{normalizeMedLoCoMoSurfaceAnswer}from'../src/adapters/medlocomo.js';
import{MEDLOCOMO_APPENDIX_B2_JUDGE_SYSTEM_PROMPT,MEDLOCOMO_PROTOCOL_DERIVED_ANSWER_SYSTEM_PROMPT,MEDLOCOMO_QUESTION_TYPES,MEDMEMORY_INVESTIGATION_STRATEGIES,PROMPTS,benchmarkAnswerContract,medLoCoMoAnswerMessages,medLoCoMoFrequencyEvidenceGroups,medLoCoMoFrequencyRequest,medLoCoMoInvestigationStrategy,medLoCoMoJudgeMessages,promptFor,renderMedLoCoMoAnswerabilityClassifierPrompt}from'../src/prompts.js';
import{MEDLOCOMO_POLICY_DISTILLATION_ARTIFACT}from'../src/medlocomo-policy-artifact.js';
import{MEDLOCOMO_ANSWERABILITY_POLICY,MEDLOCOMO_POLICY_DISTILLATION,medLoCoMoAnswerFormPrior,medLoCoMoStudentPolicyFor,withMedLoCoMoStudentPolicy}from'../src/medlocomo-policy.js';
import{MEDLOCOMO_RUNTIME_QUERY_TYPES,fallbackMedLoCoMoQueryClassification,validateMedLoCoMoQueryClassification}from'../src/medlocomo-query-classifier.js';
import{MEDLOCOMO_ANSWERABILITY_REFUSAL_CONFIDENCE,classifyMedLoCoMoAnswerability,medLoCoMoAnswerabilityInput,validateMedLoCoMoAnswerabilityClassification}from'../src/medlocomo-answerability-classifier.js';
import{MEDLOCOMO_ACTION_POLICY_MODEL_VERSION,abstractMedLoCoMoActionPolicyState}from'../src/action-policy-learning.js';
import{MEDLOCOMO_EMBEDDING_SNAPSHOT_FILE_HASHES,MEDLOCOMO_EMBEDDING_SNAPSHOT_HASH}from'../src/embedding-retrieval.js';

test('MedLoCoMo token F1 follows official normalization and comma-aware matching',()=>{
  assert.equal(medLoCoMoTokenF1('The acute kidney injury.','acute kidney injury'),1);
  assert.equal(medLoCoMoTokenF1('rehab facility, home','home, rehab facility'),1);
  assert.equal(medLoCoMoTokenF1('acute injury','acute kidney injury'),.8);
  assert.equal(normalizeMedLoCoMoAnswer('The Answer, Here!'),'answer here');
});

test('MedLoCoMo adversarial matcher accepts normalized abstentions but rejects explanations',()=>{
  for(const answer of ['the question is not answerable','Cannot be determined.','not mentioned','not answerable from the record'])assert.equal(scoreMedLoCoMoAbstention(answer).score,1,answer);
  assert.equal(scoreMedLoCoMoAbstention('The question is not answerable because cultures were negative.').score,0);
  assert.equal(scoreMedLoCoMoAbstention('Insufficient grounded evidence in the visible history.').score,0);
});

test('MedLoCoMo surface repair canonicalizes refusal wording without converting clinical answers',()=>{
  assert.equal(normalizeMedLoCoMoSurfaceAnswer('The question is not answerable because the chart does not say.',{task:'adversarial'}),'the question is not answerable');
  assert.equal(normalizeMedLoCoMoSurfaceAnswer('The records do not document the requested finding.',{task:'adversarial'}),'the question is not answerable');
  assert.equal(normalizeMedLoCoMoSurfaceAnswer('There is insufficient evidence to determine this.',{task:'medical_reasoning'}),'the question is not answerable');
  assert.equal(normalizeMedLoCoMoSurfaceAnswer('CT scan showed no pulmonary embolism.',{task:'adversarial'}),'CT scan showed no pulmonary embolism.');
  assert.equal(normalizeMedLoCoMoSurfaceAnswer('stent is open and blood flowing normally',{task:'adversarial'}),'stent is open and blood flowing normally');
});

test('MedLoCoMo Answer uses a dedicated non-verbatim protocol-derived plain-text prompt',()=>{
  const input={task:'medical_reasoning',question:'What kidney issue developed?',memory_nodes:[{memory_id:'m2',event_time:'2024-02-01',text:'Later record.'},{memory_id:'m1',event_time:'2024-01-01',text:'The patient developed acute kidney injury.'}],memory_edges:[],gold:['must stay hidden'],expected_answer:'must stay hidden',judge_metadata:{reason:'must stay hidden'},answer_contract:{format:'must stay internal'}},messages=medLoCoMoAnswerMessages(input),rendered=promptFor('medlocomo_answer',input);
  assert.match(PROMPTS.medlocomo_answer.version,/^medlocomo-answer\.protocol-derived-v14-routed-answer-only-/);
  assert.match(PROMPTS.medlocomo_answer.description,/distilled from all 17,892 questions/);
  assert.deepEqual(messages.map(message=>message.role),['system','user']);
  assert.equal(messages[0].content,MEDLOCOMO_PROTOCOL_DERIVED_ANSWER_SYSTEM_PROMPT);
  assert.match(messages[0].content,/preferably 1 to 7 words and never more than 10/);
  assert.match(messages[0].content,/combining excerpts/);
  assert.match(messages[0].content,/do not require the answer or relation to appear verbatim/);
  assert.equal(messages[1].content,rendered);
  assert.match(rendered,/The patient developed acute kidney injury/);
  assert.doesNotMatch(rendered,/Answerability check|Task-specific answer guidance|Dataset-level answer-form prior/);
  assert.ok(rendered.indexOf('The patient developed acute kidney injury')<rendered.indexOf('Later record'));
  assert.ok(rendered.endsWith('Answer:'));
  assert.doesNotMatch(JSON.stringify(messages),/must stay hidden|answer_contract|gold|expected_answer|judge_metadata/);
  assert.doesNotMatch(JSON.stringify(messages),/the question is not answerable/);
  assert.match(messages[0].content,/Do not refuse/);
  assert.ok(PROMPTS.medlocomo_answerability_classifier);
  assert.equal(Object.hasOwn(PROMPTS,'medlocomo_answerability_guard'),false);
});

test('MedLoCoMo pre-answer classifier repairs compatible model surfaces and uses an answerability-aware fallback',async()=>{
  const source={question:'Which culture confirmed the source?',evidence_ledger:{source_grounded:true,rows:[{admission_id:'a1',turn_id:'4',event_time:'2024-01-02',speaker:'Doctor',evidence_text:'Blood cultures remained negative.'}]},task:'adversarial',gold:['must stay hidden'],judge_metadata:{trap:'must stay hidden'},semantic_evaluation:{assessment:'unsupported'}},input=medLoCoMoAnswerabilityInput(source),rendered=renderMedLoCoMoAnswerabilityClassifierPrompt(input);
  assert.deepEqual(Object.keys(input).sort(),['evidence','question']);
  assert.deepEqual(input.evidence,[{evidence_id:'E1',admission_id:'a1',turn_id:'4',event_time:'2024-01-02',speaker:'Doctor',text:'Blood cultures remained negative.'}]);
  assert.doesNotMatch(rendered,/answerable\/(?:direct|composed)|not_answerable\/(?:missing|contradicted)/);assert.match(rendered,/two separate fields/);assert.match(rendered,/confidence in the classification decision, not the amount of affirmative evidence/i);assert.match(rendered,/"confidence":0\.95/);assert.match(rendered,/question wording is not evidence/i);assert.match(rendered,/Explicit evidence for “no”/);assert.doesNotMatch(rendered,/must stay hidden|judge_metadata|semantic_evaluation|task.*adversarial/);
  assert.deepEqual(validateMedLoCoMoAnswerabilityClassification({classification:'answerable',support:'direct',decisive_evidence_ids:['E1'],confidence:.91,reason:'The record directly supplies the requested negative finding.'},input),{classification:'answerable',support:'direct',decisive_evidence_ids:['E1'],confidence:.91,reason:'The record directly supplies the requested negative finding.'});
  assert.deepEqual(validateMedLoCoMoAnswerabilityClassification({classification:'answerable/direct',support:'direct',decisive_evidence_ids:['E1'],confidence:.91,reason:'Supported.'},input),{classification:'answerable',support:'direct',decisive_evidence_ids:['E1'],confidence:.91,reason:'Supported.'});
  assert.deepEqual(validateMedLoCoMoAnswerabilityClassification({classification:'not_answerable/missing',support:'missing',decisive_evidence_ids:[],confidence:.95,reason:'Absent.'},input),{classification:'not_answerable',support:'missing',decisive_evidence_ids:[],confidence:.95,reason:'Absent.'});
  assert.throws(()=>validateMedLoCoMoAnswerabilityClassification({classification:'answerable/composed',support:'direct',decisive_evidence_ids:['E1'],confidence:.9,reason:'conflict'},input),/conflicts/);
  assert.throws(()=>validateMedLoCoMoAnswerabilityClassification({classification:'not_answerable',support:'direct',decisive_evidence_ids:['E1'],confidence:.9,reason:'inconsistent'},input),/not_answerable requires/);
  const longReason=validateMedLoCoMoAnswerabilityClassification({classification:'answerable/direct',support:'direct',decisive_evidence_ids:['E1'],confidence:.9,reason:'x'.repeat(500)},input);assert.equal(longReason.reason.length,320);
  const manyInput={question:'Q',evidence:Array.from({length:10},(_,index)=>({evidence_id:`E${index+1}`,text:`fact ${index+1}`}))},manyIds=manyInput.evidence.map(row=>row.evidence_id),bounded=validateMedLoCoMoAnswerabilityClassification({classification:'answerable/composed',support:'composed',decisive_evidence_ids:[...manyIds,'E1'],confidence:.9,reason:'Composed.'},manyInput);assert.deepEqual(bounded.decisive_evidence_ids,manyIds.slice(0,8));
  assert.throws(()=>validateMedLoCoMoAnswerabilityClassification({classification:'answerable/direct',support:'direct',decisive_evidence_ids:['outside'],confidence:.9,reason:'bad ID'},input),/outside the supplied evidence/);
  const liveDecision=output=>classifyMedLoCoMoAnswerability(input,{config:{provider:'live-test'},completeJSON:async(_component,modelInput,validator)=>({value:validator(output,modelInput),trace:{mock:false}})}),refusal=await liveDecision({classification:'not_answerable/missing',support:'missing',decisive_evidence_ids:[],confidence:.95,reason:'Absent.'}),uncertain=await liveDecision({classification:'not_answerable',support:'missing',decisive_evidence_ids:[],confidence:.4,reason:'Uncertain.'});assert.equal(refusal.route,'refuse');assert.equal(uncertain.route,'answer_with_answerability_check');
  const broken={config:{provider:'live-test'},completeJSON:async()=>{throw new Error('offline')}};
  const fallback=await classifyMedLoCoMoAnswerability(input,broken);assert.equal(fallback.route,'answer_with_answerability_check');assert.equal(fallback.classification,'undetermined');assert.equal(fallback.confidence,0);assert.match(fallback.method,/answerability_fallback/);assert.match(PROMPTS.medlocomo_answerability_fallback.messages(input)[0].content,/output exactly: the question is not answerable/);assert.equal(MEDLOCOMO_ANSWERABILITY_REFUSAL_CONFIDENCE,.8);
  assert.deepEqual(MEDLOCOMO_ANSWERABILITY_POLICY.training_scope,{patient_count:101,question_count:17892,answerable_case_count:11928,not_answerable_case_count:5964,not_held_out:true,runtime_retains_case_content:false});
  assert.equal(MEDLOCOMO_ANSWERABILITY_POLICY.decision_contract.exact_phrase_required,false);assert.ok(MEDLOCOMO_ANSWERABILITY_POLICY.forbidden_runtime_features.includes('question_surface_template_prior'));
});

test('MedLoCoMo Answer receives source rows without assessor-derived ledger claims',()=>{
  const rendered=promptFor('medlocomo_answer',{medlocomo_question_type:'frequency_pattern',question:'How many events occurred?',evidence_ledger:{version:'test',source_grounded:true,rows:[{admission_id:'a',turn_id:'1',event_time:'2024-01-01',speaker:'Doctor',evidence_text:'One documented event.',roles:['invented-role']}],role_annotations:[{claim:'invented-claim'}],task_structure:{counting:{total_count:99}}}});
  assert.match(rendered,/One documented event/);assert.doesNotMatch(rendered,/invented-role|invented-claim|total_count|99/);
});

test('MedLoCoMo Frequency Answer sees grouped source evidence but never unverified Policy count claims',()=>{
  const nodes=[{memory_id:'a1',episode_id:'admission-a',event_time:'2024-01-01',text:'Vancomycin was administered during dialysis.'},{memory_id:'a2',episode_id:'admission-a',event_time:'2024-01-02',text:'Vancomycin was continued.',source_text:'Vancomycin was continued.'},{memory_id:'b1',episode_id:'admission-b',event_time:'2024-02-01',text:'Vancomycin was administered during dialysis.'}],input={task:'medlocomo_short_answer',medlocomo_question_type:'frequency_pattern',question:'How many times was vancomycin administered during dialysis sessions?',memory_nodes:nodes,memory_edges:[],working_memory:{covered_aspects:['incorrect single event estimate']},semantic_evaluation:{answer_focus:[{aspect:'grounded event',memory_ids:['a1','b1']}]},investigation_policy:{termination_reason:'answer_selected'},investigation_trace:[{rationale:'exactly one distinct event'}]},rendered=promptFor('medlocomo_answer',input),source=JSON.parse(rendered.match(/Memory source:\n(.+)\n\nQuestion:/u)[1]);
  assert.deepEqual(source.frequency_request,medLoCoMoFrequencyRequest(input.question));
  assert.deepEqual(source.frequency_evidence_groups,medLoCoMoFrequencyEvidenceGroups(nodes,input.semantic_evaluation));
  assert.equal(source.frequency_evidence_groups.length,2);
  assert.equal(source.frequency_evidence_groups[0].evidence.length,2);
  assert.deepEqual(source.frequency_evidence_groups.map(item=>item.assessor_selected_evidence_ids),[['a1'],['b1']]);
  assert.equal(Object.hasOwn(source,'investigation_policy'),false);
  assert.equal(Object.hasOwn(source,'investigation_trace'),false);
  assert.equal(Object.hasOwn(source,'working_memory'),false);
  assert.doesNotMatch(rendered,/exactly one distinct event|incorrect single event estimate/);
});

test('MedLoCoMo Frequency surface rules change only unambiguous unit formatting',()=>{
  assert.equal(normalizeMedLoCoMoSurfaceAnswer('Five admissions.',{task:'frequency_pattern',question:'How many admissions involved infection?'}),'Five');
  assert.equal(normalizeMedLoCoMoSurfaceAnswer('three',{task:'frequency_pattern',question:'How many times was candidiasis diagnosed in different sites?'}),'three sites');
  assert.equal(normalizeMedLoCoMoSurfaceAnswer('at least ten times',{task:'frequency_pattern',question:'How many times was imaging performed?'}),'at least ten times');
  assert.equal(normalizeMedLoCoMoSurfaceAnswer('10',{task:'frequency_pattern',question:'How many times was reflux documented?'}),'10 times');
  assert.equal(normalizeMedLoCoMoSurfaceAnswer('twice',{task:'frequency_pattern',question:'How many times was reflux documented?'}),'twice');
  assert.equal(normalizeMedLoCoMoSurfaceAnswer('in four admissions',{task:'frequency_pattern',question:'How many times was sepsis documented?'}),'in four admissions');
  assert.equal(normalizeMedLoCoMoSurfaceAnswer('persistent mild elevation',{task:'frequency_pattern',question:'What is the frequency pattern of transaminitis?'}),'persistent mild elevation');
});

test('MedLoCoMo type profiles are aggregate-only, registered, and compact',()=>{
  assert.equal(MEDLOCOMO_POLICY_DISTILLATION_ARTIFACT.selection.patient_count,101);
  assert.equal(MEDLOCOMO_POLICY_DISTILLATION_ARTIFACT.selection.admission_count,2982);
  assert.equal(MEDLOCOMO_POLICY_DISTILLATION_ARTIFACT.selection.question_count,17892);
  assert.equal(MEDLOCOMO_POLICY_DISTILLATION_ARTIFACT.selection.holdout_patient_count,0);
  assert.equal(MEDLOCOMO_POLICY_DISTILLATION_ARTIFACT.selection.not_held_out,true);
  assert.equal(MEDLOCOMO_POLICY_DISTILLATION_ARTIFACT.training_disclosure.valid_for_held_out_claims,false);
  assert.deepEqual(MEDLOCOMO_POLICY_DISTILLATION_ARTIFACT.isolation.compatible_benchmarks,['medlocomo']);
  assert.equal(MEDLOCOMO_POLICY_DISTILLATION_ARTIFACT.isolation.medmemorybench_policy_imported,false);
  assert.deepEqual(MEDLOCOMO_POLICY_DISTILLATION_ARTIFACT.source_validation,{invalid_evidence_admission_references:0,invalid_evidence_turn_references:0});
  assert.equal(MEDLOCOMO_POLICY_DISTILLATION_ARTIFACT.selection.patient_identifiers_retained,false);
  const serialized=JSON.stringify({artifact:MEDLOCOMO_POLICY_DISTILLATION_ARTIFACT});
  assert.doesNotMatch(serialized,/11826927|"qa_id"|"gold_answer"|"candidate_answer"|Admission ID/);
  assert.equal(Object.isFrozen(MEDLOCOMO_POLICY_DISTILLATION),true);
  assert.equal(Object.isFrozen(MEDLOCOMO_POLICY_DISTILLATION.recommendations.medical_reasoning),true);
  assert.equal(MEDLOCOMO_POLICY_DISTILLATION.student_policy.training_scope.question_count,17892);
  assert.equal(MEDLOCOMO_POLICY_DISTILLATION.student_policy.training_scope.runtime_retains_case_content,false);
  const medMemoryTypes=new Set(Object.keys(MEDMEMORY_INVESTIGATION_STRATEGIES));
  for(const type of MEDLOCOMO_QUESTION_TYPES){const profile=medLoCoMoInvestigationStrategy(type),recommendation=MEDLOCOMO_POLICY_DISTILLATION_ARTIFACT.recommendations[type];assert.equal(medMemoryTypes.has(type),false);assert.equal(profile.query_type,type);assert.equal(profile.answer_memory_limit,recommendation.answer_memory_limit);assert.equal(profile.answer_focus_limit,recommendation.answer_focus_limit);assert.ok(profile.evidence_contract.length>=2);assert.ok(profile.stop_condition);assert.match(profile.policy_directive,/^First investigate whether the record supports every premise/);assert.doesNotMatch(profile.policy_directive,/For this answerable task|instead of using the adversarial refusal rule/);}
});

test('MedLoCoMo Student prior selects a case-free aggregate cell for Policy and Answer form',()=>{
  const prior=medLoCoMoStudentPolicyFor('care_plan_rationale',{scope:'single_admission',question:'Why was the medication withheld?'}),decorated=withMedLoCoMoStudentPolicy({question:'Why was the medication withheld?'},'care_plan_rationale',{scope:'single_admission',question:'Why was the medication withheld?'}),answerPrior=medLoCoMoAnswerFormPrior('care_plan_rationale',{scope:'single_admission',question:'Why was the medication withheld?'}),serialized=JSON.stringify({prior,answerPrior});
  assert.equal(prior.query_shape,'causal');assert.equal(prior.matched_cell.cell_key,'single_admission:causal');assert.ok(prior.matched_cell.case_count>0);assert.equal(decorated.medlocomo_student_prior.student_artifact_hash,MEDLOCOMO_POLICY_DISTILLATION.artifact_hash);assert.ok(answerPrior.typical_word_count>0);assert.doesNotMatch(serialized,/patient_id|qa_id|gold_answer|candidate_answer|turn_ids|source_turns|Why was the medication withheld/iu);
});

test('MedLoCoMo Answer sends system/user messages as plain text without JSON response_format',async()=>{
  const priorFetch=globalThis.fetch;let request;
  globalThis.fetch=async(_url,options)=>{request=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:'acute kidney injury'},finish_reason:'stop'}]}),{status:200});};
  try{const gateway=new ModelGateway({provider:'openai-compatible',base_url:'https://answer.test/v1',model:'current-answer'},{apiKey:'session-key'}),input={task:'medical_reasoning',question:'What kidney issue developed?',memory_nodes:[{memory_id:'m1',text:'acute kidney injury'}],memory_edges:[]},result=await gateway.completeText('medlocomo_answer',input,()=>{throw new Error('unexpected mock')},{maxTokens:64});assert.equal(result.value,'acute kidney injury');assert.deepEqual(request.messages,medLoCoMoAnswerMessages(input));assert.equal(Object.hasOwn(request,'response_format'),false);assert.equal(request.max_tokens,64);}
  finally{globalThis.fetch=priorFetch;}
});

test('MedLoCoMo Judge input and prompt reproduce the answerable-only binary contract',()=>{
  const item={score_id:'q-1',question:'What kidney issue developed?',gold:['acute kidney injury']},input=medLoCoMoJudgeInput('AKI',item),valid=validateMedLoCoMoJudgeOutput({judgments:[{qa_id:'q-1',score:1}]},item),prompt=promptFor('medlocomo_judge',input);
  assert.deepEqual(input,{items:[{qa_id:'q-1',question:'What kidney issue developed?',gold_answer:'acute kidney injury',candidate_answer:'AKI'}]});
  assert.deepEqual(valid,{judgments:[{qa_id:'q-1',score:1}]});
  assert.match(prompt,/Judge only from the provided question, gold_answer, and candidate_answer/);
  assert.match(prompt,/Return exactly one judgment per provided qa_id/);
  assert.throws(()=>validateMedLoCoMoJudgeOutput({judgments:[{qa_id:'wrong',score:1}]},item),/qa_id/);
  assert.throws(()=>validateMedLoCoMoJudgeOutput({judgments:[{qa_id:'q-1',score:.5}]},item),/0 or 1/);
});

test('MedLoCoMo Judge preserves the Appendix B.2 first-turn system and user messages verbatim',async()=>{
  const priorFetch=globalThis.fetch;let request;
  globalThis.fetch=async(_url,options)=>{request=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:'{"judgments":[{"qa_id":"q-roles","score":1}]}'},finish_reason:'stop'}]}),{status:200});};
  try{const gateway=new ModelGateway({provider:'openai-compatible',base_url:'https://judge.test/v1',model:'current-judge'},{apiKey:'session-key'}),item={score_id:'q-roles'},input={items:[{qa_id:'q-roles',question:'Q',gold_answer:'A',candidate_answer:'A'}]},expectedSystem=`You are grading candidate answers for short-answer medical benchmark questions.
Judge only from the provided question, gold_answer, and candidate_answer.
Score 1 when the candidate answer is correct.
Score 0 when the candidate answer is false, incorrect, unsupported, incomplete enough to be wrong, or only says it is not answerable.
Return strict JSON with the schema {"judgments": [{"qa_id": "...", "score": 1}]}.
Each score must be exactly one of: 0, 1.
Return exactly one judgment per provided qa_id.`;assert.equal(MEDLOCOMO_APPENDIX_B2_JUDGE_SYSTEM_PROMPT,expectedSystem);assert.deepEqual(medLoCoMoJudgeMessages(input),[{role:'system',content:expectedSystem},{role:'user',content:JSON.stringify(input)}]);await gateway.completeJSON('medlocomo_judge',input,value=>validateMedLoCoMoJudgeOutput(value,item),()=>{throw new Error('unexpected mock')});assert.deepEqual(request.messages,medLoCoMoJudgeMessages(input));}
  finally{globalThis.fetch=priorFetch;}
});

test('MedLoCoMo answer contracts make abstention evidence-based rather than label-forced',()=>{
  for(const task of ['medical_reasoning','care_plan_rationale','longitudinal_progression','cross_admission_comparison','frequency_pattern']){const format=benchmarkAnswerContract('medlocomo',task).format;assert.match(format,/source-supported/);assert.match(format,/otherwise return exactly: the question is not answerable/);}
  const format=benchmarkAnswerContract('medlocomo','adversarial').format;assert.match(format,/when the supplied record supports it/);assert.match(format,/Otherwise return exactly/);
});

test('MedLoCoMo runtime classification cannot consume or predict the evaluator adversarial label',()=>{
  assert.equal(MEDLOCOMO_RUNTIME_QUERY_TYPES.includes('adversarial'),false);
  assert.equal(validateMedLoCoMoQueryClassification({query_type:'frequency_pattern',confidence:.9,rationale:'count request'}).query_type,'frequency_pattern');
  assert.throws(()=>validateMedLoCoMoQueryClassification({query_type:'adversarial',confidence:.9,rationale:'hidden evaluator class'}),/Unknown MedLoCoMo runtime query type/);
  assert.equal(fallbackMedLoCoMoQueryClassification('Did the condition worsen across admissions?').query_type,'longitudinal_progression');
});

test('MedLoCoMo records official metrics and can rescore a frozen complete Memory Graph',async()=>{
  const store=new Store(':memory:'),calls=[],pipeline=new StaticGateway('mock','pipeline',calls),policy=new StaticGateway('mock','policy',calls),answer=new StaticGateway('live-test','answer',calls),medJudge=new StaticGateway('live-test','medlocomo-judge',calls),medMemoryJudge=new StaticGateway('mock','medmemory-judge',calls),registry={pipelineOptions:()=>({gateway:pipeline}),assignmentSnapshot:()=>({global:pipeline.config,investigation_policy:policy.config,judge:answer.config,scoring_judge:medMemoryJudge.config,medlocomo_judge:medJudge.config}),gateway:component=>component==='judge'?answer:component==='medlocomo_judge'?medJudge:component==='scoring_judge'?medMemoryJudge:policy},harness=new ExperimentHarness(store,undefined,registry),official=adapters().medlocomo,observations=[{subject_id:'medlocomo-metric-test',source_type:'patient',episode_id:'admission-1',turn_id:'1',event_time:'2024-01-01',raw_text:'The patient developed acute kidney injury.'}],items=[{score_id:'answerable-1',task:'medical_reasoning',question:'What kidney issue developed?',gold:['acute kidney injury'],metadata:{answer_contract:benchmarkAnswerContract('medlocomo','medical_reasoning'),scope:'single_admission',official_evaluation:{benchmark:'medlocomo',metric:'answerable_token_f1+answerable_llm_judge'}}},{score_id:'adversarial-1',task:'adversarial',question:'Which culture confirmed the source?',gold:['the question is not answerable'],metadata:{answer_contract:benchmarkAnswerContract('medlocomo','adversarial'),scope:'single_admission',official_evaluation:{benchmark:'medlocomo',metric:'adversarial_abstention_accuracy'}}}];
  harness.adapters.medlocomo={load:()=>({observations}),cases:(_data,config)=>{assert.equal(config.mode,'single_admission');return items;},normalizeAnswer:value=>official.normalizeAnswer(value),requiresOfficialJudge:item=>official.requiresOfficialJudge(item),compatibleScore:(...args)=>official.compatibleScore(...args),officialJudgeInput:(...args)=>official.officialJudgeInput(...args),validateOfficialJudge:(...args)=>official.validateOfficialJudge(...args),scoreOfficialJudge:(...args)=>official.scoreOfficialJudge(...args),scoreOfficialJudgeUnavailable:(...args)=>official.scoreOfficialJudgeUnavailable(...args)};
  const policyDirectory=mkdtempSync(join(tmpdir(),'careharness-medlocomo-runtime-')),actionPolicyPath=join(policyDirectory,'policy.json'),rejectedPath=join(policyDirectory,'rejected.json'),acceptedPolicy=testMedLoCoMoActionPolicy(),rejectedBody={...acceptedPolicy,training_scope:{...acceptedPolicy.training_scope,deployment_eligible:false},validation:{...acceptedPolicy.validation,accepted:false,learned_minus_baseline:{exact_turn_recall:.01,all_evidence_rate:-.02,mean_action_cost:.01}}};delete rejectedBody.model_hash;const rejectedPolicy={...rejectedBody,model_hash:createHash('sha256').update(stablePolicyJson(rejectedBody)).digest('hex')};writeFileSync(rejectedPath,JSON.stringify(rejectedPolicy));writeFileSync(actionPolicyPath,JSON.stringify(acceptedPolicy));
  await assert.rejects(()=>harness.start('medlocomo',{mode:'single_admission',medlocomo_pairwise_ranking:false,medlocomo_action_policy_path:rejectedPath}),/diagnostic-only.*greedy_worker/);
  const advisoryCandidate=await harness.start('medlocomo',{mode:'single_admission',medlocomo_pairwise_ranking:false,medlocomo_action_policy_path:rejectedPath,medlocomo_action_policy_execution:'advisory'});assert.equal(advisoryCandidate.status,'completed',JSON.stringify(advisoryCandidate.results.filter(item=>item.status==='failed')));
  const done=await harness.start('medlocomo',{mode:'single_admission',medlocomo_pairwise_ranking:false,medlocomo_action_policy_path:actionPolicyPath}),answerable=done.results.find(item=>item.score_id==='answerable-1'),adversarial=done.results.find(item=>item.score_id==='adversarial-1'),metrics=done.progress.retrieval_metrics.medlocomo_official.overall;
  assert.equal(done.status,'completed');
  assert.equal(done.config.medlocomo_policy_mode,'distilled_typed');
  assert.equal(done.config.medlocomo_policy_distillation.not_held_out,true);
  assert.equal(done.config.medlocomo_answerability_policy.training_scope.question_count,17892);
  assert.equal(done.config.resolved_models.medlocomo_answerability_classifier.model,'answer');
  assert.equal(answerable.scoring_method,'medlocomo_official_answerable_llm_judge');
  assert.equal(answerable.scoring_details.answerable_token_f1,1);
  assert.equal(answerable.scoring_details.answerable_judge_score,1);
  assert.equal(answerable.judge_model_trace.model,'medlocomo-judge');
  assert.equal(adversarial.scoring_method,'medlocomo_official_adversarial_abstention_matcher');
  assert.equal(adversarial.judge_model_trace,null);
  assert.equal(answerable.answerability_classification.route,'answer');
  assert.equal(answerable.answerability_classification.classification,'answerable');
  assert.equal(adversarial.answerability_classification.route,'refuse');
  assert.equal(adversarial.answerability_classification.classification,'not_answerable');
  assert.equal(adversarial.system_output,'the question is not answerable');
  assert.equal(adversarial.answer_model_trace,null);
  assert.equal(done.progress.retrieval_metrics.answerability_routing_accuracy,1);
  assert.equal(done.progress.retrieval_metrics.answerability_false_refusal_count,0);
  assert.equal(done.progress.retrieval_metrics.answerability_false_answer_count,0);
  assert.deepEqual({f1:metrics.answerable_token_f1,judge:metrics.answerable_judge_accuracy,abstention:metrics.adversarial_abstention_accuracy,combined:metrics.combined_score},{f1:1,judge:1,abstention:1,combined:1});
  assert.ok(calls.some(call=>call.component==='medlocomo_answer'));
  assert.equal(calls.some(call=>call.component==='judge'),false);
  assert.ok(calls.some(call=>call.component==='medlocomo_judge'));
  assert.equal(done.config.resolved_models.medlocomo_judge.model,'medlocomo-judge');
  assert.equal(answerable.retrieval_trace.policy_mode,'distilled_typed');
  assert.equal(answerable.retrieval_context.question_request.query_type,'care_plan_rationale');
  assert.equal(answerable.retrieval_context.question_request.strategy_namespace,'medlocomo');
  assert.equal(answerable.retrieval_context.question_request.scope,'single_admission');
  assert.equal(answerable.retrieval_context.question_request.information_boundary.public_benchmark_scope_available,true);
  assert.equal(answerable.retrieval_context.question_request.strategy_profile.strategy_id,'medlocomo_plan_rationale');
  assert.equal(answerable.query_classification.predicted_query_type,'medical_reasoning');
  assert.equal(answerable.query_classification.retrieval_query_type,'care_plan_rationale');
  assert.equal(answerable.query_classification.routing_mode,'question_only_classified_distilled_policy');
  assert.equal(answerable.answer_model_trace.model_input.task,'medlocomo_short_answer');
  assert.equal(answerable.answer_model_trace.model_input.medlocomo_question_type,'care_plan_rationale');
  assert.equal(adversarial.retrieval_context.question_request.query_type,'care_plan_rationale');
  assert.equal(adversarial.answerability_classifier_trace.model_input.question,adversarial.question);
  assert.deepEqual(Object.keys(adversarial.answerability_classifier_trace.model_input).sort(),['evidence','question']);
  assert.equal(Object.hasOwn(adversarial.answerability_classifier_trace.model_input,'task'),false);
  assert.equal(calls.some(call=>call.component==='medmemory_query_classifier'),false);
  assert.ok(calls.some(call=>call.component==='medlocomo_query_classifier'));
  assert.ok(calls.filter(call=>call.component==='medlocomo_query_classifier').every(call=>Object.keys(call.input).length===1&&typeof call.input.question==='string'));
  assert.equal(calls.some(call=>call.component==='investigation_policy'),false);
  assert.ok(calls.some(call=>call.component==='medlocomo_investigation_policy'));
  assert.ok(calls.filter(call=>call.component==='medlocomo_investigation_policy').every(call=>call.input.strategy_namespace==='medlocomo'&&!call.input.offline_student_prior&&call.input.medlocomo_student_prior?.query_type));
  assert.equal(answerable.retrieval_trace.medlocomo_student_policy.used,true);
  assert.equal(done.config.medlocomo_action_policy_values.version,MEDLOCOMO_ACTION_POLICY_MODEL_VERSION);
  assert.equal(done.config.medlocomo_action_policy_execution,'greedy_worker');
  assert.ok(calls.some(call=>call.component==='medlocomo_investigation_policy'&&call.input.learned_action_prior?.model_hash===done.config.medlocomo_action_policy_values.model_hash&&call.input.allowed_workers.length===1&&call.input.allowed_workers[0]===call.input.learned_action_prior.ranked_actions[0].worker));
  assert.equal(answerable.answer_model_trace.model_input.medlocomo_answer_form_prior.query_type,'care_plan_rationale');
  const rebuilt=await harness.start('medlocomo',{mode:'single_admission',medlocomo_pairwise_ranking:false});assert.equal(rebuilt.status,'completed');assert.equal(rebuilt.config.medlocomo_action_policy_values,undefined);assert.equal(rebuilt.config.medlocomo_action_policy_execution,undefined);
  const before={nodes:store.memoryNodesFor('medlocomo-metric-test'),edges:store.memoryEdgesFor('medlocomo-metric-test'),runs:store.db.prepare(`SELECT COUNT(*) AS n FROM runs`).get().n},rescored=await harness.start('medlocomo',{mode:'single_admission',score_only_current_memory:true,medlocomo_pairwise_ranking:false}),after={nodes:store.memoryNodesFor('medlocomo-metric-test'),edges:store.memoryEdgesFor('medlocomo-metric-test'),runs:store.db.prepare(`SELECT COUNT(*) AS n FROM runs`).get().n};
  assert.equal(rescored.status,'completed');assert.equal(rescored.config.score_only_current_memory,true);assert.equal(rescored.progress.total,0);assert.equal(rescored.results.filter(item=>item.run_id).length,0);assert.equal(rescored.progress.memory_build_completeness.status,'not_run_current_memory');assert.equal(rescored.config.current_memory_snapshot.source_admission_count,1);assert.ok(rescored.results.filter(item=>item.kind==='score').every(item=>item.memory_completeness.policy==='answer_and_score_frozen_current_memory'));assert.deepEqual(after,before);
  const classifierCallsBefore=calls.filter(call=>call.component==='medlocomo_query_classifier').length,provided=await harness.start('medlocomo',{mode:'single_admission',score_only_current_memory:true,medlocomo_pairwise_ranking:false,medlocomo_policy_mode:'provided_typed'}),providedAnswerable=provided.results.find(item=>item.score_id==='answerable-1'),providedAdversarial=provided.results.find(item=>item.score_id==='adversarial-1');
  assert.equal(provided.status,'completed');assert.equal(provided.config.medlocomo_policy_mode,'provided_typed');assert.equal(calls.filter(call=>call.component==='medlocomo_query_classifier').length,classifierCallsBefore);assert.equal(providedAnswerable.query_classification,null);assert.equal(providedAdversarial.query_classification,null);assert.equal(providedAnswerable.task,'medical_reasoning');assert.equal(providedAnswerable.retrieval_context.question_request.query_type,'care_plan_rationale');assert.equal(providedAnswerable.answer_model_trace.model_input.medlocomo_question_type,'care_plan_rationale');assert.equal(provided.config.medlocomo_runtime_policy_aliases.medical_reasoning,'care_plan_rationale');assert.equal(providedAdversarial.retrieval_context.question_request.query_type,'adversarial');assert.equal(providedAdversarial.retrieval_trace.policy_mode,'provided_typed');
  await assert.rejects(()=>harness.start('medlocomo',{mode:'single_admission',score_only_current_memory:true,medlocomo_pairwise_ranking:false,medlocomo_policy_mode:'medmemory_classified'}),/Unknown MedLoCoMo policy mode/);
  await assert.rejects(()=>harness.start('medlocomo',{mode:'single_admission',score_only_current_memory:true,medlocomo_pairwise_ranking:false,action_policy_values:{}}),/cannot use action_policy_values/);
  assert.deepEqual({nodes:store.memoryNodesFor('medlocomo-metric-test'),edges:store.memoryEdgesFor('medlocomo-metric-test'),runs:store.db.prepare(`SELECT COUNT(*) AS n FROM runs`).get().n},before);
  store.db.prepare(`DELETE FROM memory_edges WHERE subject_id=?`).run('medlocomo-metric-test');store.db.prepare(`DELETE FROM memory_nodes WHERE subject_id=?`).run('medlocomo-metric-test');
  await assert.rejects(()=>harness.start('medlocomo',{mode:'single_admission',score_only_current_memory:true,medlocomo_pairwise_ranking:false}),/完整全 Admission/);
  store.close();
});

function testMedLoCoMoActionPolicy(){const trainCommitment='a'.repeat(64),validationCommitment='166669200359c91649418b44453686a9a0a867e2e622001e4cc8666b81393912',instructionHash='b'.repeat(64),state=abstractMedLoCoMoActionPolicyState({query_type:'medical_reasoning',current_information:{memory_nodes:[]},previous_steps:[],remaining_budget:7}),key=policyStateKey(state),backoff=policyStateKey({query_type:state.query_type,node_count:state.node_count,episode_count:state.episode_count,assessment:state.assessment,verification:state.verification,last_worker:state.last_worker,last_changed:state.last_changed,remaining_budget:state.remaining_budget}),rows=[{worker:'search',count:10,effective_weight:10,mean:.8},{worker:'answer',count:10,effective_weight:10,mean:.2}],body={version:MEDLOCOMO_ACTION_POLICY_MODEL_VERSION,training_scope:{benchmark:'medlocomo',runtime_eligible:true,deployment_eligible:true,counterfactual_worker_rollout:true,patient_count:97,rollout_case_count:100,train_set_commitment:trainCommitment,validation_set_commitment:validationCommitment,runtime_uses_question_text:false,runtime_uses_gold_or_judge_content:false,runtime_retains_case_content:false},state_features:Object.keys(state),prior_strength:4,contexts:{[key]:rows},backoff_contexts:{[backoff]:rows},global_actions:rows,validation:{patient_disjoint:true,patient_count:4,case_count:516,exact_turn_case_count:258,applies_to_serialized_model:true,accepted:true,runtime_environment_parity:true,validation_graph_source:'frozen_production_sqlite',validation_graph_memory_compatible:true,production_pairwise_ranker_used:true,production_embedding_selector_used:true,production_instruction_policy_used:true,production_instruction_policy_artifact_hash:instructionHash,instruction_policy_train_patient_count:97,instruction_policy_validation_patient_count:4,instruction_policy_train_set_commitment:trainCommitment,instruction_policy_validation_set_commitment:validationCommitment,instruction_policy_final_refit:false,embedding_runtime_contract_matched:true,pairwise_valid_for_held_out_claims:true,pairwise_validation_patients_included:false,pairwise_train_patient_count:97,pairwise_validation_patient_count:4,pairwise_train_set_commitment:trainCommitment,pairwise_validation_set_commitment:validationCommitment,runtime_stack_execution:testValidationRuntimeExecution(instructionHash),one_step_best_action_accuracy:.7,one_step_mean_action_regret:.1,learned_minus_baseline:{exact_turn_recall:.01,all_evidence_rate:0,mean_action_cost:-.01}}};return{...body,model_hash:createHash('sha256').update(stablePolicyJson(body)).digest('hex')};}
function testValidationRuntimeExecution(instructionHash='b'.repeat(64)){return{embedding_expected_dimensions:384,embedding_observed_dimensions:[384],embedding_observed_providers:['local'],embedding_observed_models:['Xenova/all-MiniLM-L6-v2'],embedding_observed_model_revisions:['751bff37182d3f1213fa05d7196b954e230abad9'],embedding_observed_model_revision_verifications:['local_snapshot_sha256'],embedding_observed_base_models:['sentence-transformers/all-MiniLM-L6-v2'],embedding_observed_base_model_revisions:['1110a243fdf4706b3f48f1d95db1a4f5529b4d41'],embedding_observed_snapshot_hashes:[MEDLOCOMO_EMBEDDING_SNAPSHOT_HASH],embedding_observed_snapshot_file_hash_commitments:[createHash('sha256').update(stablePolicyJson(MEDLOCOMO_EMBEDDING_SNAPSHOT_FILE_HASHES)).digest('hex')],embedding_observed_normalized:[true],embedding_observed_chunk_turn_counts:[6],embedding_attempted:3,embedding_completed:3,embedding_failed:0,pairwise_attempted:3,pairwise_applied:3,pairwise_failed:0,instruction_prior_attempted:3,instruction_prior_completed:3,instruction_prior_failed:0,instruction_prior_observed_artifact_hashes:[instructionHash]};}
function policyStateKey(value){return Object.keys(value).sort().map(key=>`${key}=${String(value[key])}`).join('|');}
function stablePolicyJson(value){if(Array.isArray(value))return`[${value.map(stablePolicyJson).join(',')}]`;if(value&&typeof value==='object')return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stablePolicyJson(value[key])}`).join(',')}}`;return JSON.stringify(value);}

class StaticGateway{
  constructor(provider,model,calls){this.config={provider,model};this.calls=calls;}
  publicConfig(){return this.config;}
  async completeText(component,input,mockFactory,options={}){this.calls.push({component,input,model:this.config.model,options});const value=String(this.config.provider==='mock'?await mockFactory(input):/culture/i.test(input.question)?'the question is not answerable':'acute kidney injury').trim();return{value,trace:{component,provider:this.config.provider,model:this.config.model,token_input:1,token_output:1,latency_ms:0,model_input:input,parsed_response:value,schema_enforcement:'plain_text',error:null,mock:this.config.provider==='mock'}};}
  async completeJSON(component,input,validator,mockFactory){this.calls.push({component,input,model:this.config.model});let raw;if(this.config.provider==='mock')raw=await mockFactory(input);else if(component==='judge')raw={answer:input.task==='adversarial'?'the question is not answerable':'acute kidney injury'};else if(component==='medlocomo_judge')raw={judgments:[{qa_id:input.items[0].qa_id,score:1}]};else if(component==='medlocomo_answerability_classifier')raw=/culture/i.test(input.question)?{classification:'not_answerable',support:'missing',decisive_evidence_ids:[],confidence:.98,reason:'No culture result fills the requested entity slot.'}:{classification:'answerable',support:'direct',decisive_evidence_ids:['E1'],confidence:.98,reason:'The requested condition is directly present in the evidence.'};else raw=await mockFactory(input);const value=validator?validator(raw):raw;return{value,trace:{component,provider:this.config.provider,model:this.config.model,token_input:1,token_output:1,latency_ms:0,model_input:input,parsed_response:value,error:null,mock:this.config.provider==='mock'}};}
}
