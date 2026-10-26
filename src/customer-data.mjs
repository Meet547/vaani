import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const datasetPath = new URL('../config/datasets/bombaybank_card_gold_synthetic_250.csv', import.meta.url);
const months = ['2025_11','2025_12',...Array.from({length:10},(_,i)=>`2026_${String(i+1).padStart(2,'0')}`)];
const triggers = new Set(['card_closure_request','downgrade_request','usage_drop','churn_score_high']);

// Strict CSV parsing: quoted commas/newlines/escaped quotes are data, never instructions.
export function parseCsv(text) {
  if (Buffer.byteLength(text)>5_000_000) throw new Error('Customer CSV exceeds the 5 MB limit.');
  text=text.replace(/^\uFEFF/,'');
  const rows=[]; let row=[],field='',quoted=false,afterQuote=false;
  const cell=()=>{row.push(field);field='';afterQuote=false;};
  const line=()=>{cell();if(row.some(v=>v!==''))rows.push(row);row=[];};
  for(let i=0;i<text.length;i++) {
    const ch=text[i];
    if(quoted){if(ch==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;afterQuote=true;}}else field+=ch;continue;}
    if(ch===','){cell();continue;}
    if(ch==='\n'||ch==='\r'){if(ch==='\r'&&text[i+1]==='\n')i++;line();continue;}
    if(afterQuote)throw new Error('Unexpected content after a quoted CSV field.');
    if(ch==='"'){if(field!=='')throw new Error('Unexpected quote in CSV field.');quoted=true;}else field+=ch;
  }
  if(quoted)throw new Error('Unclosed CSV quote.');
  if(field!==''||row.length||afterQuote)line();
  const headers=rows.shift();
  if(!headers?.length||headers.some(h=>!h)||new Set(headers).size!==headers.length)throw new Error('CSV headers must be nonempty and unique.');
  if(rows.length>10000)throw new Error('Too many customer rows.');
  return {headers,rows:rows.map((values,i)=>{if(values.length!==headers.length)throw new Error(`CSV row ${i+2} has the wrong number of columns.`);return Object.fromEntries(headers.map((h,j)=>[h,values[j]]));})};
}
const required=['row_no','customer_id','full_name','city','language','segment','is_hero','case_description','card_id','card_product','card_status','credit_limit','annual_fee','fee_waiver_spend','reward_points','outstanding_dues','emi_outstanding','addon_cards','mandates_count','card_tenure_months','fee_charged_recently','prior_waiver_12m','consent_bureau_pull','bureau_readable_by_agent','consent_marketing','consent_service','dnd','has_salary_account','last_outbound_contact_days_ago','cibil_score_on_file','dpd_30_count','dpd_90_count','written_off_or_settled','open_ticket_category','card_trigger_event','stated_reason','closure_intent','channel','customer_ask',...months.map(m=>'spend_'+m)];
const number=(row,key,{optional=false,integer=true}={})=>{
  const raw=row[key];if(optional&&(raw===''||raw===undefined))return null;
  if(typeof raw!=='string'||!/^\d+(\.\d+)?$/.test(raw))throw new Error(`Missing or invalid ${key}`);
  const n=Number(raw);if(!Number.isFinite(n)||n>Number.MAX_SAFE_INTEGER||(integer&&!Number.isSafeInteger(n)))throw new Error(`Invalid ${key}`);return n;
};
const flag=(row,key)=>{if(!['0','1'].includes(row[key]))throw new Error(`Missing or invalid ${key}`);return row[key]==='1';};
const text=(row,key)=>String(row[key]||'').trim().slice(0,1000);

