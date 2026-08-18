import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { ModelRegistry } from '../src/model-registry.js';

test('web-entered API key stays in memory while profile and assignments persist without it', () => {
  const store = new Store(':memory:');
  const registry = new ModelRegistry(store);
  const profile = registry.save({
    name: 'Private DeepSeek',
    api_key: 'super-secret-value',
    config: { provider: 'deepseek', base_url: 'https://api.deepseek.com', model: 'deepseek-chat' }
  });
  registry.assign({ global: profile.id, extractor: profile.id });
  const persisted = store.db.prepare('SELECT config_json FROM model_profiles WHERE id=?').get(profile.id).config_json;
  assert.equal(persisted.includes('super-secret-value'), false);
  assert.equal(JSON.stringify(registry.state()).includes('super-secret-value'), false);
  assert.equal(registry.state().profiles.find(x => x.id === profile.id).credential, 'session-memory');
  assert.equal(registry.gateway('extractor').apiKey, 'super-secret-value');
  assert.equal(JSON.stringify(registry.assignmentSnapshot()).includes('super-secret-value'), false);
  store.close();
});

test('component assignment can return to inherited global model', () => {
  const store = new Store(':memory:');
  const registry = new ModelRegistry(store);
  const profile = registry.save({ name: 'Other', config: { provider: 'openai-compatible', base_url: 'https://example.test/v1', model: 'other' } });
  registry.assign({ global: 'offline-mock', generator: profile.id });
  assert.equal(registry.state().assignments.generator, profile.id);
  registry.assign({ global: 'offline-mock' });
  assert.equal(registry.state().assignments.generator, undefined);
  assert.equal(registry.gateway('generator').config.model, 'careharness-rules-v1');
  store.close();
});

test('partial assignment update keeps global while full replacement clears overrides', () => {
  const store = new Store(':memory:');
  const registry = new ModelRegistry(store);
  const profile = registry.save({ name: 'Other', config: { provider: 'openai-compatible', base_url: 'https://example.test/v1', model: 'other' } });
  registry.assign({ global: profile.id }, { replace: false });
  assert.equal(registry.state().assignments.global, profile.id);
  registry.assign({ global: profile.id, judge: 'offline-mock' });
  registry.assign({ global: profile.id });
  assert.equal(registry.state().assignments.judge, undefined);
  store.close();
});

test('connection test performs authenticated model listing and real JSON inference', async () => {
  const store = new Store(':memory:');
  const registry = new ModelRegistry(store);
  const profile = registry.save({ name: 'Fake', api_key: 'memory-key', config: { provider: 'openai-compatible', base_url: 'https://provider.test/v1', model: 'live-model' } });
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'live-model' }] }), { status: 200 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
  };
  try {
    const result = await registry.gatewayForProfile(profile.id).testConnection();
    assert.equal(result.ok, true);
    assert.equal(result.model_available, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.headers.authorization, 'Bearer memory-key');
  } finally { globalThis.fetch = originalFetch; store.close(); }
});

test('active model components contain no Gate assignments', () => {
  const store = new Store(':memory:');
  const registry = new ModelRegistry(store);
  assert.deepEqual(registry.state().components, ['extractor', 'router', 'generator', 'auditor', 'query_planner', 'judge', 'scoring_judge', 'medlocomo_judge', 'cpcd_judge']);
  assert.equal(registry.state().components.includes('answer'),false);
  assert.equal(registry.pipelineOptions().componentGateways.query_planner,undefined);
  assert.equal(registry.pipelineOptions().componentGateways.scoring_judge,undefined);
  assert.equal(registry.pipelineOptions().componentGateways.medlocomo_judge,undefined);
  assert.equal(registry.pipelineOptions().componentGateways.cpcd_judge,undefined);
  store.close();
});

test('model presets expose the official Beijing DashScope endpoint',()=>{const store=new Store(':memory:'),registry=new ModelRegistry(store),preset=registry.state().presets.dashscope;assert.equal(preset.base_url,'https://dashscope.aliyuncs.com/compatible-mode/v1');assert.equal(preset.model,'qwen3.5-flash');store.close()});
