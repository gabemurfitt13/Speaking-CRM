import { createClient } from "npm:@supabase/supabase-js@2.95.0";
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Content-Type":"application/json"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:cors});
const emailActions=new Set(["respond_inquiry","send_pricing","follow_up","proposal_follow_up","collect_payment","collect_deposit","confirm_event","post_event_follow_up","restart_conversation"]);
Deno.serve(async(req)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 if(req.method!=="POST")return json({error:"Method not allowed"},405);
 const auth=req.headers.get("Authorization"); if(!auth)return json({error:"Unauthorized"},401);
 const anon=createClient(Deno.env.get("SUPABASE_URL")??"",Deno.env.get("SUPABASE_ANON_KEY")??"",{global:{headers:{Authorization:auth}}});
 const token=auth.replace("Bearer ",""); const {data:{user},error:ue}=await anon.auth.getUser(token); if(ue||!user)return json({error:"Unauthorized"},401);
 const {action_id}=await req.json().catch(()=>({})); if(!action_id)return json({error:"action_id required"},400);
 const {data:a,error:ae}=await anon.from("ai_actions").select("*").eq("id",action_id).eq("user_id",user.id).single(); if(ae||!a)return json({error:"Action not found"},404);
 if(a.status==="executed"||a.executed_at)return json({error:"ALREADY_EXECUTED",message:"This action has already been sent."},409);
 if(a.ai_status!=="ready")return json({error:"AI_NOT_READY",message:"Prepare and review this action before sending."},409);
 if(!emailActions.has(a.action_type))return json({error:"NOT_EMAIL_ACTION",message:"This action is not configured to send email."},409);
 if(a.record_kind==="progress"&&a.action_type==="follow_up")return json({error:"GMAIL_THREAD_REQUIRED",message:"Use the School Follow-Up Queue and original Gmail conversation; this Resend action cannot send school follow-ups."},409);
 const subject=String(a.ai_output?.subject||"").trim(),body=String(a.ai_output?.draft||"").trim();
 if(!subject||!body)return json({error:"MISSING_DRAFT",message:"Reviewed subject and draft are required."},409);
 let record:any=null,idColumn="id";
 if(a.record_kind==="progress"){idColumn="school_id";const q=await anon.from("progress").select("*").eq("school_id",a.record_id).eq("user_id",user.id).single();record=q.data;}
 else if(a.record_kind==="website_inquiries"){const q=await anon.from("website_inquiries").select("*").eq("id",a.record_id).eq("user_id",user.id).single();record=q.data;}
 else if(a.record_kind==="leads"){const q=await anon.from("leads").select("*").eq("id",a.record_id).eq("user_id",user.id).single();record=q.data;}
 if(!record)return json({error:"Source record not found"},404);
 const rr=(record.record&&typeof record.record==="object"&&!Array.isArray(record.record))?record.record:{};
 const to=String(record.email||rr.email||"").trim(); if(!to)return json({error:"MISSING_RECIPIENT",message:"The CRM record does not have an email address."},409);
 const resendKey=Deno.env.get("RESEND_API_KEY"),from=Deno.env.get("FROM_EMAIL")||"onboarding@resend.dev"; if(!resendKey)return json({error:"EMAIL_NOT_CONFIGURED"},503);
 // Claim the action first. The conditional update makes retries/double taps harmless.
 const {data:claimed,error:ce}=await anon.from("ai_actions").update({status:"approved",decided_at:new Date().toISOString(),execution_output:{state:"sending"}}).eq("id",a.id).eq("user_id",user.id).is("executed_at",null).neq("status","executed").select("id").maybeSingle();
 if(ce)return json({error:"CLAIM_FAILED",message:ce.message},500); if(!claimed)return json({error:"ALREADY_EXECUTED",message:"This action is already being sent or has been sent."},409);
 const res=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:`Bearer ${resendKey}`,"Content-Type":"application/json"},body:JSON.stringify({from,to,subject,html:body.replace(/\n/g,"<br>"),text:body})});
 const rd=await res.json().catch(()=>({}));
 if(!res.ok){await anon.from("ai_actions").update({status:"pending",execution_output:{state:"failed",error:rd}}).eq("id",a.id).eq("user_id",user.id);return json({error:"SEND_FAILED",detail:rd},502);}
 const now=new Date(),day=now.toISOString().slice(0,10),follow=new Date(now);follow.setDate(follow.getDate()+7);const followDay=follow.toISOString().slice(0,10);
 const logEntry={date:day,type:a.action_type==="follow_up"||a.action_type==="proposal_follow_up"||a.action_type==="restart_conversation"?"Follow-up sent":"Email sent",subject,resendId:rd.id,aiActionId:a.id};
 if(a.record_kind==="progress"||a.record_kind==="leads"){
   const log=Array.isArray(record.log)?[...record.log,logEntry]:[logEntry];
   const changes:any={log,contacted:day};
   if(a.action_type==="respond_inquiry"||a.action_type==="send_pricing")changes.follow_up=followDay;
   const q=await anon.from(a.record_kind).update(changes).eq(idColumn,a.record_id).eq("user_id",user.id); if(q.error){await anon.from("ai_actions").update({execution_output:{state:"sent_log_failed",resendId:rd.id,error:q.error.message}}).eq("id",a.id).eq("user_id",user.id);return json({error:"SENT_BUT_LOG_FAILED",resendId:rd.id},500);}
 } else {
   const command={...(record.command||{}),lastAiEmailSentOn:day,lastAiEmailActionId:a.id};
   const q=await anon.from("website_inquiries").update({command}).eq("id",a.record_id).eq("user_id",user.id); if(q.error){await anon.from("ai_actions").update({execution_output:{state:"sent_log_failed",resendId:rd.id,error:q.error.message}}).eq("id",a.id).eq("user_id",user.id);return json({error:"SENT_BUT_LOG_FAILED",resendId:rd.id},500);}
 }
 const {data:done,error:de}=await anon.from("ai_actions").update({status:"executed",executed_at:new Date().toISOString(),execution_output:{state:"sent",resendId:rd.id,to,subject}}).eq("id",a.id).eq("user_id",user.id).select("*").single();
 if(de)return json({error:"SENT_BUT_ACTION_UPDATE_FAILED",resendId:rd.id},500);
 return json({success:true,action:done});
});
