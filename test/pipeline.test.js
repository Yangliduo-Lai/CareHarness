import test from'node:test';
import assert from'node:assert/strict';
import{Store}from'../src/db.js';
import{Pipeline,pipelineInternals as I}from'../src/pipeline.js';
import{makeSessionObservation}from'../src/session-observation.js';

const obs=(text,source_type='patient',extra={})=>({subject_id:'p',source_type,episode_id:'session-1',turn_id:'1',event_time:'2026-01-01',raw_text:text,...extra});
const run=async(list)=>{const s=new Store(':memory:'),p=new Pipeline(s);let r;for(const o of list)r=await p.run(o);return{s,r}};
const forbidden=['derived','normalization','speaker','normalized_entity','numbers','relation_hints','checkpoint','entity','relations','operation_reason','derived_from'];

test('core pipeline uses one Patient Graph updater with six typed node families',async()=>{const{s,r}=await run([obs('我付不起 copay，已经停药。')]);const names=r.traces.map(x=>x.component);for(const x of ['entity_relation_linker','temporal_reconciler','state_validity','updater_bc','updater_pe','updater_pa','updater_cs','updater_cp','updater_lo'])assert.equal(names.includes(x),false);assert.equal(names.filter(x=>x==='patient_graph_updater').length,1);assert.ok(r.final.states.some(x=>x.family==='BC'));assert.ok(r.final.states.some(x=>x.family==='PE'));assert.equal(r.final.patient_graph.version,'careharness-patient-graph.v1');s.close()});

test('requested fields are absent from Evidence, Router, State, Delta and persisted memory',async()=>{const{s,r}=await run([obs('患者对青霉素过敏。','structured')]);assert.deepEqual(r.final.states.map(x=>x.family),['CS']);const payload={evidence:r.final.evidence,router:r.traces.find(x=>x.component==='multi_label_router').output,states:r.final.states,deltas:r.final.deltas,memory:s.statesFor('p')};const raw=JSON.stringify(payload);for(const key of forbidden)assert.equal(new RegExp(`"${key}"\\s*:`).test(raw),false,key);assert.equal(/"reason"\s*:/.test(JSON.stringify(payload.router)),false);s.close()});

test('atomic extractor accepts text only and code attaches immutable Session provenance',()=>{const o={observation_id:'obs-1',subject_id:'demo',source_type:'structured',episode_id:'session-17',turn_id:'session',event_time:'2026-08-12',raw_text:'[Turn=1][Role=Patient]\n我按时吃药了，有时候会恶心。'};const raw={evidence:[{text:'患者按时服药。'},{text:'患者有时出现恶心。'}]},x=I.normalizeEvidenceOutput(raw,o);assert.deepEqual(x.map(item=>item.text),['患者按时服药。','患者有时出现恶心。']);for(const item of x){assert.equal(item.episode_id,'session-17');assert.equal(item.source_session_id,'session-17');assert.equal(item.turn_id,'session');assert.equal(item.source_type,'structured');assert.equal('source_text'in item,false);assert.equal('span'in item,false)}});

test('legacy or malformed model source_text is ignored and cannot fail Session construction',()=>{const o={observation_id:'obs-legacy-source',subject_id:'demo',source_type:'structured',episode_id:'noise-health-43',turn_id:'session',event_time:null,raw_text:'[Turn=1][Role=Patient]\n孩子是男孩。'},raw={evidence:[{text:'患者的孩子为男孩。',source_text:'[Turn=1][Role=Patient]\n孩子是男孩。'}]},x=I.normalizeEvidenceOutput(raw,o);assert.equal(x.length,1);assert.equal(x[0].text,'患者的孩子为男孩。');assert.equal(x[0].source_session_id,'noise-health-43');assert.equal('source_text'in x[0],false)});

