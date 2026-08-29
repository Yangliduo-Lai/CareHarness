import test from 'node:test';
import assert from 'node:assert/strict';
import { partitionRecentSessionContext,RECENT_SESSION_WINDOW } from '../src/recent-session-context.js';
import { compactMedMemorySource } from '../src/prompts.js';

test('the newest three complete visible Sessions bypass ranking and older nodes remain searchable',()=>{
  const observations=Array.from({length:5},(_,index)=>({episode_id:`session-${index+1}`,event_time:`2025-01-0${index+1}`,raw_text:`[Turn=1][Role=Patient]\n完整消息 ${index+1}`})),memory_nodes=Array.from({length:5},(_,index)=>({memory_id:`m${index+1}`,episode_id:`session-${index+1}`,text:`事实 ${index+1}`})),memory_edges=[{edge_id:'old',from_memory_id:'m1',to_memory_id:'m2',support_memory_ids:['m1','m2']},{edge_id:'cross',from_memory_id:'m2',to_memory_id:'m3',support_memory_ids:['m2','m3']}];
  const output=partitionRecentSessionContext({visible_episode_ids:observations.map(item=>item.episode_id),observations,memory_nodes,memory_edges});
  assert.equal(RECENT_SESSION_WINDOW,3);
  assert.deepEqual(output.recent_sessions.map(item=>item.episode_id),['session-3','session-4','session-5']);
  assert.deepEqual(output.historical_memory_nodes.map(item=>item.memory_id),['m1','m2']);
  assert.deepEqual(output.historical_memory_edges.map(item=>item.edge_id),['old']);
  assert.match(output.recent_sessions[0].transcript,/完整消息 3/);
});

test('Answer memory keeps recent transcripts and historical nodes disjoint',()=>{
  const source=compactMedMemorySource({recent_sessions:[{episode_id:'session-3',event_time:'2025-01-03',transcript:'完整近期对话'}],memory_nodes:[{memory_id:'old',episode_id:'session-1',text:'旧事实'},{memory_id:'duplicate',episode_id:'session-3',text:'近期事实的节点副本'}],memory_edges:[]});
  assert.deepEqual(source.recent_sessions.map(item=>item.transcript),['完整近期对话']);
  assert.deepEqual(source.historical_memory_nodes.map(item=>item.memory_id),['old']);
  assert.equal(JSON.stringify(source).includes('近期事实的节点副本'),false);
});

test('Answer exposes only persistent verified source-grounded graph edges',()=>{
  const nodes=[{memory_id:'a',episode_id:'session-1',text:'事实 A'},{memory_id:'b',episode_id:'session-2',text:'事实 B'}],base={from_memory_id:'a',to_memory_id:'b',edge_family:'temporal',relation_type:'updates',status:'verified',verified:true,confidence:1,causal_claim:false},source=compactMedMemorySource({memory_nodes:nodes,memory_edges:[{...base,edge_id:'persistent',persistent:true,support_memory_ids:['a','b']},{...base,edge_id:'query-local',persistent:false,support_memory_ids:['a','b']},{...base,edge_id:'missing-support',persistent:true,support_memory_ids:['a','b','missing']},{...base,edge_id:'no-source-grounding',persistent:true,support_memory_ids:[]}]});
  assert.deepEqual(source.memory_edges.map(item=>item.edge_id),['persistent']);
});
