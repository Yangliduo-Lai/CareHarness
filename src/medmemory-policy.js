import { sha256,stableJson } from './matched-utils.js';

/**
 * MedMemoryBench 的 Policy 单一事实源。
 *
 * 本文件集中保存：运行时版本、题型级调查合同、离线聚合先验、校验、注入与审计清单。
 * Prompt 文本仍统一保存在 prompts.js；执行器只读取这里的声明并执行，不另存策略副本。
 */
export const INVESTIGATION_WORKER_SET_VERSION='careharness-investigation-workers.v5-source-separated-relations';
export const MEDMEMORY_MATCHED_RUNTIME_VERSION='careharness-investigation-runtime.v15-transition-objective-soft-relative';
export const MEDMEMORY_STUDENT_POLICY_RUNTIME_VERSION='medmemory-student-policy.runtime.v1-case-free-aggregate';
export const MEDMEMORY_INVESTIGATION_STRATEGY_VERSION='medmemory-investigation-strategy.v2-auditable-offline-student';
export const MEDMEMORY_QUERY_CLASSIFIER_VERSION='medmemory-query-classifier.v1-question-only';
export const MEDMEMORY_QUERY_TYPES=Object.freeze(['entity_exact_match','temporal_localization','state_update','multiple_choice','inference_generation','multi_hop_clinical_deduction']);

export const MEDMEMORY_INVESTIGATION_STRATEGIES=deepFreezePolicyObject({
  entity_exact_match:{
    strategy_id:'exact_entity',answer_memory_limit:10,answer_focus_limit:1,reasoning_hypotheses:false,target_only_assessment:true,disabled_workers:['trace'],
    evidence_contract:['one requested entity at the question\'s abstraction level','literal name/class/value/range/unit','one source-cited target fact'],
    preferred_path:['search a rare literal or semantic paraphrase','assess the exact target','refine only distractors','verify','answer'],
    stop_condition:'The exact requested entity, including any material range or unit, is source-cited.',
    policy_directive:'Do not build a causal hypothesis. Preserve the source category wording when the question asks for a class rather than a member.'
  },
  temporal_localization:{
    strategy_id:'event_time_pair',answer_memory_limit:12,answer_focus_limit:2,reasoning_hypotheses:false,target_only_assessment:true,disabled_workers:[],
    evidence_contract:['the requested event and its date as one pair','an executable exact/range/earliest temporal boundary','nearby same-Session context only when needed to disambiguate'],
    preferred_path:['apply the temporal boundary','search and semantically rank inside that boundary','contextualize only a matching Session','assess the event-time pair','verify','answer'],
    stop_condition:'Exactly one source-cited event-time pair answers the direction of the question.',
    policy_directive:'Never substitute a nearby date or a different occurrence of the same symptom. For first/onset questions keep the earliest boundary permanent.'
  },
  state_update:{
    strategy_id:'factor_trajectory',answer_memory_limit:20,answer_focus_limit:10,reasoning_hypotheses:false,target_only_assessment:false,disabled_workers:[],
    evidence_contract:['the same factor at baseline and latest applicable update','adoption, reversal, or execution events that determine the current version','the concrete latest value, status, or complete plan components'],
    preferred_path:['when the question states a baseline, first search the named factor together with the literal baseline and change wording','otherwise search the named factor','trace its longitudinal versions','assess the explicit baseline-bound update before applying a global latest operation','retain all non-redundant updates inside scope','verify','answer'],
    stop_condition:'The latest effective state is source-cited; when the chart documents a change, the update that makes it current is also retained.',
    policy_directive:'A recent exception does not erase a sustained baseline pattern, and an old summary does not override a newer explicit update. When the question itself supplies a prior value or status, treat the source-grounded record that explicitly binds that baseline to a changed value as the primary answer-bearing update; do not let a later isolated continuation silently redefine which transition was asked about unless the question gives a later as-of boundary. A relative time phrase grammatically attached to a baseline clause dates the baseline rather than the requested current answer: keep the forward update search open and never persist the baseline period as the target boundary.'
  },
  multiple_choice:{
    strategy_id:'option_claim_matrix',answer_memory_limit:16,answer_focus_limit:8,reasoning_hypotheses:false,target_only_assessment:false,disabled_workers:[],
    evidence_contract:['every visible option as an independent atomic claim','patient-specific support or contradiction for every option','shared allergies, contraindications, preferences, execution facts, and current-version constraints only when relevant'],
    preferred_path:['assess visible Profile and recent Sessions option by option','search one unresolved historical option constraint','reassess the complete option matrix','verify','answer'],
    stop_condition:'Every option has a source-grounded supported, contradicted, or genuinely unresolved status.',
    policy_directive:'Treat symptoms and circumstances stated in the question as visible facts. Do not search for prospective examination findings merely to decide recorded option feasibility, and do not group drugs from different classes.'
  },
  inference_generation:{
    strategy_id:'patient_specific_decision_chain',answer_memory_limit:20,answer_focus_limit:10,reasoning_hypotheses:true,target_only_assessment:false,disabled_workers:[],
    evidence_contract:['confirmed condition or disease stage','objective severity and longitudinal trajectory','actual treatment exposure and execution','response, failure, or adverse effect','manifestations, complications, contraindications, and feasible constraints that can change the decision'],
    preferred_path:['assess the visible chart representation','search the strongest missing diagnosis/trajectory/treatment-response anchor','trace from a retrieved anchor across time','reassess all material final states','refine only true distractors','verify','answer'],
    stop_condition:'The recommendation is supported by a compact source-cited patient chain and the strongest competing explanation has been checked.',
    policy_directive:'Do not stop at a proximal lifestyle trigger when diagnosis, treatment failure, complication, or objective deterioration is visible or still searchable. Prioritize up to ten non-duplicate material facts for answer_focus, grouping only facts that share one source-supported role.'
  },
  multi_hop_clinical_deduction:{
    strategy_id:'node_relation_chain',answer_memory_limit:24,answer_focus_limit:16,reasoning_hypotheses:true,target_only_assessment:false,disabled_workers:[],
    evidence_contract:['dated patient-specific start, intermediate, and outcome anchors','objective values, treatments, symptoms, diagnoses, and timing preserved literally','explicit relations between adjacent anchors','a clearly marked clinical-inference bridge when no chart node can contain the mechanism'],
    preferred_path:['search distinct endpoints with multiple narrow lenses','trace shortest graph paths from visible anchors toward the missing endpoint or bridge','assess node coverage and adjacent relations','search one missing patient endpoint if necessary','refine while preserving the chain','verify','answer'],
    stop_condition:'The final packet contains source-cited chronological endpoints that form a logical chain; any chart-absent mechanism connecting them is explicitly marked as clinical inference rather than a graph fact.',
    policy_directive:'Do not mistake mechanism-only annotation language for retrievable patient history. When a bridge is absent from the chart, retain its patient endpoints and label the bridge as clinical inference rather than repeatedly searching for nonexistent wording.'
  }
});

