(function(root){
'use strict';
function proposals(records,model){
 const out=[],today=model.today;
 function add(r,type,title,rationale,priority,key,payload){out.push({record_kind:r.kind,record_id:r.id,action_type:type,title,rationale,priority,source:'rules',source_key:r.key+':'+key,payload:payload||{}});}
 for(const r of records){
  if(r.test||r.closed||r.command.linkedRecord)continue;
  const x=r.command||{};
  if(r.kind==='website_inquiries'&&r.raw.status==='New')add(r,'respond_inquiry','Respond to new website inquiry','A new booking inquiry is waiting for a response.',0,'new-inquiry');
  if(x.pricingRequested&&!x.pricingResponded)add(r,'send_pricing','Send requested pricing','Pricing was requested and is not marked answered.',1,'pricing-requested');
  if(r.followUp&&r.followUp<=today&&!r.booked)add(r,'follow_up',(r.followUp<today?'Overdue':'Today')+' follow-up','The recorded follow-up date is '+r.followUp+'.',r.followUp<today?1:2,'follow-up:'+r.followUp,{follow_up:r.followUp});
  if(r.stage==='Pricing / Proposal'&&!r.booked)add(r,'proposal_follow_up','Follow up on proposal','This opportunity is in Pricing / Proposal and is not booked.',3,'proposal-follow-up:'+(x.proposalSentOn||'current'));
  if(r.booked){
   if(x.contractStatus!=='Signed')add(r,'complete_contract','Complete speaking contract','Booked engagement does not have a signed contract recorded.',3,'contract');
   if(r.payStatus!=='Received'&&x.paymentDue&&x.paymentDue<=today)add(r,'collect_payment','Collect outstanding payment','Payment is due '+x.paymentDue+' and is not marked received.',1,'payment:'+x.paymentDue);
   if(Number(x.depositAmount)>0&&!x.depositReceived)add(r,'collect_deposit','Collect deposit','A deposit is recorded but not marked received.',3,'deposit');
   if(!r.date)add(r,'set_event_date','Set booked engagement date','The engagement is booked without an event date.',2,'event-date');
   if(r.date&&r.date>=today&&r.date<=root.CRMCommand.addDays(today,30)&&(!r.location||!r.audience||r.fee===null))add(r,'confirm_event','Confirm upcoming event details','The event is within 30 days and is missing location, audience, or fee details.',2,'confirm:'+r.date);
   if(r.date&&r.date<today&&(!x.testimonialRequested||!x.referralRequested))add(r,'post_event_follow_up','Request testimonial / referral','The event date has passed and post-event requests are incomplete.',4,'post-event:'+r.date);
  } else if(!r.followUp&&['Conversation','Replied','Contacted'].includes(r.stage)){
   const dates=[r.raw.contacted,...(r.log||[]).map(e=>e.date)].filter(root.CRMCommand.validDate).sort(),latest=dates.pop();
   if(latest&&latest<root.CRMCommand.addDays(today,-14))add(r,'restart_conversation','Restart inactive conversation','No follow-up is scheduled and recorded activity is more than 14 days old.',4,'restart:'+latest);
  }
 }
 return out;
}
async function sync(client,uid,records,model){
 const wanted=proposals(records,model); if(!wanted.length)return [];
 const rows=wanted.map(a=>({...a,user_id:uid}));
 const q=await client.from('ai_actions').upsert(rows,{onConflict:'user_id,source_key',ignoreDuplicates:true}).select('*');
 if(q.error)throw q.error; return q.data||[];
}
async function list(client,uid){
 const q=await client.from('ai_actions').select('*').eq('user_id',uid).in('status',['pending','approved']).order('priority').order('created_at',{ascending:false});
 if(q.error)throw q.error; return q.data||[];
}
async function decide(client,uid,id,status){
 if(!['approved','dismissed'].includes(status))throw Error('Unsupported action decision');
 const q=await client.from('ai_actions').update({status,decided_at:new Date().toISOString()}).eq('user_id',uid).eq('id',id).select('*').single();
 if(q.error)throw q.error; return q.data;
}
const api={proposals,sync,list,decide};if(typeof module!=='undefined')module.exports=api;root.CRMOrchestrator=api;
})(typeof window==='undefined'?globalThis:window);