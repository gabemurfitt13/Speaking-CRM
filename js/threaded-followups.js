(function(root){
'use strict';
const OWNER='gabemurfittspeaker@gmail.com';
const header=(m,n)=>(m.payload?.headers||[]).find(h=>h.name.toLowerCase()===n.toLowerCase())?.value||'';
const addresses=s=>(String(s).toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/g)||[]);
const stamp=m=>Number(m.internalDate||m.internal_date||Date.parse(m.email_ts||'')||0);
const labels=m=>m.labelIds||m.label_ids||m.labels||[];
const from=m=>header(m,'From')||m.from_||'';
const to=m=>header(m,'To')||(m.to||[]).join(',');
function school(p){return /school|high|middle|K-8|elementary/i.test(p.type||p.record?.type||'')&&!/conference|church|business|college|university/i.test(p.type||p.record?.type||'');}
function content(m){let s=m.snippet||'';function parts(p){if(p?.body?.content)s+=' '+p.body.content;if(p?.body?.data){try{s+=' '+new TextDecoder().decode(Uint8Array.from(atob(p.body.data.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0)));}catch(e){}}(p?.parts||[]).forEach(parts);}parts(m.payload);return s;}
function campus(s){return String(s||'').toLowerCase().replace(/\([^)]*\)/g,'').replace(/\b(school|high|middle|junior|jr|senior|core|knowledge)\b/g,'').replace(/[^a-z0-9]+/g,' ').trim();}
function replySubject(s){return /^Re:\s*/i.test(s)?s:'Re: '+s;}
function dueDate(ms){let d=new Date(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Boise',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms))+'T12:00:00Z');let n=5;while(n){d.setUTCDate(d.getUTCDate()+1);if(![0,6].includes(d.getUTCDay()))n--;}return d.toISOString().slice(0,10);}
function analyze(p,messages,originalId,now=Date.now()){
 const fail=(code,error)=>({eligible:false,code,error});
 if(!school(p))return fail('NON_SCHOOL','Only direct-school unanswered outreach is authorized.');
 if(p.status!=='Emailed'||p.command?.replyNeedsResponse||p.command?.outreachPaused||p.command?.doNotContact)return fail('CRM_SUPPRESSED','CRM indicates an answered, paused or closed conversation.');
 const original=messages.find(m=>m.id===originalId);
 if(!original||!labels(original).includes('SENT')||!addresses(from(original)).includes(OWNER))return fail('ORIGINAL_UNMATCHED','Original Gmail Sent message cannot be verified.');
 const email=String(p.email||'').trim().toLowerCase();
 if(!addresses(to(original)).includes(email))return fail('RECIPIENT_CHANGED','Original recipient does not match the current school contact.');
 const name=campus(p.school||p.record?.school);if(!name||!campus(content(original)+' '+(header(original,'Subject')||original.subject||'')).includes(name))return fail('CAMPUS_UNMATCHED','Original outreach does not match this school campus.');
 const threadId=original.threadId||original.thread_id,rfc=header(original,'Message-ID'),subject=header(original,'Subject')||original.subject;
 if(!threadId||!/^<[^\s<>]+@[^\s<>]+>$/.test(rfc)||!subject)return fail('THREAD_METADATA_MISSING','Original thread, RFC Message-ID or subject is missing.');
 if(now-stamp(original)>45*86400000)return fail('OLD_OUTREACH','Old outreach requires a separate reconnect review.');
 const due=dueDate(stamp(original));
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Boise',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
 if(due>today)return {...fail('NOT_DUE','Follow-up is not due until '+due),due};
 const later=messages.filter(m=>m.id!==originalId&&stamp(m)>=stamp(original)&&!labels(m).includes('DRAFT'));
 if(messages.some(m=>labels(m).includes('DRAFT')))return fail('DRAFT_EXISTS','A draft exists; review before another send.');
 const inbound=later.filter(m=>!addresses(from(m)).includes(OWNER));
 if(inbound.length){const automatic=inbound.every(m=>/auto|vacation/i.test(header(m,'Auto-Submitted')+' '+header(m,'X-Autoreply')+' '+header(m,'Precedence'))||/out of office|automatic reply|auto.?reply|undeliver|delivery.*fail|mailer-daemon/i.test(from(m)+' '+(header(m,'Subject')||m.subject||'')));return fail(automatic?'AUTOMATIC_RESPONSE':'HUMAN_RESPONSE',automatic?'Automatic response or delivery notice requires review.':'A school response is present; do not send a silence follow-up.');}
 if(later.some(m=>labels(m).includes('SENT')&&addresses(from(m)).includes(OWNER)&&addresses(to(m)).includes(email)))return fail('FOLLOWUP_EXISTS','A later outbound message already exists for this recipient.');
 return {eligible:true,originalId,threadId,rfcMessageId:rfc,references:[header(original,'References'),rfc].filter(Boolean).join(' '),subject:replySubject(subject),due,originalSentAt:new Date(stamp(original)).toISOString()};
}
function mime(toAddress,body,match){
 for(const s of [toAddress,match.subject,match.rfcMessageId,match.references])if(/[\r\n]/.test(s))throw Error('Invalid email header.');
 if(!match.eligible||!match.threadId)throw Error('Verified original Gmail thread is required.');
 const encodedSubject=/[^\x20-\x7e]/.test(match.subject)?'=?UTF-8?B?'+btoa(unescape(encodeURIComponent(match.subject)))+'?=':match.subject;
 return ['From: '+OWNER,'To: '+toAddress,'Subject: '+encodedSubject,'In-Reply-To: '+match.rfcMessageId,'References: '+match.references,'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','',''+body].join('\r\n');
}
const gmailURL='https://gmail.googleapis.com/gmail/v1/users/me';
async function request(path,token,options={}){const r=await fetch(gmailURL+path,{...options,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...(options.headers||{})}});const data=await r.json().catch(()=>({}));if(!r.ok)throw Error(data.error?.message||'Gmail API error '+r.status);return data;}
async function mailbox(p,token){
 const email=String(p.email||'').trim();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw Error('Verified recipient required.');
 let next='',ids=[];do{const page=await request('/messages?maxResults=100&includeSpamTrash=true&q='+encodeURIComponent('in:anywhere "'+email+'"')+(next?'&pageToken='+encodeURIComponent(next):''),token);ids.push(...(page.messages||[]));next=page.nextPageToken||'';}while(next);
 const messages=[];for(const item of ids)messages.push(await request('/messages/'+item.id+'?format=full',token));
 return messages;
}
async function prepare(p,token){
 const profile=await request('/profile',token);if(profile.emailAddress?.toLowerCase()!==OWNER)throw Error('Connect the speaking Gmail account.');
 const messages=await mailbox(p,token),email=p.email.toLowerCase();
 const sent=messages.filter(m=>labels(m).includes('SENT')&&addresses(from(m)).includes(OWNER)&&addresses(to(m)).includes(email)).sort((a,b)=>stamp(a)-stamp(b));
 const recent=sent.filter(m=>Date.now()-stamp(m)<=45*86400000),original=recent[0];if(!original)throw Error('Original recent Gmail outreach cannot be matched. Hold for review.');
 const thread=await request('/threads/'+original.threadId+'?format=full',token);
 const all=[...new Map([...messages,...(thread.messages||[])].map(m=>[m.id,m])).values()];
 const match=analyze(p,all,original.id);return {match,messages:all};
}
async function send(p,body,token,db,uid){
 if(root.crmPersistence&&!(await root.crmPersistence.flush()))throw Error('Save pending CRM changes before sending.');
 const q=await db.from('outreach_queue').select('*').eq('user_id',uid).eq('school_id',p.id||p.school_id).eq('kind','follow_up').maybeSingle();if(q.error)throw q.error;
 if(q.data&&['sent','sending'].includes(q.data.status))throw Error('This follow-up is already sent or sending.');
 if(q.data?.hold_reason&&!/Needs review: confirm original|Review message|Draft saved|thread preflight/i.test(q.data.hold_reason))throw Error(q.data.hold_reason);
 const {match}=await prepare(p,token);if(!match.eligible){if(q.data)await db.from('outreach_queue').update({status:'held',thread_check_result:match.code,thread_checked_at:new Date().toISOString(),hold_reason:match.error}).eq('id',q.data.id).in('status',['ready','scheduled','held']);throw Error(match.error);}
 const now=new Date().toISOString(),item={user_id:uid,school_id:p.id||p.school_id,kind:'follow_up',status:'ready',verified_email:p.email,approved_subject:match.subject,approved_body:body,hold_reason:null,original_message_id:match.originalId,original_thread_id:match.threadId,original_rfc_message_id:match.rfcMessageId,original_references:match.references,original_sent_at:match.originalSentAt,follow_up_due:match.due,thread_checked_at:now,thread_check_result:'unanswered',thread_check_evidence:{originalMessageId:match.originalId,threadId:match.threadId,recipient:p.email,checkedAt:now},approval_scope:'gabe-school-silence-followups-20261013'};
 const saved=await db.from('outreach_queue').upsert(item,{onConflict:'user_id,school_id,kind'}).select('*').single();if(saved.error)throw saved.error;
 const claimed=await db.from('outreach_queue').update({status:'sending',claimed_at:now,attempt_count:(saved.data.attempt_count||0)+1}).eq('id',saved.data.id).eq('status','ready').select('*').maybeSingle();if(claimed.error)throw claimed.error;if(!claimed.data)throw Error('Another worker claimed this follow-up.');
 let result;
 try{
  const check=await prepare(p,token);if(!check.match.eligible||check.match.originalId!==match.originalId)throw Error(check.match.error||'Thread changed; review required.');
  const raw=btoa(unescape(encodeURIComponent(mime(p.email,body,match)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  result=await request('/messages/send',token,{method:'POST',body:JSON.stringify({raw,threadId:match.threadId})});
  const confirmed=await request('/messages/'+result.id+'?format=metadata',token);
  if(!labels(confirmed).includes('SENT')||confirmed.threadId!==match.threadId||header(confirmed,'In-Reply-To')!==match.rfcMessageId||!header(confirmed,'References').includes(match.rfcMessageId))throw Error('Gmail threading confirmation failed; hold and reconcile before retry.');
  const done=await db.from('outreach_queue').update({status:'sent',provider_message_id:confirmed.id,follow_up_thread_id:confirmed.threadId,sent_at:new Date(stamp(confirmed)).toISOString(),claimed_at:null,hold_reason:null}).eq('id',saved.data.id).eq('status','sending').select('id').maybeSingle();if(done.error||!done.data)throw Error('Gmail sent '+confirmed.id+' but CRM confirmation failed. Reconcile; never resend.');
  return confirmed;
 }catch(e){await db.from('outreach_queue').update({status:'held',hold_reason:(result?.id?'Gmail accepted '+result.id+'; ':'')+e.message,claimed_at:null}).eq('id',saved.data.id).eq('status','sending');throw e;}
}
const api={content,campus,header,addresses,stamp,labels,school,replySubject,dueDate,analyze,mime,prepare,send};root.CRMThreadedFollowups=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
