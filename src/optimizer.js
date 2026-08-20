import { createHash,randomUUID } from 'node:crypto';
import { FAILURE_TAXONOMY } from './failure-attribution.js';

export const OPTIMIZATION_LOOP_VERSION='careharness-inference-optimizer.v2';

export function selectOptimizationTarget(taxonomyReport){
  const candidates=Object.entries(taxonomyReport?.counts||{}).filter(([code,count])=>/^H[1-7]$/.test(code)&&Number(count)>0).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
  if(!candidates.length)return null;
  const[target_code,count]=candidates[0],entry=FAILURE_TAXONOMY[target_code];
  return{target_code,count,component:entry.component,axis:'harness',source_split:'dev'};
}

export function evaluatePatchAcceptance({before,after,action_cost_budget,minimum_dev_gain=0,nondegradation_tolerance=0}){
  for(const[side,metrics]of [['before',before],['after',after]])for(const metric of ['dev_score','ig_score','mcd_score','safety_score','average_action_cost'])if(!Number.isFinite(Number(metrics?.[metric])))throw new Error(`${side}.${metric} is required for patch acceptance`);
  const checks={
    dev_improves:Number(after.dev_score)>Number(before.dev_score)+Number(minimum_dev_gain),
    ig_non_degrading:Number(after.ig_score)>=Number(before.ig_score)-Number(nondegradation_tolerance),
    mcd_non_degrading:Number(after.mcd_score)>=Number(before.mcd_score)-Number(nondegradation_tolerance),
    safety_non_degrading:Number(after.safety_score)>=Number(before.safety_score)-Number(nondegradation_tolerance),
    action_cost_within_budget:Number(after.average_action_cost)<=Number(action_cost_budget)
  };
  const accepted=Object.values(checks).every(Boolean),failed_checks=Object.entries(checks).filter(([,ok])=>!ok).map(([name])=>name);
  return{accepted,decision:accepted?'accepted':'reverted',checks,failed_checks,reason:accepted?'all acceptance gates passed':`failed acceptance gates: ${failed_checks.join(', ')}`};
}

export async function runOptimizationRound({store,manifest,target,patch,measureBefore,applyPatch,runFullTests,runTargetedEval,revertPatch,acceptance={}}){
  validateRoundInput({manifest,target,patch,measureBefore,applyPatch,runFullTests,runTargetedEval,revertPatch});
  const id=randomUUID(),created_at=new Date().toISOString(),base={id,version:OPTIMIZATION_LOOP_VERSION,status:'running',target_code:target.target_code,component:target.component,manifest_hash:manifest.manifest_hash,patch:{...patch,diff_hash:patch.diff?hash(patch.diff):null},created_at,training_performed:false};
  let round=save(store,{...base,events:[{at:created_at,type:'round_started'}]});
  const before=await measureBefore();
  try{
    await applyPatch();
    const full_tests=await runFullTests();
    if(!full_tests?.passed)throw new Error(`full test suite failed${full_tests?.summary?`: ${full_tests.summary}`:''}`);
    const targeted=await runTargetedEval(),after=targeted.metrics,decision=evaluatePatchAcceptance({before,after,...acceptance});
    if(!decision.accepted)await revertPatch();
    round=save(store,{...round,status:decision.accepted?'accepted':'reverted',before,after,full_tests,targeted_eval:{...targeted,metrics:undefined},decision,events:[...round.events,{at:new Date().toISOString(),type:'patch_applied'},{at:new Date().toISOString(),type:'full_tests_passed'},{at:new Date().toISOString(),type:decision.accepted?'patch_accepted':'patch_reverted'}],updated_at:new Date().toISOString()});
    return round;
  }catch(error){
    let revert_error=null;try{await revertPatch();}catch(revertError){revert_error=String(revertError?.message||revertError);}
    round=save(store,{...round,status:'reverted',before,after:null,decision:{accepted:false,decision:'reverted',checks:{full_tests_and_eval_complete:false},failed_checks:['full_tests_and_eval_complete'],reason:String(error?.message||error)},revert_error,events:[...round.events,{at:new Date().toISOString(),type:'patch_reverted_after_error'}],updated_at:new Date().toISOString()});
    return round;
  }
}

function validateRoundInput({manifest,target,patch,...callbacks}){
  if(!manifest?.manifest_hash)throw new Error('optimization round requires a frozen matched manifest');
  if(!/^H[1-7]$/.test(String(target?.target_code||'')))throw new Error('each round must target exactly one H1-H7 failure');
  if(target?.source_split!=='dev'||!Number.isFinite(Number(target?.count))||Number(target.count)<=0)throw new Error('optimization target must be a positive-frequency development failure');
  if(!target?.component||target.component!==FAILURE_TAXONOMY[target.target_code].component)throw new Error('target component must match the selected taxonomy failure');
  if(!patch?.component||patch.component!==target.component)throw new Error('each round may modify only the selected component');
  if(patch.design_split!=='dev')throw new Error('patch design inputs must come from the development split only');
  if(!Array.isArray(patch.components)||patch.components.length!==1||patch.components[0]!==patch.component)throw new Error('each round may modify exactly one component');
  if(!patch?.minimal_reproduction_test)throw new Error('patch must name a minimal reproduction test');
  for(const[name,callback]of Object.entries(callbacks))if(typeof callback!=='function')throw new Error(`${name} callback is required`);
}
function save(store,round){return store?.saveOptimizationRound?store.saveOptimizationRound(round):round;}
function hash(value){return createHash('sha256').update(String(value)).digest('hex');}