test('extractor recovers validated complete Evidence items after repeated length truncation',async()=>{
  const raw='{"evidence":[{"text":"患者持续恶心。"},{"text":"患者同时听到低频嗡声。';
  const gateway={config:{provider:'live-test',model:'truncating-extractor'},publicConfig(){return this.config},async completeJSON(component,input,validator,mockFactory){
    if(component==='extractor'){const error=new Error('Model output was truncated at max_tokens=8192');error.gatewayTrace={component,input,provider:'live-test',model:'truncating-extractor',raw_model_response:raw,parsed_response:null,finish_reason:'length',raw_model_attempts:[{attempt:0,raw,finish_reason:'length',max_tokens:8192}],error:{kind:'truncated_output',message:error.message,validation_errors:[],suggestion:'retry'}};throw error;}
    const modelOutput=await mockFactory(input);return{value:validator(modelOutput),trace:{component,provider:'mock',model:'router-rules',raw_model_response:JSON.stringify(modelOutput),parsed_response:modelOutput,error:null,mock:true}};
  }};
  const store=new Store(':memory:'),pipeline=new Pipeline(store,{gateway}),result=await pipeline.run(obs('恶心基本是一直有的，大概伴随偏低频的那种“嗡——”声。'),{phase:'memory_build'}),trace=result.traces.find(item=>item.component==='atomic_evidence_extractor');
  assert.equal(result.status,'completed');assert.equal(result.final.evidence.length,1);assert.equal(result.final.evidence[0].text,'患者持续恶心。');assert.equal(result.final.evidence[0].source_session_id,'session-1');assert.equal(trace.gateway.finish_reason,'length_recovered');assert.equal(trace.gateway.recovery.mode,'validated_complete_evidence_prefix');assert.equal(trace.gateway.recovery.discarded_incomplete_suffix,true);assert.equal(trace.gateway.validation_warnings.at(-1).warning_type,'truncated_extractor_prefix_recovered');assert.ok(result.final.states.some(item=>item.family==='PE'));store.close();
});
test('extractor does not recover a truncated fragment without any complete valid Evidence item',async()=>{
  const raw='{"evidence":[{"text":"患者持续恶心';
  const gateway={config:{provider:'live-test',model:'truncating-extractor'},publicConfig(){return this.config},async completeJSON(component){
    assert.equal(component,'extractor');const error=new Error('Model output was truncated at max_tokens=8192');error.gatewayTrace={component,input:'恶心基本是一直有的。',provider:'live-test',model:'truncating-extractor',raw_model_response:raw,parsed_response:null,finish_reason:'length',raw_model_attempts:[{attempt:0,raw,finish_reason:'length',max_tokens:8192}],error:{kind:'truncated_output',message:error.message,validation_errors:[],suggestion:'retry'}};throw error;
  }};
  const store=new Store(':memory:'),pipeline=new Pipeline(store,{gateway});
  await assert.rejects(()=>pipeline.run(obs('恶心基本是一直有的。'),{phase:'memory_build'}),/truncated at max_tokens=8192/);
  assert.equal(store.statesFor('p').length,0);store.close();
});
test('extractor drops malformed entries without failing the whole Session',()=>{const o={observation_id:'obs-malformed',subject_id:'demo',source_type:'structured',episode_id:'session-1',turn_id:'session',event_time:null,raw_text:'患者今天继续监测血糖。'},result=I.normalizeEvidenceOutput({evidence:[{source_text:'旧格式但没有 text'},{text:'患者今天继续监测血糖。'}]},o);assert.equal(result.length,1);assert.equal(result.warnings[0].failure_reason,'missing_atomic_text')});

test('extractor coverage guard restores the explicit Session 6 Patient medication stop with exact provenance and trace warning',async()=>{
  const observation={observation_id:'session-6-coverage',...makeSessionObservation([
    {subject_id:'session-patient',source_type:'patient',episode_id:'session-6',turn_id:'3',event_time:'2024-02-18',raw_text:'没有，主要就是最近太忙了，睡得少。我之前也想是不是恩格列净吃了不舒服，所以我这两天把恩格列净停了之后，好像也没那么恶心了，但嘴干、老跑厕所还是有。'},
    {subject_id:'session-patient',source_type:'doctor',episode_id:'session-6',turn_id:'4',event_time:'2024-02-18',raw_text:'建议先把用药情况记录下来，复诊时再核对。'}
  ])};
  const extractor={config:{provider:'mock'},publicConfig(){return{provider:'mock',model:'omitting-extractor-test'};},async completeJSON(component,input,validator){assert.equal(component,'extractor');const raw={evidence:[{text:'患者仍然嘴干。'}]};return{value:validator(raw),trace:{component:'extractor',raw_model_response:JSON.stringify(raw)}};}};
  const store=new Store(':memory:'),pipeline=new Pipeline(store,{componentGateways:{extractor}}),result=await pipeline.run(observation,{phase:'memory_build'}),added=result.final.evidence.find(item=>item.evidence_id.includes(':coverage:medication:')),trace=result.traces.find(item=>item.component==='atomic_evidence_extractor');
  assert.ok(added);assert.equal(added.source_type,'structured');assert.equal(added.turn_id,'session');assert.equal(added.event_time,'2024-02-18');assert.equal(added.source_session_id,'session-6');assert.match(added.text,/这两天把恩格列净停用/);assert.equal('source_text'in added,false);assert.equal('span'in added,false);assert.ok(result.final.states.some(item=>item.family==='CS'&&/恩格列净停用/.test(item.value)&&item.source_session_id==='session-6'));
  assert.equal(trace.gateway.validation_warnings.length,1);assert.equal(trace.gateway.validation_warnings[0].warning_type,'coverage_guard_added');assert.deepEqual(trace.gateway.validation_warnings[0].statuses,['stopped']);
  const repeated=I.normalizeEvidenceOutput({evidence:[{text:'患者仍然嘴干。'}]},observation).find(item=>item.evidence_id.includes(':coverage:medication:'));assert.equal(repeated.evidence_id,added.evidence_id);
  store.close();
});

