import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuestionRequest } from '../src/investigation-contract.js';
import { createMemoryInvestigationWorkers } from '../src/investigation-workers.js';
import { createMemoryRetrievalRequest,retrieveMemoryCandidates,retrieveSessionMemoryAnchors } from '../src/retrieval.js';

const node=(memory_id,text,extra={})=>({memory_id,observation_id:`o-${memory_id}`,subject_id:'p',text,source_type:'patient',episode_id:'session-1',turn_id:'1',event_time:'2024-01-01',certainty:1,polarity:'affirmed',families:['PE'],status:'active',version:1,version_chain:[],operation:'ADD',...extra});
const edge=(from,to)=>({edge_id:`${from}-${to}`,from_memory_id:from,to_memory_id:to,status:'verified'});

test('retrieval request preserves the verbatim Question Request but receives direction only from a step instruction',()=>{
  const request=createMemoryRetrievalRequest(createQuestionRequest('患者当前情况如何？'),{objective:'调查血糖变化',search_terms:['空腹血糖']});
  assert.equal(request.question_request.question,'患者当前情况如何？');
  assert.deepEqual(request.instruction.search_terms,['空腹血糖']);
  for(const key of ['query_plan','node_blueprint','state_scopes','relation_goals'])assert.equal(request[key],undefined);
});

test('an empty worker instruction performs no implicit question parsing',()=>{
  const memories=[node('heart','患者当前晨起心率为72次/分。'),node('glucose','患者空腹血糖为9 mmol/L。')];
  const result=retrieveMemoryCandidates({question_request:createQuestionRequest('患者当前心率是多少？'),instruction:{}},memories);
  assert.deepEqual(result.memory_nodes,[]);
  assert.equal(result.trace.selection_mode,'policy_instruction_only');
});

test('the same question can change investigation direction on later policy turns',()=>{
  const memories=[node('heart','患者当前晨起心率为72次/分。'),node('glucose','患者空腹血糖为9 mmol/L。')],question=createQuestionRequest('患者当前情况如何？');
  const first=retrieveMemoryCandidates({question_request:question,instruction:{search_terms:['晨起心率']}},memories);
  const second=retrieveMemoryCandidates({question_request:question,instruction:{search_terms:['空腹血糖']}},memories);
  assert.deepEqual(first.memory_nodes.map(item=>item.memory_id),['heart']);
  assert.deepEqual(second.memory_nodes.map(item=>item.memory_id),['glucose']);
});

test('policy-generated clinical expansion terms retrieve grounded manifestations without creating facts',()=>{
  const memories=[node('condition','患者已确诊目标慢性疾病。',{families:['CS']}),node('manifestation','患者近期出现疾病相关表现甲并逐渐加重。',{families:['PE','LO']}),node('unrelated','患者记录了无关生活事件。')],workers=createMemoryInvestigationWorkers({question_request:createQuestionRequest('是否需要调整治疗？'),memory_nodes:memories});
  assert.ok(workers.search.capability.instruction_schema.properties.expansion_terms);
  const result=retrieveMemoryCandidates({question_request:createQuestionRequest('是否需要调整治疗？'),instruction:{objective:'扫描疾病控制恶化表现',expansion_terms:['表现甲','表现乙'],term_match:'any'}},memories);
  assert.deepEqual(result.memory_nodes.map(item=>item.memory_id),['manifestation']);assert.deepEqual(result.trace.worker_instruction.expansion_terms,['表现甲','表现乙']);
});

test('exact-entity assessment cannot generate or retain reasoning hypotheses',async()=>{
  const target=node('target','患者的口服药出现继发性药效减弱。'),workers=createMemoryInvestigationWorkers({
    question_request:createQuestionRequest('医生怀疑哪类药物出现继发性药效减弱？'),
    memory_nodes:[target],
    allow_reasoning_hypotheses:false,
    relation_evaluator:async input=>{
      assert.deepEqual(input.output_schema.reasoning_hypotheses,[]);
      assert.match(input.reasoning_hypotheses_policy,/Disabled/);
      return{value:{assessment:'supported',relevant_memory_ids:['target'],covered_aspects:['已找到类别'],answer_focus:[{aspect:'患者的口服药出现继发性药效减弱。',role:'target',source_refs:['memory:target'],memory_ids:['target'],required_in_answer:true}],connections:[],reasoning_hypotheses:[{summary:'不应保留的因果推断',supporting_source_refs:['memory:target'],reasoning_steps:['推断'],confidence:.9}],missing_information:[]}};
    },
  });
  const result=await workers.assess.run({state:{snapshot:{patient_profile:null,recent_sessions:[],memory_nodes:[target],memory_edges:[]}},instruction:{objective:'提取类别'}});
  assert.deepEqual(result.snapshot.semantic_evaluation.reasoning_hypotheses,[]);
  assert.deepEqual(result.snapshot.working_memory.reasoning_hypotheses,[]);
});

