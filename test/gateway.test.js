import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelGateway } from '../src/gateway.js';
import { MEDMEMORY_SHARED_SYSTEM_PROMPT,PROMPTS } from '../src/prompts.js';

test('gateway increases structured-output budget after a length-truncated response',async()=>{
  const gateway=new ModelGateway({provider:'openai-compatible',base_url:'https://provider.test/v1',model:'test-model',max_tokens:1200,retries:1},{apiKey:'memory-key'}),originalFetch=globalThis.fetch,budgets=[],prompts=[];let call=0;
  globalThis.fetch=async(_url,options)=>{const body=JSON.parse(options.body);budgets.push(body.max_tokens);prompts.push(body.messages.at(-1).content);call++;return new Response(JSON.stringify({choices:[{message:{content:call===1?'{"partial":"x"':'{"ok":true}'},finish_reason:call===1?'length':'stop'}],usage:{completion_tokens:call===1?body.max_tokens:4}}),{status:200})};
  try{const result=await gateway.completeJSON('extractor','x'.repeat(1000),value=>value,()=>({ok:true}));assert.deepEqual(budgets,[2500,5000]);assert.equal(result.value.ok,true);assert.equal(result.trace.finish_reason,'stop');assert.equal(result.trace.requested_max_tokens,5000);assert.equal(result.trace.raw_model_attempts[0].finish_reason,'length');assert.match(prompts[1],/Start over from the original INPUT/);assert.match(prompts[1],/at most 24 highest-priority durable Memory Nodes/);assert.doesNotMatch(prompts[1],/\{"partial":"x"/)}finally{globalThis.fetch=originalFetch}
});

test('gateway also increases an explicit component budget after length truncation',async()=>{
  const gateway=new ModelGateway({provider:'dashscope',base_url:'https://provider.test/v1',model:'qwen3.7-flash',max_tokens:1200,retries:1},{apiKey:'memory-key'}),originalFetch=globalThis.fetch,budgets=[];let call=0;
  globalThis.fetch=async(_url,options)=>{const body=JSON.parse(options.body);budgets.push(body.max_tokens);call++;return new Response(JSON.stringify({choices:[{message:{content:call===1?'{}':'{"assessment":"supported"}'},finish_reason:call===1?'length':'stop'}]}),{status:200})};
  try{const result=await gateway.completeJSON('careharness_evaluate',{question:'测试'},value=>value,()=>({}),{maxTokens:3000,extractJsonObject:true});assert.deepEqual(budgets,[3000,6000]);assert.equal(result.value.assessment,'supported');assert.equal(result.trace.requested_max_tokens,6000)}finally{globalThis.fetch=originalFetch}
});

test('DashScope requests disable thinking and send the configured deterministic seed',async()=>{const gateway=new ModelGateway({provider:'dashscope',base_url:'https://dashscope.aliyuncs.com/compatible-mode/v1',model:'qwen3.7-flash',seed:73,retries:0},{apiKey:'dashscope-key'}),originalFetch=globalThis.fetch;let request;globalThis.fetch=async(_url,options)=>{request=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:'{"ok":true}'},finish_reason:'stop'}]}),{status:200})};try{const result=await gateway.completeJSON('judge',{question:'测试'},value=>value,()=>({ok:true}));assert.equal(result.value.ok,true);assert.equal(request.enable_thinking,false);assert.equal(request.seed,73);assert.equal(request.model,'qwen3.7-flash');assert.equal(request.max_tokens,1200);assert.equal(Object.hasOwn(request,'max_completion_tokens'),false)}finally{globalThis.fetch=originalFetch}});

test('GPT-5.1 connection test uses max_completion_tokens without changing the configured budget',async()=>{
  const gateway=new ModelGateway({provider:'openai-compatible',base_url:'https://api.openai-proxy.org/v1',model:'gpt-5.1',max_tokens:1200,retries:0},{apiKey:'closeai-key'}),originalFetch=globalThis.fetch;let request;
  globalThis.fetch=async(url,options)=>{
    if(String(url).endsWith('/models'))return new Response(JSON.stringify({data:[{id:'gpt-5.1'}]}),{status:200});
    request=JSON.parse(options.body);
    return new Response(JSON.stringify({choices:[{message:{content:'{"ok":true}'},finish_reason:'stop'}]}),{status:200});
  };
  try{
    const result=await gateway.testConnection();
    assert.equal(result.ok,true);
    assert.equal(request.max_completion_tokens,1200);
    assert.equal(Object.hasOwn(request,'max_tokens'),false);
  }finally{globalThis.fetch=originalFetch}
});

test('runtime completions honor a configured 10240-token paper ceiling',async()=>{
  const gateway=new ModelGateway({provider:'openai-compatible',base_url:'https://api.openai-proxy.org/v1',model:'gpt-5.1',max_tokens:10240,retries:0},{apiKey:'closeai-key'}),originalFetch=globalThis.fetch;let request;
  globalThis.fetch=async(_url,options)=>{request=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:'论文配置已生效。'},finish_reason:'stop'}]}),{status:200})};
  try{
    const result=await gateway.completeText('medmemory_answer',{task:'state_update',question:'测试',memory_nodes:[]},()=> 'mock');
    assert.equal(request.max_completion_tokens,10240);
    assert.equal(result.trace.requested_max_tokens,10240);
  }finally{globalThis.fetch=originalFetch}
});