test('extractor coverage guard does not duplicate a model-returned medication fact for the same drug and status',()=>{
  const observation={observation_id:'session-6-covered',...makeSessionObservation([{subject_id:'session-patient',source_type:'patient',episode_id:'session-6',turn_id:'3',event_time:'2024-02-18',raw_text:'所以我这两天把恩格列净停了之后，好像也没那么恶心了。'}])};
  const evidence=I.normalizeEvidenceOutput({evidence:[{text:'患者这两天已停用恩格列净。'}]},observation);
  assert.equal(evidence.filter(item=>/恩格列净/.test(item.text)).length,1);assert.equal(evidence.some(item=>item.evidence_id.includes(':coverage:medication:')),false);assert.equal(evidence.warnings.some(item=>item.warning_type==='coverage_guard_added'),false);
});

test('extractor coverage guard never turns a Doctor stop recommendation into current medication status',()=>{
  const observation={observation_id:'doctor-stop-recommendation',...makeSessionObservation([{subject_id:'session-patient',source_type:'doctor',episode_id:'session-6',turn_id:'4',event_time:'2024-02-18',raw_text:'我建议你先停用恩格列净，复诊时再确认。'}])},evidence=I.normalizeEvidenceOutput({evidence:[]},observation);
  assert.deepEqual(evidence,[]);assert.equal(evidence.warnings.length,0);
});

test('extractor coverage guard conservatively skips a multi-drug clause instead of projecting one stop action to every drug',()=>{
  const samples=['我停用了恩格列净但仍在服用二甲双胍。','我停用恩格列净改成二甲双胍。'];
  for(const [index,raw_text]of samples.entries()){
    const observation={observation_id:`multi-drug-${index}`,subject_id:'session-patient',source_type:'patient',episode_id:'session-6',turn_id:'3',event_time:'2024-02-18',raw_text},evidence=I.normalizeEvidenceOutput({evidence:[]},observation);
    assert.deepEqual(evidence,[],raw_text);assert.equal(evidence.warnings.some(item=>item.warning_type==='coverage_guard_added'),false,raw_text);
  }
});

test('extractor coverage guard rejects hypothetical medication changes when the model returns no Evidence',()=>{
  const samples=['如果停用恩格列净，恶心可能会改善。','假如我停用恩格列净，之后再观察。','若停用恩格列净，之后再观察。','一旦停用恩格列净，血糖也许会变化。','要是停用恩格列净，之后再观察。','假设停用恩格列净，之后再观察。','只要停用恩格列净，恶心就会改善。','除非停用恩格列净，否则不会好。','万一停用恩格列净后不舒服怎么办。','我差点停用恩格列净。','我险些停用恩格列净。','我本来要停用恩格列净。','If I stop taking empagliflozin, the nausea may improve.','I almost stopped taking empagliflozin.','I nearly discontinued empagliflozin.'];
  for(const [index,raw_text]of samples.entries()){
    const observation={observation_id:`hypothetical-medication-${index}`,subject_id:'session-patient',source_type:'patient',episode_id:'session-6',turn_id:'3',event_time:'2024-02-18',raw_text},evidence=I.normalizeEvidenceOutput({evidence:[]},observation);
    assert.deepEqual(evidence,[],raw_text);assert.equal(evidence.warnings.length,0,raw_text);
  }
});

test('extractor coverage guard abstains from same-sentence medication reversals instead of recording the obsolete stop',()=>{
  const samples=['我停了几天现在又重新开始服用恩格列净。','以前停用恩格列净，后来又恢复服用。','我把恩格列净停了，但今天又吃上了。','我把恩格列净停了，后来又服用了。','我把恩格列净停了，不过昨晚又吃了一片。','我把恩格列净停了，后来继续服用了。','我把恩格列净停了，之后再次用上了。','我把恩格列净停了，今天服上了。','I discontinued empagliflozin and then resumed taking it.'];
  for(const [index,raw_text]of samples.entries()){
    const observation={observation_id:`medication-reversal-${index}`,subject_id:'session-patient',source_type:'patient',episode_id:'session-6',turn_id:'3',event_time:'2024-02-18',raw_text},evidence=I.normalizeEvidenceOutput({evidence:[]},observation);
    assert.deepEqual(evidence,[],raw_text);assert.equal(evidence.warnings.length,0,raw_text);
  }
});