test('family, time, numeric and lens controls are worker-local rather than Question Request fields',()=>{
  const memories=[node('old','患者空腹血糖为9 mmol/L。',{families:['CS'],event_time:'2024-01-10'}),node('latest','患者空腹血糖降至7 mmol/L。',{families:['CS','LO'],event_time:'2024-03-10'}),node('other','患者最近睡眠改善。',{families:['LO'],event_time:'2024-04-10'})];
  const request={question_request:createQuestionRequest('原始问题不在这里被解析'),instruction:{search_terms:['空腹血糖'],family_weights:[{family:'LO',weight:4}],temporal:{operator:'latest',month_keys:['2024-03']},numeric_signals:[7],lenses:[{id:'trajectory',terms:['降至']}]}},result=retrieveMemoryCandidates(request,memories,{limit:2});
  assert.equal(result.memory_nodes[0].memory_id,'latest');
  assert.ok(result.candidates[0].reasons.includes('instruction_month'));
  assert.ok(result.candidates[0].reasons.includes('instruction_numeric'));
  assert.ok(result.candidates[0].reasons.includes('instruction_lens'));
});

test('relative-day localization is deterministic and returns only the resolved date',()=>{
  const memories=[node('day0','患者当日血糖为8 mmol/L。',{event_time:'2024-01-15'}),node('day1a','患者次日空腹血糖为9 mmol/L。',{event_time:'2024-01-16'}),node('day1b','患者次日口渴。',{event_time:'2024-01-16'}),node('day2','患者后天空腹血糖为7 mmol/L。',{event_time:'2024-01-17'})];
  const result=retrieveMemoryCandidates({question_request:createQuestionRequest('Q'),instruction:{temporal:{operator:'exact',base_date:'2024-01-15',offset_days:1}}},memories);
  assert.deepEqual(result.memory_nodes.map(item=>item.memory_id),['day1a','day1b']);
  assert.deepEqual(result.trace.resolved_temporal.date_keys,['2024-01-16']);
});

test('rare phrase, Doctor role and family constraints form an intersection',()=>{
  const memories=[node('doctor-drug','医生复查时考虑该降糖药出现继发性药效减弱。',{source_type:'doctor',families:['CP']}),node('patient-drug','患者担心药物继发性失效。',{source_type:'patient',families:['PE']}),node('doctor-other','医生复查时讨论饮食。',{source_type:'doctor',families:['CP']})];
  const result=retrieveMemoryCandidates({question_request:createQuestionRequest('Q'),instruction:{required_terms:['继发性'],source_types:['doctor'],required_families:['CP'],max_results:3}},memories);
  assert.deepEqual(result.memory_nodes.map(item=>item.memory_id),['doctor-drug']);
});

test('broad source and family facets do not disable lexical filtering',()=>{
  const memories=[
    node('target','医生记录患者每晚浅睡并自行醒来2至3次。',{source_type:'doctor',families:['PE']}),
    ...Array.from({length:50},(_,index)=>node(`distractor-${index}`,`医生记录无关随访内容 ${index}。`,{source_type:'doctor',families:['PE']})),
  ];
  const result=retrieveMemoryCandidates({question_request:createQuestionRequest('Q'),instruction:{search_terms:['浅睡','自行醒来'],source_types:['doctor'],required_families:['PE']}},memories,{limit:24});
  assert.deepEqual(result.memory_nodes.map(item=>item.memory_id),['target']);
  assert.equal(result.trace.candidate_count,1);
  assert.equal(result.trace.lexical_filter_mode,'filter_by_terms');
});