export function medMemoryInvestigationStrategy(task){
  const profile=MEDMEMORY_INVESTIGATION_STRATEGIES[String(task||'')];
  return profile?clone({version:MEDMEMORY_INVESTIGATION_STRATEGY_VERSION,query_type:String(task),...profile}):null;
}

export function validateMedMemoryQueryClassification(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('MedMemory query classification must be one JSON object');
  const keys=Object.keys(value),allowed=new Set(['query_type','confidence','rationale']);
  if(keys.some(key=>!allowed.has(key)))throw new Error('MedMemory query classification contains unsupported fields');
  const queryType=String(value.query_type||'').trim(),confidence=Number(value.confidence),rationale=String(value.rationale||'').normalize('NFKC').trim();
  if(!MEDMEMORY_QUERY_TYPES.includes(queryType))throw new Error(`Unknown MedMemory query type: ${queryType||'<empty>'}`);
  if(!Number.isFinite(confidence)||confidence<0||confidence>1)throw new Error('MedMemory query classification confidence must be between 0 and 1');
  if(!rationale||rationale.length>240)throw new Error('MedMemory query classification rationale must contain 1-240 characters');
  return{query_type:queryType,confidence,rationale};
}

export function fallbackMedMemoryQueryClassification(question){
  const text=String(question||'').normalize('NFKC').trim(),optionCount=(text.match(/(?:^|\n)\s*[A-F]\s*[.、:：)]/gmu)||[]).length;
  if(optionCount>=2)return classification('multiple_choice',.98,'问题包含多个显式字母选项，需要选择一个或多个选项。');
  if(hasAny(text,['要不要','需不需要','是否需要','是否应该','应该吗','怎么办','怎么处理','能不能','可以吗','适合吗','建议','加药','加量','减量','换药','停药']))return classification('inference_generation',.72,'问题要求结合患者情况作出建议、判断或处置决定。');
  if(hasAny(text,['为什么','为何','原因','机制','如何导致','有什么联系','关联','综合分析','综合判断','推理链','因果']))return classification('multi_hop_clinical_deduction',.68,'问题要求解释原因、关系或跨信息推理链。');
  if(hasAny(text,['最近一次','最新','目前','当前','现在','近来','近期状态','变成了什么','更新为','现状']))return classification('state_update',.75,'问题询问同一因素的当前、最新或更新后状态。');
  if(hasExplicitDate(text)||hasAny(text,['何时','什么时候','哪天','几月几日','次日','翌日','前一天','后一天','当日','当天','开始出现','首次出现','最早出现']))return classification('temporal_localization',.74,'问题要求定位时间点，或定位特定时间对应的事件。');
  return classification('entity_exact_match',.62,'问题主要要求提取一个明确实体、类别、名称、数值或短语。');
}