test('extractor coverage guard abstains when the Patient retracts or corrects the stop in the same sentence',()=>{
  const samples=['我把恩格列净停了，不对，我没停。','我把恩格列净停了，刚才说错了。','我把恩格列净停了，其实没有停。'];
  for(const [index,raw_text]of samples.entries()){
    const observation={observation_id:`medication-stop-correction-${index}`,subject_id:'session-patient',source_type:'patient',episode_id:'session-6',turn_id:'3',event_time:'2024-02-18',raw_text},evidence=I.normalizeEvidenceOutput({evidence:[]},observation);
    assert.deepEqual(evidence,[],raw_text);assert.equal(evidence.warnings.length,0,raw_text);
  }
});

test('extractor coverage guard honors later retractions and reversals anywhere in the same Patient Turn',()=>{
  const samples=['我把恩格列净停了。其实我没停。','我把恩格列净停了。前面说错了，我没有停。','我把恩格列净停了。等等，我没停，刚才记错了。','我把恩格列净停了。后来我又服用了。'];
  for(const [index,raw_text]of samples.entries()){
    const observation={observation_id:`later-medication-stop-correction-${index}`,subject_id:'session-patient',source_type:'patient',episode_id:'session-6',turn_id:'3',event_time:'2024-02-18',raw_text},evidence=I.normalizeEvidenceOutput({evidence:[]},observation);
    assert.deepEqual(evidence,[],raw_text);assert.equal(evidence.warnings.length,0,raw_text);
  }
});

test('extractor coverage guard keeps the real empagliflozin stop when a later sentence mentions missed mealtime insulin',()=>{
  const raw_text='我这两天把恩格列净停了之后，好像也没那么恶心了。餐时胰岛素还是会漏掉一针半针。',observation={observation_id:'session-6-two-medication-turn',subject_id:'session-patient',source_type:'patient',episode_id:'session-6',turn_id:'2',event_time:'2024-02-18',raw_text},evidence=I.normalizeEvidenceOutput({evidence:[]},observation),added=evidence.find(item=>item.evidence_id.includes(':coverage:medication:'));
  assert.ok(added);assert.equal(added.source_session_id,'session-6');assert.equal('source_text'in added,false);assert.equal('span'in added,false);assert.equal(evidence.warnings[0].warning_type,'coverage_guard_added');
});

test('extractor coverage guard requires an explicitly completed medication stop',()=>{
  const rejected={observation_id:'bare-stop',subject_id:'session-patient',source_type:'patient',episode_id:'session-6',turn_id:'3',event_time:'2024-02-18',raw_text:'我停用恩格列净。'},accepted={...rejected,observation_id:'completed-stop',raw_text:'我这两天把恩格列净停了之后。'};
  assert.deepEqual(I.normalizeEvidenceOutput({evidence:[]},rejected),[]);assert.equal(I.normalizeEvidenceOutput({evidence:[]},accepted).filter(item=>item.evidence_id.includes(':coverage:medication:')).length,1);
});

test('extractor coverage guard leaves dose, current-use and uncertain facts entirely to the model',()=>{
  const samples=['我考虑把恩格列净剂量加到500mg。','我每天服用恩格列净可能是500mg。','恩格列净剂量是医生决定的。','我目前每天服用恩格列净500mg。','我可能已经停用恩格列净。','我好像已经停用恩格列净。'];
  for(const [index,raw_text]of samples.entries()){
    const observation={observation_id:`non-stop-coverage-${index}`,subject_id:'session-patient',source_type:'patient',episode_id:'session-6',turn_id:'3',event_time:'2024-02-18',raw_text},evidence=I.normalizeEvidenceOutput({evidence:[]},observation);
    assert.deepEqual(evidence,[],raw_text);assert.equal(evidence.warnings.length,0,raw_text);
  }
});

test('extractor coverage guard rejects third-party medication stops inside a Patient Turn',()=>{
  const samples=['我父亲已经停用恩格列净。','朋友已经停用恩格列净。','他说他已经停用恩格列净。','我的医生已经停用恩格列净。','我们已经停用恩格列净。','我让小王把恩格列净停了。','我告诉小王把恩格列净停了。','我知道小王不再服用恩格列净。','我已经让小王停用恩格列净。','不是我已经停用恩格列净。','并非我已经停用恩格列净。','别说我已经停用恩格列净。','不能说我已经停用恩格列净。','谁说我已经停用恩格列净。','My father has stopped taking empagliflozin.','I heard my friend discontinued empagliflozin.','I know John stopped taking empagliflozin.','It is not true that I stopped taking empagliflozin.'];
  for(const [index,raw_text]of samples.entries()){
    const observation={observation_id:`third-party-stop-${index}`,subject_id:'session-patient',source_type:'patient',episode_id:'session-6',turn_id:'3',event_time:'2024-02-18',raw_text},evidence=I.normalizeEvidenceOutput({evidence:[]},observation);
    assert.deepEqual(evidence,[],raw_text);assert.equal(evidence.warnings.length,0,raw_text);
  }
});

