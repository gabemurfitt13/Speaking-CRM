(function(root){'use strict';
const h=root.React&&root.React.createElement;
const states=['ready','scheduled','sending','sent','held','failed'];
function classify(action){
 const output=action.execution_output||{};
 if(output.gmailMessageId||output.resendId||output.state==='sent'||action.executed_at||action.status==='executed')return 'sent';
 if(output.state==='sending')return 'sending';
 if(output.sendBlocked||output.state==='failed'||action.ai_status==='failed')return 'held';
 if(action.payload?.scheduled_at)return 'scheduled';
 if(action.ai_status==='ready'&&action.status==='approved')return 'ready';
 return 'held';
}
function summarize(actions){
 const counts=Object.fromEntries(states.map(s=>[s,0]));
 actions.forEach(a=>counts[classify(a)]++);
 return counts;
}
function Queue({client,uid}){
 const [rows,setRows]=React.useState([]),[busy,setBusy]=React.useState(false),[error,setError]=React.useState(''),[filter,setFilter]=React.useState('all'),[school,setSchool]=React.useState(''),[kind,setKind]=React.useState('initial'),[saving,setSaving]=React.useState(false);
 async function refresh(){
  if(!client||!uid)return;setBusy(true);setError('');
  try{const q=await client.from('outreach_queue').select('*').eq('user_id',uid).order('updated_at',{ascending:false}).limit(300);if(q.error)throw q.error;setRows(q.data||[]);}
  catch(e){setError(e.message||'Queue could not load');}finally{setBusy(false);}
 }
 React.useEffect(()=>{refresh();},[client,uid]);
 async function toggle(item,checked){
  setSaving(true);setError('');
  try{
   const next=checked?'held':'held';
   const patch={status:next,hold_reason:checked?'Awaiting independent verification and reviewed message':'Manually removed from ready queue',updated_at:new Date().toISOString()};
   const q=await client.from('outreach_queue').update(patch).eq('user_id',uid).eq('id',item.id).select('id').single();if(q.error)throw q.error;await refresh();
  }catch(e){setError(e.message);}finally{setSaving(false);}
 }
 async function add(e){
  e.preventDefault();setSaving(true);setError('');
  try{
   const q=await client.from('progress').select('school_id,email,status,contacted,contact_confidence,last_verified,log').eq('user_id',uid).eq('school_id',school.trim()).maybeSingle();
   if(q.error)throw q.error;if(!q.data)throw Error('School not found. Enter the exact CRM school ID.');
   const p=q.data,log=Array.isArray(p.log)?p.log:[],prior=!!p.contacted||log.some(x=>/email sent|follow-up sent/i.test(x.type||''));
   if(kind==='initial'&&prior)throw Error('Already contacted. Use follow-up instead.');
   if(kind==='follow_up'&&!prior)throw Error('No prior contact recorded. Follow-up requires an existing conversation.');
   if(!p.email||!p.last_verified)throw Error('A verified email and verification date are required.');
   const payload={user_id:uid,school_id:p.school_id,kind,status:'held',verified_email:p.email,hold_reason:'Awaiting reviewed message and final eligibility checks',updated_at:new Date().toISOString()};
   const saved=await client.from('outreach_queue').upsert(payload,{onConflict:'user_id,school_id,kind'}).select('id').single();
   if(saved.error)throw saved.error;setSchool('');await refresh();
  }catch(e){setError(e.message||'Could not queue school');}finally{setSaving(false);}
 }
 const counts=Object.fromEntries(states.map(x=>[x,rows.filter(r=>r.status===x).length])),visible=rows.filter(r=>filter==='all'||r.status===filter);
 return h('section',{className:'cc-section',style:{marginTop:20}},h('div',{className:'cc-heading'},h('h3',null,'Outreach Queue'),h('button',{className:'btn',onClick:refresh,disabled:busy},busy?'Loading…':'Refresh queue')),
 h('p',{className:'cc-note'},'Initial outreach and follow-ups have separate approvals. Adding a contact does not send it. Items remain on hold until verified and a message is reviewed.'),
 h('form',{onSubmit:add,style:{display:'flex',gap:8,flexWrap:'wrap',marginBottom:12}},h('input',{required:true,placeholder:'Exact school ID',value:school,onChange:e=>setSchool(e.target.value)}),h('select',{value:kind,onChange:e=>setKind(e.target.value)},h('option',{value:'initial'},'Initial outreach'),h('option',{value:'follow_up'},'Follow-up')),h('button',{className:'btn primary',type:'submit',disabled:saving},saving?'Saving…':'Add to queue')),
 error&&h('p',{role:'alert'},error),
 h('div',{className:'cc-filters'},h('label',null,'Status ',h('select',{value:filter,onChange:e=>setFilter(e.target.value)},['all',...states].map(x=>h('option',{key:x,value:x},x==='all'?'All':x+' ('+counts[x]+')'))))),
 h('div',{className:'stat-grid'},states.map(x=>h('div',{className:'stat-card',key:x},h('div',{className:'s-label'},x),h('div',{className:'s-num'},counts[x])))),
 h('div',{style:{maxHeight:440,overflow:'auto'}},h('table',{className:'cc-table'},h('thead',null,h('tr',null,['School','Type','Status','Hold reason','Remove'].map(x=>h('th',{key:x},x)))),h('tbody',null,visible.map(r=>h('tr',{key:r.id},h('td',null,r.school_id),h('td',null,r.kind==='follow_up'?'Follow-up':'Initial'),h('td',null,r.status),h('td',null,r.hold_reason||'—'),h('td',null,h('button',{className:'btn sm',disabled:saving||r.status==='sent'||r.status==='sending',onClick:()=>toggle(r,false)},'Hold'))))))),
 h('p',{className:'cc-note'},'Showing the 300 most recently updated queue items. The sender is not connected yet.'));
}

root.SpeakingOutreachQueue={states,classify,summarize,Queue};
})(window);
