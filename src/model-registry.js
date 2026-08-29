import { randomUUID } from 'node:crypto';
import { ModelGateway } from './gateway.js';
import { validateProviderConfig } from './schema.js';

export const MODEL_COMPONENTS = ['extractor', 'router', 'relation_classifier', 'generator', 'auditor', 'investigation_policy', 'judge', 'scoring_judge', 'medlocomo_judge', 'cpcd_judge'];
export const PROVIDER_PRESETS = {
  mock: { label: 'Offline Mock', base_url: '', model: 'careharness-rules-v1' },
  openai: { label: 'OpenAI', base_url: 'https://api.openai.com/v1', model: 'gpt-5-mini' },
  dashscope: { label: '阿里云百炼 / DashScope（北京）', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3.7-flash' },
  deepseek: { label: 'DeepSeek', base_url: 'https://api.deepseek.com', model: 'deepseek-chat' },
  openrouter: { label: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5-mini' },
  'openai-compatible': { label: 'Custom OpenAI-compatible', base_url: '', model: '' }
};

export class ModelRegistry {
  constructor(store) {
    this.store = store;
    this.sessionKeys = new Map();
    if (!store.getModelProfile('offline-mock')) {
      const now = new Date().toISOString();
      store.saveModelProfile({ id: 'offline-mock', name: 'Offline Mock', config: validateProviderConfig({ provider: 'mock', model: 'careharness-rules-v1' }), created_at: now, updated_at: now });
    }
    if (!store.modelAssignments().global) store.saveModelAssignments({ global: 'offline-mock' });
  }

  state() {
    const stored = this.store.modelAssignments(),assignments=Object.fromEntries(['global',...MODEL_COMPONENTS].filter(component=>stored[component]).map(component=>[component,stored[component]]));
    return {
      local_only: true,
      secret_policy: 'API keys stay only in server memory and are never returned, logged, traced, exported, or persisted.',
      presets: PROVIDER_PRESETS,
      components: MODEL_COMPONENTS,
      assignments,
      profiles: this.store.listModelProfiles().map(profile => this.#publicProfile(profile))
    };
  }

  save(payload) {
    const id = payload.id || randomUUID();
    const prior = this.store.getModelProfile(id);
    const config = validateProviderConfig(payload.config || payload);
    const now = new Date().toISOString();
    if (typeof payload.api_key === 'string' && payload.api_key.trim()) this.sessionKeys.set(id, payload.api_key.trim());
    this.store.saveModelProfile({ id, name: String(payload.name || prior?.name || config.model).trim(), config, created_at: prior?.created_at || now, updated_at: now });
    return this.#publicProfile(this.store.getModelProfile(id));
  }

  assign(assignments, { replace = true } = {}) {
    const allowed = new Set(['global', ...MODEL_COMPONENTS]);
    const clean = {};
    for (const [component, profileId] of Object.entries(assignments || {})) {
      if (!allowed.has(component)) throw new Error(`Unknown model component: ${component}`);
      if (!this.store.getModelProfile(profileId)) throw new Error(`Unknown model profile: ${profileId}`);
      clean[component] = profileId;
    }
    const prior=this.store.modelAssignments();
    if (!clean.global) clean.global = prior.global || 'offline-mock';
    if (replace) this.store.replaceModelAssignments(clean); else this.store.saveModelAssignments(clean);
    return this.state();
  }

  delete(profileId) {
    if (profileId === 'offline-mock') throw new Error('The built-in Offline Mock profile cannot be deleted');
    const usedBy=Object.entries(this.store.modelAssignments()).filter(([,id])=>id===profileId).map(([component])=>component);
    if (usedBy.length) throw new Error(`Model profile is assigned to: ${usedBy.join(', ')}; reassign those components first`);
    this.sessionKeys.delete(profileId);
    if (!this.store.deleteModelProfile(profileId)) throw new Error(`Unknown model profile: ${profileId}`);
    return this.state();
  }

  gateway(component = 'global') {
    const assignments = this.store.modelAssignments();
    const profileId = assignments[component] || assignments.global || 'offline-mock';
    const profile = this.store.getModelProfile(profileId);
    if (!profile) throw new Error(`Configured model profile is missing: ${profileId}`);
    return new ModelGateway(profile.config, { apiKey: this.sessionKeys.get(profileId) });
  }

  gatewayForProfile(profileId) {
    const profile = this.store.getModelProfile(profileId);
    if (!profile) throw new Error(`Unknown model profile: ${profileId}`);
    return new ModelGateway(profile.config, { apiKey: this.sessionKeys.get(profileId) });
  }

  pipelineOptions() {
    const gateways = Object.fromEntries(MODEL_COMPONENTS.filter(x => !['investigation_policy','judge','scoring_judge','medlocomo_judge','cpcd_judge'].includes(x)).map(component => [component, this.gateway(component)]));
    return { gateway: this.gateway('global'), componentGateways: gateways, model: this.gateway('global').publicConfig(), component_models: Object.fromEntries(Object.entries(gateways).map(([k, g]) => [k, g.publicConfig()])) };
  }

  assignmentSnapshot() {
    const assignments=this.store.modelAssignments();
    return Object.fromEntries(['global',...MODEL_COMPONENTS].map(component=>[component,{profile_id:assignments[component]||assignments.global||'offline-mock',...this.gateway(component).publicConfig()}]));
  }

  #publicProfile(profile) {
    const environmentReady = Boolean(profile.config.api_key_ref && process.env[profile.config.api_key_ref]);
    return { ...profile, credential: profile.config.provider === 'mock' ? 'not-required' : this.sessionKeys.has(profile.id) ? 'session-memory' : environmentReady ? 'environment' : 'missing' };
  }
}
