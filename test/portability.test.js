import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,readdirSync } from 'node:fs';
import { dirname,extname,join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');

test('collaborator runtime files contain no developer-machine absolute paths',()=>{
  const files=[resolve(root,'package.json'),resolve(root,'.env.example'),...filesUnder(resolve(root,'src')),...filesUnder(resolve(root,'scripts'))];
  const violations=[];
  for(const file of files){
    const text=readFileSync(file,'utf8');
    if(/\/Users\/[^/]+\//.test(text)||/Medical Harness/.test(text))violations.push(file.slice(root.length+1));
  }
  assert.deepEqual(violations,[],'runtime files must use project-relative paths or environment variables');
});

test('shared environment template is portable and contains no credential value',()=>{
  const env=readFileSync(resolve(root,'.env.example'),'utf8');
  assert.match(env,/^PORT=\d+$/m);
  assert.match(env,/^CAREHARNESS_DATA_ROOT=\.\//m);
  assert.match(env,/^CAREHARNESS_DB_PATH=\.\//m);
  assert.match(env,/^OPENAI_API_KEY=$/m);
  assert.match(env,/^CAREHARNESS_MATCHED_API_KEY=$/m);
  assert.match(env,/^CAREHARNESS_RUN_KEY=$/m);
  assert.doesNotMatch(env,/^\w*(?:KEY|TOKEN|SECRET)=.+$/m);
  const ignore=readFileSync(resolve(root,'.gitignore'),'utf8');
  assert.match(ignore,/^\.env$/m);
  assert.match(ignore,/^data\/\*\.sqlite$/m);
  assert.match(ignore,/^data\/benchmarks\/$/m);
  assert.match(ignore,/^reports\/medmemory-careharness-results\.json$/m);
  assert.match(ignore,/^reports\/optimization-round-\*\.json$/m);
});

function filesUnder(directory){
  return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
    const path=join(directory,entry.name);
    if(entry.isDirectory())return filesUnder(path);
    return ['.js','.json'].includes(extname(entry.name))?[path]:[];
  });
}