test('literal source fragments remain searchable when the structured text paraphrases the original words',()=>{
  const target=node('literal-source','患者近期有间歇性视觉问题。',{source_text:'患者自述进入1月后眼睛时不时看不清，表现为一阵一阵的模糊。'}),result=retrieveMemoryCandidates({question_request:createQuestionRequest('Q'),instruction:{search_terms:['看不清']}},[target]);
  assert.deepEqual(result.memory_nodes.map(item=>item.memory_id),['literal-source']);assert.deepEqual(result.candidates[0].matched_terms,['看不清']);
});

test('top-K diversifies obvious same-Session duplicates before admitting a second copy',()=>{
  const paraphrase=node('paraphrase','患者近期体重轻微下降，裤腰变松，估计减少一两斤。',{source_type:'structured'}),literal=node('literal','患者原话：我近期体重轻微下降，裤腰变松，估计减少一两斤。',{source_text:'我近期体重轻微下降，裤腰变松，估计减少一两斤。'}),different=node('different','患者同日空腹血糖为9 mmol/L。'),scores=new Map([['paraphrase',.99],['literal',.85],['different',.7]]),result=retrieveMemoryCandidates({question_request:createQuestionRequest('2024-01-01当日记录了什么？'),instruction:{temporal:{operator:'exact',date_keys:['2024-01-01']},search_terms:['体重','裤腰']}},[paraphrase,literal,different],{limit:2,semantic_scores:scores,semantic_top_k:2});
  assert.deepEqual(new Set(result.memory_nodes.map(item=>item.memory_id)),new Set(['literal','different']));assert.equal(result.trace.near_duplicate_candidate_count,1);assert.equal(result.trace.distinct_fact_candidate_count,2);
});

test('retrieval diversity does not merge different values, negation or measurements',()=>{
  const memories=[node('fasting-12','患者空腹血糖为12 mmol/L。'),node('fasting-13','患者空腹血糖为13 mmol/L。'),node('no-dry','患者最近没有明显口干症状。'),node('dry','患者最近有明显口干症状。'),node('post-13','患者餐后血糖为13 mmol/L。')],scores=new Map(memories.map((item,index)=>[item.memory_id,1-index/20])),result=retrieveMemoryCandidates({question_request:createQuestionRequest('Q'),instruction:{temporal:{operator:'exact',date_keys:['2024-01-01']}}},memories,{limit:5,semantic_scores:scores,semantic_top_k:5});
  assert.deepEqual(new Set(result.memory_nodes.map(item=>item.memory_id)),new Set(memories.map(item=>item.memory_id)));assert.equal(result.trace.near_duplicate_candidate_count,0);
});

test('an exact date keeps synonymously worded patient facts inside the structural scope',()=>{
  const memories=[
    node('vague','患者表示现在这些症状又冒出来。',{event_time:'2024-01-05',families:['PE']}),
    node('vision','患者自述进入1月后眼睛时不时看不清，表现为一阵一阵的模糊，过一会儿会缓解，无黑影或闪光。',{event_time:'2024-01-05',source_type:'structured',families:['PE']}),
    node('later','患者后来出现其他症状。',{event_time:'2024-05-30',families:['PE']}),
  ];
  const result=retrieveMemoryCandidates({question_request:createQuestionRequest('患者自2024/1/5开始出现什么症状？'),instruction:{search_terms:['症状'],source_types:['patient'],required_families:['PE'],temporal:{operator:'exact',date_keys:['2024-01-05']}}},memories);
  assert.deepEqual(new Set(result.memory_nodes.map(item=>item.memory_id)),new Set(['vague','vision']));
  assert.equal(result.trace.lexical_filter_mode,'rank_within_exact_scope');
});