test('extractor coverage guard leaves every English stop expression to the model',()=>{
  const rejected=['I stopped thinking empagliflozin was helping.','I stopped worrying about empagliflozin.','I discontinued discussing empagliflozin.','I ceased believing empagliflozin worked.','I stopped taking empagliflozin.','I have stopped using empagliflozin.'];
  for(const [index,raw_text]of rejected.entries()){
    const observation={observation_id:`english-non-medication-stop-${index}`,subject_id:'session-patient',source_type:'patient',episode_id:'session-6',turn_id:'3',event_time:'2024-02-18',raw_text};
    assert.deepEqual(I.normalizeEvidenceOutput({evidence:[]},observation),[],raw_text);
  }
});

test('extractor coverage guard binds the Chinese stop verb directly to the medication object',()=>{
  const samples=['我把恩格列净的服药提醒停了。','我这两天把恩格列净的提醒停了。','我已经把讨论恩格列净的群聊停了。','我已经停止讨论恩格列净。','我停用了包含恩格列净的提醒。','我已经停用恩格列净的提醒。','我已经停用恩格列净的服药提醒。','我不再使用恩格列净提醒。','我不再使用恩格列净的提醒功能。','我已经停用二甲双胍相关的提醒。'];
  for(const [index,raw_text]of samples.entries()){
    const observation={observation_id:`chinese-non-medication-stop-${index}`,subject_id:'session-patient',source_type:'patient',episode_id:'session-6',turn_id:'3',event_time:'2024-02-18',raw_text};
    assert.deepEqual(I.normalizeEvidenceOutput({evidence:[]},observation),[],raw_text);
  }
});

test('offline extractor rewrites patient subject and known brand drugs to generic names',()=>{const o={observation_id:'o',subject_id:'p',source_type:'patient',episode_id:'s',turn_id:'1',event_time:null,raw_text:'我服用了Prilosec。'};const x=I.extractEvidence(o);assert.equal(x[0].text,'患者服用了omeprazole。');assert.equal(o.raw_text.slice(...x[0].span),'我服用了Prilosec。')});

test('complete Session extraction records Session-level provenance and drops Doctor companionship filler',async()=>{const s=new Store(':memory:'),p=new Pipeline(s),o=makeSessionObservation([{subject_id:'session-patient',source_type:'patient',episode_id:'session-1',turn_id:'1',event_time:'2024-01-05',raw_text:'我已经停用恩格列净，最近仍然口渴。'},{subject_id:'session-patient',source_type:'doctor',episode_id:'session-1',turn_id:'2',event_time:'2024-01-05',raw_text:'建议继续监测空腹血糖。不会让你一个人在黑暗里摸索。'}]),r=await p.run(o,{phase:'memory_build'});assert.equal(r.final.observation.source_type,'structured');assert.ok(r.final.evidence.some(x=>/停用恩格列净/.test(x.text)));assert.ok(r.final.evidence.some(x=>/监测空腹血糖/.test(x.text)));assert.equal(r.final.evidence.some(x=>/黑暗里摸索/.test(x.text)),false);assert.ok(r.final.evidence.every(x=>x.source_type==='structured'&&x.turn_id==='session'&&x.source_session_id==='session-1'));assert.ok(r.final.states.every(x=>x.source_session_id==='session-1'));s.close()});

test('session normalizer filters companionship text while keeping Session provenance code-owned',()=>{const o={observation_id:'session-filter',...makeSessionObservation([{subject_id:'session-patient',source_type:'doctor',episode_id:'session-1',turn_id:'7',event_time:'2024-01-05',raw_text:'不会让你一个人在黑暗里摸索。'}])},evidence=I.normalizeEvidenceOutput({evidence:[{text:'医生不会让患者一个人在黑暗里摸索。'}]},o);assert.deepEqual(evidence,[]);assert.equal(evidence.warnings[0].failure_reason,'filtered_non_memory_dialogue')});

test('session Evidence ignores model-provided transcript quotes and records only the code-owned Session id',()=>{const o={observation_id:'session-boundary',...makeSessionObservation([{subject_id:'session-patient',source_type:'patient',episode_id:'session-1',turn_id:'1',event_time:null,raw_text:'继续监测。'},{subject_id:'session-patient',source_type:'doctor',episode_id:'session-1',turn_id:'2',event_time:null,raw_text:'继续监测。'}])},evidence=I.normalizeEvidenceOutput({evidence:[{text:'患者继续监测。',source_text:'[Turn=1][Role=Patient]\n继续监测。'}]},o);assert.equal(evidence.length,1);assert.equal(evidence[0].source_session_id,'session-1');assert.equal('source_text'in evidence[0],false)});

