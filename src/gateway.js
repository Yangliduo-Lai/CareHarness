import { performance } from 'node:perf_hooks';
import { PROMPTS, promptFor } from './prompts.js';
import { sanitizeSecrets, validateProviderConfig, SchemaError } from './schema.js';

export class ModelGateway {
  constructor(config = { provider: 'mock', model: 'careharness-rules-v1' }) {
    this.config = validateProviderConfig(config);
  }

  publicConfig() { return sanitizeSecrets(this.config); }

  async testConnection() {
    const start = performance.now();
    if (this.config.provider === 'mock') return { ok: true, mock: true, model: this.config.model, latency_ms: performance.now() - start };
    try {
      const response = await fetch(`${this.config.base_url.replace(/\/$/, '')}/models`, {
        headers: this.#headers(), signal: AbortSignal.timeout(this.config.timeout_ms)
      });
      return { ok: response.ok, status: response.status, model: this.config.model, latency_ms: performance.now() - start };
    } catch (error) { return { ok: false, model: this.config.model, error: String(error), latency_ms: performance.now() - start }; }
  }

  async completeJSON(component, input, schemaValidator, mockFactory) {
    const start = performance.now();
    const prompt = promptFor(component, input);
    let raw = '', parsed, retries = 0, error = null;
    try {
      if (this.config.provider === 'mock') {
        parsed = await mockFactory(input);
        raw = JSON.stringify(parsed);
      } else {
        for (let attempt = 0; attempt <= this.config.retries; attempt++) {
          retries = attempt;
          try { raw = await this.#openAI(prompt); parsed = JSON.parse(stripFence(raw)); break; }
          catch (e) { if (attempt === this.config.retries) throw e; }
        }
      }
      parsed = schemaValidator ? schemaValidator(parsed) : parsed;
    } catch (e) {
      error = {
        kind: e instanceof SchemaError ? 'schema_error' : 'model_or_parse_error',
        message: String(e.message || e), validation_errors: e.errors || [],
        suggestion: 'Inspect the raw model response, correct the model/prompt configuration, then rerun this step.'
      };
      throw Object.assign(e, { gatewayTrace: this.#trace(component, input, raw, parsed, start, retries, error) });
    }
    return { value: parsed, trace: this.#trace(component, input, raw, parsed, start, retries, error) };
  }

  async #openAI(prompt) {
    const response = await fetch(`${this.config.base_url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers: this.#headers(), signal: AbortSignal.timeout(this.config.timeout_ms),
      body: JSON.stringify({ model: this.config.model, temperature: this.config.temperature, max_tokens: this.config.max_tokens,
        response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] })
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Provider HTTP ${response.status}: ${raw.slice(0, 1000)}`);
    const body = JSON.parse(raw);
    return body.choices?.[0]?.message?.content ?? '';
  }

  #headers() {
    const key = this.config.api_key_ref ? process.env[this.config.api_key_ref] : '';
    if (!key) throw new Error(`Server environment variable ${this.config.api_key_ref || '(missing api_key_ref)'} is not set`);
    return { 'content-type': 'application/json', authorization: `Bearer ${key}` };
  }

  #trace(component, input, raw, parsed, start, retries, error) {
    const tokensIn = Math.ceil(JSON.stringify(input).length / 4), tokensOut = Math.ceil(String(raw).length / 4);
    return sanitizeSecrets({ component, prompt_version: PROMPTS[component]?.version || 'none', provider: this.config.provider,
      model: this.config.model, config: this.publicConfig(), latency_ms: +(performance.now() - start).toFixed(2),
      token_input: tokensIn, token_output: tokensOut, estimated_cost_usd: 0, retries, raw_model_response: raw,
      parsed_response: parsed ?? null, error, mock: this.config.provider === 'mock' });
  }
}

function stripFence(text) { return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''); }