test('an exact date semantically ranks every in-scope State before applying the 24-State cutoff',()=>{
  const target=node('target','医生在这次检查中记录了与问题最相关的视网膜病变结果。',{event_time:'2024-06-03',families:['CP']}),literal=node('literal','患者询问检查结果、检查结果、检查结果以及检查结果。',{event_time:'2024-06-03',families:['PE']}),sameDayDistractors=Array.from({length:28},(_,index)=>node(`same-day-${index}`,`患者当日记录无关事项 ${index}。`,{event_time:'2024-06-03',families:index===0?['LO']:['PE']})),outside=node('outside','医生记录了极其相关的视网膜病变检查结果。',{event_time:'2024-06-04',families:['CP']}),memories=[literal,...sameDayDistractors,target,outside],scores=new Map(memories.map(item=>[item.memory_id,item.memory_id==='target'?.99:item.memory_id==='outside'?1:.7-Number(item.memory_id.match(/\d+$/)?.[0]||0)/100]));
  scores.set('literal',.75);
  const result=retrieveMemoryCandidates({question_request:createQuestionRequest('2024-06-03的眼底检查发现了什么？'),instruction:{search_terms:['检查结果'],family_weights:[{family:'PE',weight:8}],lenses:[{id:'literal',terms:['检查结果']}],expand_graph:true,temporal:{operator:'exact',date_keys:['2024-06-03']}}},memories,{limit:24,semantic_scores:scores,semantic_top_k:24,memory_edges:[edge('literal','outside')]});
  assert.equal(result.memory_nodes.length,24);
  assert.equal(result.memory_nodes[0].memory_id,'target');
  assert.equal(result.memory_nodes.some(item=>item.memory_id==='outside'),false);
  assert.ok(result.memory_nodes.every(item=>item.event_time==='2024-06-03'));
  assert.equal(result.trace.candidate_count,30);
  assert.equal(result.trace.embedding_scored_scope_count,30);
  assert.equal(result.trace.selection_mode,'exact_temporal_embedding_top_k');
  assert.equal(result.trace.ranking_primary,'embedding_similarity');
  assert.deepEqual(result.candidates.map(item=>item.embedding_similarity),[...result.candidates.map(item=>item.embedding_similarity)].sort((left,right)=>right-left));
});

test('decimal clinical measurements are not misread as two-digit year and month scopes',()=>{
  const cases=[
    ['患者餐后血糖升至15.1 mmol/L的情况被记录在什么时间？','15.1'],
    ['患者之前的体重维持在约66.5kg，请问最近一次体重记录是多少？','66.5'],
    ['患者体重曾达到68.5公斤，请问目前体重状态如何？','68.5'],
    ['患者血压曾为90.7 mmHg，请问最近一次记录是多少？','90.7'],
    ['患者UACR曾为52.3 mg/g，请问当前结果是多少？','52.3'],
    ['患者某项指标曾为120.3，请问最新结果是多少？','120.3'],
  ];
  for(const[question,term]of cases){
    const target=node(`target-${term}`,question,{event_time:'2024-09-18'}),workers=createMemoryInvestigationWorkers({question_request:createQuestionRequest(question),memory_nodes:[target]});
    const result=workers.search.run({state:{snapshot:{memory_nodes:[],memory_edges:[]}},instruction:{search_terms:[term],temporal:{operator:'latest'}}});
    assert.deepEqual(result.snapshot.memory_nodes.map(item=>item.memory_id),[`target-${term}`]);
    assert.equal(result.trace.resolved_temporal.operator,'latest');
    assert.deepEqual(result.trace.resolved_temporal.month_keys,[]);
  }
});

test('an invented Session hint cannot override a grounded exact question date',()=>{
  const target=node('target','患者自述在该次对话出现乏力和头轻飘感。',{episode_id:'session-1',event_time:'2024-01-05'}),workers=createMemoryInvestigationWorkers({question_request:createQuestionRequest('在2024-01-05的对话记录中，患者出现了什么症状？'),memory_nodes:[target]});
  const result=workers.search.run({state:{snapshot:{memory_nodes:[],memory_edges:[]}},instruction:{search_terms:['症状'],episode_ids:['session-06'],temporal:{operator:'exact',date_keys:['2024-01-05']}}});
  assert.deepEqual(result.snapshot.memory_nodes.map(item=>item.memory_id),['target']);
  assert.equal(result.trace.worker_instruction.episode_ids,undefined);
});

