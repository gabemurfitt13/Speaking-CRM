import {createClient} from 'npm:@supabase/supabase-js@2.95.0';
import {googleCredentialEnv,OWNER} from '../gmail-oauth/handler.mjs';
import {refreshGmail,runWorker} from './worker.mjs';
import {runFollowups} from './followups.mjs';
const env={...Object.fromEntries(['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY'].map(k=>[k,Deno.env.get(k)||''])),...googleCredentialEnv(Deno.env.toObject())};
const db=createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const checked=({data,error})=>{if(error)throw Error('CRM_DATABASE: '+error.message);return data;};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
Deno.serve(async req=>{
 if(req.method==='GET'&&new URL(req.url).pathname.endsWith('/health'))return json({ok:true,transport:'gmail',threadedFollowups:true});
 if(req.method!=='POST')return json({error:'POST_REQUIRED'},405);
 let run,phase='worker authentication';
 try{
  const text=await req.text();if(text.length>8192)return json({error:'REQUEST_TOO_LARGE'},413);
  let input;try{input=JSON.parse(text);}catch{return json({error:'INVALID_JSON'},400);}
  if(typeof input.runId!=='string'||typeof input.runToken!=='string'||input.runToken.length!==72)return json({error:'AUTHORIZED_WORKER_REQUEST_REQUIRED'},401);
  const runs=checked(await db.rpc('claim_gmail_worker_request',{p_run_id:input.runId,p_token:input.runToken}));
  if(!runs?.length)return json({error:'WORKER_REQUEST_INVALID_EXPIRED_OR_USED'},403);
  run=runs[0];if(run.user_id!==OWNER)throw Error('WORKER_OWNER_MISMATCH');
  const updateClaim=(q,values)=>db.from('outreach_queue').update(values).eq('user_id',OWNER).eq('id',q.id).eq('status','sending').eq('claimed_at',q.claimed_at).select('id');
  const saveClaim=async(q,values)=>{const data=checked(await updateClaim(q,values));if(data.length!==1)throw Error('CRM_CLAIM_OWNERSHIP_CHANGED');};
  const store={
   async sentCache(since){const rows=checked(await db.from('gmail_worker_sent_cache').select('gmail_metadata').eq('user_id',OWNER).gte('sent_at',new Date(since).toISOString()));return rows.map(x=>x.gmail_metadata);},
   async saveSentCache(messages){checked(await db.from('gmail_worker_sent_cache').upsert(messages.map(m=>({user_id:OWNER,message_id:m.id,sent_at:new Date(Number(m.internalDate)).toISOString(),gmail_metadata:{id:m.id,threadId:m.threadId,labelIds:m.labelIds,internalDate:m.internalDate,payload:{headers:(m.payload?.headers||[]).filter(h=>['to','from','subject','message-id'].includes(h.name.toLowerCase()))}}})),{onConflict:'user_id,message_id'}));},
   async claims(){return checked(await db.from('outreach_queue').select('*').eq('user_id',OWNER).eq('status','sending'));},
   async aiActive(){const rows=checked(await db.from('ai_actions').select('status,payload,execution_output').eq('user_id',OWNER).in('status',['pending','approved','sending']));return rows.some(a=>a.status==='sending'||a.payload?.sendInProgress===true||a.execution_output?.sendInProgress===true);},
   async context(){let all=[];for(let offset=0;;offset+=1000){const page=checked(await db.rpc('gmail_worker_district_context',{p_user_id:OWNER}).range(offset,offset+999));all.push(...page);if(page.length<1000)return all;}},
   async candidates(){let all=[];for(let offset=0;;offset+=300){const page=checked(await db.rpc('gmail_worker_candidates',{p_user_id:OWNER,p_limit:300,p_offset:offset}));all.push(...page);if(page.length<300)return all;}},
   async followupCandidates(){let all=[];for(let offset=0;;offset+=300){const page=checked(await db.rpc('gmail_worker_followup_candidates',{p_user_id:OWNER,p_limit:300,p_offset:offset}));all.push(...page);if(page.length<300)return all;}},
   async followupReview(q,reason,evidence){checked(await db.from('outreach_queue').update({status:'held',hold_reason:reason,thread_check_result:reason.split(':')[0],thread_checked_at:new Date().toISOString(),thread_check_evidence:{...q.thread_check_evidence,...(evidence||{}),reviewReason:reason},updated_at:new Date().toISOString()}).eq('user_id',OWNER).eq('id',q.id).eq('status',q.status).eq('review_approved_at',q.review_approved_at).eq('approved_body',q.approved_body));},
   async claimFollowup(r,q,snapshot,match){const {data,error}=await db.rpc('claim_gmail_followup',{p_run_id:r.id,p_queue_id:q.id,p_review:q.review_approved_at,p_email:q.verified_email,p_subject:q.approved_subject,p_body:q.approved_body,p_gmail_daily:snapshot.daily,p_gmail_hourly:snapshot.hourly,p_checked_at:snapshot.checkedAt,p_match:match});if(error){if(/ceiling|Another sending|AI sender/.test(error.message))throw Error(error.message);return null;}return data?.[0]||null;},
   async claim(r,q,snapshot){const {data,error}=await db.rpc('claim_gmail_initial',{p_run_id:r.id,p_queue_id:q.id,p_review:q.review_approved_at,p_email:q.verified_email,p_subject:q.approved_subject,p_body:q.approved_body,p_gmail_daily:snapshot.daily,p_gmail_hourly:snapshot.hourly,p_checked_at:snapshot.checkedAt});if(error){if(/ceiling|Another sending|AI sender/.test(error.message))throw Error(error.message);return null;}return data?.[0]||null;},
   async beforeSend(q){
    const current=checked(await db.from('outreach_queue').select('status,claimed_at,review_approved_at,verified_email,approved_subject,approved_body').eq('user_id',OWNER).eq('id',q.id).single());
    const control=checked(await db.from('gmail_worker_control').select('enabled,pause_reason,outreach_kind,followups_authorized_until').eq('user_id',OWNER).single());
    const prospect=checked(await db.from('progress').select('status,email').eq('user_id',OWNER).eq('school_id',q.school_id).single());
    if(!control.enabled||control.pause_reason||(q.kind==='initial'&&control.outreach_kind!=='initial')||current.status!=='sending'||Date.parse(current.claimed_at)!==Date.parse(q.claimed_at)||Date.parse(current.review_approved_at)!==Date.parse(q.review_approved_at)||current.verified_email!==q.verified_email||current.approved_subject!==q.approved_subject||current.approved_body!==q.approved_body||prospect.status!==(q.kind==='follow_up'?'Emailed':'Not Started')||(q.kind==='follow_up'&&(control.outreach_kind!=='follow_up'||!control.followups_authorized_until||Date.parse(control.followups_authorized_until)<=Date.now()))||prospect.email.toLowerCase()!==q.verified_email.toLowerCase())throw Error('Authorization or prospect changed before Gmail POST; no send attempted');
   },
   async intent(q,evidence){await saveClaim(q,{thread_check_evidence:{...q.thread_check_evidence,gmailWorker:evidence},updated_at:new Date().toISOString()});},
   async accepted(q,message){await saveClaim(q,{provider_message_id:message.id,...(q.kind==='follow_up'?{follow_up_thread_id:message.threadId}:{original_message_id:message.id,original_thread_id:message.threadId}),updated_at:new Date().toISOString()});},
   async confirm(q,message,rfc){if(q.kind==='follow_up'){await saveClaim(q,{status:'sent',sent_at:new Date(Number(message.internalDate)).toISOString(),provider_message_id:message.id,follow_up_thread_id:message.threadId,claimed_at:null,hold_reason:null,thread_check_evidence:{...q.thread_check_evidence,gmailWorker:{runId:run.id,phase:'confirmed_sent',messageId:message.id,threadId:message.threadId,rfcMessageId:rfc,confirmedAt:new Date().toISOString()}},updated_at:new Date().toISOString()});return;}await saveClaim(q,{status:'sent',sent_at:new Date(Number(message.internalDate)).toISOString(),provider_message_id:message.id,original_message_id:message.id,original_thread_id:message.threadId,original_rfc_message_id:rfc,original_sent_at:new Date(Number(message.internalDate)).toISOString(),claimed_at:null,hold_reason:null,thread_check_evidence:{...q.thread_check_evidence,gmailWorker:{runId:run.id,phase:'confirmed_sent',messageId:message.id,threadId:message.threadId,rfcMessageId:rfc,confirmedAt:new Date().toISOString()}},updated_at:new Date().toISOString()});},
   async hold(q,reason,accepted){const current=checked(await db.from('outreach_queue').select('status').eq('id',q.id).eq('user_id',OWNER).single());if(['held','sent'].includes(current.status))return;await saveClaim(q,{status:'held',claimed_at:null,hold_reason:reason,...(accepted?.id?{provider_message_id:accepted.id,...(q.kind==='follow_up'?{follow_up_thread_id:accepted.threadId}:{original_message_id:accepted.id,original_thread_id:accepted.threadId})}:{}),updated_at:new Date().toISOString()});},
   async pause(reason){checked(await db.from('gmail_worker_control').update({pause_reason:reason,updated_at:new Date().toISOString()}).eq('user_id',OWNER));}
  };
  const connection=checked(await db.from('gmail_connections').select('*').eq('user_id',OWNER).eq('status','connected').single());
  phase='Gmail refresh';const gmail=await refreshGmail(env,connection);
  const control=checked(await db.from('gmail_worker_control').select('*').eq('user_id',OWNER).single());
  const followupMode=control.outreach_kind==='follow_up'&&['live','dry_run','followups','dry_followups'].includes(run.mode);
  const result=followupMode&&(!control.followups_authorized_until||Date.parse(control.followups_authorized_until)<=Date.now())?{sent:0,stopped:'Follow-up authorization expired; initial sending remains parked'}:await (followupMode?runFollowups:runWorker)({run:followupMode?{...run,mode:['live','followups'].includes(run.mode)?'followups':'dry_followups'}:run,store,gmail,phase:value=>{phase=value}});
  checked(await db.from('gmail_worker_runs').update({status:result.providerStopped?'failed':'completed',finished_at:new Date().toISOString(),result}).eq('id',run.id));
  return json(result);
 }catch(error){
  // Do not log request URLs, secrets, OAuth responses, or bearer tokens.
  const message=String(phase+': '+(error.message||'WORKER_FAILED')).slice(0,1200);
  if(run){await db.from('gmail_worker_runs').update({status:'failed',finished_at:new Date().toISOString(),result:{error:message}}).eq('id',run.id);if(['live','followups'].includes(run.mode))await db.from('gmail_worker_control').update({pause_reason:message,updated_at:new Date().toISOString()}).eq('user_id',OWNER);}
  return json({error:message},500);
 }
});