test('router output only adds id and family labels',()=>{const evidence=[{evidence_id:'e1',observation_id:'o',subject_id:'p',text:'患者按时服药。',span:[0,1],source_type:'patient',episode_id:'s',turn_id:'1',event_time:null,certainty:1,polarity:'affirmed'}],raw={routes:[{id:'0',operation_reason:'remove',derived_from:['x'],families:['PE']}]};const x=I.normalizeRoutesOutput(raw,evidence);assert.deepEqual(x[0].families,['PE']);assert.equal('operation_reason'in x[0],false);assert.equal('derived_from'in x[0],false)});

test('router rejects combined family labels instead of guessing how to split them',()=>{const evidence=[{evidence_id:'e1',observation_id:'o',subject_id:'p',text:'患者报告症状和风险。',span:[0,1],source_type:'patient',episode_id:'s',turn_id:'1',event_time:null,certainty:1,polarity:'affirmed'}],x=I.normalizeRoutesOutput({routes:[{id:'0',families:['PE|CS']}]},evidence);assert.throws(()=>I.validateRoutes(x,evidence),/invalid route family/)});

test('router code owns Evidence ids and rejects an unnormalized duplicate family',()=>{const evidence=[{evidence_id:'e1',observation_id:'o',subject_id:'p',text:'患者已停用恩格列净。',span:[0,1],source_type:'patient',episode_id:'s',turn_id:'1',event_time:null,certainty:1,polarity:'affirmed'}];assert.throws(()=>I.validateRoutes([],evidence),/exactly 1 routes/);assert.doesNotThrow(()=>I.validateRoutes(I.normalizeRoutesOutput({routes:[{families:[]}]},evidence),evidence));assert.equal(I.normalizeRoutesOutput({routes:[{id:'model-invented',families:['PE']}]},evidence)[0].id,'0');assert.throws(()=>I.validateRoutes(I.normalizeRoutesOutput({routes:[{families:['pe']}]},evidence),evidence),/invalid route family/);assert.doesNotThrow(()=>I.validateRoutes([{...evidence[0],id:'0',families:['PE','CS','LO']}],evidence));assert.throws(()=>I.validateRoutes([{...evidence[0],id:'0',families:['PE','PE']}],evidence),/duplicate route family PE/)});

test('router deterministically unwraps a single array-wrapped routes envelope',()=>{const evidence=Array.from({length:2},(_,index)=>({evidence_id:`e${index}`,text:`事实${index}`,source_type:'structured'})),raw=[{routes:[{id:'wrong-a',families:['PA']},{id:'wrong-b',families:['PE','PA']}]}],routes=I.normalizeRoutesOutput(raw,evidence);assert.deepEqual(routes.map(item=>({id:item.id,families:item.families})),[{id:'0',families:['PA']},{id:'1',families:['PE','PA']}]);assert.strictEqual(I.validateRoutes(routes,evidence),routes)});

test('router code builds canonical routes from a family matrix or per-item wrappers',()=>{const evidence=Array.from({length:3},(_,index)=>({evidence_id:`matrix-${index}`,text:`事实${index}`,source_type:'structured'})),matrix=I.normalizeRoutesOutput({families:[['BC'],[],['PE','LO']]},evidence),wrapped=I.normalizeRoutesOutput([{routes:[{families:['BC']}]},{routes:[]},{routes:[{families:['PE','LO']}]}],evidence);assert.deepEqual(matrix.map(item=>({id:item.id,families:item.families})),[{id:'0',families:['BC']},{id:'1',families:[]},{id:'2',families:['PE','LO']}]);assert.deepEqual(wrapped.map(item=>({id:item.id,families:item.families})),matrix.map(item=>({id:item.id,families:item.families})));assert.strictEqual(I.validateRoutes(matrix,evidence),matrix);assert.strictEqual(I.validateRoutes(wrapped,evidence),wrapped)});

test('router accepts a top-level family matrix without semantic repair',()=>{const evidence=Array.from({length:3},(_,index)=>({evidence_id:`raw-matrix-${index}`,text:`事实${index}`,source_type:'structured'})),routes=I.normalizeRoutesOutput([['BC'],[],['PE','LO']],evidence);assert.deepEqual(routes.map(item=>({id:item.id,families:item.families})),[{id:'0',families:['BC']},{id:'1',families:[]},{id:'2',families:['PE','LO']}]);assert.strictEqual(I.validateRoutes(routes,evidence),routes)});

test('router splits long inputs into structural batches and restores global order',async()=>{const evidence=Array.from({length:14},(_,index)=>({evidence_id:`batch-${index}`,text:`事实${index}`,source_type:'structured'})),input=evidence.map((item,index)=>({id:String(index),text:item.text,source:item.source_type})),calls=[],gateway={async completeJSON(component,batchInput,validator){calls.push(batchInput);const value=validator({families:batchInput.map((_,index)=>index%2?['PE']:['CS'])});return{value,trace:{component,latency_ms:10,token_input:20,token_output:5,estimated_cost_usd:0,retries:0,raw_model_response:'{}',raw_model_attempts:[]}};}},result=await I.routeWithFallback(gateway,input,evidence,{});assert.deepEqual(calls.map(batch=>batch.length),[8,6]);assert.deepEqual(result.value.map(route=>route.id),Array.from({length:14},(_,index)=>String(index)));assert.deepEqual(result.value.map(route=>route.evidence_id),evidence.map(item=>item.evidence_id));assert.equal(result.trace.router_batch_count,2);assert.equal(result.trace.token_input,40);assert.strictEqual(I.validateRoutes(result.value,evidence),result.value)});

