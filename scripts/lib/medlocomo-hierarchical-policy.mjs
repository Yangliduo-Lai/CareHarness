import { createHash } from 'node:crypto';

export const MEDLOCOMO_HIERARCHICAL_POLICY_VERSION='medlocomo-hierarchical-policy.v1-offline';
export const MEDLOCOMO_DEFAULT_HOLDOUT_PATIENTS=Object.freeze(['10913302','11021643','11441519','11826927']);

const CANONICAL_ABSTENTION='the question is not answerable';
const STOP=new Set([
  'a','an','the','and','or','of','for','to','in','on','at','by','as','was','were','is','are','be','been','being','with','from','during','which','what','when','where','why','how','did','does','do','had','has','have','his','her','their','this','that','these','those','into','after','before','over','time','patient','hospitalization','hospitalizations','admission','admissions','across','multiple','because','due','while','most','primary','main','following','according','record','records',
]);
const DEFAULTS=Object.freeze({
  minimum_query_patient_support:2,
  minimum_pair_patient_support:2,
  minimum_pair_case_support:3,
  maximum_expansions_per_query_term:16,
  maximum_query_terms_per_case:8,
  maximum_positive_terms_per_case:24,
  negative_weight:0.75,
  turn_limit:24,
});

/**
 * Offline, patient-disjoint MedLoCoMo distillation.
 *
 * The trainer may read Gold and official Evidence as labels. Its compiled model
 * retains only aggregate cells and cross-patient token association weights. It
 * deliberately does not retain a Patient/QA lookup and is not runtime eligible
 * until graph-reachability and Action rollout training have been completed.
 */
export class MedLoCoMoHierarchicalTrainer{
  #config;#admissionAssociations;#turnAssociations;#queryVocabulary=new Map();#eligibleQueryTerms=null;#cells=new Map();#transitions=new Map();#trainPatients=0;#trainCases=0;#trainAdmissions=0;#trainTurns=0;

  constructor(config={}){
    this.#config={...DEFAULTS,...config};
    this.#admissionAssociations=new AssociationTrainer(this.#config);
    this.#turnAssociations=new AssociationTrainer(this.#config);
  }

