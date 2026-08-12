import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export class BenchmarkAdapter {
  constructor(root) { this.root=root; }
  json(path) { return JSON.parse(readFileSync(path,'utf8')); }
  text(path) { return readFileSync(path,'utf8'); }
  list(path, filter=()=>true) { return existsSync(path)?readdirSync(path,{withFileTypes:true}).filter(filter):[]; }
  assertCoreObservation(o) {
    const forbidden=['query','question','gold','answer','answers','answer_options','judge_score','knowledge_points','summary','client_info_last'];
    const serialized=JSON.stringify(o.metadata||{}).toLowerCase();
    for(const key of forbidden) if(serialized.includes(`"${key}"`)) throw new Error(`Benchmark leakage: ${key} entered core observation metadata`);
    return o;
  }
  compatibleScore(output,gold) {
    const norm=x=>String(x||'').toLowerCase().replace(/[\s\p{P}]/gu,''); const g=norm(gold),o=norm(output);
    const score=g&&o&&(o.includes(g)||g.includes(o))?1:0;
    return {score,is_correct:score===1,method:'compatible_normalized_containment',reason:score?'Normalized answer overlap.':'No normalized answer overlap; use official evaluator or judge for semantic scoring.'};
  }
}
export const pjoin=join;
