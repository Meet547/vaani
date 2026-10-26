import { randomUUID } from 'node:crypto';
import { classify, counterRequest, explicitYes } from './intents.mjs';
import { redact } from './privacy.mjs';
import { metrics, assignTier, businessDeadline } from './policy.mjs';
import { CardServices } from './card-services.mjs';
import { words, money, digits, spokenDate } from './words.mjs';
import { digest } from './store.mjs';
import { CustomerJourney, identityActions, normalizeName } from './customer-journey.mjs';
import { cardFacts, asksOfferTerms } from './card-questions.mjs';

export class CardEngine {
  constructor(store,policy,clock=()=>Date.now()){this.store=store;this.policy=policy;this.clock=clock;this.services=new CardServices(store,policy,clock);this.journey=new CustomerJourney(this);}
  say(s,en,hi){return s.language==='hi-IN'?hi:en;}
  create({customerId=null,channel='chat',language='en-IN',trigger='customer_message',mode=null}={}) {
    if(mode==='conversation'||!customerId)return this.journey.create({channel,language});
    const profile=this.policy.catalog?.find(c=>c.id===customerId);
    if(profile&&!profile.canStartCard)throw new Error(profile.blockingReasons.join(' '));
    const customer=this.policy.customers.find(c=>c.id===customerId);
    if(!customer||!['chat','voice'].includes(channel)||!['customer_message','card_closure_request','downgrade_request','usage_drop','churn_score_high'].includes(trigger))throw new Error('Invalid demo session request.');
    return this.store.transaction(()=>{
      const {session:s,access}=this.store.createSession({customer:structuredClone(customer),verified:true,channel,language:language==='hi-IN'?'hi-IN':'en-IN',trigger,state:'ANALYSE',reason:'unknown',offerCount:0,improvementCount:0,reasonQuestions:0,closureMentions:0,closureLocked:false,offers:[],usedActions:[],transcript:[],voiceReconfirmations:0,clarifications:0,confirmationToken:null},this.clock()+this.policy.closure.session_ttl_hours*3600000);
      this.store.audit(s.id,'IDENTITY',{method:'synthetic_orchestrator',verified:true,live_authentication:false},this.clock());
      this.store.audit(s.id,'POLICY',{version:this.policy.card.policy_version,mode:'demo'},this.clock());
      if(customer.source_revision)this.store.audit(s.id,'DATASET',{revision:customer.source_revision,customer_id:customer.id},this.clock());
      const proactive=['usage_drop','churn_score_high'].includes(trigger);
      let reply;
      if(proactive&&(!customer.outreach_consent||customer.dnd||(customer.last_contact_days_ago!==null&&customer.last_contact_days_ago<this.policy.card.contact_cooldown_days))){
        s.state='BLOCKED';this.store.audit(s.id,'GUARDRAIL',{rule:'outreach_blocked',consent:customer.outreach_consent,dnd:customer.dnd},this.clock());
        reply={text:'Demo outreach was blocked by consent, DND or contact-frequency policy. No call was made.',silent:true};
      }else{
        this.services.get_customer_360(s);this.services.get_card_summary(s);this.services.get_transactions(s);this.services.fetch_cibil(s);
        const m=metrics(customer,this.policy);this.store.audit(s.id,'ANALYSE',{tier:assignTier(customer,m,this.policy),metrics:m},this.clock());
        if(customer.fraud_ticket)reply=this.handoff(s,'fraud','Open fraud ticket in synthetic account');
        else if(trigger==='card_closure_request')reply=this.decide(s,'I want to close my card.',classify('I want to close my card.',s),{channel});
        else if(trigger==='downgrade_request')reply=this.directDowngrade(s);
        else reply={text:proactive?this.say(s,'Hi, I’m Aria, BombayBank’s virtual assistant in this demo. Is everything working well with your card?','नमस्ते, मैं Aria, इस demo में BombayBank की virtual assistant हूँ। क्या आपके कार्ड के साथ सब ठीक चल रहा है?'):this.say(s,'Hi, I’m Aria, BombayBank’s virtual assistant. We’re using a synthetic account for this demo. How can I help with your card?','नमस्ते, मैं Aria, BombayBank की virtual assistant हूँ। यह synthetic account वाला demo है। मैं आपके कार्ड के बारे में कैसे मदद कर सकती हूँ?')};
      }
      this.recordReply(s,reply);this.store.save(s);return {access,session:this.view(s),reply};
    });
  }
  handle(id,input) {
    if(!input||typeof input!=='object')throw new Error('Invalid message.');
    const messageId=input.messageId||randomUUID();
    if(typeof messageId!=='string'||messageId.length>100)throw new Error('Invalid message identifier.');
    return this.store.transaction(()=>{
      const cached=this.store.db.prepare('SELECT response FROM messages WHERE session_id=? AND message_id=?').get(id,messageId);
      if(cached)return {...JSON.parse(cached.response),duplicate:true};
      const s=this.store.get(id);if(!s)throw new Error('Session not found.');
      if(!this.store.verifyAudit(id))throw new Error('Audit integrity check failed. This session is read-only. Start a fresh demo session.');
      if(input.expectedRevision!==undefined&&input.expectedRevision!==s.revision)throw new Error('This action belongs to an older turn. Review the latest conversation first.');
      const text=redact(String(input.text||'').trim().slice(0,2000));
      if(!text&&!input.action)throw new Error('A message or action is required.');
      if(/[\u0900-\u097f]/.test(text))s.language='hi-IN';else if(text&&!input.action)s.language='en-IN';
      const event=classify(text,s);
      const actions={accept_offer:'accept',decline_offer:'decline',close_card:'closure_firm',confirm_closure:'accept',skip:'skip',redeem_points:'accept',resume_closure:'closure_firm'};
      if(input.action&&!identityActions.has(input.action)){
        if(!Object.hasOwn(actions,input.action))throw new Error('Unknown action.');
        if(['accept_offer','decline_offer'].includes(input.action)&&s.state!=='DECIDE')throw new Error('No offer is awaiting a decision.');
        if(input.action==='redeem_points'&&(s.state!=='CLOSURE_FLOW'||s.closureStep!=='points'))throw new Error('Point redemption is not pending.');
        if(input.action==='confirm_closure'&&(s.state!=='CLOSURE_FLOW'||s.closureStep!=='confirm'))throw new Error('Closure confirmation is not pending.');
        event.intent=actions[input.action];event.source='button';
      }
      if(identityActions.has(input.action)&&!s.onboarding)throw new Error('No identity action is pending.');
      // A model suggestion is a question for the caller, never an assumed request.
      let clarification=null;
      const ready=!s.onboarding||s.onboarding.phase==='READY';
      if(s.intentClarification){
        const pending=s.intentClarification;
        if(!input.action&&pending.state===s.state&&explicitYes(text)){
          Object.assign(event,{intent:pending.intent,reason:pending.reason,source:'caller_confirmed_model'});delete s.intentClarification;
        }else if(!input.action&&event.intent==='decline'){
          delete s.intentClarification;clarification={text:this.say(s,'Thanks for clarifying. What would you like help with?','बताने के लिए धन्यवाद। आप किस विषय में मदद चाहते हैं?'),kind:'clarification'};
        }else if(!input.action&&pending.state===s.state&&event.intent==='other')clarification=this.modelClarification(s,pending);
        else delete s.intentClarification;
      }
      if(!clarification&&ready&&!input.action&&['ANALYSE','FIND_REASON','DECIDE'].includes(s.state)&&event.intent==='other'&&input.fallback){
        const suggestion=input.fallback;
        if(['closure_firm','closure_soft','fraud_or_dispute','human','reason_given','downgrade'].includes(suggestion.intent)&&['fee','not_using','low_rewards','competitor','service_issue','unknown'].includes(suggestion.reason)){
          s.intentClarification={intent:suggestion.intent,reason:suggestion.reason,state:s.state};clarification=this.modelClarification(s,s.intentClarification);
          this.store.audit(id,'GUARDRAIL',{rule:'model_intent_requires_clarification',suggestion:s.intentClarification},this.clock());
        }else if(suggestion.intent==='question'){event.intent='question';event.source='model_classifier';}
      }
      s.transcript.push({role:'user',text:text||input.action,at:this.clock()});
      this.store.audit(id,'INTENT',{...event,text:text||input.action},this.clock());
      const before=s.state;
      const reply=this.journey.handle(s,text,input)||clarification||this.decide(s,text,event,input);
      if(before!==s.state)this.store.audit(id,'STATE',{from:before,to:s.state},this.clock());
      s.revision++;this.recordReply(s,reply);this.store.save(s);
      const result={reply,session:this.view(s)};
      this.store.db.prepare('INSERT INTO messages VALUES(?,?,?)').run(id,messageId,JSON.stringify(result));
      return result;
    });
  }
  recordReply(s,reply){
    if(this.policy.card.never_say.some(phrase=>reply.text.toLowerCase().includes(phrase)))throw new Error('Response failed the policy language check.');
    if(!reply.silent)s.transcript.push({role:'assistant',text:reply.text,at:this.clock()});
    s.lastReplyKind=reply.kind||'conversation';
    this.store.audit(s.id,'REPLY',{text:reply.text,kind:reply.kind||'conversation'},this.clock());
  }
  modelClarification(s,event){
    const topics={fee:'the annual fee',not_using:'not using the card',low_rewards:'the rewards',competitor:'another bank’s offer',service_issue:'a service issue',unknown:'your card'};
    const question={closure_firm:'Are you asking me to help close this demo card?',closure_soft:'Are you considering closing this demo card?',fraud_or_dispute:'Are you reporting fraud or an unrecognized transaction?',human:'Would you like a simulated support case for a colleague to review?',downgrade:'Are you asking about moving to a card with no annual fee?',reason_given:`Just to check, is ${topics[event.reason]} what you’d like help with?`}[event.intent];
    return {text:this.say(s,question,'मैं आपकी बात का अनुमान नहीं लगाना चाहती। क्या आप '+({closure_firm:'कार्ड बंद करना चाहते हैं?',closure_soft:'कार्ड बंद करने के बारे में सोच रहे हैं?',fraud_or_dispute:'fraud या अनजान transaction की शिकायत कर रहे हैं?',human:'simulated support case बनवाना चाहते हैं?',downgrade:'बिना सालाना फीस वाले कार्ड के बारे में पूछ रहे हैं?',reason_given:'कार्ड की '+({fee:'फीस',not_using:'कम उपयोग',low_rewards:'rewards',competitor:'दूसरे बैंक के offer',service_issue:'सेवा की समस्या',unknown:'समस्या'}[event.reason])+' पर मदद चाहते हैं?'}[event.intent])),kind:'clarification'};
  }
  decide(s,text,event,input) {
    if(!s.verified)return {text:'Verify the demo identity before accessing account information.',kind:'verification'};
    if(s.state==='BLOCKED')return {text:'Outreach is blocked for this demo session. Start an inbound session to continue.',silent:true};
    if(event.intent==='fraud_or_dispute'||s.customer.fraud_ticket)return this.handoff(s,/harass|disput|शिकायत/i.test(text)?'complaints':'fraud',text);
    if(event.intent==='human')return this.handoff(s,'relationship_manager',text);
    if(event.intent==='greeting')return {text:this.say(s,s.state==='ANALYSE'?'Hello! How can I help with your card today?':'Hi! Take your time. I’m here when you’re ready.','नमस्ते! आराम से बताइए। मैं सुन रही हूँ।'),kind:'greeting'};
    if(s.state==='CLOSED'||s.closure){
      if(event.intent==='stop'||/cancel|changed.*mind|वापस|रद्द/.test(text.toLowerCase()))return this.handoff(s,'credit_ops',text);
      return this.closedReply(s);
    }
    if(['stop'].includes(event.intent)){
      this.services.invalidateConfirmation(s);s.state=s.closureLocked?'CLOSURE_FLOW':'STOPPED';s.closureStep='paused';
      return {text:this.say(s,'Of course, we’ll stop here. No closure request has been submitted.','बिल्कुल, हम यहीं रुकते हैं। बंद करने का कोई अनुरोध जमा नहीं हुआ है।'),kind:'paused'};
    }
    if(['usage_drop','churn_score_high'].includes(s.trigger)&&!s.offerCount&&!s.closureLocked&&!s.closureMentions&&(event.intent==='decline'||/everything.*fine|all good|not interested|सब ठीक/i.test(text))){s.state='STOPPED';return {text:this.say(s,'Glad we could check in. We’ll leave things as they are.','समय देने के लिए धन्यवाद। हम कोई बदलाव नहीं करेंगे।')};}
    if(event.intent==='unsupported')return {text:this.say(s,'I can explain the recorded account facts and approved demo options. I can’t invent balances, approvals or different terms. What would you like to check?','मैं दर्ज account की जानकारी और मंज़ूर demo options बता सकती हूँ। बकाया, approval या नई शर्तें गढ़ नहीं सकती। क्या देखना चाहेंगे?'),kind:'clarification'};
    if(event.intent==='keep_card'){
      if(s.state==='CLOSURE_FLOW'){this.services.invalidateConfirmation(s);s.closureStep='paused';}
      return {text:this.say(s,'Understood. I haven’t submitted a closure request. You can keep discussing the card here.','समझ गई। मैंने बंद करने का अनुरोध जमा नहीं किया है। आप कार्ड के बारे में बातचीत जारी रख सकते हैं।'),kind:'paused'};
    }
    if(s.state==='CLOSURE_FLOW')return this.closureTurn(s,text,event,input);
    if(event.intent==='question')return this.informationReply(s,text);
    if(event.intent==='closure_firm'||(event.intent==='decline'&&(s.state==='DECIDE'||s.closureMentions>0)))return this.beginClosure(s);
    if(event.intent==='decline')return {text:this.say(s,'Okay. What would you like help with instead?','ठीक है। आप किस विषय में मदद चाहते हैं?'),kind:'clarification'};
    if(s.closureLocked)return this.beginClosure(s);
    if(s.state==='HANDOFF')return {text:this.say(s,'Your simulated case is saved for review. If you prefer to close the card, I can help with that.','आपका simulated case review के लिए सेव है। अगर आप कार्ड बंद करना चाहते हैं, तो मैं मदद कर सकती हूँ।'),kind:'handoff'};
    if(s.state==='STOPPED')return {text:this.say(s,'This conversation is paused. You can ask to close the card, or start a new demo session.','यह बातचीत रुकी हुई है। आप कार्ड बंद करने के लिए कह सकते हैं, या नया demo session शुरू कर सकते हैं।')};
    if(s.state==='RETAINED')return {text:this.say(s,'The simulated change is saved. If you’ve changed your mind, you can still ask to close the card.','Simulated बदलाव सेव है। अगर आपने मन बदल लिया है, तो आप कार्ड बंद करने के लिए कह सकते हैं।')};
    if(event.intent==='closure_soft'){
      s.closureMentions++;
      if(s.offerCount||s.closureMentions>1)return this.beginClosure(s);
      if(event.reason!=='unknown')s.reason=event.reason;
      if(s.reason!=='unknown')return this.makeOffer(s);
      if(s.reasonQuestions<this.policy.card.max_reason_questions){s.reasonQuestions++;s.state='FIND_REASON';return {text:this.say(s,'Of course. What’s led you to consider closing the card?','ज़रूर। आप कार्ड बंद करने के बारे में क्यों सोच रहे हैं?'),kind:'reason'};}
      return this.makeOffer(s);
    }
    if(event.intent==='downgrade')return this.directDowngrade(s);
    if(s.state==='DECIDE'){
      if(event.intent==='accept'){
        if(input.action!=='accept_offer'&&!['offer','decision'].includes(s.lastReplyKind))return this.offerReply(s);
        const applied=this.services.apply_retention_action(s,s.currentOffer.id);s.state='RETAINED';s.offerOutcome='accepted';
        return {text:this.say(s,'Done for this demo. The agreed terms are saved in your written confirmation here; no real card has been changed.','इस demo में तय शर्तें लागू करके लिखित confirmation यहाँ सेव कर दिया है। किसी असली कार्ड में बदलाव नहीं हुआ है।'),kind:'retained',result:applied};
      }
      if(event.intent==='counter')return this.counter(s,text);
      return {text:this.say(s,'Would you like the option we discussed, or would you prefer to close the card?','क्या आप बताई गई सुविधा चाहते हैं, या कार्ड बंद करना पसंद करेंगे?'),kind:'decision'};
    }
    if(event.reason!=='unknown'){s.reason=event.reason;return this.makeOffer(s);}
    if(s.state==='FIND_REASON')return {text:this.say(s,'Take your time. You can tell me what’s bothering you, or ask me to continue with closure.','आराम से बताइए कि क्या परेशानी है। चाहें तो सीधे कार्ड बंद करने के लिए भी कह सकते हैं।'),kind:'reason'};
    s.clarifications++;
    return {text:this.say(s,'I’m not sure I understood. You can ask about the recorded fee, dues or points, explain a concern, or ask for closure or a colleague.','आपकी बात स्पष्ट नहीं हुई। दर्ज फीस, बकाया या points के बारे में पूछें, समस्या बताएँ, या कार्ड बंद करने या सहकर्मी की मदद के लिए कहें।'),kind:'clarification'};
  }
  directDowngrade(s){
    if(s.offerCount)return this.counter(s,'free card instead');
    const option=this.services.get_retention_options(s).options.find(o=>o.id==='CARD_DOWNGRADE_FREE');
    if(!option)return {text:this.say(s,'This demo card is already on the fee-free product. You can keep it or request closure.','यह demo कार्ड पहले से बिना फीस वाले product पर है। आप इसे रख सकते हैं या बंद करने का अनुरोध कर सकते हैं।')};
    return this.setOffer(s,option);
  }
  informationReply(s,text){
    this.services.get_card_summary(s);
    const other=this.journey.directory().find(p=>p.id!==s.customer.id&&normalizeName(p.name)!==normalizeName(s.customer.name)&&(` ${normalizeName(text)} `).includes(` ${normalizeName(p.name)} `));
    if(other)return {text:this.say(s,`This conversation is still linked to ${s.customer.name}. Start a new conversation to look up ${other.name} and confirm that profile first.`,`यह बातचीत अभी ${s.customer.name} की profile से जुड़ी है। ${other.name} को ढूँढने और पुष्टि करने के लिए नई बातचीत शुरू करें।`),kind:'facts'};
    if(/^(?:did (?:you|we)|has |is |was ).*(?:clos(?:e|ed|ure)|cancel)|status.*clos|clos.*status/i.test(text))return {text:this.say(s,s.closureLocked?'A simulated closure is being prepared. Nothing has been submitted yet; it still needs the final confirmation.':'I haven’t submitted a closure request in this conversation.','इस बातचीत में बंद करने का अनुरोध जमा नहीं हुआ है। जमा करने के लिए अंतिम पुष्टि चाहिए।'),kind:'facts'};
    const facts=cardFacts(s,text,this.policy);if(facts)return {text:facts,kind:'facts'};
    if(s.currentOffer&&asksOfferTerms(text)){
      if(/guarantee|promise|always|every year|what if|what happens|don['’]?t (?:meet|spend)|miss.*(?:target|condition)|गारंटी/i.test(text))return {text:this.say(s,'I can confirm only the written demo offer terms shown here. The policy doesn’t specify that extra guarantee or exception, so I can’t promise it.','मैं केवल यहाँ लिखी demo offer की शर्तों की पुष्टि कर सकती हूँ। Policy में उस अतिरिक्त guarantee या exception का विवरण नहीं है।'),kind:'facts'};
      if(s.state==='DECIDE')return this.offerReply(s,true);
      if(s.state==='RETAINED')return {text:this.say(s,`Your saved demo terms: ${this.offerReply(s,true).text.replace(/^I can offer /,'').replace(/^I can /,'')}`,'आपकी तय demo शर्तें यहाँ लिखित confirmation में सेव हैं।'),kind:'facts'};
    }
    return {text:this.say(s,'I don’t have verified information to answer that from this demo record. I can check the recorded fee, dues, points, spending totals or the current offer. Which would help?','इस demo record में उसका verified जवाब नहीं है। दर्ज फीस, बकाया, points, कुल खर्च या मौजूदा offer में से क्या देखना चाहेंगे?'),kind:'facts'};
  }
  makeOffer(s){
    if(s.closureLocked||s.offerCount>=this.policy.card.max_offers)return this.beginClosure(s);
    if(s.reason==='service_issue'||s.customer.service_ticket)return this.handoff(s,'complaints','Service issue: '+s.transcript.at(-1)?.text);
    const result=this.services.get_retention_options(s);s.tier=result.tier;s.metrics=result.metrics;
    if(!result.options.length)return this.beginClosure(s);
    return this.setOffer(s,result.options[0]);
  }
  setOffer(s,option,improved=false,amount=null){
    if(s.closureLocked||(!improved&&s.offerCount>=this.policy.card.max_offers)||(improved&&s.improvementCount>=this.policy.card.max_improvements))throw new Error('Offer budget exhausted.');
    s.currentOffer=this.services.prepareOffer(s,option,{improved,amount});s.state='DECIDE';
    if(improved)s.improvementCount++;else s.offerCount++;
    s.offers.push({id:s.currentOffer.id,improved,terms:s.currentOffer});
    this.store.audit(s.id,'OFFER',{offer:s.currentOffer,offerCount:s.offerCount,improvementCount:s.improvementCount},this.clock());
    return this.offerReply(s);
  }
  offerReply(s,question=false){
    const o=s.currentOffer;let en,hi;
    if(o.id==='CARD_FEE_WAIVER_COND'){
      en=`I can offer a waiver of ${money(o.amount)} for the next annual fee${o.spend?`, if you spend ${money(o.spend)} over the next ${words(o.months)} months`:`, with no spend condition`}.`;
      hi=`मैं अगली सालाना फीस में ${money(o.amount)} की छूट दे सकती हूँ${o.spend?`, अगर आप अगले ${words(o.months)} महीनों में ${money(o.spend)} खर्च करें`:`, बिना किसी खर्च की शर्त के`}।`;
    }else if(o.id==='CARD_FEE_REVERSAL'){en=`I can reverse ${money(o.amount)} of the fee that was recently charged, with no spend condition.`;hi=`हाल में ली गई फीस में से ${money(o.amount)} वापस किए जा सकते हैं, बिना खर्च की शर्त के।`;}
    else if(o.id==='CARD_DOWNGRADE_FREE'){en='I can move this demo card to the lifetime-free product, with no annual fee.';hi='मैं इस demo कार्ड को lifetime-free product में बदल सकती हूँ, जिसमें सालाना फीस नहीं है।';}
    else if(o.id==='CARD_POINTS_BOOST'){en=`I can double reward points for ${words(o.months)} months, capped at ${words(o.points)} extra points.`;hi=`मैं ${words(o.months)} महीनों के लिए reward points दोगुने कर सकती हूँ, अधिकतम ${words(o.points)} अतिरिक्त points तक।`;}
    else if(o.id==='CARD_COMPETITOR_MATCH'){en=`I can offer a ${money(o.amount)} fee waiver for ${words(o.months)} months and double reward points for ${words(o.points_months)} months, capped at ${words(o.points)} extra points.`;hi=`मैं ${words(o.months)} महीनों के लिए ${money(o.amount)} फीस माफ कर सकती हूँ, और ${words(o.points_months)} महीनों के लिए अधिकतम ${words(o.points)} अतिरिक्त reward points दे सकती हूँ।`;}
    else throw new Error('Unknown offer.');
    return {text:this.say(s,en,hi)+(question?'':this.say(s,' Would that work for you?',' क्या यह आपके लिए ठीक रहेगा?')),kind:'offer',offer:o};
  }
  counter(s,text){
    const request=counterRequest(text);
    if(s.improvementCount>=this.policy.card.max_improvements||request.kind==='review')return this.handoff(s,'credit_ops',text);
    const result=this.services.get_retention_options(s), ids={reversal:'CARD_FEE_REVERSAL',downgrade:'CARD_DOWNGRADE_FREE',points:'CARD_POINTS_BOOST',waiver:'CARD_FEE_WAIVER_COND'};
    const option=result.options.find(o=>o.id===ids[request.kind]);
    if(!option)return this.handoff(s,'credit_ops',text);
    if(request.kind==='waiver'&&(request.amount===null||!Number.isSafeInteger(request.amount)||request.amount<=0||request.amount>option.amount))return this.handoff(s,'credit_ops',text);
    if(request.kind==='points'&&request.amount!==null&&(!Number.isSafeInteger(request.amount)||request.amount<=0||request.amount>option.points))return this.handoff(s,'credit_ops',text);
    return this.setOffer(s,option,true,request.amount??null);
  }
  handoff(s,queue,request){
    const previous=s.state, result=this.services.handoff_to_human(s,queue,request);s.handoff=result;
    if(!s.closureLocked && previous!=='CLOSED')s.state='HANDOFF';
    if(s.closureLocked&&previous!=='CLOSED'&&s.closureStep==='confirm'){this.services.invalidateConfirmation(s);s.closureStep='paused_review';}
    this.store.audit(s.id,'GUARDRAIL',{rule:queue==='fraud'||queue==='complaints'?'safety_handoff':'human_authority_required',closurePreserved:s.closureLocked},this.clock());
    const text=s.closure
      ?this.say(s,'Your submitted demo closure request is still recorded. I saved a simulated review case for your latest request; this has not cancelled or changed the submitted closure.','आपका जमा किया हुआ demo closure request अभी भी दर्ज है। नए अनुरोध के लिए simulated review case सेव है; इससे जमा किया हुआ closure रद्द या बदला नहीं है।')
      :queue==='credit_ops'
      ?this.say(s,`I can’t approve that myself. I’ve saved a simulated review case, with a demo response target of ${words(this.policy.card.review_working_days)} working day; you can still close the card.`,`यह मैं खुद मंज़ूर नहीं कर सकती। Simulated review case सेव है, जिसका demo लक्ष्य ${words(this.policy.card.review_working_days)} working day है; आप फिर भी कार्ड बंद कर सकते हैं।`)
      :this.say(s,`I’ve saved a simulated case for the ${queue==='fraud'?'fraud':queue==='complaints'?'complaints':'support'} team. This demo cannot connect a real colleague.`,`मैंने ${queue==='fraud'?'fraud':queue==='complaints'?'complaints':'support'} team के लिए simulated case सेव कर दिया है। यह demo किसी असली सहकर्मी से नहीं जोड़ सकता।`);
    return {text,kind:'handoff',handoff:result};
  }
  beginClosure(s){
    s.closureLocked=true;s.state='CLOSURE_FLOW';s.currentOffer=null;
    this.store.audit(s.id,'GUARDRAIL',{rule:'closure_never_blocked'},this.clock());
    if(s.customer.status!=='active')return this.handoff(s,'credit_ops','Closure for a non-active card');
    const c=this.services.get_closure_checklist(s);s.checklist=c;
    const dues=c.dues>0?this.say(s,`Your total dues are ${money(c.dues)}${c.emi?`, including ${money(c.emi)} in EMIs`:''}; we can record the request now, and completion follows payment.`,`आपकी कुल बकाया राशि ${money(c.dues)} है${c.emi?`, जिसमें ${money(c.emi)} EMI शामिल हैं`:''}; अनुरोध अभी दर्ज हो सकता है, और बकाया चुकाने पर पूरा होगा।`):this.say(s,'There are no outstanding dues on this demo card.','इस demo कार्ड पर कोई बकाया नहीं है।');
    if(c.points>0&&!s.pointsAsked){s.pointsAsked=true;s.closureStep='points';return {text:dues+' '+this.say(s,`You have ${words(c.points)} reward points; under this demo policy, unused points are forfeited on closure. Redeem them first, or skip?`,`आपके ${words(c.points)} reward points हैं; demo policy में बंद होने पर बचे points समाप्त होते हैं। पहले redeem करें, या छोड़ दें?`),kind:'points'};}
    return this.confirmPrompt(s,dues);
  }
  confirmPrompt(s,prefix=''){
    s.closureStep='confirm';const c=this.services.get_closure_checklist(s);s.checklist=c;
    this.services.issueConfirmation(s);
    const reminders=[];
    if(c.mandates.length)reminders.push(this.say(s,`move the ${words(c.mandates.length)} linked subscription${c.mandates.length===1?'':'s'} to another payment method`,`जुड़ी हुई ${words(c.mandates.length)} subscriptions का payment method बदलें`));
    if(c.addons)reminders.push(this.say(s,`the ${words(c.addons)} add-on card${c.addons===1?'':'s'} will also close`,`${words(c.addons)} add-on कार्ड भी बंद होंगे`));
    if(c.emi)reminders.push(this.say(s,'existing EMIs continue as scheduled under the demo policy','demo policy में EMI तय schedule पर जारी रहेंगी'));
    const reminder=reminders.length?reminders.join('; ').replace(/^./,v=>v.toUpperCase())+'.':'';
    const confirm=this.say(s,`Shall I submit the simulated closure request for the card ending ${digits(c.last4)}?`,`${digits(c.last4)} पर समाप्त होने वाले कार्ड का simulated closure request जमा कर दूँ?`);
    return {text:[prefix,reminder,confirm].filter(Boolean).join(' '),kind:'confirm'};
  }
  closureTurn(s,text,event,input){
    if(s.customer.status!=='active')return this.handoff(s,'credit_ops',text);
    if(event.intent==='counter')return this.handoff(s,'credit_ops',text);
    if(event.intent==='question'){
      if(/score|bureau|स्कोर|सिबिल/i.test(text))return {text:this.say(s,this.policy.disclosures.bureau,'यह demo credit-score बदलाव का अनुमान नहीं लगाता। सही reporting policy के लिए बैंक का सहकर्मी मदद करेगा।'),kind:'closure_question'};
      if(/review|waiv|offer|छूट|माफ/i.test(text))return this.handoff(s,'credit_ops',text);
      return this.informationReply(s,text);
    }
    if(s.closureStep==='points'){
      let prefix='';
      if(event.intent==='accept'&&input.action!=='redeem_points'&&s.lastReplyKind!=='points')return {text:this.say(s,'Would you like to redeem the remaining points in this demo, or skip them and continue with closure?','क्या इस demo में बचे points redeem करें, या छोड़कर बंद करने की प्रक्रिया जारी रखें?'),kind:'points'};
      if(event.intent==='accept'){const result=this.services.redeem_points(s);prefix=this.say(s,`${words(result.points)} points have been redeemed in the demo.`,`${words(result.points)} points इस demo में redeem कर दिए गए हैं।`);}
      else if(!['skip','decline','closure_firm','closure_soft'].includes(event.intent))return {text:this.say(s,'You can redeem the points or skip this step. Either way, we can continue with closure.','आप points redeem कर सकते हैं या यह कदम छोड़ सकते हैं। दोनों तरीकों से कार्ड बंद करने की प्रक्रिया जारी रहेगी।'),kind:'points'};
      return this.confirmPrompt(s,prefix);
    }
    if(['paused','paused_review'].includes(s.closureStep))return this.confirmPrompt(s,this.say(s,'Nothing has been submitted yet.','अभी कोई अनुरोध जमा नहीं हुआ है।'));
    if(event.intent==='decline'){this.services.invalidateConfirmation(s);s.closureStep='paused';return {text:this.say(s,'Understood. I haven’t submitted the closure request.','ठीक है। मैंने बंद करने का अनुरोध जमा नहीं किया है।'),kind:'paused'};}
    if(event.intent==='accept'){
      if(input.action!=='confirm_closure'&&s.lastReplyKind!=='confirm')return this.confirmPrompt(s,this.say(s,'Let’s review the closure confirmation first. Nothing has been submitted.','पहले बंद करने की पुष्टि फिर से देख लें। कोई अनुरोध जमा नहीं हुआ है।'));
      if(input.action!=='confirm_closure'&&!explicitYes(text))return {text:this.say(s,'Please say yes or use the confirm button to submit this closure request.','यह अनुरोध जमा करने के लिए कृपया हाँ कहें या confirm button दबाएँ।'),kind:'confirm'};
      if(input.channel==='voice'&&(typeof input.confidence!=='number'||input.confidence<this.policy.card.voice_confirmation_threshold)){
        if(s.voiceReconfirmations<this.policy.card.max_voice_reconfirmations){s.voiceReconfirmations++;this.store.audit(s.id,'GUARDRAIL',{rule:'voice_reconfirmation',confidence:input.confidence??null},this.clock());return {text:this.say(s,'I couldn’t verify that confirmation clearly. Please say yes once more, or use the confirm button.','आपकी पुष्टि स्पष्ट रूप से verify नहीं हुई। कृपया एक बार और हाँ कहें, या confirm button दबाएँ।'),kind:'confirm'};}
        return {text:this.say(s,'Voice confidence is still unavailable. Please use the confirm button here to submit the request.','Voice confidence अभी भी उपलब्ध नहीं है। अनुरोध जमा करने के लिए यहाँ confirm button दबाएँ।'),kind:'confirm'};
      }
      if(s.confirmationExpires<=this.clock()||this.services.snapshot(s)!==this.store.db.prepare('SELECT snapshot FROM challenges WHERE token_hash=?').get(digest(s.confirmationToken||''))?.snapshot)return this.confirmPrompt(s,this.say(s,'Let’s refresh the confirmation before submitting.','जमा करने से पहले पुष्टि फिर से देख लेते हैं।'));
      const token=input.action==='confirm_closure'?input.token:s.confirmationToken;
      s.closure=this.services.process_closure(s,token,{explicit:true,source:input.action==='confirm_closure'?'button':input.channel||'chat'});
      s.state='CLOSED';s.closureStep='submitted';return this.closedReply(s);
    }
    // A repeated close or skip request never doubles as the required final yes.
    return {text:this.say(s,'The closure request is ready. Please say yes or use the confirm button to submit it.','बंद करने का अनुरोध तैयार है। जमा करने के लिए हाँ कहें या confirm button दबाएँ।'),kind:'confirm'};
  }
  closedReply(s){
    const c=s.closure;
    return {text:this.say(s,`Your simulated closure request is saved. The reference is ${digits(c.reference)}. ${c.status==='pending_dues'?'It is pending dues; the recorded demo review date is ':'The demo completion target is '}${spokenDate(c.deadline)}; this does not close a real card.`,`आपका simulated closure request सेव है। Reference ${digits(c.reference)} है। ${c.status==='pending_dues'?'यह बकाया चुकाने तक pending है; demo review date ':'Demo completion target '}${spokenDate(c.deadline)} है; इससे कोई असली कार्ड बंद नहीं होता।`),kind:'closed',closure:c};
  }
  view(s){
    const hasCard=Array.isArray(s.customer?.monthly_spend),m=hasCard?metrics(s.customer,this.policy):null,tier=hasCard?assignTier(s.customer,m,this.policy):null;
    const cases=this.store.db.prepare('SELECT id,queue,status,deadline FROM cases WHERE session_id=?').all(s.id);
    return {id:s.id,revision:s.revision,state:s.state,reason:s.reason,customer:s.customer?{id:s.customer.id,name:s.customer.name,product:s.customer.product,last4:s.customer.last4,sourceRevision:s.customer.source_revision||null}:null,verified:s.verified,journeyMode:s.journeyMode||'scenario',identity:s.onboarding?{phase:s.onboarding.phase,candidates:s.onboarding.candidates.map(id=>this.journey.profile(id)).filter(Boolean).map(p=>({id:p.id,name:p.name,city:p.city})),draft:s.onboarding.phase==='REVIEW'?s.onboarding.draft:null}:null,hasCard,matchedProfile:s.matchedProfile,supportIssue:s.supportIssue,language:s.language,channel:s.channel,trigger:s.trigger,offerCount:s.offerCount,improvementCount:s.improvementCount,reasonQuestions:s.reasonQuestions,closureLocked:s.closureLocked,closureStep:s.closureStep,offer:s.currentOffer,checklist:s.checklist,closure:s.closure,confirmationToken:s.closureStep==='confirm'?s.confirmationToken:null,confirmationExpires:s.confirmationExpires,transcript:s.transcript.slice(-100),cases,tier,metrics:m,trace:this.store.trace(s.id,100),auditValid:this.store.verifyAudit(s.id),policyVersion:this.policy.card.policy_version,mode:'demo'};
  }
  resume(id){return this.store.transaction(()=>{const s=this.store.get(id);if(!s)throw new Error('Session not found.');if(!this.store.verifyAudit(id))throw new Error('Audit integrity check failed. Session is read-only.');if(s.state==='CLOSURE_FLOW'&&s.closureStep==='confirm'){this.services.issueConfirmation(s);s.revision++;this.store.save(s);}return this.view(s);});}
  alerts(){
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:this.policy.closure.timezone}).format(new Date(this.clock()));
    const soon=businessDeadline(new Date(this.clock()),this.policy.closure.reminder_working_days,this.policy.closure);
    return {closures:this.store.db.prepare('SELECT session_id,reference,status,deadline FROM closures WHERE deadline<=?').all(soon).map(c=>({...c,overdue:c.deadline<today})),reviews:this.store.db.prepare("SELECT session_id,id,queue,status,deadline FROM cases WHERE status IN ('simulated_pending','simulated_overdue') AND deadline<?").all(today)};
  }
  scanDeadlines(){
    return this.store.transaction(()=>{
      const alerts=this.alerts();
      for(const item of [...alerts.closures,...alerts.reviews]){
        if(!this.store.verifyAudit(item.session_id))continue;
        const key=`${item.reference||item.id}:${item.overdue?'overdue':'due'}`;
        if(this.store.db.prepare('SELECT key FROM deadline_alerts WHERE key=?').get(key))continue;
        this.store.db.prepare('INSERT INTO deadline_alerts VALUES(?,?,?,?)').run(key,item.session_id,JSON.stringify(item),this.clock());
        if(item.id)this.store.db.prepare("UPDATE cases SET status='simulated_overdue' WHERE id=?").run(item.id);
        this.store.audit(item.session_id,'DEADLINE_ALERT',{...item,action:item.id?'simulated review escalated; no auto-approval':'closure deadline alert shown in demo UI'},this.clock());
      }
      return alerts;
    });
  }
}