test('router schema failures fall back to the deterministic family router without failing the Session',async()=>{const extractor={config:{provider:'mock',model:'extractor-test'},publicConfig(){return this.config},async completeJSON(_component,input,validator){const raw={evidence:[{text:'患者担心手术后的恢复时间。'}]};return{value:validator(raw),trace:{component:'extractor',raw_model_response:JSON.stringify(raw)}};}},router={config:{provider:'live-test',model:'malformed-router'},publicConfig(){return this.config},async completeJSON(_component,input){const error=new Error('router must return exactly 1 routes');error.gatewayTrace={component:'router',input,raw_model_response:'{"families":[]}',error:{kind:'schema_error',message:error.message}};throw error;}},store=new Store(':memory:'),pipeline=new Pipeline(store,{componentGateways:{extractor,router}}),result=await pipeline.run(obs('患者担心手术后的恢复时间。'),{phase:'memory_build'}),trace=result.traces.find(item=>item.component==='multi_label_router');assert.equal(result.status,'completed');assert.ok(result.final.states.some(item=>item.family==='PA'));assert.equal(trace.gateway.fallback_used,true);assert.equal(trace.gateway.validation_warnings[0].warning_type,'router_model_output_fallback');assert.match(trace.gateway.model_validation_error.message,/exactly 1 routes/);store.close()});

test('router deterministically removes duplicate families and records a warning',()=>{const evidence=[{evidence_id:'e1',text:'患者停药后症状改善。',source_type:'patient',certainty:1}],normalized=I.normalizeRoutesOutput({routes:[{id:'0',families:['PE','CS','PE','LO','CS']}]},evidence);assert.deepEqual(normalized[0].families,['PE','CS','LO']);assert.strictEqual(I.validateRoutes(normalized,evidence),normalized);assert.deepEqual(normalized.warnings.map(item=>[item.warning_type,item.family,item.selection_basis]),[['exact_route_label_deduplicated','PE','exact_family'],['exact_route_label_deduplicated','CS','exact_family']])});

test('offline Router maps representative facts to one or more families',()=>{const evidence=[{evidence_id:'e-background',text:'患者近期因项目赶工长期熬夜。',source_type:'patient'},{evidence_id:'e-clinical',text:'患者被诊断为早期2型糖尿病，PHQ-9为7分。',source_type:'structured'},{evidence_id:'e-change',text:'患者服药后恶心由严重变为明显改善。',source_type:'patient'},{evidence_id:'e-care',text:'医生建议继续监测血糖并安排复诊。',source_type:'doctor'}],routes=I.routeEvidence(evidence,{source_type:'structured'});assert.ok(routes[0].families.includes('BC'));assert.ok(routes[1].families.includes('CS'));assert.ok(routes[2].families.includes('PE'));assert.ok(routes[2].families.includes('LO'));assert.deepEqual(routes[3].families,['CP'])});

test('pipeline creates at most one State per Evidence and family while retaining cross-family provenance',async()=>{const router={config:{provider:'mock'},publicConfig(){return{provider:'mock',model:'family-router-test'};},async completeJSON(component,input,validator){const raw={routes:[{id:input[0].id,families:['BC','CS','BC','PE']}]};return{value:validator(raw),trace:{component:'router',raw_model_response:JSON.stringify(raw)}};}};const store=new Store(':memory:'),pipeline=new Pipeline(store,{componentGateways:{router}}),result=await pipeline.run(obs('患者既往无持续性 UACR 升高史。','doctor',{episode_id:'session-59',turn_id:'session'}),{phase:'memory_build'});assert.equal(result.status,'completed');assert.deepEqual(result.final.states.map(item=>item.family),['BC','PE','CS']);assert.ok(result.final.states.every(item=>item.evidence_ids[0]===result.final.evidence[0].evidence_id));assert.equal(result.traces.find(item=>item.component==='multi_label_router').gateway.validation_warnings[0].family,'BC');store.close()});

test('router validator allows Patient, Doctor and Structured Evidence for every State family',()=>{for(const source_type of ['patient','doctor','structured'])for(const family of ['BC','PE','PA','CS','CP','LO']){const evidence=[{evidence_id:`${source_type}-${family}`,text:'直接支持该标签的原子事实。',source_type,certainty:.55}],routes=I.normalizeRoutesOutput({routes:[{id:'0',families:[family]}]},evidence);assert.doesNotThrow(()=>I.validateRoutes(routes,evidence),`${family} should allow ${source_type}`)}});

