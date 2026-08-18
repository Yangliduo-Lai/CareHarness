import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MedMemoryAdapter } from './medmemory.js'; import { MedLoCoMoAdapter } from './medlocomo.js'; import { MusPsyAdapter } from './muspsy.js'; import { MediLongChatAdapter } from './medilongchat.js'; import { CpcdBenchAdapter } from './cpcdbench.js';
const defaultRoot=()=>[resolve('data/benchmarks'),resolve('../..','Medical Harness','Datasets')].find(existsSync)||resolve('data/benchmarks');
export function adapters(root=process.env.CAREHARNESS_DATA_ROOT||defaultRoot()){return{medmemorybench:new MedMemoryAdapter(root),medlocomo:new MedLoCoMoAdapter(root),muspsy:new MusPsyAdapter(root),medilongchat:new MediLongChatAdapter(root),cpcdbench:new CpcdBenchAdapter(root)};}