test('discovery softens impossible conjunctive required terms instead of forcing zero recall',()=>{
  const target=node('target','患者近期睡眠变碎，每晚醒2-3次，醒后难以再次入睡。',{event_time:'2024-02-18'}),workers=createMemoryInvestigationWorkers({question_request:createQuestionRequest('患者每晚出现2-3次浅睡自行醒来的情况被记录在什么时候？'),memory_nodes:[target]});
  const result=workers.search.run({state:{snapshot:{memory_nodes:[],memory_edges:[]}},instruction:{search_terms:['2-3次','每晚'],required_terms:['浅睡','醒来'],term_match:'all'}});
  assert.deepEqual(result.snapshot.memory_nodes.map(item=>item.memory_id),['target']);
  assert.equal(result.trace.worker_instruction.required_terms,undefined);
  assert.equal(result.trace.worker_instruction.term_match,'any');
});

test('relative dates enforce a forward documentation window and rank the nearest records first',()=>{
  const base=node('base','患者表示次日空腹血糖接近 13 mmol/L。',{episode_id:'session-7',event_time:'2024-01-15'}),early=node('early','患者回顾次日空腹血糖为 12-13 mmol/L。',{episode_id:'session-8',event_time:'2024-01-20'}),later=node('later','患者再次确认次日空腹血糖为 12-13 mmol/L。',{episode_id:'session-9',event_time:'2024-01-31'}),outside=node('outside','患者空腹血糖为 8 mmol/L。',{event_time:'2024-02-16'}),distractors=Array.from({length:30},(_,index)=>node(`aug-${index}`,`患者空腹血糖记录 ${index}。`,{event_time:'2024-08-01'})),workers=createMemoryInvestigationWorkers({question_request:createQuestionRequest('患者在2024-01-15次日测得的空腹血糖值是多少？'),memory_nodes:[base,early,later,outside,...distractors],candidate_budget:2});
  const result=workers.search.run({state:{snapshot:{memory_nodes:[],memory_edges:[]}},instruction:{search_terms:['空腹血糖'],temporal:{operator:'exact',base_date:'2024-01-15',offset_days:1}}});
  assert.deepEqual(result.snapshot.memory_nodes.map(item=>item.memory_id),['early','later']);
  assert.deepEqual(result.trace.resolved_temporal,{operator:'range',date_keys:[],month_keys:[],start_date:'2024-01-16',end_date:'2024-02-15',prefer:'earliest'});
  assert.equal(result.trace.temporal_gate.hard,true);assert.equal(result.trace.temporal_gate.target_date,'2024-01-16');
  assert.ok(result.snapshot.memory_nodes.every(item=>item.event_time>='2024-01-16'&&item.event_time<='2024-02-15'));
});

test('latest temporal operation ranks a trajectory without discarding earlier answer-bearing records',()=>{
  const memories=[node('old','患者晨起心率为90次/分。',{event_time:'2024-06-28'}),node('new','患者晨起心率为72次/分。',{event_time:'2024-11-02'}),node('unrelated','患者睡眠改善。',{event_time:'2024-12-01'})];
  const result=retrieveMemoryCandidates({question_request:createQuestionRequest('Q'),instruction:{search_terms:['晨起心率'],temporal:{operator:'latest'}}},memories);
  assert.deepEqual(result.memory_nodes.map(item=>item.memory_id),['new','old']);
});

test('a newer generic factor mention cannot hide the latest explicit measurement',()=>{
  const memories=[node('baseline','患者之前的体重维持在约66.5kg。',{event_time:'2024-01-10'}),node('measurement','患者近期体重从66点多升至68.5kg。',{event_time:'2024-03-16'}),node('generic','医生解释完全不动时体重和水分更容易反弹。',{event_time:'2024-04-10'})];
  const result=retrieveMemoryCandidates({question_request:createQuestionRequest('患者之前的体重维持在约66.5kg，请问最近一次体重记录是多少？'),instruction:{objective:'寻找包含明确体重测量值和单位的记录，再从这些有效记录中确定最近一次',search_terms:['体重','kg','公斤','记录'],temporal:{operator:'none',prefer:'latest'}}},memories,{limit:3});
  assert.equal(result.memory_nodes[0].memory_id,'measurement');
  assert.deepEqual(new Set(result.memory_nodes.map(item=>item.memory_id)),new Set(['baseline','measurement','generic']));
});