test('pipeline materializes cross-provenance PA and CS States without a source-family gate',async()=>{const{s}=await run([obs('患者担心父母会失望。','doctor'),obs('患者转述医院评定当前风险等级为低风险。','patient',{episode_id:'session-2',turn_id:'2'})]),states=s.statesFor('p'),appraisal=states.find(item=>item.family==='PA'),risk=states.find(item=>item.family==='CS');assert.equal(appraisal.source_type,'doctor');assert.equal(risk.source_type,'patient');s.close()});

test('each family updater versions the same topic only within that family',async()=>{const{s}=await run([obs('我按时服用恩格列净。'),obs('我已经停用恩格列净。','patient',{episode_id:'session-2',turn_id:'2'})]);const states=s.statesFor('p').filter(x=>x.family==='PE');assert.equal(states.length,2);assert.equal(states[1].version,2);assert.deepEqual(states[1].version_chain,[states[0].state_id]);s.close()});

test('explicit medication entities keep independent version chains while aliases update the same drug',async()=>{const{s,r}=await run([obs('我正在服用恩格列净控制血糖。'),obs('我正在服用二甲双胍。','patient',{episode_id:'session-2',turn_id:'2'}),obs('I stopped taking empagliflozin.','patient',{episode_id:'session-3',turn_id:'3'})]),states=s.statesFor('p').filter(item=>item.family==='CS'),firstEmpagliflozin=states.find(item=>/恩格列净/.test(item.value)),metformin=states.find(item=>/二甲双胍/.test(item.value)),latestEmpagliflozin=states.find(item=>/empagliflozin/i.test(item.value));assert.equal(states.length,3);assert.equal(firstEmpagliflozin.version,1);assert.equal(metformin.version,1);assert.deepEqual(metformin.version_chain,[]);assert.equal(latestEmpagliflozin.version,2);assert.deepEqual(latestEmpagliflozin.version_chain,[firstEmpagliflozin.state_id]);assert.equal(r.final.memory.filter(item=>item.family==='CS').length,2);s.close()});

test('parallel family calculation commits nothing when any family validation fails',async()=>{const s=new Store(':memory:'),p=new Pipeline(s),o=obs('我有时恶心。'),prepared=await p.preprocess(o);prepared.routes=prepared.routes.map(route=>({...route,text:''}));await assert.rejects(()=>p.run(o,{prepared,phase:'memory_build'}),/State validation failed/);assert.equal(s.statesFor('p').length,0);assert.equal(s.db.prepare(`SELECT COUNT(*) AS n FROM observations`).get().n,0);s.close()});

test('patient interpretation remains a Patient appraisal',async()=>{const{s,r}=await run([obs('我觉得自己有糖尿病，最近血糖高。')]);assert.ok(r.final.states.some(x=>x.family==='PA'));s.close()});

test('self-harm disclosure, professional risk and safety plan remain PE CS CP',async()=>{const{s}=await run([obs('我有过自伤想法。'),obs('专业评估为高风险。','doctor',{turn_id:'2'}),obs('制定安全计划。','doctor',{turn_id:'3'})]);const states=s.statesFor('p');assert.ok(states.some(x=>x.family==='PE'));assert.ok(states.some(x=>x.family==='CS'));assert.ok(states.some(x=>x.family==='CP'));s.close()});

test('Action Policy reads State memory directly and remains independent from Gates',()=>{const observation=obs('我不确定现在是否还需要吃药。');const action=I.actionPolicy(observation,[]);assert.equal(action.type,'ASK');assert.equal('gate'in action,false)});
test('auditor blocks generator changing the independent Action Policy',()=>{const a={type:'ASK',forbidden_content:[]},g={action_type:'ANSWER',response:'answer',citations:[]};assert.equal(I.audit(a,g).passed,false)});

test('a rolled-back Patient Graph commit is never reported as committed',async()=>{
  const store=new Store(':memory:'),pipeline=new Pipeline(store),commit=store.commitMemory.bind(store);store.commitMemory=()=>{throw new Error('synthetic graph commit failure')};
  await assert.rejects(()=>pipeline.run(obs('患者对青霉素过敏。','structured'),{phase:'conversation'}),/synthetic graph commit failure/);
  const failed=store.listRuns(1)[0],runView=store.getRun(failed.id),trace=runView.traces.at(-1);
  assert.equal(trace.component,'patient_memory_commit');assert.equal(trace.status,'failed');assert.equal(trace.output.committed,false);assert.equal(runView.error.write_progress.committed,false);assert.equal(store.statesFor('p').length,0);assert.equal(store.evidenceFor('p').length,0);
  store.commitMemory=commit;store.close();
});
