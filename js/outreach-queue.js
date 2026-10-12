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
    if (item.kind === 'follow_up' && !hasPrior(p)) return 'Follow-up requires recorded prior outreach.';
    if (!item.approved_subject || !item.approved_body) return 'Review and save the email draft first.';
    return null;
  };
  function Queue({client, uid}) {
    const [rows, setRows] = React.useState([]), [school, setSchool] = React.useState(''), [kind, setKind] = React.useState('initial'), [schools,setSchools]=React.useState([]);
    const [filter, setFilter] = React.useState('all'), [draft, setDraft] = React.useState(null);
    const [schoolSearch,setSchoolSearch]=React.useState('');
    const [busy, setBusy] = React.useState(false), [error, setError] = React.useState('');
    async function refresh() {
      if (!client || !uid) return;
      setBusy(true); setError('');
      try {
        const q = await client.from('outreach_queue').select('*').eq('user_id', uid).order('updated_at', {ascending:false}).limit(300);
        if (q.error) throw q.error;
        setRows(q.data || []);
      } catch (e) { setError(e.message || 'Unable to load queue'); }
      finally { setBusy(false); }
    }
    React.useEffect(() => { refresh(); }, [client, uid]);
    React.useEffect(()=>{if(!client||!uid)return;let active=true;client.from('progress').select('school_id,email,status,contact,contact_confidence,last_verified,contact_source,contacted,notes,log,record').eq('user_id',uid).not('email','is',null).limit(1000).then(({data,error})=>{if(!active)return;if(error){setError(error.message);return;}setSchools((data||[]).filter(p=>!blocked.test(String(p.status||'')+' '+String(p.notes||''))&&['high','verified'].includes(String(p.contact_confidence||'').toLowerCase())&&p.last_verified&&p.contact_source));});return()=>{active=false};},[client,uid]);
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
        const q = await client.from('outreach_queue').upsert({user_id:uid,school_id:p.school_id,kind,status:'held',verified_email:p.email,hold_reason:'Review message and verify eligibility before marking ready',updated_at:new Date().toISOString()}, {onConflict:'user_id,school_id,kind'}).select('id').single();
        if (q.error) throw q.error;
        setSchool(''); await refresh();
      } catch (e) { setError(e.message); } finally { setBusy(false); }
    }
    async function saveDraft() {
      if (!draft || !draft.subject.trim() || !draft.body.trim()) { setError('Subject and message are required.'); return; }
      setBusy(true); setError('');
      try {
        const q = await client.from('outreach_queue').update({approved_subject:draft.subject.trim(),approved_body:draft.body.trim(),status:'held',hold_reason:'Draft saved. Check Ready to Send after review.',updated_at:new Date().toISOString()}).eq('id',draft.id).eq('user_id',uid).in('status',['held','ready','failed']).select('id').maybeSingle();
        if (q.error) throw q.error;
        if (!q.data) throw Error('Item changed. Refresh before editing.');
        setDraft(null); await refresh();
      } catch (e) { setError(e.message); } finally { setBusy(false); }
    }
    async function toggle(item, checked) {
      setBusy(true); setError('');
      try {
        if (['sending','sent'].includes(item.status)) throw Error('This item cannot be changed while sending or after being sent.');
        if (checked) {
          const p = await lookup(item.school_id);
          const reason = eligible(p,item);
          if (reason) throw Error(reason);
        }
        const q = await client.from('outreach_queue').update({status:checked?'ready':'held',hold_reason:checked?null:'Manually placed on hold',updated_at:new Date().toISOString()}).eq('id',item.id).eq('user_id',uid).eq('status',item.status).select('id').maybeSingle();
        if (q.error) throw q.error;
        if (!q.data) throw Error('Queue item changed. Refresh and retry.');
        await refresh();
      } catch (e) { setError(e.message); } finally { setBusy(false); }
    }
    const counts = Object.fromEntries(states.map(s=>[s,rows.filter(x=>x.status===s).length]));
    const visible = rows.filter(x=>filter==='all'||x.status===filter);
    return h('section',{className:'cc-section',style:{marginTop:20}},
      h('div',{className:'cc-heading'},h('h3',null,'Outreach Queue'),h('button',{className:'btn',disabled:busy,onClick:refresh},'Refresh')),
      h('p',{className:'cc-note'},'Initial outreach and follow-ups are approved separately. Ready to Send queues a reviewed message; it does not send it.'),
      h('form',{onSubmit:add,style:{display:'flex',flexWrap:'wrap',gap:8}},
        h('div',{style:{width:'100%',maxWidth:560}},h('input',{value:schoolSearch,onChange:e=>{setSchoolSearch(e.target.value);setSchool('');},placeholder:'Search school or contact',style:{width:'100%',marginBottom:6}}),h('select',{required:true,value:school,onChange:e=>setSchool(e.target.value),style:{width:'100%'}},h('option',{value:''},kind==='follow_up'?'Select a school previously emailed':'Select a school that needs initial outreach'),schools.filter(p=>kind==='follow_up'?hasPrior(p):(!hasPrior(p)&&p.status==='Not Started')).filter(p=>!rows.some(q=>q.school_id===p.school_id&&q.kind===kind)).filter(p=>((p.record?.school||p.school_id)+' '+(p.contact||'')+' '+(p.email||'')).toLowerCase().includes(schoolSearch.toLowerCase())).map(p=>h('option',{key:p.school_id,value:p.school_id},(p.record?.school||p.school_id)+' | '+(p.contact||'Contact unknown')+(hasPrior(p)?' | PREVIOUSLY EMAILED':' | NOT EMAILED')))),h('small',null,(kind==='follow_up'?'Only schools with recorded prior outreach appear. ':'Only schools without recorded prior outreach appear. ')+schools.filter(p=>(kind==='follow_up'?hasPrior(p):(!hasPrior(p)&&p.status==='Not Started'))&&!rows.some(q=>q.school_id===p.school_id&&q.kind===kind)).length+' available.')),
        h('select',{value:kind,onChange:e=>setKind(e.target.value)},h('option',{value:'initial'},'Initial outreach'),h('option',{value:'follow_up'},'Follow-up')),
        h('button',{className:'btn primary',disabled:busy,type:'submit'},'Add to queue')),
      error&&h('p',{role:'alert'},error),
      h('label',null,'Filter ',h('select',{value:filter,onChange:e=>setFilter(e.target.value)},['all',...states].map(s=>h('option',{key:s,value:s},s==='all'?'All':s+' ('+counts[s]+')')))),
      h('div',{style:{overflowX:'auto'}},h('table',{className:'cc-table'},
        h('thead',null,h('tr',null,['School','Type','Status','Reason','Approval'].map(x=>h('th',{key:x},x)))),
        h('tbody',null,visible.map(item=>h('tr',{key:item.id},
          h('td',null,item.school_id),h('td',null,item.kind==='follow_up'?'Follow-up':'Initial'),
          h('td',null,item.status),h('td',null,item.hold_reason||'—'),
          h('td',null,h('label',null,h('input',{type:'checkbox',checked:item.status==='ready',disabled:busy||['sent','sending'].includes(item.status),onChange:e=>toggle(item,e.target.checked)}),' Ready to Send'),
            h('button',{className:'btn sm',disabled:busy||['sent','sending'].includes(item.status),onClick:()=>setDraft({id:item.id,subject:item.approved_subject||'',body:item.approved_body||''})},'Review draft'))))))),
      draft&&h('div',{className:'cc-editor'},h('h4',null,'Review email draft'),
        h('label',null,'Subject',h('input',{value:draft.subject,onChange:e=>setDraft({...draft,subject:e.target.value})})),
        h('label',null,'Message',h('textarea',{value:draft.body,onChange:e=>setDraft({...draft,body:e.target.value}),style:{width:'100%',minHeight:180}})),
        h('button',{className:'btn primary',disabled:busy,onClick:saveDraft},'Save reviewed draft'),
        h('button',{className:'btn',onClick:()=>setDraft(null)},'Cancel')),
      h('p',{className:'cc-note'},'Displays the 300 most recently updated items. Sending worker is not included or enabled.'));
  }
  root.SpeakingOutreachQueue = {states,Queue,eligible};
})(window);
