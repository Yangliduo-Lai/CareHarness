import test from 'node:test';
import assert from 'node:assert/strict';
import { tagMemoryNodes,validateMemoryTags } from '../src/memory-family-tagger.js';

let sequence=0;
const memory=(text,source_type='patient')=>({memory_id:`m-${++sequence}`,observation_id:`o-${sequence}`,subject_id:'p',text,source_type,episode_id:'session-1',turn_id:'1',event_time:null,certainty:1,polarity:'affirmed'});
const families=(text,source='patient')=>{const nodes=[memory(text,source)],tagged=tagMemoryNodes(nodes);validateMemoryTags(tagged,nodes);return tagged[0].families;};

test('one Memory Node may carry several family labels without being copied',()=>{
  const nodes=[memory('患者担心低血糖，并愿意按医生建议每天监测血糖。')],tagged=tagMemoryNodes(nodes);
  assert.equal(tagged.length,1);assert.equal(tagged[0].memory_id,nodes[0].memory_id);
  assert.ok(tagged[0].families.includes('PA'));assert.ok(tagged[0].families.includes('CP'));
});

test('family tags describe meaning rather than provenance',()=>{
  assert.ok(families('医生记录患者长期熬夜已成为固定生活情境。','doctor').includes('BC'));
  assert.ok(families('结构化记录显示患者持续恶心。','structured').includes('PE'));
  assert.ok(families('患者转述医生建议下周复诊。','patient').includes('CP'));
});

test('clinical state, plan and longitudinal outcome remain distinguishable labels',()=>{
  const resultFamilies=families('检查显示 UACR 为 52 mg/g。','structured');
  assert.ok(resultFamilies.includes('CS'));assert.equal(resultFamilies.includes('CP'),false);
  assert.ok(families('医生建议继续监测空腹和餐后两小时血糖。','doctor').includes('CP'));
  assert.ok(families('患者服药后口渴明显改善。','patient').includes('LO'));
});

test('every durable Memory Node receives at least one valid family label',()=>{
  for(const [text,source] of [['患者最近夜间口渴并且多尿。','patient'],['医生，我应该怎样改善健康？','patient'],['糖尿病是一种慢性代谢性疾病。','structured']]){
    const value=families(text,source);assert.ok(value.length>0);for(const family of value)assert.ok(['BC','PE','PA','CS','CP','LO'].includes(family));
  }
});