export async function classifyMedMemoryQuery(question,gateway){
  const input={question:String(question||'').trim()};
  if(!input.question)throw new Error('MedMemory query classifier requires a non-empty question');
  const fallback=()=>fallbackMedMemoryQueryClassification(input.question);
  if(!gateway||typeof gateway.completeJSON!=='function')return{...fallback(),version:MEDMEMORY_QUERY_CLASSIFIER_VERSION,method:'deterministic_fallback',model_trace:null};
  try{
    const response=await gateway.completeJSON('medmemory_query_classifier',input,validateMedMemoryQueryClassification,fallback,{maxTokens:220,extractJsonObject:true});
    return{...response.value,version:MEDMEMORY_QUERY_CLASSIFIER_VERSION,method:response.trace?.mock===true||gateway.config?.provider==='mock'?'deterministic_fallback':'llm_question_only',model_trace:response.trace||null};
  }catch(error){
    return{...fallback(),version:MEDMEMORY_QUERY_CLASSIFIER_VERSION,method:'deterministic_fallback_after_model_error',model_trace:error?.gatewayTrace||{error:{message:String(error?.message||error)}}};
  }
}

export function resolveMedMemoryRuntimeTasks(officialQueryType,classification,{routing_mode='classified'}={}){
  const answerTask=String(officialQueryType||'').trim();
  if(!MEDMEMORY_QUERY_TYPES.includes(answerTask))throw new Error(`Unknown official MedMemory query type: ${answerTask||'<empty>'}`);
  const predictedTask=String(classification?.query_type||classification?.predicted_query_type||'').trim();
  if(!['classified','official_oracle_diagnostic'].includes(routing_mode))throw new Error(`Unknown MedMemory query type routing mode: ${routing_mode}`);
  const classifiedTask=MEDMEMORY_QUERY_TYPES.includes(predictedTask)?predictedTask:answerTask;
  return{retrieval_task:routing_mode==='official_oracle_diagnostic'?answerTask:classifiedTask,answer_task:answerTask,routing_mode};
}

function classification(query_type,confidence,rationale){return{query_type,confidence,rationale};}
function hasAny(text,terms){return terms.some(term=>text.includes(term));}
function hasExplicitDate(text){return/(?:19|20)\d{2}[年\/.\-]\d{1,2}(?:[月\/.\-]\d{1,2}日?)?|\d{1,2}月\d{1,2}日/u.test(text);}

