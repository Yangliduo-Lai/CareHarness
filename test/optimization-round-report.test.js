import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync,readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { adapters } from '../src/adapters/index.js';
import { attributeFailure } from '../src/failure-attribution.js';
import { buildMatchedRuntimeContext } from '../src/matched-experiment.js';

const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..'),reportPath=resolve(projectRoot,'reports/optimization-round-h5-query-relation-evaluator.json'),databasePath=resolve(projectRoot,'data/careharness.sqlite'),benchmarkRoot=resolve(projectRoot,process.env.CAREHARNESS_DATA_ROOT||'data/benchmarks'),medMemoryFixture=resolve(benchmarkRoot,'MedMemoryBench/data/MedMemoryBench/persona_1/eval/generated_dialogues.json'),report=existsSync(reportPath)?JSON.parse(readFileSync(reportPath,'utf8')):null;
const stableJson=value=>Array.isArray(value)?`[${value.map(stableJson).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`:JSON.stringify(value);

test('H5 offline report has an internally consistent non-acceptance boundary',{skip:report?false:'the optional optimization report artifact is not present'},()=>{
  assert.equal(report.status,'offline_structural_replay_complete_live_eval_blocked');
  assert.equal(report.replay_protocol.model_calls,0);assert.equal(report.replay_protocol.semantic_evaluator_calls,0);assert.equal(report.replay_protocol.runtime_mutated,false);
  assert.equal(report.replay_protocol.scores_recomputed,false);assert.equal(report.replay_protocol.gold_or_judge_metadata_in_runtime_replay,false);
  assert.equal(report.h5_cohort.diagnosed_failures,22);assert.equal(report.h5_cohort.primary.count,4);assert.equal(report.h5_cohort.confounded.count,18);
  const primary=report.h5_cohort.primary.records.map(item=>item.score_id),confounded=report.h5_cohort.confounded.records.map(item=>item.score_id),all=[...primary,...confounded];
  assert.equal(new Set(primary).size,4);assert.equal(new Set(confounded).size,18);assert.equal(new Set(all).size,22);
  assert.equal(report.legacy_complex_proof_structural_false_positives.count,3);
  assert.equal(report.credential_blocker.status,'blocked_credentials_missing_on_candidate_process');assert.equal(report.credential_blocker.live_rerun_attempted,false);assert.match(report.credential_blocker.candidate_server_observation,/updated v4\/v2 server/);assert.match(report.credential_blocker.reason,/must now be re-entered/);
  assert.equal(report.candidate_manifest.status,'frozen_not_executed');assert.equal(report.validation.live_after_queries,0);assert.equal(report.validation.live_after_score,null);assert.equal(report.validation.score_delta,null);
  assert.equal(report.optimization_decision.patch_accepted,false);assert.equal(report.optimization_decision.score_improvement_claimed,false);assert.equal(report.optimization_decision.decision,'not_evaluated_live');assert.equal(report.optimization_decision.training_started,false);
});

