#!/usr/bin/env node
import { basename,dirname,join,resolve } from 'node:path';
import { existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,renameSync,rmSync,writeFileSync } from 'node:fs';
import { buildMedLoCoMoTeacherManifest,distillMedLoCoMoPatient,sha256,stableJson,validateMedLoCoMoPatientTeacher,validateMedLoCoMoTeacherManifest } from './lib/medlocomo-teacher.mjs';

const args=parseArgs(process.argv.slice(2)),datasetRoot=resolve(args.root||process.env.CAREHARNESS_MEDLOCOMO_ROOT||join(process.env.CAREHARNESS_DATA_ROOT||'data/benchmarks','MedLoCoMo','MedLoCoMo')),outputRoot=resolve(args.output||'data/medlocomo-full-distillation');
if(!existsSync(datasetRoot))throw new Error(`MedLoCoMo dataset root not found: ${datasetRoot}`);

const availablePatients=patientDirectories(datasetRoot),requested=csv(args.patients),patientLimit=args['patient-count']==null?null:positiveInteger(args['patient-count'],'patient-count'),selected=(requested.length?requested:availablePatients).filter((value,index,list)=>list.indexOf(value)===index).slice(0,patientLimit||undefined);
if(!selected.length)throw new Error('No MedLoCoMo patients selected');for(const patientId of selected)if(!availablePatients.includes(patientId))throw new Error(`Unknown MedLoCoMo patient ${patientId}`);

const parent=dirname(outputRoot);mkdirSync(parent,{recursive:true});const staging=mkdtempSync(join(parent,`.${basename(outputRoot)}.tmp-`)),patientOutput=join(staging,'patients');mkdirSync(patientOutput,{recursive:true});
let backup=null,installed=false;
try{
  const artifacts=new Map(),shards=[],datasetSources=[];
  for(const patientId of selected){
    const patientRoot=join(datasetRoot,patientId),qaPath=join(patientRoot,'benchmark_qa.json'),conversationPath=join(patientRoot,'combined_conversation.json'),qaRaw=readFileSync(qaPath,'utf8'),conversationRaw=readFileSync(conversationPath,'utf8'),fingerprints={benchmark_qa_sha256:sha256(qaRaw),combined_conversation_sha256:sha256(conversationRaw)};
    const artifact=distillMedLoCoMoPatient({patient_id:patientId,qa:JSON.parse(qaRaw),conversation:JSON.parse(conversationRaw),source_fingerprints:fingerprints});validateMedLoCoMoPatientTeacher(artifact);artifacts.set(patientId,artifact);
    const relativePath=`patients/${patientId}.json`;writeJson(join(staging,relativePath),artifact);
    shards.push({patient_id:patientId,path:relativePath,admission_count:artifact.stats.admission_count,source_turn_count:artifact.stats.source_turn_count,case_count:artifact.stats.case_count,question_type_counts:artifact.stats.question_type_counts,scope_counts:artifact.stats.scope_counts,artifact_hash:artifact.artifact_hash});datasetSources.push({patient_id:patientId,...fingerprints});
  }
  const datasetFingerprint=sha256(stableJson(datasetSources.sort((left,right)=>left.patient_id.localeCompare(right.patient_id)))),manifest=buildMedLoCoMoTeacherManifest({dataset_fingerprint:datasetFingerprint,shards,available_patient_count:availablePatients.length});validateMedLoCoMoTeacherManifest(manifest,{patient_artifacts:artifacts});writeJson(join(staging,'manifest.json'),manifest);
  const audit={generated_at:new Date().toISOString(),dataset_root_fingerprint:datasetFingerprint,manifest_artifact_hash:manifest.artifact_hash,patient_count:manifest.selection.patient_count,admission_count:manifest.selection.admission_count,source_turn_count:manifest.selection.source_turn_count,question_count:manifest.selection.question_count,question_type_counts:manifest.selection.question_type_counts,scope_counts:manifest.selection.scope_counts,not_held_out:manifest.selection.not_held_out,validation:manifest.source_validation};writeJson(join(staging,'build-audit.json'),audit);
  if(existsSync(outputRoot)){assertReplaceableOutput(outputRoot);backup=`${outputRoot}.backup-${process.pid}-${Date.now()}`;renameSync(outputRoot,backup);}
  renameSync(staging,outputRoot);installed=true;if(backup){rmSync(backup,{recursive:true,force:true});backup=null;}
  process.stdout.write(`${JSON.stringify({output:outputRoot,manifest:join(outputRoot,'manifest.json'),artifact_hash:manifest.artifact_hash,dataset_fingerprint:datasetFingerprint,...manifest.selection,source_validation:manifest.source_validation},null,2)}\n`);
}catch(error){
  if(!installed&&existsSync(staging))rmSync(staging,{recursive:true,force:true});
  if(backup&&existsSync(backup)&&!existsSync(outputRoot))renameSync(backup,outputRoot);
  throw error;
}

function patientDirectories(root){return readdirSync(root,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&/^\d+$/u.test(entry.name)&&existsSync(join(root,entry.name,'benchmark_qa.json'))&&existsSync(join(root,entry.name,'combined_conversation.json'))).map(entry=>entry.name).sort();}
function assertReplaceableOutput(path){const manifestPath=join(path,'manifest.json');if(!existsSync(manifestPath))throw new Error(`Refusing to replace ${path}: no MedLoCoMo teacher manifest found`);const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));if(manifest?.benchmark!=='medlocomo'||!String(manifest?.version||'').startsWith('medlocomo-full-teacher-manifest.'))throw new Error(`Refusing to replace ${path}: existing directory is not a MedLoCoMo teacher corpus`);}
function writeJson(path,value){const temporary=`${path}.tmp-${process.pid}`;writeFileSync(temporary,`${JSON.stringify(value,null,2)}\n`);renameSync(temporary,path);}
function csv(value){return String(value||'').split(',').map(item=>item.trim()).filter(Boolean);}
function positiveInteger(value,label){const number=Number(value);if(!Number.isInteger(number)||number<1)throw new Error(`${label} must be a positive integer`);return number;}
function parseArgs(values){const out={};for(let index=0;index<values.length;index++){const value=values[index];if(!value.startsWith('--'))throw new Error(`Unexpected argument ${value}`);const key=value.slice(2),next=values[index+1];if(!next||next.startsWith('--'))throw new Error(`${value} requires a value`);out[key]=values[++index];}return out;}
