import { mkdirSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from '../src/db.js';
import { ModelRegistry } from '../src/model-registry.js';
import { ExperimentHarness } from '../src/experiments.js';

const args=parseArgs(process.argv.slice(2));

async function main(){
  const apiKey=(await readStdinLine()).trim();
  if(!apiKey)throw new Error('CloseAI API key was not supplied on stdin');
  const store=new Store(args.database);
  try{
    const models=new ModelRegistry(store),profile=models.state().profiles.find(item=>item.id===args.profile);
    if(!profile)throw new Error(`Missing model profile ${args.profile}`);
    process.env[profile.config.api_key_ref||'CAREHARNESS_RUN_KEY']=apiKey;
    const connection=await models.gatewayForProfile(profile.id).testConnection();
    if(!connection.ok)throw new Error(`CloseAI connection failed for ${profile.config.model}: ${connection.error||connection.models_error||'unknown error'}`);
    progress({phase:'connection',status:'completed',model:profile.config.model,latency_ms:connection.latency_ms});

    const harness=new ExperimentHarness(store,undefined,models),classified=[];
    await runPool(args.personas,args.scope_concurrency,async persona=>{
      progress({phase:'classified_routing',persona,status:'starting'});
      const evaluationMode='diagnostic_query_type_ab_qwen37plus_classified_v1',resumeSource=findResumeSource(store,{persona,evaluationMode});
      const experiment=await harness.start('medmemorybench',{persona_id:persona,noise:false,max_session:100,score_only_current_memory:true,matched_experiment:false,evaluation_mode:evaluationMode,query_type_routing_mode:'classified',resume_incomplete:false,...(resumeSource?{resume_source_experiment_id:resumeSource}:{}),seed:42,candidate_budget:args.candidate_budget,investigation_budget:args.investigation_budget,query_concurrency:args.query_concurrency,embedding_search:true,model:profile.config});
      classified.push(experimentDescriptor(persona,experiment));
      progress({phase:'classified_routing',persona,status:experiment.status,experiment_id:experiment.id,scored:experiment.progress?.scored,total:experiment.progress?.scoring_total,classification_accuracy:experiment.progress?.retrieval_metrics?.query_type_classification_accuracy,average_score:experiment.progress?.retrieval_metrics?.average_score});
    });
    classified.sort((left,right)=>left.persona-right.persona);

    const misclassifiedByPersona=new Map();
    for(const descriptor of classified){
      const {persona}=descriptor,experiment=harness.get(descriptor.experiment_id),rows=scoreRows(experiment).filter(item=>effectiveClassification(item)?.is_correct===false).map(reportScore);
      misclassifiedByPersona.set(persona,rows);
    }
    const misclassifiedCount=[...misclassifiedByPersona.values()].reduce((sum,items)=>sum+items.length,0);
    progress({phase:'classification_complete',status:'completed',misclassified_count:misclassifiedCount});

    const oracle=[];
    await runPool(args.personas.filter(persona=>(misclassifiedByPersona.get(persona)||[]).length),args.scope_concurrency,async persona=>{
      const classifiedRows=misclassifiedByPersona.get(persona),queryIds=classifiedRows.map(item=>String(item.score_id)),overrides=Object.fromEntries(classifiedRows.map(item=>[String(item.score_id),frozenClassification(item.query_classification)]));
      progress({phase:'official_oracle_routing',persona,status:'starting',query_count:queryIds.length});
      const evaluationMode='diagnostic_query_type_ab_qwen37plus_official_oracle_v1',resumeSource=findResumeSource(store,{persona,evaluationMode});
      const experiment=await harness.start('medmemorybench',{persona_id:persona,noise:false,max_session:100,query_ids:queryIds,score_only_current_memory:true,matched_experiment:false,evaluation_mode:evaluationMode,query_type_routing_mode:'official_oracle_diagnostic',query_type_classification_overrides:overrides,resume_incomplete:false,...(resumeSource?{resume_source_experiment_id:resumeSource}:{}),seed:42,candidate_budget:args.candidate_budget,investigation_budget:args.investigation_budget,query_concurrency:args.query_concurrency,embedding_search:true,model:profile.config});
      oracle.push(experimentDescriptor(persona,experiment));
      progress({phase:'official_oracle_routing',persona,status:experiment.status,experiment_id:experiment.id,scored:experiment.progress?.scored,total:experiment.progress?.scoring_total,average_score:experiment.progress?.retrieval_metrics?.average_score});
    });
    oracle.sort((left,right)=>left.persona-right.persona);

    const createdAt=new Date().toISOString(),stamp=createdAt.replace(/[:.]/g,'-'),reportDir=resolve(args.report_dir);mkdirSync(reportDir,{recursive:true});
    const common={report_version:'medmemory-query-routing-ab.v1',created_at:createdAt,benchmark:'MedMemoryBench',personas:args.personas,model:{profile_id:profile.id,provider:profile.config.provider,base_url:profile.config.base_url,model:profile.config.model,temperature:profile.config.temperature,max_tokens:profile.config.max_tokens},memory_graph_policy:'Reuse each Persona current complete Memory Graph read-only; do not rebuild Sessions.',answer_prompt_policy:'Always use the official query type in both arms.',classification_policy:'Classify from question text only. Freeze each mistaken prediction into the oracle arm so retrieval routing is the sole intended A/B variable.'};
    const classifiedExperiments=reportExperiments(harness,classified),oracleExperiments=reportExperiments(harness,oracle);
    const classifiedReport={...common,arm:'classified-routing',summary:summarizeExperiments(classifiedExperiments),experiments:classifiedExperiments};
    const oracleReport={...common,arm:'official-oracle-routing',summary:summarizeExperiments(oracleExperiments),experiments:oracleExperiments};
    const comparison=buildComparison(harness,common,classified,oracle,misclassifiedByPersona);
    const classifiedPath=resolve(reportDir,`medmemory-p1357-qwen37plus-classified-routing-${stamp}.json`),oraclePath=resolve(reportDir,`medmemory-p1357-qwen37plus-official-routing-${stamp}.json`),comparisonPath=resolve(reportDir,`medmemory-p1357-qwen37plus-routing-comparison-${stamp}.json`);
    writeFileSync(classifiedPath,JSON.stringify(classifiedReport,null,2));writeFileSync(oraclePath,JSON.stringify(oracleReport,null,2));writeFileSync(comparisonPath,JSON.stringify(comparison,null,2));
    process.stdout.write(`${JSON.stringify({status:[...classified,...oracle].every(item=>item.status==='completed')?'completed':'partial',model:profile.config.model,classified_summary:classifiedReport.summary,official_oracle_summary:oracleReport.summary,comparison_summary:comparison.summary,classified_path:classifiedPath,official_oracle_path:oraclePath,comparison_path:comparisonPath,classified_experiment_ids:Object.fromEntries(classified.map(item=>[item.persona,item.experiment_id])),official_oracle_experiment_ids:Object.fromEntries(oracle.map(item=>[item.persona,item.experiment_id]))},null,2)}\n`);
  }finally{store.close();}
}

function buildComparison(harness,common,classified,oracle,misclassifiedByPersona){
  const oracleByPersona=new Map(oracle.map(item=>{const experiment=harness.get(item.experiment_id),scores=new Map(scoreRows(experiment).map(score=>{const row=reportScore(score);return[String(row.score_id),row]}));return[item.persona,scores]})),pairs=[];
  for(const {persona} of classified)for(const before of misclassifiedByPersona.get(persona)||[]){const after=oracleByPersona.get(persona)?.get(String(before.score_id))||null;pairs.push({persona,score_id:before.score_id,question:before.question,official_query_type:before.task,predicted_query_type:before.query_classification?.predicted_query_type||null,classified_retrieval_query_type:before.query_classification?.retrieval_query_type||null,official_retrieval_query_type:after?.query_classification?.retrieval_query_type||null,answer_prompt_query_type_before:before.query_classification?.answer_prompt_query_type||null,answer_prompt_query_type_after:after?.query_classification?.answer_prompt_query_type||null,classified:{status:before.status,answer:before.system_output,score:before.score,is_correct:before.is_correct,retrieved_memory_ids:before.retrieved_memory_ids||[]},official_oracle:after?{status:after.status,answer:after.system_output,score:after.score,is_correct:after.is_correct,retrieved_memory_ids:after.retrieved_memory_ids||[]}:null,score_delta:after&&Number.isFinite(after.score)&&Number.isFinite(before.score)?after.score-before.score:null});}
  return{...common,comparison:'Mistaken classified routing vs official-type retrieval routing on the same misclassified questions.',summary:summarizePairs(pairs),pairs};
}

function summarizePairs(pairs){
  const complete=pairs.filter(item=>Number.isFinite(item.classified.score)&&Number.isFinite(item.official_oracle?.score)),mean=values=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null,byType={};
  for(const pair of complete){const group=byType[pair.official_query_type]||={count:0,classified_scores:[],oracle_scores:[],deltas:[],classified_correct:0,oracle_correct:0};group.count++;group.classified_scores.push(pair.classified.score);group.oracle_scores.push(pair.official_oracle.score);group.deltas.push(pair.score_delta);group.classified_correct+=pair.classified.is_correct===true?1:0;group.oracle_correct+=pair.official_oracle.is_correct===true?1:0;}
  return{misclassified_query_count:pairs.length,paired_scored_count:complete.length,classified_average_score:mean(complete.map(item=>item.classified.score)),official_oracle_average_score:mean(complete.map(item=>item.official_oracle.score)),average_score_delta:mean(complete.map(item=>item.score_delta)),classified_correct:complete.filter(item=>item.classified.is_correct===true).length,official_oracle_correct:complete.filter(item=>item.official_oracle.is_correct===true).length,by_official_query_type:Object.fromEntries(Object.entries(byType).map(([type,group])=>[type,{count:group.count,classified_average_score:mean(group.classified_scores),official_oracle_average_score:mean(group.oracle_scores),average_score_delta:mean(group.deltas),classified_correct:group.classified_correct,official_oracle_correct:group.oracle_correct}]))};
}

function summarizeExperiments(items){const metrics=items.map(item=>item.metrics||{}),queryCount=metrics.reduce((sum,item)=>sum+Number(item.query_count||0),0),scoredCount=metrics.reduce((sum,item)=>sum+Number(item.scored_query_count||0),0),classificationCount=metrics.reduce((sum,item)=>sum+Number(item.query_type_classification_count||0),0),classificationCorrect=metrics.reduce((sum,item)=>sum+Math.round(Number(item.query_type_classification_accuracy||0)*Number(item.query_type_classification_count||0)),0),weightedScore=metrics.reduce((sum,item)=>sum+Number(item.average_score||0)*Number(item.scored_query_count||0),0),weightedAccuracy=metrics.reduce((sum,item)=>sum+Number(item.accuracy||0)*Number(item.classified_query_count||0),0),classifiedCount=metrics.reduce((sum,item)=>sum+Number(item.classified_query_count||0),0);return{persona_count:items.length,query_count:queryCount,scored_count:scoredCount,failed_count:metrics.reduce((sum,item)=>sum+Number(item.failed_query_count||0),0),average_score:scoredCount?weightedScore/scoredCount:null,accuracy:classifiedCount?weightedAccuracy/classifiedCount:null,classification_count:classificationCount,classification_correct:classificationCorrect,classification_accuracy:classificationCount?classificationCorrect/classificationCount:null,misclassified_count:classificationCount-classificationCorrect};}
function reportExperiments(harness,items){return items.map(item=>{const experiment=harness.get(item.experiment_id),scores=scoreRows(experiment).map(reportScore);return{persona:item.persona,experiment_id:item.experiment_id,status:item.status,metrics:repairClassificationMetrics(item.metrics,scores),scores}});}
function repairClassificationMetrics(metrics,scores){const rows=scores.map(item=>item.query_classification).filter(Boolean),confusion={};for(const item of rows){const key=`${item.official_query_type}->${item.predicted_query_type}`;confusion[key]=(confusion[key]||0)+1;}const correct=rows.filter(item=>item.is_correct===true).length;return{...(metrics||{}),query_type_classification_count:rows.length,query_type_classification_accuracy:rows.length?correct/rows.length:null,query_type_classification_confusion:confusion};}
function reportScore(item){return{score_id:item.score_id,task:item.task,status:item.status,question:item.question,system_output:item.system_output,gold:item.gold,score:item.score,is_correct:item.is_correct,scoring_method:item.scoring_method,scoring_reason:item.scoring_reason,scoring_details:item.scoring_details,query_classification:compactClassification(effectiveClassification(item)),query_session:item.query_session,retrieved_memory_ids:item.memory_trace?.memory_ids||[],action_sequence:compactActionSequence(item.retrieval_context?.investigation_trace||[])};}
function compactClassification(value){if(!value)return null;return{version:value.version||null,predicted_query_type:value.predicted_query_type||value.query_type||null,retrieval_query_type:value.retrieval_query_type||null,official_query_type:value.official_query_type||null,answer_prompt_query_type:value.answer_prompt_query_type||null,is_correct:value.is_correct===true,confidence:value.confidence??null,rationale:value.rationale||null,method:value.method||null,routing_mode:value.routing_mode||null};}
function frozenClassification(value={}){return{query_type:String(value.predicted_query_type||value.query_type||''),confidence:Number(value.confidence||0),rationale:String(value.rationale||''),version:String(value.version||'medmemory-query-classifier.frozen-ab')};}
function effectiveClassification(item){const value=item?.query_classification;if(!value)return null;const trace=value.model_trace||{},traced=trace.parsed_response?.query_type||trace.raw_model_attempts?.find(attempt=>attempt?.parsed?.query_type)?.parsed?.query_type||trace.model_input?.parsed_response?.query_type||trace.model_input?.raw_model_attempts?.find(attempt=>attempt?.parsed?.query_type)?.parsed?.query_type||null,predicted=String(value.predicted_query_type||value.query_type||traced||'').trim(),official=String(value.official_query_type||item.task||'').trim(),retrieval=String(value.retrieval_query_type||predicted||official).trim();return{...value,predicted_query_type:predicted,retrieval_query_type:retrieval,official_query_type:official,answer_prompt_query_type:String(value.answer_prompt_query_type||official),is_correct:predicted===official};}
function compactActionSequence(turns){return turns.map(turn=>({step:turn.step??turn.turn??null,action:turn.action||turn.decision?.action||null,instruction:turn.instruction||turn.decision?.instruction||null,selected_memory_ids:turn.selected_memory_ids||turn.result?.selected_memory_ids||turn.output?.selected_memory_ids||[]}));}
function experimentDescriptor(persona,experiment){return{persona,experiment_id:experiment.id,status:experiment.status,metrics:experiment.progress?.retrieval_metrics||null};}
function scoreRows(experiment){return(experiment?.results||[]).filter(item=>item?.kind==='score');}
function findResumeSource(store,{persona,evaluationMode}){const row=store.db.prepare(`SELECT id FROM experiments WHERE benchmark='medmemorybench' AND json_extract(config_json,'$.score_only_current_memory')=1 AND json_extract(config_json,'$.persona_id')=? AND json_extract(config_json,'$.evaluation_mode')=? ORDER BY datetime(updated_at) DESC LIMIT 1`).get(persona,evaluationMode);return row?.id||null;}
async function runPool(items,concurrency,worker){let next=0;await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{while(true){const index=next++;if(index>=items.length)return;await worker(items[index]);}}));}
function progress(value){process.stderr.write(`${JSON.stringify({...value,at:new Date().toISOString()})}\n`);}
function readStdinLine(){return new Promise((resolve,reject)=>{let value='';const raw=Boolean(process.stdin.isTTY&&typeof process.stdin.setRawMode==='function');if(raw)process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');const finish=()=>{if(raw)process.stdin.setRawMode(false);process.stdin.pause();resolve(value.split(/\r?\n/u)[0]);};process.stdin.on('data',chunk=>{value+=chunk;if(/[\r\n]/u.test(value))finish();});process.stdin.on('end',finish);process.stdin.on('error',error=>{if(raw)process.stdin.setRawMode(false);reject(error);});});}
function parseArgs(argv){const out={database:process.env.CAREHARNESS_DB_PATH||'./data/careharness.sqlite',profile:'closeai-qwen3.7-plus',personas:[1,3,5,7],candidate_budget:24,investigation_budget:6,query_concurrency:4,scope_concurrency:4,report_dir:'reports'};for(let index=0;index<argv.length;index++){const key=argv[index],value=argv[index+1];if(key==='--database'){out.database=required(value,key);index++;}else if(key==='--profile'){out.profile=required(value,key);index++;}else if(key==='--personas'){out.personas=csv(value).map(item=>positive(item,key));index++;}else if(key==='--candidate-budget'){out.candidate_budget=positive(value,key);index++;}else if(key==='--investigation-budget'){out.investigation_budget=positive(value,key);index++;}else if(key==='--query-concurrency'){out.query_concurrency=positive(value,key);index++;}else if(key==='--scope-concurrency'){out.scope_concurrency=positive(value,key);index++;}else if(key==='--report-dir'){out.report_dir=required(value,key);index++;}else throw new Error(`Unknown argument: ${key}`);}return out;}
function csv(value){return required(value,'CSV').split(',').map(item=>item.trim()).filter(Boolean);}
function positive(value,key){const number=Number(value);if(!Number.isInteger(number)||number<1)throw new Error(`${key} requires positive integers`);return number;}
function required(value,key){if(!value||String(value).startsWith('--'))throw new Error(`${key} requires a value`);return String(value);}

main().catch(error=>{process.stderr.write(`${error.stack||error.message||error}\n`);process.exitCode=1;});
