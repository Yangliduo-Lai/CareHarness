import { BenchmarkAdapter,pjoin } from './base.js';
import { benchmarkAnswerContract } from '../prompts.js';
import { medLoCoMoJudgeInput,medLoCoMoTokenF1,scoreMedLoCoMoAbstention,scoreMedLoCoMoJudge,scoreMedLoCoMoJudgeUnavailable,validateMedLoCoMoJudgeOutput } from '../medlocomo-official.js';
export class MedLoCoMoAdapter extends BenchmarkAdapter{
  constructor(root){super(pjoin(root,'MedLoCoMo','MedLoCoMo'));this.name='medlocomo';}
  catalog(){const patients=this.list(this.root,d=>d.isDirectory()&&/^\d+$/.test(d.name)).map(d=>d.name);return{benchmark:this.name,path:this.root,available:patients.length>0,sample_count:patients.length,patients,visible_boundary:'Formal QA builds the complete chronological combined_conversation.json for one patient; Mode only filters benchmark_qa.json questions. Summaries and hidden evidence annotations are inspection/evaluation-only.',official_metrics:{answerable:['token_f1','llm_judge'],adversarial:['abstention_matcher']},discrepancies:[]};}
  load(config={}){const id=String(config.patient_id||'16957952'),dir=pjoin(this.root,id),combined=this.json(pjoin(dir,'combined_conversation.json')),qa=this.json(pjoin(dir,'benchmark_qa.json')),admissions=combined.admissions,observations=[],selection=selectQueries(qa.qas,config);
    for(const a of admissions){const turns=(a.conversation_lines||[]).map(t=>({subject_id:`medlocomo-${id}`,source_type:String(t.speaker).toLowerCase()==='patient'?'patient':'doctor',episode_id:String(a.hadm_id),turn_id:String(t.turn_number),event_time:t.time,raw_text:t.text}));if(turns.length)observations.push(this.sessionObservation(turns));}
    return{sample_id:id,observations,admissions:admissions.map(a=>({hadm_id:a.hadm_id,admission_start:a.admission_start,admission_end:a.admission_end,turn_count:a.conversation_lines?.length||0})),queries:qa.qas,query_selection:{mode:selection.mode,query_type:selection.queryType,available_count:qa.qas.length,selected_count:selection.queries.length},inspection_only:{patient_summary:pjoin(dir,'patient_summary.json'),admission_summaries:admissions.map(a=>pjoin(dir,String(a.hadm_id),'summary.json'))},visibility:{visible:['combined_conversation.admissions.conversation_lines'],inspection_only:['summary.json','patient_summary.json','previous_admission_summary'],harness_only:['benchmark_qa.qas','benchmark_qa.qas.evidence']}};}
  cases(data,config={}){return selectQueries(data.queries,config).queries.map(q=>({score_id:q.qa_id,task:q.question_type,question:q.question,gold:[q.answer],metadata:{answer_contract:benchmarkAnswerContract(this.name,q.question_type),scope:q.scope,evidence:q.evidence,long_term:q.scope==='cross_admission',official_evaluation:{benchmark:'medlocomo',metric:q.question_type==='adversarial'?'adversarial_abstention_accuracy':'answerable_token_f1+answerable_llm_judge'}}}));}
  normalizeAnswer(value){return String(value||'').trim();}
  requiresOfficialJudge(item={}){return item.task!=='adversarial';}
  compatibleScore(output,_golds,item={}){if(item.task!=='adversarial')throw new Error('MedLoCoMo answerable questions require the official LLM Judge');return scoreMedLoCoMoAbstention(output);}
  answerableTokenF1(output,item={}){return medLoCoMoTokenF1(output,Array.isArray(item.gold)?item.gold[0]:item.gold);}
  officialJudgeInput(output,item={}){return medLoCoMoJudgeInput(output,item);}
  validateOfficialJudge(value,item={}){return validateMedLoCoMoJudgeOutput(value,item);}
  scoreOfficialJudge(value,output,item={}){return scoreMedLoCoMoJudge(value,output,item);}
  scoreOfficialJudgeUnavailable(output,item={},reason){return scoreMedLoCoMoJudgeUnavailable(output,item,reason);}
}

function selectQueries(queries,config={}){
  const mode=normalizeMode(config.mode),queryType=String(config.query_type||'').trim();
  return{mode,queryType:queryType||null,queries:(queries||[]).filter(item=>(mode==='all'||item.scope===mode)&&(!queryType||item.question_type===queryType))};
}
function normalizeMode(value){const mode=String(value||'all').trim().toLowerCase().replace(/[\s-]+/g,'_');if(mode.includes('single'))return'single_admission';if(mode.includes('cross'))return'cross_admission';return'all';}
