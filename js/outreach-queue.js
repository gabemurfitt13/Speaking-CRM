(function (root) {
  'use strict';
  if (!root.React) return;
  const React = root.React, h = React.createElement;
  const states = ['ready', 'scheduled', 'sending', 'sent', 'held', 'failed'];
  const blocked = /not interested|do not contact|booked|opt.?out|unsubscribe/i;
  const hasPrior = p => Boolean(p.contacted) || [p.log,p.record?.log].some(log => Array.isArray(log) && log.some(e => /sent|emailed/i.test(String(e.type || e.action || ''))));
  const eligible = (p, item) => {
    if (!p || !p.email || !p.last_verified || !p.contact_source || !['high','verified'].includes(String(p.contact_confidence||'').toLowerCase())) return 'High-confidence contact, source and verification date are required.';
    if (p.email.trim().toLowerCase() !== String(item.verified_email || '').trim().toLowerCase()) return 'The verified email has changed. Recheck the recipient.';
    if (blocked.test(String(p.status || '') + ' ' + String(p.notes || ''))) return 'CRM record indicates a hold or opt-out.';
    if (item.kind === 'initial' && hasPrior(p)) return 'Previous outreach is recorded. Do not send another initial email.';
    if (item.kind === 'follow_up' && (!hasPrior(p)||p.status!=='Emailed')) return 'Only unanswered Emailed schools qualify. In Discussion is excluded.';
    if (item.kind === 'follow_up' && (!item.original_message_id||!item.original_thread_id||item.thread_check_result!=='unanswered')) return 'Verify the original Gmail conversation before marking this follow-up ready.';
    if (!item.approved_subject || !item.approved_body) return 'Review and save the email draft first.';
    return null;
  };
  function Queue({client, uid, onlyKind}) {
    const [rows, setRows] = React.useState([]), [school, setSchool] = React.useState(''), [kind, setKind] = React.useState('initial'), [schools,setSchools]=React.useState([]);
    const [filter, setFilter] = React.useState('active'), [draft, setDraft] = React.useState(null);
    const [schoolSearch,setSchoolSearch]=React.useState('');
    const draftEditorRef=React.useRef(null);React.useEffect(()=>{if(draft&&draftEditorRef.current){draftEditorRef.current.scrollIntoView({behavior:'smooth',block:'center'});draftEditorRef.current.querySelector('input')?.focus({preventScroll:true});}},[draft?.id]);
    const [page,setPage]=React.useState(0), [queueSearch,setQueueSearch]=React.useState('');
    React.useEffect(()=>{setPage(0);},[filter,queueSearch]);
    const [busy, setBusy] = React.useState(false), [error, setError] = React.useState('');
    const [approvalFeedback,setApprovalFeedback]=React.useState({});
    async function refresh() {
      if (!client || !uid) return;
      setBusy(true); setError('');
      try {
        const q = await client.from('outreach_queue').select('*').eq('user_id', uid).order('updated_at', {ascending:false}).limit(300);
        if (q.error) throw q.error;
        setRows(q.data || []);root.dispatchEvent(new CustomEvent('crm-queue-synced',{detail:q.data||[]}));
      } catch (e) { setError(e.message || 'Unable to load queue'); }
      finally { setBusy(false); }
    }
    React.useEffect(() => { refresh(); }, [client, uid]);
    const rowsRef=React.useRef(rows);rowsRef.current=rows;
    React.useEffect(()=>{const select=e=>{const id=String(e.detail?.school_id||'');const existing=rowsRef.current.find(x=>String(x.school_id)===id&&x.kind==='initial'&&!['sent','sending'].includes(x.status));if(existing){setDraft({id:existing.id,subject:existing.approved_subject||'',body:existing.approved_body||''});return;}setSchool(id);setKind('initial');setSchoolSearch('');setAddOpen(true);};root.addEventListener('crm-queue-select',select);return()=>root.removeEventListener('crm-queue-select',select);},[]);
    const [addOpen,setAddOpen]=React.useState(false);
    React.useEffect(()=>{if(!client||!uid)return;let active=true;client.from('progress').select('school_id,email,status,contact,contact_confidence,last_verified,contact_source,contacted,notes,log,record').eq('user_id',uid).not('email','is',null).limit(1000).then(({data,error})=>{if(!active)return;if(error){setError(error.message);return;}setSchools((data||[]).filter(p=>!blocked.test(String(p.status||'')+' '+String(p.notes||''))&&['high','verified'].includes(String(p.contact_confidence||'').toLowerCase())&&p.last_verified&&p.contact_source));});return()=>{active=false};},[client,uid]);
    React.useEffect(()=>{const id=root.crmQueueRequestedSchool;if(!id||onlyKind&&onlyKind!=='initial')return;const item=rows.find(x=>String(x.school_id)===String(id)&&x.kind==='initial');if(item){setDraft({id:item.id,subject:item.approved_subject||'',body:item.approved_body||'',approveAfterSave:true});root.crmQueueRequestedSchool=null;}},[rows,onlyKind]);
    async function lookup(id) {
      const q = await client.from('progress').select('school_id,email,status,notes,contacted,last_verified,contact_source,contact_confidence,log,record').eq('user_id',uid).eq('school_id',id).maybeSingle();
      if (q.error) throw q.error;
      if (!q.data) throw Error('School not found in your CRM. Enter the exact school ID.');
      return q.data;
    }
    async function add(e) {
      e.preventDefault(); setBusy(true); setError('');
      try {
        const p = await lookup(school.trim());
        const proposed = {kind, verified_email:p.email};
        if (!p.email || !p.last_verified || !p.contact_source || !['high','verified'].includes(String(p.contact_confidence||'').toLowerCase())) throw Error('Verify the email, source and date before queueing.');
        if (blocked.test(String(p.status || '')+' '+String(p.notes || ''))) throw Error('CRM record is on hold or opted out.');
        if (kind === 'initial' && hasPrior(p)) throw Error('This school has already been contacted. Use follow-up.');
        if (kind === 'follow_up' && !hasPrior(p)) throw Error('No previous outreach is recorded.');
        const existing = rows.find(x => x.school_id === p.school_id && x.kind === kind);
        if (existing && ['sent','sending'].includes(existing.status)) throw Error('This queue item has already been sent or claimed.');
        const schoolName=String(p.record?.school||'').trim();
        if(!schoolName)throw Error('School name is missing. Update the CRM record first.');
        const firstName=String(p.contact||'').trim().split(' ')[0]||'there';
        const subject=kind==='follow_up'?'Re: quick question':'quick question';
        const body=(kind==='initial'?['Hi '+firstName+',','','Who is the best person to contact about booking a guest speaker for assemblies at '+schoolName+'?','','Thanks,','Gabe Murfitt','gabemurfitt.com']:['Hi '+firstName+',','','I wanted to follow up on my earlier email about bringing a guest speaker to '+schoolName+'.','', 'Would you be the right person to speak with about assemblies, or is there someone else I should contact?','','Thanks,','Gabe Murfitt','gabemurfitt.com']).join('\n');
        const q = await client.from('outreach_queue').upsert({user_id:uid,school_id:p.school_id,kind,status:'held',verified_email:p.email,approved_subject:subject,approved_body:body,hold_reason:'Review message and verify eligibility before marking ready',updated_at:new Date().toISOString()}, {onConflict:'user_id,school_id,kind'}).select('id').single();
        if (q.error) throw q.error;
        setSchool(''); await refresh();
      } catch (e) { setError(e.message); } finally { setBusy(false); }
    }
    async function saveDraft() {
      if (!draft || !draft.subject.trim() || !draft.body.trim()) { setError('Subject and message are required.'); return; }
      setBusy(true); setError('');
      try {
        const q = await client.from('outreach_queue').update({approved_subject:draft.subject.trim(),approved_body:draft.body.trim(),status:'held',hold_reason:'Draft saved. Check Ready to Send after review.',updated_at:new Date().toISOString()}).eq('id',draft.id).eq('user_id',uid).in('status',['held','ready','failed']).select('*').maybeSingle();
        if (q.error) throw q.error;
        if (!q.data) throw Error('Item changed. Refresh before editing.');
        if(draft.approveAfterSave){const approval=await client.rpc('review_outreach_queue',{queue_id:q.data.id,expected_status:q.data.status,reviewed_subject:q.data.approved_subject,reviewed_body:q.data.approved_body,reviewed_recipient:q.data.verified_email,mark_ready:true});if(approval.error)throw approval.error;if(!approval.data)throw Error('Approval was not saved.');}
        setDraft(null); await refresh();
      } catch (e) { setError(e.message); } finally { setBusy(false); }
    }
    async function toggle(item, checked) {
      setBusy(true); setError('');
      setApprovalFeedback(v=>({...v,[item.id]:{pending:true,message:'Saving approval…'}}));
      try {
        if (['sending','sent'].includes(item.status)) throw Error('This item cannot be changed while sending or after being sent.');
        if (checked) {
          const p = await lookup(item.school_id);
          const reason = eligible(p,item);
          if (reason) throw Error(reason);
        }
        const q = await client.rpc('review_outreach_queue',{queue_id:item.id,expected_status:item.status,reviewed_subject:item.approved_subject,reviewed_body:item.approved_body,reviewed_recipient:item.verified_email,mark_ready:checked});
        if (q.error) throw q.error;
        const updated=Array.isArray(q.data)?q.data[0]:q.data;
        if (!updated) throw Error('Queue item changed. Refresh and retry.');
        setRows(current=>current.map(row=>row.id===item.id?updated:row));
        setApprovalFeedback(v=>({...v,[item.id]:{message:checked?(updated.status==='scheduled'?'Approved for scheduled date':'Approval saved. Ready for sending schedule.'):'Paused'}}));
        root.dispatchEvent(new CustomEvent('crm-queue-synced',{detail:[updated]}));
      } catch (e) { const message=e.message||String(e);setError(message);setApprovalFeedback(v=>({...v,[item.id]:{failed:true,message}})); } finally { setBusy(false); }
    }
    const counts = Object.fromEntries(states.map(s=>[s,rows.filter(x=>(!onlyKind||x.kind===onlyKind)&&x.status===s).length]));
    const visible = rows.filter(x=>onlyKind!=='follow_up'||! /^(biz-|church-|conf-|college-)/i.test(x.school_id)).filter(x=>(!onlyKind||x.kind===onlyKind)&&(filter==='all'||(filter==='active'?!['sent'].includes(x.status):x.status===filter)));
    if(onlyKind==='follow_up')visible.sort((a,b)=>{const date=x=>x.follow_up_due||x.original_sent_at?.slice(0,10)||'9999-12-31';return date(a).localeCompare(date(b))||String(a.created_at||'').localeCompare(String(b.created_at||''))||String(a.id).localeCompare(String(b.id));});
    const byId = new Map(schools.map(p=>[String(p.school_id),p]));
    const searched=visible.filter(item=>[(byId.get(String(item.school_id))?.record?.school||''),item.school_id,item.verified_email,item.approved_subject].join(' ').toLowerCase().includes(queueSearch.toLowerCase()));
    const pageSize=10,totalPages=Math.max(1,Math.ceil(searched.length/pageSize)),currentPage=Math.min(page,totalPages-1);
    const pageRows=searched.slice(currentPage*pageSize,(currentPage+1)*pageSize);
    const statusLabels = {ready:'Ready to Send',scheduled:'Scheduled',sending:'Sending',sent:'Sent',held:'Needs Review',failed:'Failed'};
    const reasonLabel = reason => {
      if (!reason) return '—';
      if (/Draft saved|Review message|reviewed draft/i.test(reason)) return 'Review and approve email';
      if (/Manually placed on hold/i.test(reason)) return 'Paused by you';
      return reason.replace(/\\b(school_id|user_id|verified_email)\\b/g,'record information');
    };
    return h('section',{id:'crm-outreach-queue',className:'cc-section',style:{marginTop:20}},
      h('div',{className:'cc-heading'},h('h3',null,onlyKind==='follow_up'?'School Follow-Up Queue':'Initial Outreach Queue'),h('button',{className:'btn',disabled:busy,onClick:refresh},'Refresh')),
      h('p',{className:'cc-note'},'Initial outreach and follow-ups are approved separately. Ready to Send queues a reviewed message; it does not send it.'),
      onlyKind!=='follow_up'&&h('details',{open:addOpen,onToggle:e=>setAddOpen(e.currentTarget.open),style:{margin:'12px 0'}},h('summary',{style:{cursor:'pointer',fontWeight:600}},'Add a prospect to the queue'),h('form',{onSubmit:add,style:{display:'flex',flexWrap:'wrap',gap:8}},
        h('div',{style:{width:'100%',maxWidth:560}},h('input',{value:schoolSearch,onChange:e=>{setSchoolSearch(e.target.value);setSchool('');},placeholder:'Search school or contact',style:{width:'100%',marginBottom:6}}),h('select',{required:true,value:school,onChange:e=>setSchool(e.target.value),style:{width:'100%'}},h('option',{value:''},kind==='follow_up'?'Select a school previously emailed':'Select a school that needs initial outreach'),schools.filter(p=>kind==='follow_up'?hasPrior(p):(!hasPrior(p)&&p.status==='Not Started')).filter(p=>!rows.some(q=>q.school_id===p.school_id&&q.kind===kind)).filter(p=>((p.record?.school||p.school_id)+' '+(p.contact||'')+' '+(p.email||'')).toLowerCase().includes(schoolSearch.toLowerCase())).map(p=>h('option',{key:p.school_id,value:p.school_id},(p.record?.school||p.school_id)+' | '+(p.contact||'Contact unknown')+(hasPrior(p)?' | PREVIOUSLY EMAILED':' | NOT EMAILED')))),h('small',null,(kind==='follow_up'?'Only schools with recorded prior outreach appear. ':'Only schools without recorded prior outreach appear. ')+schools.filter(p=>(kind==='follow_up'?hasPrior(p):(!hasPrior(p)&&p.status==='Not Started'))&&!rows.some(q=>q.school_id===p.school_id&&q.kind===kind)).length+' available.')),
        h('select',{value:kind,onChange:e=>setKind(e.target.value)},h('option',{value:'initial'},'Initial outreach'),h('option',{value:'follow_up'},'Follow-up')),
        h('button',{className:'btn primary',disabled:busy,type:'submit'},'Add to queue'))),
      error&&h('p',{role:'alert'},error),
      h('label',null,'Filter ',h('select',{value:filter,onChange:e=>setFilter(e.target.value)},['active','all',...states].map(s=>h('option',{key:s,value:s},s==='active'?'Active items':s==='all'?'All items':statusLabels[s]+' ('+counts[s]+')')))),
      h('input',{'aria-label':'Search outreach queue',placeholder:'Search queue by school or email',value:queueSearch,onChange:e=>setQueueSearch(e.target.value),style:{margin:'10px 0',width:'100%',maxWidth:420}}),
      h('div',{style:{overflowX:'auto'}},h('table',{className:'cc-table'},
        h('thead',null,h('tr',null,['School','Type','Status','Reason','Approval'].map(x=>h('th',{key:x},x)))),
        h('tbody',null,pageRows.map(item=>h('tr',{key:item.id},
          h('td',null,byId.get(String(item.school_id))?.record?.school || 'School name unavailable'),h('td',null,byId.get(String(item.school_id))?.record?.type || byId.get(String(item.school_id))?.record?.category || 'School'),
          h('td',null,(statusLabels[item.status]||item.status)+(item.kind==='follow_up'?' · Follow-up':' · Initial email')),h('td',null,reasonLabel(item.hold_reason),item.kind==='follow_up'&&h('small',{style:{display:'block'}},'Original email sent: '+(item.original_sent_at?new Date(item.original_sent_at).toLocaleDateString('en-US',{timeZone:'America/Boise'}):'Not recorded')+' · Follow-up due: '+(item.follow_up_due||'Not scheduled')+(item.sent_at?' · Follow-up sent: '+new Date(item.sent_at).toLocaleString('en-US',{timeZone:'America/Boise'}):'')),item.original_thread_id&&h('a',{href:'https://mail.google.com/mail/u/?authuser=gabemurfittspeaker%40gmail.com#all/'+item.original_thread_id,target:'_blank',rel:'noopener noreferrer'},'Open Gmail conversation')),
          h('td',null,h('label',null,h('input',{type:'checkbox',checked:['ready','scheduled'].includes(item.status),disabled:busy||['sent','sending'].includes(item.status),onChange:e=>toggle(item,e.target.checked)}),' Ready to Send'),
            approvalFeedback[item.id]&&h('p',{role:approvalFeedback[item.id].failed?'alert':'status',style:{maxWidth:300,margin:'6px 0',color:approvalFeedback[item.id].failed?'#b91c1c':'var(--accent)',fontSize:12}},approvalFeedback[item.id].message),
            h('button',{className:'btn sm',disabled:busy||['sent','sending'].includes(item.status),onClick:()=>setDraft({id:item.id,subject:item.approved_subject||'',body:item.approved_body||''})},'Review draft'))))))),
      !searched.length&&h('p',{className:'cc-note'},'No queue items match this view.'),
      h('div',{style:{display:'flex',alignItems:'center',gap:12,flexWrap:'wrap',margin:'12px 0'}},
        h('button',{className:'btn',disabled:currentPage===0,onClick:()=>setPage(currentPage-1)},'Previous'),
        h('span',{'aria-live':'polite'},searched.length?(currentPage*pageSize+1)+'–'+Math.min((currentPage+1)*pageSize,searched.length)+' of '+searched.length:'0 items'),
        h('button',{className:'btn',disabled:currentPage>=totalPages-1,onClick:()=>setPage(currentPage+1)},'Next')),
      draft&&h('div',{className:'cc-editor',ref:draftEditorRef},h('h4',null,'Review email draft'),
        h('label',null,'Subject',h('input',{value:draft.subject,onChange:e=>setDraft({...draft,subject:e.target.value})})),
        h('label',null,'Message',h('textarea',{value:draft.body,onChange:e=>setDraft({...draft,body:e.target.value}),style:{width:'100%',minHeight:180}})),
        h('button',{className:'btn primary',disabled:busy,onClick:saveDraft},draft.approveAfterSave?'Save and mark ready':'Save reviewed draft'),
        h('button',{className:'btn',onClick:()=>setDraft(null)},'Cancel')),
      h('p',{className:'cc-note'},'Displays the 300 most recently updated items. Ready items follow your approved sending schedule.'));
  }
  root.SpeakingOutreachQueue = {states,Queue,eligible};
})(window);
