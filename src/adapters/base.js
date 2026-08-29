import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeSessionObservation } from '../session-observation.js';
import { assertNoHiddenBenchmarkInput } from '../information-boundary.js';

export class BenchmarkAdapter {
  constructor(root) { this.root=root; }
  json(path) { return JSON.parse(readFileSync(path,'utf8')); }
  text(path) { return readFileSync(path,'utf8'); }
  exists(path) { return existsSync(path); }
  list(path, filter=()=>true) { return existsSync(path)?readdirSync(path,{withFileTypes:true}).filter(filter):[]; }
  assertCoreObservation(o) {
    assertNoHiddenBenchmarkInput(o,'core_observation');
    const forbidden=['query','question','gold','answer','answers','answer_options','judge_score','knowledge_points','summary','client_info_last'];
    const serialized=JSON.stringify(o||{}).toLowerCase();
    for(const key of forbidden) if(serialized.includes(`"${key}"`)) throw new Error(`Benchmark leakage: ${key} entered core observation`);
    const allowed=new Set(['observation_id','subject_id','source_type','episode_id','turn_id','event_time','raw_text']);
    const extra=Object.keys(o||{}).filter(key=>!allowed.has(key));
    if(extra.length)throw new Error(`Unsupported core observation fields: ${extra.join(', ')}`);
    return o;
  }
  sessionObservation(turns,options={}) { return this.assertCoreObservation(makeSessionObservation(turns,options)); }
  compatibleScore(output,golds) {
    const norm=x=>String(x||'').toLowerCase().replace(/[\s\p{P}]/gu,''); const candidates=Array.isArray(golds)?golds:[golds],o=norm(output);
    const score=o&&candidates.some(gold=>{const g=norm(gold);return g&&(o.includes(g)||g.includes(o))})?1:0;
    return {score,is_correct:score===1,method:'compatible_normalized_containment',reason:score?'Normalized answer overlap.':'No normalized answer overlap; use official evaluator or judge for semantic scoring.'};
  }
}
export const pjoin=join;
