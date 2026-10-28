(function(root){
  'use strict';
  const statuses=['New','Contacted','Follow-up','Quote Sent','Booked','Completed','Closed'];
  const removed=r=>['spam','trash'].includes(r.command?.crmModeration?.state);
  async function list(client,uid,includeRemoved=false){
    let rows=[];
    for(let from=0;;from+=500){
      const r=await client.from('website_inquiries').select('*').eq('user_id',uid).order('created_at',{ascending:false}).order('id').range(from,from+499);
      if(r.error)throw r.error;
      rows.push(...r.data);if(r.data.length<500)return includeRemoved?rows:rows.filter(r=>!removed(r));
    }
  }
  async function save(client,uid,id,draft){
    if(!statuses.includes(draft.status))throw Error('Invalid inquiry status');
    const changes={status:draft.status,follow_up:draft.follow_up||null,booking_date:draft.booking_date||null,notes:draft.notes||''};
    const r=await client.from('website_inquiries').update(changes).eq('user_id',uid).eq('id',id).select('*').single();
    if(r.error)throw r.error;if(!r.data)throw Error('Inquiry was not saved');return r.data;
  }
  async function moderate(client,id,action){const r=await client.rpc('moderate_crm_inquiry',{inquiry_id:id,action});if(r.error)throw r.error;if(!r.data)throw Error('Inquiry was not saved');return r.data;}
  const api={list,save,statuses,moderate,removed};
  if(typeof module!=='undefined')module.exports=api;
  root.CRMInquiries=api;
  if(!root.React)return;
  const h=React.createElement;
  function Detail({row,client,uid,onSave,onClose}){
    const [draft,setDraft]=React.useState({...row}),[busy,setBusy]=React.useState(false),[message,setMessage]=React.useState('');
    const change=(key,value)=>{setDraft(v=>({...v,[key]:value}));setMessage('Unsaved changes');};
    const dirty=JSON.stringify([draft.status,draft.organization_type,draft.follow_up,draft.booking_date,draft.notes])!==JSON.stringify([row.status,row.organization_type,row.follow_up,row.booking_date,row.notes]);
    React.useEffect(()=>{window.crmInquiryDirty=dirty;const fn=e=>{if(dirty){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',fn);return()=>{window.crmInquiryDirty=false;window.removeEventListener('beforeunload',fn);};},[dirty]);
    function close(){if(!dirty||window.confirm('Discard unsaved inquiry changes?'))onClose();}
    async function submit(e){e.preventDefault();setBusy(true);setMessage('Saving…');try{const saved=await save(client,uid,row.id,draft);onSave(saved);setDraft(saved);setMessage('Saved to cloud');}catch(err){setMessage('Save failed. Your edits are still here. '+err.message);}finally{setBusy(false);}}
    async function manage(action){if(dirty&&!window.confirm('Discard unsaved changes?'))return;setBusy(true);try{const saved=await moderate(client,row.id,action);onSave(saved);onClose();}catch(e){setMessage('Could not update inquiry: '+e.message);}finally{setBusy(false);}}
    const field=(label,key,type)=>h('label',{className:'inq-field'},label,h('input',{type:type||'text',value:draft[key]||'',onChange:e=>change(key,e.target.value)}));
    const select=(label,key,values)=>h('label',{className:'inq-field'},label,h('select',{value:draft[key],onChange:e=>change(key,e.target.value)},values.map(v=>h('option',{key:v},v))));
    const pair=(label,value)=>h('div',{className:'inq-detail',key:label},h('strong',null,label),h('div',null,value||'Not provided'));
    const tracking=row.tracking||{};
    return h('section',{className:'inq-card'},h('div',{className:'inq-row'},h('h2',null,row.organization||row.name),h('button',{className:'btn',onClick:close,disabled:busy},'Back to inbox')),
      h('div',{className:'inq-grid'},pair('Contact',row.name),pair('Email',row.email),pair('Phone',row.phone),pair('Received',new Date(row.created_at).toLocaleString()),pair('Event type',row.event_type),pair('Preferred date',row.preferred_date),pair('Location',row.location),pair('Audience size',row.audience_size)),
      pair('Event goals / details',row.details),pair('Email notification',row.mail_status==='mail_sent'?'WordPress reported email sent':'WordPress reported email failed'),
      h('details',null,h('summary',null,'Traffic source and landing page'),Object.entries(tracking).filter(([k,v])=>v).map(([k,v])=>pair(k.replace(/_/g,' '),v))),
      h('div',{className:'inq-row'},removed(row)?h('button',{className:'btn',disabled:busy,onClick:()=>manage('restore')},'Restore inquiry'):h(React.Fragment,null,h('button',{className:'btn',disabled:busy,onClick:()=>manage('spam')},'Report spam'),h('button',{className:'btn',disabled:busy,onClick:()=>manage('trash')},'Delete inquiry'))),
      h('p',null,removed(row)?'This inquiry is hidden from active work. Restore it to return it to the inbox.':'Deleted inquiries go to Trash. Report spam moves this inquiry to Spam in this CRM.'),
      !removed(row)&&h('form',{onSubmit:submit},h('div',{className:'inq-grid'},select('Status','status',statuses),pair('Audience',row.organization_type),field('Follow-up date','follow_up','date'),field('Booking date','booking_date','date')),
        h('label',{className:'inq-field'},'Notes',h('textarea',{rows:5,value:draft.notes||'',onChange:e=>change('notes',e.target.value)})),
        h('button',{className:'btn primary',type:'submit',disabled:busy},busy?'Saving…':'Save inquiry'),h('p',{role:'status'},message)),removed(row)&&h('p',{role:'status'},message));
  }
  root.WebsiteInquiries=function({client,uid}){
    const [rows,setRows]=React.useState([]),[loading,setLoading]=React.useState(true),[error,setError]=React.useState(''),[selected,setSelected]=React.useState(null),[filter,setFilter]=React.useState('All'),[query,setQuery]=React.useState('');
    const request=React.useRef(0);
    async function refresh(){if(!uid){setLoading(false);setError('Sign in to load your inquiries.');return;}const ticket=++request.current;setLoading(true);try{const data=await list(client,uid,true);if(ticket===request.current){setRows(data);setError('');}}catch(e){if(ticket===request.current)setError('Could not load website inquiries. '+e.message);}finally{if(ticket===request.current)setLoading(false);}}
    React.useEffect(()=>{refresh();const timer=setInterval(refresh,60000);return()=>{request.current++;clearInterval(timer);};},[uid]);
    const today=new Date().toLocaleDateString('en-CA');
    const visible=rows.filter(r=>(filter==='Spam'?r.command?.crmModeration?.state==='spam':filter==='Trash'?r.command?.crmModeration?.state==='trash':!removed(r)&&(filter==='All'||r.status===filter))&&(r.organization+' '+r.name+' '+r.email+' '+r.location).toLowerCase().includes(query.toLowerCase()));
    if(selected)return h('div',{className:'content'},h(Detail,{key:selected.id,row:selected,client,uid,onClose:()=>setSelected(null),onSave:s=>{setRows(v=>v.map(r=>r.id===s.id?s:r));setSelected(s);}}));
    return h(React.Fragment,null,h('div',{className:'topbar'},h('span',{className:'topbar-title'},'Website Inquiries'),h('button',{className:'btn',onClick:refresh,disabled:loading},loading?'Loading…':'Refresh')),
      h('div',{className:'content'},h('p',null,'Booking requests from gabemurfitt.com. Schools and organizations appear here separately from your outreach directory.'),
        h('p',{role:'status'},rows.filter(r=>!removed(r)).length+' inquiries · '+rows.filter(r=>r.status==='New').length+' new · '+rows.filter(r=>r.follow_up&&r.follow_up<=today&&!['Completed','Closed'].includes(r.status)).length+' follow-ups due'),
        error&&h('p',{role:'alert',className:'inq-error'},error),
        h('div',{className:'inq-row'},h('label',null,'Search inquiries ',h('input',{value:query,onChange:e=>setQuery(e.target.value),placeholder:'Organization, name, email, location'})),h('label',null,'Status ',h('select',{value:filter,onChange:e=>setFilter(e.target.value)},['All',...statuses,'Spam','Trash'].map(v=>h('option',{key:v},v))))),
        !loading&&!error&&!visible.length&&h('p',null,rows.length?'No inquiries match these filters.':'No website inquiries have arrived yet.'),
        visible.map(r=>h('button',{className:'inq-card inq-entry',key:r.id,onClick:()=>setSelected(r)},h('div',{className:'inq-row'},h('strong',null,r.organization||r.name),h('span',null,r.status)),h('div',null,r.name+' · '+r.email),h('div',null,(r.event_type||'Speaking inquiry')+' · '+r.location),h('small',null,new Date(r.created_at).toLocaleString()+(r.follow_up?' · Follow-up '+r.follow_up:''))))));
  };
})(typeof window==='undefined'?globalThis:window);
