#!/usr/bin/env node
import { existsSync,mkdirSync,readFileSync,renameSync,writeFileSync } from 'node:fs';
import { dirname,join,resolve } from 'node:path';
import {
  MEDLOCOMO_DEFAULT_HOLDOUT_PATIENTS,
  MedLoCoMoHierarchicalTrainer,
  evaluateMedLoCoMoHierarchicalPolicy,
  splitCommitment,
  validateMedLoCoMoHierarchicalPolicy,
  withHierarchicalEvaluation,
} from './lib/medlocomo-hierarchical-policy.mjs';
import { validateMedLoCoMoPatientTeacher,validateMedLoCoMoTeacherManifest } from './lib/medlocomo-teacher.mjs';

const args=parseArgs(process.argv.slice(2)),teacherRoot=resolve(args['teacher-root']||'data/medlocomo-full-distillation'),manifestPath=join(teacherRoot,'manifest.json'),output=resolve(args.output||'data/medlocomo-hierarchical-distillation/policy.json');
if(!existsSync(manifestPath))throw new Error(`MedLoCoMo Teacher manifest not found: ${manifestPath}`);
const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));validateMedLoCoMoTeacherManifest(manifest);
const holdoutIds=csv(args['holdout-patients']||MEDLOCOMO_DEFAULT_HOLDOUT_PATIENTS.join(',')),holdoutSet=new Set(holdoutIds),availableIds=manifest.shards.map(row=>String(row.patient_id)).sort(),unknown=holdoutIds.filter(id=>!availableIds.includes(id));
if(unknown.length)throw new Error(`Unknown holdout Patient(s): ${unknown.join(', ')}`);
if(!holdoutIds.length||holdoutIds.length>=availableIds.length)throw new Error('A patient-disjoint split needs at least one train and one holdout Patient');

const trainer=new MedLoCoMoHierarchicalTrainer({
  minimum_query_patient_support:numberArg(args['minimum-query-patient-support'],2),
  minimum_pair_patient_support:numberArg(args['minimum-pair-patient-support'],2),
  minimum_pair_case_support:numberArg(args['minimum-pair-case-support'],3),
  maximum_expansions_per_query_term:numberArg(args['maximum-expansions-per-query-term'],16),
});
const holdoutArtifacts=[],trainIds=[];
for(const shard of [...manifest.shards].sort((left,right)=>String(left.patient_id).localeCompare(String(right.patient_id)))){
  const patientId=String(shard.patient_id);if(holdoutSet.has(patientId))continue;
  const artifact=JSON.parse(readFileSync(resolve(teacherRoot,String(shard.path||'')),'utf8'));if(artifact.artifact_hash!==shard.artifact_hash||String(artifact.patient_id)!==patientId)throw new Error(`Teacher shard validation failed for Patient ${patientId}`);trainer.observeVocabularyPatient(artifact);
}
trainer.sealVocabulary();
for(const shard of [...manifest.shards].sort((left,right)=>String(left.patient_id).localeCompare(String(right.patient_id)))){
  const patientId=String(shard.patient_id),path=resolve(teacherRoot,String(shard.path||'')),artifact=JSON.parse(readFileSync(path,'utf8'));
  validateMedLoCoMoPatientTeacher(artifact);if(artifact.artifact_hash!==shard.artifact_hash||String(artifact.patient_id)!==patientId)throw new Error(`Teacher shard validation failed for Patient ${patientId}`);
  if(holdoutSet.has(patientId))holdoutArtifacts.push(artifact);else{trainer.observeTrainingPatient(artifact);trainIds.push(patientId);}
}
let model=trainer.finalize({split:{holdout_patient_count:holdoutIds.length,train_set_commitment:splitCommitment(trainIds),holdout_set_commitment:splitCommitment(holdoutIds)}});
const evaluation=evaluateMedLoCoMoHierarchicalPolicy(model,holdoutArtifacts,{turn_limit:numberArg(args['turn-limit'],24),admission_association_weight:decimalArg(args['admission-association-weight'],0.3),turn_association_weight:decimalArg(args['turn-association-weight'],0.1)});model=withHierarchicalEvaluation(model,evaluation);
validateMedLoCoMoHierarchicalPolicy(model);
mkdirSync(dirname(output),{recursive:true});const temporary=`${output}.tmp-${process.pid}`;writeFileSync(temporary,`${JSON.stringify(model,null,2)}\n`);renameSync(temporary,output);
process.stdout.write(`${JSON.stringify({output,version:model.version,model_hash:model.model_hash,report_hash:model.report_hash,train_patient_count:model.split.train_patient_count,train_case_count:model.split.train_case_count,holdout_patient_count:model.split.holdout_patient_count,evaluation_role:'reused_validation_not_final_test',admission_router:{query_terms:model.admission_router.query_term_count,edges:model.admission_router.association_edge_count},turn_ranker:{query_terms:model.turn_ranker.query_term_count,edges:model.turn_ranker.association_edge_count},validation_evaluation:model.validation_evaluation.groups.__all__},null,2)}\n`);

function csv(value){return String(value||'').split(',').map(item=>item.trim()).filter(Boolean);}
function numberArg(value,fallback){if(value==null)return fallback;const number=Number(value);if(!Number.isInteger(number)||number<1)throw new Error(`Expected a positive integer, received ${value}`);return number;}
function decimalArg(value,fallback){if(value==null)return fallback;const number=Number(value);if(!Number.isFinite(number)||number<0)throw new Error(`Expected a non-negative number, received ${value}`);return number;}
function parseArgs(values){const out={};for(let index=0;index<values.length;index++){const value=values[index];if(!value.startsWith('--'))throw new Error(`Unexpected argument ${value}`);const key=value.slice(2),next=values[index+1];if(!next||next.startsWith('--'))throw new Error(`${value} requires a value`);out[key]=values[++index];}return out;}
