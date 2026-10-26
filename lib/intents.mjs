export const intents = ['fraud_or_dispute','human','closure_firm','closure_soft','reason_given','accept','decline','counter','question','downgrade','stop','skip','other'];
export const explicitYes = text => /^(?:yes|yes please|yes please do|yes please proceed|yes close my card|हाँ|हां|हाँ कर दीजिए|हां कर दीजिए|जी हाँ|जी हां|haan|han|ha)[.!।]*$/i.test(text.trim());
export function reasonOf(text) {
  const s=text.toLowerCase();
  if (/support|service|complaint|सेवा|शिकायत/.test(s)) return 'service_issue';
  if (/another bank|competitor|other bank|rival|दूसर.*बैंक/.test(s)) return 'competitor';
  if (/not us|never us|rarely us|barely us|don't use|do not use|इस्तेमाल नहीं|उपयोग नहीं|use nahi|use nahin/.test(s)) return 'not_using';
  if (/reward|points|रिवार्ड|पॉइंट/.test(s)) return 'low_rewards';
  if (/fee|fees|charge|annual|महंगा|फीस|शुल्क|mehenga/.test(s)) return 'fee';
  return 'unknown';
}
export function classify(text, session={}) {
  const s=text.toLowerCase().replace(/[’]/g,"'").trim(), reason=reasonOf(s);
  const answer=intent=>({intent,reason,source:'rules'});
  if (/(?:unauthori[sz]ed|unrecogni[sz]ed|did not make|didn't make|fraud|stolen|harass|disput|धोखा|धोखाधड़ी|अनधिकृत|चोरी|मैंने नहीं किया|pareshan kar)/.test(s) && !/^(?:there is |this is )?(?:no|not a) (?:fraud|dispute)/.test(s)) return answer('fraud_or_dispute');
  if (/(?:human|real person|talk to a person|agent please|speak to.*person|colleague|इंसान|अधिकारी|किसी व्यक्ति|agent se|aadmi se)/.test(s) && !/(?:don't|do not|no need to).*?(?:human|person|transfer)/.test(s)) return answer('human');
  const close=/(?:clos(?:e|ing|ure)|cancel.*card|card.*cancel|card.*band|band.*card|बंद.*कार्ड|कार्ड.*बंद|बंद कर|बंद करना)/.test(s);
  if (/no offers|don't want to discuss|do not want to discuss|not discuss|बस बंद|बंद कर दो|बंद करो|बंद कर दीजिए|card band karo|close kar do|band kar do/.test(s) || (close && (/just|now|immediately|how.*clos|rather|anyway|बिल्कुल|अभी/.test(s) || session.closureMentions>0 || session.offerCount>0))) return answer('closure_firm');
  if (/^(?:stop|never mind|cancel the request|pause|hold|रुकिए|रुको|रोक दो)(?:[.! ]|$)/.test(s)) return answer('stop');
  if (/^(?:skip|skip it|continue|next|छोड़ दो|छोड़िए|आगे)(?:[.! ]|$)/.test(s)) return answer('skip');
  if (/^(?:no|nope|nah|not interested|don't want it|do not want it|नहीं|नही|नको|nahi|nahin)(?:[,.! ]|$)/.test(s)) return answer('decline');
  if (close) return answer('closure_soft');
  if (session.offerCount>0 && /(?:better|more|instead|two.year|2.year|दो साल|दो वर्ष|drop.*condition|remove.*condition|without.*condition|no spend|बिना.*शर्त|ज्यादा|बढ़ा|माफ|waive|revers|free card|five thousand|\d+[\s,]*off)/.test(s)) return answer('counter');
  if (/^(?:yes|yes please|yes that works|yes please do|that works|i accept|accept|go ahead|please proceed|confirm|हाँ|हां|हाँ कर दीजिए|हां कर दीजिए|जी हाँ|जी हां|ठीक है|haan|han|ha)(?:[.!]*$)/.test(s)) return answer('accept');
  if (/downgrade|free card|no.fee card|lifetime.free|फ्री कार्ड|बिना.*फीस/.test(s)) return answer('downgrade');
  if (/\?|^(?:what|when|how|why|can you explain|tell me|क्या|कब|कैसे|कितन)/.test(s)) return answer('question');
  if(reason!=='unknown')return answer('reason_given');
  return answer('other');
}
export function counterRequest(text) {
  const s=text.toLowerCase();
  if(/%|percent|per cent|प्रतिशत/.test(s))return {kind:'review'};
  if (/two.year|2.year|two years|दो साल|दो वर्ष|upgrade|limit|लिमिट|बढ़ा.*सीमा|without.*condition|no spend|drop.*condition|remove.*condition|बिना.*शर्त/.test(s)) return {kind:'review'};
  if (/revers|refund|charged fee|वापस/.test(s)) return {kind:'reversal'};
  if (/free card|no.fee|downgrade|फ्री कार्ड|बिना.*फीस/.test(s)) return {kind:'downgrade'};
  const numeric=s.match(/\b\d[\d,]*(?:\.\d+)?\b/), amount=numeric?Number(numeric[0].replaceAll(',','')):null;
  if (/points|पॉइंट/.test(s))return {kind:'points',amount};
  if (amount!==null && /waiv|fee|off|माफ|फीस/.test(s)) return {kind:'waiver',amount};
  return {kind:'review'};
}
