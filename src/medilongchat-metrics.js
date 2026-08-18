function tokens(value){
  return String(value||'').toLowerCase().match(/[a-z0-9]+|[\p{Script=Han}]/gu)||[];
}

export function mediLongChatTokenF1(output,gold){
  const predicted=tokens(output),reference=tokens(gold);
  if(!predicted.length&&!reference.length)return 1;
  if(!predicted.length||!reference.length)return 0;
  const remaining=new Map();for(const token of reference)remaining.set(token,(remaining.get(token)||0)+1);
  let overlap=0;for(const token of predicted){const count=remaining.get(token)||0;if(count){overlap++;remaining.set(token,count-1);}}
  if(!overlap)return 0;const precision=overlap/predicted.length,recall=overlap/reference.length;return 2*precision*recall/(precision+recall);
}

export function mediLongChatBleu1(output,gold){
  const predicted=tokens(output),reference=tokens(gold);
  if(!predicted.length||!reference.length)return 0;
  const remaining=new Map();for(const token of reference)remaining.set(token,(remaining.get(token)||0)+1);
  let overlap=0;for(const token of predicted){const count=remaining.get(token)||0;if(count){overlap++;remaining.set(token,count-1);}}
  const precision=overlap/predicted.length,brevity=predicted.length>reference.length?1:Math.exp(1-reference.length/predicted.length);
  return brevity*precision;
}

export function scoreMediLongChat(output,item={}){
  const gold=Array.isArray(item.gold)?String(item.gold[0]||''):String(item.gold||'');
  if(item.task==='synthesis_reasoning'){
    const expected=String(item.metadata?.correct_option||gold).trim().toUpperCase(),match=String(output||'').trim().toUpperCase().match(/\b([A-D])\b/),actual=match?.[1]||'';
    const score=actual===expected?1:0;return{score,is_correct:score===1,method:'medilongchat_release_derived_sr_accuracy',reason:score?'Selected the derived correct option.':`Expected option ${expected||'unknown'}, received ${actual||'no option'}.`,details:{protocol_status:'public_release_derived',official_comparable:false,accuracy:score,expected_option:expected,actual_option:actual}};
  }
  const f1=mediLongChatTokenF1(output,gold),bleu1=mediLongChatBleu1(output,gold),score=(f1+bleu1)/2;
  return{score,is_correct:f1===1,method:'medilongchat_release_derived_f1_bleu1',reason:'Token F1 and BLEU-1 on a transparent task derived from the released corpus; this is not an official-paper annotation.',details:{protocol_status:'public_release_derived',official_comparable:false,token_f1:f1,bleu_1:bleu1}};
}