test('overlapping lexical fragments contribute their average and a decimal also recalls its integer stem',()=>{
  const repeated=node('repeated','患者体重维持在原水平。',{event_time:'2024-01-10'}),transition=node('transition','患者体重从66点多升至新的水平。',{event_time:'2024-03-16'}),instruction={search_terms:['体重维持在','体重维持','维持在','体重','66.5','升至'],temporal:{operator:'none',prefer:'latest'}},result=retrieveMemoryCandidates({question_request:createQuestionRequest('Q'),instruction},[repeated,transition],{limit:4});
  assert.deepEqual(result.memory_nodes.map(item=>item.memory_id),['transition','repeated']);
  assert.equal(result.candidates[0].matched_terms.includes('66'),true);
  assert.ok(result.candidates[1].score<4,'overlapping phrase fragments must not be summed independently');
});

test('policy objective numeric literals remain soft anchors beside broad search terms',()=>{
  const transition=node('transition','患者近两日晨起体重由66.5kg上升至约68.5kg。',{event_time:'2024-03-14'}),continuation=node('continuation','患者晨起体重维持在67kg左右。',{event_time:'2024-04-02'}),result=retrieveMemoryCandidates({question_request:createQuestionRequest('Q'),instruction:{objective:'Find the updated weight by comparing it with the stated 66.5kg baseline.',search_terms:['体重','kg'],temporal:{operator:'latest'}}},[transition,continuation],{limit:2});
  assert.equal(result.memory_nodes[0].memory_id,'transition');
  assert.deepEqual(result.candidates[0].numeric_matches,['66.5']);
});

test('earliest temporal operation ranks semantic relevance before choosing an event date',()=>{
  const generic=node('generic','医生建议以后可检查胰岛自身抗体。',{event_time:'2024-01-06'}),target=node('target','患者GADA抗体强阳性，滴度>2000 U/mL。',{event_time:'2024-03-23'});
  const result=retrieveMemoryCandidates({question_request:createQuestionRequest('Q'),instruction:{search_terms:['GADA','强阳性','>2000'],expansion_terms:['胰岛自身抗体'],temporal:{operator:'earliest',prefer:'earliest'}}},[generic,target],{limit:4});
  assert.equal(result.memory_nodes[0].memory_id,'target');
  assert.deepEqual(new Set(result.memory_nodes.map(item=>item.memory_id)),new Set(['generic','target']));
});

test('persistent graph neighbors expand only when the current instruction requests it',()=>{
  const memories=[node('seed','患者确诊目标疾病。'),node('next','患者随后调整治疗。')],edges=[edge('seed','next')],base={question_request:createQuestionRequest('Q')};
  const without=retrieveMemoryCandidates({...base,instruction:{search_terms:['目标疾病']}},memories,{memory_edges:edges,limit:4});
  const withGraph=retrieveMemoryCandidates({...base,instruction:{search_terms:['目标疾病'],expand_graph:true}},memories,{memory_edges:edges,limit:4});
  assert.deepEqual(without.memory_nodes.map(item=>item.memory_id),['seed']);
  assert.deepEqual(withGraph.memory_nodes.map(item=>item.memory_id),['seed','next']);
  assert.equal(withGraph.candidates[1].reasons[0],'memory_graph_neighbor');
});

test('session anchoring uses the current instruction and returns complete selected Sessions',()=>{
  const memories=[node('a','患者记录目标症状。',{episode_id:'session-1'}),node('b','同次会话记录治疗安排。',{episode_id:'session-1'}),node('c','另一会话只有无关内容。',{episode_id:'session-2'})];
  const result=retrieveSessionMemoryAnchors({question_request:createQuestionRequest('Q'),instruction:{search_terms:['目标症状']}},memories,{anchor_limit:1,node_limit:10});
  assert.deepEqual(result.memory_nodes.map(item=>item.memory_id),['a','b']);
  assert.deepEqual(result.anchors[0].memory_ids,['a','b']);
});

