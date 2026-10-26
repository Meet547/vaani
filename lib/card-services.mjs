import { randomBytes, randomUUID } from 'node:crypto';
import { digest } from './store.mjs';
import { retentionOptions, businessDeadline } from './policy.mjs';
import { safeDetail } from './privacy.mjs';

export class CardServices {
  constructor(store,policy,clock=()=>Date.now()){this.store=store;this.policy=policy;this.clock=clock;}
  requireIdentity(s){if(!s.verified)throw new Error('Identity verification is required before accessing card data.');}
  log(s,name,result){this.store.audit(s.id,'SERVICE',{name,result:safeDetail(result)},this.clock());return result;}
  get_customer_360(s){this.requireIdentity(s);return this.log(s,'get_customer_360',{name:s.customer.name,customer:'synthetic-'+s.customer.last4,tenure_months:s.customer.tenure_months,bureau_consent:s.customer.bureau_consent});}
  get_card_summary(s){this.requireIdentity(s);const c=s.customer;return this.log(s,'get_card_summary',{product:c.product,last4:c.last4,status:c.status,annual_fee:c.annual_fee,reward_points:c.reward_points});}
  get_transactions(s){this.requireIdentity(s);return this.log(s,'get_transactions',{monthly_spend:s.customer.monthly_spend,source:'synthetic_monthly_aggregates'});}
  fetch_cibil(s){this.requireIdentity(s);if(!s.customer.bureau_consent){this.store.audit(s.id,'GUARDRAIL',{rule:'bureau_unavailable'},this.clock());return null;}return this.log(s,'fetch_cibil',{score_band:s.customer.score>=this.policy.tiers.high.minimum_score?'higher':'standard',dpd_30_count:s.customer.dpd_30_count,dpd_90_count:s.customer.dpd_90_count});}
  get_retention_options(s,reason=s.reason){this.requireIdentity(s);const result=retentionOptions(s.customer,reason,this.policy,s.usedActions);return this.log(s,'get_retention_options',result);}
  prepareOffer(s,option,{improved=false,amount=null}={}) {
    const offer=structuredClone(option);
    if(offer.id==='CARD_POINTS_BOOST') {offer.max_points=offer.points;offer.points=improved?(amount??offer.max_points):Math.max(1,Math.floor(offer.max_points*this.policy.card.points_initial_fraction));}
    if(amount!==null&&offer.id==='CARD_FEE_WAIVER_COND')offer.amount=amount;
    return this.log(s,'prepare_retention_offer',offer);
  }
  apply_retention_action(s,id) {
    this.requireIdentity(s);
    if(s.closureLocked||s.state!=='DECIDE'||s.currentOffer?.id!==id)throw new Error('That action is not the current authorized offer.');
    const offer=s.currentOffer, valid=this.get_retention_options(s).options.find(o=>o.id===id);
    if(!valid||['amount','points'].some(k=>offer[k]!==undefined&&(!Number.isSafeInteger(offer[k])||offer[k]<0||offer[k]>(valid[k]??-1)))||['spend','months','points_months','annual_fee'].some(k=>offer[k]!==valid[k]))throw new Error('Offer no longer meets policy limits.');
    const result={id:randomUUID(),action_id:id,terms:offer,status:'simulated_applied'};
    this.store.db.prepare('INSERT INTO actions VALUES(?,?,?,?)').run(result.id,s.id,id,JSON.stringify(offer));
    s.usedActions.push(id);
    if(id==='CARD_DOWNGRADE_FREE'){s.customer.product='LifetimeFree';s.customer.annual_fee=0;}
    if(['CARD_FEE_REVERSAL','CARD_FEE_WAIVER_COND','CARD_COMPETITOR_MATCH'].includes(id)){s.customer.prior_waiver_days_ago=0;s.customer.prior_waiver_12m=true;}
    return this.log(s,'apply_retention_action',result);
  }
  get_closure_checklist(s){this.requireIdentity(s);const c=s.customer;return this.log(s,'get_closure_checklist',{last4:c.last4,dues:c.outstanding_dues,emi:c.emi_outstanding,points:c.reward_points,mandates:c.mandates,addons:c.addon_cards,points_disclosure:this.policy.disclosures.points,emi_disclosure:this.policy.disclosures.emi});}
  redeem_points(s){this.requireIdentity(s);if(s.state!=='CLOSURE_FLOW'||s.closureStep!=='points')throw new Error('Point redemption is not pending.');const points=s.customer.reward_points;s.customer.reward_points=0;return this.log(s,'redeem_points',{points,status:'simulated_redeemed'});}
  snapshot(s){return digest(JSON.stringify({customer:s.customer.id,last4:s.customer.last4,dues:s.customer.outstanding_dues,emi:s.customer.emi_outstanding,points:s.customer.reward_points,policy:this.policy.card.policy_version}));}
  issueConfirmation(s) {
    this.requireIdentity(s);this.invalidateConfirmation(s);
    const token=randomBytes(32).toString('base64url');
    const expires=this.clock()+this.policy.closure.confirmation_ttl_seconds*1000;
    this.store.db.prepare('INSERT INTO challenges(token_hash,session_id,snapshot,expires) VALUES(?,?,?,?)').run(digest(token),s.id,this.snapshot(s),expires);
    s.confirmationToken=token;s.confirmationExpires=expires;s.voiceReconfirmations=0;
    this.store.audit(s.id,'CONFIRMATION_ISSUED',{expires},this.clock());return token;
  }
  invalidateConfirmation(s){this.store.db.prepare('DELETE FROM challenges WHERE session_id=? AND used=0').run(s.id);s.confirmationToken=null;s.confirmationExpires=null;}
  process_closure(s,token,{explicit=false,source='unknown'}={}) {
    this.requireIdentity(s);
    if(!explicit||!token)throw new Error('Explicit confirmation and its token are required.');
    const challenge=this.store.db.prepare('SELECT * FROM challenges WHERE token_hash=? AND session_id=?').get(digest(token),s.id);
    if(!challenge)throw new Error('Invalid confirmation token.');
    const existing=this.store.db.prepare('SELECT * FROM closures WHERE session_id=?').get(s.id);
    if(challenge.used && existing)return this.log(s,'process_closure',{...existing,idempotent:true});
    if(challenge.expires<=this.clock())throw new Error('Confirmation expired. Please review and confirm again.');
    if(challenge.snapshot!==this.snapshot(s))throw new Error('Card facts changed. Please review and confirm again.');
    if(s.state!=='CLOSURE_FLOW'||s.closureStep!=='confirm'||s.customer.status!=='active')throw new Error('Closure is not ready for confirmation.');
    const result={id:randomUUID(),reference:'CC-'+randomBytes(4).toString('hex').toUpperCase(),status:s.customer.outstanding_dues>0?'pending_dues':'submitted',deadline:businessDeadline(new Date(this.clock()),this.policy.closure.completion_working_days,this.policy.closure),created:this.clock()};
    this.store.db.prepare('INSERT INTO closures(id,session_id,customer_id,reference,status,deadline,created) VALUES(?,?,?,?,?,?,?)').run(result.id,s.id,s.customer.id,result.reference,result.status,result.deadline,result.created);
    this.store.db.prepare('UPDATE challenges SET used=1 WHERE token_hash=?').run(digest(token));
    this.store.audit(s.id,'CONFIRMATION_ACCEPTED',{source,explicit:true},this.clock());
    return this.log(s,'process_closure',result);
  }
  handoff_to_human(s,queue,request) {
    this.requireIdentity(s);
    if(!['credit_ops','fraud','complaints','relationship_manager'].includes(queue))throw new Error('Invalid handoff queue.');
    const existing=this.store.db.prepare('SELECT * FROM cases WHERE session_id=? AND queue=?').get(s.id,queue);
    if(existing)return {...existing,summary:JSON.parse(existing.summary)};
    const closure=this.store.db.prepare('SELECT reference,status,deadline FROM closures WHERE session_id=?').get(s.id)||null;
    const data=retentionOptions(s.customer,s.reason,this.policy,s.usedActions);
    const summary=safeDetail({customer:'synthetic-'+s.customer.last4,product:s.customer.product,tenure_months:s.customer.tenure_months,tier:data.tier,reason:s.reason,request,metrics:data.metrics,fee:s.customer.annual_fee,points:s.customer.reward_points,dues:s.customer.outstanding_dues,offers:s.offers,closure,closure_intent:s.closureLocked,recommended_action:data.options[0]?.id||null,authority_cap:this.policy.tiers.limits[data.tier].waiver,priority:closure&&closure.deadline<=businessDeadline(new Date(this.clock()),this.policy.closure.reminder_working_days,this.policy.closure)?'high':'normal'});
    const result={id:'CASE-'+randomBytes(4).toString('hex').toUpperCase(),queue,status:'simulated_pending',deadline:businessDeadline(new Date(this.clock()),this.policy.card.review_working_days,this.policy.closure),summary};
    this.store.db.prepare('INSERT INTO cases VALUES(?,?,?,?,?,?)').run(result.id,s.id,queue,result.status,result.deadline,JSON.stringify(summary));
    return this.log(s,'handoff_to_human',result);
  }
}
