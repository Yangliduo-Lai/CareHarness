import { performance } from 'node:perf_hooks';
import { PROMPTS,gatewayConnectionTestPrompt,promptFor,promptRetryInstruction,promptTextRetryInstruction } from './prompts.js';
import { sanitizeSecrets, validateProviderConfig, SchemaError } from './schema.js';

export class ModelGateway {
  constructor(config = { provider: 'mock', model: 'careharness-rules-v1' }, secrets = {}) {
    this.config = validateProviderConfig(config);
    this.apiKey = secrets.apiKey || '';
  }

  publicConfig() { return sanitizeSecrets(this.config); }

  async testConnection() {
    const start = performance.now();
    if (this.config.provider === 'mock') return { ok: true, mock: true, model: this.config.model, latency_ms: performance.now() - start };
    let models=[],models_status=null,models_error=null;
    try {
      const response = await fetch(`${this.config.base_url.replace(/\/$/, '')}/models`, {
        headers: this.#headers(), signal: AbortSignal.timeout(this.config.timeout_ms)
      });
      const raw=await response.text();let body=null;try{body=JSON.parse(raw)}catch{}
      models_status=response.status;models=Array.isArray(body?.data)?body.data.slice(0,100).map(x=>x.id).filter(Boolean):[];
      if(!response.ok)models_error=this.#redact(raw.slice(0,500));
    } catch (error) { models_error=this.#redact(String(error)); }
    try {
      const completion=await this.#openAI(gatewayConnectionTestPrompt());
      const parsed=JSON.parse(stripFence(completion.content));
      return { ok: parsed?.ok===true, inference_ok: parsed?.ok===true, models_status, model:this.config.model, model_available:models.length?models.includes(this.config.model):null, models, models_error, response:parsed, latency_ms:performance.now()-start };
    } catch(error) { return {ok:false,inference_ok:false,models_status,model:this.config.model,model_available:models.length?models.includes(this.config.model):null,models,models_error,error:this.#redact(String(error)),latency_ms:performance.now()-start}; }
  }

  async completeJSON(component, input, schemaValidator, mockFactory, options={}) {
    const start = performance.now();
    const prompt = promptFor(component, input);
    const officialMessages=typeof PROMPTS[component]?.messages==='function'?PROMPTS[component].messages(input):null;
    const structuredOutput=structuredOutputContract(component,input,this.config);
    let raw = '', parsed, retries = 0, error = null, attempts=[], finishReason=null, requestedMaxTokens=this.config.max_tokens;
    try {
      if (this.config.provider === 'mock') {
        parsed = await mockFactory(input);
        raw = JSON.stringify(parsed);
        parsed = schemaValidator ? schemaValidator(parsed) : parsed;
      } else {
        for (let attempt = 0; attempt <= this.config.retries; attempt++) {
          retries = attempt;
          try {
            const previous=attempts.at(-1),repairInstruction=attempt?promptRetryInstruction(component,previous):null,repair=repairInstruction?`${prompt}\n\n${repairInstruction}`:prompt;
            requestedMaxTokens=this.#outputBudget(component,input,attempt,options.maxTokens);finishReason=null;const messages=officialMessages?(repairInstruction?[...officialMessages,{role:'user',content:repairInstruction}]:officialMessages):null,completion=await this.#openAI(repair,requestedMaxTokens,messages,structuredOutput.response_format);raw=completion.content;finishReason=completion.finish_reason;
            if(finishReason==='length')throw new Error(`Model output was truncated at max_tokens=${requestedMaxTokens}`);
            parsed = parseJSONResponse(raw,Boolean(options.extractJsonObject)); parsed = schemaValidator ? schemaValidator(parsed) : parsed;
            attempts.push({attempt,raw,parsed,finish_reason:finishReason,max_tokens:requestedMaxTokens,usage:completion.usage}); break;
          } catch (e) { attempts.push({attempt,raw,error:String(e.message||e),validation_errors:e.errors||[],finish_reason:finishReason,max_tokens:requestedMaxTokens}); if (attempt === this.config.retries) throw e;await backoff(attempt,e); }
        }
      }
    } catch (e) {
      error = {
        kind: classifyError(e),
        message: String(e.message || e), validation_errors: e.errors || [],
        suggestion: 'Inspect the raw model response, correct the model/prompt configuration, then rerun this step.'
      };
      const gatewayTrace=this.#trace(component, input, prompt, raw, parsed, start, retries, error, attempts,finishReason,requestedMaxTokens,{...options,structuredOutput});gatewayTrace.input=input;
      throw Object.assign(e, { gatewayTrace });
    }
    return { value: parsed, trace: this.#trace(component, input, prompt, raw, parsed, start, retries, error, attempts,finishReason,requestedMaxTokens,{...options,structuredOutput}) };
  }

  async completeText(component,input,mockFactory,options={}){
    const start=performance.now(),prompt=promptFor(component,input),officialMessages=typeof PROMPTS[component]?.messages==='function'?PROMPTS[component].messages(input):null;let raw='',value='',retries=0,error=null,attempts=[],finishReason=null,requestedMaxTokens=this.config.max_tokens;
    try{
      if(this.config.provider==='mock'){value=String(await mockFactory(input)||'').trim();raw=value;if(!value)throw new Error('Model provided no response');}
      else for(let attempt=0;attempt<=this.config.retries;attempt++){
        retries=attempt;
        try{
          const previous=attempts.at(-1),repairInstruction=attempt?promptTextRetryInstruction(component,input,previous):null,messages=officialMessages?(repairInstruction?[...officialMessages,{role:'user',content:repairInstruction}]:officialMessages):null,repair=repairInstruction?`${prompt}\n\n${repairInstruction}`:prompt;
          requestedMaxTokens=this.#outputBudget(component,input,attempt,options.maxTokens);const completion=await this.#openAI(repair,requestedMaxTokens,messages,null);raw=completion.content;finishReason=completion.finish_reason;if(finishReason==='length')throw new Error(`Model output was truncated at max_tokens=${requestedMaxTokens}`);value=String(raw||'').trim();if(!value)throw new Error('Model provided no response');attempts.push({attempt,raw,parsed:value,finish_reason:finishReason,max_tokens:requestedMaxTokens,usage:completion.usage});break;
        }catch(e){attempts.push({attempt,raw,error:String(e.message||e),finish_reason:finishReason,max_tokens:requestedMaxTokens});if(attempt===this.config.retries)throw e;await backoff(attempt,e);}
      }
    }catch(e){error={kind:classifyError(e),message:String(e.message||e),validation_errors:e.errors||[],suggestion:'Inspect the raw model response, correct the model/prompt configuration, then rerun this step.'};const structuredOutput={response_format:null,enforcement:'plain_text'},gatewayTrace=this.#trace(component,input,prompt,raw,value,start,retries,error,attempts,finishReason,requestedMaxTokens,{...options,structuredOutput});gatewayTrace.input=input;throw Object.assign(e,{gatewayTrace});}
    const structuredOutput={response_format:null,enforcement:'plain_text'};return{value,trace:this.#trace(component,input,prompt,raw,value,start,retries,error,attempts,finishReason,requestedMaxTokens,{...options,structuredOutput})};
  }

  async #openAI(prompt,maxTokens=this.config.max_tokens,messages=null,responseFormat={type:'json_object'}) {
    const tokenBudget = tokenBudgetParameter(this.config) === 'max_completion_tokens'
      ? { max_completion_tokens: maxTokens }
      : { max_tokens: maxTokens };
    const response = await fetch(`${this.config.base_url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers: this.#headers(), signal: AbortSignal.timeout(this.config.timeout_ms),
      body: JSON.stringify({ model: this.config.model, temperature: this.config.temperature, ...tokenBudget,...(Number.isInteger(this.config.seed)?{seed:this.config.seed}:{}),...(this.config.provider==='dashscope'?{enable_thinking:false}:{}),
        ...(responseFormat?{response_format:responseFormat}:{}),messages:messages||[{role:'user',content:prompt}] })
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Provider HTTP ${response.status}: ${this.#redact(raw.slice(0, 1000))}`);
    const body = JSON.parse(raw);
    return{content:body.choices?.[0]?.message?.content??'',finish_reason:body.choices?.[0]?.finish_reason??null,usage:body.usage??null};
  }

  #outputBudget(component,input,attempt,override){const configured=Number(this.config.max_tokens)||1200,ceiling=Math.max(8192,configured);if(Number.isInteger(override)&&override>0)return Math.min(ceiling,override*(2**attempt));const chars=typeof input==='string'?input.length:JSON.stringify(input||{}).length,estimated=component==='extractor'?Math.ceil(chars*2.5):component==='router'?Math.ceil(chars*.7):configured,initial=Math.min(ceiling,Math.max(configured,estimated));return attempt?Math.min(ceiling,initial*(2**attempt)):initial;}

  #headers() {
    const key = this.apiKey || (this.config.api_key_ref ? process.env[this.config.api_key_ref] : '');
    if (!key) throw new Error(`No API key is available for ${this.config.provider}; enter one in the web settings page or configure ${this.config.api_key_ref || 'an environment variable reference'}`);
    return { 'content-type': 'application/json', authorization: `Bearer ${key}` };
  }

  #redact(text) { return this.apiKey ? String(text).split(this.apiKey).join('[REDACTED]') : String(text); }

  #trace(component, input, prompt, raw, parsed, start, retries, error, attempts=[],finishReason=null,requestedMaxTokens=this.config.max_tokens,options={}) {
    const tokensIn = Math.ceil(prompt.length / 4), tokensOut = Math.ceil(String(raw).length / 4);
    return sanitizeSecrets({ component, prompt_version: PROMPTS[component]?.version || 'none', provider: this.config.provider,
      model: this.config.model, config: this.publicConfig(), latency_ms: +(performance.now() - start).toFixed(2),finish_reason:finishReason,requested_max_tokens:requestedMaxTokens,token_budget_parameter:tokenBudgetParameter(this.config),
      token_input: tokensIn, token_output: tokensOut, estimated_cost_usd: 0, retries, raw_model_response: raw,
      model_input:input, prompt, parsed_response: parsed ?? null, raw_model_attempts:attempts, response_format:options.structuredOutput?.response_format,
      output_json_schema:options.structuredOutput?.json_schema||options.structuredOutput?.response_format?.json_schema||null,
      schema_enforcement:options.structuredOutput?.enforcement||'json_object',error, mock: this.config.provider === 'mock' });
  }
}

function tokenBudgetParameter(config){
  const model=String(config?.model||'').toLowerCase().split('/').at(-1);
  return /^(?:gpt-5(?:[.-]|$)|o[1-9](?:[.-]|$))/.test(model)?'max_completion_tokens':'max_tokens';
}

function stripFence(text) { return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''); }
function parseJSONResponse(text,allowEmbedded=false){const cleaned=stripFence(String(text||''));try{return JSON.parse(cleaned)}catch(error){if(!allowEmbedded)throw error;const embedded=firstJSONObject(cleaned);if(!embedded)throw error;return JSON.parse(embedded);}}
function firstJSONObject(text){const start=text.indexOf('{');if(start<0)return null;let depth=0,inString=false,escaped=false;for(let index=start;index<text.length;index++){const character=text[index];if(escaped){escaped=false;continue;}if(character==='\\'&&inString){escaped=true;continue;}if(character==='"'){inString=!inString;continue;}if(inString)continue;if(character==='{')depth++;else if(character==='}'&&--depth===0)return text.slice(start,index+1);}return null;}
function classifyError(error){const message=String(error?.message||error);if(error instanceof SchemaError)return'schema_error';if(/truncated|max_tokens/i.test(message))return'truncated_output';if(/timeout|aborted/i.test(message))return'timeout';if(/fetch failed|network|socket|ECONN|ENOTFOUND/i.test(message))return'transport_error';return'model_or_parse_error';}
function backoff(attempt,error){const message=String(error?.message||error),delay=/fetch failed|network|socket|ECONN|ENOTFOUND|timeout|aborted/i.test(message)?500*(attempt+1):100;return new Promise(resolve=>setTimeout(resolve,delay));}

const ROUTER_FAMILIES=['BC','PE','PA','CS','CP','LO'];
function structuredOutputContract(component,input,config){
  const contract=componentJsonSchema(component,input);
  if(!contract)return{response_format:{type:'json_object'},enforcement:'json_object'};
  if(supportsNativeJsonSchema(config))return{response_format:{type:'json_schema',json_schema:contract},enforcement:'provider_strict_json_schema'};
  return{response_format:{type:'json_object'},json_schema:contract,enforcement:'application_strict_json_schema'};
}
function componentJsonSchema(component,input){
  if(component!=='router')return null;
  const count=Array.isArray(input)?input.length:0;
  return{name:'memory_family_assignments',strict:true,schema:{type:'object',additionalProperties:false,properties:{families:{type:'array',minItems:count,maxItems:count,items:{type:'array',uniqueItems:true,items:{type:'string',enum:ROUTER_FAMILIES}}}},required:['families']}};
}
function supportsNativeJsonSchema(config){
  if(config?.capabilities?.includes('json_schema'))return true;
  if(config?.provider!=='dashscope')return false;
  return/^qwen3\.(?:7)-(?:plus|max)(?:$|-)|^qwen3\.8-max(?:$|-)/i.test(String(config.model||''));
}