export const MEDMEMORY_BUILTIN_STUDENT_ARTIFACT=Object.freeze({
  "version": "medmemory-student-strategy-summary.v2-action-role-patterns",
  "runtime_eligible": true,
  "source_teacher_version": "medmemory-oracle-teacher.v2-auditable-trajectories",
  "source_teacher_hash": "e455b7213ae1b793a036e971bb42855e5a7e0c1bc0240a7a8ec3f86a94fe6a23",
  "compiled_strategy_version": "medmemory-investigation-strategy.v2-auditable-offline-student",
  "compiled_strategy_profile_hash": "053789f81679cd7df1695a255434131544be67fd5e5426d2f42a31bbe7fc4e7f",
  "training_scope": {
    "clean_only": true,
    "persona_count": 20,
    "holdout_persona_count": 0,
    "case_count": 1939,
    "teacher_read_question_text": true,
    "teacher_read_gold_and_judge_metadata": true,
    "runtime_retains_question_text": false,
    "runtime_retains_case_ids": false,
    "runtime_retains_persona_ids": false,
    "runtime_retains_patient_facts": false,
    "runtime_retains_gold_or_judge_content": false
  },
  "query_types": {
    "entity_exact_match": {
      "case_count": 400,
      "mean_target_count": 1,
      "mean_source_session_count": 1,
      "mean_oracle_step_count": 3,
      "reachability_rates": {
        "paraphrase_candidate": 0.9875,
        "raw_dialogue_only": 0.0125
      },
      "recommended_action_paths": [
        {
          "actions": [
            "search_entity_evidence",
            "verify_target_coverage",
            "answer_from_verified_evidence"
          ],
          "support": 400
        }
      ],
      "recommended_evidence_role_patterns": [
        {
          "evidence_roles": [
            "entity_fact"
          ],
          "support": 400
        }
      ],
      "action_evidence_role_patterns": [
        {
          "action": "answer_from_verified_evidence",
          "evidence_roles": [
            "entity_fact"
          ],
          "support": 400
        },
        {
          "action": "search_entity_evidence",
          "evidence_roles": [
            "entity_fact"
          ],
          "support": 400
        },
        {
          "action": "verify_target_coverage",
          "evidence_roles": [
            "entity_fact"
          ],
          "support": 400
        }
      ],
      "decision_check_priors": []
    },
    "inference_generation": {
      "case_count": 381,
      "mean_target_count": 5.6089,
      "mean_source_session_count": 3.2336,
      "mean_oracle_step_count": 4.1496,
      "reachability_rates": {
        "paraphrase_candidate": 0.9036,
        "raw_dialogue_only": 0.0721,
        "direct_state_candidate": 0.0047,
        "unreachable": 0.0197
      },
      "recommended_action_paths": [
        {
          "actions": [
            "search_patient_decision_evidence",
            "connect_patient_decision_evidence",
            "verify_target_coverage",
            "answer_from_verified_evidence"
          ],
          "support": 269
        },
        {
          "actions": [
            "search_patient_decision_evidence",
            "search_patient_decision_evidence",
            "connect_patient_decision_evidence",
            "verify_target_coverage",
            "answer_from_verified_evidence"
          ],
          "support": 53
        },
        {
          "actions": [
            "search_patient_decision_evidence",
            "verify_target_coverage",
            "answer_from_verified_evidence"
          ],
          "support": 29
        }
      ],
      "recommended_evidence_role_patterns": [
        {
          "evidence_roles": [
            "patient_specific_anchor",
            "patient_specific_decision_factor"
          ],
          "support": 380
        },
        {
          "evidence_roles": [
            "patient_specific_anchor"
          ],
          "support": 1
        }
      ],
      "action_evidence_role_patterns": [
        {
          "action": "search_patient_decision_evidence",
          "evidence_roles": [
            "patient_specific_anchor",
            "patient_specific_decision_factor"
          ],
          "support": 382
        },
        {
          "action": "answer_from_verified_evidence",
          "evidence_roles": [
            "patient_specific_anchor",
            "patient_specific_decision_factor"
          ],
          "support": 380
        },
        {
          "action": "verify_target_coverage",
          "evidence_roles": [
            "patient_specific_anchor",
            "patient_specific_decision_factor"
          ],
          "support": 380
        },
        {
          "action": "connect_patient_decision_evidence",
          "evidence_roles": [
            "patient_specific_anchor",
            "patient_specific_decision_factor"
          ],
          "support": 351
        },
        {
          "action": "search_patient_decision_evidence",
          "evidence_roles": [
            "patient_specific_decision_factor"
          ],
          "support": 47
        },
        {
          "action": "assess_unreachable_evidence_gap",
          "evidence_roles": [
            "patient_specific_decision_factor"
          ],
          "support": 16
        },
        {
          "action": "assess_unreachable_evidence_gap",
          "evidence_roles": [
            "patient_specific_anchor",
            "patient_specific_decision_factor"
          ],
          "support": 8
        },
        {
          "action": "search_patient_decision_evidence",
          "evidence_roles": [
            "patient_specific_anchor"
          ],
          "support": 8
        }
      ],
      "decision_check_priors": [
        {
          "category": "contraindication",
          "support": 71
        },
        {
          "category": "lifestyle",
          "support": 62
        },
        {
          "category": "longitudinal_update",
          "support": 48
        },
        {
          "category": "symptom_differential",
          "support": 44
        },
        {
          "category": "allergy",
          "support": 42
        },
        {
          "category": "preference",
          "support": 37
        },
        {
          "category": "interaction",
          "support": 31
        },
        {
          "category": "dose_adjustment",
          "support": 26
        },
        {
          "category": "dose_timing",
          "support": 14
        },
        {
          "category": "disease_stage",
          "support": 12
        },
        {
          "category": "monitoring",
          "support": 4
        },
        {
          "category": "access",
          "support": 3
        }
      ]
    },
    "multi_hop_clinical_deduction": {
      "case_count": 191,
      "mean_target_count": 9.9372,
      "mean_source_session_count": 4.0995,
      "mean_oracle_step_count": 5.6492,
      "reachability_rates": {
        "paraphrase_candidate": 0.8124,
        "raw_dialogue_only": 0.0827,
        "infer_missing_mechanism_bridge": 0.0927,
        "direct_state_candidate": 0.0063,
        "unreachable": 0.0058
      },
      "recommended_action_paths": [
        {
          "actions": [
            "search_multi_visit_evidence",
            "search_multi_visit_evidence",
            "connect_multi_visit_evidence",
            "infer_missing_mechanism_bridge",
            "verify_target_coverage",
            "answer_from_verified_evidence"
          ],
          "support": 116
        },
        {
          "actions": [
            "search_multi_visit_evidence",
            "connect_multi_visit_evidence",
            "infer_missing_mechanism_bridge",
            "verify_target_coverage",
            "answer_from_verified_evidence"
          ],
          "support": 34
        },
        {
          "actions": [
            "search_multi_visit_evidence",
            "search_multi_visit_evidence",
            "connect_multi_visit_evidence",
            "verify_target_coverage",
            "answer_from_verified_evidence"
          ],
          "support": 31
        }
      ],
      "recommended_evidence_role_patterns": [
        {
          "evidence_roles": [
            "causal_chain_observation",
            "missing_mechanism_bridge",
            "multi_visit_fact_node",
            "patient_history_anchor"
          ],
          "support": 155
        },
        {
          "evidence_roles": [
            "causal_chain_observation",
            "multi_visit_fact_node",
            "patient_history_anchor"
          ],
          "support": 36
        }
      ],
      "action_evidence_role_patterns": [
        {
          "action": "search_multi_visit_evidence",
          "evidence_roles": [
            "causal_chain_observation",
            "multi_visit_fact_node",
            "patient_history_anchor"
          ],
          "support": 212
        },
        {
          "action": "connect_multi_visit_evidence",
          "evidence_roles": [
            "causal_chain_observation",
            "multi_visit_fact_node",
            "patient_history_anchor"
          ],
          "support": 191
        },
        {
          "action": "answer_from_verified_evidence",
          "evidence_roles": [
            "causal_chain_observation",
            "missing_mechanism_bridge",
            "multi_visit_fact_node",
            "patient_history_anchor"
          ],
          "support": 155
        },
        {
          "action": "infer_missing_mechanism_bridge",
          "evidence_roles": [
            "missing_mechanism_bridge"
          ],
          "support": 155
        },
        {
          "action": "verify_target_coverage",
          "evidence_roles": [
            "causal_chain_observation",
            "missing_mechanism_bridge",
            "multi_visit_fact_node",
            "patient_history_anchor"
          ],
          "support": 155
        },
        {
          "action": "search_multi_visit_evidence",
          "evidence_roles": [
            "patient_history_anchor"
          ],
          "support": 55
        },
        {
          "action": "answer_from_verified_evidence",
          "evidence_roles": [
            "causal_chain_observation",
            "multi_visit_fact_node",
            "patient_history_anchor"
          ],
          "support": 36
        },
        {
          "action": "verify_target_coverage",
          "evidence_roles": [
            "causal_chain_observation",
            "multi_visit_fact_node",
            "patient_history_anchor"
          ],
          "support": 36
        }
      ],
      "decision_check_priors": []
    },
    "multiple_choice": {
      "case_count": 398,
      "mean_target_count": 4.4221,
      "mean_source_session_count": 2.5729,
      "mean_oracle_step_count": 4.1131,
      "reachability_rates": {
        "paraphrase_candidate": 0.883,
        "raw_dialogue_only": 0.0909,
        "unreachable": 0.0239,
        "direct_state_candidate": 0.0023
      },
      "recommended_action_paths": [
        {
          "actions": [
            "search_option_constraint_evidence",
            "compare_option_constraints",
            "verify_target_coverage",
            "answer_from_verified_evidence"
          ],
          "support": 353
        },
        {
          "actions": [
            "search_option_constraint_evidence",
            "compare_option_constraints",
            "assess_unreachable_evidence_gap",
            "verify_target_coverage",
            "answer_from_verified_evidence"
          ],
          "support": 34
        },
        {
          "actions": [
            "search_option_constraint_evidence",
            "search_option_constraint_evidence",
            "compare_option_constraints",
            "verify_target_coverage",
            "answer_from_verified_evidence"
          ],
          "support": 11
        }
      ],
      "recommended_evidence_role_patterns": [
        {
          "evidence_roles": [
            "option_constraint_evidence",
            "option_discriminator"
          ],
          "support": 398
        }
      ],
      "action_evidence_role_patterns": [
        {
          "action": "answer_from_verified_evidence",
          "evidence_roles": [
            "option_constraint_evidence",
            "option_discriminator"
          ],
          "support": 398
        },
        {
          "action": "search_option_constraint_evidence",
          "evidence_roles": [
            "option_constraint_evidence",
            "option_discriminator"
          ],
          "support": 398
        },
        {
          "action": "verify_target_coverage",
          "evidence_roles": [
            "option_constraint_evidence",
            "option_discriminator"
          ],
          "support": 398
        },
        {
          "action": "compare_option_constraints",
          "evidence_roles": [
            "option_constraint_evidence",
            "option_discriminator"
          ],
          "support": 397
        },
        {
          "action": "assess_unreachable_evidence_gap",
          "evidence_roles": [
            "option_discriminator"
          ],
          "support": 20
        },
        {
          "action": "search_option_constraint_evidence",
          "evidence_roles": [
            "option_discriminator"
          ],
          "support": 9
        },
        {
          "action": "assess_unreachable_evidence_gap",
          "evidence_roles": [
            "option_constraint_evidence"
          ],
          "support": 7
        },
        {
          "action": "assess_unreachable_evidence_gap",
          "evidence_roles": [
            "option_constraint_evidence",
            "option_discriminator"
          ],
          "support": 7
        }
      ],
      "decision_check_priors": [
        {
          "category": "longitudinal_update",
          "support": 139
        },
        {
          "category": "allergy",
          "support": 74
        },
        {
          "category": "contraindication",
          "support": 67
        },
        {
          "category": "preference",
          "support": 62
        },
        {
          "category": "interaction",
          "support": 56
        },
        {
          "category": "lifestyle",
          "support": 1
        }
      ]
    },
    "state_update": {
      "case_count": 195,
      "mean_target_count": 6.8872,
      "mean_source_session_count": 5.9744,
      "mean_oracle_step_count": 4.7641,
      "reachability_rates": {
        "paraphrase_candidate": 0.994,
        "raw_dialogue_only": 0.006
      },
      "recommended_action_paths": [
        {
          "actions": [
            "trace_longitudinal_evidence",
            "trace_longitudinal_evidence",
            "trace_longitudinal_relations",
            "verify_target_coverage",
            "answer_from_verified_evidence"
          ],
          "support": 149
        },
        {
          "actions": [
            "trace_longitudinal_evidence",
            "trace_longitudinal_relations",
            "verify_target_coverage",
            "answer_from_verified_evidence"
          ],
          "support": 46
        }
      ],
      "recommended_evidence_role_patterns": [
        {
          "evidence_roles": [
            "longitudinal_state_observation"
          ],
          "support": 195
        }
      ],
      "action_evidence_role_patterns": [
        {
          "action": "trace_longitudinal_evidence",
          "evidence_roles": [
            "longitudinal_state_observation"
          ],
          "support": 344
        },
        {
          "action": "answer_from_verified_evidence",
          "evidence_roles": [
            "longitudinal_state_observation"
          ],
          "support": 195
        },
        {
          "action": "trace_longitudinal_relations",
          "evidence_roles": [
            "longitudinal_state_observation"
          ],
          "support": 195
        },
        {
          "action": "verify_target_coverage",
          "evidence_roles": [
            "longitudinal_state_observation"
          ],
          "support": 195
        }
      ],
      "decision_check_priors": []
    },
    "temporal_localization": {
      "case_count": 374,
      "mean_target_count": 1,
      "mean_source_session_count": 1,
      "mean_oracle_step_count": 3,
      "reachability_rates": {
        "paraphrase_candidate": 0.9973,
        "raw_dialogue_only": 0.0027
      },
      "recommended_action_paths": [
        {
          "actions": [
            "search_temporal_evidence",
            "verify_target_coverage",
            "answer_from_verified_evidence"
          ],
          "support": 374
        }
      ],
      "recommended_evidence_role_patterns": [
        {
          "evidence_roles": [
            "temporal_event_anchor"
          ],
          "support": 374
        }
      ],
      "action_evidence_role_patterns": [
        {
          "action": "answer_from_verified_evidence",
          "evidence_roles": [
            "temporal_event_anchor"
          ],
          "support": 374
        },
        {
          "action": "search_temporal_evidence",
          "evidence_roles": [
            "temporal_event_anchor"
          ],
          "support": 374
        },
        {
          "action": "verify_target_coverage",
          "evidence_roles": [
            "temporal_event_anchor"
          ],
          "support": 374
        }
      ],
      "decision_check_priors": []
    }
  },
  "artifact_hash": "13dfefb5aaca21dbccb909244802e858e743313af6f6b1015877fe04ba6ddbaa"
});

