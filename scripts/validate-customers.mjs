import {readFileSync} from 'node:fs';
import {parseCsv,loadCustomerData,datasetPath} from '../lib/customer-data.mjs';
import {loadPolicy,metrics,assignTier,validatePolicy} from '../lib/policy.mjs';

// Optional input is inspected, not copied or activated. No expected value changes policy.
const csv=readFileSync(process.argv[2]||datasetPath,'utf8');
const data=loadCustomerData(csv),policy=loadPolicy({customerSource:'fixtures'});
policy.customers=data.customers;validatePolicy(policy);
const rows=new Map(parseCsv(csv).rows.map(r=>[r.customer_id,r]));
const tierDifferences=data.customers.flatMap(c=>{
  const expected=rows.get(c.id).EXP_value_tier,computed=assignTier(c,metrics(c,policy),policy);
  return expected&&expected!==computed?[{id:c.id,computed,csvExpected:expected}]:[];
});
console.log(JSON.stringify({summary:data.summary,cardRecordsNeedingReview:data.catalog.filter(c=>c.segment!=='gold_only'&&!c.canStartCard).map(c=>({id:c.id,reasons:c.blockingReasons})),tierDifferences},null,2));
