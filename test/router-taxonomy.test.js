import test from'node:test';
import assert from'node:assert/strict';
import{pipelineInternals}from'../src/pipeline.js';

const{routeEvidence,validateRoutes}=pipelineInternals;let evidenceSequence=0;
function route(text,sourceType='patient'){const evidence=[{evidence_id:`router-family-evidence-${++evidenceSequence}`,text,source_type:sourceType}],routes=routeEvidence(evidence,{source_type:sourceType});assert.strictEqual(validateRoutes(routes,evidence),routes);return routes[0].families;}
function assertIncludes(text,sourceType,family){const families=route(text,sourceType);assert.equal(families.includes(family),true,`${JSON.stringify(text)} should include ${family}; got ${JSON.stringify(families)}`);return families;}

test('BC routes durable context, constraints, support and medical history',()=>{for(const [text,source]of[['患者长期熬夜已成为固定的生活情境。','patient'],['异地医保和 CGM 费用限制了方案选择。','structured'],['患者的姐姐可陪同复诊，是目前稳定的支持资源。','structured'],['患者既往病史包括 2 型糖尿病。','structured']])assertIncludes(text,source,'BC')});

test('PE routes patient experiences and direct observations',()=>{assertIncludes('患者最近夜间口渴并且多尿。','patient','PE');assertIncludes('患者持续恶心。','structured','PE');const disclosure=assertIncludes('患者披露自己有过自伤想法。','patient','PE');assert.equal(disclosure.includes('CS'),false);assertIncludes('医生观察到患者在会谈时反复流泪、情绪低落。','doctor','PE')});

test('PA preserves confirmation questions, concern and willingness',()=>{assertIncludes('所以这次真的不是我的心脏问题吗？','patient','PA');assertIncludes('患者担心父母会对自己失望。','patient','PA');assertIncludes('患者愿意先从和舍友沟通开始。','patient','PA')});

test('CS routes clinical facts and professional safety judgments',()=>{for(const [text,source]of[['检查显示 UACR 为 52 mg/g。','structured'],['医生临床判断患者当前血糖控制欠佳。','doctor'],['恩格列净的用药状态为已停用。','structured'],['患者对头孢呋辛过敏。','structured'],['患者已完成眼底检查。','structured'],['医生综合证据评定当前自杀风险等级为低风险。','doctor']])assertIncludes(text,source,'CS')});

test('Router classifies by stated meaning instead of Evidence provenance',()=>{assertIncludes('医生记录患者长期熬夜已成为固定生活情境。','doctor','BC');assertIncludes('结构化记录显示患者持续恶心。','structured','PE');assertIncludes('医生记录患者担心父母会失望。','doctor','PA');assertIncludes('患者转述医院综合证据评定当前风险等级为低风险。','patient','CS');assertIncludes('患者转述医生建议下周复诊。','patient','CP');assertIncludes('医生记录患者治疗后症状明显改善。','doctor','LO')});

test('CP routes monitoring, treatment, safety plans and accepted tasks',()=>{assertIncludes('医生建议继续监测空腹和餐后两小时血糖。','doctor','CP');assertIncludes('医生决定重启奥美拉唑治疗。','doctor','CP');assertIncludes('咨询师与患者共同制定了安全计划。','doctor','CP');const agreement=assertIncludes('患者回应：我会按医生建议每天监测并记录血糖。','patient','CP');assert.equal(agreement.includes('PA'),true)});

test('LO requires explicit comparison, response or repeated pattern',()=>{assertIncludes('恩格列净状态由 active → stopped。','structured','LO');assertIncludes('患者服药后口渴明显改善。','patient','LO');assertIncludes('发作频率由每月一次增加到每周两次。','structured','LO');assertIncludes('与上一次住院相比，本次心衰射血分数更低。','structured','LO')});

test('pure questions, reassurance and generic knowledge abstain',()=>{for(const [text,source]of[['医生，我应该怎样改善健康？','patient'],['不会让你一个人在黑暗里摸索。','doctor'],['糖尿病是一种慢性代谢性疾病。','structured']])assert.deepEqual(route(text,source),[],`${JSON.stringify(text)} should abstain`)});

test('a completed test result is not additionally routed as care process',()=>{const families=assertIncludes('检查显示 UACR 为 52 mg/g。','structured','CS');assert.equal(families.includes('CP'),false)});
