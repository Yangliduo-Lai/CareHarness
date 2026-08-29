import { createInvestigationState,policyView,validateInvestigationDecision } from './investigation-contract.js';

/**
 * Domain-neutral closed-loop orchestrator. It knows neither Memory family semantics nor
 * retrieval terms, dates, graph slots, relations, or benchmark task types.
 * Policy chooses a worker from the registry; the worker alone interprets its
 * opaque instruction and returns the next information snapshot.
 */
export async function runInvestigation({request,initial_snapshot={},policy,workers={},allowed_workers=null,budget=10,fallback_decision=null,decision_validator=null,on_turn=null}={}){
  if(typeof policy!=='function')throw new Error('investigation runtime requires a policy callback');
  if(!Number.isInteger(budget)||budget<1)throw new Error('investigation budget must be a positive integer');
  const registry=new Map(Object.entries(workers).map(([name,worker])=>[name,normalizeWorker(name,worker)]).filter(([,worker])=>worker));
  if(!registry.size)throw new Error('investigation runtime requires at least one worker');
  let state=createInvestigationState({request,snapshot:initial_snapshot,history:[]}),terminated=false;
  for(let turn=1;turn<=budget&&!terminated;turn++){
    const available=typeof allowed_workers==='function'?allowed_workers({state,turn,remaining_budget:budget-turn+1,registered_workers:[...registry.keys()]}):[...registry.keys()],allowedWorkers=[...new Set((available||[]).map(String))].filter(worker=>registry.has(worker));
    if(!allowedWorkers.length)throw new Error('investigation runtime has no allowed worker for the current turn');
    const capabilities=Object.fromEntries(allowedWorkers.map(name=>[name,registry.get(name).capability])),input=policyView(state,{allowed_workers:allowedWorkers,worker_capabilities:capabilities,remaining_budget:budget-turn+1}),validate=value=>typeof decision_validator==='function'?decision_validator(value,input):validateInvestigationDecision(value,{allowed_workers:allowedWorkers});let decision,policyTrace=null,fallbackUsed=false,error=null;
    try{const response=await policy(input);decision=validate(response?.value??response);policyTrace=response?.trace||null;}
    catch(cause){if(typeof fallback_decision!=='function')throw cause;decision=validate(await fallback_decision(input,cause));policyTrace=cause?.gatewayTrace||null;fallbackUsed=true;error=String(cause?.message||cause);}
    const result=normalizeWorkerResult(await registry.get(decision.worker).run({request:state.request,state,decision,instruction:decision.instruction,turn,remaining_budget:budget-turn}));
    const record={turn,decision,result,policy_trace:policyTrace,fallback_used:fallbackUsed,error,...(input.learned_action_prior?{learned_action_prior:input.learned_action_prior}:{}),...(input.action_exploration_assignment?{action_exploration_assignment:input.action_exploration_assignment}:{})};
    const history=[...state.history,record];state=createInvestigationState({request:state.request,snapshot:result.snapshot,history});
    if(typeof on_turn==='function')await on_turn({state,record,input});
    terminated=result.terminal===true||decision.worker==='answer';
  }
  return{state,history:state.history,terminated,termination_reason:state.history.at(-1)?.decision.worker==='answer'?'answer_selected':state.history.at(-1)?.result.terminal===true?'worker_terminal':'budget_exhausted'};
}

function normalizeWorker(name,value){
  if(typeof value==='function')return{run:value,capability:{}};
  if(!value||typeof value!=='object'||typeof value.run!=='function')return null;
  const capability=value.capability&&typeof value.capability==='object'?JSON.parse(JSON.stringify(value.capability)):{};
  return{run:value.run,capability};
}

function normalizeWorkerResult(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('investigation worker must return one result object');
  return{snapshot:value.snapshot&&typeof value.snapshot==='object'?value.snapshot:{},summary:String(value.summary||'').normalize('NFKC').trim().slice(0,500),changed:value.changed!==false,terminal:value.terminal===true,trace:value.trace||null};
}
