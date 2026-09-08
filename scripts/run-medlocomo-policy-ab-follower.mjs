import { mkdirSync,renameSync,writeFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';

const firstExperimentId=String(process.argv[2]||'').trim();
if(!firstExperimentId)throw new Error('Usage: node scripts/run-medlocomo-policy-ab-follower.mjs <distilled-experiment-id> [status-output]');

const apiBase=String(process.env.CAREHARNESS_API_BASE||'http://127.0.0.1:8766').replace(/\/$/u,''),statusPath=resolve(process.argv[3]||'reports/medlocomo-policy-ab-11826927.json'),pollMs=Math.max(5000,Number(process.env.CAREHARNESS_AB_POLL_MS||20000));
const model={provider:'dashscope',base_url:'https://dashscope.aliyuncs.com/compatible-mode/v1',model:'qwen3.5-27b',api_key_ref:'CAREHARNESS_MATCHED_API_KEY',temperature:0,max_tokens:8192,timeout_ms:300000,retries:1,capabilities:['json'],context_length:262144};
const state={version:'medlocomo-policy-ab.v2-isolated',patient_id:'11826927',first:{policy_mode:'distilled_typed',experiment_id:firstExperimentId,status:'running'},second:{policy_mode:'dynamic',experiment_id:null,status:'pending'},updated_at:new Date().toISOString()};

while(!terminal(state.second.status)){
  try{
    const first=await getExperiment(firstExperimentId);state.first.status=first.status;state.first.progress=compactProgress(first.progress);state.first.metrics=first.progress?.retrieval_metrics||null;
    if(terminal(first.status)&&!state.second.experiment_id){
      const completeness=first.progress?.memory_build_completeness;
      if(completeness?.memory_incomplete===true)throw new Error('distilled arm ended without a complete reusable Memory Graph');
      const second=await request('/api/benchmarks/medlocomo/start',{method:'POST',body:{patient_id:'11826927',mode:'all',medlocomo_policy_mode:'dynamic',score_only_current_memory:true,query_concurrency:8,candidate_budget:24,investigation_budget:6,model}});
      state.second.experiment_id=second.id;state.second.status=second.status;state.second.progress=compactProgress(second.progress);state.second.started_at=new Date().toISOString();
    }
    if(state.second.experiment_id){const second=await getExperiment(state.second.experiment_id);state.second.status=second.status;state.second.progress=compactProgress(second.progress);state.second.metrics=second.progress?.retrieval_metrics||null;}
    delete state.last_error;
  }catch(error){state.last_error={message:String(error?.message||error),at:new Date().toISOString()};}
  state.updated_at=new Date().toISOString();atomicWrite(statusPath,`${JSON.stringify(state,null,2)}\n`);
  if(!terminal(state.second.status))await wait(pollMs);
}

function getExperiment(id){return request(`/api/experiments/${encodeURIComponent(id)}/summary`);}
async function request(path,{method='GET',body=null}={}){
  const response=await fetch(`${apiBase}${path}`,{method,headers:body?{'content-type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
  const payload=await response.json();if(!response.ok)throw new Error(payload?.error||`HTTP ${response.status}`);return payload;
}
function compactProgress(progress={}){return{phase:progress.phase||null,completed:Number(progress.completed||0),total:Number(progress.total||0),failed:Number(progress.failed||0),scored:Number(progress.scored||0),scoring_total:Number(progress.scoring_total||0),query_failed:Number(progress.query_failed||0),eta_seconds:progress.eta_seconds??null};}
function terminal(status){return['completed','partial','failed','cancelled'].includes(String(status||''));}
function wait(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
function atomicWrite(path,contents){mkdirSync(dirname(path),{recursive:true});const temporary=`${path}.tmp`;writeFileSync(temporary,contents);renameSync(temporary,path);}
