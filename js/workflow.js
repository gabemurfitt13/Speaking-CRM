(function(root){
'use strict';
const C=root.CRMCommand;
const lanes=[['respond','Respond today'],['ready','Ready for outreach'],['followup','Follow-ups due'],['booked','Bookings to manage'],['waiting','Awaiting reply'],['research','Verify contact'],['paused','Paused / closed']];
function today(){return C.day(new Date());}
function valid(v){return C.validDate(String(v||'').slice(0,10));}
function businessDays(day,n=5){let d=day;while(n){d=C.addDays(d,1);const w=new Date(d+'T12:00:00Z').getUTCDay();if(w!==0&&w!==6)n--;}return d;}
function logs(r){return Array.isArray(r.log)?r.log:Array.isArray(r.command?.workflowLog)?r.command.workflowLog:[];}
function sent(e){return /^(Email|Email sent|Initial email sent|Follow.up sent|Pricing sent|Proposal sent)$/i.test(e.type||'')&&!/queued|scheduled|draft|failed|bounced/i.test(e.note||'')&&(/sent/i.test(e.type||'')||/sent|via Gmail/i.test(e.note||'')||e.gmailMessageId||e.providerMessageId||e.activity==='first_contact'||e.activity==='follow_up');}
function latest(r,predicate){return logs(r).filter(predicate).map(e=>valid(e.date||e.timestamp)).filter(Boolean).sort().pop()||'';}
function state(r,day=today(),kind='progress'){
 const x=r.command||{},status=r.status||'',follow=valid(r.followUp||r.follow_up);
 const lastSent=latest(r,sent),lastReply=latest(r,e=>e.type==='Reply')||valid(x.replyReceivedOn);
 const reached=!!(lastSent||valid(r.contacted)||['Emailed','Contacted','Follow-up','Left Voicemail'].includes(status));
 const reply=!!(lastReply||x.replyNeedsResponse||['Replied','Conversation'].includes(x.stage)||status==='In Discussion');
 const needsReply=x.replyNeedsResponse===true||(!!lastReply&&(!valid(x.replyHandledOn)||valid(x.replyHandledOn)<lastReply))||(reply&&x.replyNeedsResponse!==false&&!x.replyHandledOn);
 const verified=!!(r.email&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)&&['high','verified'].includes(String(r.contactConfidence||r.contact_confidence||'').toLowerCase())&&(r.contactSource||r.contact_source)&&valid(r.lastVerified||r.last_verified));
 const closed=['Not Interested','Closed'].includes(status)||x.doNotContact===true||x.outreachPaused===true;
 const suppressed=/do not contact|opt.?out|unsubscribe|not interested/i.test(r.notes||'');
 const booked=['Booked!','Booked','Completed'].includes(status);
 const deferred=status==='Try Next Year';
 const proposal=!!(x.proposalSentOn||x.stage==='Pricing / Proposal'||status==='Quote Sent');
 const pricing=x.pricingRequested===true&&x.pricingResponded!==true;
 let stage=closed?'Closed':booked?'Booked':proposal?'Pricing / Proposal':(status==='In Discussion'||x.stage==='Conversation')?'Conversation':reply?'Replied':reached?'Contacted':'New Lead';
 const tasks=[];
 if(booked){
  if(x.contractStatus!=='Signed')tasks.push({key:'contract',label:'Complete contract'});
  if(C.money(x.depositAmount)>0&&!x.depositReceived)tasks.push({key:'deposit',label:'Collect deposit'});
  if(!valid(r.gigDate||r.booking_date||x.eventDate))tasks.push({key:'event_date',label:'Set event date'});
  if(!x.location||!x.audience||C.money(r.fee??x.fee)===null)tasks.push({key:'event_details',label:'Confirm event details'});
  if(valid(x.paymentDue)&&valid(x.paymentDue)<=day&&!['Received'].includes(r.payStatus||r.pay_status||x.paymentStatus))tasks.push({key:'payment',label:'Collect payment'});
 }
 let lane,label,task,due=follow;
 if(closed||suppressed){lane='paused';label='Outreach paused';task='paused';}
 else if(deferred&&(!follow||follow>day)){lane='paused';label=follow?'Reconnect '+follow:'Set a reconnect date';task='reconnect';}
 else if(booked){lane='booked';label=tasks[0]?.label||'Event ready';task=tasks[0]?.key||'event_ready';}
 else if(pricing){lane='respond';label='Send requested pricing';task='pricing';}
 else if(needsReply||(kind==='website_inquiries'&&status==='New')){lane='respond';label='Respond to inquiry';task='reply';}
 else if(proposal){lane=follow&&follow<=day?'followup':'waiting';label=lane==='followup'?'Follow up on proposal':'Await proposal decision';task='proposal';}
 else if(follow&&follow<=day){lane='followup';label='Follow up today';task='followup';}
 else if(reached||reply||kind==='website_inquiries'){lane='waiting';label=follow?'Follow up '+follow:'Set a follow-up date';task='followup';}
 else if(verified){lane='ready';label='Review initial outreach';task='initial';}
 else{lane='research';label='Verify main contact';task='verify';}
 return {lane,stage,label,task,due,lastSent,lastReply,verified,tasks,routinePaused:closed||suppressed||booked||needsReply||pricing||deferred};
}
function transition(r,previous={},day=today(),kind='progress'){
 const next={...r,command:{...(r.command||{})}},x=next.command,old=previous.command||{};
 const added=logs(next).filter(e=>!logs(previous).some(o=>JSON.stringify(o)===JSON.stringify(e)));
 const newReply=added.some(e=>e.type==='Reply'),newSend=added.some(sent),proposal=added.some(e=>e.type==='Proposal sent')||x.proposalSentOn!==old.proposalSentOn&&!!valid(x.proposalSentOn);
 if(added.some(e=>e.type==='Pricing request')){x.pricingRequested=true;x.pricingResponded=false;x.replyNeedsResponse=true;}
 if(newReply){x.replyNeedsResponse=true;x.replyReceivedOn=latest(next,e=>e.type==='Reply')||day;}
 if(x.pricingRequested&&!old.pricingRequested)x.replyNeedsResponse=true;
 if(x.pricingResponded&&!old.pricingResponded){x.replyNeedsResponse=false;x.replyHandledOn=day;}
 if(newSend&&!newReply){x.replyNeedsResponse=false;x.replyHandledOn=day;}
 const lastSent=latest(next,sent);
 if((newSend||proposal||next.status!==previous.status&&['Emailed','Quote Sent'].includes(next.status))&&!['Booked!','Booked','Completed','Not Interested','Closed'].includes(next.status)){
  const field=kind==='progress'?'followUp':'follow_up';
  if(!valid(next[field])||valid(next[field])<=(lastSent||day))next[field]=businessDays(lastSent||valid(x.proposalSentOn)||day);
 }
 if(['Booked!','Booked'].includes(next.status)&&!['Booked!','Booked'].includes(previous.status)&&!x.bookedOn)x.bookedOn=day;
 if(next.email!==previous.email&&previous.email){x.contactChangedOn=day;}
 const w=state(next,day,kind);x.workflow=w;x.stage=w.stage;return next;
}
function act(r,action,day=today(),kind='progress'){
 const x={...(r.command||{})},next={...r,command:x},entry={date:day,timestamp:new Date().toISOString(),note:'Recorded by CRM owner'};
 if(action==='reply'){entry.type='Reply';x.replyNeedsResponse=true;x.replyReceivedOn=day;}
 else if(action==='pricing_requested'){entry.type='Pricing request';x.pricingRequested=true;x.pricingResponded=false;x.replyNeedsResponse=true;}
 else if(action==='pricing_sent'){if(kind==='website_inquiries'&&next.status==='New')next.status='Contacted';entry.type='Pricing sent';x.pricingResponded=true;x.replyNeedsResponse=false;x.replyHandledOn=day;x.stage='Conversation';}
 else if(action==='proposal_sent'){entry.type='Proposal sent';x.proposalSentOn=day;x.replyNeedsResponse=false;x.replyHandledOn=day;next.status=kind==='website_inquiries'?'Contacted':'Quote Sent';}
 else if(action==='response_sent'){if(kind==='website_inquiries'&&next.status==='New')next.status='Contacted';entry.type='Email sent';entry.activity='follow_up';x.replyNeedsResponse=false;x.replyHandledOn=day;}
 else if(action==='booked'){entry.type='Booking';next.status=kind==='progress'?'Booked!':'Booked';}
 else if(action==='closed'){entry.type='Note';next.status=kind==='website_inquiries'?'Closed':'Not Interested';x.outreachPaused=true;}
 else if(action==='contract_signed'){entry.type='Note';x.contractStatus='Signed';}
 else if(action==='deposit_received'){entry.type='Note';x.depositReceived=true;}
 else throw Error('Unknown workflow action');
 next.log=[{...entry,note:entry.note+' · '+action},...logs(r)];
 return transition(next,r,day,kind);
}
root.CRMWorkflow={lanes,state,transition,act,businessDays,sent};
if(typeof module!=='undefined')module.exports=root.CRMWorkflow;
})(typeof window==='undefined'?globalThis:window);
