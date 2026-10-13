import {createClient} from "npm:@supabase/supabase-js@2.95.0";
const headers={"Content-Type":"application/json"};
const reply=(x,s=200)=>new Response(JSON.stringify(x),{status:s,headers});
Deno.serve(async(req)=>{
 if(req.method!=="POST")return reply({error:"POST required"},405);
 const auth=req.headers.get("Authorization")||"";
 const url=Deno.env.get("SUPABASE_URL")||"";
 const anon=Deno.env.get("SUPABASE_ANON_KEY")||"";
 const service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
 const token=auth.replace(/^Bearer /,"");
 const client=createClient(url,anon);
 const {data:{user},error}=await client.auth.getUser(token);
 if(error||!user)return reply({error:"Unauthorized"},401);
 const db=createClient(url,service);
 const {data:claimed,error:ce}=await db.rpc("claim_ready_outreach",{p_limit:1});
 if(ce)return reply({error:"claim failed",detail:ce.message},500);
 if(!claimed?.length)return reply({claimed:0,sent:0,message:"No eligible approved queue items"});
 const q=claimed[0];
 if(q.kind==='follow_up'){
  await db.from('outreach_queue').update({status:'held',claimed_at:null,hold_reason:'GMAIL_THREAD_REQUIRED: use original Gmail thread; Resend follow-ups are disabled'}).eq('id',q.id).eq('status','sending');
  return reply({claimed:1,sent:0,error:'GMAIL_THREAD_REQUIRED'},409);
 }
 // Fail closed until a server-side mail provider is configured.
 const key=Deno.env.get("RESEND_API_KEY");
 const from=Deno.env.get("FROM_EMAIL");
 if(!key||!from){
   await db.from("outreach_queue").update({status:"held",hold_reason:"Server email provider is not configured"}).eq("id",q.id).eq("status","sending");
   return reply({claimed:1,sent:0,error:"Email provider not configured"},503);
 }
 const result=await fetch("https://api.resend.com/emails",{method:"POST",headers:{"Authorization":"Bearer "+key,"Content-Type":"application/json","Idempotency-Key":"speaking-queue-"+q.id},body:JSON.stringify({from,to:q.verified_email,subject:q.approved_subject,text:q.approved_body})});
 const payload=await result.json().catch(()=>({}));
 if(!result.ok){
   await db.from("outreach_queue").update({status:"held",hold_reason:"Provider rejected request; review before retry"}).eq("id",q.id).eq("status","sending");
   return reply({claimed:1,sent:0,error:"Provider rejected send",detail:payload},502);
 }
 const now=new Date().toISOString();
 const {error:ue}=await db.from("outreach_queue").update({status:"sent",sent_at:now,provider_message_id:payload.id||null,hold_reason:null}).eq("id",q.id).eq("status","sending");
 if(ue)return reply({claimed:1,sent:1,warning:"Sent but queue update failed",provider_message_id:payload.id},500);
 return reply({claimed:1,sent:1,provider_message_id:payload.id});
});