const QUERY_TYPES=Object.freeze(Object.keys(MEDMEMORY_INVESTIGATION_STRATEGIES).sort());
const STUDENT_VERSION='medmemory-student-strategy-summary.v2-action-role-patterns';
const TEACHER_VERSION='medmemory-oracle-teacher.v2-auditable-trajectories';
const ACTIONS=new Set(['search_entity_evidence','search_temporal_evidence','trace_longitudinal_evidence','search_option_constraint_evidence','search_patient_decision_evidence','search_multi_visit_evidence','trace_longitudinal_relations','compare_option_constraints','connect_patient_decision_evidence','connect_multi_visit_evidence','infer_missing_mechanism_bridge','assess_unreachable_evidence_gap','verify_target_coverage','answer_from_verified_evidence']);
const EVIDENCE_ROLES=new Set(['entity_fact','temporal_event_anchor','longitudinal_state_observation','option_discriminator','option_constraint_evidence','patient_specific_decision_factor','patient_specific_anchor','multi_visit_fact_node','causal_chain_observation','patient_history_anchor','missing_mechanism_bridge']);
const REACHABILITY=new Set(['direct_state_candidate','paraphrase_candidate','raw_dialogue_only','infer_missing_mechanism_bridge','unreachable']);
const DECISION_CHECKS=new Set(['allergy','contraindication','interaction','longitudinal_update','preference','lifestyle','symptom_differential','dose_adjustment','dose_timing','monitoring','access','disease_stage','other_protocol_risk']);
const ROOT_KEYS=new Set(['version','runtime_eligible','source_teacher_version','source_teacher_hash','compiled_strategy_version','compiled_strategy_profile_hash','training_scope','query_types','artifact_hash']);
const SCOPE_KEYS=new Set(['clean_only','persona_count','holdout_persona_count','case_count','teacher_read_question_text','teacher_read_gold_and_judge_metadata','runtime_retains_question_text','runtime_retains_case_ids','runtime_retains_persona_ids','runtime_retains_patient_facts','runtime_retains_gold_or_judge_content']);
const TYPE_KEYS=new Set(['case_count','mean_target_count','mean_source_session_count','mean_oracle_step_count','reachability_rates','recommended_action_paths','recommended_evidence_role_patterns','action_evidence_role_patterns','decision_check_priors']);