export function loadCustomerData(csv=readFileSync(datasetPath,'utf8')) {
  const parsed=parseCsv(csv);
  for(const key of required)if(!parsed.headers.includes(key))throw new Error(`Customer CSV is missing ${key}.`);
  const revision=createHash('sha256').update(csv).digest('hex');
  const customers=[],catalog=[],ids=new Set(),rowNumbers=new Set();
  for(const row of parsed.rows){
    const id=row.customer_id;
    if(!/^(H-(CARD|LR)-\d+|C\d{4})$/.test(id)||ids.has(id))throw new Error(`Invalid or duplicate customer ID: ${id}`);
    ids.add(id);
    const rowNumber=number(row,'row_no');
    if(rowNumber<1||rowNumber>9999||rowNumbers.has(rowNumber))throw new Error('Invalid or duplicate row number.');rowNumbers.add(rowNumber);
    if(!['card_only','gold_only','card_and_gold'].includes(row.segment)||!row.full_name.trim())throw new Error(`Invalid customer profile: ${id}`);
    const profile={id,name:text(row,'full_name'),city:text(row,'city'),language:text(row,'language'),segment:row.segment,hero:flag(row,'is_hero'),description:text(row,'case_description'),sourceRevision:revision,card:null,gold:null,warnings:[],blockingReasons:[],canStartCard:false,
      scenario:{trigger:triggers.has(row.card_trigger_event)?row.card_trigger_event:'customer_message',reason:text(row,'stated_reason'),closureIntent:text(row,'closure_intent'),channel:text(row,'channel'),customerAsk:text(row,'customer_ask')}};
    if(profile.language==='mr')profile.warnings.push('Source language is Marathi. This demo supports English and Hindi; English is selected by default.');
    if(row.segment!=='gold_only') {
      try {
        if(number(row,'mandates_count')>100)throw new Error('Invalid mandate count');
        if(!row.card_id||!['active','blocked','closure_requested'].includes(row.card_status))throw new Error('Missing card ID or unsupported card status');
        const c={id,name:profile.name,product:text(row,'card_product'),last4:String(rowNumber).padStart(4,'0'),source_revision:revision,source_kind:'csv',
          tenure_months:number(row,'card_tenure_months'),credit_limit:number(row,'credit_limit'),annual_fee:number(row,'annual_fee'),fee_waiver_spend:row.card_product==='LifetimeFree'&&row.annual_fee==='0'&&row.fee_waiver_spend===''?0:number(row,'fee_waiver_spend'),reward_points:number(row,'reward_points'),outstanding_dues:number(row,'outstanding_dues'),emi_outstanding:number(row,'emi_outstanding'),addon_cards:number(row,'addon_cards'),status:row.card_status,
          monthly_spend:months.map(m=>number(row,'spend_'+m)),mandates:Array.from({length:number(row,'mandates_count')},(_,i)=>`Synthetic mandate ${i+1}`),
          bureau_consent:flag(row,'consent_bureau_pull')&&flag(row,'bureau_readable_by_agent'),score:null,dpd_30_count:0,dpd_90_count:0,written_off_or_settled:false,
          relationship:flag(row,'has_salary_account'),outreach_consent:flag(row,'consent_marketing'),service_consent:flag(row,'consent_service'),dnd:flag(row,'dnd'),last_contact_days_ago:number(row,'last_outbound_contact_days_ago',{optional:true}),
          fraud_ticket:row.open_ticket_category==='fraud',service_ticket:row.open_ticket_category==='service',
          fee_days_ago:null,prior_waiver_days_ago:null,fee_charged_recently:flag(row,'fee_charged_recently'),prior_waiver_12m:flag(row,'prior_waiver_12m')};
        if(c.bureau_consent){c.score=number(row,'cibil_score_on_file');if(c.score<300||c.score>900)throw new Error('Invalid readable bureau score');c.dpd_30_count=number(row,'dpd_30_count');c.dpd_90_count=number(row,'dpd_90_count');c.written_off_or_settled=flag(row,'written_off_or_settled');}
        profile.card={cardId:row.card_id,product:c.product,status:c.status,displayLast4:c.last4,displayLast4IsSynthetic:true,annualFee:c.annual_fee,creditLimit:c.credit_limit,waiverSpend:c.fee_waiver_spend,rewardPoints:c.reward_points,dues:c.outstanding_dues,emi:c.emi_outstanding,addons:c.addon_cards,mandates:c.mandates.length,tenureMonths:c.tenure_months,monthlySpend:c.monthly_spend,bureauReadable:c.bureau_consent,dnd:c.dnd,marketingConsent:c.outreach_consent,serviceConsent:c.service_consent,feeChargedRecently:c.fee_charged_recently,priorWaiver:c.prior_waiver_12m};
        if(c.emi_outstanding>c.outstanding_dues)profile.blockingReasons.push('EMI outstanding exceeds stated total dues. Correct the source balances before starting a card session.');
        if(c.status!=='active')profile.blockingReasons.push(`Card status is ${c.status.replaceAll('_',' ')}. This demo cannot start a new card journey for this status.`);
        if(!c.service_consent)profile.blockingReasons.push('Service consent is missing.');
                const annual=c.monthly_spend.reduce((a,b)=>a+b,0);
        if(row.spend_12m!==''&&row.spend_12m!==undefined&&number(row,'spend_12m')!==annual)profile.warnings.push('CSV spend total differs from its monthly values; policy uses the monthly values.');
        if(!profile.blockingReasons.length){customers.push(c);profile.canStartCard=true;}
      }catch(error){profile.blockingReasons.push(error.message);}
    }else profile.blockingReasons.push('Gold-only profile: card actions are unavailable. Gold details are read-only.');
    if(row.segment!=='card_only'){
      const fields=['gold_enquiry_amount','loan_principal','loan_outstanding','loan_rate_pct','loan_emi','loan_tenure_months','collateral_gold_grams','collateral_value','rival_rate_pct_stated','customer_ask_rate_pct'];
      profile.gold={readOnly:true,enquiryOn:text(row,'gold_enquiry_on'),loanId:text(row,'existing_loan_id'),loanType:text(row,'existing_loan_type'),need:text(row,'gold_need'),repaymentQuality:text(row,'repayment_quality')};
      for(const key of fields){try{profile.gold[key]=number(row,key,{optional:true,integer:false});}catch{profile.gold[key]=null;profile.warnings.push(`Gold field ${key} is invalid and was not interpreted.`);}}
    }
    catalog.push(profile);
  }
  return {customers,catalog,summary:{filename:'bombaybank_card_gold_synthetic_250.csv',revision,total:catalog.length,cardProfiles:catalog.filter(c=>c.card).length,goldProfiles:catalog.filter(c=>c.gold).length,cardReady:catalog.filter(c=>c.canStartCard).length,cardNeedsReview:catalog.filter(c=>c.segment!=='gold_only'&&!c.canStartCard).length,segments:Object.fromEntries(['card_only','gold_only','card_and_gold'].map(s=>[s,catalog.filter(c=>c.segment===s).length]))}};
}

export function customerIndex(profile){return Object.fromEntries(['id','name','city','language','segment','hero','description','canStartCard'].map(key=>[key,profile[key]]));}
