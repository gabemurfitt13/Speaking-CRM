const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const C=require('../js/command-model.js');global.CRMCommand=C;
const W=require('../js/workflow.js');
const day='2026-10-13';
const verified={id:'v',school:'Verified school',status:'Not Started',email:'main@example.org',contactConfidence:'VERIFIED',contactSource:'https://example.org',lastVerified:day,log:[],command:{}};
test('verification moves to ready only with email, source, and date',()=>{
 assert.equal(W.state(verified,day).lane,'ready');
 for(const change of [{email:''},{contactSource:''},{lastVerified:'bad'},{contactConfidence:'LIKELY'}])assert.equal(W.state({...verified,...change},day).lane,'research');
});
test('confirmed send schedules five business days and moves to waiting',()=>{
 const updated=W.transition({...verified,status:'Emailed',log:[{type:'Email sent',date:'2026-10-09',providerMessageId:'m'}]},verified,day);
 assert.equal(updated.followUp,'2026-10-16');assert.equal(updated.command.workflow.lane,'waiting');
 assert.equal(W.state(updated,'2026-10-16').lane,'followup');
 assert.equal(W.businessDays('2026-10-09',5),'2026-10-16');
});
test('queued or failed emails do not count as confirmed sends',()=>{
 const updated=W.transition({...verified,log:[{type:'Email',date:day,note:'Queued for sending'}]},verified,day);
 assert.equal(updated.followUp,undefined);assert.equal(updated.command.workflow.lane,'ready');
});
test('reply pauses routine outreach, answer clears response task, newer reply restores it',()=>{
 const r=W.act({...verified,status:'Emailed'},'reply',day);
 assert.equal(r.command.workflow.lane,'respond');assert.equal(r.command.workflow.routinePaused,true);
 const answered=W.act(r,'response_sent',day);
 assert.equal(answered.command.workflow.lane,'waiting');assert.equal(answered.command.workflow.routinePaused,false);
 const next=W.transition({...answered,log:[{type:'Reply',date:day,timestamp:'new-reply'},...answered.log]},answered,day);
 assert.equal(next.command.workflow.lane,'respond');
});
test('pricing and proposals advance next actions without treating a draft as a send',()=>{
 const asked=W.act(verified,'pricing_requested',day);assert.equal(asked.command.workflow.task,'pricing');
 const sent=W.act(asked,'pricing_sent',day);assert.notEqual(sent.command.workflow.lane,'respond');assert.equal(sent.command.stage,'Conversation');
 const proposal=W.act(sent,'proposal_sent',day);assert.equal(proposal.command.stage,'Pricing / Proposal');assert.equal(proposal.followUp,'2026-10-20');
 assert.equal(W.state(proposal,'2026-10-20').lane,'followup');
});
test('booking tasks shrink as contract and deposit are completed',()=>{
 const booked=W.act({...verified,command:{depositAmount:100}},'booked',day);
 assert.equal(booked.command.workflow.lane,'booked');assert.equal(booked.command.bookedOn,day);
 assert(booked.command.workflow.tasks.some(t=>t.key==='contract'));assert(booked.command.workflow.tasks.some(t=>t.key==='deposit'));
 const signed=W.act(booked,'contract_signed',day),paid=W.act(signed,'deposit_received',day);
 assert(!paid.command.workflow.tasks.some(t=>['contract','deposit'].includes(t.key)));
 assert.equal(W.act(paid,'closed',day).command.workflow.lane,'paused');
});
test('deferred and suppressed records do not enter ready',()=>{
 assert.equal(W.state({...verified,status:'Try Next Year',followUp:'2027-01-01'},day).lane,'paused');
 assert.equal(W.state({...verified,notes:'Do not contact'},day).lane,'paused');
});
test('transitions preserve contact data, notes, manual future dates, and unrelated metadata',()=>{
 const prev={...verified,notes:'Keep notes',extraContacts:[{name:'Second'}],followUp:'2026-11-03',infoSent:true,command:{source:'Referral'}};
 const next=W.transition({...prev,status:'Emailed',log:[{type:'Email sent',date:day}]},prev,day);
 assert.equal(next.notes,prev.notes);assert.deepEqual(next.extraContacts,prev.extraContacts);assert.equal(next.followUp,prev.followUp);assert.equal(next.command.source,'Referral');assert.equal(next.infoSent,true);
});
test('website inquiries and snake-case lead fields participate in workflow',()=>{
 assert.equal(W.state({status:'New',command:{}},day,'website_inquiries').lane,'respond');
 assert.equal(W.state({...verified,followUp:undefined,status:'Emailed',follow_up:'2026-10-12'},day,'leads').lane,'followup');
 const response={status:'Contacted',command:{workflowLog:[{type:'Reply',date:day}]}};
 assert.equal(W.state(response,day,'website_inquiries').lane,'respond');
});
function render(view='work',search=''){
 const rows=[];for(const [lane,raw] of [
 ['ready',verified],['respond',W.act(verified,'reply',day)],
 ['followup',{...verified,status:'Emailed',followUp:'2020-01-01'}],
 ['booked',{...verified,status:'Booked!'}],['waiting',{...verified,status:'Emailed',followUp:'2099-01-01'}]
 ])for(let i=0;i<100;i++)rows.push(C.normalize({...raw,id:lane+i,school:lane+' '+i}));
 const values=[view,search,0,null,''];let index=0;
 const React={createElement:(type,props,...children)=>({type,props,children}),useState:()=>[values[index++],()=>{}],useMemo:f=>f(),useEffect:()=>{}};
 const ctx={React,CRMCommand:C,CRMWorkflow:W};ctx.window=ctx;
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(require.resolve('../js/workflow-board.js'),'utf8'),ctx);
 return ctx.CRMWorkflowBoard({records:rows,onSave:()=>{},onOpen:()=>{},onQueue:()=>{}});
}
function collect(node,type,out=[]){if(Array.isArray(node))node.forEach(n=>collect(n,type,out));else if(node&&typeof node==='object'){if(node.type===type)out.push(node);collect(node.children,type,out);}return out;}
test('working board renders bounded cards, paginates lane lists, and searches',()=>{
 assert.equal(collect(render(),'article').length,16);
 assert.equal(collect(render('respond'),'article').length,10);
 assert.equal(collect(render('respond','respond 99'),'article').length,1);
 assert.equal(collect(render('work','no matches'),'article').length,0);
 assert(collect(render('pipeline'),'article').length<=28);
});