export function medMemoryStrategyProfileHash(){
  return sha256(stableJson({version:MEDMEMORY_INVESTIGATION_STRATEGY_VERSION,profiles:MEDMEMORY_INVESTIGATION_STRATEGIES}));
}

export function validateMedMemoryStudentArtifact(value,{require_profile_match=true}={}){
  const artifact=plainObject(value,'student artifact');
  assertExactKeys(artifact,ROOT_KEYS,'student artifact');
  if(artifact.version!==STUDENT_VERSION||artifact.runtime_eligible!==true)throw new Error('Unsupported or runtime-ineligible MedMemory Student artifact');
  if(artifact.source_teacher_version!==TEACHER_VERSION||!hashLike(artifact.source_teacher_hash))throw new Error('MedMemory Student artifact has invalid Teacher provenance');
  if(artifact.compiled_strategy_version!==MEDMEMORY_INVESTIGATION_STRATEGY_VERSION)throw new Error('MedMemory Student artifact strategy version does not match runtime');
  if(!hashLike(artifact.compiled_strategy_profile_hash))throw new Error('MedMemory Student artifact lacks a strategy profile hash');
  if(require_profile_match&&artifact.compiled_strategy_profile_hash!==medMemoryStrategyProfileHash())throw new Error('MedMemory Student artifact strategy profiles do not match runtime');
  const scope=plainObject(artifact.training_scope,'training_scope');assertExactKeys(scope,SCOPE_KEYS,'training_scope');
  if(scope.clean_only!==true||!positive(scope.persona_count)||!nonnegative(scope.holdout_persona_count)||!positive(scope.case_count)||scope.teacher_read_question_text!==true||scope.teacher_read_gold_and_judge_metadata!==true||scope.runtime_retains_question_text!==false||scope.runtime_retains_case_ids!==false||scope.runtime_retains_persona_ids!==false||scope.runtime_retains_patient_facts!==false||scope.runtime_retains_gold_or_judge_content!==false)throw new Error('MedMemory Student artifact has an unsafe or incomplete training boundary');
  const types=plainObject(artifact.query_types,'query_types');if(stableJson(Object.keys(types).sort())!==stableJson(QUERY_TYPES))throw new Error('MedMemory Student artifact must contain exactly the six public query types');
  for(const type of QUERY_TYPES)validateTypeSummary(types[type],type);
  const body={...artifact};delete body.artifact_hash;
  if(!hashLike(artifact.artifact_hash)||sha256(stableJson(body))!==artifact.artifact_hash)throw new Error('MedMemory Student artifact hash mismatch');
  return clone(artifact);
}

