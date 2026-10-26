import {normalizeSpeech,isConversationalQuestion} from './dialogue.mjs';

export const securityGuidance={
  en:'If a real card is lost or stolen, contact its issuer immediately to block it. This demo cannot block or replace a real card.',
  hi:'अगर असली कार्ड खो गया है या चोरी हुआ है, तो उसे block करने के लिए तुरंत कार्ड जारी करने वाले बैंक से संपर्क करें। इस demo से असली कार्ड block या replace नहीं होता।',
};

export class CardSecurity {
  constructor(engine){this.engine=engine;}
  reply(s,en,hi){return {text:this.engine.say(s,en,hi),kind:'security'};}
  prompt(s,repeat=false){
    const alreadyGiven=s.securityGuidanceGiven;s.securityGuidanceGiven=true;
    return this.reply(s,
      repeat?'Do you want help with blocking/replacing the lost card, or do you want permanent closure of the card account? Please choose one; a yes alone doesn’t tell me which.':`${alreadyGiven?'':securityGuidance.en+' '}Blocking the card and closing the account are different. Would you like a simulated lost-card support case, or do you still want permanent account closure?`,
      repeat?'खोए कार्ड को block या replace करने में मदद चाहिए, या कार्ड का खाता हमेशा के लिए बंद करना है? इनमें से एक बताइए; सिर्फ हाँ से विकल्प स्पष्ट नहीं होता।':`${alreadyGiven?'':securityGuidance.hi+' '}कार्ड block करना और उसका खाता बंद करना अलग हैं। खोए कार्ड के लिए simulated support case बनाएँ, या खाता हमेशा के लिए बंद करना चाहते हैं?`);
  }
  handle(s,text,event,input){
    const value=normalizeSpeech(text),negative=/\b(?:don't|do not|not|nahi|nahin|mat)\b/.test(value);
    const protectRequested=!negative&&/\b(?:block|hotlist|replace|replacement|support case|lost card help)\b|ब्लॉक|बदलना/.test(value)&&(!isConversationalQuestion(text)||/\b(?:can|could|would) you.*(?:block|replace)|kar do|kijiye|dijiye/.test(value));
    if(event.intent==='card_incident'){
      if(s.cardSecurity?.phase==='closure_chosen')return this.reply(s,securityGuidance.en+' Your account-closure checklist is still pending; no account closure has been submitted.',securityGuidance.hi+' खाता बंद करने की checklist अभी बाकी है; अनुरोध जमा नहीं हुआ है।');
      if(!s.cardSecurity||s.cardSecurity.phase==='resolved'){
        s.cardSecurity={kind:event.incident||'lost',phase:'choice',previousState:s.state,previousOffer:s.currentOffer||null};
        s.currentOffer=null;this.engine.services.invalidateConfirmation(s);s.state='CARD_SECURITY';
        this.engine.store.audit(s.id,'GUARDRAIL',{rule:'lost_card_before_retention',incident:s.cardSecurity.kind},this.engine.clock());
      }
      if(s.cardSecurity.phase!=='choice')return this.saved(s);
      if(!protectRequested)return this.prompt(s);
    }
    const incident=s.cardSecurity;
    if(!incident||['resolved','closure_chosen'].includes(incident.phase))return null;
    if(event.intent==='card_recovered'){
      incident.phase='resolved';s.state=incident.previousState;s.currentOffer=incident.previousOffer;
      if(s.state==='CLOSURE_FLOW')s.closureStep='paused';
      return this.reply(s,'Thanks for clarifying that you found the card. I haven’t blocked, replaced or closed it. What would you like help with now?','बताने के लिए धन्यवाद कि कार्ड मिल गया। मैंने इसे block, replace या बंद नहीं किया है। अब किस विषय में मदद चाहिए?');
    }
    const accountClosure=/\b(?:permanent(?:ly)? (?:close|closure|account closure|band)|close (?:the )?account|account (?:close|band)|khata band)\b/.test(value)&&(!isConversationalQuestion(text)||/^(?:haan|yes)\b/.test(value));
    if(input.action==='security_close'||input.action==='close_card'||(!negative&&['closure_firm','closure_soft'].includes(event.intent))||(!negative&&accountClosure)){
      incident.phase='closure_chosen';return this.engine.beginClosure(s);
    }
    if(input.action==='security_support'||protectRequested){
      this.engine.services.invalidateConfirmation(s);s.state='HANDOFF';
      const result=this.engine.services.handoff_to_human(s,'card_security','Lost/stolen card: '+text);
      incident.phase='support_saved';incident.caseId=result.id;s.handoff=result;
      return this.saved(s);
    }
    if(event.intent==='question'){
      if(/cost|fee|charge|delivery|deliver|arriv|when|how long|kitn|kab|फीस|कब|कितना/.test(value)&&/replace|replacement|block|नया कार्ड/.test(value))return this.reply(s,'The demo doesn’t contain verified replacement fees, delivery times or blocking completion details. I can record a simulated support case, but the issuer must confirm those details.','Demo में replacement की verified फीस, delivery का समय या blocking पूरी होने की जानकारी नहीं है। Simulated support case दर्ज कर सकती हूँ; सही जानकारी बैंक को बतानी होगी।');
      if(/block|replace|lost|stolen|security|खो|गुम|चोरी/.test(value))return incident.phase==='support_saved'?this.saved(s):this.prompt(s,true);
      return this.engine.informationReply(s,text);
    }
    if(event.intent==='stop'||event.intent==='keep_card')return this.reply(s,'I won’t continue with account closure. A real lost card still needs to be reported to its issuer for blocking. No card has been blocked in this demo.','खाता बंद करने की प्रक्रिया आगे नहीं बढ़ाऊँगी। असली खोए हुए कार्ड को block कराने के लिए बैंक को सूचना देना अभी भी ज़रूरी है। इस demo ने कोई कार्ड block नहीं किया है।');
    return incident.phase==='support_saved'?this.saved(s):this.prompt(s,true);
  }
  saved(s){return this.reply(s,`I’ve saved simulated lost-card support case ${s.cardSecurity.caseId}. This has not blocked or replaced a real card; please contact the issuer for that. Permanent account closure has not been submitted.`,`खोए कार्ड का simulated support case ${s.cardSecurity.caseId} सेव है। इससे असली कार्ड block या replace नहीं हुआ; उसके लिए बैंक से संपर्क करें। खाता हमेशा के लिए बंद करने का अनुरोध जमा नहीं हुआ है।`);}
}
