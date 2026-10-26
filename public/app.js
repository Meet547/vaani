const $ = id => document.getElementById(id);
let ws, context, media, micNode, micSource, muted = false, active = false, textOnly = false;
let turn = null, generation = 0, audioQueue = Promise.resolve(), nextAudio = 0, playing = new Set();
let endTimer, sessionStart = 0, lastActivity = Date.now(), meter = 0, loudSince = 0, connecting = false;
let assistantMessage, state = 'idle', configured = false, voiceAvailable = false, sessionSnapshot = null, savedSession = null;
let customerCatalog=[],selectedProfile=null,profileRequest=null,profileLoading=false;
const bars = Array.from({ length: 27 }, (_, i) => { const b = document.createElement('i'); $('waveform').append(b); return b; });

const labels = {
  idle: ['READY WHEN YOU ARE', 'Good conversations start\nwith listening.', 'Say what’s on your mind. Aria will take it from there.'],
  connecting: ['GETTING COMFORTABLE', 'Just a moment…', 'Connecting your microphone and Aria’s voice.'],
  listening: ['I’M LISTENING', 'Go on. I’m here.', 'Take your time. There’s no need to rush.'],
  thinking: ['A MOMENT OF THOUGHT', 'Let’s work through this.', 'Aria is preparing a response.'],
  speaking: ['ARIA IS SPEAKING', 'A little understanding\ngoes a long way.', 'You can interrupt naturally, or use the pause button.'],
  muted: ['MICROPHONE MUTED', 'Take a little breather.', 'Unmute whenever you’re ready to continue.'],
};
function setState(value) {
  state = value;
  const [label, title, hint] = labels[value];
  $('state').textContent = label; $('call-title').textContent = title;
  $('call-title').style.whiteSpace = 'pre-line'; $('call-hint').textContent = hint;
  $('orb-stage').dataset.state = value;
}
function showError(message) { $('error').textContent = message; $('error').hidden = false; }
function clearError() { $('error').hidden = true; }
function send(type, data = {}) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...data })); }
function options() { return { voice: $('voice').value, language: $('language').value, pace: Number($('pace').value), customerId: $('customer').value, trigger: $('trigger').value }; }
function cardReady(){return configured&&!profileLoading&&selectedProfile?.id===$('customer').value&&selectedProfile.canStartCard;}
const rupees=n=>n===null||n===undefined?'Not supplied':new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(n);
function filterCustomers(){
  const selected=$('customer').value,query=$('customer-search').value.trim().toLowerCase(),segment=$('segment-filter').value;
  const matches=customerCatalog.filter(c=>`${c.name} ${c.id} ${c.city}`.toLowerCase().includes(query)&&(segment==='all'||c.segment===segment||(segment==='ready'&&c.canStartCard)||(segment==='review'&&c.segment!=='gold_only'&&!c.canStartCard)||(segment==='heroes'&&c.hero)));
  $('customer').replaceChildren();
  const append=(c,parent)=>{const option=document.createElement('option');option.value=c.id;option.textContent=`${c.name} · ${c.id} · ${c.city||'synthetic'}${c.canStartCard?'':' · read-only'}`;parent.append(option);};
  const current=customerCatalog.find(c=>c.id===selected);
  if(current&&!matches.some(c=>c.id===selected)){const group=document.createElement('optgroup');group.label='Current selection (outside filter)';append(current,group);$('customer').append(group);}
  for(const [value,label] of [['card_only','Card only'],['card_and_gold','Card + gold'],['gold_only','Gold only · read-only']]){
    const group=document.createElement('optgroup');group.label=label;
    for(const c of matches.filter(c=>c.segment===value))append(c,group);
    if(group.children.length)$('customer').append(group);
  }
  if(current)$('customer').value=current.id;
  $('customer-results').textContent=`${matches.length} of ${customerCatalog.length} profiles match.${current&&!matches.some(c=>c.id===selected)?' Current customer stays selected until you choose another.':''}`;
}
function profileFacts(id,rows){
  $(id).replaceChildren();
  for(const [label,value] of rows){const name=document.createElement('dt'),detail=document.createElement('dd');name.textContent=label;detail.textContent=String(value??'Not supplied');$(id).append(name,detail);}
}
function profileSessionNote(){
  const saved=sessionSnapshot?.customer;
  $('profile-session-note').textContent=saved&&saved.id===selectedProfile?.id&&saved.sourceRevision!==selectedProfile.sourceRevision?'This conversation uses its previously saved account snapshot. Choose New demo session to use the current CSV facts.':'';
}
async function loadSelectedProfile({defaults=false}={}){
  profileRequest?.abort();const request=new AbortController();profileRequest=request;
  const id=$('customer').value;selectedProfile=null;profileLoading=true;updateControls();$('customer-profile').setAttribute('aria-busy','true');
  try{
    const response=await fetch(`/api/customers/${encodeURIComponent(id)}`,{signal:request.signal});
    if(!response.ok)throw new Error('Could not load this customer profile.');
    const c=await response.json();if(request!==profileRequest||id!==$('customer').value)return;
    selectedProfile=c;$('customer-profile').hidden=false;
    $('profile-name').textContent=c.name;$('profile-meta').textContent=`${c.id} · ${c.city} · ${c.segment.replaceAll('_',' ')} · synthetic`;
    $('profile-description').textContent=`CSV scenario note (reference only): ${c.description}`;$('profile-status').textContent=c.canStartCard?'CARD DEMO READY':'READ-ONLY';
    $('profile-warnings').replaceChildren();
    for(const [messages,blocking] of [[c.blockingReasons,true],[c.warnings,false]])for(const message of messages){const p=document.createElement('p');p.className=`profile-warning${blocking?' blocking':''}`;p.textContent=message;$('profile-warnings').append(p);}
    $('card-profile').hidden=!c.card;$('gold-profile').hidden=!c.gold;
    if(c.card){const a=c.card;profileFacts('card-profile-facts',[
      ['Card',`${a.product} · ${a.cardId}`],['Status',a.status.replaceAll('_',' ')],['Policy tier',c.policyTier||'Needs review'],['Annualised spend',c.metrics?rupees(c.metrics.annual_spend_12m):'Not evaluated'],['Annual fee',rupees(a.annualFee)],['Waiver spend threshold',rupees(a.waiverSpend)],['Outstanding dues',rupees(a.dues)],['EMI outstanding',rupees(a.emi)],['Reward points',a.rewardPoints.toLocaleString('en-IN')],['Mandates / add-ons',`${a.mandates} / ${a.addons}`],['Bureau access',a.bureauReadable?'Consented & readable':'Unavailable · not used'],['Proactive contact',a.dnd?'DND enabled':a.marketingConsent?'Consent present; contact cap also checked':'No marketing consent']]);}
    if(c.gold){const g=c.gold,pct=n=>n===null?'Not supplied':`${n}%`;profileFacts('gold-profile-facts',[
      ['Enquiry date',g.enquiryOn||'Not supplied'],['Requested amount',rupees(g.gold_enquiry_amount)],['Existing loan',g.loanId?`${g.loanType} · ${g.loanId}`:'Not supplied'],['Loan outstanding',rupees(g.loan_outstanding)],['Current loan rate',pct(g.loan_rate_pct)],['Monthly EMI',rupees(g.loan_emi)],['Loan tenure',g.loan_tenure_months===null?'Not supplied':`${g.loan_tenure_months} months`],['Repayment profile',g.repaymentQuality||'Not supplied'],['Stated rival rate',pct(g.rival_rate_pct_stated)],['Requested rate',pct(g.customer_ask_rate_pct)],['Collateral gold',g.collateral_gold_grams===null?'Not supplied':`${g.collateral_gold_grams} g`],['Collateral value',rupees(g.collateral_value)]]);}
    $('profile-language').textContent=`Source language: ${{en:'English',hi:'Hindi',mr:'Marathi'}[c.language]||c.language}. Card suffixes and mandate labels are generated demo labels; the CSV contains no card-number suffixes or mandate names.`;
    if(defaults){$('language').value=c.language==='hi'?'hi-IN':'en-IN';$('trigger').value=c.scenario.trigger;}
    if(!sessionSnapshot)$('identity-note').textContent=c.canStartCard?'Selected CSV profile is ready. Start a new card demo or type a message.':'This profile is read-only. Choose a ready card customer to start a conversation.';
    profileSessionNote();
  }catch(error){if(error.name!=='AbortError'&&request===profileRequest){$('customer-profile').hidden=true;showError(error.message);}}
  finally{if(request===profileRequest){profileLoading=false;$('customer-profile').removeAttribute('aria-busy');updateControls();}}
}
function updateControls() {
  $('call').querySelector('span').textContent = active && !textOnly ? 'End conversation' : 'Start conversation';
  $('call').classList.toggle('end', active && !textOnly);
  $('call').disabled = connecting || !voiceAvailable || (!active&&!cardReady());
  $('mute').disabled = !active || textOnly;
  $('interrupt').disabled = !active;
  for (const id of ['voice', 'language', 'pace']) $(id).disabled = active || connecting;
  for (const id of ['customer','customer-search','segment-filter']) $(id).disabled=connecting||!configured;
  $('trigger').disabled=connecting||!cardReady();
  $('clear').disabled = connecting;
  $('new-session').disabled = connecting||!cardReady();
  $('message').disabled=connecting||(!active&&!cardReady());$('send').disabled=connecting||(!active&&!cardReady());
  $('resume').hidden = !savedSession || active;
  $('settings-note').textContent = active ? 'End or clear this session to change the voice settings.' : 'A warm voice. A natural pace. Room to pause.';
}
function addMessage(role, text = '') {
  $('empty')?.remove();
  const box = document.createElement('div'); box.className = `message ${role}`;
  const label = document.createElement('div'); label.className = 'message-label'; label.textContent = role === 'user' ? 'YOU' : 'ARIA';
  const content = document.createElement('p'); content.textContent = text;
  box.append(label, content); $('transcript').append(box); scrollTranscript();
  return { box, content };
}
function scrollTranscript() { $('transcript').scrollTop = $('transcript').scrollHeight; }
function clearTranscript() {
  $('transcript').replaceChildren(); $('partial').textContent = ''; assistantMessage = null;
}
function renderSession(value, { transcript = false, omitLast = false } = {}) {
  sessionSnapshot = value; savedSession = value;
  $('decision-panel').hidden = false; $('inspector').hidden = false;
  $('state-badge').textContent = value.state==='CLOSED'?'REQUEST SAVED':value.state.replaceAll('_',' ');
  $('identity-note').textContent = `${value.customer.name} · card ending ${value.customer.last4} · synthetic identity verified · session saved locally`;
  $('customer').value = value.customer.id; $('trigger').value = value.trigger;
  if(selectedProfile?.id!==value.customer.id)loadSelectedProfile();else profileSessionNote();
  if(transcript){const actionLabels={close_card:'Close the card',confirm_closure:'Confirm simulated closure',accept_offer:'Accept demo offer',decline_offer:'Decline and close',redeem_points:'Redeem demo points',skip:'Skip this step',resume_closure:'Continue closure'};clearTranscript();for(const item of value.transcript.slice(0,omitLast?-1:undefined))addMessage(item.role,item.role==='user'?(actionLabels[item.text]||item.text):item.text);}
  $('decision-facts').replaceChildren(); $('quick-actions').replaceChildren();
  const fact=(label,text)=>{const row=document.createElement('p'),name=document.createElement('b');name.textContent=label+' ';row.append(name,document.createTextNode(String(text)));$('decision-facts').append(row);};
  const button=(label,action,kind='')=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.className=`quick-action ${kind}`;b.addEventListener('click',()=>performAction(action));$('quick-actions').append(b);};
  const rupees=n=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(n);
  if(value.state==='DECIDE'&&value.offer){
    $('decision-title').textContent='Your demo offer';const o=value.offer;
    fact('Option',o.id.replace('CARD_','').replaceAll('_',' ').toLowerCase());
    if(o.amount!==undefined)fact('Fee amount',rupees(o.amount));
    if(o.spend!==undefined)fact('Condition',o.spend?`Spend ${rupees(o.spend)} in ${o.months} months`:'No spend condition');
    if(o.points!==undefined)fact('Points',`Up to ${o.points.toLocaleString('en-IN')} extra points over ${o.points_months||o.months} months`);
    if(o.id==='CARD_DOWNGRADE_FREE')fact('Annual fee','₹0 · LifetimeFree');
    button('Accept demo offer','accept_offer');button('Decline & close','decline_offer','quiet');
  }else if(value.state==='CLOSURE_FLOW'){
    $('decision-title').textContent='Closure checklist';
    const c=value.checklist;
    if(c){fact('Card',`Ending ${c.last4}`);fact('Dues',`${rupees(c.dues)} total · includes ${rupees(c.emi)} in EMIs`);fact('Rewards',`${c.points.toLocaleString('en-IN')} points`);fact('Mandates',c.mandates.join(', ')||'None');fact('Add-on cards',c.addons);}
    if(value.closureStep==='points'){button('Redeem demo points','redeem_points');button('Skip points','skip','quiet');}
    else if(value.closureStep==='confirm'){fact('Confirmation','Nothing is submitted until you confirm.');button('Confirm simulated closure','confirm_closure');}
    else button('Continue closure','resume_closure');
  }else if(value.state==='CLOSED'){
    $('decision-title').textContent='Demo closure request saved';fact('Reference',value.closure.reference);fact('Status',value.closure.status==='pending_dues'?'Pending dues · request accepted':'Submitted · not yet completed');fact('Demo target',value.closure.deadline);fact('Delivery','Written confirmation saved here. No SMS or email was sent.');
  }else if(value.state==='RETAINED'){
    $('decision-title').textContent='Demo change confirmed';fact('Result','The agreed terms are saved in the audit trail. No real account was changed.');button('Close the card instead','close_card','quiet');
  }else if(value.state==='HANDOFF'){
    $('decision-title').textContent='Simulated human review';fact('Status','Case saved locally. No real person has been connected.');if(!value.cases.some(c=>c.queue==='fraud'))button('Continue with closure','close_card','quiet');
  }else if(value.state==='BLOCKED'){
    $('decision-title').textContent='Outreach blocked';fact('Reason','Consent, DND or contact-frequency policy prevents this proactive call. Start a new inbound demo session.');
  }else{
    $('decision-title').textContent='You’re in control';fact('Policy','At most one retention offer and one counter-offer improvement.');button('Close the card','close_card','quiet');
  }
  $('policy-label').textContent=`${value.policyVersion} · demo`;
  $('policy-state').textContent=JSON.stringify({state:value.state,reason:value.reason,tier:value.tier,offers:value.offerCount,improvements:value.improvementCount,reasonQuestions:value.reasonQuestions,closureLocked:value.closureLocked,metrics:value.metrics},null,2);
  $('audit-status').textContent=value.auditValid?'· chain verified':'· integrity check failed';
  $('audit-list').replaceChildren();
  for(const event of value.trace.slice(-35).reverse()){const row=document.createElement('details'),summary=document.createElement('summary'),content=document.createElement('pre');summary.textContent=`${new Date(event.ts).toLocaleTimeString('en-IN')} · ${event.kind}`;content.textContent=JSON.stringify(event.detail,null,2);row.append(summary,content);$('audit-list').append(row);}
  $('handoff-list').replaceChildren();
  for(const item of value.cases){const p=document.createElement('p');p.textContent=`${item.id} · ${item.queue} · ${item.status} · demo target ${item.deadline}`;$('handoff-list').append(p);}
  if(!value.cases.length)$('handoff-list').textContent='No simulated cases.';
  fetch('/api/alerts').then(r=>r.ok?r.json():null).then(data=>{if(data&&sessionSnapshot?.id===value.id){const list=[...data.closures.map(c=>`${c.reference}: ${c.overdue?'overdue':'due soon'} (${c.status})`),...data.reviews.map(c=>`${c.id}: review due; no automatic approval`)];$('deadline-list').textContent=list.join('\n')||'No deadline alerts.';}}).catch(()=>{});
  updateControls();
}
async function performAction(action){
  if(connecting||!sessionSnapshot)return;
  try{if(!active)await startSession(true,true);clearError();interrupt();send('action',{action,token:action==='confirm_closure'?sessionSnapshot.confirmationToken:undefined,messageId:crypto.randomUUID(),expectedRevision:sessionSnapshot.revision});}
  catch{}
}
async function ensureAudio() {
  if (!context || context.state === 'closed') context = new AudioContext();
  await context.resume();
}
function stopPlayback() {
  generation++; clearTimeout(endTimer); audioQueue = Promise.resolve();
  for (const node of playing) { try { node.stop(); node.disconnect(); } catch {} }
  playing.clear(); nextAudio = context?.currentTime || 0;
}
function interrupt(notify = true) {
  if (turn !== null && assistantMessage) {
    assistantMessage.box.classList.add('cut');
    if (!assistantMessage.box.querySelector('.interruption-label')) {
      const label = document.createElement('div'); label.className = 'interruption-label'; label.textContent = 'Interrupted'; assistantMessage.box.append(label);
    }
  }
  stopPlayback(); turn = null;
  if (notify) send('interrupt');
  if (active) setState(muted ? 'muted' : 'listening');
  lastActivity = Date.now();
}
function queueAudio(message) {
  const token = generation, expectedTurn = turn;
  audioQueue = audioQueue.then(async () => {
    if (token !== generation || message.turn !== turn) return;
    const bytes = Uint8Array.from(atob(message.audio), c => c.charCodeAt(0));
    let buffer;
    if (message.content_type === 'audio/pcm') {
      buffer = context.createBuffer(1, bytes.byteLength / 2, message.sample_rate || 24000);
      const output = buffer.getChannelData(0), view = new DataView(bytes.buffer);
      for (let i = 0; i < output.length; i++) output[i] = view.getInt16(i * 2, true) / 32768;
    } else buffer = await context.decodeAudioData(bytes.buffer);
    if (token !== generation || expectedTurn !== turn) return;
    const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
    const when = Math.max(context.currentTime + 0.025, nextAudio);
    nextAudio = when + buffer.duration; playing.add(source);
    source.onended = () => { playing.delete(source); source.disconnect(); };
    source.start(when); setState('speaking'); lastActivity = Date.now();
  }).catch(() => { if (token === generation) { showError('This browser could not play the voice audio. Try Chrome or Edge.'); interrupt(); } });
}
function finishTurn(id) {
  const token = generation;
  audioQueue.then(() => {
    if (token !== generation || id !== turn) return;
    clearTimeout(endTimer);
    endTimer = setTimeout(() => {
      if (token !== generation || id !== turn) return;
      send('played', { turn: id }); turn = null; lastActivity = Date.now();
      setState(muted ? 'muted' : 'listening');
    }, Math.max(0, (nextAudio - context.currentTime) * 1000) + 80);
  });
}
async function startSession(typed = false, resume = false) {
  if(!resume&&!cardReady()){showError('Choose a card profile marked ready before starting a session.');throw new Error('Card profile is not ready.');}
  if (active || connecting) stopSession();
  connecting = true; textOnly = typed; clearError(); setState('connecting'); updateControls();
  try {
    await ensureAudio();
    if(!resume){
      const response=await fetch('/api/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...options(),channel:typed?'chat':'voice'})});
      const created=await response.json();if(!response.ok)throw new Error(created.error||'Could not create a demo session.');
      sessionSnapshot=created.session;savedSession=created.session;
    }
    if (!typed && sessionSnapshot?.state !== 'BLOCKED') {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access needs localhost or HTTPS in a supported browser. You can still type below.');
      media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      await context.audioWorklet.addModule('/mic-worklet.js');
    }
    clearTranscript();
    const ticketResponse=await fetch('/api/voice-ticket',{method:'POST'}),connection=await ticketResponse.json();
    if(!ticketResponse.ok)throw new Error(connection.error||'Could not authorize the voice connection.');
    const socket = new WebSocket(connection.url,['vaani',`ticket.${connection.ticket}`]); ws = socket;
    await new Promise((resolve, reject) => {
      let ready = false;
      const timeout = setTimeout(() => reject(new Error('Connection timed out. Please try again.')), 18000);
      socket.onopen = () => socket.send(JSON.stringify({ type: 'start', ...options(), textOnly: typed, newSession: !resume }));
      socket.onerror = () => { clearTimeout(timeout); reject(new Error('Could not reach the voice server. Please reconnect.')); };
      socket.onclose = () => {
        clearTimeout(timeout);
        if (!ready) reject(new Error('Voice connection closed before it was ready.'));
        if (ws === socket) { stopSession(); if (ready) showError('The connection ended. Start a new conversation to reconnect.'); }
      };
      socket.onmessage = event => {
        if (ws !== socket) return;
        const message = JSON.parse(event.data);
        if (message.type === 'ready') {
          clearTimeout(timeout); ready = true; active = true; connecting = false;
          sessionStart = Date.now(); $('duration').textContent='00:00'; lastActivity = Date.now(); setState('listening'); updateControls(); resolve();
          renderSession(message.session,{transcript:true,omitLast:message.willSpeak});
        } else if(message.type==='session') {
          renderSession(message.session);
        } else if (message.type === 'error') {
          showError(message.message);
          if (!ready) { clearTimeout(timeout); reject(new Error(message.message)); }
        } else if (message.type === 'turn_start') {
          stopPlayback(); turn = message.turn; assistantMessage = addMessage('assistant'); setState('thinking');
        } else if (message.type === 'assistant_delta' && message.turn === turn) {
          assistantMessage.content.textContent += message.text; scrollTranscript();
        } else if (message.type === 'user_text') {
          $('partial').textContent = ''; addMessage('user', message.text); lastActivity = Date.now();
        } else if (message.type === 'partial') { $('partial').textContent = message.text; lastActivity = Date.now(); }
        else if (message.type === 'audio' && message.turn === turn) queueAudio(message);
        else if (message.type === 'turn_done' && message.turn === turn) { assistantMessage.content.textContent = message.text; finishTurn(message.turn); }
        else if (message.type === 'interrupted' && message.turn === turn) interrupt(false);
        else if (message.type === 'listening') { if (turn === null) setState(muted ? 'muted' : 'listening'); lastActivity = Date.now(); }
        else if (message.type === 'latency') $('latency').textContent = `Last response · ${(message.ms / 1000).toFixed(2)}s to first audio`;
      };
    });
    if (!typed && active && media) {
      micSource = context.createMediaStreamSource(media);
      micNode = new AudioWorkletNode(context, 'aria-mic');
      const silence = context.createGain(); silence.gain.value = 0;
      micSource.connect(micNode); micNode.connect(silence); silence.connect(context.destination);
      micNode.port.onmessage = event => {
        if (!active || muted || ws?.readyState !== WebSocket.OPEN) return;
        const pcm = new Int16Array(event.data);
        meter = Math.sqrt(pcm.reduce((sum, value) => sum + (value / 32768) ** 2, 0) / pcm.length);
        if (meter > 0.025) {
          lastActivity = Date.now();
          if (!loudSince) loudSince = Date.now();
          if (turn !== null && Date.now() - loudSince >= 220) interrupt();
        } else loudSince = 0;
        if (ws.bufferedAmount < 128000) ws.send(event.data);
      };
    }
  } catch (error) {
    stopSession();
    showError(error.name === 'NotAllowedError' ? 'Microphone permission was declined. Allow it in your browser, or type below to test Aria’s voice.' : error.message);
    throw error;
  }
}
function stopSession() {
  const socket = ws; ws = null;
  if (socket) { socket.onclose = null; socket.close(); }
  media?.getTracks().forEach(track => track.stop()); media = null;
  micNode?.disconnect(); micSource?.disconnect(); micNode = null; micSource = null;
  stopPlayback(); turn = null; active = false; connecting = false; muted = false; meter = 0; loudSince = 0;
  $('mute').classList.remove('active'); $('mute').setAttribute('aria-label', 'Mute microphone');
  $('partial').textContent = ''; setState('idle'); updateControls();
}
$('call').addEventListener('click', () => {
  if (active && !textOnly) stopSession(); else startSession(false,Boolean(sessionSnapshot&&sessionSnapshot.customer.id===$('customer').value)).catch(() => {});
});
$('mute').addEventListener('click', () => {
  muted = !muted; media?.getAudioTracks().forEach(track => { track.enabled = !muted; });
  meter = 0; loudSince = 0; lastActivity = Date.now();
  $('mute').classList.toggle('active', muted); $('mute').setAttribute('aria-label', muted ? 'Unmute microphone' : 'Mute microphone');
  send('mute', { muted }); if (turn === null) setState(muted ? 'muted' : 'listening');
});
$('interrupt').addEventListener('click', () => interrupt());
$('clear').addEventListener('click', () => { stopSession(); clearTranscript(); $('latency').textContent = 'Designed to listen.'; $('duration').textContent = '00:00'; clearError(); });
$('resume').addEventListener('click',()=>{sessionSnapshot=savedSession;$('customer-search').value='';$('segment-filter').value='all';filterCustomers();$('customer').value=savedSession.customer.id;loadSelectedProfile();startSession(true,true).catch(()=>{});});
$('new-session').addEventListener('click',()=>{stopSession();sessionSnapshot=null;savedSession=null;clearTranscript();$('decision-panel').hidden=true;$('inspector').hidden=true;$('resume').hidden=true;startSession(true,false).catch(()=>{});});
for(const id of ['customer','trigger'])$(id).addEventListener('change',()=>{stopSession();sessionSnapshot=null;clearTranscript();clearError();$('decision-panel').hidden=true;$('inspector').hidden=true;$('identity-note').textContent='New synthetic scenario selected. Start a conversation or type a message.';if(id==='customer'){filterCustomers();loadSelectedProfile({defaults:true});}});
for(const id of ['customer-search','segment-filter'])$(id).addEventListener('input',filterCustomers);
$('pace').addEventListener('input', () => { $('pace-value').textContent = `${Number($('pace').value).toFixed(2)}×`; });
$('text-form').addEventListener('submit', async event => {
  event.preventDefault(); const text = $('message').value.trim(); if (!text || connecting || !configured) return;
  $('send').disabled = true;
  try { if (!active) await startSession(true,Boolean(sessionSnapshot&&sessionSnapshot.customer.id===$('customer').value)); else interrupt(); clearError(); send('text', { text, messageId:crypto.randomUUID(),expectedRevision:sessionSnapshot?.revision }); $('message').value = ''; }
  catch {} finally { updateControls(); }
});
setInterval(() => {
  if (active) {
    const seconds = Math.floor((Date.now() - sessionStart) / 1000);
    $('duration').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    if (!textOnly && !muted && turn === null && Date.now() - lastActivity > 18000) { send('silence'); lastActivity = Date.now(); }
  }
}, 1000);
setInterval(() => {
  const energy = state === 'speaking' ? 0.5 : Math.min(meter * 10, 1);
  bars.forEach((bar, index) => {
    const envelope = Math.sin((index + 1) / (bars.length + 1) * Math.PI);
    bar.style.height = `${4 + envelope * energy * (12 + Math.random() * 18)}px`;
  });
}, 130);
window.addEventListener('pagehide', stopSession);
$('backup-player').addEventListener('play',()=>{if(active)stopSession();});
async function initializeApp(){try {
  const response = await fetch('/api/config'); if (!response.ok) throw new Error();
  const info = await response.json(); voiceAvailable = info.voiceAvailable; configured = true;
  customerCatalog=info.customers;filterCustomers();
  if(info.dataset){const d=info.dataset;$('dataset-summary').textContent=`${d.total} profiles · ${d.cardProfiles} with cards · ${d.goldProfiles} with gold details · ${d.cardReady} ready for card demos`;}
  await loadSelectedProfile({defaults:true});
  $('connection').replaceChildren(); const dot = document.createElement('i');
  $('connection').append(dot, voiceAvailable ? 'Demo voice ready' : 'Chat ready · voice keys needed');
  $('connection').classList.toggle('failed', !voiceAvailable);
  $('models').textContent = `Policy: deterministic rule engine · Intent fallback: ${info.model} · Voice: ${info.ttsModel} · Listening: ${info.sttModel}.`;
  const previous=await fetch('/api/session');if(previous.ok){savedSession=(await previous.json()).session;$('resume').hidden=false;}
} catch { showError('Could not reach the server. Please refresh or check the deployment connection.'); $('connection').textContent = 'Server unavailable'; }
finally{updateControls();}}
await initializeApp();
  }catch(error){$('access-error').textContent=error.message;}
  finally{$('access-submit').disabled=false;}
});
await initializeApp();