export function medMemoryStudentPolicyFor(queryType,artifact=MEDMEMORY_BUILTIN_STUDENT_ARTIFACT){
  if(!artifact)return null;
  const student=validateMedMemoryStudentArtifact(artifact),type=String(queryType||''),summary=student.query_types[type];
  if(!summary)return null;
  return clone({version:MEDMEMORY_STUDENT_POLICY_RUNTIME_VERSION,query_type:type,student_artifact_hash:student.artifact_hash,aggregate_prior:summary});
}

export function withMedMemoryStudentPolicy(input,queryType,artifact=MEDMEMORY_BUILTIN_STUDENT_ARTIFACT){
  const prior=medMemoryStudentPolicyFor(queryType,artifact);return prior?{...input,offline_student_prior:prior}:input;
}

export function medMemoryStudentPolicyManifest(artifact=MEDMEMORY_BUILTIN_STUDENT_ARTIFACT){
  const strategyProfiles={version:MEDMEMORY_INVESTIGATION_STRATEGY_VERSION,content_hash:medMemoryStrategyProfileHash(),query_type_count:QUERY_TYPES.length};
  if(!artifact)return{status:'not_loaded',runtime_version:MEDMEMORY_STUDENT_POLICY_RUNTIME_VERSION,strategy_profiles:strategyProfiles,student_artifact:{version:null,artifact_hash:null},source_teacher_artifact:{version:null,artifact_hash:null},runtime_overlap:runtimeOverlap(),components:runtimeComponents()};
  const student=validateMedMemoryStudentArtifact(artifact);
  return{status:'loaded_builtin',runtime_version:MEDMEMORY_STUDENT_POLICY_RUNTIME_VERSION,strategy_profiles:strategyProfiles,student_artifact:{version:student.version,artifact_hash:student.artifact_hash},source_teacher_artifact:{version:student.source_teacher_version,artifact_hash:student.source_teacher_hash},compiled_strategy:{version:student.compiled_strategy_version,profile_hash:student.compiled_strategy_profile_hash},training_scope:{clean_only:student.training_scope.clean_only,persona_count:student.training_scope.persona_count,holdout_persona_count:student.training_scope.holdout_persona_count,case_count:student.training_scope.case_count},runtime_overlap:runtimeOverlap(),components:runtimeComponents()};
}