test('context worker inherits current Session scope instead of restarting a global search',()=>{
  const seed=node('seed','患者表示这些症状再次出现。',{episode_id:'session-1',event_time:'2024-01-05'}),detail=node('detail','患者自述眼睛时不时看不清，呈间歇性模糊。',{episode_id:'session-1',event_time:'2024-01-05',source_type:'structured'}),distractors=Array.from({length:20},(_,index)=>node(`later-${index}`,`后续无关记录 ${index}。`,{episode_id:'session-47',event_time:'2024-05-30'})),workers=createMemoryInvestigationWorkers({question_request:createQuestionRequest('Q'),memory_nodes:[seed,detail,...distractors],candidate_budget:10});
  const result=workers.context.run({state:{snapshot:{memory_nodes:[seed],memory_edges:[]}},instruction:{objective:'补充这条症状的上下文'}});
  assert.deepEqual(new Set(result.snapshot.memory_nodes.map(item=>item.memory_id)),new Set(['seed','detail']));
  assert.deepEqual(result.trace.inherited_episode_ids,['session-1']);
});

test('global discovery treats a guessed family as a preference instead of deleting a valid fact',()=>{
  const diagnosis=node('diagnosis','社区医生评估患者为早期 2 型糖尿病。',{source_type:'structured',families:['CS']}),workers=createMemoryInvestigationWorkers({question_request:createQuestionRequest('既往慢性代谢性疾病是什么？'),memory_nodes:[diagnosis]});
  const result=workers.search.run({state:{snapshot:{memory_nodes:[],memory_edges:[]}},instruction:{search_terms:['糖尿病'],required_families:['BC']}});
  assert.deepEqual(result.snapshot.memory_nodes.map(item=>item.memory_id),['diagnosis']);
  assert.deepEqual(result.trace.worker_instruction.family_weights,[{family:'BC',weight:2}]);
  assert.equal(result.trace.worker_instruction.required_families,undefined);
});

test('discovery grounds explicit months but keeps vague relative periods soft',()=>{
  const nodes=[node('march','患者尿酮体检测结果为++。',{event_time:'2024-03-20'}),node('april','患者尿酮体检测转阴。',{event_time:'2024-04-01'}),node('recent','患者两周内记录目标症状。',{event_time:'2024-03-14'}),node('old','患者更早记录目标症状。',{event_time:'2024-01-01'})];
  const monthWorkers=createMemoryInvestigationWorkers({question_request:createQuestionRequest('患者2024年3月尿酮检测的结果是什么？'),memory_nodes:nodes}),month=monthWorkers.search.run({state:{snapshot:{memory_nodes:[],memory_edges:[]}},instruction:{search_terms:['尿酮'],temporal:{operator:'exact',date_keys:['2024-03-01']}}});
  assert.equal(month.snapshot.memory_nodes[0].memory_id,'march');
  assert.equal(month.snapshot.memory_nodes.some(item=>item.memory_id==='april'),false);
  assert.deepEqual(month.trace.resolved_temporal.month_keys,['2024-03']);
  const rangeNodes=nodes.filter(item=>['recent','old'].includes(item.memory_id)),rangeWorkers=createMemoryInvestigationWorkers({question_request:createQuestionRequest('这两周出现过目标症状吗？'),memory_nodes:rangeNodes}),range=rangeWorkers.search.run({state:{snapshot:{memory_nodes:[],memory_edges:[]}},instruction:{search_terms:['目标症状'],temporal:{operator:'range',start_date:'2023-10-01',end_date:'2023-10-15'}}});
  assert.deepEqual(new Set(range.snapshot.memory_nodes.map(item=>item.memory_id)),new Set(['recent','old']));
  assert.deepEqual(range.trace.resolved_temporal,{operator:'none',date_keys:[],month_keys:[],start_date:null,end_date:null});
});

test('a month-only date key is searched as the whole month instead of its first day',()=>{
  const nodes=[node('target','患者11月15日UACR复查结果为34 mg/g。',{episode_id:'session-94',event_time:'2024-11-15'}),node('same-month','患者11月20日复查血压正常。',{event_time:'2024-11-20'}),node('outside','患者12月复查UACR为31 mg/g。',{event_time:'2024-12-05'})],workers=createMemoryInvestigationWorkers({question_request:createQuestionRequest('患者7月记录的UACR是52 mg/g，11月的复查数值是多少？'),memory_nodes:nodes});
  const result=workers.search.run({state:{snapshot:{memory_nodes:[],memory_edges:[]}},instruction:{search_terms:['UACR','复查'],temporal:{operator:'exact',date_keys:['2024-11']}}});
  assert.equal(result.snapshot.memory_nodes.some(item=>item.memory_id==='target'),true);
  assert.equal(result.snapshot.memory_nodes.some(item=>item.memory_id==='outside'),false);
  assert.deepEqual(result.trace.worker_instruction.temporal,{operator:'range',month_keys:['2024-11']});
  assert.deepEqual(result.trace.resolved_temporal,{operator:'range',date_keys:[],month_keys:['2024-11'],start_date:null,end_date:null});
  assert.equal(result.trace.zero_recall,false);
});