test('Router uses provider strict JSON Schema when the selected model supports it',async()=>{const gateway=new ModelGateway({provider:'dashscope',base_url:'https://dashscope.aliyuncs.com/compatible-mode/v1',model:'qwen3.7-plus',retries:0},{apiKey:'dashscope-key'}),originalFetch=globalThis.fetch;let request;globalThis.fetch=async(_url,options)=>{request=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:'{"families":[["PA"],[]]}'},finish_reason:'stop'}]}),{status:200})};try{const input=[{id:'0',text:'a',source:'patient'},{id:'1',text:'b',source:'doctor'}],result=await gateway.completeJSON('router',input,value=>value,()=>null);const families=request.response_format.json_schema.schema.properties.families;assert.equal(request.response_format.type,'json_schema');assert.equal(request.response_format.json_schema.strict,true);assert.equal(families.minItems,2);assert.equal(families.maxItems,2);assert.deepEqual(families.items.items.enum,['BC','PE','PA','CS','CP','LO']);assert.equal(result.trace.schema_enforcement,'provider_strict_json_schema')}finally{globalThis.fetch=originalFetch}});

test('Router applies the same strict application schema when Qwen 3.7 Flash uses JSON Object mode',async()=>{const gateway=new ModelGateway({provider:'dashscope',base_url:'https://dashscope.aliyuncs.com/compatible-mode/v1',model:'qwen3.7-flash',retries:0},{apiKey:'dashscope-key'}),originalFetch=globalThis.fetch;let request;globalThis.fetch=async(_url,options)=>{request=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:'{"families":[["PA"]]}'},finish_reason:'stop'}]}),{status:200})};try{const result=await gateway.completeJSON('router',[{id:'0',text:'a',source:'patient'}],value=>value,()=>null);assert.equal(request.response_format.type,'json_object');assert.equal(result.trace.schema_enforcement,'application_strict_json_schema');assert.equal(result.trace.response_format.type,'json_object');assert.equal(result.trace.output_json_schema.strict,true);assert.equal(result.trace.output_json_schema.schema.properties.families.minItems,1)}finally{globalThis.fetch=originalFetch}});

test('benchmark answer transport keeps the judge JSON call and carries only visible runtime context',async()=>{const gateway=new ModelGateway({provider:'openai-compatible',base_url:'https://provider.test/v1',model:'answer-model',max_tokens:1200,retries:0},{apiKey:'memory-key'}),originalFetch=globalThis.fetch;let request;globalThis.fetch=async(_url,options)=>{request=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:'{"answer":"患者已停用恩格列净。"}'},finish_reason:'stop'}]}),{status:200})};try{const input={task:'state_update',question:'目前是否服药？',answer_contract:{language:'zh-CN',format:'简短状态'},question_request:{question:'目前是否服药？'},memory_nodes:[],memory_edges:[],investigation_trace:[],protocol:null},result=await gateway.completeJSON('judge',input,value=>value,()=>({answer:'mock'}));assert.equal(result.value.answer,'患者已停用恩格列净。');assert.equal(request.response_format.type,'json_object');assert.deepEqual(request.messages.map(message=>message.role),['user']);assert.equal(result.trace.prompt_version,'judge.unified-memory.v8');assert.deepEqual(result.trace.model_input,input);assert.match(request.messages[0].content,/Memory Nodes/);assert.doesNotMatch(request.messages[0].content,/decision[_ -]?gates?/i)}finally{globalThis.fetch=originalFetch}});

test('MedMemory Answer transport uses appendix-plus-overlay messages and plain-text completion',async()=>{
  const gateway=new ModelGateway({provider:'openai-compatible',base_url:'https://provider.test/v1',model:'answer-model',max_tokens:1200,retries:0},{apiKey:'memory-key'}),originalFetch=globalThis.fetch;let request;
  globalThis.fetch=async(_url,options)=>{request=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:'  患者已停用恩格列净。  '},finish_reason:'stop'}]}),{status:200})};
  try{
    const input={task:'state_update',question:'目前是否服药？',memory_nodes:[{memory_id:'m1',text:'患者已停用恩格列净。',families:['PE','CS']}]},result=await gateway.completeText('medmemory_answer',input,()=> 'mock answer');
    assert.deepEqual(request.messages.map(message=>message.role),['system','user']);
    assert.equal(request.messages[0].content,MEDMEMORY_SHARED_SYSTEM_PROMPT);
    assert.ok(request.messages[1].content.endsWith('Answer:'));
    assert.equal(Object.hasOwn(request,'response_format'),false);
    assert.equal(result.value,'患者已停用恩格列净。');
    assert.equal(result.trace.schema_enforcement,'plain_text');
    assert.equal(result.trace.prompt_version,PROMPTS.medmemory_answer.version);
    assert.equal(result.trace.response_format,null);
  }finally{globalThis.fetch=originalFetch}
});

test('official Judge transport accepts the benchmark bracket-extracted JSON form',async()=>{const gateway=new ModelGateway({provider:'openai-compatible',base_url:'https://provider.test/v1',model:'judge-model',retries:0},{apiKey:'memory-key'}),originalFetch=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({choices:[{message:{content:'评判如下：\n{"is_correct":true,"reason":"符合"}\n结束'},finish_reason:'stop'}]}),{status:200});try{const result=await gateway.completeJSON('medmemory_judge',{query_type:'state_update',question:'q',expected_answer:'a',explanation:'e',model_output:'m'},value=>value,()=>null,{extractJsonObject:true,maxTokens:500});assert.equal(result.value.is_correct,true);assert.equal(result.value.reason,'符合')}finally{globalThis.fetch=originalFetch}});
