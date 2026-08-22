export const MEDICAL_ALIAS_GROUPS = Object.freeze([
  ['恩格列净','empagliflozin'],
  ['二甲双胍','metformin'],
  ['头孢呋辛','cefuroxime'],
  ['克拉霉素','clarithromycin'],
  ['阿莫西林','amoxicillin'],
  ['视力模糊','视物模糊','眼睛模糊','看不清','vision','blurry','blurred','blurred vision'],
  ['尿酮体','尿酮','urine ketone','ketone'],
  ['血糖','glucose'],
  ['糖化血红蛋白','糖化','hba1c','a1c'],
  ['慢性代谢性疾病','糖尿病','2型糖尿病','type 2 diabetes','diabetes'],
  ['抗生素','antibiotic'],
  ['过敏','避用','allergy','allergic','avoid'],
  ['监测','测量','monitor','monitoring','measure','measurement'],
  ['空腹','fasting'],
  ['餐后','饭后','postprandial','after meal'],
  ['不适','症状','unwell','symptom'],
  ['体重','weight'],
  ['裤腰','腰围','waist','waistband'],
  ['头痛','头疼','headache'],
  ['喉咙痛','咽痛','sore throat'],
  ['剂量','加量','减量','dose','dosage'],
  ['降糖药','降糖药物','glucose-lowering medication','diabetes medication'],
  ['多饮','口渴','polydipsia','excessive thirst'],
  ['多尿','尿多','polyuria','frequent urination'],
  ['体重下降','掉重','消瘦','weight loss','lost weight'],
  ['乏力','疲劳','fatigue','weakness'],
  ['恶心','nausea'],
  ['停用','停药','stopped','discontinued','ceased']
]);

export function aliasesIn(text){
  const normalized=String(text||'').toLowerCase(),out=[];
  for(const group of MEDICAL_ALIAS_GROUPS)if(group.some(term=>normalized.includes(term.toLowerCase())))out.push(...group);
  return[...new Set(out)];
}

export function canonicalizeMedicalAliases(value){
  return String(value||'')
    .replace(/\bcefuroxime\b/gi,'头孢呋辛')
    .replace(/\bempagliflozin\b/gi,'恩格列净')
    .replace(/\bmetformin\b/gi,'二甲双胍')
    .replace(/\bclarithromycin\b/gi,'克拉霉素')
    .replace(/\bamoxicillin\b/gi,'阿莫西林')
    .trim();
}
