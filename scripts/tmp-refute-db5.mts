import { q, sb } from './tmp-refute-lib.mts';
const rows = await q(()=>sb.from('paystub_dispatch_queue').select('id,cycle_source_file,recipient_email,recipient_name,department_key,amount_php,pay_period,payload,created_at').eq('recipient_email','erjiee@simple.biz').order('created_at',{ascending:false}).limit(4),'erjiee');
console.log('rows',rows.length);
for(const row of rows as any[]){
  console.log('\n============ cycle', row.cycle_source_file, '| period', row.pay_period, '| amount_php', row.amount_php, '|', row.created_at);
  console.log(JSON.stringify(row.payload, null, 1));
}
