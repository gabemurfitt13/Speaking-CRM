// Reuse the browser's original-thread analyzer and MIME builder in the existing server sender.
import '../../../js/threaded-followups.js';
import {OWNER,MAILBOX,base64url} from '../gmail-oauth/handler.mjs';
import {email,district,businessHours,dayStart,header,addresses,confirmedMessage,snapshot,ProviderError,QuotaYield,ZONES} from './worker.mjs';
export const core=globalThis.CRMThreadedFollowups;
export function followupStatic(q,p,now){
 if(q.user_id!==OWNER||p.user_id!==OWNER||q.kind!=='follow_up'||!q.review_approved_at)return 'APPROVAL_REQUIRED';
 if(!['held','ready'].includes(q.status)||q.provider_message_id||q.follow_up_thread_id)return 'SEND_EVIDENCE_REVIEW';
 if(q.status==='held'&&q.hold_reason!=='Approved by you; sending blocked: Original Gmail conversation check pending'&&!/^Your saved draft is approved\. Original Gmail thread matched[.;].*(?:RATE_LIMIT_EXCEEDED|403|blocked)/i.test(q.hold_reason||''))return 'INTENTIONAL_HOLD';
 if(q.status==='ready'&&q.hold_reason)return 'INTENTIONAL_HOLD';
 if(!q.follow_up_due||q.follow_up_due>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Boise'}).format(new Date(now)))return 'NOT_DUE';
 if(q.scheduled_at&&Date.parse(q.scheduled_at)>now)return 'NOT_DUE';
 if(p.status!=='Emailed'||p.record?.status&&p.record.status!=='Emailed'||p.record?.command?.workflow?.routinePaused||p.record?.command?.replyNeedsResponse||p.record?.command?.outreachPaused||p.record?.command?.doNotContact)return 'CRM_SUPPRESSED';
 if(!core.school(p.record||{})||!q.original_message_id||!q.original_thread_id||!q.approved_body||!q.approved_subject)return 'THREAD_OR_SCHOOL_MISSING';
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q.verified_email||'')||email(q.verified_email)!==email(p.email))return 'RECIPIENT_CHANGED';
 if(!['high','verified'].includes(email(p.contact_confidence))||!p.contact_source||!p.last_verified||Date.parse(p.last_verified)>now||!Number.isFinite(Date.parse(p.last_verified))||now-Date.parse(p.last_verified)>31*86400000)return 'CONTACT_REVIEW';
 const notes=[p.notes,p.record?.notes,JSON.stringify(p.record?.command?.holds||'')].filter(Boolean).join('\n');
 if(/\bDEFERRED\b|\bWARM\b|\bRECONNECT\b|DO NOT CONTACT|do not send yet|Gabe handles|snippet.only|BOUNCED|invalid email|account inactive/i.test(notes))return 'CONTACT_OR_SPECIAL_HOLD';
 const proof=p.record?.command?.followupContactVerification;
 let directPublished=false;
 try{const host=new URL(proof?.source||'').hostname.toLowerCase(),domain=email(p.email).split('@')[1];directPublished=proof?.exactAddressPublished===true&&email(proof.email)===email(q.verified_email)&&proof.source===p.contact_source&&Number.isFinite(Date.parse(proof.checkedAt))&&Date.parse(proof.checkedAt)<=now&&now-Date.parse(proof.checkedAt)<=31*86400000&&(host===domain||host.endsWith('.'+domain));}catch{}
 if(/OSAA/i.test(notes)&&!directPublished)return 'CONTACT_OR_SPECIAL_HOLD';
 if(/Kamiakin|Meadowdale|Edgemont|Mountlake Terrace|Everett Jackson|Carmichael|Magic Valley|Lapwai|Brindlee|Buena Park|Sonora|Liberty.*Joes/i.test(p.record?.school||'')||/Kennewick|Kuna|Fresno/i.test(p.record?.district||''))return 'SPECIAL_CASE_REVIEW';
 const zones=ZONES[String(p.record?.state||'').toUpperCase()];
 if(!zones)return 'TIMEZONE_UNKNOWN';
 if(!businessHours(now,'America/Boise')||!zones.every(z=>businessHours(now,z)))return 'OUTSIDE_HOURS';
 return null;
}
export async function preflight(gmail,q,p,now){
 const campusContacts=[...new Set([q.verified_email,...[...(p.extra_contacts||[]),...(p.record?.extraContacts||[])].map(c=>c.email)].map(email).filter(a=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)))];
 const query=campusContacts.length===1?'"'+campusContacts[0]+'"':'{'+campusContacts.map(a=>'"'+a+'"').join(' ')+'}';
 const found=await gmail.list('in:anywhere '+query,200);
 if(!found.complete)return {eligible:false,code:'INCOMPLETE_HISTORY',error:'Recipient history exceeds complete review budget'};
 const messages=new Map();for(const x of found.messages)messages.set(x.id,await gmail.full(x.id));
 const ids=new Set([q.original_thread_id,...[...messages.values()].map(x=>x.threadId)]);
 for(const id of ids){if(!id)return {eligible:false,code:'THREAD_METADATA_MISSING'};const thread=await gmail.thread(id);for(const m of thread.messages||[])messages.set(m.id,m);}
 const all=[...messages.values()],original=messages.get(q.original_message_id);
 const match=core.analyze({...p.record,status:p.status,email:p.email},all,q.original_message_id,now);
 if(!match.eligible)return {...match,messageIds:[...messages.keys()]};
 if(match.threadId!==q.original_thread_id||match.subject!==q.approved_subject)return {eligible:false,code:'APPROVED_THREAD_CHANGED',error:'Original thread or exact approved subject differs'};
 if(all.some(m=>m.id!==original.id&&core.stamp(m)>=core.stamp(original)&&core.labels(m).includes('SENT')&&addresses(header(m,'From')).includes(MAILBOX)&&addresses(header(m,'To')).some(a=>campusContacts.includes(a))))return {eligible:false,code:'CAMPUS_FOLLOWUP_EXISTS',error:'A later outbound message already exists for a saved contact at this school'};
 if(all.some(m=>m.id!==original.id&&core.stamp(m)<core.stamp(original)&&addresses(header(m,'To')).includes(email(q.verified_email))&&core.labels(m).includes('SENT')))return {eligible:false,code:'PRIOR_CONTACT_REVIEW',error:'Earlier exact-address outreach requires reconnect review'};
 return {...match,messageIds:[...messages.keys()],checkedAt:new Date(now).toISOString(),allMailChecked:true,completeThreadChecked:true,recipient:q.verified_email,originalMessageId:match.originalId};
}
export function districtRestriction(message){
 if(/mailer-daemon|postmaster/i.test(header(message,'From'))||/delivery status|undeliverable/i.test(header(message,'Subject')))return false;
 const text=core.content(message).replace(/<[^>]*>/g,' ').replace(/^>.*$/gm,'').split(/\r?\n(?:On .{0,200}wrote:|From:|-----Original Message-----)/i)[0];
 const scope=/\bdistrict[ -]*wide\b|\b(?:our|the|this) (?:school )?district\b|\b(?:all|any|every|each|none)(?: of)? (?:our |the |this )?(?:schools|campuses)\b|\bany other (?:schools|campuses)\b/i;
 const restriction=/\b(?:do not|don't|does not|doesn't|cannot|can't|may not|not (?:allow|accept|permit)|prohibit(?:ed|s)?|no (?:outside|external|guest|speakers)|must (?:go|be)|requir(?:e|es|ed))\b/i;
 return text.split(/[.!?\n]+/).some(sentence=>scope.test(sentence)&&restriction.test(sentence));
}
export function districtWideContextHold(context,key){
 for(const p of context){const hold=p.record?.command?.districtWideHold;if(district(p)===key&&hold?.active===true&&hold.scope==='district'&&hold.gmailMessageId&&hold.reason)return 'Explicit district-wide hold: '+hold.reason;}
 return null;
}
export async function districtReview(gmail,domain){
 const found=await gmail.list('in:anywhere "'+domain+'" -from:'+MAILBOX,100);
 if(!found.complete||found.messages.length>30)return 'District inbound history needs manual review';
 for(const item of found.messages){const message=await gmail.full(item.id);if(districtRestriction(message))return 'Explicit district-wide instruction in Gmail message '+message.id;}
 return null;
}
export function confirmedFollowup(m,q,match){return confirmedMessage(m,q)&&m.threadId===match.threadId&&header(m,'In-Reply-To')===match.rfcMessageId&&header(m,'References').split(/\s+/).includes(match.rfcMessageId);}
export function rawFollowup(q,match){return base64url(new TextEncoder().encode(core.mime(q.verified_email,q.approved_body,match)));}
export async function runFollowups({run,store,gmail,now=()=>Date.now(),phase=()=>{}}){
 const live=run.mode==='followups',started=now(),items=[],cache=new Map(),domainCache=new Map();let sent=0,failed=0,ambiguous=0,inspected=0,providerStopped=false,stopReason=null;
 for(const m of store.sentCache?await store.sentCache(dayStart(now())):[])cache.set(m.id,m);
 let account=await snapshot(gmail,now(),cache);
 if(store.saveSentCache&&account.messages.length)try{await store.saveSentCache(account.messages);}catch{}
 const base={runId:run.id,mode:run.mode,mailbox:MAILBOX,initialAccountDaily:account.daily,initialAccountHourly:account.hourly};
 if(await store.aiActive()||(await store.claims()).length)return {...base,sent:0,stopped:'Another sending claim requires reconciliation'};
 if(account.daily>=270||account.hourly>=45)return {...base,sent:0,stopped:'Shared sending ceiling reached'};
 if(!businessHours(now(),'America/Boise'))return {...base,sent:0,stopped:'Outside Boise hours'};
 const bounces=await gmail.list('in:anywhere after:'+Math.floor(dayStart(now())/1000)+' {from:mailer-daemon from:postmaster subject:"Delivery Status Notification" subject:"Undeliverable"}',10);
 const reviewedNotices=new Set(await store.reviewedDeliveryNoticeIds?.()||[]);const unreviewedNotices=bounces.messages.filter(x=>!reviewedNotices.has(x.id));
 if(!bounces.complete||unreviewedNotices.length>2){if(live)await store.pause('BOUNCE_REVIEW: more than two unreviewed delivery notices or incomplete history');return {...base,sent:0,stopped:'Bounce accumulation requires review',deliveryNotices:unreviewedNotices.map(x=>x.id)};}
 const context=await store.context();
 try{for(const {queue:q,prospect:p} of await store.followupCandidates()){
  if(now()-started>85000||sent>=run.max_sends||(!live&&items.filter(i=>i.eligible).length>=run.max_sends))break;
  inspected++;phase('Follow-up '+q.school_id);let reason=followupStatic(q,p,now());const key=district(p),domain=email(q.verified_email).split('@')[1];
  if(!reason)reason=districtWideContextHold(context,key);
  if(!reason){if(!domainCache.has(domain))domainCache.set(domain,await districtReview(gmail,domain));if(domainCache.get(domain))reason='DISTRICT_CONVERSATION_REVIEW: '+domainCache.get(domain);}
  let match;if(!reason){match=await preflight(gmail,q,p,now());if(!match.eligible)reason=match.code+': '+(match.error||'Gmail review required');}
  if(reason){items.push({queueId:q.id,schoolId:q.school_id,eligible:false,reason});if(live&&!['OUTSIDE_HOURS','NOT_DUE'].includes(reason))await store.followupReview(q,reason,match);continue;}
  if(!live){items.push({queueId:q.id,schoolId:q.school_id,recipient:q.verified_email,eligible:true,originalMessageId:match.originalId,threadId:match.threadId});continue;}
  account=await snapshot(gmail,now(),cache);
  if(account.daily>=270||account.hourly>=45){stopReason='Shared sending ceiling reached';break;}
  gmail.ensureSendBudget?.();
  const claimed=await store.claimFollowup(run,q,account,match);if(!claimed){items.push({queueId:q.id,schoolId:q.school_id,eligible:false,reason:'Approval or claim changed'});continue;}
  let accepted=null,sendStarted=false;
  try{
   await store.intent(claimed,{runId:run.id,phase:'send_requested',originalMessageId:match.originalId,threadId:match.threadId,rfcMessageId:match.rfcMessageId,checkedAt:new Date(now()).toISOString()});
   sendStarted=true;accepted=await gmail.send(rawFollowup(q,match),async()=>{await store.beforeSend(claimed);const scopeHold=await districtReview(gmail,domain);if(scopeHold)throw Error('District restriction appeared before POST: '+scopeHold);const fresh=await preflight(gmail,q,p,now());if(!fresh.eligible||fresh.threadId!==match.threadId||fresh.rfcMessageId!==match.rfcMessageId)throw Error('Thread changed immediately before POST: '+(fresh.code||'identity mismatch'));gmail.ensureSendBudget?.();await store.beforeSend(claimed);},match.threadId);
   if(!accepted.id||accepted.threadId!==match.threadId)throw Error('GMAIL_ACCEPTED_THREAD_MISMATCH');
   await store.accepted(claimed,accepted);const confirmed=await gmail.full(accepted.id);
   if(!confirmedFollowup(confirmed,q,match))throw Error('GMAIL_SENT_THREAD_OR_COPY_NOT_CONFIRMED');
   await store.confirm(claimed,confirmed,header(confirmed,'Message-ID'));sent++;cache.set(confirmed.id,confirmed);account.messages.push(confirmed);
   if(store.saveSentCache)try{await store.saveSentCache([confirmed]);}catch{}
   items.push({queueId:q.id,schoolId:q.school_id,recipient:q.verified_email,sent:true,messageId:confirmed.id,threadId:confirmed.threadId,originalMessageId:match.originalId,sentAt:new Date(Number(confirmed.internalDate)).toISOString()});
  }catch(error){const rejected=error instanceof ProviderError&&error.status>=400&&error.status<500&&!accepted;const label=(!sendStarted||error.preSend)?'FAILED_PRE_SEND':rejected?'FAILED_REJECTED':'AMBIGUOUS_SEND';if(label==='AMBIGUOUS_SEND')ambiguous++;else failed++;await store.hold(claimed,label+': '+error.message,accepted);items.push({queueId:q.id,schoolId:q.school_id,sent:false,outcome:label,error:error.message,messageId:accepted?.id||null});if(!error.preSend&&(!rejected||[401,403,429].includes(error.status))){providerStopped=true;stopReason=label+': '+error.message;await store.pause(stopReason);break;}}
 }}catch(error){stopReason=error.message;providerStopped=!(error instanceof QuotaYield);if(providerStopped&&live)await store.pause('FOLLOWUP_PREFLIGHT: '+error.message);items.push({preflightFailed:true,error:error.message});}
 return {...base,sent,failed,ambiguous,inspected,providerStopped,stopReason,skipped:items.filter(i=>i.eligible===false).length,apiQuotaUnitsUsed:gmail.usedUnits??null,items};
}

