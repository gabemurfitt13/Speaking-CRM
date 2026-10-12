// Initial outreach batch worker. Never sends follow-ups.
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN,
// BULK_SENDER_CRON_SECRET, BULK_SENDER_USER_ID.
// Invoke with Authorization: Bearer <BULK_SENDER_CRON_SECRET> from a trusted scheduler.
// Deployment must be kept OFF until OAuth, Gmail identity and dry-run checks pass.
import { createClient } from "npm:@supabase/supabase-js@2";
const json=(x:unknown,status=200)=>new Response(JSON.stringify(x),{status,headers:{"content-type":"application/json"}});
const env=(key:string)=>{const x=Deno.env.get(key);if(!x)throw Error("Missing "+key);return x;};
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const norm=(s:string)=>s.trim().toLowerCase();
const blocked=/not interested|do not contact|opt.?out|unsubscribe|no keynotes|already booked/i;
async function gmailToken(){
 const body=new URLSearchParams({client_id:env("GMAIL_CLIENT_ID"),client_secret:env("GMAIL_CLIENT_SECRET"),refresh_token:env("GMAIL_REFRESH_TOKEN"),grant_type:"refresh_token"});
 const res=await fetch("https://oauth2.googleapis.com/token",{method:"POST",body});
 if(!res.ok)throw Error("Gmail token refresh failed "+res.status);
 const data=await res.json();return data.access_token as string;
}
async function gmail(token:string,path:string,init:RequestInit={}){
 const res=await fetch("https://gmail.googleapis.com/gmail/v1/users/me/"+path,{...init,headers:{authorization:"Bearer "+token,...init.headers}});
 if(!res.ok)throw Error("Gmail "+res.status+" "+(await res.text()).slice(0,300));
 return res.json();
}
function base64url(s:string){return btoa(unescape(encodeURIComponent(s))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");}
async function main(req:Request){
 if(req.method!=="POST")return json({error:"POST only"},405);
 if(req.headers.get("authorization")!=="Bearer "+env("BULK_SENDER_CRON_SECRET"))return json({error:"Unauthorized"},401);
 const uid=env("BULK_SENDER_USER_ID"),db=createClient(env("SUPABASE_URL"),env("SUPABASE_SERVICE_ROLE_KEY"),{auth:{persistSession:false}});
 const {data:ctl,error:ce}=await db.from("outreach_sender_control").select("*").eq("user_id",uid).maybeSingle();
 if(ce)throw ce;if(!ctl?.enabled||!ctl.initial_only)return json({status:"paused",sent:0});
 const hour=new Intl.DateTimeFormat("en-US",{timeZone:"America/Boise",weekday:"short",hour:"numeric",hour12:false}).formatToParts(new Date());
 const day=hour.find(x=>x.type==="weekday")?.value,hh=Number(hour.find(x=>x.type==="hour")?.value);
 if(["Sat","Sun"].includes(day||"")||hh<9||hh>=17)return json({status:"outside_hours",sent:0});
 const since=new Date();\n const localDate=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Boise",year:"numeric",month:"2-digit",day:"2-digit"}).format(since);\n const localMidnight=new Date(localDate+"T00:00:00"+(new Intl.DateTimeFormat("en-US",{timeZone:"America/Boise",timeZoneName:"shortOffset"}).formatToParts(since).find(p=>p.type==="timeZoneName")?.value?.includes("-6")?"-06:00":"-07:00"));\n since.setTime(localMidnight.getTime());
 const {count,error:countErr}=await db.from("outreach_queue").select("id",{count:"exact",head:true}).eq("user_id",uid).eq("kind","initial").eq("status","sent").gte("sent_at",since.toISOString());
 if(countErr)throw countErr;
 const allowance=Math.min(ctl.batch_limit,ctl.daily_limit-(count||0),20);
 if(allowance<=0)return json({status:"daily_limit",sent:0});
 const token=await gmailToken();
 const profile=await gmail(token,"profile");
 if(norm(profile.emailAddress||"")!==norm(env("BULK_SENDER_FROM_EMAIL")))throw Error("Wrong Gmail sending account");
 const {data:items,error:qe}=await db.from("outreach_queue").select("*").eq("user_id",uid).eq("kind","initial").eq("status","ready").order("created_at").limit(allowance);
 if(qe)throw qe;
 let sent=0,held=0,errors=0;const results=[];
 for(const item of items||[]){
  const {data:lock,error:le}=await db.from("outreach_queue").update({status:"sending",claimed_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq("id",item.id).eq("status","ready").eq("kind","initial").select("id").maybeSingle();
  if(le||!lock)continue;
  const hold=async(reason:string)=>{held++;await db.from("outreach_queue").update({status:"held",hold_reason:reason,updated_at:new Date().toISOString()}).eq("id",item.id);};
  try{
   const {data:p,error:pe}=await db.from("progress").select("*").eq("user_id",uid).eq("school_id",item.school_id).single();
   if(pe||!p||p.status!=="Not Started"||p.contacted||!p.email||norm(p.email)!==norm(item.verified_email)||!["high","verified"].includes(norm(p.contact_confidence||""))||!p.last_verified||!p.contact_source||blocked.test((p.notes||"")+" "+p.status)){await hold("Eligibility or opt-out check failed");continue;}
   if(!item.approved_subject?.trim()||!item.approved_body?.trim()){await hold("Missing approved draft");continue;}
   // Gmail history catches sent messages and existing conversations, not merely CRM state.
   const address=item.verified_email.replace(/["\\]/g,"");
   const q=encodeURIComponent('in:anywhere {to:"'+address+'" from:"'+address+'"}');
   const history=await gmail(token,"messages?q="+q+"&maxResults=1");
   if(history.resultSizeEstimate>0||(history.messages||[]).length){await hold("Existing Gmail conversation; manual review required");continue;}
   // Guard against sending multiple schools in one domain in a batch.
   const domain=address.split("@")[1];
   const {data:recentDomain}=await db.from("outreach_queue").select("verified_email").eq("user_id",uid).eq("kind","initial").eq("status","sent").gte("sent_at",since.toISOString()).limit(1000);\n   if((recentDomain||[]).some(x=>norm(x.verified_email||"").split("@")[1]===domain)){await hold("Same-domain daily limit");continue;}
   const mime=["From: "+profile.emailAddress,"To: "+address,"Subject: "+item.approved_subject.replace(/[\r\n]/g," "), "MIME-Version: 1.0","Content-Type: text/plain; charset=UTF-8","",""+item.approved_body].join("\r\n");
   const message=await gmail(token,"messages/send",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({raw:base64url(mime)})});
   // Once Gmail succeeds, never automatically retry even if CRM persistence fails.
   const now=new Date().toISOString();
   const {error:se}=await db.from("outreach_queue").update({status:"sent",sent_at:now,provider_message_id:message.id,hold_reason:null,updated_at:now}).eq("id",item.id).eq("status","sending");
   if(se){await db.from("outreach_queue").update({status:"held",hold_reason:"GMAIL SENT "+message.id+" but queue persistence failed. Never retry without reconciliation.",provider_message_id:message.id,updated_at:now}).eq("id",item.id);throw Error("SENT BUT CRM QUEUE WRITE FAILED: "+message.id);}
   const log=[...(Array.isArray(p.log)?p.log:[]),{type:"initial_email",recipient:address,subject:item.approved_subject,gmail_message_id:message.id,sent_at:now}];
   const {error:pe2}=await db.from("progress").update({status:"Emailed",contacted:now,log}).eq("user_id",uid).eq("school_id",item.school_id).eq("status","Not Started");
   if(pe2)results.push({school_id:item.school_id,status:"sent_queue_only",message_id:message.id});
   else results.push({school_id:item.school_id,status:"sent",message_id:message.id,domain});
   sent++;
   await sleep(1200);
  }catch(e){errors++;await db.from("outreach_queue").update({status:"held",hold_reason:"Ambiguous or failed send. Reconcile Gmail before retry: "+String(e).slice(0,220),updated_at:new Date().toISOString()}).eq("id",item.id).eq("status","sending");results.push({school_id:item.school_id,status:"held_error"});}
 }
 return json({sent,held,errors,results});
}
Deno.serve(req=>main(req).catch(e=>json({error:String(e)},500)));
