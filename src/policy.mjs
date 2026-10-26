import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { loadCustomerData } from './customer-data.mjs';

const root = new URL('../', import.meta.url);
export function loadPolicy({customerSource='csv'}={}) {
  const read = path => parse(readFileSync(new URL(path, root), 'utf8'), { uniqueKeys: true, maxAliasCount: 0 });
  const policy = {
    card: read('config/card.yaml'), tiers: read('config/card_tiers.yaml'),
    closure: read('config/card_closure.yaml'), disclosures: read('config/disclosures.yaml'),
    customers: read('config/customers.yaml').customers,
  };
  if(customerSource==='csv'){
    const data=loadCustomerData();policy.customers=data.customers;policy.catalog=data.catalog;policy.dataset=data.summary;
  }else if(customerSource!=='fixtures')throw new Error('Unknown customer source.');
  validatePolicy(policy);
  return policy;
}
export function validatePolicy(p) {
  if (p.card.mode !== 'demo' || p.card.approved_for_live_use !== false || process.env.APP_MODE === 'production') throw new Error('Live banking mode is disabled. This build only supports synthetic demo services.');
  if (p.card.max_offers !== 1 || p.card.max_improvements !== 1 || p.card.max_reason_questions !== 1) throw new Error('Policy cannot loosen the one-offer, one-improvement or one-question limits.');
  const positive = value => Number.isSafeInteger(value) && value > 0;
  for (const key of ['waiver_cap','points_cap','points_months','waiver_months','reversal_days','repeat_waiver_months','review_working_days','competitor_min_tenure_months','human_level_one_cap','contact_cooldown_days']) if (!positive(p.card[key])) throw new Error(`Invalid card policy: ${key}`);
  for (const key of ['completion_working_days','confirmation_ttl_seconds','session_ttl_hours','reminder_working_days']) if (!positive(p.closure[key])) throw new Error(`Invalid closure policy: ${key}`);
  if (!(p.card.voice_confirmation_threshold > 0 && p.card.voice_confirmation_threshold <= 1) || p.card.max_voice_reconfirmations !== 1) throw new Error('Invalid voice confirmation policy.');
  if (!(p.card.points_initial_fraction > 0 && p.card.points_initial_fraction <= 1)) throw new Error('Invalid initial points fraction.');
  if(Object.values(p.card.ranking).some(n=>typeof n!=='number'||!Number.isFinite(n)||n<0)||p.card.ranking.acceptance_probability>1)throw new Error('Invalid offer ranking weights.');
  if (!Array.isArray(p.closure.weekend_days) || p.closure.weekend_days.length > 6 || p.closure.weekend_days.some(n => !Number.isInteger(n) || n < 0 || n > 6)) throw new Error('Invalid business calendar.');
  if (!Array.isArray(p.closure.holidays) || p.closure.holidays.some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d))) throw new Error('Invalid holiday calendar.');
  if (!p.closure.dues_are_completion_condition || !p.card.closure_continues_during_review) throw new Error('Closure safeguards cannot be disabled.');
  for (const tier of ['A','B','C','D','X']) for (const key of ['waiver','reversal','points','competitor']) if (!Number.isSafeInteger(p.tiers.limits[tier]?.[key]) || p.tiers.limits[tier][key] < 0) throw new Error('Invalid tier limit.');
  for (const key of ['waiver','reversal','points','competitor']) if (p.tiers.limits.X[key] || p.tiers.limits.D[key]) throw new Error('Restricted/dormant tiers cannot receive cost-bearing offers.');
  for (const value of [p.tiers.restricted.min_dpd90,p.tiers.restricted.score_below,p.tiers.high.spend,p.tiers.high.minimum_score,p.tiers.high.spend_without_bureau,p.tiers.core_spend,p.tiers.light_spend]) if (!positive(value)) throw new Error('Invalid tier threshold.');
  if (!(p.tiers.max_fee_to_spend_ratio > 0) || !Number.isFinite(p.tiers.dormant_trend_pct)) throw new Error('Invalid tier ratio.');
  if(p.tiers.high.spend<p.tiers.core_spend||p.tiers.core_spend<p.tiers.light_spend)throw new Error('Tier thresholds must be ordered.');
  if (!Array.isArray(p.card.never_say) || !p.card.never_say.length) throw new Error('Missing prohibited phrases.');
  const ids = new Set();
  for (const c of p.customers) {
    if (ids.has(c.id) || !/^(H-CARD-\d+|C\d{4})$/.test(c.id) || !/^\d{4}$/.test(c.last4)) throw new Error('Invalid synthetic customer identity.'); ids.add(c.id);
    for (const key of ['annual_fee','fee_waiver_spend','reward_points','outstanding_dues','emi_outstanding','credit_limit','tenure_months','addon_cards']) if (!Number.isSafeInteger(c[key]) || c[key] < 0) throw new Error(`Invalid customer fact ${key}`);
    if (c.emi_outstanding > c.outstanding_dues || c.monthly_spend.length !== 12 || c.monthly_spend.some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error('Invalid customer balances or transactions.');
    for(const key of ['fee_days_ago','prior_waiver_days_ago','last_contact_days_ago'])if(c[key]!==null&&(!Number.isSafeInteger(c[key])||c[key]<0))throw new Error('Invalid customer date offset.');
    for(const key of ['bureau_consent','outreach_consent','dnd','fraud_ticket','service_ticket','relationship'])if(typeof c[key]!=='boolean')throw new Error('Invalid customer consent or flag.');
  }
  return p;
}

