import { STATE_FAMILIES } from './schema.js';

export const CAREHARNESS_METHOD_CONTRACT_VERSION='careharness-method-contract.v6';

export const CAREHARNESS_STATE_FAMILIES=Object.freeze({
  BC:'Background and Context',
  PE:'Patient Experience',
  PA:'Patient Adaptation',
  CS:'Clinical State',
  CP:'Care Plan',
  LO:'Longitudinal Outcome'
});

export const CAREHARNESS_RUNTIME_CONTROLS=Object.freeze(['scope','time','relation']);
export const CAREHARNESS_ACTIONS=Object.freeze(['focus','anchor','connect','evaluate','verify','answer']);
export const MATCHED_EVALUATION_MODE='static_careharness';

export const CAREHARNESS_METHOD_CONTRACT=deepFreeze({
  version:CAREHARNESS_METHOD_CONTRACT_VERSION,
  state:{families:CAREHARNESS_STATE_FAMILIES,representation:'single_persistent_versioned_patient_graph',node_types:'BC_PE_PA_CS_CP_LO',factor_domains:['biological','psychological','behavioral','social','care'],edge_families:['temporal','clinical_care']},
  runtime:{controls:CAREHARNESS_RUNTIME_CONTROLS,working_state:'query_conditioned_graph_view_with_verified_query_local_augmentation',relations:'persistent_verified_edges_plus_verified_query_local_structural_relations; candidates_are_excluded_by_verify'},
  policy:{actions:CAREHARNESS_ACTIONS,selective:false,implementation:'universal_type_blind_policy',fixed_six_step_sequence:true,terminal_action:'answer'},
  architecture_claims:{persistent_cross_state_graph:true,strict_causality_claimed:false,learned_runtime_policy:false},
  provenance:{runtime_gold_or_judge_metadata_allowed:false,offline_post_answer_diagnosis_allowed:true}
});

export function validateCareHarnessMethodContract(contract=CAREHARNESS_METHOD_CONTRACT){
  const errors=[];
  if(JSON.stringify(Object.keys(contract?.state?.families||{}))!==JSON.stringify(STATE_FAMILIES))errors.push('State families must be exactly BC / PE / PA / CS / CP / LO');
  if(JSON.stringify(contract?.runtime?.controls)!==JSON.stringify(CAREHARNESS_RUNTIME_CONTROLS))errors.push('runtime controls must be exactly scope / time / relation');
  if(JSON.stringify(contract?.policy?.actions)!==JSON.stringify(CAREHARNESS_ACTIONS))errors.push('actions must be exactly focus / anchor / connect / evaluate / verify / answer');
  if(contract?.policy?.selective!==false||contract?.policy?.fixed_six_step_sequence!==true)errors.push('the actions must be one type-blind six-step sequence');
  if(contract?.architecture_claims?.persistent_cross_state_graph!==true)errors.push('the contract requires a persistent cross-state Patient Graph');
  if(contract?.architecture_claims?.strict_causality_claimed!==false)errors.push('the graph must not claim strict causality');
  if(contract?.architecture_claims?.learned_runtime_policy!==false||contract?.policy?.implementation!=='universal_type_blind_policy')errors.push('the current runtime policy must be described as universal and type-blind, not learned or task-configured');
  if(contract?.provenance?.runtime_gold_or_judge_metadata_allowed!==false)errors.push('Gold/Judge metadata must never enter runtime inputs');
  if(errors.length)throw new Error(`CareHarness method contract violation: ${errors.join('; ')}`);
  return contract;
}

function deepFreeze(value){
  if(!value||typeof value!=='object'||Object.isFrozen(value))return value;
  for(const child of Object.values(value))deepFreeze(child);
  return Object.freeze(value);
}
