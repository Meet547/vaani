import {randomUUID} from 'node:crypto';
import {classify,explicitYes} from './intents.mjs';
import {redact} from './privacy.mjs';
import {digest} from './store.mjs';
import {securityGuidance} from './card-security.mjs';

export const normalizeName=value=>String(value).normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
export const identityActions=new Set(['select_identity','confirm_identity','register_profile','save_profile','cancel_registration']);
const isNo=text=>/^(?:no|nope|not me|not mine|different person|नहीं|नही|nahi|nahin)[.!। ]*$/i.test(text);
const identityYes=text=>explicitYes(text)||/^(?:yes[, ]+)?(?:that['’]?s me|that is me|that['’]?s correct|that['’]?s right|correct|it['’]?s me|जी हाँ|हाँ मैं ही हूँ|haan main hi hoon)[.!। ]*$/i.test(text.trim());
const saveYes=text=>explicitYes(text)||/^(?:yes[, ]+)?(?:save it|please save|save my profile|that['’]?s correct)[.! ]*$/i.test(text.trim());
const cleanName=value=>{
  const name=value.trim().replace(/\s+(?:speaking|here)[.! ]*$/i,'').replace(/\s+है[।.! ]*$/,'').replace(/[.!।]+$/,'').trim();
  if(name.length<2||name.length>80||name.split(/\s+/).length>6||!/^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u.test(name))return null;
  if(/\b(?:hello|hi|hey|yes|no|fine|thanks|thank|card|close|fee|help|want|please|name|know|ignore|rules|nothing|having|calling|okay|doing|looking|worried|upset)\b/i.test(name)||/^(?:हाँ|हां|नहीं|नमस्ते|ठीक)/.test(name))return null;
  return name;
};
export function extractName(text,{direct=true}={}){
  const match=text.replace(/’/g,"'").match(/(?:\bmy (?:full )?name(?: is|'s)|\bi am|\bi'm|\bthis is|\bmera naam|मेरा नाम)\s+(.+?)(?=\s+(?:and|from|in|aur|और)\s|[.,;!?।]|$)/i);
  return cleanName(match?match[1]:direct?text:'');
}

export class CustomerJourney {
  constructor(engine){this.engine=engine;this.store=engine.store;this.policy=engine.policy;}
  directory(){
    const seed=this.policy.catalog||this.policy.customers.map(c=>({id:c.id,name:c.name,city:'',segment:'card_only',language:'en',hero:true,canStartCard:true,sourceRevision:c.source_revision||null,card:{},scenario:{trigger:'customer_message',reason:'unknown',closureIntent:'none'},blockingReasons:[],warnings:[]}));
    return [...seed,...this.store.profiles()];
  }
  profile(id){return this.directory().find(p=>p.id===id);}
  candidates(name){
    const key=normalizeName(name),profiles=this.directory(),exact=profiles.filter(p=>normalizeName(p.id)===key||normalizeName(p.name)===key);
    return exact.length?exact:profiles.filter(p=>key.split(' ').every(word=>normalizeName(p.name).split(' ').includes(word)));
  }
  reply(s,en,hi){return {text:this.engine.say(s,en,hi),kind:'identity'};}
  create({channel='chat',language='en-IN'}={}){
    if(!['chat','voice'].includes(channel))throw new Error('Invalid conversation channel.');
    return this.store.transaction(()=>{
      const {session:s,access}=this.store.createSession({customer:null,verified:false,journeyMode:'conversation',channel,language:language==='hi-IN'?'hi-IN':'en-IN',trigger:'customer_message',state:'AWAITING_NAME',reason:'unknown',offerCount:0,improvementCount:0,reasonQuestions:0,closureMentions:0,closureLocked:false,offers:[],usedActions:[],transcript:[],voiceReconfirmations:0,clarifications:0,confirmationToken:null,onboarding:{phase:'NAME',candidates:[]}},this.engine.clock()+this.policy.closure.session_ttl_hours*3600000);
      this.store.audit(s.id,'POLICY',{version:this.policy.card.policy_version,mode:'demo'},this.engine.clock());
      const reply=this.reply(s,'Hi, I’m Aria, BombayBank’s virtual assistant. We’re using demo profiles today. What name should I look for?','नमस्ते, मैं Aria, BombayBank की virtual assistant हूँ। आज हम demo profiles इस्तेमाल कर रहे हैं। मैं किस नाम से आपकी profile ढूँढूँ?');
      this.engine.recordReply(s,reply);this.store.save(s);return {access,session:this.engine.view(s),reply};
    });
  }
  match(s,name){
    const matches=this.candidates(name),o=s.onboarding;
    o.name=name;o.candidates=matches.slice(0,8).map(p=>p.id);
    if(matches.length===1){o.phase='CONFIRM';s.state='CONFIRM_IDENTITY';const p=matches[0];return this.reply(s,`I found ${p.name}${p.city?` in ${p.city}`:''}. Is that you?`,`मुझे ${p.name}${p.city?`, ${p.city}`:''} की profile मिली। क्या यह आपकी profile है?`);}
    if(matches.length>1){o.phase='CHOOSE';s.state='CHOOSE_IDENTITY';return this.reply(s,`I found more than one match for ${name}. Could you share your full name or city, or choose your profile on screen?`,`मुझे ${name} नाम की कई profiles मिलीं। अपना पूरा नाम या शहर बताइए, या screen पर अपनी profile चुनिए।`);}
    o.phase='OFFER_REGISTRATION';s.state='NEW_CUSTOMER';
    return this.reply(s,`I couldn’t find ${name} in the demo records. Would you like me to create a new synthetic profile with your name, city and what you need help with?`,`मुझे ${name} की profile नहीं मिली। क्या मैं आपके नाम, शहर और समस्या के साथ नई synthetic profile बना दूँ?`);
  }
  bind(s,id){
    const profile=this.profile(id);if(!profile)throw new Error('That profile is no longer available. Please tell me your name again.');
    const customer=this.policy.customers.find(c=>c.id===id);
    s.verified=true;s.customer=customer?structuredClone(customer):{id:profile.id,name:profile.name,product:null,last4:null,source_revision:profile.sourceRevision};
    s.matchedProfile={id:profile.id,name:profile.name,city:profile.city,source:profile.segment==='new_customer'?'saved_profile':'csv'};
    this.store.audit(s.id,'IDENTITY',{method:'confirmed_demo_name_lookup',customer_id:id,verified:true,live_authentication:false},this.engine.clock());
    if(!customer){
      s.onboarding.phase='SUPPORT';s.state='PROFILE_READY';s.supportIssue=profile.supportIssue||'';
      if(profile.segment==='new_customer')return this.reply(s,`Welcome back, ${profile.name}. I found your saved profile${s.supportIssue?` and your note: ${s.supportIssue}`:'.'} Your enquiry is saved; account-specific fees or changes need a validated card record to be linked first.`,`स्वागत है, ${profile.name}। आपकी सेव की हुई profile मिल गई${s.supportIssue?`। आपकी समस्या: ${s.supportIssue}`:'।'} आपकी समस्या सेव है। खाते की फीस या बदलाव के लिए पहले valid कार्ड record जोड़ना होगा।`);
      return this.reply(s,profile.gold&&!profile.card?`Thanks, ${profile.name}. I found your gold-loan enquiry. Those details are available to view; this demo currently handles card conversations. What would you like to know?`:`Thanks, ${profile.name}. I found your record, but its card data needs review before account actions can continue. You can see the reason on screen. What would you like help with?`,`${profile.name}, आपकी profile मिल गई। इस record पर अभी कार्ड के actions उपलब्ध नहीं हैं। वजह screen पर दिखाई गई है। आप क्या जानना चाहेंगे?`);
    }
    s.state='ANALYSE';s.onboarding.phase='READY';
    this.engine.services.get_customer_360(s);this.engine.services.get_card_summary(s);this.engine.services.get_transactions(s);this.engine.services.fetch_cibil(s);
    this.store.audit(s.id,'DATASET',{revision:customer.source_revision,customer_id:id},this.engine.clock());
    if(customer.fraud_ticket)return this.engine.handoff(s,'fraud','Open fraud ticket in matched synthetic account');
    if(s.onboarding.deferredMessage){const message=s.onboarding.deferredMessage;delete s.onboarding.deferredMessage;return this.engine.decide(s,message,classify(message,s),{channel:s.channel});}
    const context=profile.scenario||{},reasons={fee:'the annual fee',not_using:'not using the card',low_rewards:'the rewards',competitor:'another bank’s offer',service_issue:'a service issue'};
    if(context.closureIntent==='firm'||reasons[context.reason]){
      s.onboarding.phase='CONTEXT';s.state='CHECK_CONTEXT';s.onboarding.context=context;
      return this.reply(s,context.closureIntent==='firm'?`Thanks, ${profile.name}. I see a saved request to close your card. Is that what you’d like help with today?`:`Thanks, ${profile.name}. Your saved card request mentions ${reasons[context.reason]}. Is that what you’d like to talk about today?`,context.closureIntent==='firm'?`${profile.name}, आपके record में कार्ड बंद करने का अनुरोध है। क्या आज आप इसी बारे में बात करना चाहते हैं?`:`${profile.name}, आपकी सेव की हुई कार्ड समस्या ${reasons[context.reason]} के बारे में है। क्या आप इसी पर बात करना चाहते हैं?`);
    }
    return this.reply(s,`Thanks, ${profile.name}. I found your card record. How can I help today?`,`${profile.name}, आपके कार्ड की जानकारी मिल गई। आज मैं कैसे मदद कर सकती हूँ?`);
  }
  handle(s,text,input){
    if(!s.onboarding)return null;
    const o=s.onboarding,event=classify(text,s),yes=explicitYes(text);
    if(identityActions.has(input.action)&&!['NAME','CHOOSE','CONFIRM','OFFER_REGISTRATION','REGISTER_NAME','CITY','ISSUE','REVIEW'].includes(o.phase))throw new Error('No identity or registration action is pending.');
    if(o.phase==='READY')return null;
    if(event.intent==='stop'||input.action==='cancel_registration'){
      o.phase='NAME';o.candidates=[];delete o.draft;delete o.deferredMessage;s.state='AWAITING_NAME';s.verified=false;s.customer=null;
      return this.reply(s,'Of course. Nothing new was saved. Tell me the name you’d like me to look for when you’re ready.','ज़रूर। कुछ नया सेव नहीं हुआ। तैयार होने पर बताइए कि मैं किस नाम से profile ढूँढूँ।');
    }
    if(o.phase==='SUPPORT'){
      if(event.intent==='card_incident')return this.reply(s,securityGuidance.en+' This profile has no linked card record for demo account actions.',securityGuidance.hi+' इस profile से demo account actions के लिए कार्ड record जुड़ा नहीं है।');
      return this.reply(s,event.intent==='greeting'?`Hi, ${s.customer.name}. I’m here. What would you like help with?`:'I can keep your enquiry here, but I don’t have a validated card account to quote fees or make account changes. You can start a new conversation to look up a different profile.','मैं आपकी बात सुन सकती हूँ, लेकिन इस profile से जुड़ा valid कार्ड record नहीं है। दूसरी profile ढूँढने के लिए नई बातचीत शुरू कर सकते हैं।');
    }
    if(o.phase==='CONTEXT'){
      if(event.intent==='greeting')return this.reply(s,'Hi! Take your time. Would you like to discuss the saved request, or something else?','नमस्ते! आराम से बताइए। क्या सेव किए हुए अनुरोध पर बात करें या किसी और विषय पर?');
      if(yes||event.intent==='accept'||/^(?:exactly|that['’]?s the issue|yes[, ]+that['’]?s the issue)[.! ]*$/i.test(text)){o.phase='READY';s.state='ANALYSE';const c=o.context;
        if(c.closureIntent==='firm')return this.engine.beginClosure(s);
        s.reason=c.reason;return this.engine.makeOffer(s);
      }
      if(isNo(text)){o.phase='READY';s.state='ANALYSE';return this.reply(s,'No problem. What would you like help with instead?','कोई बात नहीं। आप किस विषय में मदद चाहते हैं?');}
      if(['closure_firm','closure_soft','fraud_or_dispute','card_incident','card_recovered','human','reason_given','downgrade','question'].includes(event.intent)){o.phase='READY';s.state='ANALYSE';return this.engine.decide(s,text,event,input);}
      return this.reply(s,'Is the saved request still relevant, or is there something different you need today?','क्या सेव किया हुआ अनुरोध अभी भी सही है, या आज किसी और विषय पर मदद चाहिए?');
    }
    if(input.action==='select_identity'){
      if(!['CHOOSE','CONFIRM'].includes(o.phase)||!o.candidates.includes(input.choice))throw new Error('Choose one of the matched profiles from the current turn.');
      return this.bind(s,input.choice);
    }
    if(input.action==='register_profile'&&['CHOOSE','CONFIRM'].includes(o.phase)){o.phase='OFFER_REGISTRATION';o.allowNew=true;}
    if(o.phase==='CONFIRM'){
      if(identityYes(text)||input.action==='confirm_identity')return this.bind(s,o.candidates[0]);
      if(isNo(text)){o.phase='NAME';o.candidates=[];s.state='AWAITING_NAME';return this.reply(s,'Thanks for correcting that. What’s your full name?','बताने के लिए धन्यवाद। आपका पूरा नाम क्या है?');}
      const name=extractName(text);if(name)return this.match(s,name);
      return this.reply(s,'Is the name and city I found yours? Say yes, or tell me your full name again.','क्या मिला हुआ नाम और शहर आपका है? हाँ कहें, या अपना पूरा नाम फिर से बताइए।');
    }
    if(o.phase==='CHOOSE'){
      const narrowed=o.candidates.map(id=>this.profile(id)).filter(p=>normalizeName(p.city)===normalizeName(text)||normalizeName(p.id)===normalizeName(text)||normalizeName(p.name)===normalizeName(text));
      if(narrowed.length===1){o.candidates=[narrowed[0].id];o.phase='CONFIRM';s.state='CONFIRM_IDENTITY';return this.reply(s,`That looks like ${narrowed[0].name} in ${narrowed[0].city}. Is that you?`,`${narrowed[0].name}, ${narrowed[0].city} की profile मिली। क्या यह आपकी है?`);}
      const name=extractName(text);if(name)return this.match(s,name);
      return this.reply(s,'Please share the full name or city, or choose the matching profile on screen.','पूरा नाम या शहर बताइए, या screen पर सही profile चुनिए।');
    }
    if(o.phase==='OFFER_REGISTRATION'){
      if(yes||input.action==='register_profile'){
        o.draft={name:o.name,city:null,issue:''};o.phase=o.name.split(/\s+/).length>1?'CITY':'REGISTER_NAME';s.state='REGISTERING';
        return this.reply(s,o.phase==='CITY'?'Sure. Which city should I put on the demo profile? You can say skip.':'Sure. What full name should I save on the demo profile?',o.phase==='CITY'?'ज़रूर। demo profile में कौन-सा शहर लिखूँ? चाहें तो skip कह सकते हैं।':'ज़रूर। demo profile में कौन-सा पूरा नाम सेव करूँ?');
      }
      if(isNo(text)){o.phase='NAME';s.state='AWAITING_NAME';return this.reply(s,'That’s fine. I won’t save a profile. You can give me another name to look up.','ठीक है। मैं profile सेव नहीं करूँगी। आप ढूँढने के लिए दूसरा नाम बता सकते हैं।');}
      return this.reply(s,'Shall I create a synthetic profile, or would you prefer to try a different name?','क्या synthetic profile बनाएँ, या कोई दूसरा नाम ढूँढें?');
    }
    if(o.phase==='REGISTER_NAME'){
      const name=extractName(text);if(!name||name.split(/\s+/).length<2)return this.reply(s,'Please share the first and last name you want to use for this demo.','इस demo के लिए अपना पहला और आखिरी नाम बताइए।');
      if(!o.allowNew&&this.candidates(name).length)return this.match(s,name);
      o.draft.name=name;o.phase='CITY';return this.reply(s,'Thank you. Which city should I save? You can say skip.','धन्यवाद। कौन-सा शहर सेव करूँ? चाहें तो skip कह सकते हैं।');
    }
    if(o.phase==='CITY'){
      if(event.intent==='skip')o.draft.city=null;
      else{const city=text.replace(/^(?:i live in|i am from|i'm from|from|मैं .*?से हूँ|city is)\s+/i,'').trim();if(!/^[\p{L}\p{M}][\p{L}\p{M} .'-]{1,79}$/u.test(city))return this.reply(s,'Just the city name is enough, or say skip.','सिर्फ शहर का नाम बताइए, या skip कहिए।');o.draft.city=city;}
      o.phase='ISSUE';return this.reply(s,'And what would you like help with? A short description is enough. Please use demo details only.','आप किस विषय में मदद चाहते हैं? छोटा-सा विवरण बताइए। कृपया सिर्फ demo जानकारी दें।');
    }
    if(o.phase==='ISSUE'){
      if(text.length<5||text.length>500||event.intent==='greeting')return this.reply(s,'Could you briefly describe the issue in one or two sentences?','समस्या एक-दो वाक्यों में बताइए।');
      o.draft.issue=redact(text);o.phase='REVIEW';s.state='CONFIRM_REGISTRATION';
      return this.reply(s,`Here’s what I’ll save: ${o.draft.name}${o.draft.city?`, ${o.draft.city}`:''}. Your note: ${o.draft.issue} Is that correct, and may I save this synthetic profile?`,`मैं यह सेव करूँगी: ${o.draft.name}${o.draft.city?`, ${o.draft.city}`:''}। समस्या: ${o.draft.issue} क्या यह सही है और मैं synthetic profile सेव कर दूँ?`);
    }
    if(o.phase==='REVIEW'){
      if(saveYes(text)||input.action==='save_profile'){
        const d=o.draft,id='NEW-'+randomUUID().slice(0,8).toUpperCase(),revision=digest(JSON.stringify(d));
        const profile=this.store.saveProfile({id,name:d.name,city:d.city||'',language:s.language==='hi-IN'?'hi':'en',segment:'new_customer',hero:false,description:'Customer-created synthetic enquiry',sourceRevision:revision,card:null,gold:null,warnings:[],blockingReasons:['Card details are not linked. Account-specific actions are unavailable.'],canStartCard:false,scenario:{trigger:'customer_message',reason:'unknown',closureIntent:'none',channel:s.channel},supportIssue:d.issue},normalizeName(d.name),normalizeName(d.city||''),this.engine.clock());
        this.store.audit(s.id,'PROFILE_CREATED',{customer_id:profile.id,synthetic:true},this.engine.clock());
        s.customer={id:profile.id,name:profile.name,product:null,last4:null,source_revision:profile.sourceRevision};s.verified=true;s.matchedProfile={id:profile.id,name:profile.name,city:profile.city,source:'saved_profile'};s.supportIssue=profile.supportIssue;o.phase='SUPPORT';delete o.draft;s.state='PROFILE_READY';
        return this.reply(s,`You’re saved, ${profile.name}. Your demo profile ID is ${profile.id}, and your enquiry is recorded. I haven’t linked any card details, so I’ll need a validated card record before quoting account-specific fees or making changes.`,`${profile.name}, आपकी demo profile सेव हो गई। ID ${profile.id} है और आपकी समस्या दर्ज है। कार्ड की जानकारी अभी जुड़ी नहीं है, इसलिए खाते की फीस या बदलाव के लिए valid कार्ड record चाहिए होगा।`);
      }
      if(isNo(text)){o.phase='CITY';s.state='REGISTERING';return this.reply(s,'Let’s correct it. Which city should I use? Then we can update the issue.','इसे ठीक कर लेते हैं। कौन-सा शहर लिखूँ? फिर समस्या का विवरण बदल सकते हैं।');}
      return this.reply(s,'Please confirm with yes or the Save profile button, or say no to correct the details.','हाँ या Save profile button से पुष्टि करें। जानकारी बदलने के लिए नहीं कहें।');
    }
    if(o.phase==='NAME'){
      if(event.intent==='greeting')return this.reply(s,'Hello! I’m here and ready to help. What’s your name?','नमस्ते! मैं मदद के लिए तैयार हूँ। आपका नाम क्या है?');
      if(/^(?:H-(?:CARD|LR)-\d+|C\d{4}|NEW-[\dA-F]{8})$/i.test(text))return this.match(s,text);
      if(event.intent==='card_incident'){
        o.deferredMessage=text;s.securityGuidanceGiven=true;const name=extractName(text,{direct:false});
        if(name){const reply=this.match(s,name);reply.text=this.engine.say(s,securityGuidance.en,securityGuidance.hi)+' '+reply.text;return reply;}
        return this.reply(s,securityGuidance.en+' What name should I look up in the demo records?',securityGuidance.hi+' Demo records में किस नाम से profile ढूँढूँ?');
      }
      if(['closure_firm','closure_soft','fraud_or_dispute','reason_given','downgrade'].includes(event.intent)){o.deferredMessage=text;if(!extractName(text,{direct:false}))return this.reply(s,'I can help with that. First, what name should I look up in the demo records?','मैं मदद कर सकती हूँ। पहले बताइए, demo records में किस नाम से ढूँढूँ?');}
      const name=extractName(text);if(name)return this.match(s,name);
      return this.reply(s,'What’s your full name? I’ll use it to find the right demo profile.','आपका पूरा नाम क्या है? उससे सही demo profile ढूँढूँगी।');
    }
    return null;
  }
}
