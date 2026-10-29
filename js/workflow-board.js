(function(root){
'use strict';if(!root.React||!root.CRMWorkflow)return;
const React=root.React,h=React.createElement,W=root.CRMWorkflow,C=root.CRMCommand;
const styles=`
.wf{margin:18px 0 24px}.wf-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:14px 0}.wf-toolbar input{flex:1;min-width:180px;padding:9px;border:1px solid var(--border);border-radius:7px}.wf-tabs{display:flex;gap:6px;flex-wrap:wrap}.wf-tabs button[aria-pressed=true]{background:var(--accent);color:white}.wf-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.wf-column{background:var(--bg,#eff7f2);border:1px solid var(--border);border-radius:10px;padding:12px;min-width:0}.wf-column h4{display:flex;justify-content:space-between;gap:8px;margin-bottom:12px;font-size:13px}.wf-count{color:var(--accent);font-weight:700}.wf-card{background:var(--bg-card,#fff);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:9px}.wf-card h5{font-size:13px;line-height:1.4;margin:0 0 7px}.wf-card .cc-link{font-weight:700;font-size:13px;line-height:1.4}.wf-card p{font-size:12px;line-height:1.45;margin:5px 0;color:var(--text-muted)}.wf-card .wf-next{color:var(--text);font-weight:600}.wf-card .wf-due{color:#a14217;font-weight:600}.wf-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}.wf-full{width:100%;margin-top:4px}.wf-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.wf-panel{border:2px solid var(--accent);border-radius:10px;padding:18px;background:var(--bg-card,#fff);margin:12px 0}.wf-panel label{display:flex;flex-direction:column;gap:6px;font-size:12px;font-weight:600}.wf-panel input,.wf-panel select{width:100%;padding:9px;border:1px solid var(--border);border-radius:6px;color:var(--text);background:var(--bg-card,#fff)}.wf-panel .wf-form{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0}.wf-status{padding:9px 12px;border-radius:7px;background:var(--accent-bg);font-size:12px}.wf-pager{display:flex;justify-content:center;align-items:center;gap:12px;margin:12px 0}.wf-empty{font-size:12px;color:var(--text-muted);padding:10px 0}@media(max-width:1050px){.wf-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:650px){.wf-grid,.wf-list,.wf-panel .wf-form{grid-template-columns:1fr}.wf-toolbar input{width:100%}.wf-card{padding:11px}}
`;
const actionChoices=[['reply','Reply received'],['pricing_requested','Pricing requested'],['pricing_sent','Pricing sent'],['proposal_sent','Proposal sent'],['response_sent','Response / follow-up sent'],['booked','Booked'],['closed','Not interested'],['contract_signed','Contract signed'],['deposit_received','Deposit received'],['schedule','Set next follow-up']];
function UpdatePanel({r,onSave,onClose}){
 const [action,setAction]=React.useState('schedule'),[due,setDue]=React.useState(r.followUp||''),[busy,setBusy]=React.useState(false),[error,setError]=React.useState('');
 const [note,setNote]=React.useState(''),[dueChanged,setDueChanged]=React.useState(false);
 async function submit(e){e.preventDefault();if(busy)return;setBusy(true);setError('');try{
  if(action==='schedule'&&!C.validDate(due))throw Error('Choose a valid follow-up date.');
  await onSave(r,{action,due:(dueChanged||action==='schedule')?due:'',note});onClose();
 }catch(e){setError(e.message||'Update failed.');}finally{setBusy(false);}}
 return h('form',{className:'wf-panel',onSubmit:submit},h('div',{className:'cc-heading'},h('h3',null,'Update '+r.name),h('button',{className:'btn',type:'button',disabled:busy,onClick:onClose},'Close')),
 h('p',{className:'cc-note'},'Record what happened. The card and next action update after saving.'),
 h('div',{className:'wf-form'},h('label',null,'What happened?',h('select',{value:action,onChange:e=>setAction(e.target.value)},actionChoices.map(([value,label])=>h('option',{key:value,value},label)))),h('label',null,'Next follow-up date',h('input',{type:'date',value:due,onChange:e=>{setDue(e.target.value);setDueChanged(true);}}))),
 h('label',null,'Optional note',h('input',{value:note,onChange:e=>setNote(e.target.value),placeholder:'What should you remember?'})),
 /sent$/.test(action)&&h('p',{className:'cc-note'},'Only record this after the message was actually sent. This update does not send an email.'),
 error&&h('p',{role:'alert'},error),h('button',{className:'btn primary',disabled:busy,type:'submit',style:{marginTop:12}},busy?'Saving…':'Save and move card'));
}
function Board({records,onOpen,onSave,onQueue,activity=[]}){
 const [view,setView]=React.useState('work'),[search,setSearch]=React.useState(''),[page,setPage]=React.useState(0),[editing,setEditing]=React.useState(null),[notice,setNotice]=React.useState('');
 const day=C.day(new Date());
 const items=React.useMemo(()=>records.filter(r=>!r.test&&!r.command.linkedRecord).map(r=>({r,w:W.state(r.raw,day,r.kind)})),[records,day]);
 const filtered=items.filter(({r})=>[r.name,r.raw.contact,r.raw.email].join(' ').toLowerCase().includes(search.toLowerCase()));
 React.useEffect(()=>{setPage(0);},[search,view]);
 const stageLanes=[...C.stages,'Closed'].map(stage=>['stage:'+stage,stage]);
 const groups=Object.fromEntries([...W.lanes.map(([id])=>[id,filtered.filter(x=>x.w.lane===id)]),...stageLanes.map(([id,stage])=>[id,filtered.filter(x=>x.w.stage===stage)])]);
 Object.entries(groups).forEach(([id,rs])=>{rs.sort((a,b)=>(a.w.due||'9999').localeCompare(b.w.due||'9999')||a.r.name.localeCompare(b.r.name));if(id==='stage:Conversation'){const sent=x=>x.r.raw&&x.r.raw.infoSent===true;groups[id]=rs.filter(sent).concat(rs.filter(x=>!sent(x)));}});
 async function save(r,change){const updated=await onSave(r,change);const w=W.state(updated,day,r.kind);setNotice(r.name+' moved to '+(W.lanes.find(([id])=>id===w.lane)?.[1]||w.lane)+'. Next: '+w.label);}
 function card({r,w}){const infoSent=w.stage==='Conversation'&&r.raw.infoSent===true;return h('article',{className:'wf-card',key:r.key},h('h5',null,h('button',{className:'cc-link',onClick:()=>onOpen(r)},r.name),infoSent&&h('span',{className:'sales-chip info-sent',style:{marginLeft:8}},'Info sent')),
  h('p',null,w.stage+' · '+r.market),h('p',null,(r.raw.contact||r.raw.email||'Main contact missing')+(w.verified?' · Verified':'')),
  h('p',{className:'wf-next'},w.label),w.due&&h('p',{className:w.due<=day?'wf-due':''},(w.due<day?'Overdue · ':'Due · ')+w.due),
  w.tasks.length>1&&h('p',null,w.tasks.length+' booking tasks remaining'),
  h('div',{className:'wf-actions'},h('button',{className:'btn sm primary',onClick:()=>w.lane==='ready'?onQueue(r):(w.lane==='research'||['event_date','event_details'].includes(w.task))?onOpen(r):setEditing(r)},w.lane==='ready'?'Review outreach':w.lane==='research'?'Verify contact':['event_date','event_details'].includes(w.task)?'Complete details':'Update'),
   h('button',{className:'btn sm',onClick:()=>onOpen(r)},'Open record')));}
 const shownLanes=view==='work'?W.lanes.slice(0,4):view==='pipeline'?stageLanes:null;
 const all=groups[view]||[],current=Math.min(page,Math.max(0,Math.ceil(all.length/10)-1));
 return h('section',{className:'wf','aria-label':'Working pipeline'},h('style',null,styles),
 h('div',{className:'cc-heading'},h('div',null,h('h3',null,'Your working pipeline'),h('p',{className:'cc-note'},'Update a record to move the work forward. Email follow-ups default to five business days; you can change the date.'))),
 h('div',{className:'wf-toolbar'},h('div',{className:'wf-tabs'},
  [['work','Today’s work'],['pipeline','All stages']].map(([id,label])=>h('button',{key:id,className:'btn','aria-pressed':view===id,onClick:()=>setView(id)},label)),
  !shownLanes&&h('button',{className:'btn',onClick:()=>setView('work')},'Back to today')),
  h('input',{'aria-label':'Search working pipeline',placeholder:'Find a prospect or contact',value:search,onChange:e=>setSearch(e.target.value)})),
 notice&&h('p',{className:'wf-status',role:'status'},notice),
 editing&&h(UpdatePanel,{key:editing.key,r:editing,onSave:save,onClose:()=>setEditing(null)}),
 shownLanes?h('div',{className:'wf-grid'},shownLanes.map(([id,label])=>h('div',{className:'wf-column',key:id},
  h('h4',null,label,h('span',{className:'wf-count'},groups[id].length)),
  groups[id].slice(0,4).map(card),!groups[id].length&&h('p',{className:'wf-empty'},'All clear'),
  groups[id].length>4&&h('button',{className:'btn sm wf-full',onClick:()=>setView(id)},'View all '+groups[id].length))))
 :h('div',null,h('h4',null,([...W.lanes,...stageLanes].find(([id])=>id===view)?.[1]||view)+' · '+all.length),
  h('div',{className:'wf-list'},all.slice(current*10,(current+1)*10).map(card)),
  !all.length&&h('p',{className:'wf-empty'},'No prospects match this view.'),
  h('div',{className:'wf-pager'},h('button',{className:'btn',disabled:current===0,onClick:()=>setPage(current-1)},'Previous'),h('span',null,all.length?(current*10+1)+'–'+Math.min((current+1)*10,all.length)+' of '+all.length:'0 items'),h('button',{className:'btn',disabled:(current+1)*10>=all.length,onClick:()=>setPage(current+1)},'Next'))));
}
root.CRMWorkflowBoard=Board;
})(window);
