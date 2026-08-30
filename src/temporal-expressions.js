/**
 * Extract only unambiguous calendar expressions from clinical text.
 *
 * Four-digit years may use Chinese markers or common date separators. A
 * two-digit year is accepted only with explicit 年/月 markers, so clinical
 * measurements such as 66.5kg or 90.7 mmHg can never become calendar scopes.
 */
export function explicitDatesInText(value){
  const text=String(value||'').normalize('NFKC'),out=[],patterns=[
    /(?<!\d)(?<year>20\d{2})\s*年\s*(?<month>\d{1,2})\s*月\s*(?<day>\d{1,2})(?:日)?/gu,
    /(?<!\d)(?<year>20\d{2})\s*[-/.]\s*(?<month>\d{1,2})\s*[-/.]\s*(?<day>\d{1,2})(?!\d)/gu,
    /(?<!\d)(?<year>\d{2})\s*年\s*(?<month>\d{1,2})\s*月\s*(?<day>\d{1,2})(?:日)?/gu,
  ];
  for(const pattern of patterns)for(const match of text.matchAll(pattern)){const rawYear=Number(match.groups.year),year=rawYear<100?2000+rawYear:rawYear,date=validDate(year,Number(match.groups.month),Number(match.groups.day));if(date)out.push(date);}
  return[...new Set(out)];
}

export function explicitMonthsInText(value,exactDates=explicitDatesInText(value)){
  const text=String(value||'').normalize('NFKC'),out=[],patterns=[
    /(?<!\d)(?<year>20\d{2})\s*年\s*(?<month>\d{1,2})\s*月/gu,
    /(?<!\d)(?<year>20\d{2})\s*[-/.]\s*(?<month>\d{1,2})(?!\s*[-/.]\s*\d)(?!\d)/gu,
    /(?<!\d)(?<year>\d{2})\s*年\s*(?<month>\d{1,2})\s*月/gu,
  ];
  for(const pattern of patterns)for(const match of text.matchAll(pattern)){const rawYear=Number(match.groups.year),year=rawYear<100?2000+rawYear:rawYear,month=Number(match.groups.month);if(month>=1&&month<=12)out.push(`${year}-${String(month).padStart(2,'0')}`);}
  const datedMonths=new Set(exactDates.map(date=>String(date).slice(0,7)));
  return[...new Set(out.filter(month=>!datedMonths.has(month)))];
}

function validDate(year,month,day){
  if(year<2000||year>2099)return'';
  const date=new Date(Date.UTC(year,month-1,day));
  return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day?date.toISOString().slice(0,10):'';
}
