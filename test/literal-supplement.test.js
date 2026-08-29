import test from 'node:test';
import assert from 'node:assert/strict';
import { LITERAL_SUPPLEMENT_LIMITS,minimalLiteralSupplement } from '../src/literal-supplement.js';

test('literal supplements enforce item, item-length, and total-length bounds',()=>{
  const source='药物 ABC-1 检查；药物 XYZ-2 检查；药物 LMN-3 检查；药物 PQR-4 检查；药物 STU-5 检查；药物 VWX-6 检查。',items=minimalLiteralSupplement({text:'患者完成药物检查。',source_text:source});
  assert.equal(items.length,LITERAL_SUPPLEMENT_LIMITS.max_items);
  assert.ok(items.every(item=>[...item.text].length<=LITERAL_SUPPLEMENT_LIMITS.max_item_chars));
  assert.ok(items.reduce((sum,item)=>sum+[...item.text].length,0)<=LITERAL_SUPPLEMENT_LIMITS.max_total_chars);
  assert.ok(items.every(item=>source.includes(item.text)));assert.ok(items.every(item=>item.text!==source));
});

test('literal supplements stay empty when structured text already contains the protected literals',()=>{
  assert.deepEqual(minimalLiteralSupplement({text:'患者在2024-01-05的血糖为12 mmol/L，且没有口渴。',source_text:'患者在2024年1月5日的血糖为12 mmol/L，且无明显口渴。'}),[]);
});