test('hidden benchmark metadata is discarded at the Question Request boundary',()=>{
  const request=createMemoryRetrievalRequest({question:'Q',gold:['hidden'],answer_explanation:'hidden'},{search_terms:['Q']});
  assert.equal(request.question_request.question,'Q');
  assert.equal(JSON.stringify(request).includes('hidden'),false);
});

test('hybrid Search can retrieve a semantically equivalent patient phrase without weakening hard time scope',()=>{
  const early=node('early','患者自述眼睛时不时看不清，呈一阵一阵发作。',{event_time:'2024-01-05'}),literal=node('literal','后续记录使用了视力模糊一词。',{event_time:'2024-02-01'}),request={question_request:createQuestionRequest('患者最初何时出现视物模糊？'),instruction:{search_terms:['视力模糊'],temporal:{operator:'earliest',end_date:'2024-01-06',prefer:'earliest'}}};
  const result=retrieveMemoryCandidates(request,[early,literal],{limit:1,semantic_scores:new Map([['early',.95],['literal',.2]]),semantic_top_k:1});
  assert.deepEqual(result.memory_nodes.map(item=>item.memory_id),['early']);
  assert.ok(result.candidates[0].reasons.includes('embedding_similarity'));
  assert.equal(result.trace.selection_mode,'policy_instruction_hybrid_lexical_embedding');
});

test('Refine persists removed IDs and inferred time direction across every later Search',()=>{
  const early=node('early','患者自述眼睛时不时看不清，呈一阵一阵模糊。',{event_time:'2024-01-05'}),anchor=node('anchor','患者在复诊时确认此前已有间歇性视物模糊。',{event_time:'2024-01-06'}),later=node('later','患者后续再次出现间歇性视物模糊。',{event_time:'2024-01-20'}),workers=createMemoryInvestigationWorkers({question_request:createQuestionRequest('患者最初什么时候出现视物模糊？'),memory_nodes:[early,anchor,later],candidate_budget:8});
  const refined=workers.refine.run({state:{snapshot:{memory_nodes:[anchor,later],memory_edges:[],refinement_boundary:null}},instruction:{memory_ids:['anchor']}});
  assert.equal(refined.snapshot.refinement_boundary.permanent,true);
  assert.deepEqual(refined.snapshot.refinement_boundary.excluded_memory_ids,['later']);
  assert.deepEqual(refined.snapshot.refinement_boundary.temporal,{operator:'earliest',end_date:'2024-01-06',prefer:'earliest'});
  const searched=workers.search.run({state:{snapshot:refined.snapshot},instruction:{objective:'继续查找更早的同义症状',search_terms:['眼睛','看不清']}});
  assert.deepEqual(new Set(searched.snapshot.memory_nodes.map(item=>item.memory_id)),new Set(['anchor','early']));
  assert.equal(searched.snapshot.memory_nodes.some(item=>item.memory_id==='later'),false);
  assert.deepEqual(searched.trace.effective_instruction.temporal,{operator:'earliest',end_date:'2024-01-06',prefer:'earliest'});
});

test('a no-op Refine does not create a phantom permanent boundary',()=>{
  const current=node('current','患者当前记录。',{event_time:'2024-01-06'}),workers=createMemoryInvestigationWorkers({question_request:createQuestionRequest('Q'),memory_nodes:[current]});
  const result=workers.refine.run({state:{snapshot:{memory_nodes:[current],memory_edges:[],refinement_boundary:null}},instruction:{memory_ids:['missing'],temporal:{operator:'earliest',end_date:'2024-01-05'}}});
  assert.equal(result.trace.refinement_applied,false);assert.equal(result.snapshot.refinement_boundary,null);assert.deepEqual(result.snapshot.memory_nodes.map(item=>item.memory_id),['current']);
});