test('H5 report replays the frozen formal run without a model call and reproduces 4 primary versus 18 confounded cases',{skip:report&&existsSync(databasePath)&&existsSync(medMemoryFixture)?false:'the optional local SQLite or MedMemoryBench artifact is not present'},()=>{
  const db=new DatabaseSync(databasePath,{readOnly:true}),originalFetch=globalThis.fetch;let networkCalls=0;globalThis.fetch=()=>{networkCalls++;throw new Error('offline structural replay must not call fetch')};
  try{
    const row=db.prepare('SELECT * FROM experiments WHERE id=?').get(report.source_run.experiment_id);assert.ok(row);const config=JSON.parse(row.config_json),scores=JSON.parse(row.results_json).filter(item=>item.kind==='score');
    assert.equal(row.status,'completed');assert.equal(scores.length,97);assert.equal(scores.filter(item=>item.mock).length,0);assert.equal(config.matched_manifest.manifest_hash,report.source_run.manifest_hash);
    assert.equal(report.candidate_manifest.version,'medmemory-matched-experiment.v5');assert.match(report.candidate_manifest.manifest_hash,/^[a-f0-9]{64}$/);assert.ok(report.candidate_manifest.prompt_versions);
    const subject=report.frozen_patient_graph.subject_id,load=table=>db.prepare(`SELECT payload_json FROM ${table} WHERE subject_id=? ORDER BY rowid`).all(subject).map(item=>JSON.parse(item.payload_json)),statesAll=load('patient_graph_nodes'),edgesAll=load('patient_graph_edges'),allEvidence=load('evidence'),referencedIds=new Set([...statesAll,...edgesAll].flatMap(item=>item.evidence_ids||[])),evidenceAll=allEvidence.filter(item=>referencedIds.has(item.evidence_id)),fingerprint=createHash('sha256').update(stableJson({states:statesAll,graph_edges:edgesAll,evidence:evidenceAll})).digest('hex');
    assert.equal(fingerprint,report.frozen_patient_graph.fingerprint_expected);assert.equal(fingerprint,report.frozen_patient_graph.fingerprint_recomputed);assert.equal(statesAll.length,918);assert.equal(edgesAll.length,654);assert.equal(evidenceAll.length,695);
    const adapter=adapters()[row.benchmark],data=adapter.load(config),cases=adapter.cases(data,config),h5=[];
    for(const score of scores){
      if(score.is_correct!==false)continue;const benchmarkCase=cases.find(item=>String(item.score_id)===String(score.score_id)),episodes=new Set(benchmarkCase?.metadata?.visible_episode_ids||[]),visible=items=>items.filter(item=>!episodes.size||episodes.has(item.episode_id)),states=visible(statesAll),evidence=visible(evidenceAll),stateIds=new Set(states.map(item=>String(item.state_id))),evidenceIds=new Set(evidence.map(item=>String(item.evidence_id))),edges=edgesAll.filter(item=>stateIds.has(String(item.from_state_id))&&stateIds.has(String(item.to_state_id))&&(item.evidence_ids||[]).every(id=>evidenceIds.has(String(id)))),attribution=attributeFailure({score,raw_observations:visible(data.observations),all_evidence:evidence,all_states:states,runtime_context:score.retrieval_context});
      if(attribution.code!=='H5')continue;const replay=buildMatchedRuntimeContext({item:{task:score.task,question:score.question},query_plan:score.retrieval_context.query_plan,states,evidence,graph_edges:edges,candidate_budget:config.candidate_budget,action_budget:config.action_budget}),eligible=replay.action_policy.selected_actions.includes('evaluate')&&replay.verification?.safe_to_answer===true&&replay.proof?.complete!==true&&!(replay.proof?.missing_families||[]).length&&replay.states.length>=2;h5.push({score_id:score.score_id,eligible});
    }
    const primary=h5.filter(item=>item.eligible).map(item=>item.score_id).sort(),confounded=h5.filter(item=>!item.eligible).map(item=>item.score_id).sort();assert.equal(h5.length,22);assert.deepEqual(primary,report.h5_cohort.primary.records.map(item=>item.score_id).sort());assert.deepEqual(confounded,report.h5_cohort.confounded.records.map(item=>item.score_id).sort());assert.equal(networkCalls,0);
    const falsePositiveIds=report.legacy_complex_proof_structural_false_positives.records.map(item=>item.score_id).sort(),storedFalsePositives=scores.filter(item=>falsePositiveIds.includes(item.score_id));assert.equal(storedFalsePositives.length,3);for(const item of storedFalsePositives){assert.equal(item.retrieval_context.proof.complete,true);assert.equal(item.is_correct,false);assert.ok(item.retrieval_context.relations.length>0);assert.ok(item.retrieval_context.relations.every(edge=>edge.edge_family==='temporal'&&['updates','resolves'].includes(edge.type)))}
    const profile=db.prepare('SELECT config_json FROM model_profiles WHERE id=(SELECT profile_id FROM model_assignments WHERE component=?)').get('global');assert.ok(profile);const profileConfig=JSON.parse(profile.config_json);assert.notEqual(profileConfig.provider,'mock');assert.equal(profileConfig.api_key_ref,'');
  }finally{globalThis.fetch=originalFetch;db.close()}
});