export function renderMedMemoryStudentPolicyArtifactModule(artifact){
  const student=validateMedMemoryStudentArtifact(artifact);
  return`// Generated by scripts/distill-medmemory-policy.mjs. Do not edit by hand.\n// This aggregate contains no case, question, Gold, Judge, patient, persona, or Session content.\nexport const MEDMEMORY_BUILTIN_STUDENT_ARTIFACT=Object.freeze(${JSON.stringify(student,null,2)});\n`;
}

function validateTypeSummary(value,type){
  const summary=plainObject(value,`query_types.${type}`);assertExactKeys(summary,TYPE_KEYS,`query_types.${type}`);
  for(const key of ['case_count','mean_target_count','mean_source_session_count','mean_oracle_step_count'])if(!nonnegative(summary[key]))throw new Error(`${type}.${key} must be finite and non-negative`);
  const rates=plainObject(summary.reachability_rates,`${type}.reachability_rates`);for(const [key,rate] of Object.entries(rates)){if(!REACHABILITY.has(key)||!unit(rate))throw new Error(`${type} has invalid reachability aggregate`);}
  validatePatterns(summary.recommended_action_paths,['actions'],'action path',item=>item.actions.every(action=>ACTIONS.has(action)));
  validatePatterns(summary.recommended_evidence_role_patterns,['evidence_roles'],'evidence role pattern',item=>item.evidence_roles.every(role=>EVIDENCE_ROLES.has(role)));
  validatePatterns(summary.action_evidence_role_patterns,['action','evidence_roles'],'action/evidence role pattern',item=>ACTIONS.has(item.action)&&item.evidence_roles.every(role=>EVIDENCE_ROLES.has(role)));
  validatePatterns(summary.decision_check_priors,['category'],'decision check prior',item=>DECISION_CHECKS.has(item.category));
}
function validatePatterns(value,fields,label,predicate){if(!Array.isArray(value)||value.length>12)throw new Error(`Invalid ${label} collection`);for(const item of value){const expected=new Set([...fields,'support']),object=plainObject(item,label);assertExactKeys(object,expected,label);if(Object.hasOwn(object,'actions')&&(!Array.isArray(object.actions)||!object.actions.length||object.actions.length>16||object.actions.some(action=>typeof action!=='string')))throw new Error(`Invalid ${label} actions`);if(Object.hasOwn(object,'evidence_roles')&&(!Array.isArray(object.evidence_roles)||object.evidence_roles.length>16||object.evidence_roles.some(role=>typeof role!=='string')))throw new Error(`Invalid ${label} evidence roles`);if(Object.hasOwn(object,'action')&&typeof object.action!=='string')throw new Error(`Invalid ${label} action`);if(Object.hasOwn(object,'category')&&typeof object.category!=='string')throw new Error(`Invalid ${label} category`);if(!positive(object.support)||!predicate(object))throw new Error(`Invalid ${label}`);}}
function runtimeOverlap(){return{public_query_type:true,aggregate_action_frequencies:true,aggregate_evidence_role_frequencies:true,aggregate_decision_check_frequencies:true,question_text:false,case_ids:false,persona_ids:false,patient_facts:false,gold_answers:false,judge_metadata:false,source_sessions:false,oracle_trajectories:false};}
function runtimeComponents(){return{matched_runtime_version:MEDMEMORY_MATCHED_RUNTIME_VERSION,worker_set_version:INVESTIGATION_WORKER_SET_VERSION};}
function assertExactKeys(value,allowed,label){const keys=Object.keys(value);for(const key of keys)if(!allowed.has(key))throw new Error(`${label} contains forbidden field ${key}`);for(const key of allowed)if(!Object.hasOwn(value,key))throw new Error(`${label} lacks required field ${key}`);}
function plainObject(value,label){if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${label} must be an object`);return value;}
function hashLike(value){return/^[a-f0-9]{64}$/u.test(String(value||''));}
function positive(value){return Number.isInteger(Number(value))&&Number(value)>0;}
function nonnegative(value){return Number.isFinite(Number(value))&&Number(value)>=0;}
function unit(value){return Number.isFinite(Number(value))&&Number(value)>=0&&Number(value)<=1;}
function clone(value){return JSON.parse(JSON.stringify(value));}
function deepFreezePolicyObject(value){if(!value||typeof value!=='object'||Object.isFrozen(value))return value;for(const child of Object.values(value))deepFreezePolicyObject(child);return Object.freeze(value);}
