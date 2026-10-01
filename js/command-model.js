(function(root){
'use strict';
const markets=['Schools','Businesses / Organizations','Conferences / Associations','Churches','Partners / Sponsors','Referrals'];
const stages=['New Lead','Contacted','Replied','Conversation','Pricing / Proposal','Booked'];
const day=d=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Boise',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
function validDate(v){return typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&!isNaN(Date.parse(v))&&new Date(v+'T12:00:00Z').toISOString().slice(0,10)===v?v:'';}
function money(v){if(v===''||v==null)return null;const n=Number(String(v).replace(/[$,]/g,''));return Number.isFinite(n)&&n>=0?n:null;}
function week(d){const s=day(d);const t=new Date(s+'T12:00:00Z');t.setUTCDate(t.getUTCDate()-((t.getUTCDay()+6)%7));return t.toISOString().slice(0,10);}
function normalize(c,kind='progress'){
 const x=c.command||{};const inquiry=kind==='website_inquiries';
 const market=x.market||(inquiry?(c.organization_type==='School'?'Schools':c.organization_type==='Organization'?'Businesses / Organizations':'Unclassified'):c.type==='Business'?'Businesses / Organizations':c.type==='Church'?'Churches':'Schools');
 const booked=['Booked!','Booked','Completed'].includes(c.status);
 const closed=['Not Interested','Closed'].includes(c.status);
 const stage=booked?'Booked':closed?'Closed':(x.stage&&x.stage!=='Booked'?x.stage:null)||({'Not Started':'New Lead',New:'New Lead','Left Voicemail':'Contacted',Emailed:'Contacted',Contacted:'Contacted','Follow-up':'Contacted','In Discussion':'Conversation','Quote Sent':'Pricing / Proposal','Try Next Year':'Contacted'}[c.status]||'New Lead');
 const mapped=({'Not Started':'New Lead',New:'New Lead','Left Voicemail':'Contacted',Emailed:'Contacted',Contacted:'Contacted','Follow-up':'Contacted','In Discussion':'Conversation','Quote Sent':'Pricing / Proposal'}[c.status]||'New Lead');
 const resolvedStage=(!booked&&!closed&&stages.indexOf(mapped)>stages.indexOf(stage))?mapped:stage;
 const tracking=c.tracking||{};const source=x.source||(inquiry?sourceFor(tracking):'Unknown');
 return {id:String(c.id),key:kind+':'+c.id,kind,raw:c,command:x,name:c.school||c.organization||c.name||'Unnamed',market,stage:resolvedStage,booked,closed,source,
  fee:money(inquiry?x.fee:(c.fee!==''&&c.fee!=null?c.fee:x.fee??(!booked?x.potentialFee:undefined))),date:validDate(inquiry?c.booking_date:c.gigDate||x.eventDate),bookedOn:validDate(x.bookedOn),followUp:validDate(inquiry?c.follow_up:c.followUp),log:c.log||[],created:validDate((c.created_at||x.createdAt||'').slice(0,10)),
  payStatus:c.payStatus||c.pay_status||x.paymentStatus||'Not Invoiced',location:x.location||c.location||[c.city,c.state].filter(Boolean).join(', '),audience:c.students||c.audience_size||x.audience||'',contact:c.contact||c.email||'',test:/integration-test/i.test(tracking.source||'')};
}
function sourceFor(t){const v=(t.utm_source||t.source||'').toLowerCase();if(/organic|google|bing|duckduckgo/.test(v))return 'Google / SEO';if(/facebook|instagram|linkedin|tiktok|youtube|social/.test(v))return 'Social media';if(/referral/.test(v))return 'Referral';if(/partner/.test(v))return 'Partner';if(!v||/direct.*unknown/.test(v))return 'Website (unattributed)';return 'Website: '+(t.utm_source||t.source);}
function emails(r){return r.log.filter(e=>e.type==='Email'&&!/queued|scheduled|bounc|failed|draft/i.test(e.note||'')&&(/sent|via Gmail/i.test(e.note||'')||['first_contact','follow_up'].includes(e.activity))).sort((a,b)=>String(a.date).localeCompare(String(b.date)));}
function evidence(r,activity){const known=new Set(['New Lead']);if(emails(r).length||r.raw.contacted)known.add('Contacted');if(r.kind==='website_inquiries')known.add('Replied');if(r.stage!=='Closed')known.add(r.stage);
 for(const e of r.log){if(e.type==='Reply')known.add('Replied');if(e.type==='Sales conversation')known.add('Conversation');if(e.type==='Proposal sent')known.add('Pricing / Proposal');}
 for(const e of activity.filter(e=>e.record_kind===r.kind&&e.record_id===r.id)){const s=e.event_type==='milestone'?e.details.stage:e.event_type==='status'?({'In Discussion':'Conversation','Quote Sent':'Pricing / Proposal','Booked!':'Booked',Booked:'Booked',Completed:'Booked',Emailed:'Contacted'}[e.details.to]):null;if(s)known.add(s);}
 return known;
}
function model(records,activity=[],now=new Date(),market='All',period='All time'){
 const today=day(now),start=week(now),year=today.slice(0,4),end90=new Date(today+'T12:00:00Z');end90.setUTCDate(end90.getUTCDate()+90);const horizon=day(end90);
 const all=records.filter(r=>!r.test&&!r.command.linkedRecord);
 const scoped=all.filter(r=>market==='All'||r.market===market);
 const cutoff=period==='This year'?year+'-01-01':period==='Last 90 days'?(()=>{const d=new Date(today+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-90);return d.toISOString().slice(0,10);})():'';
 const selected=scoped.filter(r=>!cutoff||r.created>=cutoff||r.log.some(e=>e.date>=cutoff)||activity.some(e=>e.record_kind===r.kind&&e.record_id===r.id&&day(new Date(e.occurred_at))>=cutoff));
 const booked=scoped.filter(r=>r.booked);const bookingDate=r=>r.bookedOn||(()=>{const e=activity.find(e=>e.record_kind===r.kind&&e.record_id===r.id&&e.event_type==='status'&&['Booked!','Booked'].includes(e.details.to));return e?day(new Date(e.occurred_at)):'';})();
 const ytd=booked.filter(r=>bookingDate(r)>=year+'-01-01'&&bookingDate(r)<=today);
 const upcoming=booked.filter(r=>r.date>=today).sort((a,b)=>a.date.localeCompare(b.date));
 const pipeline=selected.filter(r=>!r.booked&&!r.closed&&r.stage!=='New Lead');const proposals=selected.filter(r=>r.stage==='Pricing / Proposal');
 const sum=rs=>rs.reduce((n,r)=>n+(r.fee||0),0);
 const weekly={qualified:0,first:0,follow:0,partner:0,conference:0,content:0,conversation:0,pricing:0,proposal:0,booking:0};const weeklyRows={};
 function count(k,r){weekly[k]++;(weeklyRows[k]||=[]).push(r);}
 for(const r of scoped){const es=emails(r);es.forEach((e,i)=>{if(e.date>=start&&e.date<=today){count(e.activity==='follow_up'||/follow.up/i.test(e.note||'')||i>0?'follow':'first',r);if(r.market==='Partners / Sponsors')count('partner',r);}});
  if(r.created>=start&&r.created<=today&&r.market==='Conferences / Associations')count('conference',r);
  const qualified=validDate(r.command.qualifiedOn);if(r.command.qualified&&qualified>=start&&qualified<=today)count('qualified',r);
  for(const e of r.log)if(e.date>=start&&e.date<=today){if(r.market==='Partners / Sponsors'&&['Call','Meeting'].includes(e.type))count('partner',r);const k={'Sales conversation':'conversation','Pricing request':'pricing','Proposal sent':'proposal'}[e.type];if(k)count(k,r);}
  for(const [k,stage] of [['conversation','Conversation'],['proposal','Pricing / Proposal']]){if(!(r.log||[]).some(e=>e.type===(k==='conversation'?'Sales conversation':'Proposal sent')&&e.date>=start&&e.date<=today)&&activity.some(e=>e.record_kind===r.kind&&e.record_id===r.id&&day(new Date(e.occurred_at))>=start&&day(new Date(e.occurred_at))<=today&&((e.event_type==='milestone'&&e.details.stage===stage&&e.details.fromStage!==stage)||(e.event_type==='status'&&e.details.to===(k==='conversation'?'In Discussion':'Quote Sent')))))count(k,r);}
  if(!r.log.some(e=>e.type==='Pricing request'&&e.date>=start&&e.date<=today)&&activity.some(e=>e.record_kind===r.kind&&e.record_id===r.id&&e.event_type==='milestone'&&e.details.pricingRequested==='true'&&e.details.previousPricingRequested!=='true'&&day(new Date(e.occurred_at))>=start&&day(new Date(e.occurred_at))<=today))count('pricing',r);
  if(bookingDate(r)>=start&&bookingDate(r)<=today)count('booking',r);
 }
 weekly.content=activity.filter(e=>e.record_kind==='content'&&day(new Date(e.occurred_at))>=start&&day(new Date(e.occurred_at))<=today).length;
 const alerts=[];function alert(r,label,priority){alerts.push({r,label,priority});}
 for(const r of scoped){if(r.closed)continue;const x=r.command;
  if(r.kind==='website_inquiries'&&r.raw.status==='New')alert(r,'Respond to new website inquiry',0);
  if(r.followUp&&r.followUp<=today&&!r.booked)alert(r,(r.followUp<today?'Overdue':'Today')+' · follow up '+r.followUp,r.followUp<today?1:2);
  if(x.pricingRequested&&!x.pricingResponded)alert(r,'Send requested pricing',1);
  if(r.stage==='Pricing / Proposal')alert(r,'Follow up on proposal'+(x.proposalSentOn?' · sent '+x.proposalSentOn:''),3);
  if(validDate(x.cfpDeadline)&&x.cfpDeadline>=today&&x.cfpDeadline<=horizon&&x.cfpDeadline<=addDays(today,14)&&x.submissionStatus!=='Submitted')alert(r,'Submit CFP by '+x.cfpDeadline,1);
  if(validDate(x.callDate)&&x.callDate>=today&&x.callDate<=addDays(today,7))alert(r,'Sales call '+x.callDate,2);
  if(r.booked){if(x.contractStatus!=='Signed')alert(r,'Complete speaking contract',3);if(r.payStatus!=='Received'&&validDate(x.paymentDue)&&x.paymentDue<=today)alert(r,'Collect outstanding payment · due '+x.paymentDue,1);
   if(money(x.depositAmount)>0&&!x.depositReceived)alert(r,'Collect deposit',3);
   if(r.date&&r.date>=today&&r.date<=addDays(today,30)&&(!r.location||!r.audience||r.fee===null))alert(r,'Confirm upcoming event details',2);
   if(!r.date)alert(r,'Set booked engagement date',2);
   if(r.date&&r.date<today&&(!x.testimonialRequested||!x.referralRequested))alert(r,'Request post-event testimonial / referral',4);
  }else if(!r.followUp&&['Conversation','Replied','Contacted'].includes(r.stage)){const latest=[r.raw.contacted,...r.log.map(e=>e.date)].filter(validDate).sort().pop();if(latest&&latest<addDays(today,-14))alert(r,'Restart conversation · inactive 14+ days',4);}
 }
 alerts.sort((a,b)=>a.priority-b.priority||a.r.name.localeCompare(b.r.name));
 return {today,start,selected,scoped,weekly,weeklyRows,alerts,booked,ytd,upcoming,pipeline,proposals,sum,bookingDate,
 kpis:{ytd:sum(ytd),next90:sum(upcoming.filter(r=>r.date<=horizon)),pipeline:sum(pipeline),bookings:ytd.length},unknownFees:booked.filter(r=>r.fee===null).length,unknownBookingDates:booked.filter(r=>!bookingDate(r)).length};
}
function addDays(s,n){const d=new Date(s+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);}
const api={markets,stages,day,week,money,validDate,normalize,emails,evidence,model,addDays};if(typeof module!=='undefined')module.exports=api;root.CRMCommand=api;
})(typeof window==='undefined'?globalThis:window);
