// Interpret an answer against the pending question, rather than matching a
// global "yes". This layer supplies intent only; services still own actions.
export function normalizeSpeech(text='') {
  return String(text).normalize('NFKC').toLowerCase().replace(/[’]/g,"'")
    .replace(/हाँ|हां/g,' haan ').replace(/नहीं|नही/g,' nahi ').replace(/मत/g,' mat ')
    .replace(/कर दीजिए|कर दीजिये|कर दो|कर दें|करदो/g,' kar do ')
    .replace(/बंद/g,' band ').replace(/कार्ड/g,' card ').replace(/खाता/g,' account ')
    .replace(/रीडीम|रिडीम/g,' redeem ').replace(/पॉइंट्स|पॉइंट|प्वाइंट्स/g,' points ')
    .replace(/\b(?:ridim|redim|redeam|reedeem)\b/g,'redeem')
    .replace(/\b(?:ha|haa+|han|haanji|hanji)\b/g,'haan').replace(/\bkardo\b/g,'kar do')
    .replace(/\bkarlo\b/g,'kar lo').replace(/\bbandh\b/g,'band')
    .replace(/[,.!।]/g,' ').replace(/\s+/g,' ').trim();
}
export function conversationLanguage(text,previous='en-IN') {
  if(/[\u0900-\u097f]/.test(text)||/\b(?:haa+n?|han|haanji|kardo|karlo|nahi|nahin|mat|mera|mere|mujhe|aap|kitn[aei]|kya|kaise|kyun|kho|gum|gaya|kijiye)\b|\bkar (?:do|lo|dijiye)\b/i.test(text))return 'hi-IN';
  if(/^(?:yes|no|okay|ok|sure|skip|redeem|hello|hi)[.!? ]*$/i.test(text))return previous;
  return text?'en-IN':previous;
}
export function pendingAction(s={}) {
  if(s.state==='CARD_SECURITY')return 'security_choice';
  if(s.onboarding&&s.onboarding.phase!=='READY')return null;
  if(s.state==='DECIDE'&&s.currentOffer)return 'accept_offer';
  if(s.state==='CLOSURE_FLOW'&&s.closureStep==='points')return 'redeem_points';
  if(s.state==='CLOSURE_FLOW'&&s.closureStep==='confirm')return 'confirm_closure';
  return null;
}
const negative=s=>/\b(?:no|not|don't|do not|never|nahi|nahin|mat|nako)\b/.test(s);
const hypothetical=s=>/\b(?:if|unless|suppose|hypothetical|what happens|what would|agar|maan lo|first explain|tomorrow|later|kal|baad me|after)\b/.test(s);
export const explicitAffirmation=text=>/^(?:yes|haan|ji haan)(?: (?:please|kar|do|lo|dijiye|kijiye|proceed|it|then|fir|ab|now|ji))*[? ]*$/.test(normalizeSpeech(text))&&!String(text).includes('?');
const assent=s=>explicitAffirmation(s)||/^(?:sure|okay|ok|theek hai|bilkul|go ahead|please proceed|ठीक है)[ ]*$/.test(s);
export function isConversationalQuestion(text) {
  const s=normalizeSpeech(text);
  return /\?|^(?:what|why|when|where|which|who|how|tell me|explain)|\b(?:kitn[aei]|kya hoga|kaise|kyun|kab|batao|bataiye|matlab)\b|क्या|कितन|कैसे|क्यों|समझा/.test(s);
}
export function cardIncident(text) {
  const s=normalizeSpeech(text),card=/\b(?:card|wallet)\b|कार्ड|बटुआ/.test(s);
  if(!card)return null;
  if(/\b(?:lost interest|lost (?:my |all )?points|lose points|losing points|points.*lost)\b/.test(s))return null;
  if(/\b(?:found (?:it|my card|the card)|false alarm|mil gaya|mil gya)\b|\b(?:not|never|haven't|have not|didn't|did not|wasn't|was not|isn't|is not).{0,20}\b(?:lost|lose|stolen|missing)\b|मिल गया|खोया नहीं/.test(s))return {kind:'recovered'};
  const reported=/\b(?:lost|stolen|missing|misplaced|can't find|cannot find|kho|gum|ghum|chori)\b|खो गया|गुम|चोरी/.test(s);
  if(!reported)return null;
  const kind=/stolen|chori|चोरी/.test(s)?'stolen':'lost';
  return {kind,hypothetical:/\b(?:if|suppose|what if|agar|kabhi)\b/.test(s)};
}
export function contextualIntent(text,s={}) {
  const value=normalizeSpeech(text),pending=pendingAction(s);
  const result=(intent,target,explicit=false)=>({intent,target,explicit,source:'dialogue_context'});
  if(!/\b(?:redeem|redemption)\b/.test(value)&&/\b(?:you (?:keep|are) repeating|same (?:line|thing) again|stuck|don't understand|do not understand|samajh nahi|samajh me nahi|baar baar|bar bar|samjhao)\b|बार बार|समझ नहीं/.test(value))return result('explain_step',pending);
  const redeem=/\b(?:redeem|redemption|redeeming)\b/.test(value);
  if(redeem){
    const info=hypothetical(value)||/\b(?:why|how|what|when|worth|value|cash|money|paise|matlab|kitn[aei]|batao|bataiye|samjhao)\b|^(?:should|can i|could i|do i|would i)\b|कितन|कैसे|क्यों/.test(value);
    if(info)return result('question','redeem_points');
    if(negative(value)){
      const negatedSkip=/\b(?:don't|do not|mat) skip\b/.test(value)&&!/\b(?:don't|do not|never|mat) redeem\b|redeem.*\b(?:nahi|nahin|mat)\b/.test(value);
      if(!negatedSkip){
        const explicitNegative=/\b(?:don't|do not|never|mat) redeem\b|redeem.*\b(?:nahi|nahin|mat)\b/.test(value)||/^(?:no|nahi|nahin) (?:redeem|points redeem)$/.test(value);
        return result(explicitNegative?(pending==='redeem_points'?'skip':'redemption_declined'):'question','redeem_points',true);
      }
    }
    // The simulator redeems the complete balance; partial or conditional asks
    // need an explanation instead of silently redeeming a different amount.
    if(/\d|\b(?:some|half|only|sirf|thode|aadhe)\b/.test(value))return result('question','redeem_points');
    const request=/\b(?:kar do|kar lo|kijiye|dijiye|please|do it|go ahead|redeem (?:them|it|my|the|all|points)|can you redeem|could you redeem|yes|haan)\b/.test(value)||/^(?:redeem|redeem points|points redeem)$/.test(value);
    if(request)return result('redeem','redeem_points',true);
  }
  if(pending&&pending!=='security_choice'&&!negative(value)&&!hypothetical(value)){
    if(pending==='confirm_closure'&&/^(?:yes|haan|ji haan)(?: (?:please|close|closure|band|kar|do|dijiye|kijiye|my|the|this|card|account|it|now|ab|fir|permanently))*$/.test(value)&&/\b(?:close|closure|band)\b/.test(value))return result('accept',pending,true);
    if(assent(value))return result(pending==='redeem_points'?'redeem':'accept',pending,false);
  }
  if(isConversationalQuestion(text))return result('question',null);
  return null;
}

export function classifierContext(s) {
  return {state:s.state,pendingAction:pendingAction(s),lastAssistant:s.transcript?.findLast(m=>m.role==='assistant')?.text?.slice(0,500)||'',recentMessages:s.transcript?.slice(-4).map(m=>({role:m.role,text:m.text.slice(0,300)}))||[]};
}
export function canUseModel(s) {
  return (!s.onboarding||s.onboarding.phase==='READY')&&!s.intentClarification&&(['ANALYSE','FIND_REASON','DECIDE','CARD_SECURITY'].includes(s.state)||(s.state==='CLOSURE_FLOW'&&s.closureStep==='points'));
}
