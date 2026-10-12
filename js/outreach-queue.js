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
 const [rows,setRows]=React.useState([]),[busy,setBusy]=React.useState(false),[error,setError]=React.useState(''),[filter,setFilter]=React.useState('all');
 async function refresh(){
  if(!client||!uid)return;setBusy(true);setError('');
  try{
   let out=[];for(let from=0;from<500;from+=500){
    const q=await client.from('ai_actions').select('id,record_id,record_kind,action_type,status,ai_status,execution_output,payload,executed_at,updated_at').eq('user_id',uid).order('updated_at',{ascending:false}).range(from,from+499);
    if(q.error)throw q.error;out.push(...(q.data||[]));if((q.data||[]).length<500)break;
   }
   setRows(out.filter(a=>a.record_kind==='progress'&&['research_contact','initial_outreach'].includes(a.action_type)));
  }catch(e){setError(e.message||'Queue could not load');}finally{setBusy(false);}
 }
 React.useEffect(()=>{refresh();},[client,uid]);
 const counts=summarize(rows),visible=rows.filter(a=>filter==='all'||classify(a)===filter);
 return h('section',{className:'cc-section',style:{marginTop:20}},h('div',{className:'cc-heading'},h('h3',null,'Outreach Queue'),h('button',{className:'btn',onClick:refresh,disabled:busy},busy?'Loading…':'Refresh queue')),
 h('p',{className:'cc-note'},'Recent 500 actions only, to keep the dashboard responsive. Read-only audit of school outreach actions. Ready means AI-approved, not independently verified for sending. Sent requires recorded provider evidence. This panel never sends emails.'),
 error&&h('p',{role:'alert'},error),
 h('div',{className:'cc-filters'},h('label',null,'Status ',h('select',{value:filter,onChange:e=>setFilter(e.target.value)},['all',...states].map(s=>h('option',{key:s,value:s},s==='all'?'All':s+' ('+counts[s]+')'))))),
 h('div',{className:'stat-grid'},states.map(s=>h('div',{className:'stat-card',key:s},h('div',{className:'s-label'},s),h('div',{className:'s-num'},counts[s])))),
 h('div',{style:{maxHeight:440,overflow:'auto'}},h('table',{className:'cc-table'},h('thead',null,h('tr',null,['Record','Action','Queue state','Updated'].map(x=>h('th',{key:x},x)))),h('tbody',null,visible.slice(0,250).map(a=>h('tr',{key:a.id},h('td',null,a.record_id),h('td',null,a.action_type),h('td',null,classify(a)),h('td',null,a.updated_at?new Date(a.updated_at).toLocaleString():'—')))))),
 visible.length>250&&h('p',{className:'cc-note'},'Showing first 250 of '+visible.length+' matching actions.'));
}
root.SpeakingOutreachQueue={states,classify,summarize,Queue};
})(window);
