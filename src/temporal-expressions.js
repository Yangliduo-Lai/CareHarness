/**
 * Extract only unambiguous calendar expressions from clinical text.
 *
 * Four-digit years may use Chinese markers or common date separators. A
 * two-digit year is accepted only with explicit 年/月 markers, so clinical
 * measurements such as 66.5kg or 90.7 mmHg can never become calendar scopes.
 */
export const RUNTIME_CALENDAR_YEAR_MIN=2000;
export const RUNTIME_CALENDAR_YEAR_MAX=2209;

export function isRuntimeCalendarYear(value){
  const year=Number(value);
  return Number.isInteger(year)&&year>=RUNTIME_CALENDAR_YEAR_MIN&&year<=RUNTIME_CALENDAR_YEAR_MAX;
}

export function canonicalCalendarDate(value){
  const raw=String(value||'').normalize('NFKC').trim(),patterns=[
    /^(?<year>\d{4})\s*年\s*(?<month>\d{1,2})\s*月\s*(?<day>\d{1,2})(?:日)?$/u,
    /^(?<year>\d{4})\s*[-/.]\s*(?<month>\d{1,2})\s*[-/.]\s*(?<day>\d{1,2})(?:$|[T\s])/u,
  ];
  for(const pattern of patterns){const match=pattern.exec(raw);if(match)return validDate(Number(match.groups.year),Number(match.groups.month),Number(match.groups.day));}
  return'';
}

export function canonicalCalendarMonth(value){
  const raw=String(value||'').normalize('NFKC').trim(),patterns=[
    /^(?<year>\d{4})\s*年\s*(?<month>\d{1,2})\s*月$/u,
    /^(?<year>\d{4})\s*[-/.]\s*(?<month>\d{1,2})(?:\s*月)?$/u,
  ];
  for(const pattern of patterns){const match=pattern.exec(raw),year=Number(match?.groups?.year),month=Number(match?.groups?.month);if(match&&isRuntimeCalendarYear(year)&&month>=1&&month<=12)return`${year}-${String(month).padStart(2,'0')}`;}
  return'';
}

export function stripLeadingCalendarExpression(value){
  const text=String(value||'').normalize('NFKC'),patterns=[
    /^(?:于)?(?<year>\d{4})\s*年(?:\s*(?<month>\d{1,2})\s*月(?:\s*(?<day>\d{1,2})\s*日?)?)?[，,:：\s]*/u,
    /^(?:于)?(?<year>\d{4})\s*[-/.]\s*(?<month>\d{1,2})(?:\s*[-/.]\s*(?<day>\d{1,2}))?[，,:：\s]*/u,
  ];
  for(const pattern of patterns){
    const match=pattern.exec(text);if(!match||!isRuntimeCalendarYear(match.groups.year))continue;
    const month=match.groups.month==null?null:Number(match.groups.month),day=match.groups.day==null?null:Number(match.groups.day);
    if(month!=null&&(month<1||month>12))continue;
    if(day!=null&&!validDate(Number(match.groups.year),month,day))continue;
    return text.slice(match[0].length);
  }
  return text;
}

export function explicitDatesInText(value){
  const text=String(value||'').normalize('NFKC'),out=[],patterns=[
    /(?<!\d)(?<year>\d{4})\s*年\s*(?<month>\d{1,2})\s*月\s*(?<day>\d{1,2})(?:日)?/gu,
    /(?<!\d)(?<year>\d{4})\s*[-/.]\s*(?<month>\d{1,2})\s*[-/.]\s*(?<day>\d{1,2})(?!\d)/gu,
    /(?<!\d)(?<year>\d{2})\s*年\s*(?<month>\d{1,2})\s*月\s*(?<day>\d{1,2})(?:日)?/gu,
  ];
  for(const pattern of patterns)for(const match of text.matchAll(pattern)){const rawYear=Number(match.groups.year),year=rawYear<100?2000+rawYear:rawYear,date=validDate(year,Number(match.groups.month),Number(match.groups.day));if(date)out.push(date);}
  return[...new Set(out)];
}

export function explicitMonthsInText(value,exactDates=explicitDatesInText(value)){
  const text=String(value||'').normalize('NFKC'),out=[],patterns=[
    /(?<!\d)(?<year>\d{4})\s*年\s*(?<month>\d{1,2})\s*月/gu,
    /(?<!\d)(?<year>\d{4})\s*[-/.]\s*(?<month>\d{1,2})(?!\s*[-/.]\s*\d)(?!\d)/gu,
    /(?<!\d)(?<year>\d{2})\s*年\s*(?<month>\d{1,2})\s*月/gu,
  ];
  for(const pattern of patterns)for(const match of text.matchAll(pattern)){const rawYear=Number(match.groups.year),year=rawYear<100?2000+rawYear:rawYear,month=Number(match.groups.month);if(isRuntimeCalendarYear(year)&&month>=1&&month<=12)out.push(`${year}-${String(month).padStart(2,'0')}`);}
  const datedMonths=new Set(exactDates.map(date=>String(date).slice(0,7)));
  return[...new Set(out.filter(month=>!datedMonths.has(month)))];
}

function validDate(year,month,day){
  if(!isRuntimeCalendarYear(year))return'';
  const date=new Date(Date.UTC(year,month-1,day));
  return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day?date.toISOString().slice(0,10):'';
}
