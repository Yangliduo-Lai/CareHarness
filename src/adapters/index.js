import { resolve } from 'node:path';
import { MedMemoryAdapter } from './medmemory.js'; import { MedLoCoMoAdapter } from './medlocomo.js'; import { CpcdBenchAdapter } from './cpcdbench.js';
const defaultRoot=()=>resolve('data/benchmarks');
export function adapters(root=process.env.CAREHARNESS_DATA_ROOT||defaultRoot()){return{medmemorybench:new MedMemoryAdapter(root),medlocomo:new MedLoCoMoAdapter(root),cpcdbench:new CpcdBenchAdapter(root)};}
