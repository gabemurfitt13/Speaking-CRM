(function(root){
'use strict';
const stages=['Qualified','Contacted','Conversation','Pricing / Proposal','Decision'];
function date(v){return typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&!isNaN(Date.parse(v))?v:'';}
function model(c,kind='progress',today=''){
 const command=c.command||{},sales=command.sales||{},status=c.status||'Not Started';
 const won=['Booked!','Booked','Completed'].includes(status),lost=['Not Interested','Closed'].includes(status),deferred=status==='Try Next Year';
 const stage=won?'Won':lost?'Lost':stages.includes(sales.stage)?sales.stage:command.stage==='Pricing / Proposal'?'Pricing / Proposal':status==='In Discussion'||['Conversation','Replied'].includes(command.stage)?'Conversation':status==='Emailed'||status==='Left Voicemail'?'Contacted':'Qualified';
 const inPipeline=kind==='website_inquiries'||!!sales.inPipeline||won||lost||status==='In Discussion'||['Conversation','Pricing / Proposal','Replied'].includes(command.stage)||command.qualified===true;
 const money=v=>v===''||v==null?null:Number.isFinite(Number(v))?Number(v):null;
 const acts=(Array.isArray(sales.activities)?sales.activities:[]).map(a=>({...a,recordKey:kind+':'+c.id}));
 const legacy=date(c.followUp||c.follow_up);
 if(legacy&&!acts.some(a=>a.due===legacy))acts.push({id:acts.some(a=>a.id==='legacy')?'legacy:'+legacy:'legacy',type:'email',subject:'Follow up',due:legacy,recordKey:kind+':'+c.id});
 const pending=acts.filter(a=>!a.completedAt).sort((a,b)=>(a.due||'9999').localeCompare(b.due||'9999')||(a.time||'').localeCompare(b.time||''));
 const next=pending[0]||null;
 const market=command.market||(kind==='website_inquiries'?(c.organization_type==='School'?'Schools':'Organizations'):({Business:'Organizations',Church:'Churches',Conference:'Conferences',College:'Colleges'}[c.type]||'Schools'));
 return {id:String(c.id),key:kind+':'+c.id,kind,raw:c,command,sales,revision:sales.revision||'0',name:c.school||c.organization||c.name||'Unnamed organization',person:c.contact||c.contact_name||'',email:c.email||'',phone:c.phone||'',status,stage,won,lost,deferred,inPipeline,market,value:money(command.potentialFee??sales.value??c.fee??command.fee),expectedClose:date(sales.expectedClose),activities:acts,pending,next,activityState:next?(next.due<today?'overdue':next.due===today?'today':'scheduled'):'none',log:c.log||command.workflowLog||[],notes:c.notes||'',location:[c.city,c.state].filter(Boolean).join(', '),extraContacts:c.extraContacts||c.extra_contacts||[],test:/integration-test/i.test(c.tracking?.source||'')||!!command.linkedRecord};
}
function activityRows(records){return records.filter(r=>r.inPipeline&&!r.lost&&!r.deferred).flatMap(r=>r.pending.map(a=>({...a,r}))).sort((a,b)=>(a.due||'9999').localeCompare(b.due||'9999')||(a.time||'').localeCompare(b.time||'')||a.r.name.localeCompare(b.r.name));}
function history(r){return [...r.log.map((e,i)=>({id:e.gmailMessageId||e.messageId||'log'+i,date:String(e.timestamp||e.sentAt||e.date||''),title:e.type||e.activity||'Activity',text:e.note||e.summary||'',subject:e.subject||'',email:e.recipient||'',thread:e.gmailThreadId||e.originalThreadId||''})),...(r.sales.notes||[]).map(e=>({id:e.id,date:e.createdAt,title:'Note',text:e.text})),...r.activities.filter(a=>a.completedAt).map(a=>({id:a.id,date:a.completedAt,title:'Activity completed',text:a.subject}))].sort((a,b)=>b.date.localeCompare(a.date));}
const api={stages,model,activityRows,history,date};root.CRMSalesModel=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
