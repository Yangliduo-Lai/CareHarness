import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPatientProfile,PATIENT_PROFILE_VERSION } from '../src/patient-profile.js';

const node=(memory_id,text,event_time,families,extra={})=>({memory_id,text,event_time,families,source_type:'doctor',status:'active',episode_id:`episode-${memory_id}`,factor_key:memory_id,...extra});

test('Patient Profile is a grounded query-independent historical chart disjoint from recent Sessions',()=>{
  const nodes=[
    node('diagnosis','患者已确诊目标疾病。','2025-01-01',['CS']),
    node('old-treatment','患者服用旧方案。','2025-01-02',['CP'],{factor_key:'treatment'}),
    node('new-treatment','患者目前改用新方案并继续监测。','2025-02-02',['CP'],{factor_key:'treatment'}),
    node('objective','最近检查指标为 8.2%。','2025-02-03',['CS']),
    node('symptom','患者当前出现疲劳症状。','2025-02-04',['PE'],{source_type:'patient'}),
    node('course','治疗后症状逐步改善。','2025-02-05',['LO']),
    node('constraint','患者因工作作息难以执行固定时间方案。','2025-02-06',['BC','PA'],{source_type:'patient'}),
    node('history','较早的其他相关事实。','2024-01-01',['PE']),
    node('recent-excluded','患者最近一次 Session 出现明显乏力症状。','2025-02-07',['PE'],{episode_id:'recent-session',source_type:'patient'}),
  ];
  const historicalIds=nodes.filter(item=>item.episode_id!=='recent-session').map(item=>item.memory_id),result=buildPatientProfile(nodes,{historical_memory_ids:historicalIds}),profile=result.patient_profile,items=profile.sections.flatMap(section=>section.items);
  assert.equal(profile.version,PATIENT_PROFILE_VERSION);assert.equal(profile.query_independent,true);assert.equal(profile.overlaps_recent_sessions,false);
  assert.ok(items.some(item=>item.text.includes('确诊目标疾病')));assert.ok(items.some(item=>item.text.includes('改用新方案')));assert.equal(items.some(item=>item.text.includes('旧方案')),false);
  assert.equal(items.some(item=>item.text.includes('最近一次 Session')),false);assert.equal(result.backing_memory_ids.includes('recent-excluded'),false);
  assert.equal(new Set(result.backing_memory_ids).size,result.backing_memory_ids.length);
  assert.equal(result.remaining_memory_nodes.some(item=>result.backing_memory_ids.includes(item.memory_id)),false);
  assert.equal(result.remaining_memory_nodes.some(item=>item.memory_id==='history'),true);
  assert.equal(result.policy.selection_uses_question,false);assert.equal(result.policy.selection_uses_benchmark_task,false);assert.equal(result.policy.recent_sessions_are_disjoint,true);
  assert.ok(items.every(item=>item.source_ref.startsWith('memory:')));
});

test('Patient Profile construction is deterministic and has no query input',()=>{
  const nodes=[node('a','患者当前接受目标治疗。','2025-01-01',['CP']),node('b','患者当前有疲劳症状。','2025-01-02',['PE'],{source_type:'patient'})];
  assert.deepEqual(buildPatientProfile(nodes),buildPatientProfile(nodes));
  assert.equal(buildPatientProfile.length,0);
});

test('Patient Profile preserves only bounded literal deltas from its backing nodes',()=>{
  const drugSource='患者目前规律服用口服降糖药，但药效持续减弱；下班后曾去公园散步。',unitSource='最近检查空腹血糖为12-13 mmol/L，同时早餐吃了一片面包。',result=buildPatientProfile([
    node('drug','患者目前规律服用口服药，但药效持续减弱。','2025-02-01',['PE','CS'],{source_type:'patient',source_text:drugSource}),
    node('unit','最近检查空腹血糖为12-13。','2025-02-02',['CS'],{source_type:'structured',source_text:unitSource}),
  ]),items=result.patient_profile.sections.flatMap(section=>section.items),drug=items.find(item=>item.source_ref==='memory:drug'),unit=items.find(item=>item.source_ref==='memory:unit'),serialized=JSON.stringify(result.patient_profile);
  assert.deepEqual(drug.literal_supplement,[{kind:'medical_term',text:'口服降糖药'}]);
  assert.deepEqual(unit.literal_supplement,[{kind:'unit',text:'mmol/L'}]);
  assert.equal(serialized.includes(drugSource),false);assert.equal(serialized.includes(unitSource),false);
  assert.equal(serialized.includes('公园散步'),false);assert.equal(serialized.includes('早餐'),false);assert.equal(serialized.includes('source_text'),false);
});