export function metrics(c, p) {
  const annual = c.monthly_spend.reduce((a,b) => a+b,0) * (c.tenure_months > 0 && c.tenure_months < 12 ? 12 / c.tenure_months : 1);
  const last = c.monthly_spend.slice(-3).reduce((a,b) => a+b,0), previous = c.monthly_spend.slice(-6,-3).reduce((a,b) => a+b,0);
  return {
    annual_spend_12m: Math.round(annual), spend_trend_pct: previous ? (last-previous)/previous*100 : (last ? null : 0),
    fee_charged_recently: c.fee_charged_recently ?? (c.fee_days_ago !== null && c.fee_days_ago >= 0 && c.fee_days_ago <= p.card.reversal_days),
    fee_to_spend_ratio: annual ? c.annual_fee/annual : null,
    dues_ratio: c.credit_limit ? c.outstanding_dues/c.credit_limit : null,
    prior_waiver_12m: c.prior_waiver_12m ?? (c.prior_waiver_days_ago !== null && c.prior_waiver_days_ago < p.card.repeat_waiver_months * 365.2425 / 12),
    relationship_flag: c.relationship,
  };
}
export function assignTier(c, m, p) {
  const t = p.tiers;
  // Bureau is never consulted without consent. Fraud and card status are independent.
  if (c.fraud_ticket || c.status !== 'active' || (c.bureau_consent && (c.written_off_or_settled || c.dpd_90_count >= t.restricted.min_dpd90 || c.score < t.restricted.score_below))) return 'X';
  if (m.annual_spend_12m >= (c.bureau_consent ? t.high.spend : t.high.spend_without_bureau) && (!c.bureau_consent || c.score >= t.high.minimum_score)) return 'A';
  if (m.annual_spend_12m >= t.core_spend) return 'B';
  if (m.annual_spend_12m >= t.light_spend) return 'C';
  return 'D';
}
export function businessDeadline(now, days, calendar) {
  const local = new Intl.DateTimeFormat('en-CA', {timeZone: calendar.timezone, year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const date = new Date(`${local}T12:00:00Z`);
  while (days > 0) { date.setUTCDate(date.getUTCDate()+1); if (!calendar.weekend_days.includes(date.getUTCDay()) && !calendar.holidays.includes(date.toISOString().slice(0,10))) days--; }
  return date.toISOString().slice(0,10);
}

export function retentionOptions(c, reason, p, used = []) {
  const m = metrics(c,p), tier = assignTier(c,m,p), limits = p.tiers.limits[tier], options = [];
  const cap = kind => Math.min(c.annual_fee, limits[kind], p.card.waiver_cap);
  const add = (id, facts) => { if (!used.includes(id)) options.push({id, ...facts}); };
  if (c.fraud_ticket || c.status !== 'active') return {options, metrics:m, tier};
  if (cap('waiver') > 0 && c.fee_waiver_spend > 0 && !m.prior_waiver_12m && (tier !== 'C' || (m.fee_to_spend_ratio !== null && m.fee_to_spend_ratio <= p.tiers.max_fee_to_spend_ratio))) add('CARD_FEE_WAIVER_COND',{amount:cap('waiver'),spend:tier==='A'?0:c.fee_waiver_spend,months:p.card.waiver_months});
  if (cap('reversal') > 0 && m.fee_charged_recently && !m.prior_waiver_12m) add('CARD_FEE_REVERSAL',{amount:cap('reversal')});
  if (c.product !== 'LifetimeFree') add('CARD_DOWNGRADE_FREE',{annual_fee:0});
  if (limits.points > 0 && m.annual_spend_12m > 0) add('CARD_POINTS_BOOST',{points:Math.min(limits.points,p.card.points_cap),months:p.card.points_months});
  if (reason === 'competitor' && cap('competitor') > 0 && c.tenure_months >= p.card.competitor_min_tenure_months && c.bureau_consent && c.dpd_30_count===0 && c.dpd_90_count===0 && !m.prior_waiver_12m) add('CARD_COMPETITOR_MATCH',{amount:cap('competitor'),points:Math.min(limits.points,p.card.points_cap),months:p.card.waiver_months,points_months:p.card.points_months});
  const preferred = {fee:'CARD_FEE_WAIVER_COND',not_using:'CARD_DOWNGRADE_FREE',low_rewards:'CARD_POINTS_BOOST',competitor:'CARD_COMPETITOR_MATCH'}[reason] || (m.annual_spend_12m===0 || tier==='D' ? 'CARD_DOWNGRADE_FREE':'CARD_FEE_WAIVER_COND');
  const w = p.card.ranking;
  for (const offer of options) {
    const fit = offer.id===preferred ? 1 : (offer.id==='CARD_DOWNGRADE_FREE' ? .7 : .3);
    offer.score_breakdown = {fit:fit*w.fit_weight,acceptance:p.card.ranking.acceptance_probability*w.acceptance_weight,relationship:c.relationship?w.relationship_weight:0,cost:(offer.amount||0)*w.cost_weight};
    const b=offer.score_breakdown; offer.score=b.fit+b.acceptance+b.relationship-b.cost;
  }
  options.sort((a,b)=>b.score-a.score || a.id.localeCompare(b.id));
  return { options, metrics:m, tier };
}
