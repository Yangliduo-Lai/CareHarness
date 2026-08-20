import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { ModelRegistry } from '../src/model-registry.js';
import { DebugRuns } from '../src/debug-runs.js';

const observation={subject_id:'debug-patient',source_type:'patient',episode_id:'session-1',turn_id:'1',event_time:'2026-08-12',raw_text:'我按时吃药了，有时候会恶心。我希望下周复诊时问清楚。'};

test('breakpoint debug advances exactly one step and then continues without replay', async () => {
  const store=new Store(':memory:'),registry=new ModelRegistry(store),debug=new DebugRuns(store,registry);
  const first=await debug.start(observation,{seed:42});
  assert.equal(first.status,'paused');
  assert.equal(first.traces.length,1);
  assert.equal(first.traces[0].component,'observation_ingest');
  const second=await debug.advance(first.id,'step');
  assert.equal(second.status,'paused');
  assert.equal(second.traces.length,2);
  assert.deepEqual(second.traces.map(x=>x.ordinal),[0,1]);
  const done=await debug.advance(first.id,'continue');
  assert.equal(done.status,'completed');
  assert.equal(done.traces.length,9);
  assert.equal(new Set(done.traces.map(x=>x.ordinal)).size,9);
  assert.equal(done.traces.some(x=>x.component.startsWith('gate_')),false);
  assert.ok(done.traces.some(x=>x.component==='action_policy'));
  assert.equal(store.statesFor('debug-patient').length>0,true);
  store.close();
});

test('phase 2 breakpoint commits Patient before policy and then pauses before Doctor write-back', async () => {
  const store=new Store(':memory:'),registry=new ModelRegistry(store),debug=new DebugRuns(store,registry);
  let view=await debug.startConversation({...observation,subject_id:'conversation-debug'},{seed:42});
  const sessionId=view.debug.session_id;
  assert.equal(view.debug.current_stage,'patient');
  assert.equal(view.debug.patient_memory_written,false);

  for(let i=0;i<4;i++)view=await debug.advance(sessionId,'step');
  assert.equal(view.status,'paused');
  assert.equal(view.traces.at(-1).component,'patient_memory_commit');
  assert.equal(view.debug.patient_memory_written,true);
  assert.equal(view.debug.doctor_memory_written,false);
  assert.ok(store.statesFor('conversation-debug').length>0);
  assert.equal(view.traces.some(x=>x.component==='action_policy'),false);

  for(let i=0;i<4;i++)view=await debug.advance(sessionId,'step');
  assert.equal(view.debug.boundary,true);
  assert.equal(view.debug.current_stage,'doctor');
  assert.equal(view.debug.patient_memory_written,true);
  assert.equal(view.debug.doctor_memory_written,false);
  assert.equal(view.traces.at(-1).component,'conversation_commit');

  view=await debug.advance(sessionId,'step');
  assert.equal(view.debug.current_stage,'doctor');
  assert.equal(view.debug.boundary,false);
  assert.equal(view.traces[0].component,'observation_ingest');
  assert.equal(view.debug.prior_runs.length,1);
  assert.equal(view.debug.prior_runs[0].final.observation.source_type,'patient');

  view=await debug.advance(sessionId,'continue');
  assert.equal(view.status,'completed');
  assert.equal(view.debug.patient_memory_written,true);
  assert.equal(view.debug.doctor_memory_written,true);
  assert.equal(view.debug.run_ids.length,2);
  assert.equal(view.final.observation.source_type,'doctor');
  store.close();
});

test('breakpoint debug persists a failed model step with input, raw output, parse and actionable error', async () => {
  const store=new Store(':memory:'),registry=new ModelRegistry(store);
  const profile=registry.save({name:'No key',config:{provider:'openai-compatible',base_url:'https://provider.invalid/v1',model:'qwen'}});
  registry.assign({global:profile.id});
  const debug=new DebugRuns(store,registry),first=await debug.start({...observation,subject_id:'debug-failure'});
  const failed=await debug.advance(first.id,'continue');
  assert.equal(failed.status,'failed');
  const trace=failed.traces.at(-1);
  assert.equal(trace.component,'atomic_evidence_extractor');
  assert.equal(trace.status,'failed');
  assert.equal(trace.input,observation.raw_text);
  assert.equal(trace.gateway.model_input,observation.raw_text);
  assert.equal(trace.output,null);
  assert.ok(trace.gateway.raw_model_attempts.length>=1);
  assert.match(trace.error.suggestion,/raw model response/i);
  store.close();
});

test('phase 1 breakpoint groups turns and pauses only between complete Sessions', async () => {
  const store=new Store(':memory:'),registry=new ModelRegistry(store),debug=new DebugRuns(store,registry);
  const observations=[
    {...observation,subject_id:'memory-debug',source_type:'structured',turn_id:'1',raw_text:'患者对青霉素过敏。'},
    {...observation,subject_id:'memory-debug',source_type:'patient',turn_id:'2'},
    {...observation,subject_id:'memory-debug',source_type:'doctor',turn_id:'3',raw_text:'建议下周复诊。'},
    {...observation,subject_id:'memory-debug',episode_id:'session-2',source_type:'patient',turn_id:'1',raw_text:'我已经停用旧药。'}
  ];
  let view=await debug.startMemory(observations,{seed:42});
  const sessionId=view.debug.session_id;
  assert.equal(view.status,'paused');
  assert.equal(view.phase,'memory_build');
  assert.equal(view.traces.length,1);
  assert.equal(view.traces[0].input.observation_id,undefined);
  assert.equal(view.traces[0].description.length>0,true);
  assert.equal(typeof view.traces[0].diff.input_bytes,'number');
  assert.equal(view.debug.current_index,0);
  assert.equal(view.debug.total_observations,2);
  assert.equal(view.debug.source_observations,4);
  assert.equal(view.debug.completed_observations,0);
  assert.equal(view.debug.current_observation.source_type,'structured');
  assert.match(view.debug.current_observation.raw_text,/\[Role=Patient\]/);
  assert.match(view.debug.current_observation.raw_text,/\[Role=Doctor\]/);

  for(let i=0;i<4;i++)view=await debug.advance(sessionId,'step');
  assert.equal(view.status,'paused');
  assert.equal(view.debug.boundary,true);
  assert.equal(view.debug.current_index,1);
  assert.equal(view.debug.completed_observations,1);
  assert.equal(view.traces.length,5);
  assert.equal(view.traces.at(-1).component,'memory_commit');
  assert.equal(view.debug.runs.length,1);
  assert.equal(store.statesFor('memory-debug').length>0,true);

  view=await debug.advance(sessionId,'step');
  assert.equal(view.status,'paused');
  assert.equal(view.debug.boundary,false);
  assert.equal(view.debug.current_index,1);
  assert.equal(view.debug.completed_observations,1);
  assert.equal(view.traces.length,1);
  assert.equal(view.traces[0].component,'observation_ingest');
  assert.equal(view.debug.runs.length,2);
  assert.notEqual(view.id,sessionId);

  view=await debug.advance(sessionId,'continue');
  assert.equal(view.status,'completed');
  assert.equal(view.debug.completed_observations,2);
  assert.equal(view.debug.run_ids.length,2);
  assert.equal(view.traces.length,5);
  assert.equal(view.traces.some(x=>x.component==='action_policy'),false);
  assert.equal(view.traces.some(x=>x.component.startsWith('gate_')),false);
  store.close();
});