  observeVocabularyPatient(artifact){
    validateTeacherShape(artifact);const patientTag=sha256(String(artifact.patient_id));
    for(const item of array(artifact.cases))for(const term of contentUnigrams(item.task?.question))incrementStat(this.#queryVocabulary,term,patientTag,1);
    return this;
  }

  sealVocabulary(){
    this.#eligibleQueryTerms=new Set([...this.#queryVocabulary.entries()].filter(([,stats])=>stats.patient_count>=this.#config.minimum_query_patient_support).map(([term])=>term));
    if(!this.#eligibleQueryTerms.size)throw new Error('No cross-patient query vocabulary survived the configured support threshold');
    return this;
  }

  observeTrainingPatient(artifact){
    validateTeacherShape(artifact);
    if(!this.#eligibleQueryTerms)this.observeVocabularyPatient(artifact);
    const patientTag=sha256(String(artifact.patient_id)),sourceByRef=new Map(array(artifact.source_turns).map(turn=>[String(turn.source_ref),turn]));
    this.#trainPatients++;this.#trainAdmissions+=array(artifact.admissions).length;this.#trainTurns+=array(artifact.source_turns).length;
    for(const item of array(artifact.cases)){
      const question=String(item.task?.question||''),questionType=String(item.task?.question_type||''),scope=String(item.task?.scope||''),operation=queryOperation(questionType,question),topology=evidenceTopology(questionType,operation),selectedRefs=array(item.supervision?.source_turn_selection).map(row=>String(row.source_ref||'')).filter(sourceByRef.has.bind(sourceByRef)),officialRefs=array(item.supervision?.official_evidence?.turn_refs).map(String).filter(sourceByRef.has.bind(sourceByRef)),negativeRefs=array(item.retrieval_teacher?.hard_negatives).map(row=>String(row.source_ref||'')).filter(sourceByRef.has.bind(sourceByRef)),officialAdmissionIds=new Set(array(item.supervision?.official_evidence?.admission_ids).map(String)),admissionNegativeRefs=negativeRefs.filter(ref=>!officialAdmissionIds.has(String(sourceByRef.get(ref)?.admission_id||'')));
      const selectedTexts=selectedRefs.map(ref=>String(sourceByRef.get(ref)?.text||'')),officialTexts=officialRefs.map(ref=>String(sourceByRef.get(ref)?.text||'')),negativeTexts=negativeRefs.map(ref=>String(sourceByRef.get(ref)?.text||'')),admissionNegativeTexts=admissionNegativeRefs.map(ref=>String(sourceByRef.get(ref)?.text||''));
      const queryTerms=this.#queryTerms(question),preferred=supervisionTerms(item,selectedTexts);
      this.#admissionAssociations.observe({patientTag,queryTerms,question,positiveTexts:selectedTexts,negativeTexts:admissionNegativeTexts,preferredTerms:preferred,positiveWeight:officialRefs.length?0.8:0.45});
      if(officialTexts.length)this.#turnAssociations.observe({patientTag,queryTerms,question,positiveTexts:officialTexts,negativeTexts,preferredTerms:supervisionTerms(item,officialTexts),positiveWeight:1});
      observeCell(this.#cells,{questionType,scope,operation,topology,item});
      observeDynamicTransitions(this.#transitions,{patientTag,scope,operation,topology,item});
      this.#trainCases++;
    }
    return this;
  }

  #queryTerms(question){
    const eligible=this.#eligibleQueryTerms||new Set(contentUnigrams(question));
    return contentUnigrams(question).filter(term=>eligible.has(term)).sort((left,right)=>Number(this.#queryVocabulary.get(left)?.case_count||0)-Number(this.#queryVocabulary.get(right)?.case_count||0)||right.length-left.length||left.localeCompare(right)).slice(0,this.#config.maximum_query_terms_per_case);
  }

  finalize({split={}}={}){
    if(!this.#trainPatients||!this.#trainCases)throw new Error('Cannot finalize an empty MedLoCoMo hierarchical trainer');
    const admissionRouter=this.#admissionAssociations.finalize(),turnRanker=this.#turnAssociations.finalize(),cells=Object.fromEntries([...this.#cells.entries()].sort(([left],[right])=>left.localeCompare(right)).map(([key,value])=>[key,finalizeCell(value)]));
    const core={
      version:MEDLOCOMO_HIERARCHICAL_POLICY_VERSION,
      benchmark:'medlocomo',
      runtime_eligible:false,
      status:'offline_candidate_requires_graph_rollout_validation',
      split:{method:'patient_disjoint',evaluation_role:'reused_validation_not_final_test',train_patient_count:this.#trainPatients,train_case_count:this.#trainCases,train_admission_count:this.#trainAdmissions,train_source_turn_count:this.#trainTurns,holdout_patient_count:Number(split.holdout_patient_count||0),train_set_commitment:String(split.train_set_commitment||''),holdout_set_commitment:String(split.holdout_set_commitment||'')},
      boundary:{retains_patient_ids:false,retains_qa_ids:false,retains_full_question_text:false,retains_full_gold_text:false,retains_full_or_per_case_evidence_text:false,retains_aggregate_cross_patient_evidence_tokens:true,retains_source_refs:false,retains_case_lookup:false,minimum_cross_patient_support:this.#config.minimum_pair_patient_support},
      supervision:{teacher_read_question:true,teacher_read_question_type:true,teacher_read_scope:true,teacher_read_gold_answer:true,teacher_read_official_evidence:true,teacher_read_judge_semantic_contract:true,teacher_read_traps:true,fixed_teacher_action_paths_used_as_dynamic_labels:false,official_exact_turn_labels_for_turn_ranker:true,teacher_selected_turns_for_admission_router:true},
      label_space:{
        query_operations:['direct_fact','causal_explanation','plan_rationale','treatment_change_reason','ordered_progression','endpoint_outcome','aligned_comparison','count_occurrences','frequency_extremum','answerability_check'],
        evidence_topologies:['point','local_pair','ordered_chain','parallel_sides','occurrence_ledger','answerability_probe'],
        action_roles:['locate_scope','retrieve_target','retrieve_counterpart','expand_local_context','complete_admission_coverage','order_evidence','deduplicate_occurrences','verify_relation','verify_answerability','answer'],
      },
      admission_router:admissionRouter,
      turn_ranker:turnRanker,
      policy_cells:cells,
      dynamic_action_prior:finalizeDynamicTransitions(this.#transitions),
      next_training_stage:{required:true,method:'real_graph_counterfactual_rollout',state:['query_operation','evidence_topology','covered_evidence_roles','covered_admission_sides','last_information_gain','remaining_budget'],reward:['new_official_admission_coverage','new_reachable_exact_turn_coverage','new_evidence_role_coverage','relation_completeness','minus_duplicate_nodes','minus_irrelevant_nodes','minus_action_and_token_cost'],reason:'The source Teacher contains only two nearly fixed worker paths, so frequency imitation cannot learn a dynamic Action Policy.'},
    };
    const model={...core,model_hash:sha256(stableJson(core))};validateMedLoCoMoHierarchicalPolicy(model);return deepFreeze(model);
  }
}

export function evaluateMedLoCoMoHierarchicalPolicy(model,holdoutArtifacts,{turn_limit=DEFAULTS.turn_limit,admission_association_weight=0.3,turn_association_weight=0.1}={}){
  if(model?.version!==MEDLOCOMO_HIERARCHICAL_POLICY_VERSION)throw new Error('Unsupported MedLoCoMo hierarchical policy');
  const admissionAssociations=associationLookup(model.admission_router),turnAssociations=associationLookup(model.turn_ranker),groups=new Map();
  for(const artifact of array(holdoutArtifacts)){
    validateTeacherShape(artifact);
    const sourceByRef=new Map(array(artifact.source_turns).map(turn=>[String(turn.source_ref),turn])),admissionById=new Map(array(artifact.admissions).map(admission=>[String(admission.admission_id),admission]));
    for(const item of array(artifact.cases)){
      const type=String(item.task?.question_type||''),scope=String(item.task?.scope||''),question=String(item.task?.question||''),operation=queryOperation(type,question),topology=evidenceTopology(type,operation),cell=model.policy_cells[`${type}:${scope}:${operation}:${topology}`]||null,requiredAdmissions=array(item.supervision?.official_evidence?.admission_ids).map(String),officialRefs=array(item.supervision?.official_evidence?.turn_refs).map(String),teacherRefs=array(item.retrieval_teacher?.final_state?.selected_source_refs).map(String),budget=admissionBudget(scope,cell,admissionById.size),effectiveTurnLimit=topology==='occurrence_ledger'?Math.max(40,turn_limit):turn_limit,admissionWeight=topology==='occurrence_ledger'?0:admission_association_weight,key=type;
      const row=groups.get(key)||newMetricGroup(),all=groups.get('__all__')||newMetricGroup();groups.set(key,row);groups.set('__all__',all);
      for(const metric of [row,all]){
        metric.case_count++;
        evaluateMode(metric.baseline,{artifact,item,question,scope,budget,turnLimit:effectiveTurnLimit,requiredAdmissions,officialRefs,teacherRefs,sourceByRef,admissionById,admissionAssociations:null,turnAssociations:null,admissionAssociationWeight:0,turnAssociationWeight:0});
        evaluateMode(metric.student,{artifact,item,question,scope,budget,turnLimit:effectiveTurnLimit,requiredAdmissions,officialRefs,teacherRefs,sourceByRef,admissionById,admissionAssociations,turnAssociations:officialRefs.length?turnAssociations:admissionAssociations,admissionAssociationWeight:admissionWeight,turnAssociationWeight:officialRefs.length?turn_association_weight:admissionWeight});
      }
    }
  }
  return deepFreeze({default_turn_limit:turn_limit,occurrence_ledger_turn_limit:Math.max(40,turn_limit),admission_association_weight,turn_association_weight,occurrence_ledger_association_weight:0,groups:Object.fromEntries([...groups.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,finalizeMetricGroup(value)]))});
}

export function withHierarchicalEvaluation(model,evaluation){
  validateMedLoCoMoHierarchicalPolicy(model);const core={...model,validation_evaluation:evaluation};return deepFreeze({...core,report_hash:sha256(stableJson(core))});
}

export function validateMedLoCoMoHierarchicalPolicy(model){
  if(!model||model.version!==MEDLOCOMO_HIERARCHICAL_POLICY_VERSION||model.benchmark!=='medlocomo'||model.runtime_eligible!==false)throw new Error('Invalid MedLoCoMo hierarchical policy header');
  if(model.boundary?.retains_patient_ids!==false||model.boundary?.retains_qa_ids!==false||model.boundary?.retains_full_question_text!==false||model.boundary?.retains_full_gold_text!==false||model.boundary?.retains_full_or_per_case_evidence_text!==false||model.boundary?.retains_source_refs!==false||model.boundary?.retains_case_lookup!==false)throw new Error('MedLoCoMo hierarchical policy violates its case-free boundary');
  const forbiddenKeys=new Set(['patient_id','qa_id','question','question_hash','gold','gold_answer','source_ref','source_refs','turn_ids','evidence_text']),stack=[model];
  while(stack.length){const value=stack.pop();if(Array.isArray(value)){stack.push(...value);continue;}if(!value||typeof value!=='object')continue;for(const[key,child]of Object.entries(value)){if(forbiddenKeys.has(key))throw new Error(`MedLoCoMo hierarchical policy retained forbidden field ${key}`);if(typeof child==='string'&&child.startsWith('turn:'))throw new Error('MedLoCoMo hierarchical policy retained a source Turn reference');stack.push(child);}}
  return true;
}

export function queryOperation(questionType,question){
  const text=normalize(question);
  if(questionType==='adversarial')return'answerability_check';
  if(questionType==='frequency_pattern')return/\bhow many\b|\bnumber of\b|\bhow often\b|\btimes?\b|\bepisodes?\b/u.test(text)?'count_occurrences':'frequency_extremum';
  if(questionType==='cross_admission_comparison')return'aligned_comparison';
  if(questionType==='longitudinal_progression')return/\b(?:what|which)\b[\s\S]{0,100}\b(?:became|developed|evolved|progressed|resolved|ultimately|eventually)\b|\bfinal\b|\boutcome\b/u.test(text)?'endpoint_outcome':'ordered_progression';
  if(questionType==='care_plan_rationale')return/\b(?:stopp?ed|discontinued|withheld|held|changed|switched|avoided|resumed|continued|started)\b/u.test(text)?'treatment_change_reason':'plan_rationale';
  if(/\bwhy\b|\breason\b|\brationale\b|\bdue to\b|\bcaus(?:e|ed|ing)\b/u.test(text))return'causal_explanation';
  return'direct_fact';
}

export function evidenceTopology(questionType,operation){
  if(operation==='answerability_check')return'answerability_probe';
  if(operation==='count_occurrences'||operation==='frequency_extremum')return'occurrence_ledger';
  if(operation==='aligned_comparison')return'parallel_sides';
  if(operation==='ordered_progression')return'ordered_chain';
  if(operation==='causal_explanation'||operation==='plan_rationale'||operation==='treatment_change_reason')return'local_pair';
  return questionType==='care_plan_rationale'?'local_pair':'point';
}

export function splitCommitment(patientIds){return sha256([...new Set(array(patientIds).map(String))].sort().join('\n'));}
export function stableJson(value){if(Array.isArray(value))return`[${value.map(stableJson).join(',')}]`;if(value&&typeof value==='object')return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;return JSON.stringify(value);}

class AssociationTrainer{
  constructor(config){this.config=config;this.caseCount=0;this.queryStats=new Map();this.evidenceStats=new Map();this.pairs=new Map();this.negativePairs=new Map();}
  observe({patientTag,queryTerms,question,positiveTexts,negativeTexts,preferredTerms=[],positiveWeight}){
    const positiveTerms=selectPositiveTerms(positiveTexts,this.config.maximum_positive_terms_per_case,{question,preferredTerms}),negativeTerms=selectPositiveTerms(negativeTexts,this.config.maximum_positive_terms_per_case,{question});
    if(!queryTerms.length||!positiveTerms.length)return;
    this.caseCount++;
    for(const term of queryTerms)incrementStat(this.queryStats,term,patientTag,1);
    for(const term of positiveTerms)incrementStat(this.evidenceStats,term,patientTag,positiveWeight);
    for(const queryTerm of queryTerms){
      const pairs=nested(this.pairs,queryTerm);for(const evidenceTerm of positiveTerms)if(queryTerm!==evidenceTerm)incrementStat(pairs,evidenceTerm,patientTag,positiveWeight);
      const negatives=nested(this.negativePairs,queryTerm);for(const evidenceTerm of negativeTerms)if(queryTerm!==evidenceTerm)incrementStat(negatives,evidenceTerm,patientTag,1);
    }
  }
  finalize(){
    const associations={};let edgeCount=0;
    for(const[queryTerm,queryStat]of[...this.queryStats.entries()].sort(([a],[b])=>a.localeCompare(b))){
      if(queryStat.patient_count<this.config.minimum_query_patient_support)continue;
      const rows=[];
      for(const[evidenceTerm,pair]of nested(this.pairs,queryTerm).entries()){
        if(pair.patient_count<this.config.minimum_pair_patient_support||pair.case_count<this.config.minimum_pair_case_support)continue;
        const negative=nested(this.negativePairs,queryTerm).get(evidenceTerm),adjusted=Math.max(0,pair.weight-this.config.negative_weight*Number(negative?.weight||0)),evidence=this.evidenceStats.get(evidenceTerm);if(!adjusted||!evidence)continue;
        const pmi=Math.log((adjusted*Math.max(1,this.caseCount))/(Math.max(1,queryStat.weight)*Math.max(0.0001,evidence.weight)));if(pmi<=0)continue;
        const weight=round(pmi*Math.log1p(adjusted)*(1+0.08*Math.log1p(pair.patient_count)));
        rows.push({term:evidenceTerm,weight,case_support:pair.case_count,patient_support:pair.patient_count,negative_case_support:Number(negative?.case_count||0)});
      }
      rows.sort((left,right)=>right.weight-left.weight||right.patient_support-left.patient_support||left.term.localeCompare(right.term));
      if(rows.length){associations[queryTerm]=rows.slice(0,this.config.maximum_expansions_per_query_term);edgeCount+=associations[queryTerm].length;}
    }
    const queryTermWeights=Object.fromEntries([...this.queryStats.entries()].filter(([,stats])=>stats.patient_count>=this.config.minimum_query_patient_support).sort(([a],[b])=>a.localeCompare(b)).map(([term,stats])=>[term,round(1+Math.log((this.caseCount+1)/(stats.case_count+1)))]));
    return{kind:'cross_patient_positive_pmi_token_association.v1',case_count:this.caseCount,query_term_count:Object.keys(associations).length,association_edge_count:edgeCount,minimum_query_patient_support:this.config.minimum_query_patient_support,minimum_pair_patient_support:this.config.minimum_pair_patient_support,minimum_pair_case_support:this.config.minimum_pair_case_support,maximum_expansions_per_query_term:this.config.maximum_expansions_per_query_term,negative_weight:this.config.negative_weight,query_term_weights:queryTermWeights,associations};
  }
}

function observeCell(cells,{questionType,scope,operation,topology,item}){
  const key=`${questionType}:${scope}:${operation}:${topology}`,cell=cells.get(key)||{question_type:questionType,scope,query_operation:operation,evidence_topology:topology,case_count:0,evidence_admission_counts:[],evidence_turn_counts:[],answer_word_counts:[],target_kinds:{},trap_types:{},required_relations:{},evidence_roles:{},semantic_unit_kinds:{},judge_protocols:{},judge_required_unit_counts:[],needs_context_count:0,numeric_answer_count:0,abstention_count:0};
  cell.case_count++;cell.evidence_admission_counts.push(array(item.supervision?.official_evidence?.admission_ids).length);cell.evidence_turn_counts.push(array(item.supervision?.official_evidence?.turn_refs).length);cell.answer_word_counts.push(words(item.supervision?.gold_answer).length);increment(cell.target_kinds,String(item.supervision?.answer_contract?.target_kind||'unknown'));for(const trap of array(item.supervision?.traps))increment(cell.trap_types,String(trap.type||'unknown'));for(const relation of array(item.supervision?.required_relations)){increment(cell.required_relations,String(relation.relation||'unknown'));increment(cell.semantic_unit_kinds,'relation');}for(const concept of array(item.supervision?.required_concepts))increment(cell.semantic_unit_kinds,String(concept.kind||'concept'));for(const _number of array(item.supervision?.required_numbers))increment(cell.semantic_unit_kinds,'number');for(const source of array(item.supervision?.source_turn_selection))increment(cell.evidence_roles,String(source.evidence_role||'unknown'));increment(cell.judge_protocols,String(item.supervision?.judge_semantic_contract?.protocol||'unknown'));cell.judge_required_unit_counts.push(array(item.supervision?.judge_semantic_contract?.required_semantic_unit_ids).length);if(array(item.supervision?.source_turn_selection).some(row=>row.selection_basis==='adjacent_context'))cell.needs_context_count++;if(array(item.supervision?.required_numbers).length)cell.numeric_answer_count++;if(normalize(item.supervision?.gold_answer)===CANONICAL_ABSTENTION)cell.abstention_count++;cells.set(key,cell);
}

function finalizeCell(cell){
  const targetKinds=rates(cell.target_kinds,cell.case_count),traps=rates(cell.trap_types,cell.case_count),relations=rates(cell.required_relations,cell.case_count),answerWords=distribution(cell.answer_word_counts);
  return{question_type:cell.question_type,scope:cell.scope,query_operation:cell.query_operation,evidence_topology:cell.evidence_topology,case_count:cell.case_count,evidence_admissions:distribution(cell.evidence_admission_counts),evidence_turns:distribution(cell.evidence_turn_counts),answer_words:answerWords,target_kind_rates:targetKinds,trap_rates:traps,required_relation_mean_per_case:relations,evidence_role_mean_per_case:rates(cell.evidence_roles,cell.case_count),semantic_unit_mean_per_case:rates(cell.semantic_unit_kinds,cell.case_count),judge_protocol_rates:rates(cell.judge_protocols,cell.case_count),judge_required_semantic_units:distribution(cell.judge_required_unit_counts),needs_context_rate:ratio(cell.needs_context_count,cell.case_count),numeric_answer_rate:ratio(cell.numeric_answer_count,cell.case_count),canonical_abstention_rate:ratio(cell.abstention_count,cell.case_count),action_blueprint:actionBlueprint(cell.evidence_topology),answer_overlay_prior:{target_kind:topKey(targetKinds),recommended_max_words:Math.max(1,answerWords.p90),preserve_number_and_unit:cell.numeric_answer_count>0,canonical_abstention_only:cell.abstention_count===cell.case_count,highest_risk_traps:topKeys(traps,3),required_relation_shapes:topKeys(relations,3)}};
}

function actionBlueprint(topology){
  if(topology==='point')return['locate_scope','retrieve_target','verify_relation','answer'];
  if(topology==='local_pair')return['locate_scope','retrieve_target','expand_local_context','retrieve_counterpart','verify_relation','answer'];
  if(topology==='ordered_chain')return['retrieve_target','complete_admission_coverage','order_evidence','verify_relation','answer'];
  if(topology==='parallel_sides')return['retrieve_target','retrieve_counterpart','complete_admission_coverage','verify_relation','answer'];
  if(topology==='occurrence_ledger')return['retrieve_target','complete_admission_coverage','deduplicate_occurrences','verify_relation','answer'];
  return['locate_scope','retrieve_target','expand_local_context','verify_answerability','answer'];
}

function observeDynamicTransitions(transitions,{patientTag,scope,operation,topology,item}){
  const needsContext=array(item.supervision?.source_turn_selection).some(row=>row.selection_basis==='adjacent_context'),multiAdmission=array(item.supervision?.official_evidence?.admission_ids).length>1,steps=[];
  if(topology==='point')steps.push(['scope_unknown','locate_scope'],['scope_ready_target_missing','retrieve_target'],['target_covered_relation_unverified','verify_relation'],['answer_ready','answer']);
  else if(topology==='local_pair')steps.push(['scope_unknown','locate_scope'],['scope_ready_target_missing','retrieve_target'],['target_covered_counterpart_missing',needsContext?'expand_local_context':'retrieve_counterpart'],['pair_covered_relation_unverified','verify_relation'],['answer_ready','answer']);
  else if(topology==='ordered_chain')steps.push(['trajectory_empty','retrieve_target'],[multiAdmission?'some_admission_points_missing':'trajectory_point_missing','complete_admission_coverage'],['all_points_covered_unordered','order_evidence'],['ordered_chain_unverified','verify_relation'],['answer_ready','answer']);
  else if(topology==='parallel_sides')steps.push(['comparison_empty','retrieve_target'],['first_side_covered_second_missing','retrieve_counterpart'],['some_admission_sides_missing','complete_admission_coverage'],['all_sides_covered_unverified','verify_relation'],['answer_ready','answer']);
  else if(topology==='occurrence_ledger')steps.push(['ledger_empty','retrieve_target'],['ledger_scope_incomplete','complete_admission_coverage'],['candidates_covered_not_deduplicated','deduplicate_occurrences'],['ledger_unverified','verify_relation'],['answer_ready','answer']);
  else steps.push(['scope_unknown','locate_scope'],['claim_evidence_unchecked','retrieve_target'],['related_evidence_requires_context',needsContext?'expand_local_context':'verify_answerability'],['exact_claim_unverified','verify_answerability'],['answer_ready','answer']);
  for(const[state,action]of steps){const key=`${scope}:${operation}:${topology}:${state}`,byAction=nested(transitions,key);incrementStat(byAction,action,patientTag,1);}
}

function finalizeDynamicTransitions(transitions){
  const states={};let transitionCount=0;
  for(const[key,byAction]of[...transitions.entries()].sort(([a],[b])=>a.localeCompare(b))){
    const actions=[...byAction.entries()].map(([action,stats])=>({action_role:action,support_cases:stats.case_count,support_patients:stats.patient_count})).sort((left,right)=>right.support_cases-left.support_cases||left.action_role.localeCompare(right.action_role)),total=actions.reduce((sum,row)=>sum+row.support_cases,0);states[key]={support_cases:total,actions:actions.map(row=>({...row,probability:ratio(row.support_cases,total)}))};transitionCount+=actions.length;
  }
  return{kind:'query_and_coverage_conditioned_transition_prior.v1',runtime_eligible:false,source:'counterfactual evidence-coverage states derived from training labels; not imitation of the fixed Teacher worker path',state_key:'scope:query_operation:evidence_topology:current_coverage_state',transition_count:transitionCount,states};
}

function evaluateMode(metric,{artifact,question,scope,budget,turnLimit,requiredAdmissions,officialRefs,teacherRefs,sourceByRef,admissionById,admissionAssociations,turnAssociations,admissionAssociationWeight,turnAssociationWeight}){
  const queryTerms=contentTerms(question),datedAdmissions=explicitDateAdmissions(question,admissionById),admissionRows=[];
  for(const admission of admissionById.values()){
    const id=String(admission.admission_id),turns=array(admission.source_turn_refs).map(ref=>sourceByRef.get(String(ref))).filter(Boolean),turnScores=turns.map(turn=>scoreText(question,queryTerms,String(turn.text||''),admissionAssociations,admissionAssociationWeight)).sort((a,b)=>b-a),dateMatch=!datedAdmissions.size||datedAdmissions.has(id),score=(turnScores[0]||0)+0.35*(turnScores[1]||0)+0.15*(turnScores[2]||0)+(dateMatch&&datedAdmissions.size?1000:0);
    admissionRows.push({id,score,dateMatch});
  }
  admissionRows.sort((left,right)=>right.score-left.score||left.id.localeCompare(right.id));
  const pool=datedAdmissions.size?admissionRows.filter(row=>row.dateMatch):admissionRows,selectedAdmissions=new Set(pool.slice(0,Math.max(1,budget)).map(row=>row.id));
  metric.admission_recall_sum+=recall(requiredAdmissions,[...selectedAdmissions]);metric.admission_all_covered+=Number(requiredAdmissions.every(id=>selectedAdmissions.has(id)));metric.admission_budget_insufficient+=Number(requiredAdmissions.length>budget);
  const rankedTurns=[...selectedAdmissions].flatMap(id=>array(admissionById.get(id)?.source_turn_refs).map(ref=>sourceByRef.get(String(ref))).filter(Boolean).map(turn=>({turn,score:scoreText(question,queryTerms,String(turn.text||''),turnAssociations||admissionAssociations,turnAssociationWeight)}))).sort((left,right)=>right.score-left.score||Number(left.turn.admission_order||0)-Number(right.turn.admission_order||0)||Number(left.turn.turn_number||0)-Number(right.turn.turn_number||0)).slice(0,turnLimit).map(row=>String(row.turn.source_ref));
  metric.teacher_turn_recall_sum+=recall(teacherRefs,rankedTurns);metric.teacher_turn_case_count++;metric.teacher_turn_budget_insufficient+=Number(teacherRefs.length>turnLimit);
  if(officialRefs.length){metric.official_turn_recall_sum+=recall(officialRefs,rankedTurns);metric.official_turn_any_hit+=Number(officialRefs.some(ref=>rankedTurns.includes(ref)));metric.official_turn_all_hit+=Number(officialRefs.every(ref=>rankedTurns.includes(ref)));metric.official_turn_case_count++;}
}

function scoreText(question,queryTerms,text,associationModel,associationWeight){
  const terms=new Set(contentTerms(text)),allWords=new Set(words(text)),normalized=normalize(text);let score=0;
  for(const term of queryTerms){const idf=Number(associationModel?.query_weights?.get(term)||1);if(terms.has(term))score+=(/^\d/u.test(term)?2.5:term.includes('_')?2.25:1.25)*idf;else if(/^\d/u.test(term)&&allWords.has(term))score+=2.5*idf;for(const edge of associationModel?.associations?.get(term)||[])if(terms.has(edge.term))score+=Math.min(4,edge.weight)*associationWeight;}
  for(const phrase of salientPhrases(question))if(normalized.includes(phrase))score+=2;
  return score;
}

function admissionBudget(scope,cell,admissionCount){if(scope==='single_admission')return 1;return Math.min(admissionCount,Math.max(2,Number(cell?.evidence_admissions?.p90||4)));}
function explicitDateAdmissions(question,admissionById){const dates=[...String(question||'').matchAll(/\b(\d{4}-\d{2}-\d{2})\b/gu)].map(match=>match[1]);if(!dates.length)return new Set();const low=[...dates].sort()[0],high=[...dates].sort().at(-1),matches=new Set();for(const[id,admission]of admissionById){const start=String(admission.admission_start||'').slice(0,10),end=String(admission.admission_end||'').slice(0,10);if(start&&end&&start<=high&&end>=low)matches.add(id);}return matches;}

function associationLookup(model){const associations=new Map(),queryWeights=new Map();for(const[key,rows]of Object.entries(model?.associations||{}))associations.set(key,array(rows));for(const[key,value]of Object.entries(model?.query_term_weights||{}))queryWeights.set(key,Number(value||1));return{associations,query_weights:queryWeights};}
function newMetricGroup(){return{case_count:0,baseline:newMetric(),student:newMetric()};}
function newMetric(){return{admission_recall_sum:0,admission_all_covered:0,admission_budget_insufficient:0,teacher_turn_recall_sum:0,teacher_turn_case_count:0,teacher_turn_budget_insufficient:0,official_turn_recall_sum:0,official_turn_any_hit:0,official_turn_all_hit:0,official_turn_case_count:0};}
function finalizeMetricGroup(group){return{case_count:group.case_count,baseline:finalizeMetric(group.baseline,group.case_count),student:finalizeMetric(group.student,group.case_count)};}
function finalizeMetric(metric,total){return{official_admission_recall:ratio(metric.admission_recall_sum,total),official_admission_all_covered_rate:ratio(metric.admission_all_covered,total),admission_budget_insufficient_case_count:metric.admission_budget_insufficient,teacher_selected_turn_recall:ratio(metric.teacher_turn_recall_sum,metric.teacher_turn_case_count),teacher_turn_budget_insufficient_case_count:metric.teacher_turn_budget_insufficient,official_exact_turn:{case_count:metric.official_turn_case_count,recall:ratio(metric.official_turn_recall_sum,metric.official_turn_case_count),any_hit_rate:ratio(metric.official_turn_any_hit,metric.official_turn_case_count),all_hit_rate:ratio(metric.official_turn_all_hit,metric.official_turn_case_count)}};}

function validateTeacherShape(artifact){if(!artifact||artifact.benchmark!=='medlocomo'||!Array.isArray(artifact.cases)||!Array.isArray(artifact.source_turns)||!Array.isArray(artifact.admissions))throw new Error('Invalid MedLoCoMo Teacher patient artifact');}
function selectPositiveTerms(texts,limit,{question='',preferredTerms=[]}={}){
  const counts=new Map(),priority=new Set(array(preferredTerms)),query=new Set(contentUnigrams(question));
  for(const text of array(texts)){
    const terms=words(text).filter(term=>term.length>1&&!STOP.has(term));for(const term of terms)counts.set(term,Number(counts.get(term)||0)+1);
    for(let index=0;index<terms.length;index++)if(query.has(terms[index]))for(let offset=-4;offset<=4;offset++){const term=terms[index+offset];if(term&&!query.has(term))priority.add(term);}
  }
  return[...counts.keys()].sort((left,right)=>Number(priority.has(right))-Number(priority.has(left))||Number(counts.get(right))-Number(counts.get(left))||left.localeCompare(right)).slice(0,limit);
}
function supervisionTerms(item,texts){const available=new Set(array(texts).flatMap(contentUnigrams)),out=[];for(const value of [...array(item.supervision?.required_concepts).map(row=>row.concept),...array(item.supervision?.required_numbers).map(row=>row.text)])for(const term of contentUnigrams(value))if(available.has(term))out.push(term);return[...new Set(out)];}
function contentUnigrams(value){return[...new Set(words(value).filter(term=>!STOP.has(term)&&term.length>1&&!/^\d{4}-\d{2}(?:-\d{2})?$/u.test(term)))];}
function contentTerms(value){const base=words(value).filter(term=>!STOP.has(term)&&term.length>1&&!/^\d{4}-\d{2}(?:-\d{2})?$/u.test(term)),out=new Set(base);for(let index=0;index<base.length-1;index++)if(base[index].length>2&&base[index+1].length>2)out.add(`${base[index]}_${base[index+1]}`);return[...out];}
function salientPhrases(value){return words(value).filter(term=>term.length>=5&&!STOP.has(term)).slice(0,8);}
function words(value){return normalize(value).match(/[a-z0-9]+(?:[.'-][a-z0-9]+)*/gu)||[];}
function normalize(value){return String(value||'').normalize('NFKC').trim().toLowerCase().replace(/[’]/gu,"'").replace(/\s+/gu,' ');}
function nested(map,key){let value=map.get(key);if(!value){value=new Map();map.set(key,value);}return value;}
function incrementStat(map,key,patientTag,weight){let value=map.get(key);if(!value){value={case_count:0,patient_count:0,weight:0,last_patient:null};map.set(key,value);}value.case_count++;value.weight+=Number(weight||0);if(value.last_patient!==patientTag){value.patient_count++;value.last_patient=patientTag;}}
function increment(object,key){object[key]=Number(object[key]||0)+1;}
function distribution(values){const sorted=[...values].sort((a,b)=>a-b);return{mean:round(sorted.length?sorted.reduce((sum,value)=>sum+value,0)/sorted.length:0),median:quantile(sorted,0.5),p90:quantile(sorted,0.9),max:sorted.at(-1)||0};}
function rates(counts,total){return Object.fromEntries(Object.entries(counts).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,ratio(value,total)]));}
function topKey(ratesObject){return topKeys(ratesObject,1)[0]||'unknown';}
function topKeys(ratesObject,limit){return Object.entries(ratesObject).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,limit).map(([key])=>key);}
function quantile(values,p){return values.length?values[Math.min(values.length-1,Math.max(0,Math.ceil(values.length*p)-1))]:0;}
function recall(expected,actual){const targets=new Set(array(expected).map(String));if(!targets.size)return 1;const found=new Set(array(actual).map(String));return[...targets].filter(value=>found.has(value)).length/targets.size;}
function ratio(numerator,denominator){return denominator?round(Number(numerator||0)/Number(denominator)):0;}
function round(value){return Math.round(Number(value||0)*10000)/10000;}
function array(value){return Array.isArray(value)?value:[];}
function sha256(value){return createHash('sha256').update(String(value)).digest('hex');}
function deepFreeze(value){if(!value||typeof value!=='object'||Object.isFrozen(value))return value;for(const child of Object.values(value))deepFreeze(child);return Object.freeze(value);}
