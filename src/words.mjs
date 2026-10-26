const ones=['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
const tens=['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];
export function words(value) {
  if(!Number.isSafeInteger(value)||value<0)throw new Error('Speech numbers must be non-negative integers from validated facts.');
  if(value<20)return ones[value];
  if(value<100)return tens[Math.floor(value/10)]+(value%10?' '+ones[value%10]:'');
  for(const [scale,name] of [[10000000,'crore'],[100000,'lakh'],[1000,'thousand'],[100,'hundred']])if(value>=scale)return words(Math.floor(value/scale))+' '+name+(value%scale?' '+words(value%scale):'');
}
export const money=n=>words(n)+' rupees';
export const digits=value=>String(value).split('').map(c=>/\d/.test(c)?ones[Number(c)]:c.toUpperCase()).join(' ');
export function spokenDate(value){return new Intl.DateTimeFormat('en-IN',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(`${value}T12:00:00Z`)).replace(/\d+/g,n=>words(Number(n)));}
