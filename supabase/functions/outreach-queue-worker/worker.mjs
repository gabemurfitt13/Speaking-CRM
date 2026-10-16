import {MAILBOX,OWNER,base64url,unseal} from '../gmail-oauth/handler.mjs';
const utf8=new TextEncoder();
export const compact=x=>String(x||'').toLowerCase().replace(/[^a-z0-9]/g,'');
export const email=x=>String(x||'').trim().toLowerCase();
export function district(p){return compact(p.record?.command?.spreadGroup||p.record?.district||email(p.email).split('@')[1]);}
export function localParts(now,tz){return Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:tz,weekday:'short',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now)).map(p=>[p.type,p.value]));}
export function businessHours(now,tz){const p=localParts(now,tz);return !['Sat','Sun'].includes(p.weekday)&&Number(p.hour)>=9&&Number(p.hour)<15;}
export function dayStart(now){const p=localParts(now,'America/Boise');const midday=Date.UTC(+p.year,+p.month-1,+p.day,12);const h=Number(localParts(midday,'America/Boise').hour);return midday-(h*60+Number(localParts(midday,'America/Boise').minute))*60000;}
export const ZONES={WA:['America/Los_Angeles'],OR:['America/Los_Angeles','America/Boise'],ID:['America/Boise','America/Los_Angeles'],MT:['America/Denver'],CO:['America/Denver'],UT:['America/Denver'],AZ:['America/Phoenix','America/Denver'],CA:['America/Los_Angeles'],TX:['America/Chicago','America/Denver'],AL:['America/Chicago'],MI:['America/Detroit','America/Chicago'],OH:['America/New_York'],FL:['America/New_York','America/Chicago'],WI:['America/Chicago'],TN:['America/Chicago','America/New_York'],MN:['America/Chicago'],MO:['America/Chicago'],IN:['America/Indiana/Indianapolis','America/Chicago'],MD:['America/New_York'],SC:['America/New_York'],NJ:['America/New_York'],GA:['America/New_York'],NM:['America/Denver'],NV:['America/Los_Angeles','America/Boise']};
const blockedIds=new Set(['wa2-131','wa2-085','wa2-253','wa2-087','wa2-083','co-042','ca-113','nm-041','nv-114','al-544']);
export function staticCheck(q,p,now){
 if(q.user_id!==OWNER||p.user_id!==OWNER)return 'Wrong account';
 if(q.kind!=='initial'||q.status!=='ready'||!q.review_approved_at||q.hold_reason)return 'Not an approved ready initial';
 if(q.scheduled_at&&Date.parse(q.scheduled_at)>now)return 'Not-before date is in the future';
 if(p.status!=='Not Started'||p.record?.status&&p.record.status!=='Not Started')return 'Prospect is already contacted or in discussion';
 if(!/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(q.verified_email||'')||email(q.verified_email)!==email(p.email)||p.record?.email&&email(p.record.email)!==email(p.email))return 'Recipient is invalid or changed';
 if(!['high','verified'].includes(String(p.contact_confidence).toLowerCase())||!p.contact_source||!p.last_verified)return 'Contact verification evidence missing';
 const verified=Date.parse(p.last_verified);if(!Number.isFinite(verified)||verified>now||now-verified>31*86400000)return 'Contact verification requires review';
 if(/20(?:0\d|1\d|2[0-4])(?:[^\d]|$)/.test(p.contact_source)&&!/202[5-9]/.test(p.contact_source))return 'Source predates the required current directory';
 if(!/school|high|middle|elementary|junior|k-8/i.test(p.record?.type||'')||/business|conference|church|college|university/i.test(p.record?.type||'')||/^(biz-|church-|college-|conf-)/.test(q.school_id))return 'Outside direct-school initial scope';
 if(blockedIds.has(q.school_id))return 'Special-case school requires individual review';
 const schoolName=String(p.record?.school||'');const districtName=String(p.record?.district||'');
 if(/Kamiakin|Meadowdale|Edgemont|Mountlake Terrace|Everett Jackson|Carmichael|Magic Valley|Lapwai|Cosumnes Oaks|Northwood|Kern Valley|The Dalles|Cal Young|Talent Middle|North Bend Middle|Citrus Valley|Point Loma|Aragon|Burlingame|Brindlee|Buena Park|Sonora|Liberty|\bLeigh\b/i.test(schoolName)||/Bellevue|Lake Washington|Bellingham|Richland|Mt.? Spokane|Kennewick|Kuna|Fresno|Chaffey|Capistrano|San Mateo/i.test(districtName))return 'Named handoff exclusion or district hold requires individual review';
 const notes=[p.notes,p.record?.notes,JSON.stringify(p.record?.command?.holds||'')].filter(Boolean).join('\n');
 if(/\bDEFERRED\b|\bWARM\b|\bRECONNECT\b|DO NOT CONTACT|do not send yet|Gabe handles|OSAA|snippet.only|Kamiakin|Kennewick|Kuna|Brindlee|Buena Park|Sonora|Liberty.*Joes|Lapwai/i.test(notes+' '+(p.record?.school||'')+' '+(p.record?.district||'')))return 'Intentional hold or warm/reconnect special case';
 if(p.record?.command?.workflow?.routinePaused)return 'CRM workflow pauses routine outreach';
 if(q.approved_subject!=='quick question'||!q.approved_body||/[\r\n]/.test(q.approved_subject))return 'Missing or unexpected approved initial copy';
 const log=[...(Array.isArray(p.log)?p.log:[]),...(Array.isArray(p.record?.log)?p.record.log:[])];
 if(p.contacted||log.some(x=>/sent|emailed|reply|replied|response/i.test(x.type||x.action||'')))return 'CRM correspondence history requires review';
 const state=String(p.record?.state||'').toUpperCase();
 if(!ZONES[state])return 'Recipient timezone is unknown';
 if(!businessHours(now,'America/Boise')||!ZONES[state].every(tz=>businessHours(now,tz)))return 'Outside Boise or recipient business hours';
 if(!district(p))return 'District spreading key is missing';
 return null;
}
export function rawInitial(q,now){
 if(/[\r\n]/.test(q.verified_email+q.approved_subject))throw Error('Header injection');
 const rfc='<crm-initial-'+q.id+'@gabemurfitt.com>';
 const body=base64url(utf8.encode(q.approved_body)).replace(/-/g,'+').replace(/_/g,'/');
 const padded=body+'='.repeat((4-body.length%4)%4);
 const mime=['From: Gabe Murfitt <'+MAILBOX+'>','To: '+q.verified_email,'Subject: '+q.approved_subject,'Date: '+new Date(now).toUTCString(),'Message-ID: '+rfc,'X-Speaking-CRM-Queue: '+q.id,'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',''].join('\r\n')+(padded.match(/.{1,76}/g)||[]).join('\r\n');
 return {raw:base64url(utf8.encode(mime)),rfc};
}
export function header(m,name){return (m.payload?.headers||[]).find(h=>h.name.toLowerCase()===name.toLowerCase())?.value||'';}
export function addresses(text){return (String(text).match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)||[]).map(email);}
export function plainBody(payload){
 if(payload?.mimeType==='text/plain'&&payload.body?.data){return new TextDecoder().decode(Uint8Array.from(atob(payload.body.data.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0)));}
 for(const part of payload?.parts||[]){const value=plainBody(part);if(value!==null)return value;}return null;
}
export function confirmedMessage(m,q,rfc=null){
 const to=addresses(header(m,'To'));const from=addresses(header(m,'From'));
 return m.labelIds?.includes('SENT')&&to.length===1&&to[0]===email(q.verified_email)&&from.length===1&&from[0]===MAILBOX&&!header(m,'Cc')&&!header(m,'Bcc')&&header(m,'Subject')===q.approved_subject&&(!rfc||header(m,'Message-ID')===rfc||(/^<[^<>\s]+@[^<>\s]+>$/.test(header(m,'Message-ID'))&&header(m,'X-Speaking-CRM-Queue')===q.id))&&plainBody(m.payload)?.replace(/\r\n/g,'\n').trimEnd()===q.approved_body.replace(/\r\n/g,'\n').trimEnd();
}
export class ProviderError extends Error{constructor(status,reason,detail=''){super('GMAIL_HTTP_'+status+'_'+reason+(detail?': '+detail:''));this.status=status;this.provider=true;}}
export class QuotaYield extends Error{constructor(){super('GMAIL_API_BUDGET_YIELD');}}
export class Gmail {
 constructor(token,request=fetch,{clock=()=>Date.now(),delay=ms=>new Promise(r=>setTimeout(r,ms)),maxUnits=4000}={}){this.token=token;this.request=request;this.clock=clock;this.delay=delay;this.maxUnits=maxUnits;this.usedUnits=0;this.nextAt=0;}
 ensureSendBudget(){if(this.maxUnits-this.usedUnits<120)throw new QuotaYield();}
 async pace(path){const cost=path==='messages/send'?100:path.startsWith('threads/')?40:path.startsWith('messages/')?20:path==='profile'?1:5;if(this.usedUnits+cost>this.maxUnits)throw new QuotaYield();this.usedUnits+=cost;const now=this.clock();this.nextAt=Math.max(now,this.nextAt)+cost*20;await this.delay(this.nextAt-now);}
 async api(path,options={}){
  const {beforeRequest,...fetchOptions}=options;await this.pace(path);if(beforeRequest){try{await beforeRequest();}catch(error){error.preSend=true;throw error;}}const response=await this.request('https://gmail.googleapis.com/gmail/v1/users/me/'+path,{...fetchOptions,headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(15000)});
  if(!response.ok){const body=await response.json().catch(()=>({}));throw new ProviderError(response.status,String(body.error?.errors?.[0]?.reason||body.error?.status||'request_rejected').replace(/[^A-Za-z0-9_]/g,'').slice(0,100), /quota|rate|retry/i.test(body.error?.message||'')?String(body.error.message).slice(0,800):'');}
  const text=await response.text();try{return JSON.parse(text);}catch{throw Error('GMAIL_INVALID_JSON_'+path.split('?')[0]+'_HTTP_'+response.status+'_BYTES_'+text.length);}
 }
 async list(query,limit=1000){let pageToken,all=[];do{const params=new URLSearchParams({q:query,includeSpamTrash:'true',maxResults:'500',fields:'messages(id,threadId),nextPageToken,resultSizeEstimate'});if(pageToken)params.set('pageToken',pageToken);const page=await this.api('messages?'+params);all.push(...(page.messages||[]));pageToken=page.nextPageToken;if(all.length>=limit){return {messages:all,complete:!pageToken};}}while(pageToken);return {messages:all,complete:true};}
 async metadata(id){return this.api('messages/'+encodeURIComponent(id)+'?format=metadata&fields=id,threadId,labelIds,internalDate,payload(headers)&metadataHeaders=To&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID');}
 async full(id){return this.api('messages/'+encodeURIComponent(id)+'?format=full');}
 async thread(id){return this.api('threads/'+encodeURIComponent(id)+'?format=full');}
 async send(raw,beforeRequest,threadId){return this.api('messages/send',{method:'POST',body:JSON.stringify({raw,...(threadId?{threadId}:{})}),beforeRequest});}
}
export async function refreshGmail(env,connection,request=fetch){
 const refresh=await unseal(connection.refresh_token_encrypted,env.SUPABASE_SERVICE_ROLE_KEY);
 const response=await request('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,grant_type:'refresh_token',refresh_token:refresh}),signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw new ProviderError(response.status,'oauth_refresh_rejected');
 const tokens=await response.json();if(!tokens.access_token)throw Error('OAUTH_ACCESS_TOKEN_MISSING');
 const gmail=new Gmail(tokens.access_token,request);const profile=await gmail.api('profile');if(email(profile.emailAddress)!==MAILBOX)throw Error('AUTHORIZED_MAILBOX_MISMATCH');return gmail;
}
export async function snapshot(gmail,now,cache=new Map()){
 const result=await gmail.list('in:sent after:'+Math.floor(dayStart(now)/1000),1000);if(!result.complete)throw Error('GMAIL_DAILY_COUNTS_INCOMPLETE');
 for(let i=0;i<result.messages.length;i+=5){await Promise.all(result.messages.slice(i,i+5).map(async x=>{if(!cache.has(x.id))cache.set(x.id,await (gmail.metadata?gmail.metadata(x.id):gmail.full(x.id)));}));}
 const messages=result.messages.map(x=>cache.get(x.id)).filter(x=>x?.labelIds?.includes('SENT'));
 return {daily:messages.length,hourly:messages.filter(x=>Number(x.internalDate)>=now-3600000).length,messages,checkedAt:new Date(now).toISOString()};
}
async function priorDomain(gmail,domain){
 const history=await gmail.list('in:anywhere "'+domain+'"',100);const ids=[...new Set(history.messages.map(m=>m.threadId))];
 if(!history.complete||ids.length>20)return 'District history needs manual conversation review';
 for(const id of ids){const thread=await gmail.thread(id);for(const m of thread.messages||[]){
  if(m.labelIds?.includes('DRAFT'))return 'District has a draft or scheduled message';
  if(!m.labelIds?.includes('SENT')&&!addresses(header(m,'From')).includes(MAILBOX))return 'District has a human, automatic, or delivery response requiring review';
  if(m.labelIds?.includes('SENT')&&/On .{5,150}wrote:|From:.{0,150}\n|Original Message/i.test(plainBody(m.payload)||''))return 'Quoted district conversation requires review';
 }}return null;
}
export async function runWorker({run,store,gmail,now=()=>Date.now(),phase=()=>{}}){
 const started=now(),items=[],cache=new Map(),domainCache=new Map();let sent=0,failed=0,ambiguous=0,inspected=0,stopReason=null,providerStopped=false;const cacheWarnings=[];
 for(const m of store.sentCache?await store.sentCache(dayStart(now())):[])cache.set(m.id,m);
 const savedCacheIds=new Set(cache.keys());const remember=async messages=>{const fresh=messages.filter(m=>!savedCacheIds.has(m.id));if(fresh.length&&store.saveSentCache){try{await store.saveSentCache(fresh);for(const m of fresh)savedCacheIds.add(m.id);}catch(error){cacheWarnings.push(String(error.message||'SENT cache write failed'));}}};
 phase('Gmail account snapshot');let account=await snapshot(gmail,now(),cache);await remember(account.messages);
 const base={runId:run.id,mode:run.mode,mailbox:MAILBOX,initialAccountDaily:account.daily,initialAccountHourly:account.hourly};
 if(run.mode==='audit_claims'){
  for(const q of await store.claims()){
   const search=await gmail.list('in:anywhere "'+q.verified_email+'"',100);let found=[];
   for(const x of search.messages){const m=await gmail.full(x.id);if(Number(m.internalDate)>=Date.parse(q.claimed_at)-60000&&confirmedMessage(m,q))found.push({id:m.id,threadId:m.threadId,sentAt:new Date(Number(m.internalDate)).toISOString()});}
   items.push({queueId:q.id,schoolId:q.school_id,claimedAt:q.claimed_at,complete:search.complete,confirmed:found});
  }
  return {...base,items,sent:0};
 }
 if(!businessHours(now(),'America/Boise'))return {...base,sent:0,stopped:'Outside Boise weekday business hours'};
 if(account.daily>=270||account.hourly>=45)return {...base,sent:0,stopped:'Shared sending ceiling reached'};
 const claims=await store.claims();if(claims.length)return {...base,sent:0,stopped:'Existing sending claims require reconciliation',claims:claims.map(q=>({id:q.id,schoolId:q.school_id,claimedAt:q.claimed_at}))};
 if(await store.aiActive())return {...base,sent:0,stopped:'AI sender ownership is active'};
 phase('Gmail delivery notices');const bounces=await gmail.list('in:anywhere after:'+Math.floor(dayStart(now())/1000)+' {from:mailer-daemon from:postmaster subject:"Delivery Status Notification" subject:"Undeliverable"}',10);
 if(bounces.messages.length>2){if(run.mode==='live')await store.pause('BOUNCE_REVIEW: more than two delivery notices today');return {...base,sent:0,stopped:'Bounce accumulation requires review',deliveryNotices:bounces.messages.map(x=>x.id)};}
 phase('CRM district context');const contexts=await store.context();phase('CRM candidates');const candidates=await store.candidates();
 const groupsByEmail=new Map(contexts.map(c=>[email(c.email),district(c)]));
 const activeDistricts=new Map(contexts.filter(c=>(/discussion|booked|not interested|do not contact|try next year|closed/i.test(c.status)||c.status==='No'||c.record?.command?.workflow?.routinePaused)).map(c=>[district(c),c.school_id]));
 const alreadyToday=(key,domain,s)=>s.messages.some(m=>addresses(header(m,'To')).some(a=>a.split('@')[1]===domain||groupsByEmail.get(a)===key));
 try{for(const {queue:q,prospect:p} of candidates){
  if(now()-started>95000||sent>=run.max_sends||(run.mode==='dry_run'&&items.filter(x=>x.eligible).length>=run.max_sends))break;
  phase('Candidate '+q.school_id);inspected++;let reason=staticCheck(q,p,now());const key=district(p),domain=email(q.verified_email).split('@')[1];
  if(!reason&&activeDistricts.has(key))reason='District has existing CRM outreach or conversation; review sibling '+activeDistricts.get(key);
  if(!reason&&alreadyToday(key,domain,account))reason='District already contacted today';
  if(!reason){const prior=await gmail.list('in:anywhere "'+q.verified_email+'"',1);if(prior.messages.length)reason='Recipient already appears in Gmail correspondence, drafts, or scheduled mail';}
  if(!reason){if(!domainCache.has(domain))domainCache.set(domain,await priorDomain(gmail,domain));reason=domainCache.get(domain);}
  if(!reason){const school=p.record?.school||p.record?.name;if(!school)reason='School name is missing';else{const expanded=school.replace(/\bHS\b/gi,'High School').replace(/\bMS\b/gi,'Middle School').replace(/\bJH\b/gi,'Junior High');const names=[...new Set([school,expanded])].map(x=>'"'+x.replace(/["\\]/g,'')+'"').join(' ');const history=await gmail.list('in:anywhere {'+names+'}',1);if(history.messages.length)reason='School appears in earlier Gmail correspondence; reconnect review required';}}
  if(reason){items.push({queueId:q.id,schoolId:q.school_id,eligible:false,reason});continue;}
  if(run.mode==='dry_run'){items.push({queueId:q.id,schoolId:q.school_id,recipient:q.verified_email,eligible:true});continue;}
  account=await snapshot(gmail,now(),cache);
  if(account.daily>=270||account.hourly>=45){items.push({queueId:q.id,eligible:false,reason:'Shared sending ceiling reached'});break;}
  if(alreadyToday(key,domain,account)){items.push({queueId:q.id,schoolId:q.school_id,eligible:false,reason:'District already contacted today'});continue;}
  // Repeat complete address search immediately before acquiring the unchanged approval.
  if((await gmail.list('in:anywhere "'+q.verified_email+'"',1)).messages.length){items.push({queueId:q.id,eligible:false,reason:'Correspondence appeared during preflight'});continue;}
  if(gmail.ensureSendBudget)gmail.ensureSendBudget();
  const claimed=await store.claim(run,q,account);if(!claimed){items.push({queueId:q.id,eligible:false,reason:'Claim rejected or approval changed'});continue;}
  const prepared=rawInitial(q,now());let accepted=null,sendStarted=false;
  try{
   await store.intent(claimed,{runId:run.id,rfcMessageId:prepared.rfc,phase:'send_requested',checkedAt:new Date(now()).toISOString()});
   sendStarted=true;accepted=await gmail.send(prepared.raw,store.beforeSend?()=>store.beforeSend(claimed):undefined);
   if(!accepted.id||!accepted.threadId)throw Error('GMAIL_ACCEPTANCE_ID_MISSING');
   await store.accepted(claimed,accepted);
   const confirmed=await gmail.full(accepted.id);
   if(!confirmedMessage(confirmed,q,prepared.rfc))throw Error('GMAIL_SENT_IDENTITY_NOT_CONFIRMED');
   await store.confirm(claimed,confirmed,header(confirmed,'Message-ID'));
   sent++;cache.set(confirmed.id,confirmed);await remember([confirmed]);domainCache.set(domain,'District already contacted in this run');
   contexts.push({...p,status:'Emailed'});
   items.push({queueId:q.id,schoolId:q.school_id,recipient:q.verified_email,sent:true,messageId:confirmed.id,threadId:confirmed.threadId,sentAt:new Date(Number(confirmed.internalDate)).toISOString()});
  }catch(error){
   const rejected=error instanceof ProviderError&&error.status>=400&&error.status<500&&!accepted;
   const label=(!sendStarted||error.preSend)?'FAILED_PRE_SEND':rejected?'FAILED_REJECTED':'AMBIGUOUS_SEND';if(rejected||!sendStarted||error.preSend)failed++;else ambiguous++;
   await store.hold(claimed,label+': '+error.message+(accepted?.id?'; Gmail accepted ID '+accepted.id:''),accepted);
   items.push({queueId:q.id,schoolId:q.school_id,sent:false,outcome:label,error:error.message,messageId:accepted?.id||null});
   if(error.preSend){stopReason=error.message;break;}
   if(!rejected||[401,403,429].includes(error.status)){stopReason=label+': '+error.message;providerStopped=true;await store.pause(stopReason);break;}
  }
 }}catch(error){stopReason=error.message;providerStopped=!(error instanceof QuotaYield);items.push({preflightFailed:true,error:error.message});if(providerStopped&&run.mode==='live')await store.pause('PREFLIGHT: '+error.message);}
 return {...base,sent,failed,ambiguous,inspected,stopReason,providerStopped,cacheWarnings,apiQuotaUnitsUsed:gmail.usedUnits??null,skipped:items.filter(x=>x.eligible===false).length,items,lastAccountSnapshotDaily:account.daily};
}
