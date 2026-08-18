import test from 'node:test';
import assert from 'node:assert/strict';
import { mediLongChatBleu1,mediLongChatTokenF1,scoreMediLongChat } from '../src/medilongchat-metrics.js';
import { cpcdJudgeInput,scoreCpcdJudge,validateCpcdJudgeOutput } from '../src/cpcd-official.js';

test('MediLongChat derived diagnostics expose the paper metric shapes without claiming official comparability',()=>{
  assert.equal(mediLongChatTokenF1('blood glucose 10','blood glucose 10'),1);
  assert.equal(mediLongChatBleu1('blood glucose 10','blood glucose 10'),1);
  const open=scoreMediLongChat('blood glucose 10',{task:'in_dialogue_reasoning',gold:['blood glucose 10']});
  assert.equal(open.score,1);assert.equal(open.details.official_comparable,false);assert.equal(open.details.protocol_status,'public_release_derived');
  const sr=scoreMediLongChat('B',{task:'synthesis_reasoning',gold:['B'],metadata:{correct_option:'B'}});
  assert.equal(sr.score,1);assert.equal(sr.details.accuracy,1);assert.equal(sr.details.official_comparable,false);
});

test('CPCD official validator keeps SR at 1-5 and MR/TCR at 0-5',()=>{
  const srg={score_id:'s',task:'session_level_response_generation'},mr={score_id:'m',task:'memory_recall'};
  assert.throws(()=>validateCpcdJudgeOutput({scores:{empathy:0,coherence:1,professionalism:1}},srg),/1 to 5/);
  const zero=validateCpcdJudgeOutput({scores:{accuracy:0,completeness:0,temporal_consistency:0,no_hallucination:0}},mr);
  assert.equal(zero.overall.average_score,0);
  const scored=scoreCpcdJudge({scores:{empathy:5,coherence:4,professionalism:3}},srg);
  assert.equal(scored.score,.8);assert.equal(scored.is_correct,null);assert.equal(scored.details.scale,'1-5');assert.equal(scored.details.classification_threshold,null);
});

test('CPCD post-answer Judge input follows task-specific reference and history defaults',()=>{
  const item={score_id:'s',task:'session_level_response_generation',question:'respond',gold:['reference'],metadata:{official_input:{current_student_utterance:'help'},evaluation_focus:{empathy:'criterion'},full_consultation_history:null}};
  const input=cpcdJudgeInput('candidate',item);
  assert.equal(input.model_response,'candidate');assert.equal(input.reference_answer,null);assert.equal(input.full_consultation_history,null);assert.deepEqual(input.dimensions,['empathy','coherence','professionalism']);
  const tcr=cpcdJudgeInput('candidate',{score_id:'t',task:'temporal_causal_reasoning',question:'why',gold:['reference'],metadata:{full_consultation_history:[{role:'Student',content:'history'}]}});
  assert.equal(tcr.reference_answer,'reference');assert.equal(tcr.full_consultation_history.length,1);
});
