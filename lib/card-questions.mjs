import {money,words,digits} from './words.mjs';

// Only fields in the validated session snapshot may supply account facts.
// The dataset contains aggregates, not a dated transaction ledger or an APR.
export function cardFacts(session,text,policy) {
  const c=session.customer,hi=session.language==='hi-IN',s=text.toLowerCase(),answers=[];
  const say=(en,hindi)=>hi?hindi:en;
  if(/who are you|are you.*(?:human|real person|bot|ai)/.test(s))return say('I’m Aria, BombayBank’s virtual assistant for this synthetic demo.','मैं Aria, इस synthetic demo में BombayBank की virtual assistant हूँ।');
  if(/whose (?:card|account)|my name|which (?:card|account|profile)|card ending|last four|last 4|कार्ड नंबर/.test(s))answers.push(say(`We’re looking at ${c.name}’s synthetic ${c.product} card, ending ${digits(c.last4)}.`,`${c.name} का synthetic ${c.product} कार्ड खुला है, जो ${digits(c.last4)} पर समाप्त होता है।`));
  const missing=/interest|\bapr\b|\bgst\b|\btax\b|due date|billing date|fee date|(?:when|date).*(?:charg|refund|credited)|merchant|transaction (?:detail|list|date)|where.*(?:spent|spend)|cash value|rupee value|points worth|ब्याज|तारीख/.test(s);
  if(missing)answers.push(say('That detail isn’t in the validated demo record, so I can’t confirm it. I have the recorded annual fee, dues, points and spending totals.','यह जानकारी validated demo record में नहीं है, इसलिए इसकी पुष्टि नहीं कर सकती। सालाना फीस, बकाया, points और कुल खर्च की जानकारी उपलब्ध है।'));
  if(/score|bureau|cibil|स्कोर|सिबिल/.test(s))answers.push(say(policy.disclosures.bureau,'यह demo credit-score बदलाव का अनुमान नहीं लगाता। सही जानकारी के लिए बैंक का सहकर्मी मदद करेगा।'));
  if(!missing){
    if(/fee|फीस|शुल्क/.test(s)&&!/waiv|revers|refund|offer|condition|शर्त|छूट/.test(s))answers.push(say(`The recorded annual fee on this demo card is ${money(c.annual_fee)}.`,`इस demo कार्ड की दर्ज सालाना फीस ${money(c.annual_fee)} है।`));
    if(/point|reward|पॉइंट|रिवार्ड/.test(s))answers.push(say(`Your demo card currently has ${words(c.reward_points)} reward points.`,`आपके demo कार्ड पर अभी ${words(c.reward_points)} reward points हैं।`));
    if(/dues|outstanding|owe|\bemi\b|बकाया|ईएमआई/.test(s)||(/balance/.test(s)&&!/point|reward/.test(s)))answers.push(c.outstanding_dues===0
      ?say('You have no outstanding dues on this demo card.','इस demo कार्ड पर कोई बकाया नहीं है।')
      :say(`Your recorded total dues are ${money(c.outstanding_dues)}${c.emi_outstanding?`, including ${money(c.emi_outstanding)} in EMIs. The EMI amount is already part of the total`:''}.`,`कुल दर्ज बकाया ${money(c.outstanding_dues)} है${c.emi_outstanding?`, जिसमें ${money(c.emi_outstanding)} EMI पहले से शामिल है`:''}।`));
    if(/credit limit|available limit|लिमिट|सीमा/.test(s))answers.push(say(`The recorded credit limit is ${money(c.credit_limit)}. I don’t have an available-credit calculation in this demo.`,`दर्ज credit limit ${money(c.credit_limit)} है। इस demo में उपलब्ध credit की गणना नहीं है।`));
    if(/(?:have i|i have|i) spent|spending total|spend history|monthly spend|annual spend|last (?:12|twelve) months.*spend/.test(s)){
      const total=c.monthly_spend.reduce((sum,value)=>sum+value,0);
      answers.push(say(`The twelve monthly spending entries in your demo record total ${money(total)}. They don’t include individual transaction details.`,`आपके demo record की बारह मासिक spending entries का कुल ${money(total)} है। अलग-अलग transactions का विवरण उपलब्ध नहीं है।`));
    }
    if(/card status|(?:is|are).*card.*active|product name|card type/.test(s))answers.push(say(`The recorded product is ${c.product}; its source status is ${c.status}.`,`दर्ज product ${c.product} है और source status ${c.status} है।`));
  }
  return answers.length?answers.join(' '):null;
}

export const asksOfferTerms=text=>/offer|condition|terms|waiv|revers|refund|double|cap|months|explain (?:it|that)|repeat|spend.*(?:need|have|required)|शर्त|छूट/.test(text.toLowerCase());
